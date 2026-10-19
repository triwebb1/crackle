import type {
  DeviceStoreClient,
  DocumentRead,
  DocumentWrite,
  ManifestRead,
  RestoreMaintenanceResult,
  RunIndexRead,
} from '../data/deviceStore'
import { COLLECTIONS, type CollectionName, type DocumentTarget } from '../data/documentSerializer'
import { CALIBRATION_LIMITS, expandBaselineGrid } from '../domain/calibrationProgram'
import {
  archiveStateFromStatus,
  type DeviceArchive,
  deviceArchive,
  parseArchiveStorage,
  parseDeviceCoefficients,
  parseDeviceCurrentLog,
  parseDeviceLogList,
  sanitizeFitId,
} from '../domain/deviceLogs'
import { manualParamError } from '../domain/manualControl'
import { requireRecordingOrigin, requireStorageAddress } from '../domain/provenance'
import {
  type ConfiguredRoasterTarget,
  type ModelSpecificOperation,
  normalizeTargetBaseUrl,
  normalizeTargetPathPrefix,
} from '../domain/roasterModel'
import {
  type RoastStartArgs,
  roastStartFailure,
  sanitizeRoastName,
  serializeJourneyZones,
} from '../domain/roastProgram'
import type {
  CalibrationEndReason,
  CalibrationProgramStatus,
  CalibrationStep,
  ControllerCapabilities,
  ControllerLifecycle,
  ControllerStatus,
  ManualEndReason,
  ManualStatus,
  RecordingOrigin,
  RecordingStorageAddress,
  RoastEndReason,
  RoasterIdentity,
  RoastProgramMode,
  RoastProgramStatus,
  StepAdvance,
  ThermalLogStatus,
  ThermalSegment,
} from '../domain/types'

export type CalibrationProgramSpec =
  | { steps: CalibrationStep[]; fans?: undefined; heats?: undefined }
  | { fans: number[]; heats: number[]; steps?: undefined }

export type CalibrationStartParams = CalibrationProgramSpec & {
  maxStepSeconds: number
  minStepSeconds: number
  settleSeconds: number
  settleBandC: number
}

export const isGridProgram = (
  params: CalibrationProgramSpec,
): params is { fans: number[]; heats: number[]; steps?: undefined } =>
  Array.isArray(params.fans) && Array.isArray(params.heats)

export const programSteps = (params: CalibrationProgramSpec): CalibrationStep[] =>
  isGridProgram(params) ? expandBaselineGrid(params.fans, params.heats) : (params.steps ?? [])

export interface CommandResult {
  ok: boolean
  message?: string
  /**
   * The request may have reached the roaster but its acknowledgement was lost (timeout, dropped
   * response, gateway 504) and status could not settle whether it committed. `ok` is false, but
   * this is NOT a refusal: callers must not undo anything that assumes the command never ran.
   */
  outcomeUnknown?: boolean
  /** Persistent device state after a successful mutating command. Decimal uint64 on the wire. */
  stateRev?: string
  thermocoupleOffsetC?: number
  planRev?: number
  /** Device-authoritative transition metadata, present on first-class manual roast commands. */
  elapsedSec?: number
  requestedFan?: number
  requestedHeat?: number
  effectiveFan?: number
  effectiveHeat?: number
  startedEpoch?: number
  bootId?: string
  name?: string
  sessionId?: string
  /** Reserved thermal recording id returned when a recorded roast is accepted. */
  logId?: string
  wasActive?: boolean
  endReason?: RoastEndReason
  recordingOrigin?: RecordingOrigin
  storageAddress?: RecordingStorageAddress
}

export interface ManualLevels {
  fan: number
  heat: number
}

export interface ActiveRoastStep {
  fan: number
  heat: number
  durationSec: number
}

export interface ActiveRoastPlan {
  active: boolean
  bootId?: string
  sessionId?: string
  planRev?: number
  mode: RoastProgramMode
  profileId?: string
  profileRevision?: number
  name?: string
  batchMassG?: number
  steps: ActiveRoastStep[]
  zones: ThermalSegment[]
  /** Immutable zone instructions accepted when this roast started. */
  initialZones?: ThermalSegment[]
  journal?: unknown[]
}

export type ActivePlanPatchResult =
  | { ok: true; plan: ActiveRoastPlan; immediateTransition?: boolean }
  | { ok: false; message: string; sessionId?: string; planRev?: number; requiresImmediateTransition?: boolean }

/** The compact payload shared by the WebSocket stream and `/api/live` fallback. */
export interface LiveSnapshot {
  receivedAtMs: number
  connected: boolean
  firmwareVersion?: string
  roaster?: RoasterIdentity
  capabilities?: ControllerCapabilities
  manualLockout?: boolean
  temperatureC?: number
  ambientC?: number
  effectiveFan?: number
  effectiveHeat?: number
  requestedFan?: number
  requestedHeat?: number
  actuatorMode?: string
  fault?: string
  calibrationActive: boolean
  calibrationStep?: number
  calibrationCount?: number
  /** Current calibration program state, carried compactly while full status is deferred. */
  calibrationId?: string
  calibrationFan?: number
  calibrationHeat?: number
  calibrationElapsedSec?: number
  calibrationSettleState?: CalibrationSettleState
  /** Terminal calibration result; `none` is parsed away while the pass is still running. */
  calibrationEndReason?: CalibrationEndReason
  /** Controller-owned completed-step journal, retaining only its latest bounded window. */
  calibrationCompletedSteps?: CalibrationCompletedStepStatus[]
  /** True while the device is capturing a recording, including its passive fan-off tail. */
  thermalLogActive?: boolean
  thermalLogId?: string
  thermalLogSource?: ThermalLogStatus['source']
  manualActive: boolean
  manualSinceMs?: number
  logSamples?: number
  /**
   * The roast executor's own fields are included in the compact live snapshot. They make the
   * "Running on the controller" panel move at stream cadence instead of waiting for an explicit
   * full-status reconciliation; everything else about the roast stays status-owned.
   */
  roastActive?: boolean
  roastJourney?: boolean
  roastMode?: RoastProgramMode
  roastSessionId?: string
  roastName?: string
  roastStartedEpoch?: number
  roastBatchMassG?: number
  roastAmbientC?: number
  roastSaturated?: boolean
  roastHoldover?: boolean
  /** Legacy journey discriminator retained for older firmware. */
  roastElapsedSec?: number
  roastZone?: number
  roastZones?: number
  roastTargetC?: number
  /**
   * The rest of the Journey executor's per-tick progress tuple (firmware 2026-07-26.107 and later).
   * Full status is deferred for as long as anything actuates, so during a roast this stream is the
   * ONLY transport for everything the cockpit renders per tick. The firmware publishes the whole
   * tuple atomically with `roastZone`, which is what makes it safe to merge without a confirming
   * status poll.
   */
  roastZoneEntrySec?: number
  roastZoneNominalSec?: number
  roastZoneEndC?: number
  roastCorrectionTotal?: number
  roastIntegral?: number
  roastSolvedFan?: number
  roastSolvedHeat?: number
  roastHoldoverMs?: number
  /** Per-zone attainment offsets; null is "this endpoint was never reached". */
  roastZonesAttained?: Array<number | null>
  roastEndReason?: RoastEndReason
  /** Device boot/session identity; unlike stateRev this changes on every reboot. */
  bootId?: string
  /** Per-boot live-frame sequence. A gap affects telemetry health, not catalog currency. */
  streamSeq?: number
  /** Persistent controller state revision, kept as text to preserve all uint64 values. */
  stateRev?: string
  /** Revision of the active in-memory roast plan. */
  planRev?: number
}

export interface ControllerClient {
  status(): Promise<ControllerStatus>
  live(): Promise<LiveSnapshot>
  subscribeLive(
    onSnapshot: (snapshot: LiveSnapshot) => void,
    onConnection?: (connected: boolean) => void,
  ): LiveSubscription
  /** Workflow-agnostic safe stop; never preflighted or withheld by stale/fault state. */
  stopAll(): Promise<CommandResult>
  startCalibration(params: CalibrationStartParams): Promise<CommandResult>
  stopCalibration(): Promise<CommandResult>
  setManual(levels: ManualLevels): Promise<CommandResult>
  stopManual(): Promise<CommandResult>
  startRoast(args: RoastStartArgs): Promise<CommandResult>
  setRoast(levels: ManualLevels, expectedSessionId: string): Promise<CommandResult>
  stopRoast(expectedSessionId?: string): Promise<CommandResult>
  fetchActiveRoastPlan(): Promise<ActiveRoastPlan>
  patchActiveRoastPlan(
    zones: ThermalSegment[],
    expectedSessionId: string,
    expectedPlanRev: number,
    allowImmediateTransition?: boolean,
  ): Promise<ActivePlanPatchResult>
  patchActiveTimedRoastStep(
    stepIndex: number,
    step: ActiveRoastStep,
    expectedSessionId: string,
    expectedPlanRev: number,
  ): Promise<ActivePlanPatchResult>
  setThermocoupleOffset(offsetC: number): Promise<CommandResult>
  fetchThermalCsv(): Promise<string>
}

export const STATUS_URL = '/api/status'
export const DEV_POWER_CYCLE_URL = '/api/dev/power-cycle'
export const DEV_PROBE_URL = '/api/dev/probe'
export const DEV_LIVE_DROP_URL = '/api/dev/live-drop'
export const LIVE_URL = '/api/live'
export const LIVE_WS_PATH = '/ws/live'
const STATUS_TIMEOUT_MS = 12000
export const STOP_ALL_URL = '/api/stop'
export const CALIBRATION_START_URL = '/api/calibration/start'
export const CALIBRATION_STOP_URL = '/api/calibration/stop'
export const MANUAL_SET_URL = '/api/manual/set'
export const MANUAL_STOP_URL = '/api/manual/stop'
export const ROAST_SET_URL = '/api/roast/set'
export const ROAST_ACTIVE_PLAN_URL = '/api/roast/active-plan'
export const THERMOCOUPLE_OFFSET_URL = '/api/settings/thermocouple-offset'
export const THERMAL_CSV_URL = '/thermal.csv'
export const DEVICE_MANIFEST_URL = '/api/data/manifest'
export const RESTORE_MAINTENANCE_BEGIN_URL = '/api/restore/begin'
export const RESTORE_MAINTENANCE_COMMIT_URL = '/api/restore/commit'
export const RESTORE_MAINTENANCE_ABORT_URL = '/api/restore/abort'
/**
 * The device log archive, added to the allow-list in 0.7.0 and feature-detected at every call.
 *
 * `DEVICE_LOGS_URL` lists (GET), `DEVICE_LOG_DELETE_URL` deletes (POST with `id` and confirm
 * token as query args), and `DEVICE_LOG_PREFIX` is the parent of the per-log fetch. Keeping the ids
 * out of the literals is what lets the fetch-surface test keep policing an exact list of paths while
 * the routes stay parameterised.
 *
 * **The prefix is one path and it now serves two representations.** `GET /logs/<id>.csv` decodes the
 * recording into rows; `GET /logs/<id>.crk` hands back the stored file byte for byte and interprets
 * nothing - not the header, not the version, and not the checksum the CSV route refuses to serve
 * without. The SUFFIX picks the representation, so backup cost the allow-list nothing here: it was
 * named `DEVICE_LOG_CSV_PREFIX` when `.csv` was the only suffix, and the rename is the whole change.
 */
export const DEVICE_LOGS_URL = '/api/logs'
export const DEVICE_LOG_DELETE_URL = '/api/logs/delete'
export const DEVICE_LOG_PREFIX = '/logs/'
/**
 * Backup and restore, and they are two paths rather than one because they are two different acts.
 *
 * `DEVICE_LOG_FORMAT_URL` erases the whole volume - recordings AND `/data`, since they share it -
 * and is the firmware's single user-confirmed way to do that. `DEVICE_LOG_RESTORE_URL` puts ONE
 * recording back; there is no batch form and there must not be one, because the firmware holds no
 * restore session and cannot be left half-way through one. A restore is N independent, individually
 * confirmed writes, and the browser assembling them is what makes a failure at N-1 leave the N-2
 * that succeeded exactly as they landed.
 */
export const DEVICE_LOG_FORMAT_URL = '/api/logs/format'
export const DEVICE_LOG_RESTORE_URL = '/api/logs/restore'
export const CALIBRATION_APPLY_URL = '/api/calibration/apply'
/**
 * Device-owned roast execution uses explicit commands, never a per-tick browser scheduler.
 * Start hands over a complete plan; Stop requests a safe end; Set records operator changes during
 * manual roasting; active-plan GET/PATCH reconstructs or deliberately edits a journey using exact
 * session and plan revisions. Firmware validates and owns every accepted result.
 */
export const ROAST_START_URL = '/api/roast/start'
export const ROAST_STOP_URL = '/api/roast/stop'
/**
 * The document store: one prefix and one delete, and that is the whole data layer.
 *
 * `DEVICE_DATA_PREFIX` is the parent of every document address - `profiles`, `beans`,
 * `calibrations`, `meta`, the run index at `runs`, and one run at `runs/<id>`. Keeping the address
 * out of the literal is the same discipline `/logs/` already uses: the allow-list test can police an
 * exact set of paths while the routes stay parameterised over ids the firmware validates.
 *
 * The store is READ with a GET whose body is the payload itself and whose `X-Doc-Version` header is
 * the concurrency counter, and WRITTEN with a POST carrying `?base=<version>`. There is no third
 * path, no batch endpoint, and no "sync" verb: reconciliation is the client's job, and a device that
 * had opinions about it would need a firmware release every time the schema moved.
 */
export const DEVICE_DATA_PREFIX = '/api/data/'
export const DEVICE_DATA_DELETE_URL = '/api/data/delete'

/** The firmware's own confirmation tokens, mirrored so a stray request cannot satisfy them. */
export const DELETE_LOG_CONFIRM = 'DELETE_LOG'
export const APPLY_CALIBRATION_CONFIRM = 'APPLY_CALIBRATION'
export const DELETE_DATA_CONFIRM = 'DELETE_DATA'
export const FORMAT_LOGS_CONFIRM = 'FORMAT_LOGS'
export const RESTORE_LOG_CONFIRM = 'RESTORE_LOG'
/**
 * The binary file cap on one restored recording - `kMaxIncomingLogBytes`, `104 + 4800 x 25`.
 *
 * Mirrored so an over-cap file is refused before a raw upload is put on the wire.
 * The DEVICE's own `log_archive.restore_max_bytes` is the authority and is preferred whenever status
 * carries it; this is the fallback, not a second opinion.
 */
export const RESTORE_MAX_BYTES = 121_244
/** A recording upload is a streamed flash write and gets longer than a document. */
const RESTORE_TIMEOUT_MS = 20000
/** How long a document request may take. Writes are flash writes; reads come out of a cache. */
const DOCUMENT_TIMEOUT_MS = 10000
/** Every applied coefficient must be finite and inside this range before anything is sent. */
export const APPLY_COEFFICIENT_RANGE = { min: 0, max: 1000 } as const
/**
 * The firmware's physical-plausibility gate, mirrored exactly. "Present" is not enough: a journey
 * inverting a model with zero heater authority saturates heat at the zone maximum, so the firmware
 * rejects implausible coefficients at apply, at NVS load, and at journey start — and this client
 * rejects them before they are ever sent, naming the field instead of echoing a 400.
 */
export const PLAUSIBLE_COEFFICIENTS = {
  // This is a positive rate, not a standalone measure of heater strength. The
  // model's equilibrium authority is gain / thermal loss, so a measured gain
  // below 5 can be perfectly credible when loss is correspondingly small.
  // Align the floor with the journey solver's 0.1 authority clamp: it rejects
  // zero and sign errors without inventing a larger independent physical limit.
  heaterGainCPerMinAt10: { min: 0.1, max: 500 },
  fanCoolingCPerMinAt10: { min: 0.5, max: 200 },
  coolingFanCPerMinAt10: { min: 1, max: 300 },
  thermalLossPerMinPerC: { min: 0.005, max: 2 },
} as const

export type AppliedCoefficientSet = Record<keyof typeof PLAUSIBLE_COEFFICIENTS, number>

/**
 * The first coefficient the firmware would refuse, or nothing when the whole set is sendable.
 *
 * Separated from the request so a screen can ask the question BEFORE it offers the button: a page
 * that puts "apply my calibration" in front of a user whose fit could never be accepted has
 * offered a dead end, and the only honest thing left to offer them is Calibrate.
 */
export const implausibleCoefficient = (coefficients: AppliedCoefficientSet): string | undefined => {
  for (const [key, range] of Object.entries(PLAUSIBLE_COEFFICIENTS)) {
    const value = coefficients[key as keyof AppliedCoefficientSet]
    if (!Number.isFinite(value) || value < range.min || value > range.max) {
      return `${key} is ${value} but must be between ${range.min} and ${range.max} — this fit is not physically plausible, so it was not sent to the roaster`
    }
  }
  return undefined
}

const CALIBRATION_CONFIRM = 'FOUR_DASHES_CALIBRATION'
const MANUAL_CONFIRM = 'MANUAL_CONTROL'
export const THERMAL_CSV_BUSY = 'Thermal CSV is available after the active recording completes'
// Telemetry is intentionally a low-rate state feed, not a heartbeat that must arrive every
// quarter-second. Browser scheduling, Wi-Fi retries, and a brief firmware loop stall must not turn
// one missed frame into a disconnect/reconnect storm. `/api/live` fallback still establishes
// freshness independently once this genuinely quiet socket is retired.
const LIVE_WATCHDOG_MS = 12000
/** The live socket's backoff returns to its floor only after a connection has STAYED up this long. */
export const LIVE_STABLE_CONNECTION_MS = 10_000
export const LIVE_RETRY_MIN_MS = 750
export const LIVE_RETRY_MAX_MS = 10_000

/** Unsubscribes when called; `reconnect()` replaces the live socket immediately. */
export type LiveSubscription = (() => void) & { reconnect: () => void }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)
const UINT64_MAX = 18446744073709551615n
/** Parse without ever passing through Number, which would lose uint64 precision. */
export const stateRevision = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined
  try {
    return BigInt(value) <= UINT64_MAX ? value : undefined
  } catch {
    return undefined
  }
}
const sequenceNumber = (value: unknown): number | undefined => {
  const parsed = finite(value)
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff ? parsed : undefined
}
const identifierText = (value: unknown): string | undefined => {
  const numeric = finite(value)
  return numeric !== undefined && Number.isInteger(numeric) && numeric >= 0 ? String(numeric) : text(value)
}
let controllerMutationGate: (() => string | undefined) | undefined
let controllerModelGate: ((operation: ModelSpecificOperation) => string | undefined) | undefined

/** Wire the application currency gate into every non-safety mutating transport call. */
export const setControllerMutationGate = (gate?: () => string | undefined) => {
  controllerMutationGate = gate
}

const mutationBlocked = () => controllerMutationGate?.()

/**
 * Model-specific commands have a separate fail-closed gate so an unknown controller can still
 * serve and mutate its model-neutral library. Stop deliberately never consults either gate.
 */
export const setControllerModelGate = (gate?: (operation: ModelSpecificOperation) => string | undefined) => {
  controllerModelGate = gate
}

const modelBlocked = (operation: ModelSpecificOperation) => controllerModelGate?.(operation)

const sessionText = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffffffff) return String(value)
  return text(value)
}
const bool = (value: unknown): boolean => value === true
const sentinel = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined
const round = (value: number) => Math.round(value * 10) / 10
const level = (value: number) => String(round(value))
const faultText = (value: unknown) => {
  const fault = text(value)
  return fault && fault !== 'none' ? fault : undefined
}

const LIFECYCLES: ControllerLifecycle[] = ['DISCONNECTED', 'STANDBY', 'READY', 'RUNNING', 'FAULT', 'MANUAL_LOCKOUT']
const STEP_ADVANCES: StepAdvance[] = ['settled', 'capped']
const MANUAL_END_REASONS: ManualEndReason[] = [
  'stopped',
  'renewal_rejected',
  'fault',
  'instruction_expired',
  'telemetry_stale',
  'heat_lease_expired',
]
const CALIBRATION_READINESS = ['ready', 'sensor_invalid', 'sensor_fault_latched', 'too_hot', 'stabilizing'] as const

const disconnectedStatus = (fault: string): ControllerStatus => ({
  lifecycle: 'DISCONNECTED',
  connected: false,
  stale: true,
  receivedAtMs: Date.now(),
  firmwareVersion: 'unknown',
  bootId: 'unknown',
  fault,
  manualLockout: false,
  thermocoupleValid: false,
  capabilities: {
    apiVersion: 'unavailable',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: false,
  },
})

const roasterIdentityFrom = (value: unknown): RoasterIdentity | undefined => {
  const source = record(value)
  const deviceId = identifierText(source?.device_id)
  const modelId = identifierText(source?.model_id)
  const displayName = text(source?.display_name)
  if (!deviceId || !modelId || !displayName || typeof source?.simulated !== 'boolean') return undefined
  const simulatesModelId = identifierText(source.simulates_model_id)
  return {
    deviceId,
    modelId,
    displayName,
    simulated: source.simulated,
    ...(simulatesModelId ? { simulatesModelId } : {}),
  }
}

const capabilitiesFrom = (body: Record<string, unknown>): ControllerCapabilities => {
  const advertised = record(body.capabilities)
  if (!advertised) {
    return {
      apiVersion: 'diagnostic-v0',
      autonomousTimedPrograms: false,
      thermalExecution: false,
      diagnosticTests: true,
    }
  }
  return {
    apiVersion: text(advertised.api_version) ?? 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: advertised.diagnostic_tests === true,
    manualRoast: advertised.manual_roast === true,
  }
}

export interface CalibrationCompletedStepStatus {
  index?: number
  fan?: number
  heat?: number
  elapsedSec?: number
  /** Corrected controller temperature captured when this step ended. */
  temperatureC?: number
  outcome?: string
}

export type CalibrationSettleState = 'minimum_dwell' | 'waiting_for_transition' | 'settled' | 'checking'

export interface CalibrationProgramProgressStatus extends CalibrationProgramStatus {
  logId?: string
  completedEpoch?: number
  stepElapsedSec?: number
  settleState?: CalibrationSettleState
  completedSteps?: CalibrationCompletedStepStatus[]
}

const calibrationCompletedStepsFrom = (value: unknown): CalibrationCompletedStepStatus[] | undefined => {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry) => {
    const source = record(entry)
    if (!source) return []
    return [
      {
        index: finite(source.index),
        fan: finite(source.fan),
        heat: finite(source.heat),
        elapsedSec: finite(source.elapsed_sec),
        temperatureC: finite(source.temperature_c),
        outcome: text(source.outcome),
      },
    ]
  })
}

const SETTLE_STATES = ['minimum_dwell', 'waiting_for_transition', 'settled', 'checking'] as const
const CALIBRATION_END_REASONS = [
  'completed',
  'stopped',
  'fault',
  'telemetry_stale',
  'qualification_stalled',
  'step_rejected',
  'renewal_rejected',
  'heat_lease_expired',
] as const satisfies readonly CalibrationEndReason[]

const calibrationFrom = (value: unknown): CalibrationProgramProgressStatus | undefined => {
  const source = record(value)
  if (!source) return undefined
  const startedEpoch = finite(source.started_epoch)
  return {
    active: bool(source.active),
    startedEpoch: startedEpoch !== undefined && startedEpoch > 0 ? startedEpoch : undefined,
    stepIndex: finite(source.step_index),
    stepCount: finite(source.step_count),
    currentFanLevel: finite(source.current_fan_level),
    currentHeatLevel: finite(source.current_heat_level),
    maxStepSeconds: finite(source.max_step_seconds),
    minStepSeconds: finite(source.min_step_seconds),
    settleSeconds: finite(source.settle_seconds),
    settleBandC: finite(source.settle_band_c),
    lastStepAdvance: sentinel(source.last_step_advance, STEP_ADVANCES),
    ...(identifierText(source.log_id) ? { logId: identifierText(source.log_id) } : {}),
    completedEpoch: finite(source.completed_epoch),
    stepElapsedSec: finite(source.step_elapsed_sec),
    settleState: sentinel(source.settle_state, SETTLE_STATES),
    completedSteps: calibrationCompletedStepsFrom(source.completed_steps),
    leaseRenewals: finite(source.lease_renewals),
    endReason: sentinel(source.end_reason, CALIBRATION_END_REASONS),
  }
}

const LOG_SOURCES = ['proof', 'calibration', 'manual', 'roast', 'none'] as const

const ROAST_MODES: RoastProgramMode[] = ['none', 'timed', 'journey', 'manual']
const ROAST_END_REASON_VALUES: RoastEndReason[] = [
  'completed',
  'stopped',
  'fault',
  'sensor_lost',
  'qualification_stalled',
  'step_rejected',
  'renewal_rejected',
  'command_rejected',
  'envelope_timeout',
  'instruction_expired',
  'telemetry_stale',
  'heat_lease_expired',
]

/**
 * Per-zone attainment offsets. The firmware sends `null` for a zone whose endpoint was never
 * reached, and `null` is the answer - a zone that never arrived did not arrive at second 0.
 */
const attainments = (value: unknown): Array<number | null> | undefined =>
  Array.isArray(value) ? value.map((entry) => finite(entry) ?? null) : undefined

/**
 * The `roast` block from `GET /api/status`, parsed with the same null-safe discipline as every
 * other block: a firmware that stops emitting a field degrades to "not reported" rather than to a
 * fake zero, and the PRESENCE of the block is the feature detection for the executor itself.
 *
 * `end_reason: "none"` is the idle sentinel and is parsed away, exactly as the calibration and
 * manual blocks treat theirs, so an absent reason reads as undefined rather than as a string a view
 * would then have to special-case.
 */
const roastFrom = (value: unknown): RoastProgramStatus | undefined => {
  const source = record(value)
  if (!source) return undefined
  const startedEpoch = finite(source.started_epoch)
  const planRev = sequenceNumber(source.plan_rev)
  return {
    ...(planRev ? { planRev } : {}),
    active: bool(source.active),
    mode: sentinel(source.mode, ROAST_MODES) ?? 'none',
    name: text(source.name),
    sessionId: sessionText(source.session_id),
    elapsedSec: finite(source.elapsed_sec),
    // 0 is "the clock has never synced", which is not a date and must never render as 1970.
    startedEpoch: startedEpoch !== undefined && startedEpoch > 0 ? startedEpoch : undefined,
    stepIndex: finite(source.step_index),
    stepElapsedSec: finite(source.step_elapsed_sec),
    stepCount: finite(source.step_count),
    zoneIndex: finite(source.zone_index),
    zoneCount: finite(source.zone_count),
    zoneEntrySec: finite(source.zone_entry_sec),
    zoneElapsedSec: finite(source.zone_elapsed_sec),
    zoneNominalSec: finite(source.zone_nominal_sec),
    zoneEndC: finite(source.zone_end_c),
    targetC: finite(source.target_c),
    commandedFan: finite(source.commanded_fan),
    commandedHeat: finite(source.commanded_heat),
    solvedFan: finite(source.solved_fan),
    solvedHeat: finite(source.solved_heat),
    correctionTotal: finite(source.correction_total),
    integral: finite(source.integral),
    saturated: bool(source.saturated),
    holdover: bool(source.holdover),
    holdoverMs: finite(source.holdover_ms),
    holdoverLimitMs: finite(source.holdover_limit_ms),
    ambientC: finite(source.ambient_c),
    batchMassG: finite(source.batch_mass_g),
    leaseRenewals: finite(source.lease_renewals),
    instructionAgeMs: finite(source.instruction_age_ms),
    instructionLimitMs: finite(source.instruction_limit_ms),
    zoneAttainedSec: attainments(source.zone_attained_sec),
    endReason: sentinel(source.end_reason, ROAST_END_REASON_VALUES),
  }
}

const activeZonesFrom = (value: unknown, idPrefix: string): ThermalSegment[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const zones = value.flatMap((value, index) => {
    const row = record(value)
    const startC = finite(row?.start_c)
    const endC = finite(row?.end_c)
    const durationSec = finite(row?.duration_sec)
    const fanMin = finite(row?.fan_min)
    const fanMax = finite(row?.fan_max)
    const heatMin = finite(row?.heat_min)
    const heatMax = finite(row?.heat_max)
    return startC !== undefined &&
      endC !== undefined &&
      durationSec !== undefined &&
      fanMin !== undefined &&
      fanMax !== undefined &&
      heatMin !== undefined &&
      heatMax !== undefined
      ? [{ id: `${idPrefix}-${index + 1}`, startC, endC, durationSec, fanMin, fanMax, heatMin, heatMax }]
      : []
  })
  return zones.length === value.length ? zones : undefined
}

const activeRoastPlanFrom = (value: unknown): ActiveRoastPlan => {
  const source = record(value)
  if (!source) throw new Error('The roaster sent an invalid active plan')
  const rawSteps = Array.isArray(source.steps) ? source.steps : []
  const rawZones = Array.isArray(source.zones) ? source.zones : []
  const steps = rawSteps.flatMap((value) => {
    const row = record(value)
    const fan = finite(row?.fan)
    const heat = finite(row?.heat)
    const durationSec = finite(row?.duration_sec)
    return fan !== undefined && heat !== undefined && durationSec !== undefined ? [{ fan, heat, durationSec }] : []
  })
  const zones = activeZonesFrom(rawZones, 'active-zone')
  const initialZones = activeZonesFrom(source.initial_zones, 'initial-zone')
  if (steps.length !== rawSteps.length || !zones || (source.initial_zones !== undefined && !initialZones))
    throw new Error('The roaster sent an invalid active plan')
  return {
    active: bool(source.active),
    bootId: identifierText(source.boot_id),
    sessionId: sessionText(source.session_id),
    planRev: sequenceNumber(source.plan_rev),
    mode: sentinel(source.mode, ROAST_MODES) ?? 'none',
    profileId: text(source.profile_id),
    profileRevision: sequenceNumber(source.profile_revision),
    name: text(source.name),
    batchMassG: finite(source.batch_mass_g),
    steps,
    zones,
    initialZones,
    journal: Array.isArray(source.journal) ? source.journal : undefined,
  }
}

type ThermalLogWithIdentity = ThermalLogStatus & { logId?: string }

const thermalLogFrom = (value: unknown): ThermalLogWithIdentity | undefined => {
  const source = record(value)
  if (!source) return undefined
  return {
    available: typeof source.available === 'boolean' ? source.available : undefined,
    active: bool(source.active),
    samples: finite(source.samples),
    capacity: finite(source.capacity),
    intervalMs: finite(source.interval_ms),
    download: text(source.download),
    // Stable from reservation through archive, so reconnect hydration can name the exact log.
    ...(identifierText(source.log_id) ? { logId: identifierText(source.log_id) } : {}),
    // Firmware 2026-07-26.38 and later name what is being recorded and whether it has reached flash.
    source: sentinel(source.source, LOG_SOURCES),
    unsaved: typeof source.unsaved === 'boolean' ? source.unsaved : undefined,
  }
}

/**
 * The `data_store` block, parsed with the same null-safe discipline as every other one.
 *
 * The PRESENCE of the block is the feature detection for the document store, so this returns
 * undefined for a firmware that omits it and a real object - possibly with `mounted: false` - for
 * one that does not. `collections` is a sparse map on purpose: a collection that has never been
 * written is absent, and that absence is the same fact as its `GET` answering 404, which is exactly
 * what the boot reconciliation needs to know before it decides the store is empty.
 */
const dataStoreFrom = (value: unknown): ControllerStatus['dataStore'] => {
  const source = record(value)
  if (!source) return undefined
  const collections: Record<string, { bytes?: number; version?: number }> = {}
  for (const [name, entry] of Object.entries(record(source.collections) ?? {})) {
    const stored = record(entry)
    if (stored) collections[name] = { bytes: finite(stored.bytes), version: finite(stored.version) }
  }
  const runs = record(source.runs)
  return {
    mounted: bool(source.mounted),
    usedBytes: finite(source.used_bytes),
    totalBytes: finite(source.total_bytes),
    freeBytes: finite(source.free_bytes),
    // The 507 line, kept rather than discarded: `free_bytes` alone does not say where it is, and the
    // app's own constant is a fallback for old firmware, not a second opinion about this one.
    writeFloorBytes: finite(source.write_floor_bytes),
    collections,
    runs: { count: finite(runs?.count), bytes: finite(runs?.bytes) },
  }
}

const manualFrom = (value: unknown): ManualStatus | undefined => {
  const source = record(value)
  if (!source) return undefined
  return {
    active: bool(source.active),
    fanLevel: finite(source.fan_level),
    heatLevel: finite(source.heat_level),
    sinceMs: finite(source.since_ms),
    endReason: sentinel(source.end_reason, MANUAL_END_REASONS),
    // The 30-minute instruction lease. Absent on firmware that predates it; these renamed one for
    // one from `keepalive_ms_ago` / `keepalive_limit_ms` and carry the same semantics.
    instructionAgeMs: finite(source.instruction_age_ms),
    instructionLimitMs: finite(source.instruction_limit_ms),
  }
}

const liveSnapshot = (value: unknown): LiveSnapshot => {
  const body = record(value)
  if (!body) throw new Error('Invalid live payload')
  return {
    receivedAtMs: Date.now(),
    firmwareVersion: text(body.firmware_version),
    roaster: roasterIdentityFrom(body.roaster),
    capabilities: record(body.capabilities) ? capabilitiesFrom(body) : undefined,
    manualLockout: typeof body.manual_conflict_latched === 'boolean' ? body.manual_conflict_latched : undefined,
    connected: true,
    temperatureC: finite(body.tc_c),
    ambientC: finite(body.cj_c),
    effectiveFan: finite(body.fan),
    effectiveHeat: finite(body.heat),
    requestedFan: finite(body.fan_req),
    requestedHeat: finite(body.heat_req),
    actuatorMode: text(body.mode),
    fault: faultText(body.fault),
    calibrationActive: bool(body.cal_active),
    calibrationStep: finite(body.cal_step),
    calibrationCount: finite(body.cal_count),
    calibrationId: identifierText(body.cal_id),
    calibrationFan: finite(body.cal_fan),
    calibrationHeat: finite(body.cal_heat),
    calibrationElapsedSec: finite(body.cal_elapsed_s),
    calibrationSettleState: sentinel(body.cal_settle, SETTLE_STATES),
    calibrationEndReason: sentinel(body.cal_end, CALIBRATION_END_REASONS),
    calibrationCompletedSteps: calibrationCompletedStepsFrom(body.cal_done),
    thermalLogActive: typeof body.log_active === 'boolean' ? body.log_active : undefined,
    thermalLogId: identifierText(body.log_id),
    thermalLogSource: sentinel(body.log_source, LOG_SOURCES),
    manualActive: bool(body.manual_active),
    manualSinceMs: finite(body.manual_since_ms),
    logSamples: finite(body.log_samples),
    roastActive: bool(body.roast_active),
    roastJourney: bool(body.roast_journey),
    roastMode: sentinel(body.roast_mode, ROAST_MODES),
    roastSessionId: sessionText(body.roast_session_id),
    roastSaturated: typeof body.roast_saturated === 'boolean' ? body.roast_saturated : undefined,
    roastHoldover: typeof body.roast_holdover === 'boolean' ? body.roast_holdover : undefined,
    roastElapsedSec: finite(body.roast_elapsed_s),
    roastZone: finite(body.roast_zone),
    roastZones: finite(body.roast_zones),
    roastTargetC: finite(body.roast_target_c),
    roastZoneEntrySec: finite(body.roast_zone_entry_s),
    roastZoneNominalSec: finite(body.roast_zone_nominal_s),
    roastZoneEndC: finite(body.roast_zone_end_c),
    roastCorrectionTotal: finite(body.roast_correction),
    roastIntegral: finite(body.roast_integral),
    roastSolvedFan: finite(body.roast_solved_fan),
    roastSolvedHeat: finite(body.roast_solved_heat),
    roastHoldoverMs: finite(body.roast_holdover_ms),
    roastZonesAttained: attainments(body.roast_zones_done),
    roastEndReason: sentinel(body.roast_end, ROAST_END_REASON_VALUES),
    bootId: identifierText(body.boot_id) ?? identifierText(body.boot),
    streamSeq: sequenceNumber(body.stream_seq),
    roastName: text(body.roast_name),
    roastStartedEpoch: finite(body.roast_started_epoch),
    roastBatchMassG: finite(body.roast_batch_g),
    roastAmbientC: finite(body.roast_ambient_c),
    stateRev: stateRevision(body.state_rev),
    planRev: sequenceNumber(body.plan_rev),
  }
}

export const calibrationParamError = (params: CalibrationStartParams): string | undefined => {
  const inRange = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max
  if (isGridProgram(params)) {
    if (params.fans.length < 1 || params.fans.length > CALIBRATION_LIMITS.maximumGridFans)
      return `Enter 1 to ${CALIBRATION_LIMITS.maximumGridFans} fan levels`
    if (params.heats.length < 1 || params.heats.length > CALIBRATION_LIMITS.maximumGridHeats)
      return `Enter 1 to ${CALIBRATION_LIMITS.maximumGridHeats} heat levels`
    if (params.fans.some((value) => !inRange(value, Number.EPSILON, CALIBRATION_LIMITS.level.max)))
      return 'Every grid fan level must be above 0.0 and at most 10.0'
    if (params.heats.some((value) => !inRange(value, Number.EPSILON, CALIBRATION_LIMITS.level.max)))
      return 'Every grid heat level must be above 0.0 and at most 10.0'
    if (params.fans.length * params.heats.length > CALIBRATION_LIMITS.maximumProgramSteps)
      return `The expanded grid exceeds ${CALIBRATION_LIMITS.maximumProgramSteps} steps`
  } else {
    const steps = params.steps ?? []
    if (steps.length < 1 || steps.length > CALIBRATION_LIMITS.maximumSteps)
      return `Enter 1 to ${CALIBRATION_LIMITS.maximumSteps} fan:heat steps`
    for (const step of steps) {
      if (
        !inRange(step.fan, CALIBRATION_LIMITS.level.min, CALIBRATION_LIMITS.level.max) ||
        !inRange(step.heat, CALIBRATION_LIMITS.level.min, CALIBRATION_LIMITS.level.max)
      )
        return 'Fan and heat must be between 0.0 and 10.0'
      if (step.fan === 0 && step.heat > 0) return 'Fan 0 is only allowed with heat 0'
    }
  }
  if (!inRange(params.maxStepSeconds, CALIBRATION_LIMITS.maxStepSeconds.min, CALIBRATION_LIMITS.maxStepSeconds.max))
    return 'Step cap must be between 15 and 300 seconds'
  if (!inRange(params.minStepSeconds, CALIBRATION_LIMITS.minStepSeconds.min, CALIBRATION_LIMITS.minStepSeconds.max))
    return 'Minimum dwell must be between 5 and 120 seconds'
  if (params.minStepSeconds > params.maxStepSeconds) return 'Minimum dwell cannot exceed the step cap'
  if (!inRange(params.settleSeconds, CALIBRATION_LIMITS.settleSeconds.min, CALIBRATION_LIMITS.settleSeconds.max))
    return 'Settle hold must be between 2 and 30 seconds'
  if (!inRange(params.settleBandC, CALIBRATION_LIMITS.settleBandC.min, CALIBRATION_LIMITS.settleBandC.max))
    return 'Settle band must be between 0.2 and 10.0 °C'
  return undefined
}

export class HttpControllerClient implements ControllerClient, DeviceStoreClient {
  private restoreMaintenanceToken?: string
  private statusRequest?: Promise<ControllerStatus>

  private storageRequestTail: Promise<void> = Promise.resolve()
  private readonly baseUrl: string
  private readonly pathPrefix: string

  constructor(target?: Pick<ConfiguredRoasterTarget, 'baseUrl' | 'pathPrefix'>) {
    this.baseUrl = normalizeTargetBaseUrl(target?.baseUrl ?? '')
    this.pathPrefix = normalizeTargetPathPrefix(target?.pathPrefix)
    if (this.baseUrl) {
      const parsed = new URL(this.baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error('A roaster target must use http or https')
      if (parsed.username || parsed.password || parsed.search || parsed.hash)
        throw new Error('A roaster target must be an origin, without credentials, query, or fragment')
      if (parsed.pathname !== '/' && parsed.pathname !== '')
        throw new Error('A roaster target must be an origin, without a path')
    }
    if (this.pathPrefix.includes('?') || this.pathPrefix.includes('#') || this.pathPrefix.includes('..')) {
      throw new Error('A roaster proxy prefix must be a simple absolute path')
    }
  }

  /** Relative by default; absolute for an explicitly configured target or same-origin proxy. */
  private endpoint(path: string): string {
    const targetPath = `${this.pathPrefix}${path}`
    return this.baseUrl ? new URL(targetPath, `${this.baseUrl}/`).toString() : targetPath
  }

  /**
   * One browser gets one FIFO into controller storage. A response does not leave the lane until its
   * body is buffered, so a manifest, recording download, and document save cannot collide merely
   * because different components requested them at the same time.
   */
  private queueStorageRequest<T>(operation: () => Promise<T>): Promise<T> {
    const request = this.storageRequestTail.then(operation, operation)
    this.storageRequestTail = request.then(
      () => undefined,
      () => undefined,
    )
    return request
  }

  private async fetchWithBusyRetry(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    busyBudgetMs: number,
  ): Promise<Response> {
    const deadlineMs = Date.now() + busyBudgetMs
    while (true) {
      const response = await fetch(this.endpoint(path), {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const retryAfter = Number(response.headers.get('Retry-After'))
      const transientBusy = response.status === 503 && Number.isFinite(retryAfter) && retryAfter > 0
      if (!transientBusy) return response
      const delayMs = Math.min(1500, Math.max(250, retryAfter * 1000)) + Math.floor(Math.random() * 151)
      if (Date.now() + delayMs > deadlineMs) return response
      // Drain the explicit pre-admission refusal before retrying on the same browser connection.
      await response.arrayBuffer().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  private isStoragePath(path: string): boolean {
    return (
      path.startsWith(DEVICE_DATA_PREFIX) ||
      path === DEVICE_LOGS_URL ||
      path.startsWith(DEVICE_LOG_PREFIX) ||
      path === THERMAL_CSV_URL
    )
  }

  private async storageFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.queueStorageRequest(async () => {
      const response = await this.fetchWithBusyRetry(path, init, timeoutMs, 15_000)
      // Fetch resolves when headers arrive. Buffer before releasing the FIFO so a slow recording
      // body remains the active transfer rather than overlapping the request queued behind it.
      const buffered = response.clone()
      await response.arrayBuffer()
      return buffered
    })
  }

  /** Ordinary observations retry once; storage reads join the longer FIFO above. */
  private async get(path: string, timeoutMs: number): Promise<Response> {
    if (this.isStoragePath(path)) return this.storageFetch(path, { method: 'GET' }, timeoutMs)
    return this.fetchWithBusyRetry(path, { method: 'GET' }, timeoutMs, 1_600)
  }
  status(): Promise<ControllerStatus> {
    // The native server formats status from an immutable controller snapshot,
    // so status remains safe during actuation. Coalesce callers only to avoid
    // redundant work; this is not a control-loop lock or an actuation gate.
    if (this.statusRequest) return this.statusRequest
    const request = this.fetchStatus().then((next) => {
      return next
    })
    this.statusRequest = request
    void request.then(
      () => {
        if (this.statusRequest === request) this.statusRequest = undefined
      },
      () => {
        if (this.statusRequest === request) this.statusRequest = undefined
      },
    )
    return request
  }

  private async fetchStatus(): Promise<ControllerStatus> {
    try {
      const response = await this.get(STATUS_URL, STATUS_TIMEOUT_MS)
      const body = record(await response.json().catch(() => undefined))
      if (response.status === 401) return disconnectedStatus('Sign in required')
      if (!response.ok) return disconnectedStatus(text(body?.message) ?? `HTTP ${response.status}`)
      if (!body) return disconnectedStatus('The roaster sent a status this app could not read')
      const actuator = record(body.actuator)
      const sensor = record(body.max31856)
      const calibration = calibrationFrom(body.calibration)
      const systemBlock = record(body.system)
      const system = systemBlock
        ? {
            resetReason: text(systemBlock.reset_reason),
            uptimeMs: finite(systemBlock.uptime_ms),
            freeHeapBytes: finite(systemBlock.heap_free_bytes),
            minimumFreeHeapBytes: finite(systemBlock.heap_minimum_free_bytes),
            largestFreeHeapBlockBytes: finite(systemBlock.heap_largest_free_block_bytes),
            freePsramBytes: finite(systemBlock.psram_free_bytes),
            minimumFreePsramBytes: finite(systemBlock.psram_minimum_free_bytes),
            largestFreePsramBlockBytes: finite(systemBlock.psram_largest_free_block_bytes),
            lastLoopGapMs: finite(systemBlock.loop_last_gap_ms),
            maximumLoopGapMs: finite(systemBlock.loop_maximum_gap_ms),
            lastArchivePersistMs: finite(systemBlock.archive_persist_last_ms),
            maximumArchivePersistMs: finite(systemBlock.archive_persist_maximum_ms),
            archivePersistCount: finite(systemBlock.archive_persist_count),
            bootHistory: Array.isArray(systemBlock.boot_history)
              ? systemBlock.boot_history.flatMap((entry) => {
                  const row = record(entry)
                  const boot = finite(row?.boot)
                  const resetReason = text(row?.reset_reason)
                  return boot === undefined || resetReason === undefined ? [] : [{ boot, resetReason }]
                })
              : undefined,
            storedCrash: (() => {
              const crash = record(systemBlock.stored_crash)
              const task = text(crash?.task)
              const pc = text(crash?.pc)
              if (!crash || task === undefined || pc === undefined) return undefined
              return {
                task,
                pc,
                backtrace: Array.isArray(crash.backtrace)
                  ? crash.backtrace.flatMap((value) => {
                      const frame = text(value)
                      return frame === undefined ? [] : [frame]
                    })
                  : [],
                corrupted: crash.corrupted === true,
                elfSha256: text(crash.elf_sha256) ?? '',
                currentBuild: typeof crash.current_build === 'boolean' ? crash.current_build : undefined,
              }
            })(),
            psramLowWaterBytes: finite(systemBlock.psram_low_water_bytes),
            psramLowWaterAtMs: finite(systemBlock.psram_low_water_at_ms),
            failedAllocations: finite(systemBlock.failed_allocations),
            lastFailedAllocation: (() => {
              const failure = record(systemBlock.last_failed_allocation)
              const bytes = finite(failure?.bytes)
              const caps = finite(failure?.caps)
              const atMs = finite(failure?.at_ms)
              return bytes === undefined || caps === undefined || atMs === undefined ? undefined : { bytes, caps, atMs }
            })(),
          }
        : undefined
      const sensorFaultReasons = Array.isArray(sensor?.fault_reasons)
        ? sensor.fault_reasons.flatMap((value) => {
            const reason = text(value)
            return reason === undefined ? [] : [reason]
          })
        : undefined
      const thermalLog = thermalLogFrom(body.thermal_log)
      const manual = manualFrom(body.manual)
      /*
       * The roast executor's feature detection is the PRESENCE of `roast` in this document, exactly
       * as the archive's is `log_archive`. A device without the executor omits the key, and the
       * Roast page's device Start path stays unreachable rather than failing at the request.
       */
      const roast = roastFrom(body.roast)
      /*
       * The archive's feature detection is the PRESENCE of `log_archive` in this document. A device
       * at 2026-07-26.37 or older omits the key, and no amount of probing `/api/logs` would change that - so
       * the status document decides, and the routes are only called once it has said yes.
       */
      const logArchive = parseArchiveStorage(body.log_archive)
      /*
       * The document store's feature detection, same rule again: a firmware without `/data` omits
       * `data_store` entirely, and the app then runs on IndexedDB alone rather than probing.
       */
      const dataStore = dataStoreFrom(body.data_store)
      const appliedCoefficients = parseDeviceCoefficients(body.applied_calibration)
      const manualLockout = bool(body.manual_conflict_latched)
      const fault = faultText(actuator?.fault)
      const reportedLifecycle = sentinel(body.lifecycle, LIFECYCLES)
      let lifecycle: ControllerLifecycle
      if (manualLockout) lifecycle = 'MANUAL_LOCKOUT'
      else if (fault) lifecycle = 'FAULT'
      else if (reportedLifecycle) lifecycle = reportedLifecycle
      else if (calibration?.active || manual?.active || roast?.active || text(actuator?.mode) === 'running')
        lifecycle = 'RUNNING'
      else lifecycle = 'STANDBY'
      const appUsedBytes = finite(body.app_used_bytes)
      const appSlotBytes = finite(body.ota_slot_bytes)
      const appFreeBytes = finite(body.app_free_bytes)
      const spiffsReservedBytes = finite(body.spiffs_reserved_bytes)
      const controllerHistoryUsedBytes = finite(body.controller_history_used_bytes)
      const roasterIdentity = roasterIdentityFrom(body.roaster)
      const calibrationReadiness = sentinel(body.calibration_readiness, CALIBRATION_READINESS)
      const restore = record(body.restore_maintenance)
      const restoreMaintenance = restore
        ? {
            active: bool(restore.active),
            incomplete: bool(restore.incomplete),
            expiresInMs: finite(restore.expires_in_ms),
          }
        : undefined
      return {
        lifecycle,
        connected: true,
        stale: false,
        receivedAtMs: Date.now(),
        firmwareVersion: text(body.firmware_version) ?? 'unknown',
        bootId: identifierText(body.boot_id) ?? identifierText(body.boot_count) ?? 'unknown',
        ...(roasterIdentity ? { roaster: roasterIdentity } : {}),
        ...(stateRevision(body.state_rev) ? { stateRev: stateRevision(body.state_rev) } : {}),
        ...(finite(body.last_request_id) !== undefined ? { lastRequestId: finite(body.last_request_id) } : {}),
        ...(finite(body.last_request_status) !== undefined
          ? { lastRequestStatus: finite(body.last_request_status) }
          : {}),
        ...(finite(body.thermocouple_offset_c) !== undefined
          ? { thermocoupleOffsetC: finite(body.thermocouple_offset_c) }
          : {}),
        ...(typeof body.calibration_ready === 'boolean' ? { calibrationReady: body.calibration_ready } : {}),
        ...(calibrationReadiness ? { calibrationReadiness } : {}),
        ...(finite(body.calibration_stable_for_ms) !== undefined
          ? { calibrationStableForMs: finite(body.calibration_stable_for_ms) }
          : {}),
        ...(restoreMaintenance ? { restoreMaintenance } : {}),
        activeRunId: text(body.active_run_id),
        loadedProfileHash: text(body.loaded_profile_hash),
        fault,
        ...(system ? { system } : {}),
        ...(sensorFaultReasons ? { sensorFaultReasons } : {}),
        manualLockout,
        thermocoupleValid: bool(sensor?.temperature_valid),
        temperatureC: finite(sensor?.thermocouple_c),
        ambientC: finite(sensor?.cold_junction_c),
        actuatorMode: text(actuator?.mode),
        logArchive,
        dataStore,
        appliedCoefficients,
        effectiveFan: finite(actuator?.effective_fan),
        effectiveHeat: finite(actuator?.effective_heat),
        overtempLimitC: finite(actuator?.overtemp_limit_c),
        overtempCooldownRemainingMs: finite(actuator?.overtemp_cooldown_remaining_ms),
        storage:
          appUsedBytes !== undefined || appSlotBytes !== undefined || spiffsReservedBytes !== undefined
            ? {
                appUsedBytes,
                appSlotBytes,
                appFreeBytes,
                spiffsReservedBytes,
                controllerHistoryUsedBytes,
                controllerHistoryEnabled: bool(body.controller_history_enabled),
              }
            : undefined,
        liveTransport:
          body.live_websocket_available !== undefined
            ? {
                websocketAvailable: bool(body.live_websocket_available),
                websocketPort: finite(body.live_websocket_port),
                websocketClientCount: finite(body.live_websocket_client_count),
                websocketClientCapacity: finite(body.live_websocket_client_capacity),
                websocketBroadcastCount: finite(body.live_websocket_broadcast_count),
                websocketSendFailureCount: finite(body.live_websocket_send_failure_count),
                websocketQueueFailureCount: finite(body.live_websocket_queue_failure_count),
                websocketStackLowWaterBytes: finite(body.live_websocket_stack_low_water_bytes),
                pendingStaticTransferCount: finite(body.http_pending_static_transfer_count),
                httpResponseStallAbortCount: finite(body.http_response_stall_abort_count),
                httpResponsePeerAbortCount: finite(body.http_response_peer_abort_count),
                httpRejectedRequestCount: finite(body.http_rejected_request_count),
                httpWorkerFailureCount: finite(body.http_worker_failure_count),
                httpWorkerStackLowWaterBytes: finite(body.http_worker_stack_low_water_bytes),
                httpAssetWorkerStackLowWaterBytes: finite(body.http_asset_worker_stack_low_water_bytes),
                httpCommandWorkerStackLowWaterBytes: finite(body.http_command_worker_stack_low_water_bytes),
                storageWorkerStackLowWaterBytes: finite(body.storage_worker_stack_low_water_bytes),
                storageWorkerStackLowWaterRoute: text(body.storage_worker_stack_low_water_route),
                storageSlowestRequestMs: finite(body.storage_request_slowest_ms),
                storageSlowestRequestRoute: text(body.storage_request_slowest_route),
                storageRequestsOverOneSecond: finite(body.storage_requests_over_1s),
                wifiRssiDbm: finite(body.station_rssi_dbm),
                wifiDisconnectCount: finite(body.wifi_disconnect_count),
              }
            : undefined,
        capabilities: capabilitiesFrom(body),
        calibration,
        manual,
        thermalLog,
        roast,
      }
    } catch (error) {
      return disconnectedStatus(error instanceof Error ? error.message : 'The roaster did not answer')
    }
  }

  async live(): Promise<LiveSnapshot> {
    try {
      const response = await this.get(LIVE_URL, 3000)
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in required' : `HTTP ${response.status}`)
      const snapshot = liveSnapshot(await response.json())
      return snapshot
    } catch {
      return {
        receivedAtMs: Date.now(),
        connected: false,
        calibrationActive: false,
        manualActive: false,
        roastActive: false,
      }
    }
  }

  subscribeLive(
    onSnapshot: (snapshot: LiveSnapshot) => void,
    onConnection: (connected: boolean) => void = () => {},
  ): LiveSubscription {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined')
      return Object.assign(() => {}, { reconnect: () => {} })
    let disposed = false
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let watchdogTimer: number | undefined
    let stableTimer: number | undefined
    // A flaky link that delivers one frame and drops must not reconnect every 750 ms forever: the
    // backoff keeps growing until a connection has stayed up LIVE_STABLE_CONNECTION_MS.
    let retryMs = LIVE_RETRY_MIN_MS
    let announcedConnected = false
    let wireState: Record<string, unknown> | undefined
    let wireSequence: number | undefined
    const targetLocation = this.baseUrl ? new URL(this.baseUrl) : window.location
    const scheme = targetLocation.protocol === 'https:' ? 'wss:' : 'ws:'
    // HTTP and WebSocket traffic share one native server (firmware 2026-07-26.70 and later). This
    // preserves Vite/reverse-proxy targets and needs no extra port-81 socket.
    const authority = targetLocation.host

    const clearWatchdog = () => {
      if (watchdogTimer !== undefined) window.clearTimeout(watchdogTimer)
      watchdogTimer = undefined
    }
    const armWatchdog = (current: WebSocket) => {
      clearWatchdog()
      watchdogTimer = window.setTimeout(() => dropAndReconnect(current), LIVE_WATCHDOG_MS)
    }
    const clearStable = () => {
      if (stableTimer !== undefined) window.clearTimeout(stableTimer)
      stableTimer = undefined
    }
    const scheduleReconnect = () => {
      if (disposed) return
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, retryMs)
      retryMs = Math.min(retryMs * 2, LIVE_RETRY_MAX_MS)
    }
    /*
     * A socket is replaced, never waited out. A phone that locked holds a socket the roaster has
     * long since dropped; asked to close, iOS Safari may not deliver `onclose` for minutes, and
     * reconnecting only from `onclose` would leave the page STALE until the user re-entered the URL. The old socket's handlers are detached first, so whatever it reports later is ignored.
     */
    const abandon = (current: WebSocket) => {
      if (socket === current) socket = undefined
      current.onopen = null
      current.onmessage = null
      current.onerror = null
      current.onclose = null
      try {
        current.close()
      } catch {
        /* already closed */
      }
    }
    const dropAndReconnect = (current: WebSocket) => {
      if (disposed || socket !== current) return
      clearWatchdog()
      clearStable()
      abandon(current)
      if (announcedConnected) onConnection(false)
      announcedConnected = false
      scheduleReconnect()
    }
    const connect = () => {
      if (disposed) return
      let current: WebSocket
      try {
        current = new WebSocket(`${scheme}//${authority}${this.pathPrefix}${LIVE_WS_PATH}`)
      } catch {
        // A synchronous constructor throw (a transient security or network state) must schedule a
        // retry rather than end live reconnects for the life of the page.
        socket = undefined
        scheduleReconnect()
        return
      }
      socket = current
      announcedConnected = false
      armWatchdog(current)
      current.onopen = () => {
        wireState = undefined
        wireSequence = undefined
        armWatchdog(current)
      }
      current.onmessage = (event) => {
        try {
          const decoded: unknown = JSON.parse(String(event.data))
          const envelope = record(decoded)
          let payload: unknown = decoded
          if (envelope?.channel === 'live') {
            const kind = text(envelope.kind)
            const sequence = sequenceNumber(envelope.seq)
            const update = record(envelope.payload)
            if (!sequence || !update) throw new Error('Invalid live envelope')
            if (kind === 'snapshot') {
              wireState = { ...update }
              wireSequence = sequence
            } else if (kind === 'delta') {
              const base = sequenceNumber(envelope.base)
              if (!wireState || base !== wireSequence) {
                dropAndReconnect(current)
                return
              }
              wireState = { ...wireState, ...update }
              wireSequence = sequence
            } else {
              throw new Error('Unknown live envelope')
            }
            payload = wireState
          }
          const snapshot = liveSnapshot(payload)
          if (!announcedConnected) {
            announcedConnected = true
            clearStable()
            stableTimer = window.setTimeout(() => {
              stableTimer = undefined
              if (!disposed && socket === current) retryMs = LIVE_RETRY_MIN_MS
            }, LIVE_STABLE_CONNECTION_MS)
            onConnection(true)
          }
          onSnapshot(snapshot)
          armWatchdog(current)
        } catch {
          // Invalid frames do not keep the stream alive; the watchdog restores HTTP fallback.
        }
      }
      current.onerror = () => dropAndReconnect(current)
      current.onclose = () => dropAndReconnect(current)
    }

    connect()
    const stop = () => {
      disposed = true
      clearWatchdog()
      clearStable()
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (socket) abandon(socket)
    }
    /** A fresh socket now, at the shortest backoff: the page woke, came back online, or went stale. */
    const reconnect = () => {
      if (disposed) return
      clearWatchdog()
      clearStable()
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (socket) abandon(socket)
      if (announcedConnected) onConnection(false)
      announcedConnected = false
      retryMs = LIVE_RETRY_MIN_MS
      connect()
    }
    return Object.assign(stop, { reconnect })
  }

  private async blockedReason() {
    const status = await this.status()
    if (!status.connected) return status.fault ?? 'The roaster is not connected'
    if (!status.capabilities.diagnosticTests) return 'This firmware does not offer diagnostic tests'
    return undefined
  }

  /** Retained for callers compiled against older firmware; native status is never deferred. */
  fullStatusDeferred(): boolean {
    return false
  }

  private async runActuationCommand(operation: () => Promise<CommandResult>): Promise<CommandResult> {
    return operation()
  }
  private actuationCommand(url: string): Promise<CommandResult> {
    return this.runActuationCommand(() => this.command(url))
  }

  private async command(url: string): Promise<CommandResult> {
    try {
      const response = await fetch(this.endpoint(url), {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
      })
      if (response.status === 401) return { ok: false, message: 'Sign in required' }
      const body = record(await response.json().catch(() => undefined))
      const message = text(body?.message)
      if (response.status === 504) {
        const requestId = finite(Number(response.headers.get('X-Crackle-Request-Id')))
        if (requestId !== undefined) {
          // The controller may have committed after the worker's acknowledgement
          // wait elapsed. Reconcile the immutable status head; never replay the
          // mutation blindly.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await new Promise((resolve) => globalThis.setTimeout(resolve, 150))
            const current = await this.fetchStatus()
            if (current.lastRequestId !== requestId) continue
            const committed =
              current.lastRequestStatus !== undefined &&
              current.lastRequestStatus >= 200 &&
              current.lastRequestStatus < 300
            return {
              ok: committed,
              message: committed
                ? 'The roaster committed the request after its acknowledgement was delayed.'
                : `The roaster completed the request with HTTP ${current.lastRequestStatus ?? 500}.`,
              stateRev: current.stateRev,
            }
          }
        }
        return {
          ok: false,
          message:
            message ??
            'The command outcome could not be confirmed. Current state was refreshed; review it before retrying.',
        }
      }
      if (!response.ok) return { ok: false, message: message ?? `HTTP ${response.status}` }
      return commandResult(body, message)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The roaster did not answer' }
    }
  }
  async stopAll(): Promise<CommandResult> {
    return this.command(STOP_ALL_URL)
  }

  async startCalibration(params: CalibrationStartParams): Promise<CommandResult> {
    const gate = mutationBlocked() ?? modelBlocked('calibrate')
    if (gate) return { ok: false, message: gate }
    const invalid = calibrationParamError(params)
    if (invalid) return { ok: false, message: invalid }
    const blocked = await this.blockedReason()
    if (blocked) return { ok: false, message: blocked }
    const program: Record<string, string> = isGridProgram(params)
      ? { fans: params.fans.map(level).join(','), heats: params.heats.map(level).join(',') }
      : { steps: (params.steps ?? []).map((pair) => `${level(pair.fan)}:${level(pair.heat)}`).join(',') }
    const query = new URLSearchParams({
      confirm: CALIBRATION_CONFIRM,
      ...program,
      step_seconds: String(Math.round(params.maxStepSeconds)),
      min_step_seconds: String(Math.round(params.minStepSeconds)),
      settle_seconds: String(Math.round(params.settleSeconds)),
      settle_band_tenths_c: String(Math.round(params.settleBandC * 10)),
    })
    return this.actuationCommand(`${CALIBRATION_START_URL}?${query.toString()}`)
  }

  async stopCalibration(): Promise<CommandResult> {
    return this.command(CALIBRATION_STOP_URL)
  }

  async setManual(levels: ManualLevels): Promise<CommandResult> {
    const gate = mutationBlocked() ?? modelBlocked('start')
    if (gate) return { ok: false, message: gate }
    const invalid = manualParamError(levels, { allowZeroStop: true })
    if (invalid) return { ok: false, message: invalid }
    const query = new URLSearchParams({
      confirm: MANUAL_CONFIRM,
      fan: level(levels.fan),
      heat: level(levels.heat),
    })
    return this.actuationCommand(`${MANUAL_SET_URL}?${query.toString()}`)
  }

  async stopManual(): Promise<CommandResult> {
    return this.command(MANUAL_STOP_URL)
  }

  /**
   * Hand the whole roast to the controller.
   *
   * There is no status pre-flight here, and that is deliberate rather than an omission. Every gate
   * the firmware checks is checked by `roastPreflight` against the status the page is already
   * holding, BEFORE this is called - including the one the firmware structurally cannot check, zone
   * feasibility - so a second round trip would only widen the window between "the browser looked"
   * and "the controller acted". The firmware's own gates are the authority either way, and every
   * refusal it can issue is mapped to plain language by `roastStartFailure`.
   *
   * On `202`, timed and journey plans need nothing else from the browser. Manual mode safely holds
   * its last instruction on the device, but the browser remains the operator's channel for changes.
   */
  async startRoast(args: RoastStartArgs): Promise<CommandResult> {
    const gate = mutationBlocked() ?? modelBlocked('start')
    if (gate) return { ok: false, message: gate }
    const query = new URLSearchParams(args as unknown as Record<string, string>)
    return this.runActuationCommand(async () => {
      let response: Response
      try {
        response = await fetch(this.endpoint(`${ROAST_START_URL}?${query.toString()}`), {
          method: 'POST',
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        })
      } catch (error) {
        // No HTTP status at all: the request may or may not have reached the roaster. A lost
        // acknowledgement is not a refusal, so ask the roaster what is running now.
        return this.reconcileLostStart(args, error instanceof Error ? error.message : undefined)
      }
      const body = record(await response.json().catch(() => undefined))
      if (response.ok) return commandResult(body)
      if (response.status === 504 || response.status === 502) {
        const requestId = finite(Number(response.headers.get('X-Crackle-Request-Id')))
        if (requestId !== undefined) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await new Promise((resolve) => globalThis.setTimeout(resolve, 150))
            const current = await this.fetchStatus()
            if (current.lastRequestId !== requestId) continue
            const status = current.lastRequestStatus
            if (status !== undefined && status >= 200 && status < 300) {
              return {
                ...startFromStatus(current),
                message: 'The roaster committed the Start after its acknowledgement was delayed.',
              }
            }
            return { ok: false, message: roastStartFailure(status ?? 500, text(body?.message)) }
          }
        }
        return this.reconcileLostStart(args, text(body?.message))
      }
      return { ok: false, message: roastStartFailure(response.status, text(body?.message)) }
    })
  }

  /**
   * The Start acknowledgement was lost. Status is the only witness: an active roast carrying the
   * requested name is this Start, accepted. Anything else that cannot be settled is reported as
   * UNKNOWN - never as a refusal - so the caller keeps the staged record rather than deleting the
   * record of a roast that may be running.
   */
  private async reconcileLostStart(args: RoastStartArgs, detail?: string): Promise<CommandResult> {
    const requested = sanitizeRoastName(args.name)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, 250))
      const current = await this.fetchStatus().catch(() => undefined)
      if (!current?.connected) continue
      const roast = current.roast
      if (roast?.active && roast.name !== undefined && sanitizeRoastName(roast.name) === requested) {
        return {
          ...startFromStatus(current),
          message: 'The roaster started the roast; its acknowledgement was lost on the way back.',
        }
      }
    }
    const said = detail ? ` (${detail})` : ''
    return {
      ok: false,
      outcomeUnknown: true,
      message: `The roaster's answer to Start was lost${said}, and its status could not confirm whether the roast began. Check the roaster before starting again.`,
    }
  }

  /** Apply a new instruction to an already-running manual roast. */
  async setRoast(levels: ManualLevels, expectedSessionId: string): Promise<CommandResult> {
    const gate = mutationBlocked() ?? modelBlocked('start')
    if (gate) return { ok: false, message: gate }
    const invalid = manualParamError(levels)
    if (invalid) return { ok: false, message: invalid }
    const query = new URLSearchParams({
      confirm: 'CONTROL_ROAST',
      expected_session: expectedSessionId,
      fan: level(levels.fan),
      heat: level(levels.heat),
    })
    return this.actuationCommand(`${ROAST_SET_URL}?${query.toString()}`)
  }

  /**
   * A manual stop names the session it owns so firmware can reject a status/request race. A
   * profiled stop remains argument-free and unconditional: withholding that safe direction because
   * status looks unhealthy is still worse than sending it.
   */
  async stopRoast(expectedSessionId?: string): Promise<CommandResult> {
    if (!expectedSessionId) return this.command(ROAST_STOP_URL)
    return this.command(`${ROAST_STOP_URL}?${new URLSearchParams({ expected_session: expectedSessionId }).toString()}`)
  }

  async fetchActiveRoastPlan(): Promise<ActiveRoastPlan> {
    const response = await this.get(ROAST_ACTIVE_PLAN_URL, 6000)
    const body = await response.json().catch(() => undefined)
    if (!response.ok)
      throw new Error(text(record(body)?.message) ?? `The roaster refused the active plan (HTTP ${response.status})`)
    return activeRoastPlanFrom(body)
  }

  async patchActiveTimedRoastStep(
    stepIndex: number,
    step: ActiveRoastStep,
    expectedSessionId: string,
    expectedPlanRev: number,
  ): Promise<ActivePlanPatchResult> {
    const gate = mutationBlocked() ?? modelBlocked('start')
    if (gate) return { ok: false, message: gate }
    const query = new URLSearchParams({
      confirm: 'PATCH_ROAST_PLAN',
      expected_session: expectedSessionId,
      expected_plan_rev: String(Math.max(0, Math.trunc(expectedPlanRev))),
      step_index: String(Math.max(0, Math.trunc(stepIndex))),
      fan: level(step.fan),
      heat: level(step.heat),
      duration_sec: String(Math.max(1, Math.trunc(step.durationSec))),
    })
    try {
      const response = await fetch(this.endpoint(`${ROAST_ACTIVE_PLAN_URL}?${query.toString()}`), {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })
      const body = record(await response.json().catch(() => undefined))
      if (response.ok) return { ok: true, plan: activeRoastPlanFrom(body) }
      return {
        ok: false,
        message: text(body?.message) ?? `The roaster refused the active step change (HTTP ${response.status})`,
        sessionId: sessionText(body?.session_id),
        planRev: sequenceNumber(body?.plan_rev),
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The roaster did not answer the active step change',
      }
    }
  }
  async patchActiveRoastPlan(
    zones: ThermalSegment[],
    expectedSessionId: string,
    expectedPlanRev: number,
    allowImmediateTransition = false,
  ): Promise<ActivePlanPatchResult> {
    const gate = mutationBlocked() ?? modelBlocked('start')
    if (gate) return { ok: false, message: gate }
    const query = new URLSearchParams({
      confirm: 'PATCH_ROAST_PLAN',
      expected_session: expectedSessionId,
      expected_plan_rev: String(Math.max(0, Math.trunc(expectedPlanRev))),
      zones: serializeJourneyZones(zones),
    })
    if (allowImmediateTransition) query.set('allow_immediate_transition', '1')
    try {
      const response = await fetch(this.endpoint(`${ROAST_ACTIVE_PLAN_URL}?${query.toString()}`), {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })
      const body = record(await response.json().catch(() => undefined))
      if (response.ok) {
        return {
          ok: true,
          plan: activeRoastPlanFrom(body),
          immediateTransition: body?.immediate_transition === true,
        }
      }
      return {
        ok: false,
        message: text(body?.message) ?? `The roaster refused the active plan change (HTTP ${response.status})`,
        sessionId: sessionText(body?.session_id),
        planRev: sequenceNumber(body?.plan_rev),
        requiresImmediateTransition: body?.requires_immediate_transition === true,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The roaster did not answer' }
    }
  }

  async setThermocoupleOffset(offsetC: number): Promise<CommandResult> {
    const gate = mutationBlocked()
    if (gate) return { ok: false, message: gate }
    if (!Number.isFinite(offsetC) || offsetC < -25 || offsetC > 25) {
      return { ok: false, message: 'Probe correction must be between -25.0 and 25.0 °C' }
    }
    const query = new URLSearchParams({
      confirm: 'SET_THERMOCOUPLE_OFFSET',
      offset_c: String(Math.round(offsetC * 100) / 100),
    })
    return this.command(`${THERMOCOUPLE_OFFSET_URL}?${query.toString()}`)
  }

  /**
   * The device log archive, feature-detected.
   *
   * Firmware after `2026-07-26.37` persists logs to SPIFFS and serves them; older firmware does not, and
   * answers 404. That is the ABSENCE of a feature, not a failure, so it maps to a stated
   * `unsupported` state rather than to an error banner - see `archiveStateFromStatus`. A network
   * failure maps to `unreachable`, which is a different thing that clears by itself.
   */
  async deviceLogs(): Promise<DeviceArchive> {
    try {
      const response = await this.get(DEVICE_LOGS_URL, 6000)
      if (response.status === 401) return deviceArchive('unreachable')
      if (response.status === 503 && response.headers.has('Retry-After')) return deviceArchive('busy')
      const state = archiveStateFromStatus(response.status)
      if (state !== 'available') return deviceArchive(state)
      const body = record(await response.json())
      return deviceArchive('available', parseDeviceLogList(body), {
        current: parseDeviceCurrentLog(body?.current),
        storage: parseArchiveStorage(body),
      })
    } catch {
      return deviceArchive('unreachable')
    }
  }

  /** One stored log, in the same CSV format `/thermal.csv` serves. */
  async fetchDeviceLogCsv(id: string): Promise<string> {
    const response = await this.get(`${DEVICE_LOG_PREFIX}${encodeURIComponent(id)}.csv`, 60000)
    if (response.status === 409)
      throw new Error('The current thermal recording is still being captured. Try again when it finishes.')
    if (response.status === 401) throw new Error('Sign in required')
    if (response.status === 404) throw new Error('That recording is no longer on the roaster')
    if (response.status === 503 && response.headers.has('Retry-After'))
      throw new Error('The roaster is busy serving another recording request. Try again shortly.')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.text()
  }

  /*
   * ==========================================================================================
   * BACKUP AND RESTORE
   * ==========================================================================================
   *
   * Three calls. Recordings travel as raw bytes in both directions. The native storage worker
   * streams each request body directly to a temporary file while keeping id and confirm in
   * the query string. Firmware validates that file through a 256-byte window before the atomic
   * rename, so every file up to the advertised format ceiling is restorable without a second
   * file-sized heap allocation.
   */

  /** One stored recording, byte for byte. The backup's whole job is to hand back what is on disk. */
  async fetchDeviceLogFile(id: string): Promise<Uint8Array> {
    const response = await this.get(`${DEVICE_LOG_PREFIX}${encodeURIComponent(id)}.crk`, 20000)
    if (response.status === 401) throw new Error('Sign in required')
    if (response.status === 404) throw new Error('That recording is no longer on the roaster')
    if (response.status === 503)
      throw new Error(
        response.headers.has('Retry-After')
          ? 'The roaster is busy serving another recording request. Try again shortly.'
          : 'Recording storage on the roaster is not mounted',
      )
    if (response.status === 409)
      throw new Error('The current thermal recording is still being captured. Try again when it finishes.')
    if (!response.ok) throw new Error(`The roaster refused the recording (HTTP ${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Put one recording back. Restore WINS: an id that already holds a recording is overwritten, with
   * no conflict token and no version dance, because a restore is not an edit - it is the user
   * replaying an archive they already hold. `confirm=RESTORE_LOG` is what makes that deliberate.
   */
  async restoreDeviceLog(id: string, bytes: Uint8Array): Promise<CommandResult> {
    const gate = this.restoreMaintenanceToken ? undefined : mutationBlocked()
    if (gate) return { ok: false, message: gate }
    if (id !== 'auto' && (!/^[1-9][0-9]*$/.test(id) || Number(id) >= 0xffffffff)) {
      return { ok: false, message: 'Recording ids must be auto or positive decimals below 4294967295' }
    }
    if (bytes.length > RESTORE_MAX_BYTES) {
      return {
        ok: false,
        message: `That recording is ${bytes.length} bytes and the roaster accepts at most ${RESTORE_MAX_BYTES}`,
      }
    }
    try {
      const query = new URLSearchParams({ id, confirm: RESTORE_LOG_CONFIRM })
      if (this.restoreMaintenanceToken) query.set('restore_token', this.restoreMaintenanceToken)
      // Storage mutations join the same browser FIFO and pre-admission busy retry as reads and
      // document writes, so a restore cannot collide with a manifest or save this tab issued.
      const response = await this.storageFetch(
        `${DEVICE_LOG_RESTORE_URL}?${query.toString()}`,
        {
          method: 'POST',
          // The firmware streams one raw archive body through the dedicated storage worker.
          // Multipart parsing added framing and state without adding any value here.
          headers: { 'content-type': 'application/octet-stream' },
          body: Uint8Array.from(bytes),
        },
        RESTORE_TIMEOUT_MS,
      )
      if (response.status === 401) return { ok: false, message: 'Sign in required' }
      const body = record(await response.json().catch(() => undefined))
      if (response.ok) {
        try {
          const recordingOrigin = requireRecordingOrigin(body?.recording_origin ?? body?.recordingOrigin)
          const storageAddress = requireStorageAddress(body?.storage_address ?? body?.storageAddress)
          return {
            ok: true,
            message: text(body?.message),
            stateRev: stateRevision(body?.state_rev),
            recordingOrigin,
            storageAddress,
          }
        } catch {
          return {
            ok: false,
            message: 'The roaster restored the recording but did not return trustworthy origin and storage identity.',
          }
        }
      }
      // The firmware names WHICH check failed in `check`; passing it through is the difference
      // between "the roaster refused it" and "its checksum did not match".
      const check = text(body?.check)
      return {
        ok: false,
        message:
          text(body?.message) ??
          (check ? `the roaster refused it (${check})` : `the roaster refused it (HTTP ${response.status})`),
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The roaster did not answer' }
    }
  }

  /**
   * Erase the volume. One call takes BOTH trees, because recordings and `/data` share it - the
   * firmware's own success body says `data_store_erased` out loud for exactly that reason.
   */
  async formatDeviceStorage(): Promise<CommandResult> {
    const gate = this.restoreMaintenanceToken ? undefined : mutationBlocked()
    if (gate) return { ok: false, message: gate }
    try {
      const query = new URLSearchParams({ confirm: FORMAT_LOGS_CONFIRM })
      if (this.restoreMaintenanceToken) query.set('restore_token', this.restoreMaintenanceToken)
      const response = await this.storageFetch(
        `${DEVICE_LOG_FORMAT_URL}?${query.toString()}`,
        { method: 'POST' },
        20000,
      )
      if (response.status === 401) return { ok: false, message: 'Sign in required' }
      if (response.status === 409)
        return {
          ok: false,
          message: 'The roaster is running or recording. It can only erase its storage while it is idle.',
        }
      const body = record(await response.json().catch(() => undefined))
      if (!response.ok)
        return { ok: false, message: text(body?.message) ?? `The roaster refused the erase (HTTP ${response.status})` }
      return { ok: true, message: text(body?.message), stateRev: stateRevision(body?.state_rev) }
    } catch {
      return { ok: false, message: 'The roaster is not connected' }
    }
  }

  /**
   * Deleting writes to flash, and the firmware defers flash writes while the actuator is running,
   * so a 409 here means "not now" rather than "no" - and saying so is the difference between the
   * user waiting thirty seconds and the user thinking the archive is broken.
   */
  async deleteDeviceLog(id: string): Promise<CommandResult> {
    const gate = mutationBlocked()
    if (gate) return { ok: false, message: gate }
    try {
      const query = new URLSearchParams({ id, confirm: DELETE_LOG_CONFIRM })
      const response = await this.storageFetch(`${DEVICE_LOG_DELETE_URL}?${query.toString()}`, { method: 'POST' }, 6000)
      if (response.status === 401) return { ok: false, message: 'Sign in required' }
      if (response.status === 404) return { ok: false, message: 'That recording is no longer on the roaster' }
      if (response.status === 409)
        return {
          ok: false,
          message:
            'The roaster is running or recording. It defers writes to its own storage until it is idle, so try again in a moment.',
        }
      if (response.status === 503) return { ok: false, message: 'Recording storage on the roaster is not mounted' }
      if (!response.ok) return { ok: false, message: `The roaster refused the delete (HTTP ${response.status})` }
      const body = record(await response.json().catch(() => undefined))
      return { ok: true, message: 'Recording deleted from the roaster', stateRev: stateRevision(body?.state_rev) }
    } catch {
      return { ok: false, message: 'The roaster is not connected' }
    }
  }

  /**
   * Push fitted coefficients to the device, so it holds its own applied set.
   *
   * Validated before anything leaves the browser, exactly as the calibration and manual commands
   * are: four finite numbers in range, and a `fit_id` already reduced to the alphabet the firmware
   * sanitizes to, so what comes back in status is byte-identical to what went out and the
   * divergence check can be trusted.
   */
  async applyCalibration(coefficients: AppliedCoefficientSet, fitId: string): Promise<CommandResult> {
    const gate = modelBlocked('apply-calibration')
    if (gate) return { ok: false, message: gate }
    const implausible = implausibleCoefficient(coefficients)
    if (implausible) return { ok: false, message: implausible }
    const query = new URLSearchParams({
      heater_gain: coefficients.heaterGainCPerMinAt10.toFixed(3),
      fan_cooling: coefficients.fanCoolingCPerMinAt10.toFixed(3),
      cooling_fan: coefficients.coolingFanCPerMinAt10.toFixed(3),
      loss_per_min: coefficients.thermalLossPerMinPerC.toFixed(4),
      fit_id: sanitizeFitId(fitId),
      confirm: APPLY_CALIBRATION_CONFIRM,
    })
    return this.applyRequest(query)
  }

  /** Clear the device's applied set, leaving it with none. */
  async clearDeviceCalibration(): Promise<CommandResult> {
    const gate = this.restoreMaintenanceToken ? undefined : modelBlocked('apply-calibration')
    if (gate) return { ok: false, message: gate }
    return this.applyRequest(new URLSearchParams({ clear: 'true', confirm: APPLY_CALIBRATION_CONFIRM }))
  }

  private async applyRequest(query: URLSearchParams): Promise<CommandResult> {
    const gate = this.restoreMaintenanceToken ? undefined : mutationBlocked()
    if (gate) return { ok: false, message: gate }
    if (this.restoreMaintenanceToken) query.set('restore_token', this.restoreMaintenanceToken)
    try {
      const response = await fetch(this.endpoint(`${CALIBRATION_APPLY_URL}?${query.toString()}`), {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
      })
      if (response.status === 401) return { ok: false, message: 'Sign in required' }
      if (response.status === 409)
        return { ok: false, message: 'The roaster is running. Coefficients can only be applied while it is idle.' }
      const body = record(await response.json().catch(() => undefined))
      if (!response.ok)
        return {
          ok: false,
          message: text(body?.message) ?? `The roaster refused the request (HTTP ${response.status})`,
        }
      return { ok: true, message: 'The roaster stored the coefficients', stateRev: stateRevision(body?.state_rev) }
    } catch {
      return { ok: false, message: 'The roaster is not connected' }
    }
  }

  /*
   * ==========================================================================================
   * THE DOCUMENT STORE
   * ==========================================================================================
   *
   * Four calls, each of which maps ONE firmware answer onto ONE outcome the data layer knows how to
   * act on. The mapping is the whole value of this section, because the codes are not
   * interchangeable and treating them as "failed" would break the feature:
   *
   *   - `409` WITH `conflict: true` is a version conflict. The data layer may refetch, replay
   *     once, and retry against the new base.
   *   - `409` WITHOUT it is the idle gate. Ordinary acknowledged mutations remain uncommitted and
   *     ask the user to retry after current actuation or recording rather than firing later.
   *   - `503` is an unmounted volume, `413`/`507` are capacity, and a thrown request is an
   *     unreachable controller. All fail closed at this transport boundary.
   *
   * A successful document GET returns the payload as its BODY, not as JSON with a wrapper, and the
   * version arrives in `X-Doc-Version`. A missing header reads as version 0, which is also what a
   * corrupted envelope reports - and 0 is precisely the base a create uses, so recovery needs no
   * special case.
   */
  private static version(response: Response) {
    return finite(Number(response.headers.get('X-Doc-Version'))) ?? 0
  }

  async readManifestPage(cursor?: string): Promise<ManifestRead> {
    try {
      const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : ''
      const response = await this.get(`${DEVICE_MANIFEST_URL}${query}`, DOCUMENT_TIMEOUT_MS)

      if (response.status === 503) return { kind: 'unmounted' }
      if (response.status === 409) {
        const errorBody = record(await response.json().catch(() => undefined))
        if (errorBody?.code === 'bulk_response_suspended') {
          return {
            kind: 'error',
            message: text(errorBody.error) ?? 'Bulk data waits for the current actuation or recording to finish.',
          }
        }
      }
      if (!response.ok) return { kind: 'error', message: `The roaster refused the manifest (HTTP ${response.status})` }
      const body = record(await response.json())
      const stateRev = stateRevision(body?.state_rev)
      const sourceCollections = record(body?.collections)
      if (!body || !stateRev || !sourceCollections || !Array.isArray(body.runs) || !Array.isArray(body.logs)) {
        return { kind: 'error', message: 'The roaster sent an invalid revisioned manifest' }
      }
      const collections: Partial<Record<CollectionName, { bytes: number; version: number } | null>> = {}
      for (const name of COLLECTIONS) {
        if (!Object.hasOwn(sourceCollections, name)) {
          return { kind: 'error', message: `The manifest omitted the ${name} collection` }
        }
        const value = sourceCollections[name]
        if (value === null) {
          collections[name] = null
          continue
        }
        const entry = record(value)
        const bytes = finite(entry?.bytes)
        const version = finite(entry?.version)
        if (
          bytes === undefined ||
          version === undefined ||
          !Number.isInteger(bytes) ||
          !Number.isInteger(version) ||
          bytes < 0 ||
          version < 0
        ) {
          return { kind: 'error', message: `The manifest has an invalid ${name} entry` }
        }
        collections[name] = { bytes, version }
      }
      const runs = body.runs.flatMap((value) => {
        const entry = record(value)
        const id = identifierText(entry?.id)
        const bytes = finite(entry?.bytes)
        const version = finite(entry?.version)
        return id !== undefined &&
          bytes !== undefined &&
          version !== undefined &&
          Number.isInteger(bytes) &&
          Number.isInteger(version) &&
          bytes >= 0 &&
          version >= 0
          ? [{ id, bytes, version }]
          : []
      })
      const logs = body.logs.flatMap((value) => {
        const entry = record(value)
        const id = identifierText(entry?.id)
        const bytes = finite(entry?.bytes)
        return id !== undefined && bytes !== undefined && Number.isInteger(bytes) && bytes >= 0 ? [{ id, bytes }] : []
      })
      if (runs.length !== body.runs.length || logs.length !== body.logs.length) {
        return { kind: 'error', message: 'The manifest contains an invalid run or recording entry' }
      }
      const restoreMaintenance = record(body.restore_maintenance)
      const maintenance =
        restoreMaintenance?.incomplete === true
          ? 'incomplete'
          : restoreMaintenance?.active === true
            ? 'restoring'
            : body.maintenance === 'restoring' || body.maintenance === 'incomplete'
              ? body.maintenance
              : undefined
      return {
        kind: 'ok',
        page: {
          stateRev,
          bootId: identifierText(body.boot_id),
          collections,
          runs,
          logs,
          nextCursor: text(body.next_cursor),
          maintenance,
        },
      }
    } catch {
      return { kind: 'unreachable' }
    }
  }

  /** Read data only when one stable controller revision brackets the complete operation. */
  async withRevisionFence<T>(reader: () => Promise<T>): Promise<T> {
    const before = await this.readManifestPage()
    if (before.kind !== 'ok')
      throw new Error('The roaster manifest is unavailable, so an authoritative snapshot cannot be created.')
    if (before.page.maintenance) throw new Error('The roaster library is in restore maintenance mode.')
    const value = await reader()
    const after = await this.readManifestPage()
    if (
      after.kind !== 'ok' ||
      after.page.maintenance ||
      after.page.stateRev !== before.page.stateRev ||
      after.page.bootId !== before.page.bootId
    ) {
      throw new Error('The roaster library changed while it was being read. Try the operation again.')
    }
    return value
  }

  private async restoreMaintenanceRequest(
    path: string,
    token?: string,
    confirm?: string,
  ): Promise<RestoreMaintenanceResult> {
    try {
      const params = new URLSearchParams()
      if (token) params.set('restore_token', token)
      if (confirm) params.set('confirm', confirm)
      const encoded = params.toString()
      const query = encoded ? `?${encoded}` : ''
      const response = await fetch(this.endpoint(`${path}${query}`), {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
      })
      const body = record(await response.json().catch(() => undefined))
      return {
        ok: response.ok && body?.ok !== false,
        token: text(body?.restore_token),
        stateRev: stateRevision(body?.state_rev),
        message: text(body?.message) ?? (response.ok ? undefined : `HTTP ${response.status}`),
        incomplete: body?.incomplete === true || body?.maintenance === 'incomplete',
      }
    } catch {
      return { ok: false, message: 'The roaster is not connected' }
    }
  }

  async beginRestoreMaintenance(): Promise<RestoreMaintenanceResult> {
    const result = await this.restoreMaintenanceRequest(RESTORE_MAINTENANCE_BEGIN_URL, undefined, 'BEGIN_RESTORE')
    if (result.ok && result.token) this.restoreMaintenanceToken = result.token
    return result
  }

  async commitRestoreMaintenance(token = this.restoreMaintenanceToken): Promise<RestoreMaintenanceResult> {
    if (!token) return { ok: false, message: 'The restore maintenance token is missing' }
    const result = await this.restoreMaintenanceRequest(RESTORE_MAINTENANCE_COMMIT_URL, token)
    if (result.ok) this.restoreMaintenanceToken = undefined
    return result
  }

  async abortRestoreMaintenance(token = this.restoreMaintenanceToken): Promise<RestoreMaintenanceResult> {
    if (!token) return { ok: false, message: 'The restore maintenance token is missing' }
    const result = await this.restoreMaintenanceRequest(RESTORE_MAINTENANCE_ABORT_URL, token)
    if (result.ok) this.restoreMaintenanceToken = undefined
    return result
  }

  async readDocument(target: DocumentTarget): Promise<DocumentRead> {
    try {
      const response = await this.get(`${DEVICE_DATA_PREFIX}${target}`, DOCUMENT_TIMEOUT_MS)
      if (response.ok)
        return { kind: 'ok', payload: await response.text(), version: HttpControllerClient.version(response) }
      if (response.status === 404) return { kind: 'missing' }
      if (response.status === 503) return { kind: 'unmounted' }
      if (response.status === 409) {
        const body = record(await response.json().catch(() => undefined))
        if (body?.code === 'bulk_response_suspended') {
          return {
            kind: 'error',
            message: text(body.error) ?? 'Bulk data waits for the current actuation or recording to finish.',
          }
        }
      }
      // An envelope that will not decode reads as version 0, so a `base=0` write overwrites it.
      if (response.status === 500) {
        const body = record(await response.json().catch(() => undefined))
        const message = text(body?.error) ?? text(body?.message)
        // Only the firmware's explicit unreadable-envelope contract authorizes base-zero recovery.
        if (
          response.headers.get('X-Doc-Version') === '0' &&
          message?.toLowerCase().includes('stored document is unreadable')
        ) {
          return { kind: 'corrupt', version: 0 }
        }
        return { kind: 'error', message: message ?? 'The roaster could not read this document (HTTP 500)' }
      }
      return { kind: 'error', message: `The roaster refused the read (HTTP ${response.status})` }
    } catch {
      return { kind: 'unreachable' }
    }
  }

  async writeDocument(target: DocumentTarget, payload: string, base: number): Promise<DocumentWrite> {
    const gate = this.restoreMaintenanceToken ? undefined : mutationBlocked()
    if (gate) return { kind: 'error', message: gate }
    try {
      const query = new URLSearchParams({ base: String(Math.max(0, Math.trunc(base))) })
      if (this.restoreMaintenanceToken) query.set('restore_token', this.restoreMaintenanceToken)
      const response = await this.storageFetch(
        `${DEVICE_DATA_PREFIX}${target}?${query.toString()}`,
        {
          method: 'POST',
          // The native storage worker receives one size-capped JSON document body.
          headers: { 'content-type': 'application/json' },
          body: payload,
        },
        DOCUMENT_TIMEOUT_MS,
      )
      const body = record(await response.json().catch(() => undefined))
      if (response.ok)
        return { kind: 'ok', version: finite(body?.version) ?? base + 1, stateRev: stateRevision(body?.state_rev) }
      if (response.status === 409) {
        return body?.conflict === true
          ? { kind: 'conflict', version: finite(body?.version) ?? 0, stateRev: stateRevision(body?.state_rev) }
          : { kind: 'busy', message: text(body?.message) }
      }
      if (response.status === 413) return { kind: 'too-large', message: text(body?.message) }
      if (response.status === 507) return { kind: 'no-space', message: text(body?.message) }
      if (response.status === 503) {
        return response.headers.has('Retry-After')
          ? { kind: 'busy', message: text(body?.message) }
          : { kind: 'unmounted' }
      }
      return {
        kind: 'error',
        message: text(body?.message) ?? `The roaster refused the write (HTTP ${response.status})`,
      }
    } catch {
      // The device commits a document before sending its acknowledgement. A
      // dropped ACK is therefore ambiguous until the authoritative document is
      // read back; never tell the user that a committed edit was not received.
      const reconciled = await this.readDocument(target)
      if (reconciled.kind === 'ok') {
        if (reconciled.version > base && reconciled.payload === payload) {
          return { kind: 'ok', version: reconciled.version }
        }
        if (reconciled.version > base) {
          return { kind: 'conflict', version: reconciled.version }
        }
        return {
          kind: 'error',
          message:
            'The connection ended before the roaster acknowledged this change. Its previous copy is still stored; try again.',
        }
      }
      if (reconciled.kind === 'error' && reconciled.message?.toLowerCase().includes('bulk data waits')) {
        return { kind: 'busy', message: reconciled.message }
      }
      return { kind: 'unreachable' }
    }
  }

  async listRunDocuments(): Promise<RunIndexRead> {
    try {
      const response = await this.get(`${DEVICE_DATA_PREFIX}runs`, DOCUMENT_TIMEOUT_MS)
      if (response.status === 503) return { kind: 'unmounted' }
      if (response.status === 409) {
        const errorBody = record(await response.json().catch(() => undefined))
        if (errorBody?.code === 'bulk_response_suspended') {
          return {
            kind: 'error',
            message: text(errorBody.error) ?? 'Bulk data waits for the current actuation or recording to finish.',
          }
        }
      }
      if (!response.ok) return { kind: 'error', message: `The roaster refused the run index (HTTP ${response.status})` }
      const body = record(await response.json())
      const runs = Array.isArray(body?.runs) ? body.runs : []
      const parsedRuns = runs.flatMap((entry) => {
        const row = record(entry)
        const id = text(row?.id)
        return id === undefined ? [] : [{ id, bytes: finite(row?.bytes) ?? 0, version: finite(row?.version) ?? 0 }]
      })
      return {
        kind: 'ok',
        runs: parsedRuns,
        total: Math.max(parsedRuns.length, Math.trunc(finite(body?.total) ?? parsedRuns.length)),
        // Firmware before this field existed silently stopped at 400. Exactly 400 is therefore
        // incomplete-until-proven-otherwise, while newer firmware can explicitly say false.
        truncated: body?.truncated === true || (body?.truncated !== false && runs.length >= 400),
      }
    } catch {
      return { kind: 'unreachable' }
    }
  }

  /** Deleting is a flash write, so it answers the same idle gate a save does. */
  async deleteDocument(target: DocumentTarget, base: number): Promise<DocumentWrite> {
    const gate = this.restoreMaintenanceToken ? undefined : mutationBlocked()
    if (gate) return { kind: 'error', message: gate }
    try {
      const query = new URLSearchParams({ target, confirm: DELETE_DATA_CONFIRM, base: String(base) })
      if (this.restoreMaintenanceToken) query.set('restore_token', this.restoreMaintenanceToken)
      const response = await this.storageFetch(
        `${DEVICE_DATA_DELETE_URL}?${query.toString()}`,
        { method: 'POST' },
        DOCUMENT_TIMEOUT_MS,
      )
      const body = record(await response.json().catch(() => undefined))
      // Nothing stored there is the state a delete was asking for, so it is a success.
      if (response.ok || response.status === 404)
        return { kind: 'ok', version: 0, stateRev: stateRevision(body?.state_rev) }
      if (response.status === 409) {
        return body?.conflict === true
          ? { kind: 'conflict', version: finite(body?.version) ?? 0, stateRev: stateRevision(body?.state_rev) }
          : { kind: 'busy', message: text(body?.message) }
      }
      if (response.status === 503) {
        return response.headers.has('Retry-After')
          ? { kind: 'busy', message: text(body?.message) }
          : { kind: 'unmounted' }
      }
      return {
        kind: 'error',
        message: text(body?.message) ?? `The roaster refused the delete (HTTP ${response.status})`,
      }
    } catch {
      return { kind: 'unreachable' }
    }
  }

  /** Vite mock only. The action is never surfaced for a physical controller. */
  async powerCycleMock(): Promise<string> {
    const result = await this.command(DEV_POWER_CYCLE_URL)
    if (!result.ok) throw new Error(result.message ?? 'The simulated roaster refused the power cycle')
    return result.message ?? 'Mock roaster power-cycled; device-stored data was preserved.'
  }

  /** Vite mock only. Simulates a probe dropout so holdover and recovery remain observable. */
  async setMockProbeAvailable(available: boolean): Promise<string> {
    const result = await this.command(`${DEV_PROBE_URL}?available=${available ? 'true' : 'false'}`)
    if (!result.ok) throw new Error(result.message ?? 'The simulated roaster refused the probe change')
    return result.message ?? `Mock probe ${available ? 'reconnected' : 'disconnected'}.`
  }

  /**
   * Vite mock only. Drops every attached live WebSocket so this browser's stream reconnects - the
   * phone-lock discontinuity, on demand - and the trace resync can be watched filling the hole.
   */
  async dropMockLiveStream(): Promise<string> {
    const result = await this.command(DEV_LIVE_DROP_URL)
    if (!result.ok) throw new Error(result.message ?? 'The simulated roaster refused to drop the live stream')
    return result.message ?? 'Mock live stream dropped; browsers reconnect on their own.'
  }

  async fetchThermalCsv(): Promise<string> {
    const response = await this.get(THERMAL_CSV_URL, 60000)
    if (response.status === 401) throw new Error('Sign in required')
    if (response.status === 409) throw new Error(THERMAL_CSV_BUSY)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.text()
  }
}

/** An accepted Start reconstructed from status after its acknowledgement was lost. */
const startFromStatus = (status: ControllerStatus): CommandResult => ({
  ok: true,
  stateRev: status.stateRev,
  planRev: status.roast?.planRev,
  elapsedSec: status.roast?.elapsedSec,
  startedEpoch: status.roast?.startedEpoch,
  bootId: status.bootId !== 'unknown' ? status.bootId : undefined,
  name: status.roast?.name,
  sessionId: status.roast?.sessionId,
  ...(status.thermalLog?.source === 'roast' && status.thermalLog.logId ? { logId: status.thermalLog.logId } : {}),
})

const commandResult = (body: Record<string, unknown> | undefined, message = text(body?.message)): CommandResult => ({
  ok: true,
  message,
  stateRev: stateRevision(body?.state_rev),
  planRev: sequenceNumber(body?.plan_rev),
  thermocoupleOffsetC: finite(body?.thermocouple_offset_c),
  elapsedSec: finite(body?.elapsed_sec),
  requestedFan: finite(body?.accepted_fan) ?? finite(body?.fan_level) ?? finite(body?.requested_fan),
  requestedHeat: finite(body?.accepted_heat) ?? finite(body?.heat_level) ?? finite(body?.requested_heat),
  effectiveFan: finite(body?.effective_fan),
  effectiveHeat: finite(body?.effective_heat),
  startedEpoch: finite(body?.started_epoch),
  bootId: finite(body?.boot) === undefined ? text(body?.boot) : String(finite(body?.boot)),
  name: text(body?.name),
  sessionId: sessionText(body?.session_id),
  logId: identifierText(body?.log_id),
  wasActive: typeof body?.was_active === 'boolean' ? body.was_active : undefined,
  endReason: sentinel(body?.end_reason, ROAST_END_REASON_VALUES),
})
