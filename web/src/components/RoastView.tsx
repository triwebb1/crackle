import { Check, Play, Plus, Save, Server, TriangleAlert, X } from 'lucide-preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  type ActivePlanPatchResult,
  type ActiveRoastPlan,
  type ActiveRoastStep,
  type HttpControllerClient,
  implausibleCoefficient,
} from '../controller/client'
import { calibrationSettingsCompatibility } from '../domain/calibrationCompatibility'
import { previewCalibration } from '../domain/calibrationProvenance'
import { formatLocalDateTime } from '../domain/dateTime'
import type { DeviceLogEntry } from '../domain/deviceLogs'
import { stableEquals } from '../domain/draft'
import { adjustedJourneyTargetPath, deviceJourneyChartState, liveJourneyControl } from '../domain/liveJourney'
import { manualApplyBlockedReason, manualParamError, predictedManualLevels } from '../domain/manualControl'
import { automaticRunName, formatClock, latestSample, targetPoints, timedDuration } from '../domain/model'
import {
  type Requirement,
  requirementSentence,
  thermocoupleUnavailableReason,
  unmetRequirements,
} from '../domain/requirements'
import { LEAVE_WITHOUT_SAVING } from '../domain/revisionDiff'
import {
  CALIBRATION_APPLY_ACTION,
  calibrationApplyBlockedReason,
  journeyZonesError,
  ROAST_LIMITS,
  type RoastStartArgs,
  roastEndReasonText,
  roastModeLabel,
  roastPreflight,
  roastStartArgs,
} from '../domain/roastProgram'
import { runScore } from '../domain/roastScore'
import { formatBytes, recordingBytes, retentionWarning } from '../domain/storage'
import type {
  BatchMeasurements,
  BeanLot,
  CalibrationRun,
  CalibrationSettings,
  CalibrationSnapshot,
  ControllerStatus,
  Profile,
  RoastEvent,
  RoastRun,
  TelemetrySample,
  ThermalIntent,
  ThermalSegment,
  TimedProfile,
} from '../domain/types'
import { useArmedConfirm } from './armedConfirm'
import { FanHeatEditor } from './FanHeatEditor'
import { LiveChart } from './LiveChart'
import { NumberField } from './NumberField'
import { sourceMatches } from './RoasterSource'
import { ScorePicker } from './ScorePicker'
import { LifecycleBadge, LiveReadouts } from './Status'
import { StopIcon } from './StopIcon'
import { TextArea, TextField } from './TextField'

/**
 * The Roast page heading says what the page is doing now: a roast the roaster is running (whichever
 * browser started it), a Controls session, a finished session under review, or setup for the next.
 */
export const roastViewTitle = ({
  deviceActive,
  controlsActive,
  sessionName,
}: {
  deviceActive: boolean
  controlsActive: boolean
  sessionName?: string
}): string =>
  deviceActive ? 'Roast in progress' : controlsActive ? 'Manual control in progress' : (sessionName ?? 'Set up a roast')

export const profileFromActiveRoastPlan = (
  plan: ActiveRoastPlan,
  nowIso = new Date().toISOString(),
  library: readonly Profile[] = [],
): Profile => {
  // A roast started from a saved profile reports that profile's id. Its name, intent, and notes come
  // from the library; the zones or steps always come from what the roaster is executing.
  const saved = plan.profileId ? library.find((profile) => profile.id === plan.profileId) : undefined
  const shared = {
    id: plan.profileId || `active-plan-${plan.bootId ?? 'boot'}-${plan.sessionId ?? 'session'}`,
    name: saved?.name ?? (plan.name || 'Active roast'),
    revision: plan.profileRevision ?? 0,
    createdAt: saved?.createdAt ?? nowIso,
    updatedAt: nowIso,
    metadata: saved ? { ...saved.metadata } : { intent: 'Controller active plan' },
    notes: saved?.notes ?? 'Exact plan reported by the roaster for this session.',
  }
  if (plan.mode === 'journey') {
    return {
      ...shared,
      strategy: 'thermal-intent',
      segments: plan.zones.map((zone) => ({ ...zone })),
      calibrationStatus: 'validated',
    }
  }
  let timeSec = 0
  const points = plan.steps.map((step, index) => {
    const point = { id: `active-step-${index + 1}`, timeSec, fan: step.fan, heat: step.heat }
    timeSec += step.durationSec
    return point
  })
  const cooling = plan.steps.at(-1)
  return {
    ...shared,
    strategy: 'timed',
    points,
    coolFan: cooling?.heat === 0 ? cooling.fan : 9,
    coolDurationSec: cooling?.heat === 0 ? cooling.durationSec : 0,
  }
}

export interface ProfiledTelemetryObservation {
  elapsedSec: number
  beanTempC: number
  requestedFan: number
  effectiveFan: number
  requestedHeat: number
  effectiveHeat: number
}

/** One point per controller second, bounded to forty minutes of display-only telemetry. */
export const appendProfiledRoastSample = (
  current: TelemetrySample[],
  observation: ProfiledTelemetryObservation,
): TelemetrySample[] => {
  const elapsedSec = Math.max(0, Math.floor(observation.elapsedSec))
  if (current.at(-1)?.elapsedSec === elapsedSec) return current
  const earlier = [...current].reverse().find((sample) => elapsedSec - sample.elapsedSec >= 10) ?? current[0]
  const span = earlier ? elapsedSec - earlier.elapsedSec : 0
  const rorCPerMin = !earlier || span <= 0 ? 0 : ((observation.beanTempC - earlier.beanTempC) / span) * 60
  return [
    ...current,
    {
      elapsedSec,
      beanTempC: observation.beanTempC,
      rorCPerMin,
      requestedFan: observation.requestedFan,
      effectiveFan: observation.effectiveFan,
      requestedHeat: observation.requestedHeat,
      effectiveHeat: observation.effectiveHeat,
      phase: 'DRYING' as const,
    },
  ].slice(-2400)
}

const zoneDirection = (zone: ThermalSegment) =>
  Math.abs(zone.endC - zone.startC) <= 0.5 ? 0 : Math.sign(zone.endC - zone.startC)

export const editActiveJourneyZone = (
  zones: ThermalSegment[],
  index: number,
  currentIndex: number,
  patch: Partial<ThermalSegment>,
): ThermalSegment[] => {
  if (index < currentIndex || !zones[index]) return zones
  const next = zones.map((zone) => ({ ...zone }))
  next[index] = { ...next[index], ...patch, id: next[index].id, startC: next[index].startC }
  for (let cursor = index + 1; cursor < next.length; cursor += 1) next[cursor].startC = next[cursor - 1].endC
  return next
}

export const activeJourneyEditProblem = (
  original: ThermalSegment[],
  draft: ThermalSegment[],
  currentIndex: number,
  currentElapsedSec: number,
): string | undefined => {
  const shape = journeyZonesError(draft)
  if (shape) return shape
  for (let index = 0; index < currentIndex; index += 1) {
    if (JSON.stringify(original[index]) !== JSON.stringify(draft[index])) return 'Completed zones cannot be changed'
  }
  const before = original[currentIndex]
  const after = draft[currentIndex]
  if (!before || !after) return 'The active zone must remain in the plan'
  if (before.startC !== after.startC || zoneDirection(before) !== zoneDirection(after))
    return 'The active zone cannot reverse direction from its entry temperature'
  if (after.durationSec < currentElapsedSec + 5)
    return `The active zone duration must be at least ${Math.ceil(currentElapsedSec + 5)} seconds`
  return undefined
}

export const activeTimedStepProblem = (
  step: ActiveRoastStep | undefined,
  index: number,
  currentIndex: number,
  currentElapsedSec: number,
): string | undefined => {
  if (
    !step ||
    !Number.isFinite(step.fan) ||
    !Number.isFinite(step.heat) ||
    step.fan < ROAST_LIMITS.level.min ||
    step.fan > ROAST_LIMITS.level.max ||
    step.heat < ROAST_LIMITS.level.min ||
    step.heat > ROAST_LIMITS.level.max ||
    (step.fan === 0 && step.heat > 0)
  ) {
    return 'Fan and Heat must be 0.0 through 10.0; Fan 0 requires Heat 0.'
  }
  if (
    !Number.isInteger(step.durationSec) ||
    step.durationSec < ROAST_LIMITS.stepSeconds.min ||
    step.durationSec > ROAST_LIMITS.stepSeconds.max
  ) {
    return `Step duration must be a whole number from ${ROAST_LIMITS.stepSeconds.min} through ${ROAST_LIMITS.stepSeconds.max} seconds.`
  }
  const currentMinimum = Math.ceil(currentElapsedSec + 5)
  return index === currentIndex && step.durationSec < currentMinimum
    ? `The current step must retain at least 5 seconds; enter ${currentMinimum} seconds or more.`
    : undefined
}

export interface PlannedManualStep {
  id: number
  fan: number
  heat: number
  /** Absolute device-owned roast elapsed time at which this row becomes due. */
  atElapsedSec: number
}

export const manualStepTimeError = (seconds: number): string | undefined => {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > ROAST_LIMITS.stepSeconds.max) {
    return `At elapsed must be a whole number from 0 through ${ROAST_LIMITS.stepSeconds.max} seconds.`
  }
  return undefined
}

/**
 * The countdown is presentation only. Reaching zero never sends an actuator command from a timer;
 * the operator applies the row and the roaster acknowledges the transition.
 */
export const nextManualStepRemainingSec = (
  step: PlannedManualStep | undefined,
  roastElapsedSec: number | undefined,
): number | undefined => {
  if (!step || roastElapsedSec === undefined) return undefined
  return Math.max(0, Math.ceil(step.atElapsedSec - roastElapsedSec))
}

const REVIEW_ZONE_FIELDS = [
  ['startC', 'Start °C'],
  ['endC', 'End °C'],
  ['durationSec', 'Seconds'],
  ['fanMin', 'Fan min'],
  ['fanMax', 'Fan max'],
  ['heatMin', 'Heat min'],
  ['heatMax', 'Heat max'],
] as const

type ReviewZoneField = (typeof REVIEW_ZONE_FIELDS)[number][0]

export interface ActiveJourneyZoneChange {
  zoneIndex: number
  field: ReviewZoneField
  before: number
  after: number
}

/** Exact field changes against the immutable device-owned instructions accepted at Start. */
export const activeJourneyZoneChanges = (plan: ActiveRoastPlan): ActiveJourneyZoneChange[] => {
  if (plan.mode !== 'journey' || !plan.initialZones) return []
  const changes: ActiveJourneyZoneChange[] = []
  plan.zones.forEach((zone, zoneIndex) => {
    const initial = plan.initialZones?.[zoneIndex]
    if (!initial) return
    REVIEW_ZONE_FIELDS.forEach(([field]) => {
      if (zone[field] !== initial[field]) changes.push({ zoneIndex, field, before: initial[field], after: zone[field] })
    })
  })
  return changes
}

interface RoastViewProps {
  profile: Profile
  profiles: Profile[]
  beans: BeanLot[]
  targetIntent?: ThermalIntent
  overlay?: RoastRun
  runs: RoastRun[]
  activeSession?: RoastRun
  status: ControllerStatus
  activePlan?: ActiveRoastPlan
  activePlanLoading?: boolean
  /** True only during the exact one-revision PATCH/status acknowledgement bridge. */
  activePlanReconciling?: boolean
  activePlanError?: string
  /** Honest reconnect state for the bounded display trace; durability remains on the roaster. */
  liveHistoryNotice?: string
  onActivePlanAccepted?: (plan: ActiveRoastPlan, previousPlanRev: number) => void
  onRefreshActivePlan?: () => Promise<void>
  onSaveActivePlanRevision?: () => void
  onDiscardActivePlanRevision?: () => void
  activePlanRevisionHandled?: boolean
  activePlanRevisionSaving?: boolean
  /** The coefficients the live control law inverts - the same ones the simulation is handed. */
  calibration: CalibrationSettings
  /** Saved provenance for qualifying applied-model predictions with replay error and source identity. */
  calibrationSnapshots?: CalibrationSnapshot[]
  /** Matching raw runs can establish a measured reachability lower bound. */
  calibrationRuns?: CalibrationRun[]
  ambientC: number
  elapsedSec: number
  samples: TelemetrySample[]
  events: RoastEvent[]
  startBlockedReason?: string
  modelBlockedReason?: string
  defaultMassG: number
  setupMeasurements?: BatchMeasurements
  selectedBeanId?: string
  onBean: (id?: string) => void
  onProfile: (id: string) => void
  onOverlay: (id?: string) => void
  onStart: (measurements: BatchMeasurements, beanLotId?: string, name?: string) => void
  /**
   * Start a device-executed roast through the app, which durably stages the COMPLETE run record
   * (volume, ambient, bean lot and snapshot, mass, name) in the roaster's document store BEFORE
   * commanding Start. Fail-closed: a refused record write means no Start,
   * and the returned message says why. The firmware is still handed only the plan, the sanitized
   * name and the mass; every other setup field lives in the staged record all browsers share.
   */
  onStartDeviceRoast?: (setup: {
    args: RoastStartArgs
    record: boolean
    measurements: BatchMeasurements
    beanLotId?: string
  }) => Promise<{ ok: boolean; message?: string }>
  onMeasurements: (measurements: BatchMeasurements) => void
  onNotes: (notes: string) => void
  /** Commits the completed-session draft only after the roaster acknowledges the run document. */
  onSaveDetails?: (measurements: BatchMeasurements, notes: string, score: number | undefined) => Promise<void>
  /** Why a completed run document cannot currently be changed on the roaster. */
  detailsSaveBlockedReason?: string
  onDetailsDirtyChange?: (dirty: boolean) => void
  onPlannedStepsDirtyChange?: (dirty: boolean) => void
  onCloseSession: () => void
  onAbandonSession: () => void
  revisionAvailable: boolean
  onSaveRevision: () => void
  onDismissRevision: () => void
  /** The controller's recordings, for the pre-roast retention warning. Absent on older firmware. */
  deviceLogs?: DeviceLogEntry[]
  importedLogIds?: string[]
  /** Wall clock, for the staleness half of the pre-start gate. Defaults to now when not supplied. */
  nowMs?: number
  /** Ask the app to re-read `/api/status` immediately, rather than waiting out the 5 s poll. */
  onRefreshStatus?: () => void
  /** The secondary way out of a calibration disagreement: go and look at the fit itself. */
  onOpenCalibrate?: () => void
  /** Manual is selected from the same setup row as a saved profile, but is not itself a profile. */
  manualMode?: boolean
  onManualMode?: (manual: boolean) => void
  onStartManual?: (setup: {
    measurements: BatchMeasurements
    beanLotId?: string
    name?: string
    fan: number
    heat: number
    record: boolean
  }) => void
  onSetManual?: (levels: { fan: number; heat: number }) => Promise<boolean>
  onStopManual?: () => void
  /** Authoritative device-roast Stop; preferred over browser-session handlers. */
  onStopDeviceRoast?: () => void
  manualBusy?: boolean
  /** Independent from Apply: an Apply request must never withhold the safe-direction Stop. */
  manualStopBusy?: boolean
  manualMessage?: string
  manualError?: string
  manualControlBlockedReason?: string
  /** A controller-session mismatch blocks Apply only; Stop follows authoritative roast state. */
  manualOwnershipBlockedReason?: string
  /** Authoritative post-Stop recording phase; reuse and dismissal wait until this clears. */
  manualRecordingFinalization?: { phase: 'waiting' | 'finishing' | 'saving' | 'reconciling'; detail: string }
  manualProfileBlockedReason?: string
  manualCalibrationBlockedReason?: string
  manualProfileDraftName?: string
  onManualProfileDraftName?: (name: string) => void
  onSaveManualProfile?: () => void
  onUseManualAsCalibrationEvidence?: () => void
  onSkipManualProfile?: () => void
  /** App-owned singleton; components never create a second controller connection. */
  controller?: HttpControllerClient
}

const bulkDensityLabel = (measurements?: BatchMeasurements) =>
  measurements?.startingMassG && measurements.startingVolumeMl
    ? `${(measurements.startingMassG / measurements.startingVolumeMl).toFixed(3)} g/ml bulk density`
    : 'Add volume to record bulk density'

/**
 * The Roast page is one screen in three modes, not three screens.
 *
 * - **Setup** (nothing running): the setup IS the page. Bean lot, profile, grams for this roast,
 *   and one Start. There is no "Set up roast" button that opens a panel containing a second button
 *   of the same color; the thing you came here to do is already in front of you.
 * - **Running**: the live cockpit.
 * - **Reviewing**: an open or completed session, which is what a just-started roast becomes.
 *
 * Start is gated by the same requirement filter the rest of the app uses: the message carries only
 * what is actually missing, and the button is never hidden - only disabled, with its reasons beside
 * it.
 */
export function RoastView(props: RoastViewProps) {
  const {
    profile,
    profiles,
    beans,
    targetIntent,
    overlay,
    runs,
    activeSession,
    status,
    activePlan,
    activePlanLoading = false,
    activePlanReconciling = false,
    activePlanError,
    liveHistoryNotice,
    onActivePlanAccepted,
    onRefreshActivePlan,
    onSaveActivePlanRevision,
    onDiscardActivePlanRevision,
    activePlanRevisionHandled = false,
    activePlanRevisionSaving = false,
    calibration: appCalibration,
    calibrationSnapshots = [],
    calibrationRuns = [],
    ambientC,
    elapsedSec,
    samples,
    events,
    startBlockedReason,
    modelBlockedReason,
    defaultMassG,
    setupMeasurements,
    selectedBeanId,
    onBean,
    onProfile,
    onOverlay,
    onStart,
    onStartDeviceRoast,
    onMeasurements,
    onNotes,
    onSaveDetails,
    detailsSaveBlockedReason,
    onDetailsDirtyChange,
    onPlannedStepsDirtyChange,
    onCloseSession,
    onAbandonSession,
    revisionAvailable,
    onSaveRevision,
    onDismissRevision,
    nowMs = Date.now(),
    onRefreshStatus,
    onOpenCalibrate,
    deviceLogs = [],
    importedLogIds = [],
    manualMode = false,
    onManualMode,
    onStartManual,
    onSetManual,
    onStopManual,
    onStopDeviceRoast,
    manualBusy = false,
    manualStopBusy = false,
    manualMessage,
    manualError,
    manualControlBlockedReason,
    manualOwnershipBlockedReason,
    manualRecordingFinalization,
    manualProfileBlockedReason,
    manualCalibrationBlockedReason,
    manualProfileDraftName,
    onManualProfileDraftName,
    onSaveManualProfile,
    onUseManualAsCalibrationEvidence,
    onSkipManualProfile,
    controller,
  } = props
  const activeDeviceId = status.roaster?.deviceId
  const activeRuns = useMemo(
    () => runs.filter((run) => sourceMatches(run.recordedOn, 'active', activeDeviceId)),
    [activeDeviceId, runs],
  )
  const comparableRuns = useMemo(() => activeRuns.filter((run) => run.outcome === 'complete'), [activeRuns])
  /*
   * The model this page previews with is the CONTROLLER's, whenever the controller has one.
   *
   * The roast is solved on the device against the device's own applied coefficients, so a preview
   * drawn with anything else answers a question nobody asked - and the gap between the two then
   * surfaces as a warning about a disagreement the preview itself created. See
   * `previewCalibration` for the full ladder.
   */
  const calibration = useMemo(
    () => previewCalibration(appCalibration, status.appliedCoefficients),
    [appCalibration, status.appliedCoefficients],
  )
  const lifecycle = status.lifecycle
  const active = lifecycle === 'RUNNING'
  const sample = latestSample(samples)
  const manualPresentation = activeSession ? Boolean(activeSession.manualRoast) : manualMode
  // An active manual DEVICE roast is manual presentation on every browser, session or no session:
  // overlaying the locally selected profile's plan or target on someone else's manual roast would
  // draw instructions the roaster is not following.
  const deviceManualActive = status.roast?.active === true && status.roast.mode === 'manual'
  // The mirror image: an active profiled DEVICE roast is never drawn as manual, whatever session
  // record this browser still holds - a retained manual session restored on reload, say. The chart
  // presents the roast the roaster is executing.
  const deviceProfiledActive =
    status.roast?.active === true && (status.roast.mode === 'journey' || status.roast.mode === 'timed')
  const manualChartPresentation = deviceProfiledActive ? false : manualPresentation || deviceManualActive
  const journey = !manualChartPresentation && profile.strategy === 'thermal-intent' ? targetIntent : undefined
  const finishSec = profile.strategy === 'timed' ? timedDuration(profile) : (targetPoints(profile).at(-1)?.timeSec ?? 0)

  /*
   * ==========================================================================================
   * THE LOCAL FOLD - what the CHART is drawn from, and nothing else
   * ==========================================================================================
   *
   * `liveJourneyControl` folds `journeyControlStep` - the identical function `simulateJourney`
   * threads - over this session's telemetry, so the zone boundaries, the attainment marks and the
   * stretched in-zone target line on the plot are the shared control law's own answer rather than a
   * second, differently shaped one.
   *
   * It does not feed a control PANEL. Journey control has no place on a page whose roast has not
   * started: it would be the control math run against idle telemetry as though a roast were at
   * t = 0, with recommended levels and correction wobbling with the room. Live execution numbers
   * come only from `status.roast`; the separate plan editor sends explicit revision-checked changes
   * and never computes actuator commands in the browser. Before execution, this page remains setup and preview.
   *
   * A timed profile is open loop and gets none of this - no zone, no target, no correction.
   */
  const probeReason = thermocoupleUnavailableReason(status)

  const requestedDiffers = Boolean(
    sample && (sample.requestedFan !== sample.effectiveFan || sample.requestedHeat !== sample.effectiveHeat),
  )
  const recentEvents = useMemo(() => [...events].reverse().slice(0, 6), [events])
  const latestSafetyEvent = useMemo(
    () => [...events].reverse().find((event) => event.type === 'SAFETY' || event.type === 'ABORT'),
    [events],
  )

  const [startMeasurements, setStartMeasurements] = useState<BatchMeasurements>(() =>
    setupMeasurements ? { ...setupMeasurements } : { startingMassG: defaultMassG },
  )
  const [startName, setStartName] = useState(() =>
    automaticRunName(
      profile,
      new Date(),
      beans.find((bean) => bean.id === selectedBeanId),
      startMeasurements.startingMassG,
    ),
  )
  const startNameTouched = useRef(false)
  /**
   * Whether the controller keeps 1 s temperature detail. record=0 still stores the same authoritative
   * roast occurrence, plan and accepted edit journal, sampled every 10 s, so the label must not
   * suggest (as "Record this roast" would) that turning it off throws the roast away.
   */
  // Every roast defaults to 1 s detail: calibration fits are made from 1 s Journey recordings, so a
  // freshly reloaded page must not silently start unticked and keep a roast at 10 s. Once the
  // operator touches the checkbox, switching profiles or receiving status updates must preserve
  // that explicit choice.
  const [record, setRecord] = useState(true)
  const recordTouched = useRef(false)
  const previousManualMode = useRef(manualMode)
  useEffect(() => {
    if (manualMode && !previousManualMode.current && !recordTouched.current) setRecord(true)
    previousManualMode.current = manualMode
  }, [manualMode])
  // Manual setup and the live cockpit intentionally share one draft. A status poll never writes
  // over the values the operator is preparing for the next Apply.
  const [manualFanRaw, setManualFanRaw] = useState('4')
  const [manualHeatRaw, setManualHeatRaw] = useState('0')
  const [manualAtRaw, setManualAtRaw] = useState('60')
  const [plannedManualSteps, setPlannedManualSteps] = useState<PlannedManualStep[]>([])
  const nextPlannedManualStepId = useRef(1)
  const manualDraftTouchedFor = useRef<string | undefined>(undefined)
  const manualLevels = { fan: Number(manualFanRaw), heat: Number(manualHeatRaw) }
  const manualParamProblem = manualParamError(manualLevels)
  const manualAtSec = Number(manualAtRaw)
  const manualAtProblem = manualStepTimeError(manualAtSec)
  const manualPredicted = predictedManualLevels(manualLevels)
  const reportedManualFan = status.roast?.mode === 'manual' ? status.roast.commandedFan : status.manual?.fanLevel
  const reportedManualHeat = status.roast?.mode === 'manual' ? status.roast.commandedHeat : status.manual?.heatLevel
  const manualDraftDiffers =
    reportedManualFan === undefined || reportedManualHeat === undefined
      ? false
      : Math.abs(manualLevels.fan - reportedManualFan) > 0.02 || Math.abs(manualLevels.heat - reportedManualHeat) > 0.02
  const manualApplyBlocked =
    manualControlBlockedReason ??
    manualApplyBlockedReason({
      status,
      nowMs: nowMs ?? Date.now(),
      paramError: manualParamProblem,
      busy: manualBusy,
    })
  // Stop follows the controller's roast state. Browser ownership and Apply never withhold it.
  const manualRoastStoppable = status.roast?.mode === 'manual' && status.roast.active === true
  const authoritativeManualStop = onStopDeviceRoast ?? onStopManual
  /**
   * Interrupting an active roast requires an explicit confirmation.
   * The confirm is an in-place arm on the same button (never a dialog), so an intended stop is
   * two quick taps on one spot and an accidental tap disarms itself. The device-side Stop
   * command remains unconditional once sent.
   */
  const deviceStopConfirm = useArmedConfirm()
  const manualStopConfirm = useArmedConfirm()
  const manualStopBlocked = manualStopBusy
    ? 'Stop is already being sent'
    : !authoritativeManualStop
      ? 'Stop is not available'
      : undefined

  /*
   * ==========================================================================================
   * THE ROAST RUNS ON THE CONTROLLER
   * ==========================================================================================
   *
   * Starting a roast and then closing the browser must leave the controller running that roast. So
   * Start is not the beginning of something this page does; it is
   * a single handover of the whole plan, after which this page is a spectator with no privileged
   * role. Three consequences are visible in the code below.
   *
   *   - **`status.roast` is the single source of truth while it executes.** Every number on the
   *     running panel comes from the device, because the device is the thing that decided them.
   *   - **Stop is always visible while a device roast is active**, on every state of this page,
   *     because the browser may have arrived halfway through a roast it never started.
   *   - **The controller remains autonomous after Start.** A journey may receive an explicit,
   *     revision-checked plan patch, but it never depends on a per-tick browser command channel.
   *
   * Feature detection is the PRESENCE of `status.roast`, exactly as the archive detects on
   * `log_archive`. Without it the old local-session path is what Start does, and its own gate keeps
   * it impossible on diagnostic firmware, which is the documented behaviour.
   */
  const deviceRoast = status.roast
  const executorPresent = deviceRoast !== undefined
  const deviceActive = deviceRoast?.active === true
  const deviceStatusAgeSec = Math.max(0, Math.floor((nowMs - status.receivedAtMs) / 1000))
  const [roastBusy, setRoastBusy] = useState(false)
  const [roastMessage, setRoastMessage] = useState('')
  const [roastError, setRoastError] = useState('')
  const [activePlanDraft, setActivePlanDraft] = useState<ThermalSegment[]>(() =>
    activePlan?.mode === 'journey' ? activePlan.zones.map((zone) => ({ ...zone })) : [],
  )
  const [activeTimedDraft, setActiveTimedDraft] = useState<ActiveRoastStep[]>(() =>
    activePlan?.mode === 'timed' ? activePlan.steps.map((step) => ({ ...step })) : [],
  )
  const [activePlanBusy, setActivePlanBusy] = useState(false)
  const [activePlanMessage, setActivePlanMessage] = useState('')
  type DetailsDraft = {
    runId: string
    measurements: BatchMeasurements
    notes: string
    score?: number
    savedMeasurements: BatchMeasurements
    savedNotes: string
    savedScore?: number
  }
  const [detailsDraft, setDetailsDraftState] = useState<DetailsDraft>()
  /*
   * The draft is also held in a ref that every writer updates synchronously. Save first blurs the
   * focused field so its value commits, and that commit is a state update the save handler cannot
   * see in its own render's closure. Reading the ref after the blur is what makes the values sent
   * to the roaster the same values then marked saved.
   */
  const detailsDraftRef = useRef<DetailsDraft>()
  const setDetailsDraft = (
    next: DetailsDraft | undefined | ((current: DetailsDraft | undefined) => DetailsDraft | undefined),
  ) => {
    const resolved = typeof next === 'function' ? next(detailsDraftRef.current) : next
    detailsDraftRef.current = resolved
    setDetailsDraftState(resolved)
  }
  const [detailsSaveState, setDetailsSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')
  const [detailsSaveError, setDetailsSaveError] = useState('')
  // Synchronous in-flight guard: a second tap before the 'saving' render lands must not send twice.
  const detailsSavingRef = useRef(false)
  // Detail fields whose box holds a number typed but not yet committed by blur. Such text is
  // unsaved work that exists only in this tab, so it enables Save and raises the leave guard.
  const [detailsTypingFields, setDetailsTypingFields] = useState<Partial<Record<keyof BatchMeasurements, boolean>>>({})
  const trackDetailsTyping = (field: keyof BatchMeasurements) => (uncommitted: boolean) =>
    setDetailsTypingFields((current) =>
      Boolean(current[field]) === uncommitted ? current : { ...current, [field]: uncommitted },
    )
  const [activePlanEditError, setActivePlanEditError] = useState('')
  useEffect(() => {
    if (!activePlanMessage) return
    const timer = window.setTimeout(() => setActivePlanMessage(''), 4500)
    return () => window.clearTimeout(timer)
  }, [activePlanMessage])
  useEffect(() => {
    if (!activeSession || activeSession.outcome === 'running') {
      setDetailsDraft(undefined)
      setDetailsSaveState('idle')
      setDetailsSaveError('')
      return
    }
    const measurements = { ...activeSession.measurements }
    const score = runScore(activeSession)
    setDetailsDraft({
      runId: activeSession.id,
      measurements,
      notes: activeSession.notes,
      score,
      savedMeasurements: measurements,
      savedNotes: activeSession.notes,
      savedScore: score,
    })
    setDetailsSaveState('idle')
    setDetailsSaveError('')
  }, [activeSession?.id, activeSession?.outcome])
  const [confirmImmediateTransition, setConfirmImmediateTransition] = useState(false)
  const activePlanKey = activePlan
    ? `${activePlan.bootId ?? ''}:${activePlan.sessionId ?? ''}:${activePlan.planRev ?? ''}`
    : ''
  useEffect(() => {
    if (activePlan?.mode === 'timed') {
      setActiveTimedDraft(activePlan.steps.map((step) => ({ ...step })))
      setActivePlanDraft([])
    } else if (activePlan?.mode === 'journey') {
      setActivePlanDraft(activePlan.zones.map((zone) => ({ ...zone })))
      setActiveTimedDraft([])
    } else {
      setActivePlanDraft([])
      setActiveTimedDraft([])
    }
    setConfirmImmediateTransition(false)
    setActivePlanEditError('')
  }, [activePlanKey])
  const currentPlanZone = Math.max(0, deviceRoast?.zoneIndex ?? 0)
  const activePlanProblem =
    activePlan?.mode === 'journey'
      ? activeJourneyEditProblem(activePlan.zones, activePlanDraft, currentPlanZone, deviceRoast?.zoneElapsedSec ?? 0)
      : undefined
  const updateTimedStep = (index: number, field: keyof ActiveRoastStep, value: string) => {
    const parsed = Number(value)
    setActiveTimedDraft((current) =>
      current.map((step, stepIndex) => (stepIndex === index ? { ...step, [field]: parsed } : step)),
    )
    setActivePlanMessage('')
    setActivePlanEditError('')
  }

  const patchTimedStep = async (index: number) => {
    const step = activeTimedDraft[index]
    const problem = activeTimedStepProblem(step, index, deviceRoast?.stepIndex ?? 0, deviceRoast?.stepElapsedSec ?? 0)
    if (
      !controller ||
      !activePlan?.sessionId ||
      activePlan.mode !== 'timed' ||
      activePlan.planRev === undefined ||
      problem ||
      activePlanBusy
    ) {
      if (problem) setActivePlanEditError(problem)
      return
    }
    setActivePlanBusy(true)
    setActivePlanEditError('')
    setActivePlanMessage('')
    const result = await controller.patchActiveTimedRoastStep(index, step, activePlan.sessionId, activePlan.planRev)
    setActivePlanBusy(false)
    if (result.ok) {
      setActiveTimedDraft(result.plan.steps.map((accepted) => ({ ...accepted })))
      setActivePlanMessage(`Step ${index + 1} is accepted on the roaster.`)
      onActivePlanAccepted?.(result.plan, activePlan.planRev)
    } else {
      setActivePlanEditError(result.message)
      if (result.planRev !== undefined || (result.sessionId && result.sessionId !== activePlan.sessionId))
        void onRefreshActivePlan?.()
    }
  }
  const patchActivePlan = async (allowImmediateTransition = false) => {
    if (
      !controller ||
      !activePlan?.sessionId ||
      activePlan.planRev === undefined ||
      activePlanProblem ||
      activePlanBusy
    )
      return
    setActivePlanBusy(true)
    setActivePlanEditError('')
    setActivePlanMessage('')
    const result: ActivePlanPatchResult = await controller.patchActiveRoastPlan(
      activePlanDraft,
      activePlan.sessionId,
      activePlan.planRev,
      allowImmediateTransition,
    )
    setActivePlanBusy(false)
    if (result.ok) {
      setConfirmImmediateTransition(false)
      setActivePlanDraft(result.plan.zones.map((zone) => ({ ...zone })))
      setActivePlanMessage(
        result.immediateTransition
          ? 'Plan updated; the roaster advanced through the crossed endpoint.'
          : 'The roaster accepted the updated plan.',
      )
      onActivePlanAccepted?.(result.plan, activePlan.planRev)
      return
    }
    if (result.requiresImmediateTransition) {
      setConfirmImmediateTransition(true)
      setActivePlanEditError(
        'The new endpoint has already been crossed. Confirm once more to apply it and advance immediately.',
      )
      return
    }
    const stale = result.planRev !== undefined && result.planRev !== activePlan.planRev
    if (stale) {
      setActivePlanEditError('The plan changed on another browser. The current roaster plan is being reloaded.')
      await onRefreshActivePlan?.()
      return
    }
    setActivePlanEditError(result.message)
  }

  const updateActiveZone = (index: number, field: keyof ThermalSegment, raw: string) => {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    setActivePlanDraft((current) => editActiveJourneyZone(current, index, currentPlanZone, { [field]: value }))
    setConfirmImmediateTransition(false)
    setActivePlanEditError('')
    setActivePlanMessage('')
  }

  /*
   * The gate is handed the APP's own set, deliberately - not the merged preview one. Feasibility
   * inside it already runs against the device's coefficients; what the app's set is needed for is
   * the one remaining honest comparison, "you have fitted something you have not applied yet".
   */
  const preflight = useMemo(
    () =>
      roastPreflight({
        profile,
        intent: journey,
        status,
        massG: startMeasurements.startingMassG,
        ambientC,
        calibration: appCalibration,
        roastRuns: runs,
        calibrationSnapshots,
        calibrationRuns,
        nowMs: nowMs ?? Date.now(),
        busy: roastBusy,
      }),
    [
      ambientC,
      appCalibration,
      calibrationRuns,
      calibrationSnapshots,
      journey,
      nowMs,
      profile,
      roastBusy,
      runs,
      startMeasurements.startingMassG,
      status,
    ],
  )

  /**
   * What starting this roast would cost the archive, said BEFORE it is started.
   *
   * If starting a roast will cause an older recording to be deleted, the user is told before Start.
   *
   * Informational, never a blocker: a roast the user wants is worth more than a recording they have
   * already imported, and only they can weigh that. The arithmetic is in `domain/storage.ts`.
   */
  const retention = useMemo(
    () =>
      retentionWarning({
        archive: status.logArchive,
        dataStore: status.dataStore,
        logs: deviceLogs,
        importedLogIds: new Set(importedLogIds),
        averageRecordingBytes:
          deviceLogs.length > 0
            ? deviceLogs.reduce((total, entry) => total + recordingBytes(entry), 0) / deviceLogs.length
            : 0,
        record,
      }),
    [deviceLogs, importedLogIds, record, status.dataStore, status.logArchive],
  )

  const startOnDevice = async () => {
    if (!onStartDeviceRoast || preflight.blockers.length > 0) return
    const args = roastStartArgs({
      profile,
      name: startName.trim() || undefined,
      intent: journey,
      massG: startMeasurements.startingMassG,
      startC: status.temperatureC,
    })
    if (typeof args === 'string') {
      setRoastError(args)
      setRoastMessage('')
      return
    }
    setRoastBusy(true)
    // The app stages the complete run record on the roaster first, then commands Start;
    // record=0 selects the compact 10 s archive, absence keeps detailed 1 s telemetry.
    const result = await onStartDeviceRoast({
      args,
      record,
      measurements: startMeasurements,
      beanLotId: selectedBeanId,
    })
    setRoastError(result.ok ? '' : (result.message ?? 'The roaster refused the roast'))
    setRoastMessage('')
    setRoastBusy(false)
    onRefreshStatus?.()
  }

  const stopOnDevice = async () => {
    if (!controller) return
    setRoastBusy(true)
    const result = await controller.stopRoast()
    setRoastError(result.ok ? '' : (result.message ?? 'The roaster did not acknowledge the stop'))
    setRoastMessage(result.ok ? 'Stop acknowledged. Heat is off; the fan is cooling for 10 seconds.' : '')
    setRoastBusy(false)
    onRefreshStatus?.()
  }

  /**
   * Ending the calibration disagreement from the banner that reports it.
   *
   * The notice must not bury the action in prose pointing at another screen. Applying a fit is one request the controller already accepts, so the banner
   * makes it - and on success `status.appliedCoefficients` comes back equal to this app's set, the
   * divergence check stops firing, and the banner removes itself. Nothing has to be dismissed.
   *
   * The fit id travels for traceability, exactly as Calibrate sends it, so the controller can say
   * afterwards which fit it is holding. `applyCalibration` sanitizes it to the firmware's alphabet.
   */
  const myCoefficients = {
    heaterGainCPerMinAt10: appCalibration.heaterGainCPerMinAt10,
    fanCoolingCPerMinAt10: appCalibration.fanCoolingCPerMinAt10,
    coolingFanCPerMinAt10: appCalibration.coolingFanCPerMinAt10,
    thermalLossPerMinPerC: appCalibration.thermalLossPerMinPerC,
  }
  const appliedCalibrationCompatibility = status.roaster
    ? calibrationSettingsCompatibility(appCalibration, status.roaster)
    : undefined
  const calibrationProvenanceBlockedReason = !status.roaster
    ? 'The roaster has not reported its device and model identity, so calibration cannot be applied safely.'
    : appliedCalibrationCompatibility && !appliedCalibrationCompatibility.compatible
      ? appliedCalibrationCompatibility.message
      : undefined
  const applyMyCalibration = async () => {
    if (!controller || applyBlockedReason) return
    if (
      appliedCalibrationCompatibility?.kind === 'same-model-different-device' &&
      !window.confirm(
        `${appliedCalibrationCompatibility.warning}\n\nApply these coefficients to ${status.roaster?.displayName ?? 'this roaster'}?`,
      )
    )
      return
    setRoastBusy(true)
    const result = await controller.applyCalibration(
      myCoefficients,
      appCalibration.thermalSourceRunId ?? `app-${appCalibration.updatedAt.slice(0, 10)}`,
    )
    setRoastError(result.ok ? '' : (result.message ?? 'The roaster refused the coefficients'))
    setRoastMessage(result.ok ? 'The roaster is now using your calibration.' : '')
    setRoastBusy(false)
    onRefreshStatus?.()
  }
  /** Said on the button rather than discovered as a 409: the firmware stores coefficients only idle. */
  const applyBlockedReason =
    modelBlockedReason ?? calibrationProvenanceBlockedReason ?? calibrationApplyBlockedReason(status)
  /*
   * Whether this app has anything worth offering to apply. Asked before the button is drawn rather
   * than after it is pressed: the firmware refuses an implausible set, so offering it would be a
   * dead end, and the only honest affordance left in that state is the Calibrate page.
   */
  const canOfferMyCalibration = implausibleCoefficient(myCoefficients) === undefined

  const ended = !deviceActive ? roastEndReasonText(deviceRoast?.endReason) : undefined

  // The batch actually being roasted, or the one about to be. The control law must be handed the
  // same mass the simulation would be, or the two answers are not comparable.
  const measurements = activeSession?.measurements ?? startMeasurements
  const reading = useMemo(
    () =>
      journey
        ? liveJourneyControl({
            intent: journey,
            samples,
            elapsedSec,
            ambientC,
            massG: measurements.startingMassG,
            volumeMl: measurements.startingVolumeMl,
            calibration,
            probeC: probeReason === undefined ? status.temperatureC : undefined,
          })
        : undefined,
    [
      ambientC,
      calibration,
      elapsedSec,
      journey,
      measurements.startingMassG,
      measurements.startingVolumeMl,
      probeReason,
      samples,
      status.temperatureC,
    ],
  )
  const deviceJourneyChart = useMemo(
    () =>
      activePlan?.mode === 'journey' &&
      deviceRoast?.mode === 'journey' &&
      activePlan.bootId === status.bootId &&
      activePlan.sessionId === deviceRoast.sessionId
        ? deviceJourneyChartState(activePlan.zones, deviceRoast)
        : undefined,
    [activePlan, deviceRoast, status.bootId],
  )
  const journeyScore =
    !deviceActive && deviceRoast?.mode === 'journey' && deviceJourneyChart
      ? deviceJourneyChart.zones.map((zone) => ({
          ...zone,
          driftSec:
            zone.actualDurationSec === undefined
              ? undefined
              : Math.round(zone.actualDurationSec - zone.nominalDurationSec),
        }))
      : []

  const targetTemperatureC = deviceActive ? deviceRoast?.targetC : reading?.targetC
  const deviceZonesComplete =
    deviceRoast?.zoneAttainedSec?.filter((value) => value !== null).length ??
    (deviceRoast?.mode === 'journey' ? (deviceRoast.zoneIndex ?? 0) : undefined)
  const targetError = sample && targetTemperatureC != null ? sample.beanTempC - targetTemperatureC : undefined
  const selectedStartBean = beans.find((bean) => bean.id === selectedBeanId)
  const suggestedStartName = automaticRunName(profile, new Date(), selectedStartBean, startMeasurements.startingMassG)
  useEffect(() => {
    if (!startNameTouched.current) setStartName(suggestedStartName)
  }, [suggestedStartName])

  // The roaster-owned catalog order is the same everywhere. Past use never silently reshuffles
  // this selector away from the order the user chose on Profiles.
  const profileOption = (item: Profile) => (
    <option key={item.id} value={item.id}>
      {item.strategy === 'timed' ? 'Timed' : 'Journey'} / {item.name}
    </option>
  )

  // Everything Start needs, as a list that renders only what is still missing.
  const startRequirements = useMemo<Requirement[]>(
    () => [
      { key: 'mass', need: 'a batch weight for this roast', met: (startMeasurements.startingMassG ?? 0) > 0 },
      {
        key: 'roaster',
        need: startBlockedReason ? startBlockedReason.toLowerCase() : 'a roaster that is ready',
        met: !startBlockedReason,
      },
    ],
    [startBlockedReason, startMeasurements.startingMassG],
  )
  const legacyMissing = requirementSentence(startRequirements, 'Start needs')
  const legacyCanStart = unmetRequirements(startRequirements).length === 0
  /*
   * Two gates, and which one applies is decided by the firmware rather than by a flag.
   *
   * With the executor present, `roastPreflight` is the gate: it mirrors the firmware's own start
   * gates in the firmware's own order, and adds the one the firmware structurally cannot check -
   * whether every zone is reachable at all. Without the executor the old allow-list applies and
   * keeps Start impossible on diagnostic firmware, which is the documented behaviour.
   */
  const profiledStartMissing = executorPresent
    ? // The blocker's own sentence, as its own sentence: prefixing "Start needs" to one that already
      // begins "A journey roast needs..." produced a tooltip nobody could read.
      (preflight.blockers[0] ?? '')
    : legacyMissing
  const profiledCanStart = executorPresent ? preflight.blockers.length === 0 : legacyCanStart
  // Starting a first-class manual roast is not a diagnostic actuator command. Its controller gate
  // arrives through startBlockedReason; diagnosticTests is relevant only to Apply while running.
  const manualStartMissing =
    (manualBusy ? 'A manual command is in flight' : manualParamProblem) ??
    ((startMeasurements.startingMassG ?? 0) <= 0
      ? 'A batch weight is required for this roast'
      : (startBlockedReason ?? ''))
  const startMissing = manualMode ? manualStartMissing : profiledStartMissing
  const canStart = manualMode ? manualStartMissing === '' : profiledCanStart

  const completedDetails: { measurements: BatchMeasurements; notes: string; score?: number } =
    activeSession?.outcome !== 'running' && detailsDraft && detailsDraft.runId === activeSession?.id
      ? detailsDraft
      : activeSession
        ? { measurements: activeSession.measurements ?? {}, notes: activeSession.notes, score: runScore(activeSession) }
        : { measurements: {}, notes: '' }
  const detailsDraftDiffers = Boolean(
    activeSession &&
      activeSession.outcome !== 'running' &&
      detailsDraft?.runId === activeSession.id &&
      (detailsDraft.notes !== detailsDraft.savedNotes ||
        detailsDraft.score !== detailsDraft.savedScore ||
        !stableEquals(detailsDraft.measurements, detailsDraft.savedMeasurements)),
  )
  const detailsTyping = Boolean(
    activeSession && activeSession.outcome !== 'running' && Object.values(detailsTypingFields).some(Boolean),
  )
  const detailsDirty = detailsDraftDiffers || detailsTyping
  /*
   * The stored run can change under the same id and outcome - another tab saved, a re-import
   * replaced it, the roaster normalised a value. A draft with no edits in it is re-seeded from the
   * stored values, so a later Save can never write stale values back. A draft holding edits, or one
   * being saved, is left alone.
   */
  const storedDetailsScore = activeSession ? runScore(activeSession) : undefined
  useEffect(() => {
    const current = detailsDraftRef.current
    if (!activeSession || activeSession.outcome === 'running' || !current || current.runId !== activeSession.id) return
    if (detailsSavingRef.current || detailsDirty) return
    const measurements = { ...activeSession.measurements }
    if (
      stableEquals(measurements, current.savedMeasurements) &&
      activeSession.notes === current.savedNotes &&
      storedDetailsScore === current.savedScore
    )
      return
    setDetailsDraft({
      runId: activeSession.id,
      measurements,
      notes: activeSession.notes,
      score: storedDetailsScore,
      savedMeasurements: measurements,
      savedNotes: activeSession.notes,
      savedScore: storedDetailsScore,
    })
  }, [activeSession?.measurements, activeSession?.notes, storedDetailsScore, detailsDirty, detailsSaveState])
  useEffect(() => {
    onDetailsDirtyChange?.(detailsDirty)
  }, [detailsDirty, onDetailsDirtyChange])
  useEffect(() => () => onDetailsDirtyChange?.(false), [onDetailsDirtyChange])

  // An edit never downgrades an in-flight save: 'saving' stays until the roaster answers, so Save
  // cannot be pressed again mid-flight. The answer then decides between saved and still-unsaved.
  const markDetailsEdited = () => {
    setDetailsSaveState((state) => (state === 'saving' ? state : 'dirty'))
    setDetailsSaveError('')
  }
  const setMeasurement = (field: keyof BatchMeasurements, value: number | undefined, starting = false) => {
    const draftBase =
      detailsDraftRef.current?.runId === activeSession?.id ? detailsDraftRef.current?.measurements : undefined
    const next = { ...(starting ? startMeasurements : (draftBase ?? completedDetails.measurements)) }
    if (value === undefined) delete next[field]
    else next[field] = value
    if (starting) setStartMeasurements(next)
    else if (activeSession && activeSession.outcome !== 'running') {
      setDetailsDraft((current) => (current?.runId === activeSession.id ? { ...current, measurements: next } : current))
      markDetailsEdited()
    } else onMeasurements(next)
  }
  const setCompletedScore = (score: number | undefined) => {
    if (!activeSession || activeSession.outcome === 'running') return
    setDetailsDraft((current) => (current?.runId === activeSession.id ? { ...current, score } : current))
    markDetailsEdited()
  }
  const setCompletedNotes = (notes: string) => {
    if (activeSession?.outcome === 'running') {
      onNotes(notes)
      return
    }
    if (!activeSession) return
    setDetailsDraft((current) => (current?.runId === activeSession.id ? { ...current, notes } : current))
    markDetailsEdited()
  }
  const saveCompletedDetails = async () => {
    if (
      !activeSession ||
      activeSession.outcome === 'running' ||
      !onSaveDetails ||
      detailsSavingRef.current ||
      detailsSaveState === 'saving' ||
      manualFinalizing
    )
      return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    // After the blur: the ref, not this render's closure, holds the field that just committed.
    const sent = detailsDraftRef.current?.runId === activeSession.id ? detailsDraftRef.current : undefined
    if (!sent) return
    const sentMeasurements = { ...sent.measurements }
    detailsSavingRef.current = true
    setDetailsSaveState('saving')
    setDetailsSaveError('')
    try {
      await onSaveDetails(sentMeasurements, sent.notes, sent.score)
      // Mark saved exactly what was sent. An edit made while the save was in flight stays dirty.
      setDetailsDraft((current) =>
        current?.runId === activeSession.id
          ? { ...current, savedMeasurements: sentMeasurements, savedNotes: sent.notes, savedScore: sent.score }
          : current,
      )
      const latest = detailsDraftRef.current
      const draftIsWhatWasSent =
        latest?.runId === activeSession.id &&
        latest.notes === sent.notes &&
        latest.score === sent.score &&
        stableEquals(latest.measurements, sentMeasurements)
      setDetailsSaveState(draftIsWhatWasSent ? 'saved' : 'dirty')
    } catch (error) {
      setDetailsSaveError(error instanceof Error ? error.message : 'The roaster did not confirm these roast details.')
      setDetailsSaveState('error')
    } finally {
      detailsSavingRef.current = false
    }
  }
  const closeCompletedSession = () => {
    if (detailsDirty && !window.confirm(LEAVE_WITHOUT_SAVING)) return
    onCloseSession()
  }
  const closeManualReview = () => {
    if (detailsDirty && !window.confirm(LEAVE_WITHOUT_SAVING)) return
    onSkipManualProfile?.()
  }

  const begin = () => {
    if (!canStart) return
    if (manualMode) {
      onStartManual?.({
        measurements: startMeasurements,
        beanLotId: selectedBeanId,
        name: startName.trim() || undefined,
        ...manualLevels,
        record,
      })
      return
    }
    if (executorPresent) {
      void startOnDevice()
      return
    }
    onStart(startMeasurements, selectedBeanId, startName.trim() || undefined)
    setStartName('')
  }

  // The chart owns its own options: an overlay is a charting choice, not part of the roast.
  // A comparison is chosen before a roast or reviewed after it. While outputs are running the
  // selector would only take chart space, so it is withheld; an overlay chosen beforehand keeps
  // drawing under its "Comparison" key. With no finished roast there is nothing to offer.
  const outputsRunning = deviceActive || activeSession?.outcome === 'running' || status.manual?.active === true
  const chartToolbar =
    outputsRunning || comparableRuns.length === 0 ? undefined : (
      <div className="chart-source-controls">
        <label className="chart-option">
          Compare with
          <select value={overlay?.id ?? ''} onChange={(event) => onOverlay(event.currentTarget.value || undefined)}>
            <option value="">No comparison</option>
            {comparableRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    )

  const authoritativeManualActive =
    (status.roast?.mode === 'manual' && status.roast.active === true) || status.manual?.active === true
  /*
   * The interactive cockpit belongs to a browser holding this roast's own running session, or one
   * steering idle Controls levels (`status.manual`). A browser that merely observes an active
   * manual roast is a spectator: its Apply would be refused by session-fenced command gating, so
   * offering the cockpit would present a dead control as live. Spectators keep the authoritative
   * device-roast panel instead, which carries the clock, the accepted levels, and Stop.
   */
  const manualSessionRunning = activeSession?.manualRoast !== undefined && activeSession.outcome === 'running'
  const manualRunning = manualSessionRunning || status.manual?.active === true
  const manualFinalizing =
    manualPresentation && activeSession !== undefined && manualRecordingFinalization !== undefined
  const manualFinished =
    manualPresentation && activeSession !== undefined && activeSession.outcome !== 'running' && !manualFinalizing
  const [manualDraftSeededFor, setManualDraftSeededFor] = useState<string>()
  const manualDraftSessionKey =
    activeSession?.id ??
    (status.manual?.active ? `controls-${status.bootId}` : status.roast?.sessionId) ??
    (authoritativeManualActive ? 'active-manual-roast' : undefined)
  const nextManualRemainingSec = nextManualStepRemainingSec(plannedManualSteps[0], status.roast?.elapsedSec)
  useEffect(() => {
    onPlannedStepsDirtyChange?.(manualRunning && plannedManualSteps.length > 0)
  }, [manualRunning, onPlannedStepsDirtyChange, plannedManualSteps.length])
  useEffect(() => () => onPlannedStepsDirtyChange?.(false), [onPlannedStepsDirtyChange])
  useEffect(() => {
    setPlannedManualSteps([])
    nextPlannedManualStepId.current = 1
  }, [manualDraftSessionKey])
  useEffect(() => {
    if (!manualRunning || !manualDraftSessionKey || manualDraftSeededFor === manualDraftSessionKey) return
    if (
      manualDraftTouchedFor.current === manualDraftSessionKey ||
      manualControlBlockedReason ||
      manualOwnershipBlockedReason
    )
      return
    const roast = status.roast
    const fan =
      roast?.active && roast.mode === 'manual'
        ? roast.commandedFan
        : status.manual?.active
          ? status.manual.fanLevel
          : undefined
    const heat =
      roast?.active && roast.mode === 'manual'
        ? roast.commandedHeat
        : status.manual?.active
          ? status.manual.heatLevel
          : undefined
    if (fan === undefined || heat === undefined) return
    setManualFanRaw(String(fan))
    setManualHeatRaw(String(heat))
    setManualDraftSeededFor(manualDraftSessionKey)
  }, [
    manualControlBlockedReason,
    manualDraftSeededFor,
    manualDraftSessionKey,
    manualOwnershipBlockedReason,
    manualRunning,
    status.manual,
    status.roast,
  ])
  const resetManualDraft = () => {
    if (reportedManualFan === undefined || reportedManualHeat === undefined) return
    setManualFanRaw(String(reportedManualFan))
    setManualHeatRaw(String(reportedManualHeat))
  }
  const applyManual = () => {
    if (manualApplyBlocked) return
    void onSetManual?.(manualLevels)
  }
  const addPlannedManualStep = () => {
    if (manualParamProblem || manualAtProblem) return
    const id = nextPlannedManualStepId.current
    nextPlannedManualStepId.current += 1
    setPlannedManualSteps((current) =>
      [
        ...current,
        {
          id,
          ...manualLevels,
          atElapsedSec: manualAtSec,
        },
      ].sort((a, b) => a.atElapsedSec - b.atElapsedSec || a.id - b.id),
    )
    setManualAtRaw(String(Math.min(ROAST_LIMITS.stepSeconds.max, manualAtSec + 60)))
  }
  const updatePlannedManualStep = (id: number, field: 'fan' | 'heat' | 'atElapsedSec', raw: string) => {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    setPlannedManualSteps((current) =>
      current
        .map((step) => (step.id === id ? { ...step, [field]: value } : step))
        .sort((a, b) => a.atElapsedSec - b.atElapsedSec || a.id - b.id),
    )
  }
  const applyPlannedManualStep = async (step: PlannedManualStep) => {
    const problem = manualParamError(step) ?? manualStepTimeError(step.atElapsedSec)
    if (problem || manualApplyBlocked || !onSetManual) return
    const accepted = await onSetManual({ fan: step.fan, heat: step.heat })
    if (accepted) setPlannedManualSteps((current) => current.filter((candidate) => candidate.id !== step.id))
  }
  const removePlannedManualStep = (id: number) =>
    setPlannedManualSteps((current) => current.filter((candidate) => candidate.id !== id))

  const setupVisible = !activeSession && !deviceActive && status.manual?.active !== true
  const title = roastViewTitle({
    deviceActive,
    controlsActive: status.manual?.active === true,
    sessionName: activeSession?.name,
  })
  return (
    <section
      className={`view roast-view ${active ? 'active-roast' : ''}${setupVisible ? ' setup-roast' : ''}${manualPresentation ? ' manual-roast' : ''}`}
    >
      <div className="roast-topbar">
        <div>
          <span className="eyebrow">Roast desk</span>
          <h1>{title}</h1>
        </div>
        <div className="roast-state">
          <LifecycleBadge lifecycle={lifecycle} connected={status.connected} stale={status.stale} />
        </div>
      </div>

      {((status.connected && status.fault) || latestSafetyEvent) && (
        <div className="mobile-safety-banner">
          <strong>{status.connected && status.fault ? 'Roaster fault' : latestSafetyEvent?.label}</strong>
          <span>
            {(status.connected ? status.fault : undefined) ??
              latestSafetyEvent?.detail ??
              'Roast stopped by a safety event.'}
          </span>
        </div>
      )}

      {(roastMessage || roastError) && (
        <div className={roastError ? 'storage-error-banner' : 'import-message'} role={roastError ? 'alert' : 'status'}>
          <span>{roastError || roastMessage}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss roast message"
            onClick={() => {
              setRoastMessage('')
              setRoastError('')
            }}
          >
            x
          </button>
        </div>
      )}
      {(manualMessage || manualError) && !manualRunning && !manualFinalizing && (
        <div
          className={`manual-command-message ${manualError ? 'error' : 'confirmed'}`}
          role={manualError ? 'alert' : 'status'}
        >
          <strong>{manualError ? 'Manual command not accepted' : 'Manual roast status'}</strong>
          <span>{manualError || manualMessage}</span>
        </div>
      )}

      {manualFinalizing && (
        <div className="manual-recording-finalization" role="status">
          <strong>Finalizing the roaster recording</strong>
          <span>{manualRecordingFinalization.detail}</span>
          <small>
            Keep this roast open. Save and close options appear after the roaster-owned recording is verified in
            History.
          </small>
        </div>
      )}
      {/*
      The device roast, while it is the thing that is happening.

      Every number here comes from `status.roast` - the DEVICE - because the device is what decided
      them. Stop is inside this panel rather than in the actions column so that it is present on
      every route into this screen, including a browser that arrived halfway through a roast it
      never started; that is the one command a spectator must always have.

      The gate is the absence of this browser's own running manual session - the cockpit is the
      fuller presentation of the same roast - never browser-local mode state: a manual roast on the
      device must show its clock and accepted levels on every browser that opens this page.
    */}
      {executorPresent && deviceActive && !manualSessionRunning && (
        <section className="device-roast-panel" aria-label="Roast running on the roaster">
          <div className="device-roast-head">
            <div>
              <span className="eyebrow">{roastModeLabel(deviceRoast?.mode)}</span>
              <strong>{deviceRoast?.name ?? 'Roast'}</strong>
            </div>
            <button
              type="button"
              className={deviceStopConfirm.armed ? 'command-button stop-command armed' : 'command-button stop-command'}
              disabled={roastBusy}
              title="A first tap asks for confirmation; a second tap within a few seconds stops the roast."
              onClick={() => {
                if (deviceStopConfirm.fire()) void stopOnDevice()
              }}
            >
              <StopIcon size={19} />
              {deviceStopConfirm.armed ? 'Tap again to stop' : 'Stop roast'}
            </button>
          </div>
          {(status.stale || !status.connected) && (
            <p className="device-roast-stale" role="status">
              Last roaster update {deviceStatusAgeSec} {deviceStatusAgeSec === 1 ? 'second' : 'seconds'} ago. Values
              below are not current.
            </p>
          )}
          <div className="device-roast-grid">
            {deviceRoast?.mode === 'journey' ? (
              <div>
                <span>Zone</span>
                <strong>
                  {(deviceRoast.zoneIndex ?? 0) + 1} of {deviceRoast.zoneCount ?? '--'}
                </strong>
                <small>
                  {formatClock(deviceRoast.zoneElapsedSec ?? 0)} of {formatClock(deviceRoast.zoneNominalSec ?? 0)}{' '}
                  nominal
                </small>
              </div>
            ) : deviceRoast?.mode === 'manual' ? (
              <div>
                <span>Instructions</span>
                <strong>Operator-directed</strong>
                <small>Fan and Heat follow the latest accepted instruction</small>
              </div>
            ) : (
              <div>
                <span>Step</span>
                <strong>
                  {(deviceRoast?.stepIndex ?? 0) + 1} of {deviceRoast?.stepCount ?? '--'}
                </strong>
                <small>exact durations</small>
              </div>
            )}
            {deviceRoast?.mode === 'journey' && (
              <div>
                <span>Zone target</span>
                <strong>{deviceRoast.targetC === undefined ? '--' : `${deviceRoast.targetC.toFixed(1)} °C`}</strong>
                <small>
                  {deviceRoast.zoneEndC === undefined ? 'open loop' : `ends at ${deviceRoast.zoneEndC.toFixed(0)} °C`}
                </small>
              </div>
            )}
            {/* A manual roast has no control law; claiming "waiting" for a correction that will never
            come would misreport the operator's own steering as a stalled controller. */}
            {deviceRoast?.mode !== 'manual' && (
              <div className={deviceRoast?.saturated ? 'correction saturated' : 'correction'}>
                <span>Target tracking</span>
                <strong>
                  {deviceRoast?.holdover
                    ? 'Waiting for temperature'
                    : deviceRoast?.correctionTotal === undefined
                      ? '--'
                      : Math.abs(deviceRoast.correctionTotal) <= 0.05
                        ? 'No automatic adjustment'
                        : `Automatic adjustment ${deviceRoast.correctionTotal >= 0 ? '+' : ''}${deviceRoast.correctionTotal.toFixed(1)} °C/min`}
                </strong>
                <small>
                  {deviceRoast?.holdover
                    ? `No reading for ${Math.round((deviceRoast.holdoverMs ?? 0) / 1000)} s; Heat stops after ${Math.round((deviceRoast.holdoverLimitMs ?? 30000) / 1000)} s without one.`
                    : deviceRoast?.correctionTotal === undefined
                      ? 'Waiting for the roaster'
                      : `Controller correction applied to follow the adjusted target${deviceRoast?.saturated ? ' / maximum adjustment reached' : ''}.`}
                </small>
              </div>
            )}

            <div>
              <span>Batch</span>
              <strong>{deviceRoast?.batchMassG ?? '--'} g</strong>
              <small>ambient {deviceRoast?.ambientC?.toFixed(1) ?? '--'} °C, frozen at start</small>
            </div>
          </div>
        </section>
      )}

      {executorPresent && !manualPresentation && activePlanLoading && (
        <div className="active-plan-status" role="status">
          Reading the exact plan from the roaster...
        </div>
      )}
      {executorPresent && deviceActive && !manualPresentation && liveHistoryNotice && (
        <div className="active-plan-status" role="status">
          {liveHistoryNotice}
        </div>
      )}
      {executorPresent && !manualPresentation && activePlanError && (
        <div className="storage-error-banner" role="alert">
          <span>{activePlanError}</span>
          <button type="button" className="secondary-button" onClick={() => void onRefreshActivePlan?.()}>
            Retry
          </button>
        </div>
      )}
      {/* What the controller did, for a browser that was not here when it happened. */}
      {!manualPresentation && executorPresent && ended && (
        <div className="device-roast-ended" role="status">
          <Server size={18} />
          <div>
            <strong>
              {deviceRoast?.name ? `${deviceRoast.name}: ` : ''}
              {ended.headline}
            </strong>
            <span>{ended.detail}</span>
          </div>
        </div>
      )}

      {setupVisible && (
        <section className="roast-setup">
          {/*
        One control row, one baseline. Every field is the same three-part stack - label, control,
        hint - and the hint is absolutely positioned under the row, so a note beneath one field can
        never push its control out of line with the others.
      */}
          <div className="setup-row">
            <label className="setup-field">
              <span className="form-field-label">Bean lot</span>
              <select
                value={selectedBeanId ?? ''}
                disabled={active}
                onChange={(event) => onBean(event.currentTarget.value || undefined)}
              >
                <option value="">Unspecified</option>
                {beans.map((bean) => (
                  <option value={bean.id} key={bean.id}>
                    {bean.name}
                  </option>
                ))}
              </select>
              <small className="setup-hint">
                {selectedStartBean?.origins.join(', ') ||
                  'Optional — links this roast to its beans so they can be compared later.'}
              </small>
            </label>
            <label className="setup-field">
              <span className="form-field-label">Profile</span>
              <select
                value={manualMode ? '__manual__' : profile.id}
                disabled={active}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  if (value === '__manual__') {
                    onManualMode?.(true)
                    return
                  }
                  onManualMode?.(false)
                  onProfile(value)
                }}
              >
                <option value="__manual__">Manual roast / Fan and heat</option>
                {profiles.map(profileOption)}
              </select>
              <small className="setup-hint">
                {manualMode
                  ? 'Adjust fan and heat yourself while the temperature curve records.'
                  : `Revision ${profile.revision} / ${profile.strategy === 'timed' ? 'timed control' : 'temperature journey'}`}
              </small>
            </label>
            {manualMode && (
              <>
                <label className="setup-field narrow">
                  <span className="form-field-label">Initial fan</span>
                  <input
                    aria-label="Initial manual fan"
                    type="number"
                    min={0.1}
                    max={10}
                    step={0.1}
                    value={manualFanRaw}
                    onInput={(event) => setManualFanRaw(event.currentTarget.value)}
                  />
                  <small className="setup-hint">0.1 - 10.0</small>
                </label>
                <label className="setup-field narrow">
                  <span className="form-field-label">Initial heat</span>
                  <input
                    aria-label="Initial manual heat"
                    type="number"
                    min={0}
                    max={10}
                    step={0.1}
                    value={manualHeatRaw}
                    onInput={(event) => setManualHeatRaw(event.currentTarget.value)}
                  />
                  <small className="setup-hint">0.0 - 10.0</small>
                </label>
              </>
            )}
            <label className="setup-field narrow">
              <span className="form-field-label">Batch weight (g)</span>
              <NumberField
                min={1}
                step={1}
                value={startMeasurements.startingMassG}
                disabled={active}
                ariaLabel="Batch weight in grams"
                onCommit={(value) => setMeasurement('startingMassG', value, true)}
              />
              <small className="setup-hint">This roast only</small>
            </label>
            <label className="setup-field narrow">
              <span className="form-field-label">Volume (ml)</span>
              <NumberField
                min={1}
                step={1}
                value={startMeasurements.startingVolumeMl}
                placeholder="Optional"
                disabled={active}
                ariaLabel="Batch volume in millilitres"
                onCommit={(value) => setMeasurement('startingVolumeMl', value, true)}
              />
              <small className="setup-hint">{bulkDensityLabel(startMeasurements)}</small>
            </label>
            <label className="setup-field">
              <span className="form-field-label">Roast name</span>
              <TextField
                value={startName}
                ariaLabel="Roast name"
                disabled={active}
                onCommit={(value) => {
                  startNameTouched.current = true
                  setStartName(value)
                }}
              />
              <small className="setup-hint">Automatic and editable</small>
            </label>
            {/*
          A checkbox, at checkbox size, saying what it actually governs. The stylesheet keeps the
          shared 42 px control height off the box and lets this note wrap instead of clipping it to
          one ellipsized line. The wording is fixed here: the roast is saved either way, and only the
          1 s temperature detail is optional; the 10 s authoritative occurrence is not.
        */}
            {executorPresent && (
              <label className="setup-record-toggle">
                <input
                  type="checkbox"
                  checked={record}
                  aria-label="Keep detailed thermal recording"
                  onInput={(event) => {
                    recordTouched.current = true
                    setRecord(event.currentTarget.checked)
                  }}
                />
                <span>Detailed 1-second curve</span>
                <small>Optional. A compact 10-second curve is always saved.</small>
              </label>
            )}
            {/*
          The spacer label is a NON-BREAKING space, not a plain one. A span holding only collapsible
          whitespace generates no line box at all, so it measured zero high and this one field's
          control started a label's height above every other control in the row - which is exactly
          the misalignment this avoids. The row's discipline is otherwise untouched: same
          three-part stack, same left edge, same 42 px control band.
        */}
            <div className="setup-field setup-start">
              <span className="form-field-label" aria-hidden="true">
                {' '}
              </span>
              <button
                type="button"
                className="primary-button"
                disabled={!canStart || roastBusy || (manualMode && manualBusy)}
                title={startMissing}
                onClick={begin}
              >
                <Play size={18} fill="currentColor" />
                {manualMode ? 'Start manual roast' : 'Start roast'}
              </button>
            </div>
          </div>
          {/*
        The real admission gate, in full rather than as a first reason. Model feasibility has its
        own warning below and never appears here; every entry in this list is something that makes
        the firmware request impossible now - apply a fit, restore probe data, or finish the active
        session that holds the roaster.

        A missing applied calibration gets the action beside it, exactly as the mismatch banner does,
        because "fit and apply a calibration first" is one request away and pointing at another
        screen for it would be the same failure the banner already avoids.
      */}
          {manualMode
            ? startMissing && (
                <div className="setup-blocked" role="status">
                  Before this roast can start: {startMissing}.
                </div>
              )
            : executorPresent
              ? preflight.blockers.length > 0 && (
                  <div className="setup-blocked" role="status">
                    <strong>Before this roast can start</strong>
                    <ul>
                      {preflight.blockers.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                    {preflight.needsCalibration && (
                      <div className="calibration-mismatch-actions">
                        {canOfferMyCalibration && (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={applyBlockedReason !== undefined || roastBusy}
                            title={applyBlockedReason}
                            onClick={() => void applyMyCalibration()}
                          >
                            {CALIBRATION_APPLY_ACTION}
                          </button>
                        )}
                        {onOpenCalibrate && (
                          <button type="button" className="link-button" onClick={onOpenCalibrate}>
                            Open Calibrate
                          </button>
                        )}
                        {canOfferMyCalibration && applyBlockedReason && <small>{applyBlockedReason}</small>}
                      </div>
                    )}
                  </div>
                )
              : startMissing && (
                  <div className="setup-blocked" role="status">
                    {startMissing}
                  </div>
                )}
          {!manualMode && executorPresent && preflight.warnings.length > 0 && (
            <div className="retention-warning model-prediction-warning" role="status">
              <TriangleAlert size={18} />
              <div>
                <strong>Prediction to review — Start remains available</strong>
                <ul>
                  {preflight.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {/*
        THE ONE DISAGREEMENT WORTH A BANNER, AND THE BUTTON THAT ENDS IT.

        It has to be clear about what is wrong and what the user needs to do. So the situation is
        the first line, the two sets are a table rather than a semicolon-separated sentence, and the
        action is a button rather than an instruction to visit another screen. Applying succeeds and the banner is gone on the next
        status - the sets now match, so `roastPreflight` stops reporting a mismatch at all.
      */}
          {!manualMode && executorPresent && preflight.calibrationMismatch && (
            <div className="calibration-mismatch" role="status">
              <TriangleAlert size={18} />
              <div>
                <strong>{preflight.calibrationMismatch.headline}</strong>
                <table className="diff-table">
                  <thead>
                    <tr>
                      <th>Coefficient</th>
                      <th>On the roaster</th>
                      <th>In this app</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preflight.calibrationMismatch.rows.map((row) => (
                      <tr key={row.field}>
                        <td>{row.label}</td>
                        <td>{row.controller}</td>
                        <td>{row.app}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <span>{preflight.calibrationMismatch.reassurance}</span>
                <div className="calibration-mismatch-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={applyBlockedReason !== undefined || roastBusy}
                    title={applyBlockedReason}
                    onClick={() => void applyMyCalibration()}
                  >
                    {CALIBRATION_APPLY_ACTION}
                  </button>
                  {onOpenCalibrate && (
                    <button type="button" className="link-button" onClick={onOpenCalibrate}>
                      Open Calibrate
                    </button>
                  )}
                  {applyBlockedReason && <small>{applyBlockedReason}</small>}
                </div>
              </div>
            </div>
          )}
          {/*
        The retention warning names each detailed recording that would go and whether a bounded
        summary curve already survives with its roast record. That is the distinction needed to
        decide whether starting now discards unique temperature detail.
      */}
          {executorPresent && retention.willPrune && (
            <div className="retention-warning" role="status">
              <TriangleAlert size={18} />
              <div>
                <strong>
                  Starting this roast will delete {retention.pruned.length} older recording
                  {retention.pruned.length === 1 ? '' : 's'}
                </strong>
                <span>
                  The roaster keeps recordings until its storage reaches its working reserve, then removes the oldest to
                  make room. This roast is expected to need about {formatBytes(retention.estimatedBytes)} and there is{' '}
                  {formatBytes(retention.headroomBytes)} left before that point.
                </span>
                <ul>
                  {retention.pruned.map((entry) => (
                    <li key={entry.id}>
                      recording #{entry.id} — {entry.startedAt ? formatLocalDateTime(entry.startedAt) : 'date unknown'}{' '}
                      —{' '}
                      {entry.imported
                        ? 'its roast record retains a summary curve; this detailed recording will be deleted'
                        : 'no roast record has preserved it; its detailed temperature curve would be lost permanently'}{' '}
                      — {formatBytes(entry.bytes)}
                    </li>
                  ))}
                </ul>
                <span>
                  {record
                    ? 'You can start anyway, switch to the compact 10-second curve, or clear older recordings in Settings first.'
                    : 'You can start anyway or clear older recordings in Settings first. Even the compact occurrence needs some archive space.'}
                </span>
              </div>
            </div>
          )}
        </section>
      )}

      {manualRunning && (
        <section className="manual-roast-cockpit" aria-label="Manual roast controls">
          <div className="manual-roast-cockpit-head">
            <div>
              <span className="eyebrow">Manual roast</span>
              <h2>Fan and heat</h2>
              <small>The roaster holds the last accepted command. Step or type new levels, then Apply.</small>
            </div>
          </div>
          {/*
        The numbers the operator steers by, pinned above the steppers exactly as Controls pins its
        own working readout: at arm's length from a hot roaster the glance -> nudge -> Apply loop
        must never require scrolling back up to the chart.
      */}
          <div
            className="manual-live-bar cockpit-live-bar"
            role="status"
            aria-label="Live readout while adjusting levels"
          >
            <span className="manual-live-elapsed">
              <small>Elapsed</small>
              <strong>
                {formatClock(Math.floor(status.roast?.active ? (status.roast.elapsedSec ?? 0) : elapsedSec))}
              </strong>
            </span>
            <span className="manual-live-temp">
              <small>Bean temp</small>
              <strong>
                {!status.connected || status.stale || !status.thermocoupleValid || status.temperatureC === undefined
                  ? '--'
                  : `${status.temperatureC.toFixed(1)} °C`}
              </strong>
            </span>
            <span className="manual-live-level">
              <small>RoR</small>
              <strong>{sample ? `${sample.rorCPerMin >= 0 ? '+' : ''}${sample.rorCPerMin.toFixed(1)}` : '--'}</strong>
            </span>
          </div>
          <FanHeatEditor
            id="manual-roast-levels"
            fanRaw={manualFanRaw}
            heatRaw={manualHeatRaw}
            onFanInput={(value) => {
              if (manualDraftSessionKey) manualDraftTouchedFor.current = manualDraftSessionKey
              setManualFanRaw(value)
            }}
            onHeatInput={(value) => {
              if (manualDraftSessionKey) manualDraftTouchedFor.current = manualDraftSessionKey
              setManualHeatRaw(value)
            }}
            appliedFan={reportedManualFan}
            appliedHeat={reportedManualHeat}
            outputFan={status.effectiveFan}
            outputHeat={status.effectiveHeat}
            outputState={manualRoastStoppable ? 'Manual roast running' : 'Waiting for roaster'}
            outputDetail={
              reportedManualFan !== undefined &&
              status.effectiveFan !== undefined &&
              Math.abs(reportedManualFan - status.effectiveFan) > 0.02
                ? `The heat-on minimum is delivering Fan ${status.effectiveFan.toFixed(3)} for the applied command.`
                : undefined
            }
            draftDiffers={manualDraftDiffers}
            onReset={resetManualDraft}
            onApply={applyManual}
            applyLabel="Apply"
            applyBlockedReason={manualApplyBlocked}
            busy={manualBusy}
            feedback={
              manualError
                ? { tone: 'error', text: manualError }
                : manualMessage
                  ? { tone: 'success', text: manualMessage }
                  : undefined
            }
            preview={
              !manualParamProblem && manualPredicted.fan !== manualLevels.fan
                ? `The heat-on minimum will raise Fan to ${manualPredicted.fan.toFixed(3)} at heat ${manualPredicted.heat.toFixed(1)}.`
                : undefined
            }
            stopAction={
              manualRoastStoppable ? (
                <button
                  type="button"
                  className={
                    manualStopConfirm.armed
                      ? 'command-button stop-command manual-roast-stop armed'
                      : 'command-button stop-command manual-roast-stop'
                  }
                  disabled={Boolean(manualStopBlocked)}
                  title={
                    manualStopBlocked ??
                    'A first tap asks for confirmation; a second tap within a few seconds stops the roast.'
                  }
                  onClick={() => {
                    if (manualStopConfirm.fire()) authoritativeManualStop?.()
                  }}
                >
                  <StopIcon size={19} />
                  {manualStopConfirm.armed ? 'Tap again to stop' : 'Stop roast'}
                </button>
              ) : undefined
            }
          />
          <section className="planned-manual-steps" aria-label="Upcoming manual roast steps">
            <div className="planned-manual-steps__head">
              <div>
                <span className="eyebrow">Optional plan</span>
                <h3>Next steps</h3>
                <p>
                  Give each row an exact roast elapsed time and watch the next countdown. A due row waits for you to
                  apply it; a sleeping browser never sends heat commands on its own.
                </p>
              </div>
            </div>
            <div className="planned-manual-table table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Fan</th>
                    <th>Heat</th>
                    <th>At elapsed</th>
                    <th>Countdown</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {plannedManualSteps.map((step, index) => {
                    const problem = manualParamError(step) ?? manualStepTimeError(step.atElapsedSec)
                    const countdown = index === 0 ? nextManualRemainingSec : undefined
                    const timer =
                      index === 0
                        ? countdown === undefined
                          ? 'Waiting for roast clock'
                          : countdown === 0
                            ? 'Due now'
                            : `Due in ${formatClock(countdown)}`
                        : `At ${formatClock(step.atElapsedSec)}`
                    const actionTitle =
                      problem ??
                      manualApplyBlocked ??
                      (index > 0
                        ? 'Apply the earlier rows first'
                        : countdown && countdown > 0
                          ? `Scheduled for ${formatClock(countdown)} from now; applying early is allowed.`
                          : undefined)
                    return (
                      <tr key={step.id} className={index === 0 && countdown === 0 ? 'is-due' : undefined}>
                        <td data-label="Step">{index + 1}</td>
                        <td data-label="Fan">
                          <input
                            aria-label={`Planned step ${index + 1} fan`}
                            type="number"
                            min="0.1"
                            max="10"
                            step="0.1"
                            value={step.fan}
                            onInput={(event) => updatePlannedManualStep(step.id, 'fan', event.currentTarget.value)}
                          />
                        </td>
                        <td data-label="Heat">
                          <input
                            aria-label={`Planned step ${index + 1} heat`}
                            type="number"
                            min="0"
                            max="10"
                            step="0.1"
                            value={step.heat}
                            onInput={(event) => updatePlannedManualStep(step.id, 'heat', event.currentTarget.value)}
                          />
                        </td>
                        <td data-label="At elapsed">
                          <input
                            aria-label={`Planned step ${index + 1} at elapsed seconds`}
                            type="number"
                            min="0"
                            max="1800"
                            step="1"
                            value={step.atElapsedSec}
                            onInput={(event) =>
                              updatePlannedManualStep(step.id, 'atElapsedSec', event.currentTarget.value)
                            }
                          />
                          <small>{formatClock(step.atElapsedSec)}</small>
                        </td>
                        <td data-label="Countdown">
                          <strong>{timer}</strong>
                        </td>
                        <td data-label="Action">
                          <button
                            type="button"
                            className="primary-button"
                            disabled={index > 0 || Boolean(problem) || Boolean(manualApplyBlocked) || !onSetManual}
                            title={actionTitle}
                            onClick={() => void applyPlannedManualStep(step)}
                          >
                            {index > 0 ? 'Queued' : countdown === 0 ? 'Apply due step' : 'Apply early'}
                          </button>
                          <button
                            type="button"
                            className="link-button"
                            disabled={manualBusy}
                            onClick={() => removePlannedManualStep(step.id)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td data-label="Step">New</td>
                    <td data-label="Fan">
                      <input
                        aria-label="New planned step fan"
                        type="number"
                        min="0.1"
                        max="10"
                        step="0.1"
                        value={manualFanRaw}
                        onInput={(event) => setManualFanRaw(event.currentTarget.value)}
                      />
                    </td>
                    <td data-label="Heat">
                      <input
                        aria-label="New planned step heat"
                        type="number"
                        min="0"
                        max="10"
                        step="0.1"
                        value={manualHeatRaw}
                        onInput={(event) => setManualHeatRaw(event.currentTarget.value)}
                      />
                    </td>
                    <td data-label="At elapsed">
                      <input
                        aria-label="New planned step at elapsed seconds"
                        type="number"
                        min="0"
                        max="1800"
                        step="1"
                        value={manualAtRaw}
                        onInput={(event) => setManualAtRaw(event.currentTarget.value)}
                      />
                      <small>{Number.isFinite(manualAtSec) ? formatClock(manualAtSec) : 'seconds'}</small>
                    </td>
                    <td data-label="Countdown">Uses roast clock</td>
                    <td data-label="Action">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={Boolean(manualParamProblem || manualAtProblem)}
                        title={manualParamProblem ?? manualAtProblem}
                        onClick={addPlannedManualStep}
                      >
                        <Plus size={17} />
                        Add row
                      </button>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {plannedManualSteps.length === 0 && (
              <p className="planned-manual-steps__empty">
                No next steps added. The new row uses the Fan and Heat draft above.
              </p>
            )}
            <p className="planned-manual-steps__note">
              The timer is a visible reminder, not an automatic controller. Apply is still an acknowledged roaster
              instruction, so a suspended or disconnected browser cannot change the roast.
            </p>
          </section>
        </section>
      )}

      {activeSession && (
        <div className={`session-panel ${activeSession.outcome}`}>
          <div className="session-title">
            <span>
              {manualFinalizing
                ? 'Finalizing manual roast recording'
                : activeSession.outcome === 'running'
                  ? `Open ${manualPresentation ? 'manual ' : ''}roast session`
                  : `Completed ${manualPresentation ? 'manual ' : ''}roast session`}
            </span>
            <strong>{activeSession.name}</strong>
            <small>{bulkDensityLabel(activeSession.measurements)}</small>
          </div>
          <div className="session-measurements">
            <NumberField
              label="Starting weight (g)"
              min={0}
              step={0.1}
              value={completedDetails.measurements.startingMassG}
              placeholder="Optional"
              onUncommittedChange={trackDetailsTyping('startingMassG')}
              onCommit={(value) => setMeasurement('startingMassG', value)}
            />
            <NumberField
              label="Starting volume (ml)"
              min={0}
              step={1}
              value={completedDetails.measurements.startingVolumeMl}
              placeholder="Optional"
              onUncommittedChange={trackDetailsTyping('startingVolumeMl')}
              onCommit={(value) => setMeasurement('startingVolumeMl', value)}
            />
            {activeSession.outcome !== 'running' && (
              <>
                <NumberField
                  label="Final weight (g)"
                  min={0}
                  step={0.1}
                  value={completedDetails.measurements.finalMassG}
                  placeholder="Optional"
                  onUncommittedChange={trackDetailsTyping('finalMassG')}
                  onCommit={(value) => setMeasurement('finalMassG', value)}
                />
                <NumberField
                  label="Final volume (ml)"
                  min={0}
                  step={1}
                  value={completedDetails.measurements.finalVolumeMl}
                  placeholder="Optional"
                  onUncommittedChange={trackDetailsTyping('finalVolumeMl')}
                  onCommit={(value) => setMeasurement('finalVolumeMl', value)}
                />
              </>
            )}
          </div>
          {/* Completed details are a browser draft until the one explicit save below receives the
          roaster's acknowledgement. Running-session metadata keeps its existing live-save path. */}
          {activeSession.outcome !== 'running' && (
            <ScorePicker value={completedDetails.score} onChange={setCompletedScore} />
          )}
          <TextArea
            className="notes-field session-notes"
            label="Roast notes"
            maxLength={4000}
            value={completedDetails.notes}
            placeholder="Observations about this run"
            onCommit={setCompletedNotes}
          />
          {activeSession.outcome !== 'running' && (
            <div className="session-save-actions">
              <button
                type="button"
                className={detailsDirty ? 'primary-button' : 'secondary-button'}
                disabled={
                  !onSaveDetails ||
                  manualFinalizing ||
                  Boolean(detailsSaveBlockedReason) ||
                  detailsSaveState === 'saving' ||
                  !detailsDirty
                }
                title={
                  manualFinalizing
                    ? 'Wait for the roaster recording to be verified before saving details.'
                    : (detailsSaveBlockedReason ??
                      (!detailsDirty
                        ? 'These roast details are already saved. Change a field or note to save an update.'
                        : undefined))
                }
                onClick={() => void saveCompletedDetails()}
              >
                <Save size={16} />
                {detailsSaveState === 'saving'
                  ? 'Saving to roaster...'
                  : manualFinalizing
                    ? 'Waiting for roast record'
                    : detailsDirty
                      ? 'Save roast details'
                      : 'Roast details saved'}
              </button>
              {detailsDirty && detailsSaveState !== 'saving' && (
                <small className="save-state unsaved">Unsaved changes</small>
              )}
              {detailsSaveState === 'saved' && !detailsDirty && (
                <span className="save-state saved" role="status">
                  <Check size={15} />
                  Saved on the roaster
                </span>
              )}
              {detailsSaveState === 'error' && (
                <small className="field-error" role="alert">
                  {detailsSaveError}
                </small>
              )}
              {manualFinalizing && <small>Details can be saved after the roaster record is verified in History.</small>}
              {!manualFinalizing && detailsSaveBlockedReason && (
                <small className="session-save-blocked" role="status">
                  {detailsSaveBlockedReason}
                </small>
              )}
            </div>
          )}
          {activeSession.outcome !== 'running'
            ? !manualFinished &&
              !manualFinalizing && (
                <button type="button" className="secondary-button" onClick={closeCompletedSession}>
                  Done
                </button>
              )
            : !active && (
                <button type="button" className="secondary-button danger-icon" onClick={onAbandonSession}>
                  Mark aborted
                </button>
              )}
        </div>
      )}

      {manualFinished && (
        <section className="manual-completion-actions" aria-label="Completed manual roast options">
          <div className="manual-profile-prompt">
            <div>
              <span className="eyebrow">Optional profile</span>
              <h2>Save these instructions for reuse</h2>
              <p>
                {activeSession?.manualRoast?.changes.length ?? 0} accepted{' '}
                {(activeSession?.manualRoast?.changes.length ?? 0) === 1 ? 'command becomes' : 'commands become'} timed
                profile steps.
              </p>
            </div>
            <label className="form-field">
              <span className="form-field-label">New profile name</span>
              <input
                aria-label="New manual roast profile name"
                value={manualProfileDraftName ?? ''}
                placeholder={`${activeSession?.name ?? 'Manual roast'} profile`}
                onInput={(event) => onManualProfileDraftName?.(event.currentTarget.value)}
              />
            </label>
            {manualProfileBlockedReason && (
              <div className="manual-roast-blocked" role="status">
                {manualProfileBlockedReason}
              </div>
            )}
            <div className="manual-profile-actions">
              <button
                type="button"
                className="primary-button"
                disabled={!manualProfileDraftName?.trim() || Boolean(manualProfileBlockedReason)}
                title={manualProfileBlockedReason}
                onClick={onSaveManualProfile}
              >
                <Save size={17} />
                Save new profile
              </button>
            </div>
          </div>
          <div className="manual-calibration-prompt">
            <div>
              <span className="eyebrow">Calibration evidence</span>
              <h2>Use this roast as measurement data</h2>
              <p>
                Add the recorded temperatures and accepted Fan and Heat changes to the calibration evidence library.
              </p>
            </div>
            {manualCalibrationBlockedReason && (
              <div className="manual-roast-blocked" role="status">
                {manualCalibrationBlockedReason}
              </div>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={Boolean(manualCalibrationBlockedReason)}
              title={manualCalibrationBlockedReason}
              onClick={onUseManualAsCalibrationEvidence}
            >
              Use as calibration evidence
            </button>
          </div>
          <div className="manual-review-done">
            <p>This roast is already saved in History. Saving a reusable profile is optional.</p>
            <button type="button" className="secondary-button" onClick={closeManualReview}>
              Done reviewing
            </button>
          </div>
        </section>
      )}

      {!manualPresentation &&
        !deviceActive &&
        !activePlanRevisionHandled &&
        activePlan &&
        (activePlan.planRev ?? 0) > 1 && (
          <section className="active-plan-review" aria-label="Review journey changes">
            <div className="active-plan-review-head">
              <div>
                <span className="eyebrow">Edited journey / revision {activePlan.planRev ?? '--'}</span>
                <h2>
                  {deviceRoast?.endReason === 'completed' ? 'Save the journey changes?' : 'Review the journey changes'}
                </h2>
                <p>
                  {deviceRoast?.endReason === 'completed'
                    ? 'Changed fields are highlighted against the instructions the roaster accepted at Start.'
                    : 'This roast ended early, so these incomplete instructions cannot be saved as a reusable profile. The roast record and its edit history remain in History.'}
                </p>
              </div>
            </div>
            {activePlan.initialZones ? (
              <div className="active-plan-zone-list review-only">
                {activePlan.zones.map((zone, index) => {
                  const changes = activeJourneyZoneChanges(activePlan).filter((change) => change.zoneIndex === index)
                  return (
                    <fieldset className={changes.length > 0 ? 'changed' : ''} key={zone.id}>
                      <legend>
                        Zone {index + 1}
                        {changes.length > 0
                          ? ` / ${changes.length} changed ${changes.length === 1 ? 'field' : 'fields'}`
                          : ' / unchanged'}
                      </legend>
                      {REVIEW_ZONE_FIELDS.map(([field, label]) => {
                        const change = changes.find((candidate) => candidate.field === field)
                        return (
                          <label className={change ? 'changed-field' : ''} key={field}>
                            <span>{label}</span>
                            <output>{zone[field]}</output>
                            {change && <small>was {change.before}</small>}
                          </label>
                        )
                      })}
                    </fieldset>
                  )
                })}
              </div>
            ) : (
              <div className="active-plan-feedback error" role="alert">
                The roaster has not supplied the immutable starting plan yet. Retry before resolving these changes.
              </div>
            )}
            <div className="active-plan-actions">
              {deviceRoast?.endReason === 'completed' && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={activePlanRevisionSaving || !activePlan.initialZones}
                  onClick={onSaveActivePlanRevision}
                >
                  <Save size={17} />
                  {activePlanRevisionSaving ? 'Saving revision...' : 'Save as new profile revision'}
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={activePlanRevisionSaving || !activePlan.initialZones}
                onClick={onDiscardActivePlanRevision}
              >
                {deviceRoast?.endReason === 'completed' ? 'Keep only in roast record' : 'Reviewed'}
              </button>
            </div>
          </section>
        )}

      {!manualPresentation && revisionAvailable && (
        <div className="revision-prompt">
          <div>
            <strong>Overrides recorded</strong>
            <span>Turn this roast's requested Fan and Heat path into the next profile revision.</span>
          </div>
          <button type="button" className="secondary-button" onClick={onSaveRevision}>
            <Save size={17} />
            Save revision
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss revision prompt"
            onClick={onDismissRevision}
          >
            <X size={18} />
          </button>
        </div>
      )}

      {/*
      The executability warning lives HERE, not in the profile editor. Authoring a journey needs no
      hardware; roasting one is steered entirely by the probe, so this is the only screen where a
      dead thermocouple is a fact about what is about to happen. It appears only for a temperature
      journey, and only when the reading is actually unusable.
    */}
      {journey && probeReason && (
        <div className="probe-warning" role="status">
          <TriangleAlert size={18} />
          <div>
            <strong>No bean temperature, so this journey cannot steer</strong>
            <span>
              {probeReason} A temperature journey holds its plan by measuring the beans, so the roaster refuses to start
              one until a reading is back.
            </span>
          </div>
        </div>
      )}

      {/* Elapsed, Fan and Heat appear here and in the header strip; the roast panel above carries
        only what these tiles do not, and its detail rides on them: the roaster's start time, and
        what the control law solved before the levels were quantized. */}
      <LiveReadouts
        sample={sample}
        elapsedSec={
          executorPresent && deviceActive && deviceRoast?.elapsedSec !== undefined ? deviceRoast.elapsedSec : elapsedSec
        }
        lifecycle={lifecycle}
        requestedDiffers={requestedDiffers}
        targetTemperatureC={targetTemperatureC}
        mode={manualChartPresentation ? 'manual' : profile.strategy === 'thermal-intent' ? 'journey' : 'timed'}
        elapsedNote={
          executorPresent && deviceActive && deviceRoast?.startedEpoch
            ? `started ${new Date(deviceRoast.startedEpoch * 1000).toLocaleTimeString()}`
            : undefined
        }
        fanNote={
          executorPresent && deviceActive && deviceRoast?.solvedFan !== undefined
            ? `solved ${deviceRoast.solvedFan.toFixed(2)}`
            : undefined
        }
        heatNote={
          executorPresent && deviceActive && deviceRoast?.solvedHeat !== undefined
            ? `solved ${deviceRoast.solvedHeat.toFixed(2)}`
            : undefined
        }
      />
      <div className="roast-main">
        <div className="graph-column">
          <LiveChart
            samples={samples}
            profile={!manualChartPresentation && profile.strategy === 'timed' ? (profile as TimedProfile) : undefined}
            targetIntent={manualChartPresentation ? undefined : journey}
            overlay={overlay}
            events={events}
            elapsedSec={elapsedSec}
            toolbar={chartToolbar}
            journeyZones={deviceJourneyChart?.zones ?? reading?.zones}
            zoneTargetSegment={
              deviceJourneyChart?.targetPath ??
              (reading ? adjustedJourneyTargetPath(reading.zones, elapsedSec) : undefined)
            }
            active={deviceActive || activeSession?.outcome === 'running'}
          />
          {!manualChartPresentation && (
            <div className="phase-strip">
              <div>
                <span>Zones complete</span>
                <strong>
                  {deviceActive && deviceRoast?.mode === 'journey'
                    ? `${deviceZonesComplete ?? 0} / ${deviceRoast.zoneCount ?? activePlan?.zones.length ?? '--'}`
                    : reading
                      ? `${reading.zonesAttained} / ${reading.zones.length}`
                      : '--'}
                </strong>
              </div>
              <div>
                <span>Current zone target</span>
                <strong>
                  {deviceActive && deviceRoast?.mode === 'journey'
                    ? deviceRoast.targetC === undefined
                      ? '--'
                      : `${deviceRoast.targetC.toFixed(1)} °C`
                    : reading
                      ? `${reading.targetC.toFixed(1)} °C`
                      : '--'}
                </strong>
              </div>
              <div>
                <span>Curve error</span>
                <strong>
                  {targetError == null ? '--' : `${targetError >= 0 ? '+' : ''}${targetError.toFixed(1)} °C`}
                </strong>
              </div>
              {/* A journey's zones end on reached temperature, so its finish is the original plan's, not a forecast. */}
              <div>
                <span>{profile.strategy === 'timed' ? 'Planned finish' : 'Original plan ends'}</span>
                <strong>{formatClock(finishSec)}</strong>
              </div>
            </div>
          )}
          {manualPresentation && activeSession?.manualRoast && (
            <section className="live-instruction-table" aria-label="Accepted manual roast instructions">
              <div className="active-plan-editor-head">
                <div>
                  <span className="eyebrow">Instructions on the roaster</span>
                  <h2>Manual roast steps</h2>
                  <p>
                    Each Apply above commits the next instruction here. This accepted timeline is what can be saved as a
                    timed profile.
                  </p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Applied at</th>
                      <th>Fan requested</th>
                      <th>Heat requested</th>
                      <th>Fan delivered</th>
                      <th>Heat delivered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSession.manualRoast.changes.map((change, index) => (
                      <tr key={change.id}>
                        <td data-label="Step">{index + 1}</td>
                        <td data-label="Applied at">{formatClock(change.elapsedSec)}</td>
                        <td data-label="Fan requested">{change.requestedFan.toFixed(1)}</td>
                        <td data-label="Heat requested">{change.requestedHeat.toFixed(1)}</td>
                        <td data-label="Fan delivered">{change.effectiveFan.toFixed(1)}</td>
                        <td data-label="Heat delivered">{change.effectiveHeat.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {journeyScore.length > 0 && (
            <section className="journey-scorecard" aria-label="Journey automation scorecard">
              <div className="active-plan-editor-head">
                <div>
                  <span className="eyebrow">Post-roast analysis</span>
                  <h2>Automation scorecard</h2>
                  <p>
                    Timing is calculated from the zone boundaries recorded by the roaster. Positive drift means a zone
                    finished late; negative drift means it finished early.
                  </p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Zone</th>
                      <th>Planned</th>
                      <th>Actual</th>
                      <th>Drift</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {journeyScore.map((zone) => (
                      <tr key={zone.zoneId}>
                        <td data-label="Zone">{zone.index + 1}</td>
                        <td data-label="Planned">{formatClock(zone.nominalDurationSec)}</td>
                        <td data-label="Actual">
                          {zone.actualDurationSec === undefined ? '—' : formatClock(zone.actualDurationSec)}
                        </td>
                        <td
                          data-label="Drift"
                          className={zone.driftSec !== undefined && Math.abs(zone.driftSec) >= 15 ? 'score-drift' : ''}
                        >
                          {zone.driftSec === undefined
                            ? '—'
                            : `${zone.driftSec >= 0 ? '+' : '-'}${formatClock(Math.abs(zone.driftSec))}`}
                        </td>
                        <td data-label="Result">
                          {zone.attained
                            ? Math.abs(zone.driftSec ?? 0) < 15
                              ? 'On time'
                              : (zone.driftSec ?? 0) > 0
                                ? 'Reached late'
                                : 'Reached early'
                            : 'Not reached'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {executorPresent && deviceRoast?.active === true && !manualPresentation && activePlan?.mode === 'journey' && (
            <section className="active-plan-editor" aria-label="Edit active journey plan">
              <div className="active-plan-editor-head">
                <div>
                  <span className="eyebrow">Live journey plan / revision {activePlan.planRev ?? '--'}</span>
                  <h2>Adjust current and upcoming zones</h2>
                  <p>Completed zones are locked. Changes remain drafts until the roaster accepts them.</p>
                </div>
              </div>
              <div className="active-plan-zone-list">
                {activePlanDraft.map((zone, index) => {
                  const completed = index < currentPlanZone
                  const current = index === currentPlanZone
                  return (
                    <fieldset
                      className={completed ? 'completed' : current ? 'current' : 'future'}
                      disabled={completed || activePlanBusy || activePlanReconciling}
                      key={zone.id}
                    >
                      <legend>
                        Zone {index + 1} / {completed ? 'completed' : current ? 'current' : 'upcoming'}
                      </legend>
                      <label>
                        <span>Start °C</span>
                        <input aria-label={`Zone ${index + 1} start C`} value={zone.startC} readOnly />
                      </label>
                      <label>
                        <span>End °C</span>
                        <input
                          aria-label={`Zone ${index + 1} end C`}
                          type="number"
                          step="0.1"
                          value={zone.endC}
                          onInput={(event) => updateActiveZone(index, 'endC', event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        <span>Seconds</span>
                        <input
                          aria-label={`Zone ${index + 1} seconds`}
                          type="number"
                          min={current ? Math.ceil((deviceRoast?.zoneElapsedSec ?? 0) + 5) : 5}
                          step="1"
                          value={zone.durationSec}
                          onInput={(event) => updateActiveZone(index, 'durationSec', event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        <span>Fan min</span>
                        <input
                          aria-label={`Zone ${index + 1} fan minimum`}
                          type="number"
                          min="0.1"
                          max="10"
                          step="0.1"
                          value={zone.fanMin}
                          onInput={(event) => updateActiveZone(index, 'fanMin', event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        <span>Fan max</span>
                        <input
                          aria-label={`Zone ${index + 1} fan maximum`}
                          type="number"
                          min="0.1"
                          max="10"
                          step="0.1"
                          value={zone.fanMax}
                          onInput={(event) => updateActiveZone(index, 'fanMax', event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        <span>Heat min</span>
                        <input
                          aria-label={`Zone ${index + 1} heat minimum`}
                          type="number"
                          min="0"
                          max="10"
                          step="0.1"
                          value={zone.heatMin}
                          onInput={(event) => updateActiveZone(index, 'heatMin', event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        <span>Heat max</span>
                        <input
                          aria-label={`Zone ${index + 1} heat maximum`}
                          type="number"
                          min="0"
                          max="10"
                          step="0.1"
                          value={zone.heatMax}
                          onInput={(event) => updateActiveZone(index, 'heatMax', event.currentTarget.value)}
                        />
                      </label>
                    </fieldset>
                  )
                })}
              </div>
              {(activePlanProblem || activePlanEditError || activePlanMessage) && (
                <div
                  className={
                    activePlanProblem || activePlanEditError ? 'active-plan-feedback error' : 'active-plan-feedback'
                  }
                  role={activePlanProblem || activePlanEditError ? 'alert' : 'status'}
                >
                  {activePlanProblem || activePlanEditError || activePlanMessage}
                </div>
              )}
              <div className="active-plan-actions">
                {confirmImmediateTransition ? (
                  <>
                    <button
                      type="button"
                      className="command-button stop-command"
                      disabled={activePlanBusy}
                      onClick={() => void patchActivePlan(true)}
                    >
                      Confirm apply and advance now
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={activePlanBusy}
                      onClick={() => {
                        setConfirmImmediateTransition(false)
                        setActivePlanEditError('')
                      }}
                    >
                      Keep current plan
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={
                      activePlanBusy ||
                      activePlanReconciling ||
                      Boolean(activePlanProblem) ||
                      JSON.stringify(activePlanDraft) === JSON.stringify(activePlan.zones)
                    }
                    onClick={() => void patchActivePlan(false)}
                  >
                    {activePlanReconciling ? 'Confirming with roaster...' : 'Apply journey changes'}
                  </button>
                )}
              </div>
            </section>
          )}
          {executorPresent && deviceRoast?.active === true && !manualPresentation && activePlan?.mode === 'timed' && (
            <section className="active-plan-editor timed-plan-editor" aria-label="Edit active timed plan">
              <div className="active-plan-editor-head">
                <div>
                  <span className="eyebrow">Live timed plan / revision {activePlan.planRev ?? '--'}</span>
                  <h2>Adjust current and upcoming steps</h2>
                  <p>
                    Completed steps are locked. Each row is committed separately and becomes part of the roaster
                    recording.
                  </p>
                </div>
              </div>
              <div className="timed-step-table table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Fan</th>
                      <th>Heat</th>
                      <th>Seconds</th>
                      <th>Status</th>
                      <th>
                        <span className="sr-only">Action</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeTimedDraft.map((step, index) => {
                      const completed = index < (deviceRoast.stepIndex ?? 0)
                      const current = index === (deviceRoast.stepIndex ?? 0)
                      const accepted = activePlan.steps[index]
                      const unchanged =
                        accepted !== undefined &&
                        accepted.fan === step.fan &&
                        accepted.heat === step.heat &&
                        accepted.durationSec === step.durationSec
                      const problem = activeTimedStepProblem(
                        step,
                        index,
                        deviceRoast?.stepIndex ?? 0,
                        deviceRoast?.stepElapsedSec ?? 0,
                      )
                      return (
                        <tr className={completed ? 'completed' : current ? 'current' : 'future'} key={index}>
                          <td data-label="Step">{index + 1}</td>
                          <td data-label="Fan">
                            <input
                              aria-label={`Step ${index + 1} fan`}
                              type="number"
                              min="0"
                              max="10"
                              step="0.1"
                              disabled={completed || activePlanBusy}
                              value={step.fan}
                              onInput={(event) => updateTimedStep(index, 'fan', event.currentTarget.value)}
                            />
                          </td>
                          <td data-label="Heat">
                            <input
                              aria-label={`Step ${index + 1} heat`}
                              type="number"
                              min="0"
                              max="10"
                              step="0.1"
                              disabled={completed || activePlanBusy}
                              value={step.heat}
                              onInput={(event) => updateTimedStep(index, 'heat', event.currentTarget.value)}
                            />
                          </td>
                          <td data-label="Seconds">
                            <input
                              aria-label={`Step ${index + 1} seconds`}
                              type="number"
                              min={
                                current
                                  ? Math.ceil((deviceRoast.stepElapsedSec ?? 0) + 5)
                                  : ROAST_LIMITS.stepSeconds.min
                              }
                              max={ROAST_LIMITS.stepSeconds.max}
                              step="1"
                              disabled={completed || activePlanBusy}
                              value={step.durationSec}
                              onInput={(event) => updateTimedStep(index, 'durationSec', event.currentTarget.value)}
                            />
                          </td>
                          <td data-label="Status">
                            {completed ? 'Completed' : current ? 'Current' : accepted ? 'Upcoming' : 'New draft'}
                          </td>
                          <td data-label="Action">
                            {!completed && (
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={activePlanBusy || unchanged || Boolean(problem)}
                                title={problem}
                                onClick={() => void patchTimedStep(index)}
                              >
                                {accepted ? 'Apply step' : 'Add step'}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="active-plan-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    activePlanBusy || activeTimedDraft.length >= 24 || activeTimedDraft.length > activePlan.steps.length
                  }
                  onClick={() => {
                    const previous = activeTimedDraft.at(-1)
                    setActiveTimedDraft((current) => [
                      ...current,
                      { fan: previous?.fan ?? 4, heat: previous?.heat ?? 0, durationSec: 60 },
                    ])
                  }}
                >
                  Add upcoming step
                </button>
              </div>
              {(activePlanEditError || activePlanMessage) && (
                <div
                  className={activePlanEditError ? 'active-plan-feedback error' : 'active-plan-feedback'}
                  role={activePlanEditError ? 'alert' : 'status'}
                >
                  {activePlanEditError || activePlanMessage}
                </div>
              )}
            </section>
          )}

          {/*
          There is no browser-computed control panel here, on purpose.

          Rendering one whenever the device is not executing would also render it on an idle page
          with no roast at all: the control law folded over idle telemetry, reporting a zone, a
          target and recommended levels for a roast that has not started, all of it drifting with
          the room temperature. Controller execution numbers come from `status.roast`, above;
          the live plan editor is a separate, explicit revision-checked action.
        */}
        </div>
        <aside className="roast-side">
          <div className="event-log">
            <h2>Roast events</h2>
            {recentEvents.length === 0 ? (
              <div className="empty-state">Safety and program events land here as the roast runs.</div>
            ) : (
              recentEvents.map((event) => (
                <div className="event-row" key={event.id}>
                  <span>{formatClock(event.elapsedSec)}</span>
                  <strong>{event.label}</strong>
                </div>
              ))
            )}
          </div>
          {/* The comparison overlay is a charting option and lives on the chart, not in this column. */}
          <div className="run-summary">
            <span>Profile</span>
            <strong>{manualPresentation ? 'Manual / unsaved instructions' : profile.name}</strong>
            <span>Strategy</span>
            <strong>
              {manualPresentation
                ? 'Manual roast'
                : profile.strategy === 'timed'
                  ? 'Timed control'
                  : 'Temperature journey'}
            </strong>
            {!manualPresentation && (
              <>
                <span>Profile revision</span>
                <strong>{profile.revision}</strong>
                <span>Program duration</span>
                <strong>{formatClock(finishSec)}</strong>
              </>
            )}
          </div>
        </aside>
      </div>
    </section>
  )
}
