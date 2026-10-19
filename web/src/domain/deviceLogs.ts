import { requireRecordedOn, requireRecordingOrigin, requireStorageAddress } from './provenance'
import type { RecordedOn, RecordingOrigin, RecordingStorageAddress, RoastEndReason, RoastProgramMode } from './types'

/**
 * The device log archive, as pure logic.
 *
 * Firmware after `2026-07-26.37` persists thermal logs to SPIFFS and exposes them for listing,
 * fetching and deletion, along with the coefficients it currently has applied. The firmware flashed
 * today does not, and a client that assumes otherwise turns a missing feature into a broken screen.
 *
 * So everything here is feature-detected and everything degrades to a stated absence rather than an
 * error: an archive that is not there reads as "this firmware has no device log archive", which is
 * a fact about the roaster, not a fault in the app.
 *
 * Built against the final firmware contract. Feature detection is the presence of the `log_archive`
 * key in `GET /api/status`: a device at `2026-07-26.37` or older does not send it, and no amount of
 * probing the routes will change that, so the status document decides and the routes are only ever
 * called once it has said yes.
 *
 * Parsing stays defensive anyway - every field read null-safely, an entry that cannot produce an id
 * dropped rather than rendered as a row that cannot be fetched - because a status document is a
 * contract with a device that may be mid-upgrade, not a type guarantee.
 */

/** What a stored log was recorded by. Anything unrecognised reads as `unknown` rather than throwing. */
export type DeviceLogMode = 'manual' | 'calibration' | 'proof' | 'roast' | 'none' | 'unknown'

export interface DeviceLogEntry {
  /** The roaster that produced the recording; required for every v4 index row. */
  recordedOn: RecordedOn
  /** Immutable producer-local identity. */
  recordingOrigin: RecordingOrigin
  /** Current roaster-local address used for fetch/delete. */
  storageAddress: RecordingStorageAddress
  /** Current storage-local id, retained as the HTTP route segment. */
  id: string
  /** Which boot of the controller produced it, so logs from one power cycle group together. */
  bootId?: string
  durationSec?: number
  samples?: number
  intervalMs?: number
  mode: DeviceLogMode
  /** How a roast-source recording was controlled. Absent for diagnostic recordings. */
  roastMode?: RoastProgramMode
  /** v3 roast boundary; automatic programs may retain a later passive tail. */
  roastStopSec?: number
  /** v3 terminal reason captured at that same boundary. */
  roastEndReason?: RoastEndReason
  /** False when the source-specific capture policy did not complete; the archive does not guess why. */
  passiveTailComplete?: boolean
  /** Correction already applied to thermocouple samples in this recording. */
  thermocoupleOffsetC?: number
  /**
   * The archive header version. v1 files carry no name and no attainments and keep validating
   * forever; v2 adds both. Reading the version rather than probing for the fields is what lets a
   * mixed archive - the normal case after an update - list without either half being misread.
   */
  version?: number
  /** v2 only: the sanitized roast name the controller ran under. The import's join key. */
  name?: string
  /**
   * v2 only: the green mass the roast was planned against, in grams.
   *
   * The firmware sends `0` for "not a roast, or mass unknown" - it is carried in two former reserved
   * bytes, so there is no way to spell absence other than zero - and 0 g is not a batch. It becomes
   * `undefined` here for the same reason `start_epoch: 0` becomes undefined: a sentinel that means
   * "unknown" must never reach the archive as a measurement, where every consumer downstream would
   * read it as one.
   */
  batchMassG?: number
  /** v2 only. `null` for a zone whose endpoint was never attained, never 0. */
  zoneAttainedSec?: Array<number | null>
  zoneCount?: number
  /**
   * Unix seconds, or absent. The firmware sends 0 when its clock had never been SNTP-synced at the
   * moment the log was persisted, which means "date unknown" - NOT 1970. Showing the epoch would
   * be worse than showing the boot number, so 0 becomes undefined here and the UI falls back.
   */
  startedAt?: string
  bytes?: number
  /**
   * v3 only: the compressed payload length, where `bytes` is the whole file on the volume. Absent on
   * v1/v2 files, which are fixed-stride and whose payload is simply `bytes` minus their header - so
   * every consumer here falls back to `bytes`, which is what actually occupies the volume anyway.
   */
  payloadBytes?: number
  /** The path the firmware itself gives for this log, when it gives one. */
  download?: string
}

/** What the controller is recording right now, which may not be on flash yet. */
export interface DeviceCurrentLog {
  active: boolean
  /**
   * A log persists only when the actuator is fully idle - three minutes after everything went quiet,
   * or the moment the next run starts. `unsaved` is therefore a normal, expected state after a
   * roast, not a fault: the log is not lost, it is just still in RAM, and `/thermal.csv` serves it.
   */
  unsaved: boolean
  samples?: number
  mode: DeviceLogMode
}

/** The filesystem behind the archive, from the status document. */
export interface DeviceArchiveStorage {
  mounted: boolean
  count?: number
  usedBytes?: number
  totalBytes?: number
  /**
   * The free space a document write must leave behind - the `507` line. The firmware derives it as
   * its archive reserve plus the largest recording a persist can produce and emits it in
   * `data_store`, so this is read here only for a device that also states it alongside the archive.
   * Absent means "ask the constant", never "there is no floor".
   */
  writeFloorBytes?: number
  /**
   * The largest recording `POST /api/logs/restore` will accept, DECODED - the firmware's
   * `kMaxIncomingLogBytes`, 121,244.
   *
   * It is the feature detection for backup/restore, and it has to be, because `log_archive` predates
   * those endpoints: unlike `data_store`, the presence of the BLOCK proves nothing about them. A
   * device that states this number can hand back `/logs/<id>.crk` and take one back; a device that
   * does not is an older controller (such as 2026-07-26.39) whose recordings can only be read as CSV.
   */
  restoreMaxBytes?: number
  /** False means every `start_epoch` this device writes will be 0 until it syncs. */
  clockSynced?: boolean
  /**
   * Recordings the controller could not keep: overwritten before they reached flash, or dropped
   * after exhausting persist retries. The firmware added the counter precisely so that a recording
   * going away can never be silent, so a non-zero value is always shown rather than summed away.
   */
  lostLogs?: number
  /** The volume mounted in the state where only an explicit, user-confirmed format can recover it. */
  needsFormat?: boolean
}

export interface DeviceArchive {
  state: DeviceArchiveState
  logs: DeviceLogEntry[]
  /** Plain wording for whichever state this is, ready to render. */
  message: string
  current?: DeviceCurrentLog
  storage?: DeviceArchiveStorage
}

const MODES: DeviceLogMode[] = ['manual', 'calibration', 'proof', 'roast', 'none']
const ROAST_MODES: RoastProgramMode[] = ['timed', 'journey', 'manual']
const ROAST_END_REASONS: RoastEndReason[] = [
  'completed',
  'stopped',
  'fault',
  'telemetry_stale',
  'sensor_lost',
  'qualification_stalled',
  'step_rejected',
  'renewal_rejected',
  'command_rejected',
  'envelope_timeout',
  'instruction_expired',
  'heat_lease_expired',
]

const pick = (source: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key]
  }
  return undefined
}

const asText = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

const asNumber = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

const asMode = (value: unknown): DeviceLogMode => {
  const text = asText(value)?.toLowerCase()
  return MODES.find((mode) => mode === text) ?? 'unknown'
}

/** Unix seconds to an ISO string, treating the firmware's 0 as "the clock was never synced". */
export const epochToIso = (epoch: unknown): string | undefined => {
  const seconds = asNumber(epoch)
  if (seconds === undefined || seconds <= 0) return undefined
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export const parseDeviceLogEntry = (value: unknown): DeviceLogEntry | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const id = asText(pick(record, 'id'))
  if (!id) return undefined
  let recordedOn: RecordedOn
  let recordingOrigin: RecordingOrigin
  let storageAddress: RecordingStorageAddress
  try {
    recordedOn = requireRecordedOn(pick(record, 'recorded_on', 'recordedOn'))
    recordingOrigin = requireRecordingOrigin(pick(record, 'recording_origin', 'recordingOrigin'))
    storageAddress = requireStorageAddress(pick(record, 'storage_address', 'storageAddress'))
  } catch {
    // Missing origin is quarantined rather than attributed to whichever roaster is active.
    return undefined
  }
  if (storageAddress.logId !== id) return undefined
  const durationMs = asNumber(pick(record, 'duration_ms', 'durationMs'))
  const attainments = pick(record, 'zone_attained_sec', 'zoneAttainedSec')
  const massG = asNumber(pick(record, 'batch_mass_g', 'batchMassG'))
  const mode = asMode(pick(record, 'source', 'mode'))
  const zoneCount = asNumber(pick(record, 'zone_count', 'zoneCount'))
  const declaredRoastMode = asText(pick(record, 'roast_mode', 'roastMode'))?.toLowerCase()
  const declaredEndReason = asText(pick(record, 'roast_end_reason', 'roastEndReason'))?.toLowerCase()
  return {
    recordedOn,
    recordingOrigin,
    storageAddress,
    id,
    bootId: asText(pick(record, 'boot', 'boot_id', 'bootId')),
    durationSec: durationMs === undefined ? undefined : durationMs / 1000,
    samples: asNumber(pick(record, 'samples')),
    intervalMs: asNumber(pick(record, 'interval_ms', 'intervalMs')),
    mode,
    roastMode:
      mode === 'roast'
        ? (ROAST_MODES.find((candidate) => candidate === declaredRoastMode) ??
          ((zoneCount ?? 0) > 0 ? 'journey' : 'timed'))
        : undefined,
    roastStopSec: mode === 'roast' ? asNumber(pick(record, 'roast_stop_sec', 'roastStopSec')) : undefined,
    roastEndReason:
      mode === 'roast' ? ROAST_END_REASONS.find((candidate) => candidate === declaredEndReason) : undefined,
    passiveTailComplete:
      mode === 'roast' && typeof pick(record, 'passive_tail_complete', 'passiveTailComplete') === 'boolean'
        ? (pick(record, 'passive_tail_complete', 'passiveTailComplete') as boolean)
        : undefined,
    thermocoupleOffsetC: asNumber(pick(record, 'thermocouple_offset_c', 'thermocoupleOffsetC')),
    startedAt: epochToIso(pick(record, 'start_epoch', 'startEpoch')),
    bytes: asNumber(pick(record, 'bytes')),
    payloadBytes: asNumber(pick(record, 'payload_bytes', 'payloadBytes')),
    download: asText(pick(record, 'download')),
    version: asNumber(pick(record, 'version')),
    name: asText(pick(record, 'name')),
    // 0 is the firmware's "unknown", not a batch of nothing.
    batchMassG: massG !== undefined && massG > 0 ? massG : undefined,
    zoneCount,
    zoneAttainedSec: Array.isArray(attainments) ? attainments.map((entry) => asNumber(entry) ?? null) : undefined,
  }
}

export const parseDeviceCurrentLog = (value: unknown): DeviceCurrentLog | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  return {
    active: record.active === true,
    unsaved: record.unsaved === true,
    samples: asNumber(pick(record, 'samples')),
    mode: asMode(pick(record, 'source', 'mode')),
  }
}

/**
 * The `log_archive` block from the status document. Its PRESENCE is the feature detection - a
 * device that has never heard of the archive omits the key entirely.
 */
export const parseArchiveStorage = (value: unknown): DeviceArchiveStorage | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  return {
    mounted: record.mounted === true,
    count: asNumber(pick(record, 'count')),
    usedBytes: asNumber(pick(record, 'used_bytes', 'usedBytes')),
    totalBytes: asNumber(pick(record, 'total_bytes', 'totalBytes')),
    writeFloorBytes: asNumber(pick(record, 'write_floor_bytes', 'writeFloorBytes')),
    restoreMaxBytes: asNumber(pick(record, 'restore_max_bytes', 'restoreMaxBytes')),
    clockSynced:
      typeof record.clock_synced === 'boolean'
        ? record.clock_synced
        : typeof record.clockSynced === 'boolean'
          ? record.clockSynced
          : undefined,
    lostLogs: asNumber(pick(record, 'lost_logs', 'lostLogs')),
    needsFormat:
      typeof record.needs_format === 'boolean'
        ? record.needs_format
        : typeof record.needsFormat === 'boolean'
          ? record.needsFormat
          : undefined,
  }
}

/** The list payload, in whichever of the plausible shapes it arrives. */
export const parseDeviceLogList = (payload: unknown): DeviceLogEntry[] => {
  const rows = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null
      ? (pick(payload as Record<string, unknown>, 'logs', 'entries', 'files', 'items') as unknown)
      : undefined
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const entry = parseDeviceLogEntry(row)
    return entry ? [entry] : []
  })
}

/** Newest first. Ids are monotonic across boots, so this needs no clock at all. */
export const orderDeviceLogs = (logs: DeviceLogEntry[]): DeviceLogEntry[] => orderById(logs)

export type DeviceArchiveState = 'available' | 'busy' | 'unsupported' | 'unmounted' | 'unreachable'

export const ARCHIVE_MESSAGES: Record<DeviceArchiveState, string> = {
  available: 'Detailed thermal recordings are stored on the roaster. Manage them in Settings.',
  busy: 'The roaster is still capturing the current thermal recording. Stored recordings become available when it finishes.',
  unsupported:
    'This firmware cannot keep detailed thermal recordings. Only the current run is held in memory until the next run replaces it.',
  unmounted:
    'The roaster can keep detailed thermal recordings, but its storage did not mount. No new detailed recording can be saved until storage is available.',
  unreachable: 'The roaster could not be reached, so what it has stored is unknown.',
}

/**
 * Turn an HTTP outcome into an archive state.
 *
 * A 404 or 501 is the ABSENCE of the feature, not a failure: the firmware simply does not serve
 * that route. Anything else that failed is a reachability problem, and the two must not be
 * conflated - one is permanent until the device is updated, the other clears by itself.
 */
export const archiveStateFromStatus = (status: number | undefined): DeviceArchiveState => {
  if (status === undefined) return 'unreachable'
  if (status === 404 || status === 501 || status === 405) return 'unsupported'
  if (status === 503) return 'unmounted'
  if (status === 409) return 'busy'
  if (status >= 200 && status < 300) return 'available'
  return 'unreachable'
}

export const deviceArchive = (
  state: DeviceArchiveState,
  logs: DeviceLogEntry[] = [],
  extra: { current?: DeviceCurrentLog; storage?: DeviceArchiveStorage } = {},
): DeviceArchive => ({
  state,
  logs: state === 'available' ? orderDeviceLogs(logs) : [],
  message: ARCHIVE_MESSAGES[state],
  current: extra.current,
  storage: extra.storage,
})

/**
 * Ids are monotonic across boots, so descending id IS newest-first and needs no clock. That is what
 * makes the ordering trustworthy on a controller that has never been SNTP-synced - which, on a
 * trusted-LAN roaster with no internet, is the normal case rather than the exception.
 */
export const orderById = (logs: DeviceLogEntry[]): DeviceLogEntry[] =>
  [...logs].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0) || b.id.localeCompare(a.id))

/**
 * The coefficients the DEVICE believes are applied, when it reports them at all.
 *
 * Once the firmware stores its own applied set, the app's copy and the device's copy can disagree -
 * an app that was applied to from another browser, a device that was reflashed. Divergence is not
 * an error state, but it is something the user has to be able to see.
 */
export interface DeviceCoefficients {
  heaterGainCPerMinAt10?: number
  fanCoolingCPerMinAt10?: number
  coolingFanCPerMinAt10?: number
  thermalLossPerMinPerC?: number
  /** The fit fingerprint that produced them, echoed back so a set can be traced to its calibration. */
  fitId?: string
  /** Absent when the device clock had never synced at the moment they were applied. */
  updatedAt?: string
}

/**
 * `applied_calibration` from the status document. `{present: false}` is a real answer - the device
 * has the feature and nothing is applied - and is reported as `undefined` here, same as a firmware
 * that never sends the block at all, because both mean "the device is not holding coefficients".
 */
export const parseDeviceCoefficients = (value: unknown): DeviceCoefficients | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.present === false) return undefined
  const coefficients: DeviceCoefficients = {
    heaterGainCPerMinAt10: asNumber(pick(record, 'heater_gain', 'heaterGain')),
    fanCoolingCPerMinAt10: asNumber(pick(record, 'fan_cooling', 'fanCooling')),
    coolingFanCPerMinAt10: asNumber(pick(record, 'cooling_fan', 'coolingFan')),
    thermalLossPerMinPerC: asNumber(pick(record, 'loss_per_min', 'lossPerMin')),
    fitId: asText(pick(record, 'fit_id', 'fitId')),
    updatedAt: epochToIso(pick(record, 'applied_epoch', 'appliedEpoch')),
  }
  const known = Object.values(coefficients).filter((entry) => entry !== undefined)
  return known.length === 0 ? undefined : coefficients
}

/**
 * The firmware sanitizes `fit_id` to `[A-Za-z0-9._:-]`, at most 47 characters, and echoes what it
 * stored. Sending anything outside that alphabet means the value that comes back is NOT the value
 * that went out, and a divergence check comparing them would fire forever. So the id is put into
 * that alphabet here, before it is sent, and the round trip is byte-identical by construction.
 */
export const FIT_ID_MAX = 47
export const sanitizeFitId = (value: string) => value.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, FIT_ID_MAX)

/**
 * What each thermal coefficient is CALLED, in one place.
 *
 * Three screens and the roast pre-flight all name these four numbers, and for a while one of them
 * did not: it humanized the identifier and rendered "heater gain c per min at10", which reads as a
 * bug because it is one. A coefficient has a name and a unit, both are short, and neither may be
 * derived from a TypeScript property at runtime - so they are declared here, beside the precision
 * rule and the divergence check that already had to be shared for the same reason.
 */
export const COEFFICIENT_LABELS = {
  heaterGainCPerMinAt10: 'Heat gain at 10',
  // Two airflow terms that must not read alike: cooling by the fan while the heater runs, and the
  // fan's cooling once the heat is off.
  fanCoolingCPerMinAt10: 'Airflow loss at Fan 10',
  coolingFanCPerMinAt10: 'Forced cooling at Fan 10',
  thermalLossPerMinPerC: 'Thermal loss',
} as const

export const COEFFICIENT_UNITS = {
  heaterGainCPerMinAt10: '°C/min',
  fanCoolingCPerMinAt10: '°C/min',
  coolingFanCPerMinAt10: '°C/min',
  thermalLossPerMinPerC: '°C/min/°C',
} as const

export type CoefficientField = keyof typeof COEFFICIENT_LABELS

/** The name and the unit together, for prose that has room for only one string. */
export const coefficientLabel = (field: CoefficientField) =>
  `${COEFFICIENT_LABELS[field]} (${COEFFICIENT_UNITS[field]})`

/** The precision the firmware serializes at, so a round trip cannot read as a divergence. */
export const DEVICE_COEFFICIENT_PLACES = {
  heaterGainCPerMinAt10: 3,
  fanCoolingCPerMinAt10: 3,
  coolingFanCPerMinAt10: 3,
  thermalLossPerMinPerC: 4,
} as const

export interface CoefficientDivergence {
  diverged: boolean
  fields: Array<{ field: CoefficientField; device?: number; app: number }>
}

const COMPARED = Object.keys(COEFFICIENT_LABELS) as CoefficientField[]

/**
 * Compared at the precision the FIRMWARE serializes at, so a value that survived the round trip
 * intact never reads as divergence. Three decimals on the rates, four on the loss.
 */
export const coefficientDivergence = (
  device: DeviceCoefficients | undefined,
  app: Record<CoefficientField, number>,
): CoefficientDivergence => {
  if (!device) return { diverged: false, fields: [] }
  const fields = COMPARED.map((field) => ({
    field,
    device: device[field] as number | undefined,
    app: app[field],
  })).filter((entry) => {
    if (entry.device === undefined) return false
    const places = DEVICE_COEFFICIENT_PLACES[entry.field]
    return entry.device.toFixed(places) !== entry.app.toFixed(places)
  })
  return { diverged: fields.length > 0, fields }
}
