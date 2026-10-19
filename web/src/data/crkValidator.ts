import type {
  ArchivedCalibrationProgram,
  ArchivedJourneyZone,
  ArchivedPlanChange,
  ArchivedRoastPlan,
  RecordingOrigin,
  RoastEndReason,
  ThermalSample,
} from '../domain/types'

/**
 * Production-side validation for a recording that is about to cross the
 * destructive whole-backup restore boundary.
 *
 * Keep this in sync with `sr800_log_codec.cpp::validateArchiveReader`. Backup
 * parsing deliberately does not call it: a byte-exact backup/import must still
 * preserve a damaged recording so it can be repaired off-device.
 */
const ARCHIVE_MAGIC = 0x4c4b5243
const HEADER_V1_BYTES = 32
const HEADER_V4_BYTES = 220
const RAW_SAMPLE_BYTES = 12
const MAX_SAMPLES = 4800
const MAX_ZONES = 12
const CODEC_RAW = 0
const CODEC_DELTA_VARINT = 1
const CODEC_PLAN_DELTA_VARINT = 2
const PLAN_ENVELOPE_MAGIC = 0xc7
const PLAN_ENVELOPE_VERSION = 1
const PLAN_ENVELOPE_MAX_BYTES = 1024
const PLAN_JOURNAL_MAX_EVENTS = 32
const timedStepValid = (fan: number, heat: number, durationSec: number) =>
  fan <= 100 && heat <= 100 && durationSec >= 1 && durationSec <= 1800 && (fan !== 0 || heat === 0)
const MIN_I32 = -0x80000000
const MAX_I32 = 0x7fffffff
const MIN_DECI_DEGREES = -32768
const MAX_DECI_DEGREES = 32767
const MAX_DECI_LEVEL = 655
const ROAST_END_REASONS: ReadonlyArray<RoastEndReason | undefined> = [
  undefined,
  'stopped',
  'completed',
  'fault',
  'instruction_expired',
  'renewal_rejected',
  'qualification_stalled',
  'sensor_lost',
  'command_rejected',
  'envelope_timeout',
  'step_rejected',
  'telemetry_stale',
  'heat_lease_expired',
]

export type CrkValidationCheck =
  | 'truncated_header'
  | 'bad_magic'
  | 'bad_version'
  | 'sample_count'
  | 'zone_count'
  | 'bad_codec'
  | 'size_mismatch'
  | 'crc_mismatch'
  | 'provenance'
  | 'payload_undecodable'
  | 'log_id'

export type CrkValidationResult =
  | {
      ok: true
      summary: {
        version: number
        logId: number
        sampleCount: number
        encodedBytes: number
        codec: number
        /** Immutable producer identity carried inside the v4 archive header. */
        recordingOrigin: RecordingOrigin
        /** Correction already applied to every stored thermocouple sample. */
        thermocoupleOffsetC: number
        /** Stable terminal reason from the v4 archive header, when the recording has ended. */
        roastEndReason?: RoastEndReason
      }
    }
  | { ok: false; check: CrkValidationCheck; message: string }

const failure = (check: CrkValidationCheck, message: string): CrkValidationResult => ({ ok: false, check, message })

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return value >>> 0
})

/** The wire-format CRC, exported so focused archive fixtures can remain honest. */
export const crkCrc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

const readFixedAscii = (bytes: Uint8Array, offset: number, length: number): string | undefined => {
  const field = bytes.subarray(offset, offset + length)
  const end = field.indexOf(0)
  const used = end < 0 ? field : field.subarray(0, end)
  if (used.length === 0 || used.some((byte) => byte < 0x20 || byte > 0x7e || byte === 0x22 || byte === 0x5c))
    return undefined
  return new TextDecoder().decode(used)
}

const archiveIntegrityBytes = (header: Uint8Array, payload: Uint8Array): Uint8Array =>
  Uint8Array.from([...header.subarray(0, 96), ...header.subarray(100, HEADER_V4_BYTES), ...payload])
interface Varint {
  value: number
  next: number
}

const takeVarint = (bytes: Uint8Array, at: number): Varint | undefined => {
  let value = 0
  for (let index = 0; index < 5 && at + index < bytes.length; index += 1) {
    const byte = bytes[at + index]
    // A u32 has only four payload bits left in its fifth byte. This also
    // rejects a continuation bit there, exactly as the firmware does.
    if (index === 4 && (byte & 0xf0) !== 0) return undefined
    value += (byte & 0x7f) * 2 ** (7 * index)
    if ((byte & 0x80) === 0) return { value, next: at + index + 1 }
  }
  return undefined
}

const zigzagDecode = (value: number): number => (value >>> 1) ^ -(value & 1)

const decodeDeltaPayload = (payload: Uint8Array, sampleCount: number, samples?: ThermalSample[]): boolean => {
  let at = 0
  let previousTime = 0
  let previousDeltaTime = 0
  let previousThermocouple = 0
  let previousColdJunction = 0
  let previousFan = 0
  let previousHeat = 0

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const tokens: number[] = []
    for (let channel = 0; channel < 5; channel += 1) {
      const token = takeVarint(payload, at)
      if (!token) return false
      tokens.push(token.value)
      at = token.next
    }

    const deltaTime = previousDeltaTime + zigzagDecode(tokens[0])
    if (deltaTime < MIN_I32 || deltaTime > MAX_I32) return false
    const time = previousTime + deltaTime
    if (time < 0 || time > MAX_I32) return false

    let thermocouple = previousThermocouple
    const thermocoupleValid = tokens[1] !== 0
    if (thermocoupleValid) {
      thermocouple += zigzagDecode(tokens[1] - 1)
      if (thermocouple < MIN_DECI_DEGREES || thermocouple > MAX_DECI_DEGREES) return false
    }

    let coldJunction = previousColdJunction
    const coldJunctionValid = tokens[2] !== 0
    if (coldJunctionValid) {
      coldJunction += zigzagDecode(tokens[2] - 1)
      if (coldJunction < MIN_DECI_DEGREES || coldJunction > MAX_DECI_DEGREES) return false
    }

    const fan = previousFan + zigzagDecode(tokens[3])
    if (fan < 0 || fan > MAX_DECI_LEVEL) return false
    const heat = previousHeat + zigzagDecode(tokens[4])
    if (heat < 0 || heat > MAX_DECI_LEVEL) return false

    samples?.push({
      tMs: time,
      ...(thermocoupleValid ? { thermocoupleC: thermocouple / 10 } : {}),
      ...(coldJunctionValid ? { coldJunctionC: coldJunction / 10 } : {}),
      effectiveFan: fan / 10,
      effectiveHeat: heat / 10,
    })

    previousTime = time
    previousDeltaTime = deltaTime
    previousThermocouple = thermocouple
    previousColdJunction = coldJunction
    previousFan = fan
    previousHeat = heat
  }
  return at === payload.length
}
const deltaPayloadDecodes = (payload: Uint8Array, sampleCount: number): boolean =>
  decodeDeltaPayload(payload, sampleCount)

export interface DecodedCrkRoastPlan {
  initialPlan: ArchivedRoastPlan
  planJournal: ArchivedPlanChange[]
  /** The exact bounded codec-2 envelope, base64 so the run document can retain it compactly. */
  planEnvelope: string
}

export interface DecodedCrkCalibrationProgram {
  program: ArchivedCalibrationProgram
  thermocoupleOffsetC: number
}

interface DecodedPlanEnvelope {
  initialPlan: ArchivedRoastPlan | ArchivedCalibrationProgram
  planJournal: ArchivedPlanChange[]
  bytes: number
}

const readPlanVarint = (bytes: Uint8Array, cursor: { at: number }): number | undefined => {
  const token = takeVarint(bytes, cursor.at)
  if (!token) return undefined
  cursor.at = token.next
  return token.value
}

const readPlanByte = (bytes: Uint8Array, cursor: { at: number }): number | undefined =>
  cursor.at < bytes.length ? bytes[cursor.at++] : undefined

const readPlanU16 = (bytes: Uint8Array, cursor: { at: number }): number | undefined => {
  if (cursor.at + 2 > bytes.length) return undefined
  const value = bytes[cursor.at] | (bytes[cursor.at + 1] << 8)
  cursor.at += 2
  return value
}

const readPlanTemperature = (bytes: Uint8Array, cursor: { at: number }): number | undefined => {
  const token = readPlanVarint(bytes, cursor)
  if (token === undefined) return undefined
  const value = zigzagDecode(token)
  return value < MIN_DECI_DEGREES || value > MAX_DECI_DEGREES ? undefined : value / 10
}

const readJourneyZone = (
  bytes: Uint8Array,
  cursor: { at: number },
  mask: number,
  base?: ArchivedJourneyZone,
): ArchivedJourneyZone | undefined => {
  const zone: ArchivedJourneyZone = base
    ? { ...base }
    : { startC: 0, endC: 0, durationSec: 0, fanMin: 0, fanMax: 0, heatMin: 0, heatMax: 0 }
  if (mask & 0x01) {
    const value = readPlanTemperature(bytes, cursor)
    if (value === undefined) return undefined
    zone.startC = value
  }
  if (mask & 0x02) {
    const value = readPlanTemperature(bytes, cursor)
    if (value === undefined) return undefined
    zone.endC = value
  }
  if (mask & 0x04) {
    const value = readPlanVarint(bytes, cursor)
    if (value === undefined || value < 1 || value > 0xffff) return undefined
    zone.durationSec = value
  }
  const levelFields: Array<[number, keyof Pick<ArchivedJourneyZone, 'fanMin' | 'fanMax' | 'heatMin' | 'heatMax'>]> = [
    [0x08, 'fanMin'],
    [0x10, 'fanMax'],
    [0x20, 'heatMin'],
    [0x40, 'heatMax'],
  ]
  for (const [bit, field] of levelFields) {
    if ((mask & bit) === 0) continue
    const value = readPlanByte(bytes, cursor)
    if (value === undefined || value > 100) return undefined
    zone[field] = value / 10
  }
  return zone.durationSec > 0 && zone.fanMin <= zone.fanMax && zone.heatMin <= zone.heatMax ? zone : undefined
}

const decodePlanEnvelope = (payload: Uint8Array): DecodedPlanEnvelope | undefined => {
  if (payload.length < 7 || payload[0] !== PLAN_ENVELOPE_MAGIC || payload[1] !== PLAN_ENVELOPE_VERSION) return undefined
  const envelopeBytes = payload[5] | (payload[6] << 8)
  if (envelopeBytes < 7 || envelopeBytes > PLAN_ENVELOPE_MAX_BYTES || envelopeBytes > payload.length) return undefined
  const bytes = payload.subarray(0, envelopeBytes)
  const mode = bytes[2]
  const itemCount = bytes[3]
  const eventCount = bytes[4]
  if (eventCount > PLAN_JOURNAL_MAX_EVENTS) return undefined
  const cursor = { at: 7 }
  let initialPlan: ArchivedRoastPlan | ArchivedCalibrationProgram

  if (mode === 1) {
    if (itemCount < 1 || itemCount > 24) return undefined
    const steps = []
    for (let index = 0; index < itemCount; index += 1) {
      const fan = readPlanByte(bytes, cursor)
      const heat = readPlanByte(bytes, cursor)
      const durationSec = readPlanU16(bytes, cursor)
      if (
        fan === undefined ||
        heat === undefined ||
        durationSec === undefined ||
        !timedStepValid(fan, heat, durationSec)
      )
        return undefined
      steps.push({ fan: fan / 10, heat: heat / 10, durationSec })
    }
    initialPlan = { mode: 'timed', steps }
  } else if (mode === 2) {
    if (itemCount < 1 || itemCount > MAX_ZONES) return undefined
    const zones: ArchivedJourneyZone[] = []
    for (let index = 0; index < itemCount; index += 1) {
      const zone = readJourneyZone(bytes, cursor, 0x7f)
      if (!zone) return undefined
      zones.push(zone)
    }
    initialPlan = { mode: 'journey', zones }
  } else if (mode === 3) {
    if (itemCount !== 1) return undefined
    const fan = readPlanByte(bytes, cursor)
    const heat = readPlanByte(bytes, cursor)
    if (fan === undefined || heat === undefined || fan > 100 || heat > 100) return undefined
    initialPlan = { mode: 'manual', fan: fan / 10, heat: heat / 10 }
  } else if (mode === 4) {
    if (itemCount < 1 || itemCount > 48 || eventCount !== 0) return undefined
    const minStepSeconds = readPlanByte(bytes, cursor)
    const settleSeconds = readPlanByte(bytes, cursor)
    const settleBandTenthsC = readPlanByte(bytes, cursor)
    if (
      minStepSeconds === undefined ||
      minStepSeconds < 5 ||
      minStepSeconds > 120 ||
      settleSeconds === undefined ||
      settleSeconds < 2 ||
      settleSeconds > 30 ||
      settleBandTenthsC === undefined ||
      settleBandTenthsC < 2 ||
      settleBandTenthsC > 100
    )
      return undefined
    const steps = []
    for (let index = 0; index < itemCount; index += 1) {
      const fan = readPlanByte(bytes, cursor)
      const heat = readPlanByte(bytes, cursor)
      const durationSec = readPlanU16(bytes, cursor)
      if (
        fan === undefined ||
        heat === undefined ||
        durationSec === undefined ||
        fan > 100 ||
        heat > 100 ||
        (fan === 0 && heat > 0) ||
        durationSec < 1 ||
        durationSec > 1800
      )
        return undefined
      steps.push({ fan: fan / 10, heat: heat / 10, durationSec })
    }
    initialPlan = {
      mode: 'calibration',
      steps,
      maxStepSeconds: steps[0].durationSec,
      minStepSeconds,
      settleSeconds,
      settleBandC: settleBandTenthsC / 10,
    }
    if (cursor.at !== bytes.length) return undefined
    return { initialPlan, planJournal: [], bytes: envelopeBytes }
  } else return undefined

  const planJournal: ArchivedPlanChange[] = []
  let previous = initialPlan.mode === 'journey' ? initialPlan.zones : []
  let timedStepCount = initialPlan.mode === 'timed' ? initialPlan.steps.length : 0
  let previousElapsedSec = 0
  let previousPlanRev = 0
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const elapsedSec = readPlanVarint(bytes, cursor)
    const planRev = readPlanVarint(bytes, cursor)
    if (
      elapsedSec === undefined ||
      elapsedSec > 0xffff ||
      planRev === undefined ||
      planRev <= previousPlanRev ||
      elapsedSec < previousElapsedSec
    )
      return undefined
    previousElapsedSec = elapsedSec
    previousPlanRev = planRev
    if (initialPlan.mode === 'timed') {
      const stepIndex = readPlanByte(bytes, cursor)
      const fan = readPlanByte(bytes, cursor)
      const heat = readPlanByte(bytes, cursor)
      const durationSec = readPlanU16(bytes, cursor)
      if (
        stepIndex === undefined ||
        stepIndex >= 24 ||
        stepIndex > timedStepCount ||
        fan === undefined ||
        heat === undefined ||
        durationSec === undefined ||
        !timedStepValid(fan, heat, durationSec)
      )
        return undefined
      planJournal.push({ elapsedSec, planRev, stepIndex, step: { fan: fan / 10, heat: heat / 10, durationSec } })
      if (stepIndex === timedStepCount) timedStepCount += 1
      continue
    }
    if (initialPlan.mode === 'manual') {
      const requestedFan = readPlanByte(bytes, cursor)
      const requestedHeat = readPlanByte(bytes, cursor)
      const effectiveFan = readPlanByte(bytes, cursor)
      const effectiveHeat = readPlanByte(bytes, cursor)
      if (
        requestedFan === undefined ||
        requestedHeat === undefined ||
        effectiveFan === undefined ||
        effectiveHeat === undefined ||
        requestedFan > 100 ||
        requestedHeat > 100 ||
        effectiveFan > 100 ||
        effectiveHeat > 100
      )
        return undefined
      planJournal.push({
        elapsedSec,
        planRev,
        requestedFan: requestedFan / 10,
        requestedHeat: requestedHeat / 10,
        effectiveFan: effectiveFan / 10,
        effectiveHeat: effectiveHeat / 10,
      })
      continue
    }
    const nextCount = readPlanByte(bytes, cursor)
    const patchCount = readPlanByte(bytes, cursor)
    if (
      nextCount === undefined ||
      nextCount < 1 ||
      nextCount > MAX_ZONES ||
      patchCount === undefined ||
      patchCount > nextCount
    )
      return undefined
    const next = previous.slice(0, nextCount).map((zone) => ({ ...zone }))
    while (next.length < nextCount) {
      next.push({ startC: 0, endC: 0, durationSec: 0, fanMin: 0, fanMax: 0, heatMin: 0, heatMax: 0 })
    }
    const seen = new Set<number>()
    for (let patchIndex = 0; patchIndex < patchCount; patchIndex += 1) {
      const index = readPlanByte(bytes, cursor)
      const mask = readPlanByte(bytes, cursor)
      if (
        index === undefined ||
        mask === undefined ||
        index >= nextCount ||
        mask === 0 ||
        (mask & 0x80) !== 0 ||
        seen.has(index)
      )
        return undefined
      seen.add(index)
      const zone = readJourneyZone(bytes, cursor, mask, next[index])
      if (!zone) return undefined
      next[index] = zone
    }
    if (next.some((zone) => zone.durationSec < 1 || zone.fanMin > zone.fanMax || zone.heatMin > zone.heatMax))
      return undefined
    planJournal.push({ elapsedSec, planRev, zones: next })
    previous = next
  }
  if (cursor.at !== bytes.length) return undefined
  return { initialPlan, planJournal, bytes: envelopeBytes }
}

const planEnvelopeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Hydrate the compact form retained in a run document after its full `.crk` recording is pruned. */
export const decodeStoredPlanEnvelope = (encoded: string): DecodedCrkRoastPlan | undefined => {
  try {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const decoded = decodePlanEnvelope(bytes)
    if (!decoded || decoded.bytes !== bytes.length || decoded.initialPlan.mode === 'calibration') return undefined
    return { initialPlan: decoded.initialPlan, planJournal: decoded.planJournal, planEnvelope: encoded }
  } catch {
    return undefined
  }
}

/**
 * Validate and decode codec-2's device-owned instruction provenance. `undefined` means this is a
 * valid v4 recording without codec-2 plan data, or an invalid file; callers retain their codec-1
 * profile-name fallback in both cases.
 */
export const decodeCrkRoastPlan = (bytes: Uint8Array, expectedId: string): DecodedCrkRoastPlan | undefined => {
  const validation = validateCrkRecording(bytes, expectedId)
  if (!validation.ok || validation.summary.codec !== CODEC_PLAN_DELTA_VARINT) return undefined
  const payload = bytes.subarray(HEADER_V4_BYTES)
  const decoded = decodePlanEnvelope(payload)
  return decoded && decoded.initialPlan.mode !== 'calibration'
    ? {
        initialPlan: decoded.initialPlan,
        planJournal: decoded.planJournal,
        planEnvelope: planEnvelopeBase64(payload.subarray(0, decoded.bytes)),
      }
    : undefined
}

/** Exact device-owned program for a diagnostic calibration recording. */
export const decodeCrkCalibrationProgram = (
  bytes: Uint8Array,
  expectedId: string,
): DecodedCrkCalibrationProgram | undefined => {
  const validation = validateCrkRecording(bytes, expectedId)
  if (!validation.ok || validation.summary.codec !== CODEC_PLAN_DELTA_VARINT) return undefined
  const decoded = decodePlanEnvelope(bytes.subarray(HEADER_V4_BYTES))
  return decoded?.initialPlan.mode === 'calibration'
    ? { program: decoded.initialPlan, thermocoupleOffsetC: validation.summary.thermocoupleOffsetC }
    : undefined
}

/**
 * Validate the same structure, CRC, and delta stream the firmware accepts,
 * then verify the archive header id against the manifest/file id.
 */
export const validateCrkRecording = (bytes: Uint8Array, expectedId: string): CrkValidationResult => {
  if (bytes.length < HEADER_V1_BYTES) {
    return failure('truncated_header', 'the file is shorter than the header its version declares')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== ARCHIVE_MAGIC) {
    return failure('bad_magic', 'the file does not begin with the CRKL archive magic')
  }

  const version = view.getUint16(4, true)
  if (version !== 4) {
    return failure('bad_version', 'the archive is not the provenance-bearing version this firmware accepts (4)')
  }
  if (bytes.length < HEADER_V4_BYTES) {
    return failure('truncated_header', 'the file is shorter than the header its version declares')
  }

  const logId = view.getUint32(8, true)
  const sampleCount = view.getUint32(24, true)
  if (sampleCount > MAX_SAMPLES) {
    return failure('sample_count', 'the header claims more samples than a recording can hold')
  }
  if (view.getUint8(64) > MAX_ZONES) {
    return failure('zone_count', 'the header claims more journey zones than exist')
  }

  const codec = view.getUint8(100)
  const encodedBytes = view.getUint32(92, true)
  if (codec !== CODEC_RAW && codec !== CODEC_DELTA_VARINT && codec !== CODEC_PLAN_DELTA_VARINT) {
    return failure('bad_codec', 'the payload names a codec this firmware cannot decode')
  }
  if (codec === CODEC_RAW && encodedBytes !== sampleCount * RAW_SAMPLE_BYTES) {
    return failure('size_mismatch', 'the file length disagrees with the payload length in its header')
  }
  if (bytes.length !== HEADER_V4_BYTES + encodedBytes) {
    return failure('size_mismatch', 'the file length disagrees with the payload length in its header')
  }

  const deviceId = readFixedAscii(bytes, 104, 24)
  const modelId = readFixedAscii(bytes, 128, 24)
  const displayName = readFixedAscii(bytes, 152, 32)
  const firmwareVersion = readFixedAscii(bytes, 184, 24)
  const originLogId = view.getUint32(208, true)
  const thermocoupleOffsetCenti = view.getInt16(213, true)
  const thermocoupleOffsetPresent = (view.getUint8(215) & 0x01) !== 0
  if (
    !deviceId ||
    !modelId ||
    !displayName ||
    !firmwareVersion ||
    originLogId === 0 ||
    !thermocoupleOffsetPresent ||
    thermocoupleOffsetCenti < -2500 ||
    thermocoupleOffsetCenti > 2500
  ) {
    return failure('provenance', 'the recording has no valid immutable producer identity')
  }
  if (crkCrc32(bytes.subarray(104, 216)) !== view.getUint32(216, true)) {
    return failure('provenance', 'the recording producer identity does not match its checksum')
  }

  const payload = bytes.subarray(HEADER_V4_BYTES)
  if (crkCrc32(archiveIntegrityBytes(bytes.subarray(0, HEADER_V4_BYTES), payload)) !== view.getUint32(96, true)) {
    return failure('crc_mismatch', 'the header identity or payload does not match the checksum stored with it')
  }
  if (codec === CODEC_DELTA_VARINT && !deltaPayloadDecodes(payload, sampleCount)) {
    return failure('payload_undecodable', 'the payload passes its checksum but does not decode as a recording')
  }
  if (codec === CODEC_PLAN_DELTA_VARINT) {
    const plan = decodePlanEnvelope(payload)
    if (!plan || !deltaPayloadDecodes(payload.subarray(plan.bytes), sampleCount)) {
      return failure('payload_undecodable', 'the payload passes its checksum but does not decode as a recording')
    }
  }

  if (!/^[1-9][0-9]*$/.test(expectedId)) {
    return failure('log_id', `the manifest carries invalid recording id ${expectedId}`)
  }
  const manifestId = Number(expectedId)
  if (!Number.isSafeInteger(manifestId) || manifestId >= 0xffffffff) {
    return failure('log_id', `the manifest carries invalid recording id ${expectedId}`)
  }
  if (manifestId !== logId) {
    return failure('log_id', `the recording's header carries id ${logId}, not manifest id ${expectedId}`)
  }

  return {
    ok: true,
    summary: {
      version,
      logId,
      sampleCount,
      encodedBytes,
      codec,
      recordingOrigin: { deviceId, logId: String(originLogId) },
      thermocoupleOffsetC: thermocoupleOffsetCenti / 100,
      roastEndReason: ROAST_END_REASONS[view.getUint8(103)],
    },
  }
}

/** Decode a validated archive locally so one compact transfer supplies both provenance and samples. */
export const decodeCrkThermalSamples = (bytes: Uint8Array, expectedId: string): ThermalSample[] | undefined => {
  const validation = validateCrkRecording(bytes, expectedId)
  if (!validation.ok) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const payload = bytes.subarray(HEADER_V4_BYTES)
  if (validation.summary.codec === CODEC_RAW) {
    const samples: ThermalSample[] = []
    for (let index = 0; index < validation.summary.sampleCount; index += 1) {
      const offset = HEADER_V4_BYTES + index * RAW_SAMPLE_BYTES
      const thermocoupleCenti = view.getInt16(offset + 4, true)
      const coldJunctionCenti = view.getInt16(offset + 6, true)
      samples.push({
        tMs: view.getUint32(offset, true),
        ...(thermocoupleCenti !== -32768 ? { thermocoupleC: thermocoupleCenti / 100 } : {}),
        ...(coldJunctionCenti !== -32768 ? { coldJunctionC: coldJunctionCenti / 100 } : {}),
        effectiveFan: view.getUint16(offset + 8, true) / 1000,
        effectiveHeat: view.getUint16(offset + 10, true) / 1000,
      })
    }
    return samples
  }

  let samplePayload = payload
  if (validation.summary.codec === CODEC_PLAN_DELTA_VARINT) {
    const plan = decodePlanEnvelope(payload)
    if (!plan) return undefined
    samplePayload = payload.subarray(plan.bytes)
  }
  const samples: ThermalSample[] = []
  return decodeDeltaPayload(samplePayload, validation.summary.sampleCount, samples) ? samples : undefined
}
