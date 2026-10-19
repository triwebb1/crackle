export type AppView = 'roast' | 'profiles' | 'reference' | 'beans' | 'manual' | 'calibrate' | 'history' | 'settings'

export type ControllerLifecycle = 'DISCONNECTED' | 'STANDBY' | 'READY' | 'RUNNING' | 'FAULT' | 'MANUAL_LOCKOUT'

export type RoastPhase = 'READY' | 'DRYING' | 'MAILLARD' | 'DEVELOPMENT' | 'COOLING' | 'COMPLETE' | 'ABORTED'

/** Immutable provenance captured with an observation. */
export interface RecordedOn {
  deviceId: string
  modelId: string
  displayNameAtCapture: string
  simulated: boolean
  firmwareVersion: string
  identitySource: 'roaster' | 'configured-legacy'
  simulatesModelId?: string
}

/** Immutable identity of the machine and local sequence that produced a recording. */
export interface RecordingOrigin {
  deviceId: string
  logId: string
}

/** Where recording bytes are currently addressable; it may differ after a foreign restore. */
export interface RecordingStorageAddress {
  deviceId: string
  logId: string
}
/**
 * What a profile carries about itself. Batch mass is NOT here: mass belongs to the roast that was
 * actually run, not to the recipe, so it is entered in the roast setup. There are no explicit bean
 * links for the same reason - which beans a profile suits is derived from the roast archive. Both
 * legacy fields are dropped by `normalizeProfile` on read.
 */
export interface ProfileMetadata {
  intent: string
}

export interface BeanLot {
  id: string
  name: string
  origins: string[]
  lotId?: string
  species?: string
  cultivars: string[]
  process?: string
  greenDensityGPerMl?: number
  moisturePercent?: number
  notes: string
  createdAt: string
  updatedAt: string
}

export interface TimedPoint {
  id: string
  timeSec: number
  fan: number
  heat: number
}

export interface ThermalSegment {
  id: string
  startC: number
  endC: number
  durationSec: number
  fanMin: number
  fanMax: number
  heatMin: number
  heatMax: number
}

interface ProfileBase {
  id: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
  metadata: ProfileMetadata
  notes: string
}

export interface TimedProfile extends ProfileBase {
  strategy: 'timed'
  points: TimedPoint[]
  coolFan: number
  coolDurationSec: number
}

export interface ThermalIntent extends ProfileBase {
  strategy: 'thermal-intent'
  segments: ThermalSegment[]
  calibrationStatus: 'unavailable' | 'experimental' | 'validated'
}

export type Profile = TimedProfile | ThermalIntent

/**
 * One entry of a catalog's edit history. Written on every save that actually changed something, so
 * the history is a record of edits rather than of button presses. The full record is kept, not only
 * the summary, so a revision remains restorable later without a second migration.
 */
export interface ProfileRevision {
  id: string
  profileId: string
  revision: number
  savedAt: string
  /** "Heat step 3: 5.0->6.5; zone 2 duration 2:00->2:30; notes edited". */
  summary: string
  profile: Profile
}

export interface BeanRevision {
  id: string
  beanId: string
  savedAt: string
  summary: string
  bean: BeanLot
}

export interface BatchMeasurements {
  startingMassG?: number
  startingVolumeMl?: number
  finalMassG?: number
  finalVolumeMl?: number
  moisturePercent?: number
  ambientC?: number
}

/**
 * What the in-roast feedback layer had to add to the model's own answer, for one sample.
 *
 * This is a MEASUREMENT, not a setting. The feed-forward inversion says what the current
 * calibration thinks the plan needs; the correction is what the roaster actually needed on top of
 * that, in the same units the plan is written in (°C/min of rate of rise). A correction that sits at
 * a non-zero average for minutes at a time is the model's bias, measured under load, and it is the
 * input the post-roast refit wants - see `domain/controlResidual.ts`.
 */
export interface ControlCorrection {
  /** Nominal target minus measured, in C. Positive means the roast is behind the plan. */
  errorC: number
  proportionalRatePerMin: number
  integralRatePerMin: number
  /** The correction actually applied: P plus I, after the authority clamp. */
  totalRatePerMin: number
  /** The plant had no room left in the direction the correction was pushing; the integral froze. */
  saturated: boolean
  /** No usable measurement, so the step ran feed-forward only and the integral was left untouched. */
  holdover: boolean
}

export interface TelemetrySample {
  elapsedSec: number
  beanTempC: number
  rorCPerMin: number
  requestedFan: number
  effectiveFan: number
  requestedHeat: number
  effectiveHeat: number
  phase: RoastPhase
  /**
   * Optional, and absent on every run recorded before the feedback layer existed. Normalization
   * passes archived samples through untouched, so an old run simply has no correction series and
   * the summary declines to score it rather than inventing zeroes.
   */
  correction?: ControlCorrection
}

export type RoastEventType = 'DRY_END' | 'FIRST_CRACK' | 'DROP' | 'OVERRIDE' | 'ABORT' | 'SAFETY' | 'SYSTEM'

export interface RoastEvent {
  id: string
  elapsedSec: number
  type: RoastEventType
  label: string
  detail?: string
}

/**
 * What a run reconstructed from a controller-executed roast knows about its origin.
 *
 * The device is the thing that ran the roast, so its log id is the run's identity: an import is
 * keyed on it and is therefore idempotent by construction. Everything else here is a fact the
 * controller recorded that cannot be recovered from the temperature series - the name it ran under,
 * where each zone boundary actually fell, and whether its clock knew what day it was.
 */
export interface DeviceRoastOrigin {
  /** Globally stable producer identity. This, not the current storage address, is the import key. */
  recordingOrigin: RecordingOrigin
  /** The roaster and local id currently used to fetch/delete the bytes. */
  storageAddress: RecordingStorageAddress
  /** The sanitized name the controller ran under, byte-identical to what was sent. */
  name: string
  /** Which power cycle of the controller produced it. */
  bootId?: string
  /**
   * True when the controller clock had never synced, so `startedAt` is the moment of IMPORT rather
   * than a reading. Never 1970: an epoch of 0 means "date unknown", and saying so is the only
   * honest option a log with no clock leaves.
   */
  dateUnknown: boolean
  /** Per zone, the elapsed second its endpoint was attained. `null` means it never was. */
  zoneAttainedSec?: Array<number | null>
  /** False when no unique profile matched by name, so the user links it from History. */
  profileLinked: boolean
  /**
   * Codec-2's immutable, device-owned starting instructions. Unlike a catalog link, this survives
   * the source profile being renamed, edited, or deleted after the roast.
   */
  initialPlan?: ArchivedRoastPlan
  /** Every journey-plan edit the controller accepted, in acceptance order. */
  planJournal?: ArchivedPlanChange[]
  /** The same provenance in codec-2's bounded binary envelope, base64 for compact run storage. */
  planEnvelope?: string
}

export interface ArchivedTimedStep {
  fan: number
  heat: number
  durationSec: number
}

export interface ArchivedJourneyZone {
  startC: number
  endC: number
  durationSec: number
  fanMin: number
  fanMax: number
  heatMin: number
  heatMax: number
}

export interface ArchivedCalibrationProgram {
  mode: 'calibration'
  steps: ArchivedTimedStep[]
  maxStepSeconds: number
  minStepSeconds: number
  settleSeconds: number
  settleBandC: number
}

export type ArchivedRoastPlan =
  | { mode: 'timed'; steps: ArchivedTimedStep[] }
  | { mode: 'journey'; zones: ArchivedJourneyZone[] }
  | { mode: 'manual'; fan: number; heat: number }

export type ArchivedPlanChange =
  | { elapsedSec: number; planRev: number; stepIndex: number; step: ArchivedTimedStep }
  | { elapsedSec: number; planRev: number; zones: ArchivedJourneyZone[] }
  | {
      elapsedSec: number
      planRev: number
      requestedFan: number
      requestedHeat: number
      effectiveFan: number
      effectiveHeat: number
    }

export interface RoastRun {
  id: string
  name: string
  startedAt: string
  completedAt?: string
  profile: Profile
  beanLotId?: string
  beanLotSnapshot?: BeanLot
  notes: string
  /** How much the user liked this bean and roast, 1-10. See `domain/roastScore.ts`. */
  score?: number
  controllerVersion: string
  /** Correction already applied to every recorded thermocouple sample. */
  thermocoupleOffsetC?: number
  /** The roaster that produced this observation, fixed when the run was accepted. */
  recordedOn: RecordedOn
  measurements?: BatchMeasurements
  outcome: 'complete' | 'aborted' | 'running'
  samples: TelemetrySample[]
  events: RoastEvent[]
  /** Present when this roast was steered directly rather than executed from a saved profile. */
  manualRoast?: ManualRoastOrigin
  /** Present only on a run imported from the controller's own archive. */
  deviceRoast?: DeviceRoastOrigin
  /**
   * Present while the roaster is executing (or was commanded to execute) this roast. The record was
   * staged in the roaster's document store at Start with everything the setup form collected; the
   * archive reconciliation completes it in place from the device recording and removes this marker.
   * `bootId` is the controller boot the Start command was accepted under, kept as a last-resort
   * join for a recording whose device clock never synced.
   */
  deviceRoastPending?: { bootId?: string }
}

export interface ControllerCapabilities {
  apiVersion: string
  autonomousTimedPrograms: boolean
  thermalExecution: boolean
  diagnosticTests: boolean
  /** Explicit first-class `/api/roast/*?mode=manual` advertisement on firmware 2026-07-26.40 and newer. */
  manualRoast?: boolean
}

// Firmware 2026-07-26.34 and later have no program ceiling and no `limited` advance: a step ends only
// by settling or by reaching its cap. Overtemperature is a latched actuator fault, not a step outcome.
export type StepAdvance = 'settled' | 'capped'
export type CalibrationEndReason =
  | 'completed'
  | 'stopped'
  | 'fault'
  | 'telemetry_stale'
  | 'qualification_stalled'
  | 'step_rejected'
  | 'renewal_rejected'
  | 'heat_lease_expired'

// Diagnostic calibration program state, reported by firmware 2026-07-26.34.
// It omits `ceiling_c`, `advance_margin_c`, and `skipped_steps`, which belonged to the program ceiling.
export interface CalibrationProgramStatus {
  active: boolean
  /** Device clock at program start; absent when the roaster clock was not synchronized. */
  startedEpoch?: number
  stepIndex?: number
  stepCount?: number
  currentFanLevel?: number
  currentHeatLevel?: number
  maxStepSeconds?: number
  minStepSeconds?: number
  settleSeconds?: number
  settleBandC?: number
  lastStepAdvance?: StepAdvance
  /** Reserved device recording identity for this exact pass. */
  logId?: string
  completedEpoch?: number
  stepElapsedSec?: number
  settleState?: 'minimum_dwell' | 'waiting_for_transition' | 'settled' | 'checking' | 'capped'
  completedSteps?: Array<{
    index?: number
    fan?: number
    heat?: number
    elapsedSec?: number
    temperatureC?: number
    outcome?: string
  }>
  leaseRenewals?: number
  endReason?: CalibrationEndReason
}

export interface ThermalLogStatus {
  /** False means recording memory is unavailable; actuation and Stop remain usable. */
  available?: boolean
  active: boolean
  samples?: number
  capacity?: number
  intervalMs?: number
  logId?: string
  download?: string
  /** What is being recorded. Manual sessions auto-log on firmware 2026-07-26.38 and later; roasts on 2026-07-26.39 and later. */
  source?: 'proof' | 'calibration' | 'manual' | 'roast' | 'none'
  /** True while the log is still only in RAM. Not a fault - flash writes wait for idle. */
  unsaved?: boolean
}

/**
 * Why a manual run ended. "none" is the idle sentinel and is parsed away like every other one, so an
 * absent reason reads as undefined rather than as a string.
 *
 * `instruction_expired` is the 30-minute instruction lease: an instruction is good for at most half
 * an hour, any new command resets that clock, and nothing about a browser being open enters into it.
 * It replaced the client keepalive, whose safeguard lived in a web page rather than in the firmware.
 */
export type ManualEndReason =
  | 'stopped'
  | 'telemetry_stale'
  | 'renewal_rejected'
  | 'fault'
  | 'instruction_expired'
  | 'heat_lease_expired'

// Indefinite manual fan/heat, reported by firmware 2026-07-26.36. `sinceMs` is time at the CURRENT
// applied levels, so re-applying new levels restarts it while the run itself continues.
export interface ManualStatus {
  active: boolean
  fanLevel?: number
  heatLevel?: number
  sinceMs?: number
  endReason?: ManualEndReason
  /**
   * Age of the instruction currently in force, and the 30-minute lease it runs under. Both absent on
   * firmware that predates the lease; nothing about them is a liveness obligation on this browser.
   */
  instructionAgeMs?: number
  instructionLimitMs?: number
}

/**
 * Why a device-resident roast program ended, exhaustively, from the firmware's own table. `none`
 * means running or never started since boot and is parsed away like every other idle sentinel.
 */
export type RoastEndReason =
  | 'completed'
  | 'stopped'
  | 'fault'
  | 'telemetry_stale'
  | 'sensor_lost'
  | 'qualification_stalled'
  | 'step_rejected'
  | 'renewal_rejected'
  | 'command_rejected'
  | 'envelope_timeout'
  | 'instruction_expired'
  | 'heat_lease_expired'

export type RoastProgramMode = 'none' | 'timed' | 'journey' | 'manual'

/**
 * The `roast` object from `GET /api/status`, present running or not.
 *
 * Its PRESENCE is the feature detection for the on-device roast executor, exactly as `log_archive`
 * is for the archive: firmware without the executor omits the key, and no amount of probing
 * `/api/roast/start` would change that. While `active` is true this block is the SINGLE SOURCE OF
 * TRUTH for what the roast is doing - the browser's own `liveJourney` fold is a display-only
 * fallback for when the device is not executing.
 */
export interface RoastProgramStatus {
  active: boolean
  mode: RoastProgramMode
  /** Revision of the device-resident active plan; separate from persistent catalog state. */
  planRev?: number
  name?: string
  elapsedSec?: number
  /** Device-issued identity for atomic control of this exact roast session. */
  sessionId?: string
  /** SNTP Unix seconds at start; absent when the clock had never synced (the firmware sends 0). */
  startedEpoch?: number
  stepIndex?: number
  /** Elapsed dwell in the current timed step; excludes fan-qualification time. */
  stepElapsedSec?: number
  stepCount?: number
  zoneIndex?: number
  zoneCount?: number
  /** Elapsed seconds at which the roast actually ENTERED the current zone. */
  zoneEntrySec?: number
  zoneElapsedSec?: number
  /** The current zone's authored duration. Compare with `zoneElapsedSec` to read overrun. */
  zoneNominalSec?: number
  zoneEndC?: number
  /** The anchored in-zone target the PI is holding right now. Absent in timed mode. */
  targetC?: number
  commandedFan?: number
  commandedHeat?: number
  /** What the control law solved before level quantization. */
  solvedFan?: number
  solvedHeat?: number
  /** The applied PI correction, °C/min of wanted rate, clamped to +/-15. */
  correctionTotal?: number
  /** The integral term, °C/min, clamped to +/-8. This is the model bias a refit consumes. */
  integral?: number
  saturated: boolean
  /** This tick ran feed-forward on a missing or stale reading. */
  holdover: boolean
  holdoverMs?: number
  holdoverLimitMs?: number
  /** The frozen ambient the plan is being solved against. */
  ambientC?: number
  batchMassG?: number
  leaseRenewals?: number
  /** Manual roast only: age and device-owned limit of the current operator instruction. */
  instructionAgeMs?: number
  instructionLimitMs?: number
  /** Per zone, the elapsed second its endpoint was attained, or null. Length `zoneCount`. */
  zoneAttainedSec?: Array<number | null>
  endReason?: RoastEndReason
}

// One row of the local manual history. `source` records whether Crackle issued the command itself
// or inferred it from a firmware state transition seen in the status poll.
export interface ManualEvent {
  id: string
  atMs: number
  kind: 'apply' | 'stop'
  fan: number
  heat: number
  temperatureC?: number
  source: 'local' | 'firmware'
  detail?: string
  recordedOn: RecordedOn
}

/**
 * One accepted instruction within a manual roast.
 *
 * Requested and effective levels are both facts. The requested pair is what can become a timed
 * profile later; the effective pair is what the safety floors and actuator protocol actually ran.
 * Imported legacy manual recordings know only the latter and copy it into both pairs rather than
 * inventing an instruction the controller never stored.
 */
export interface ManualRoastChange {
  id: string
  elapsedSec: number
  requestedFan: number
  requestedHeat: number
  effectiveFan: number
  effectiveHeat: number
  temperatureC?: number
  source: 'local' | 'firmware'
}

/** Durable, per-roast manual history. The global ManualEvent log remains an operating log. */
export interface ManualRoastOrigin {
  changes: ManualRoastChange[]
  stoppedElapsedSec?: number
  endReason?: RoastEndReason
  /** Controller session identity used to prevent a stale browser steering a later roast. */
  deviceBootId?: string
  deviceName?: string
  deviceSessionId?: string
  deviceStartedEpoch?: number
  /** True when this browser joined late and the archive has not filled the missing instruction path. */
  incomplete?: boolean
  /**
   * Exact device identity reserved when recording starts. This is transient reconciliation state;
   * the imported archive replaces it with deviceRoast and the compound logId completion marker.
   */
  pendingRecording?: {
    recordingOrigin: RecordingOrigin
    storageAddress: RecordingStorageAddress
  }
  /** The controller recording that carries this roast's thermal series, when one has been imported. */
  logId?: string
}

export interface RoasterIdentity {
  /** Stable across reboots; never the boot counter. */
  deviceId: string
  /** Stable model key used to resolve model-specific constraints. */
  modelId: string
  displayName: string
  simulated: boolean
  /** Present for a simulator that intentionally implements another model's public contract. */
  simulatesModelId?: string
}

export interface ControllerStatus {
  lifecycle: ControllerLifecycle
  connected: boolean
  stale: boolean
  receivedAtMs: number
  firmwareVersion: string
  bootId: string
  /** Controller-declared identity. Absence means an older or unknown controller, never SR800. */
  roaster?: RoasterIdentity
  /** Persistent uint64 device-state head, represented as text without precision loss. */
  stateRev?: string
  /** Last controller-mailbox request completed on this boot, for lost-ack reconciliation. */
  lastRequestId?: number
  lastRequestStatus?: number
  restoreMaintenance?: { active: boolean; incomplete: boolean; expiresInMs?: number }
  /** Device-owned correction already applied to reported thermocouple temperature. */
  thermocoupleOffsetC?: number
  /** Explicit readiness is absent on older firmware and only blocks Start when reported false. */
  calibrationReady?: boolean
  calibrationReadiness?: 'ready' | 'sensor_invalid' | 'sensor_fault_latched' | 'too_hot' | 'stabilizing'
  calibrationStableForMs?: number
  activeRunId?: string
  loadedProfileHash?: string
  fault?: string
  /** The firmware's overheat limit (`kOvertempDisableC`), reported so messages quote the built value. */
  overtempLimitC?: number
  /** Time left in an overtemperature cooldown, while one is running. */
  overtempCooldownRemainingMs?: number
  /** Boot/runtime diagnostics are observations only; they never gate control. */
  system?: {
    resetReason?: string
    uptimeMs?: number
    freeHeapBytes?: number
    minimumFreeHeapBytes?: number
    largestFreeHeapBlockBytes?: number
    freePsramBytes?: number
    minimumFreePsramBytes?: number
    largestFreePsramBlockBytes?: number
    lastLoopGapMs?: number
    maximumLoopGapMs?: number
    lastArchivePersistMs?: number
    maximumArchivePersistMs?: number
    archivePersistCount?: number
    /** Reset reasons of recent boots, newest first, persisted by the roaster across power cycles. */
    bootHistory?: { boot: number; resetReason: string }[]
    /** The last crash held in the roaster's core-dump partition; its addresses decode against `elfSha256`. */
    /** `currentBuild` is false for a crash of an earlier firmware build; undefined before firmware 2026-07-26.116. */
    storedCrash?: {
      task: string
      pc: string
      backtrace: string[]
      corrupted: boolean
      elfSha256: string
      currentBuild?: boolean
    }
    /** The firmware's own sampled PSRAM low-water and the uptime it occurred at (firmware 2026-07-26.116+). */
    psramLowWaterBytes?: number
    psramLowWaterAtMs?: number
    /** Allocations the heap refused since boot, and the most recent one (firmware 2026-07-26.116+). */
    failedAllocations?: number
    lastFailedAllocation?: { bytes: number; caps: number; atMs: number }
  }
  /** Human-readable MAX31856 status-register reasons, when firmware supplies them. */
  sensorFaultReasons?: string[]
  manualLockout: boolean
  thermocoupleValid: boolean
  temperatureC?: number
  ambientC?: number
  // What the actuator is actually doing, as opposed to what was asked of it. The effective levels
  // differ from the applied ones whenever a firmware floor lifts them.
  actuatorMode?: string
  effectiveFan?: number
  effectiveHeat?: number
  storage?: {
    appUsedBytes?: number
    appSlotBytes?: number
    appFreeBytes?: number
    spiffsReservedBytes?: number
    controllerHistoryUsedBytes?: number
    controllerHistoryEnabled: boolean
  }
  liveTransport?: {
    websocketAvailable: boolean
    websocketPort?: number
    websocketClientCount?: number
    websocketClientCapacity?: number
    websocketBroadcastCount?: number
    websocketSendFailureCount?: number
    websocketQueueFailureCount?: number
    websocketStackLowWaterBytes?: number
    pendingStaticTransferCount?: number
    httpResponseStallAbortCount?: number
    httpResponsePeerAbortCount?: number
    httpRejectedRequestCount?: number
    httpWorkerFailureCount?: number
    httpWorkerStackLowWaterBytes?: number
    /** The asset worker and the command/Stop workers separately (firmware 2026-07-26.116+). */
    httpAssetWorkerStackLowWaterBytes?: number
    httpCommandWorkerStackLowWaterBytes?: number
    storageWorkerStackLowWaterBytes?: number
    /** The storage request ("POST /api/data/...") or "idle service" that set that low-water (firmware 2026-07-26.117+). */
    storageWorkerStackLowWaterRoute?: string
    /** The slowest storage request's handler time and route, and how many took >= 1 s (firmware 2026-07-26.119+). */
    storageSlowestRequestMs?: number
    storageSlowestRequestRoute?: string
    storageRequestsOverOneSecond?: number
    /** Station signal strength and disconnects since boot. */
    wifiRssiDbm?: number
    wifiDisconnectCount?: number
  }
  capabilities: ControllerCapabilities
  /**
   * The controller's own log archive. Its PRESENCE is the feature detection: a device at
   * `2026-07-26.37` or older omits the block entirely.
   */
  logArchive?: {
    mounted: boolean
    count?: number
    usedBytes?: number
    totalBytes?: number
    /** See `DeviceArchiveStorage.writeFloorBytes`: read here too, for a device that moves it. */
    writeFloorBytes?: number
    clockSynced?: boolean
    /** Recordings the controller could not keep. Never summed away: see `DeviceArchiveStorage`. */
    lostLogs?: number
    needsFormat?: boolean
  }
  /**
   * The coefficients the DEVICE has applied. Absent both on a firmware without the feature and on
   * one reporting `{present: false}`, because both mean the device is holding none.
   */
  appliedCoefficients?: {
    heaterGainCPerMinAt10?: number
    fanCoolingCPerMinAt10?: number
    coolingFanCPerMinAt10?: number
    thermalLossPerMinPerC?: number
    fitId?: string
    updatedAt?: string
  }
  /**
   * The controller's document store, under `/data` on the recordings volume. Its PRESENCE is the
   * feature detection - exactly as `log_archive` is for the archive - and it is emitted even when
   * the volume is not mounted, so "this firmware has no store" and "this store is not available
   * right now" stay distinguishable. A collection that has never been written is OMITTED from
   * `collections`, which is the same fact as its `GET` answering 404.
   */
  dataStore?: {
    mounted: boolean
    usedBytes?: number
    totalBytes?: number
    freeBytes?: number
    /**
     * The 507 threshold, emitted so a client can warn before a write is refused rather than after.
     * The firmware derives it (`kLogArchiveReserveBytes + kMaxIncomingLogBytes`) and says outright
     * that it "is not a round number a client should hardcode" - so this is preferred over the
     * app's own constant wherever it is present. Absent on firmware older than the derivation.
     */
    writeFloorBytes?: number
    collections: Record<string, { bytes?: number; version?: number }>
    runs: { count?: number; bytes?: number }
  }
  calibration?: CalibrationProgramStatus
  manual?: ManualStatus
  thermalLog?: ThermalLogStatus
  /**
   * The device-resident roast program. Its PRESENCE is the feature detection for the executor; a
   * firmware without it omits the key and the roast Start path stays the old, blocked one.
   */
  roast?: RoastProgramStatus
}

// One row of GET /thermal.csv. Sensor columns are blank while the thermocouple is faulted.
export interface ThermalSample {
  tMs: number
  thermocoupleC?: number
  coldJunctionC?: number
  effectiveFan: number
  effectiveHeat: number
}

// One programmed step. Fan 0 is only legal with heat 0, which is a passive-decay step.
export interface CalibrationStep {
  fan: number
  heat: number
}

// How the program was requested. A grid is expanded to `steps` locally exactly as the firmware
// expands it, so analysis never has to care which form produced the run.
export type CalibrationForm = 'steps' | 'grid'

// A stored diagnostic program. Baseline runs are empty-chamber: massG/densityGPerMl stay empty.
export interface CalibrationRun {
  id: string
  capturedAt: string
  /** Set when this log came from a recorded roast, which is what carries the covariates. */
  roastRunId?: string
  /**
   * The producing roaster's immutable origin-local log id, when this came from the archive.
   *
   * It is the IDEMPOTENCY key. Without it, bringing in the same stored recording twice produces two
   * identical rows, because nothing on the stored copy says which roaster recording it already is.
   * Together with `recordedOn.deviceId`, a recording that carries this id is never offered for
   * import again and never fetched twice. A restored copy may have a different current storage id.
   */
  sourceLogId?: string
  /**
   * What the roaster was doing when it recorded this, in the firmware's own words for it:
   * `calibration`, `proof`, `manual` or `roast`.
   *
   * This is what lets the screen STATE a recording's kind instead of asking. A diagnostic pass is an
   * empty chamber by construction - the runner on this page starts nothing else - so a recording
   * from one needs no classification question at all. A manual or roast recording is genuinely
   * ambiguous, because only the person who loaded the chamber knows what was in it, and that is the
   * only case where the classification control appears.
   */
  sourceMode?: string
  form: CalibrationForm
  steps: CalibrationStep[]
  maxStepSeconds: number
  minStepSeconds: number
  settleSeconds: number
  settleBandC: number
  // Passes captured before firmware 2026-07-26.34 recorded a program ceiling and its advance margin.
  // Later passes have no ceiling, so nothing can be ceiling-limited and neither field is written.
  ceilingC?: number
  advanceMarginC?: number
  ambientC?: number
  samples: ThermalSample[]
  notes: string
  massG?: number
  densityGPerMl?: number
  /** Correction already applied to every thermocouple sample in this evidence. */
  thermocoupleOffsetC?: number
  /** Stable provenance of the roaster that produced this evidence. */
  recordedOn: RecordedOn
}

/** The four measured terms the controller's journey inversion consumes. */
export interface ThermalModelCoefficients {
  heaterGainCPerMinAt10: number
  fanCoolingCPerMinAt10: number
  coolingFanCPerMinAt10: number
  thermalLossPerMinPerC: number
}

/**
 * A device's runtime thermal model.
 *
 * `referenceBatchMassG` is coefficient normalization, not one privileged observed roast. It stays
 * fixed at 225 g for the SR800 firmware and is not a user-editable calibration field.
 */
export interface ThermalModelSettings extends ThermalModelCoefficients {
  referenceBatchMassG: number
}

/** Synthetic sensor dynamics belong to a simulator, never to the persisted device calibration. */
export interface SimulationSensorModel {
  probeOffsetC: number
  sensorLagSec: number
}

/** A planning policy, kept separate from measured coefficients and simulated sensor behavior. */
export interface RoastPlanningSettings {
  coolingTargetMarginC: number
}

/**
 * The compact persisted planning model. Electrical phase timing is firmware-owned; simulated probe
 * bias and lag are dev-model-owned. Neither can be smuggled into this document.
 */
export interface CalibrationSettings extends ThermalModelSettings, RoastPlanningSettings {
  updatedAt: string
  // Provenance for the thermal coefficients, recorded when a staged fit is approved.
  thermalSourceDeviceId?: string
  thermalSourceModelId?: string
  thermalSourceRunId?: string
  thermalSourceCapturedAt?: string
  thermalStagedAt?: string
}

// The thermal coefficients a calibration fit can drive. Electrical mapping is never derived here.
export type ThermalCoefficientField =
  | 'heaterGainCPerMinAt10'
  | 'fanCoolingCPerMinAt10'
  | 'coolingFanCPerMinAt10'
  | 'thermalLossPerMinPerC'

export type ThermalCoefficientPatch = Partial<Record<ThermalCoefficientField, number>>

/**
 * A coefficient a provisional snapshot inherited from the set the roaster has already applied.
 * This is evidence for completing a partial fit, not a newly measured coefficient.
 */
export interface CalibrationInheritedCoefficient {
  source: 'roaster-applied'
  value: number
  fitId?: string
  appliedAt?: string
}

// How far a mesh point can be trusted. `measured` plateaued; `extrapolated` was cut short and its
// steady state comes from a three-parameter curve fit; `unreliable` was cut short too, but the fit
// could not identify an asymptote, so the value is a lower bound and must not be read as a reading.
export type CurvePointQuality = 'measured' | 'extrapolated' | 'unreliable'

// One point of the mesh: what the chamber settles to at a given fan and heat. `fan` is the level
// the step ACTUALLY ran at; `floored` marks a point the actuator lifted off its declared fan.
export interface CalibrationCurvePoint {
  heat: number
  steadyStateC: number
  riseOverAmbientC?: number
  tauSec?: number
  quality?: CurvePointQuality
  floored?: boolean
  extrapolated: boolean
  r2?: number
}

export interface CalibrationCurve {
  fanLevel: number
  points: CalibrationCurvePoint[]
}

/** One log a calibration was fitted from, with the covariates that were known at the time. */
export interface CalibrationFitInput {
  runId: string
  capturedAt: string
  label: string
  massG?: number
  beanLotId?: string
  beanLotName?: string
  roastRunId?: string
  roastName?: string
  measurements?: BatchMeasurements
  metrics?: {
    greenDensityGPerMl?: number
    roastedDensityGPerMl?: number
    expansionRatio?: number
    massLossPercent?: number
    densityLossPercent?: number
  }
}

/**
 * The inputs a fit consumed, hashed. If the measurements on those runs are edited later, the
 * calibration is stale - see `fitInputs.ts`. Absent on calibrations that were derived from a
 * chamber pass rather than fitted from roasts.
 */
export interface CalibrationFingerprint {
  runIds: string[]
  measurementHash: string
}

// A named, restorable calibration. Restoring stages its patch through the existing lock and diff.
export interface CalibrationSnapshot {
  id: string
  name: string
  createdAt: string
  runIds: string[]
  ambientC?: number
  patch: ThermalCoefficientPatch
  /**
   * Coefficients retained from the roaster-applied set when this fit could only identify part of
   * the model. Only explicitly attributed, finite values may cross the document boundary.
   */
  inheritedCoefficients?: Partial<Record<ThermalCoefficientField, CalibrationInheritedCoefficient>>
  /** Stable id of the complete fitted set this snapshot was applied as, when the roaster reports it. */
  applicationFitId?: string
  curves: CalibrationCurve[]
  /** Present when this calibration was FITTED from loaded roasts rather than derived from a pass. */
  inputs?: CalibrationFitInput[]
  fingerprint?: CalibrationFingerprint
  /** The replay RMS the fit achieved, in C, so the list can report fit quality without recomputing. */
  fitRmsC?: number
  /** Stable provenance of the roaster whose thermal behavior this snapshot describes. */
  recordedOn: RecordedOn
}

export interface Projection {
  finishSec?: number
  nextTargetSec?: number
  nextTargetC?: number
}
