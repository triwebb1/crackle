/**
 * ============================================================================================
 * THE ARCHIVE FILE, AS BYTES - the mock's half of `GET /logs/<id>.crk` and `POST /api/logs/restore`
 * ============================================================================================
 *
 * The mock has always held its recordings as JavaScript objects, which was enough while the only way
 * off the device was a decoded CSV. Backup changed that: the browser now downloads the STORED FILE
 * and uploads it back, so the mock has to have a file at all - and the file it has must be the one
 * the firmware writes, or a backup taken from the mock would be a backup of a format nothing else
 * reads.
 *
 * So this module is the wire format, ported from `firmware/crackle/crackle/sr800_log_codec.{h,cpp}`
 * and `crackle.ino`'s `LogArchiveHeader`, by byte offset - never by casting a struct, because that is
 * the mistake the firmware's own validator exists to avoid.
 *
 * --------------------------------------------------------------------------------------------
 * THE HEADER, BY OFFSET
 * --------------------------------------------------------------------------------------------
 *
 *     0   u32   magic, "CRKL" = 0x4C4B5243
 *     4   u16   version, 4 (older unprovenanced files fail closed)
 *     6   u8    source: 0 none, 1 proof, 2 calibration, 3 manual, 4 roast
 *     7   u8    reserved
 *     8   u32   logId - MUST equal the id it is being restored under
 *     12  u32   boot count
 *     16  u32   startEpoch, Unix seconds, 0 = the clock never synced
 *     20  u32   durationMs
 *     24  u32   sampleCount
 *     28  u32   intervalMs                                       (v1 ends here, 32 bytes)
 *     32  char  name[32], NOT null-terminated when full
 *     64  u8    zoneCount, at most 12
 *     65  u8    roast mode: 0 legacy/unknown, 1 timed, 2 journey, 3 manual
 *     66  u16   batchMassG, 0 = not a roast / mass unknown
 *     68  u16   zoneAttainedSec[12], 0xFFFF = not attained       (v2 ends here, 92 bytes)
 *     92  u32   encodedBytes - the payload length, whatever the codec
 *     96  u32   crc32 over header metadata/provenance and payload
 *     100 u8    codec: 0 raw v2-shaped, 1 delta-varint
 *     101 u16   roast stop second
 *     103 u8    stable roast end-reason code                      (v3 ends here, 104 bytes)
 *     104 char  source device id[24]
 *     128 char  source model id[24]
 *     152 char  source display name[32]
 *     184 char  source firmware version[24]
 *     208 u32   immutable origin log id
 *     212 u8    provenance flags, bit 0 = simulated
 *     216 u32   provenance CRC32                            (v4 ends here, 220 bytes)
 *
 * **v1 and v2 payloads are a fixed-stride array** of the frozen 12-byte raw record: `u32 tMs`,
 * `i16` thermocouple centi-degrees, `i16` cold-junction centi-degrees, `u16` fan milli, `u16` heat
 * milli, with `-32768` as the missing-reading sentinel. With no checksum to offer, that stride IS
 * their integrity check, so `92 + samples x 12` has to be exact - no trailing byte.
 *
 * **v3 is the delta-varint stream**: five unsigned LEB128 varints per sample, zigzagged against the
 * previous one, temperatures in DECI-degrees and levels in deci-levels. Time carries a second-order
 * predictor (the residual against the previous interval), which is what makes a steady 1 Hz sample
 * cost five bytes rather than six. Token `0` on either temperature channel means "missing", which is
 * why every real delta is `+1`: token 0 can then never collide with a temperature.
 *
 * --------------------------------------------------------------------------------------------
 * WHAT THIS VALIDATOR CHECKS, EXACTLY
 * --------------------------------------------------------------------------------------------
 *
 * All of it, in the firmware's own verdict names, because a mock that accepts what the device
 * refuses does not fail to catch a bug - it certifies one:
 *
 *   `truncated_header` `bad_magic` `bad_version` `sample_count` `zone_count` `bad_codec`
 *   `size_mismatch` `crc_mismatch` `provenance` `payload_undecodable` `log_id`
 *
 * `payload_undecodable` is the one a CRC cannot stand in for: re-checksumming garbage makes it
 * self-consistent, so the payload is DECODED and required to yield exactly `sampleCount` frames
 * ending exactly at `encodedBytes`.
 *
 * Raw binary restore makes the shared format cap the transport ceiling too: firmware streams
 * request chunks to a temp file and validates through a 256-byte read window. The mock buffers in
 * Node for convenience, but enforces the same binary length and verdicts.
 */

import type {
  ArchivedJourneyZone,
  ArchivedPlan,
  ArchivedPlanChange,
  ArchivedTimedStep,
  LogSample,
  LogSource,
  StoredLog,
} from './archive'
import { LOG_CAPACITY_SAMPLES, LOG_INTERVAL_MS } from './config'

export const ARCHIVE_MAGIC = 0x4c4b5243
export const HEADER_V1_BYTES = 32
export const HEADER_V2_BYTES = 92
export const HEADER_V3_BYTES = 104
export const HEADER_V4_BYTES = 220
export const RAW_SAMPLE_BYTES = 12
export const MAX_ZONES = 12
export const NAME_BYTES = 32
export const CODEC_RAW = 0
export const CODEC_DELTA_VARINT = 1
export const CODEC_PLAN_DELTA_VARINT = 2
export const PLAN_ENVELOPE_MAX_BYTES = 1024
export const PLAN_JOURNAL_MAX_EVENTS = 32
const PLAN_ENVELOPE_MAGIC = 0xc7
const PLAN_ENVELOPE_VERSION = 1
/** The centi-degree "no reading" sentinel the raw layout uses. */
const MISSING_CENTI = -32768
const NOT_ATTAINED = 0xffff
const END_REASONS = [
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
] as const

const SOURCES: Array<LogSource | 'none'> = ['none', 'proof', 'calibration', 'manual', 'roast']

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1)
    value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

// ------------------------------------------------------------------------------- the delta codec

/** Round half AWAY FROM ZERO, so a long passive tail does not drift toward zero. */
const deci = (value: number) => (value < 0 ? -1 : 1) * Math.round(Math.abs(value) * 10)
const zigzag = (value: number) => (value << 1) ^ (value >> 31)
const unzigzag = (value: number) => (value >>> 1) ^ -(value & 1)

const putVarint = (out: number[], value: number) => {
  let remaining = value >>> 0
  for (;;) {
    const group = remaining & 0x7f
    remaining = remaining >>> 7
    if (remaining === 0) {
      out.push(group)
      return
    }
    out.push(group | 0x80)
  }
}

interface VarintRead {
  value: number
  next: number
}

const takeVarint = (bytes: Uint8Array, at: number): VarintRead | undefined => {
  let value = 0
  let shift = 0
  for (let index = 0; index < 5; index += 1) {
    if (at + index >= bytes.length) return undefined
    const byte = bytes[at + index]
    value += (byte & 0x7f) * 2 ** shift
    // A token that will not fit a u32 is malformed, not a very large number.
    if (value > 0xffffffff) return undefined
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: at + index + 1 }
    shift += 7
  }
  return undefined
}

export const encodeSamples = (samples: LogSample[]): Uint8Array => {
  const out: number[] = []
  let prevTMs = 0
  let prevDt = 0
  let prevTc = 0
  let prevCj = 0
  let prevFan = 0
  let prevHeat = 0
  for (const [tMs, tcC, cjC, fan, heat] of samples) {
    const dt = Math.round(tMs) - prevTMs
    putVarint(out, zigzag(dt - prevDt))
    prevTMs = Math.round(tMs)
    prevDt = dt
    if (tcC === null) putVarint(out, 0)
    else {
      const value = deci(tcC)
      putVarint(out, zigzag(value - prevTc) + 1)
      prevTc = value
    }
    if (cjC === null) putVarint(out, 0)
    else {
      const value = deci(cjC)
      putVarint(out, zigzag(value - prevCj) + 1)
      prevCj = value
    }
    const fanDeci = deci(fan)
    putVarint(out, zigzag(fanDeci - prevFan))
    prevFan = fanDeci
    const heatDeci = deci(heat)
    putVarint(out, zigzag(heatDeci - prevHeat))
    prevHeat = heatDeci
  }
  return Uint8Array.from(out)
}

/** Decode exactly `count` frames, or undefined if the payload is not that. */
export const decodeSamples = (payload: Uint8Array, count: number): LogSample[] | undefined => {
  const samples: LogSample[] = []
  let at = 0
  let prevTMs = 0
  let prevDt = 0
  let prevTc = 0
  let prevCj = 0
  let prevFan = 0
  let prevHeat = 0
  for (let index = 0; index < count; index += 1) {
    const time = takeVarint(payload, at)
    if (!time) return undefined
    const dt = prevDt + unzigzag(time.value)
    prevTMs += dt
    prevDt = dt
    at = time.next

    const tc = takeVarint(payload, at)
    if (!tc) return undefined
    at = tc.next
    let thermocouple: number | null = null
    if (tc.value !== 0) {
      prevTc += unzigzag(tc.value - 1)
      thermocouple = prevTc / 10
    }

    const cj = takeVarint(payload, at)
    if (!cj) return undefined
    at = cj.next
    let coldJunction: number | null = null
    if (cj.value !== 0) {
      prevCj += unzigzag(cj.value - 1)
      coldJunction = prevCj / 10
    }

    const fan = takeVarint(payload, at)
    if (!fan) return undefined
    at = fan.next
    prevFan += unzigzag(fan.value)

    const heat = takeVarint(payload, at)
    if (!heat) return undefined
    at = heat.next
    prevHeat += unzigzag(heat.value)

    samples.push([prevTMs, thermocouple, coldJunction, prevFan / 10, prevHeat / 10])
  }
  // Exactly the payload, not a prefix of it: trailing bytes mean the file is not what it claims.
  return at === payload.length ? samples : undefined
}

export interface DecodedPlanEnvelope {
  initialPlan: ArchivedPlan
  journal: ArchivedPlanChange[]
  bytes: number
}

const planModeByte = (mode: ArchivedPlan['mode']) =>
  mode === 'timed' ? 1 : mode === 'journey' ? 2 : mode === 'manual' ? 3 : 4
const quantizedLevel = (value: number) => {
  const stored = Math.round(value * 10)
  if (!Number.isFinite(value) || stored < 0 || stored > 100) throw new Error('plan level must be from 0.0 through 10.0')
  return stored
}
const timedStepFields = (step: { fan: number; heat: number; durationSec: number }) => {
  const fan = quantizedLevel(step.fan)
  const heat = quantizedLevel(step.heat)
  if (!Number.isInteger(step.durationSec) || step.durationSec < 1 || step.durationSec > 1800) {
    throw new Error('timed step duration must be a whole number from 1 through 1800 seconds')
  }
  if (fan === 0 && heat > 0) throw new Error('a timed step cannot use heat with fan 0')
  return { fan, heat, durationSec: step.durationSec }
}
const quantizedTemp = (value: number) => {
  const stored = Math.round(value * 10)
  if (!Number.isFinite(value) || stored < -32768 || stored > 32767)
    throw new Error('plan temperature is outside int16 deci-degrees')
  return stored
}
const boundedU16 = (value: number, field: string) => {
  const stored = Math.round(value)
  if (!Number.isFinite(value) || stored < 0 || stored > 0xffff) throw new Error(`${field} is outside uint16`)
  return stored
}
const pushU16 = (out: number[], value: number) => {
  out.push(value & 0xff, (value >>> 8) & 0xff)
}
const putSigned = (out: number[], value: number) => putVarint(out, zigzag(value))

const initialItems = (plan: ArchivedPlan): number =>
  plan.mode === 'timed' || plan.mode === 'calibration'
    ? plan.steps.length
    : plan.mode === 'journey'
      ? plan.zones.length
      : 1

const assertPlanCount = (plan: ArchivedPlan) => {
  const count = initialItems(plan)
  const maximum =
    plan.mode === 'journey' ? MAX_ZONES : plan.mode === 'timed' ? 24 : plan.mode === 'calibration' ? 48 : 1
  if (count < 1 || count > maximum) throw new Error('initial plan item count is outside its bounded format')
}

const putJourneyZone = (out: number[], zone: ArchivedJourneyZone, mask = 0x7f) => {
  if (mask & 0x01) putSigned(out, quantizedTemp(zone.startC))
  if (mask & 0x02) putSigned(out, quantizedTemp(zone.endC))
  if (mask & 0x04) putVarint(out, boundedU16(zone.durationSec, 'duration'))
  if (mask & 0x08) out.push(quantizedLevel(zone.fanMin))
  if (mask & 0x10) out.push(quantizedLevel(zone.fanMax))
  if (mask & 0x20) out.push(quantizedLevel(zone.heatMin))
  if (mask & 0x40) out.push(quantizedLevel(zone.heatMax))
}

const zoneMask = (before: ArchivedJourneyZone | undefined, after: ArchivedJourneyZone) => {
  if (!before) return 0x7f
  let mask = 0
  if (quantizedTemp(before.startC) !== quantizedTemp(after.startC)) mask |= 0x01
  if (quantizedTemp(before.endC) !== quantizedTemp(after.endC)) mask |= 0x02
  if (boundedU16(before.durationSec, 'duration') !== boundedU16(after.durationSec, 'duration')) mask |= 0x04
  if (quantizedLevel(before.fanMin) !== quantizedLevel(after.fanMin)) mask |= 0x08
  if (quantizedLevel(before.fanMax) !== quantizedLevel(after.fanMax)) mask |= 0x10
  if (quantizedLevel(before.heatMin) !== quantizedLevel(after.heatMin)) mask |= 0x20
  if (quantizedLevel(before.heatMax) !== quantizedLevel(after.heatMax)) mask |= 0x40
  return mask
}

/**
 * Compact immutable roast provenance. The initial plan is stored once. Journey edits carry a
 * delta-compressed full plan; manual events carry requested and effective fan/heat levels. Thirty-two
 * accepted edits is the explicit archive bound; pathological browser chatter cannot consume a log.
 */
export const encodePlanEnvelope = (initialPlan: ArchivedPlan, journal: ArchivedPlanChange[] = []): Uint8Array => {
  assertPlanCount(initialPlan)
  if (journal.length > PLAN_JOURNAL_MAX_EVENTS) throw new Error('plan journal exceeds the 32-event archive bound')
  if (initialPlan.mode === 'calibration' && journal.length !== 0)
    throw new Error('calibration provenance cannot carry a plan journal')
  const out: number[] = [
    PLAN_ENVELOPE_MAGIC,
    PLAN_ENVELOPE_VERSION,
    planModeByte(initialPlan.mode),
    initialItems(initialPlan),
    journal.length,
    0,
    0,
  ]
  if (initialPlan.mode === 'calibration') {
    const minimumDwell = boundedU16(initialPlan.minStepSeconds, 'minimum dwell')
    const settleSeconds = boundedU16(initialPlan.settleSeconds, 'settle seconds')
    const settleBandTenths = Math.round(initialPlan.settleBandC * 10)
    if (
      minimumDwell < 5 ||
      minimumDwell > 120 ||
      settleSeconds < 2 ||
      settleSeconds > 30 ||
      !Number.isFinite(initialPlan.settleBandC) ||
      settleBandTenths < 2 ||
      settleBandTenths > 100
    ) {
      throw new Error('calibration settle metadata is outside its bounded format')
    }
    const maximumDwell = boundedU16(initialPlan.maxStepSeconds, 'maximum dwell')
    if (maximumDwell < minimumDwell) throw new Error('calibration maximum dwell must cover its minimum dwell')
    out.push(minimumDwell, settleSeconds, settleBandTenths)
    for (const step of initialPlan.steps) {
      const stored = timedStepFields({ fan: step.fan, heat: step.heat, durationSec: maximumDwell })
      out.push(stored.fan, stored.heat)
      pushU16(out, stored.durationSec)
    }
  } else if (initialPlan.mode === 'timed') {
    for (const step of initialPlan.steps) {
      const stored = timedStepFields(step)
      out.push(stored.fan, stored.heat)
      pushU16(out, stored.durationSec)
    }
  } else if (initialPlan.mode === 'journey') {
    for (const zone of initialPlan.zones) putJourneyZone(out, zone)
  } else {
    out.push(quantizedLevel(initialPlan.fan), quantizedLevel(initialPlan.heat))
  }

  let previous = initialPlan.mode === 'journey' ? initialPlan.zones : []
  let timedStepCount = initialPlan.mode === 'timed' ? initialPlan.steps.length : 0
  let previousElapsed = 0
  let previousRevision = 0
  for (const event of journal) {
    const elapsed = boundedU16(event.elapsed_sec, 'elapsed_sec')
    if (!Number.isInteger(event.plan_rev) || event.plan_rev < 1 || event.plan_rev > 0xffffffff)
      throw new Error('plan_rev is outside uint32')
    if (elapsed < previousElapsed) throw new Error('plan journal elapsed_sec must not move backwards')
    if (event.plan_rev <= previousRevision) throw new Error('plan journal plan_rev must increase')
    putVarint(out, elapsed)
    putVarint(out, event.plan_rev)
    previousElapsed = elapsed
    previousRevision = event.plan_rev
    if (initialPlan.mode === 'timed') {
      if (
        !('step' in event) ||
        !Number.isInteger(event.step_index) ||
        event.step_index < 0 ||
        event.step_index >= 24 ||
        event.step_index > timedStepCount
      )
        throw new Error('a timed journal event must replace an existing step or append the next one')
      const stored = timedStepFields(event.step)
      out.push(event.step_index, stored.fan, stored.heat)
      pushU16(out, stored.durationSec)
      if (event.step_index === timedStepCount) timedStepCount += 1
      continue
    }
    if (initialPlan.mode === 'manual') {
      if (!('requested_fan' in event)) throw new Error('a manual journal event must carry accepted levels')
      out.push(
        quantizedLevel(event.requested_fan),
        quantizedLevel(event.requested_heat),
        quantizedLevel(event.effective_fan),
        quantizedLevel(event.effective_heat),
      )
      continue
    }
    if (initialPlan.mode !== 'journey') throw new Error('calibration provenance cannot carry a plan journal')
    if (!('change' in event) || event.change.length < 1 || event.change.length > MAX_ZONES)
      throw new Error('journal zone count is outside its bounded format')
    out.push(event.change.length)
    const patches = event.change
      .map((zone, index) => ({ index, zone, mask: zoneMask(previous[index], zone) }))
      .filter((patch) => patch.mask !== 0)
    out.push(patches.length)
    for (const patch of patches) {
      out.push(patch.index, patch.mask)
      putJourneyZone(out, patch.zone, patch.mask)
    }
    previous = event.change
  }
  if (out.length > PLAN_ENVELOPE_MAX_BYTES) throw new Error('plan envelope exceeds its 1024-byte archive bound')
  out[5] = out.length & 0xff
  out[6] = (out.length >>> 8) & 0xff
  return Uint8Array.from(out)
}

const readPlanVarint = (bytes: Uint8Array, cursor: { at: number }): number | undefined => {
  const read = takeVarint(bytes, cursor.at)
  if (!read) return undefined
  cursor.at = read.next
  return read.value
}
const readPlanByte = (bytes: Uint8Array, cursor: { at: number }): number | undefined =>
  cursor.at < bytes.length ? bytes[cursor.at++] : undefined
const readPlanU16 = (bytes: Uint8Array, cursor: { at: number }): number | undefined => {
  if (cursor.at + 2 > bytes.length) return undefined
  const value = bytes[cursor.at] | (bytes[cursor.at + 1] << 8)
  cursor.at += 2
  return value
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
    const v = readPlanVarint(bytes, cursor)
    if (v === undefined) return
    zone.startC = unzigzag(v) / 10
  }
  if (mask & 0x02) {
    const v = readPlanVarint(bytes, cursor)
    if (v === undefined) return
    zone.endC = unzigzag(v) / 10
  }
  if (mask & 0x04) {
    const v = readPlanVarint(bytes, cursor)
    if (v === undefined) return
    zone.durationSec = v
  }
  const levelFields: Array<[number, keyof Pick<ArchivedJourneyZone, 'fanMin' | 'fanMax' | 'heatMin' | 'heatMax'>]> = [
    [0x08, 'fanMin'],
    [0x10, 'fanMax'],
    [0x20, 'heatMin'],
    [0x40, 'heatMax'],
  ]
  for (const [bit, field] of levelFields)
    if (mask & bit) {
      const value = readPlanByte(bytes, cursor)
      if (value === undefined || value > 100) return
      zone[field] = value / 10
    }
  return zone
}

export const decodePlanEnvelope = (payload: Uint8Array): DecodedPlanEnvelope | undefined => {
  if (payload.length < 7 || payload[0] !== PLAN_ENVELOPE_MAGIC || payload[1] !== PLAN_ENVELOPE_VERSION) return
  const bytes = payload.subarray(0, payload[5] | (payload[6] << 8))
  if (bytes.length < 7 || bytes.length > PLAN_ENVELOPE_MAX_BYTES) return
  const mode = bytes[2]
  const count = bytes[3]
  const eventCount = bytes[4]
  if (eventCount > PLAN_JOURNAL_MAX_EVENTS) return
  const cursor = { at: 7 }
  let initialPlan: ArchivedPlan
  if (mode === 1) {
    if (count < 1 || count > 24) return
    const steps = []
    for (let index = 0; index < count; index += 1) {
      const fan = readPlanByte(bytes, cursor),
        heat = readPlanByte(bytes, cursor),
        durationSec = readPlanU16(bytes, cursor)
      if (
        fan === undefined ||
        heat === undefined ||
        durationSec === undefined ||
        fan > 100 ||
        heat > 100 ||
        durationSec < 1 ||
        durationSec > 1800 ||
        (fan === 0 && heat > 0)
      )
        return
      steps.push({ fan: fan / 10, heat: heat / 10, durationSec })
    }
    initialPlan = { mode: 'timed', steps }
  } else if (mode === 2) {
    if (count < 1 || count > MAX_ZONES) return
    const zones: ArchivedJourneyZone[] = []
    for (let index = 0; index < count; index += 1) {
      const zone = readJourneyZone(bytes, cursor, 0x7f)
      if (!zone) return
      zones.push(zone)
    }
    initialPlan = { mode: 'journey', zones }
  } else if (mode === 3) {
    if (count !== 1) return
    const fan = readPlanByte(bytes, cursor),
      heat = readPlanByte(bytes, cursor)
    if (fan === undefined || heat === undefined || fan > 100 || heat > 100) return
    initialPlan = { mode: 'manual', fan: fan / 10, heat: heat / 10 }
  } else if (mode === 4) {
    if (count < 1 || count > 48 || eventCount !== 0) return
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
      return
    const steps: ArchivedTimedStep[] = []
    for (let index = 0; index < count; index += 1) {
      const fan = readPlanByte(bytes, cursor),
        heat = readPlanByte(bytes, cursor),
        durationSec = readPlanU16(bytes, cursor)
      if (
        fan === undefined ||
        heat === undefined ||
        durationSec === undefined ||
        fan > 100 ||
        heat > 100 ||
        (fan === 0 && heat > 0) ||
        durationSec < minStepSeconds ||
        durationSec > 1800
      )
        return
      steps.push({ fan: fan / 10, heat: heat / 10, durationSec })
    }
    if (steps.some((step) => step.durationSec !== steps[0].durationSec) || cursor.at !== bytes.length) return
    initialPlan = {
      mode: 'calibration',
      steps,
      maxStepSeconds: steps[0].durationSec,
      minStepSeconds,
      settleSeconds,
      settleBandC: settleBandTenthsC / 10,
    }
    return { initialPlan, journal: [], bytes: bytes.length }
  } else return

  const journal: ArchivedPlanChange[] = []
  let previous = initialPlan.mode === 'journey' ? initialPlan.zones : []
  let timedStepCount = initialPlan.mode === 'timed' ? initialPlan.steps.length : 0
  let previousElapsed = 0
  let previousRevision = 0
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const elapsed = readPlanVarint(bytes, cursor),
      planRev = readPlanVarint(bytes, cursor)
    if (
      elapsed === undefined ||
      elapsed > 0xffff ||
      planRev === undefined ||
      planRev <= previousRevision ||
      elapsed < previousElapsed
    )
      return
    previousElapsed = elapsed
    previousRevision = planRev
    if (initialPlan.mode === 'timed') {
      const stepIndex = readPlanByte(bytes, cursor),
        fan = readPlanByte(bytes, cursor),
        heat = readPlanByte(bytes, cursor),
        durationSec = readPlanU16(bytes, cursor)
      if (
        stepIndex === undefined ||
        stepIndex >= 24 ||
        stepIndex > timedStepCount ||
        fan === undefined ||
        heat === undefined ||
        durationSec === undefined ||
        durationSec < 1 ||
        durationSec > 1800 ||
        fan > 100 ||
        heat > 100 ||
        (fan === 0 && heat > 0)
      )
        return
      journal.push({
        elapsed_sec: elapsed,
        plan_rev: planRev,
        step_index: stepIndex,
        step: { fan: fan / 10, heat: heat / 10, durationSec },
      })
      if (stepIndex === timedStepCount) timedStepCount += 1
      continue
    }
    if (initialPlan.mode === 'manual') {
      const requestedFan = readPlanByte(bytes, cursor),
        requestedHeat = readPlanByte(bytes, cursor)
      const effectiveFan = readPlanByte(bytes, cursor),
        effectiveHeat = readPlanByte(bytes, cursor)
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
        return
      journal.push({
        elapsed_sec: elapsed,
        plan_rev: planRev,
        requested_fan: requestedFan / 10,
        requested_heat: requestedHeat / 10,
        effective_fan: effectiveFan / 10,
        effective_heat: effectiveHeat / 10,
      })
      continue
    }
    if (initialPlan.mode !== 'journey') return
    const nextCount = readPlanByte(bytes, cursor),
      patchCount = readPlanByte(bytes, cursor)
    if (
      nextCount === undefined ||
      patchCount === undefined ||
      nextCount < 1 ||
      nextCount > MAX_ZONES ||
      patchCount > nextCount
    )
      return
    const next = previous.slice(0, nextCount).map((zone) => ({ ...zone }))
    while (next.length < nextCount)
      next.push({ startC: 0, endC: 0, durationSec: 0, fanMin: 0, fanMax: 0, heatMin: 0, heatMax: 0 })
    const seen = new Set<number>()
    for (let patchIndex = 0; patchIndex < patchCount; patchIndex += 1) {
      const index = readPlanByte(bytes, cursor),
        mask = readPlanByte(bytes, cursor)
      if (
        index === undefined ||
        mask === undefined ||
        index >= nextCount ||
        mask === 0 ||
        (mask & 0x80) !== 0 ||
        seen.has(index)
      )
        return
      seen.add(index)
      const zone = readJourneyZone(bytes, cursor, mask, next[index])
      if (!zone) return
      next[index] = zone
    }
    if (next.some((zone) => zone.durationSec <= 0 || zone.fanMin > zone.fanMax || zone.heatMin > zone.heatMax)) return
    journal.push({ elapsed_sec: elapsed, plan_rev: planRev, change: next })
    previous = next
  }
  if (cursor.at !== bytes.length) return
  return { initialPlan, journal, bytes: bytes.length }
}

// ------------------------------------------------------------------------------ the raw v1/v2 payload

const decodeRawSamples = (payload: Uint8Array, count: number): LogSample[] => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const samples: LogSample[] = []
  for (let index = 0; index < count; index += 1) {
    const at = index * RAW_SAMPLE_BYTES
    const tc = view.getInt16(at + 4, true)
    const cj = view.getInt16(at + 6, true)
    samples.push([
      view.getUint32(at, true),
      tc === MISSING_CENTI ? null : tc / 100,
      cj === MISSING_CENTI ? null : cj / 100,
      view.getUint16(at + 8, true) / 1000,
      view.getUint16(at + 10, true) / 1000,
    ])
  }
  return samples
}

// -------------------------------------------------------------------------------------- the file

export const headerBytesFor = (version: number) =>
  version === 1 ? HEADER_V1_BYTES : version === 2 ? HEADER_V2_BYTES : version === 3 ? HEADER_V3_BYTES : HEADER_V4_BYTES

export const archiveFileBytes = (log: StoredLog): number =>
  HEADER_V4_BYTES +
  (log.initialPlan ? encodePlanEnvelope(log.initialPlan, log.planJournal).length : 0) +
  encodeSamples(log.samples).length

const writeFixedAscii = (out: Uint8Array, offset: number, length: number, value: string) => {
  out.set(new TextEncoder().encode(value).subarray(0, Math.max(0, length - 1)), offset)
}
const readFixedAscii = (bytes: Uint8Array, offset: number, length: number): string | undefined => {
  const field = bytes.subarray(offset, offset + length)
  const end = field.indexOf(0)
  const used = end < 0 ? field : field.subarray(0, end)
  if (used.length === 0 || used.some((byte) => byte < 0x20 || byte > 0x7e || byte === 0x22 || byte === 0x5c)) return
  return new TextDecoder().decode(used)
}
const integrityBytes = (header: Uint8Array, payload: Uint8Array) =>
  Uint8Array.from([...header.subarray(0, 96), ...header.subarray(100, HEADER_V4_BYTES), ...payload])
/** One stored recording, as the file the device holds. Its own version, not a re-encoding. */
export const encodeArchiveFile = (log: StoredLog): Uint8Array => {
  if (
    log.version !== 4 ||
    !log.recordedOn ||
    !log.recordingOriginLogId ||
    !Number.isFinite(log.thermocoupleOffsetC) ||
    log.thermocoupleOffsetC! < -25 ||
    log.thermocoupleOffsetC! > 25
  ) {
    throw new Error('only complete provenance-bearing version 4 recordings can be encoded')
  }
  const samplePayload = encodeSamples(log.samples)
  const planPayload = log.initialPlan ? encodePlanEnvelope(log.initialPlan, log.planJournal) : new Uint8Array()
  const payload = planPayload.length > 0 ? Uint8Array.from([...planPayload, ...samplePayload]) : samplePayload
  const out = new Uint8Array(HEADER_V4_BYTES + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, ARCHIVE_MAGIC, true)
  view.setUint16(4, 4, true)
  view.setUint8(6, Math.max(0, SOURCES.indexOf(log.source)))
  view.setUint32(8, Number(log.id) || 0, true)
  view.setUint32(12, log.boot, true)
  view.setUint32(16, log.startEpoch, true)
  view.setUint32(20, log.samples.at(-1)?.[0] ?? 0, true)
  view.setUint32(24, log.samples.length, true)
  view.setUint32(28, log.intervalMs, true)
  out.set(new TextEncoder().encode(log.name ?? '').subarray(0, NAME_BYTES), 32)
  view.setUint8(64, Math.min(MAX_ZONES, log.zoneCount ?? 0))
  view.setUint8(65, log.source !== 'roast' ? 0 : log.roastMode === 'manual' ? 3 : log.roastMode === 'journey' ? 2 : 1)
  view.setUint16(66, log.batchMassG ?? 0, true)
  for (let zone = 0; zone < MAX_ZONES; zone += 1) {
    const attained = (log.zoneAttainedSec ?? [])[zone]
    view.setUint16(68 + zone * 2, attained === undefined || attained === null ? NOT_ATTAINED : attained, true)
  }
  view.setUint32(92, payload.length, true)
  view.setUint8(100, planPayload.length > 0 ? CODEC_PLAN_DELTA_VARINT : CODEC_DELTA_VARINT)
  if (log.roastEndReason !== undefined && log.roastStopSec !== undefined) {
    view.setUint16(101, Math.max(0, Math.min(0xffff, Math.round(log.roastStopSec))), true)
    view.setUint8(103, Math.max(0, END_REASONS.indexOf(log.roastEndReason)))
  }
  writeFixedAscii(out, 104, 24, log.recordedOn.deviceId)
  writeFixedAscii(out, 128, 24, log.recordedOn.modelId)
  writeFixedAscii(out, 152, 32, log.recordedOn.displayNameAtCapture)
  writeFixedAscii(out, 184, 24, log.recordedOn.firmwareVersion)
  view.setUint32(208, Number(log.recordingOriginLogId), true)
  view.setUint8(212, (log.recordedOn.simulated ? 1 : 0) | (log.passiveTailComplete === false ? 2 : 0))
  view.setInt16(213, Math.round(log.thermocoupleOffsetC! * 100), true)
  view.setUint8(215, 1)
  view.setUint32(216, crc32(out.subarray(104, 216)), true)
  out.set(payload, HEADER_V4_BYTES)
  view.setUint32(96, crc32(integrityBytes(out.subarray(0, HEADER_V4_BYTES), payload)), true)
  return out
}
export type ArchiveVerdict =
  | 'ok'
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

export const VERDICT_REASON: Record<ArchiveVerdict, string> = {
  ok: 'the recording is valid',
  truncated_header: 'the file is shorter than the header its version declares',
  bad_magic: 'the file does not begin with CRKL, so it is not an archive file',
  bad_version: 'the file is not the provenance-bearing archive version this firmware accepts',
  sample_count: 'the file claims more samples than the recorder could ever have held',
  zone_count: 'the file claims more journey zones than exist',
  bad_codec: 'the file was written by a codec this firmware cannot decode',
  size_mismatch: 'the file length disagrees with the payload length it declares',
  crc_mismatch: 'the header identity or payload does not match its stored checksum',
  provenance: 'the recording has no valid immutable producer identity',
  payload_undecodable: 'the payload checksums correctly and is not a recording',
  log_id: 'the header names a different recording than the id it is being restored under',
}
export interface ArchiveRead {
  verdict: ArchiveVerdict
  log?: StoredLog
}

/**
 * Validate a `.crk` file whole, then rebuild the recording from it.
 *
 * Nothing reaches the archive until the entire file passes - the firmware's rule, and the reason
 * `validateArchiveBuffer` is a pure function over there rather than a call into the serving reader.
 */
export const readArchiveFile = (bytes: Uint8Array, expectedId: string): ArchiveRead => {
  if (bytes.length < HEADER_V1_BYTES) return { verdict: 'truncated_header' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== ARCHIVE_MAGIC) return { verdict: 'bad_magic' }
  if (view.getUint16(4, true) !== 4) return { verdict: 'bad_version' }
  if (bytes.length < HEADER_V4_BYTES) return { verdict: 'truncated_header' }
  const sampleCount = view.getUint32(24, true)
  if (sampleCount > LOG_CAPACITY_SAMPLES) return { verdict: 'sample_count' }
  const zoneCount = view.getUint8(64)
  if (zoneCount > MAX_ZONES) return { verdict: 'zone_count' }
  const codec = view.getUint8(100)
  if (codec !== CODEC_RAW && codec !== CODEC_DELTA_VARINT && codec !== CODEC_PLAN_DELTA_VARINT)
    return { verdict: 'bad_codec' }
  const encodedBytes = view.getUint32(92, true)
  if (codec === CODEC_RAW && encodedBytes !== sampleCount * RAW_SAMPLE_BYTES) return { verdict: 'size_mismatch' }
  if (bytes.length !== HEADER_V4_BYTES + encodedBytes) return { verdict: 'size_mismatch' }

  const deviceId = readFixedAscii(bytes, 104, 24)
  const modelId = readFixedAscii(bytes, 128, 24)
  const displayNameAtCapture = readFixedAscii(bytes, 152, 32)
  const firmwareVersion = readFixedAscii(bytes, 184, 24)
  const originLogId = view.getUint32(208, true)
  const thermocoupleOffsetCenti = view.getInt16(213, true)
  if (
    !deviceId ||
    !modelId ||
    !displayNameAtCapture ||
    !firmwareVersion ||
    originLogId === 0 ||
    (view.getUint8(215) & 1) === 0 ||
    thermocoupleOffsetCenti < -2500 ||
    thermocoupleOffsetCenti > 2500
  )
    return { verdict: 'provenance' }
  if (crc32(bytes.subarray(104, 216)) !== view.getUint32(216, true)) return { verdict: 'provenance' }

  const payload = bytes.subarray(HEADER_V4_BYTES)
  if (crc32(integrityBytes(bytes.subarray(0, HEADER_V4_BYTES), payload)) !== view.getUint32(96, true)) {
    return { verdict: 'crc_mismatch' }
  }
  const plan = codec === CODEC_PLAN_DELTA_VARINT ? decodePlanEnvelope(payload) : undefined
  if (codec === CODEC_PLAN_DELTA_VARINT && !plan) return { verdict: 'payload_undecodable' }
  const samples =
    codec === CODEC_RAW
      ? decodeRawSamples(payload, sampleCount)
      : decodeSamples(plan ? payload.subarray(plan.bytes) : payload, sampleCount)
  if (!samples) return { verdict: 'payload_undecodable' }

  const logId = view.getUint32(8, true)
  if (expectedId !== 'auto' && String(logId) !== expectedId) return { verdict: 'log_id' }
  const source = SOURCES[view.getUint8(6)]
  const roastModeByte = view.getUint8(65)
  const roastMode =
    source !== 'roast'
      ? undefined
      : roastModeByte === 3
        ? ('manual' as const)
        : roastModeByte === 2
          ? ('journey' as const)
          : roastModeByte === 1
            ? ('timed' as const)
            : zoneCount > 0
              ? ('journey' as const)
              : ('timed' as const)
  const roastEndReason = END_REASONS[view.getUint8(103)]
  const roastStopSec = roastEndReason === undefined ? undefined : view.getUint16(101, true)
  const attained: Array<number | null> = []
  for (let zone = 0; zone < zoneCount; zone += 1) {
    const value = view.getUint16(68 + zone * 2, true)
    attained.push(value === NOT_ATTAINED ? null : value)
  }
  return {
    verdict: 'ok',
    log: {
      id: String(logId),
      boot: view.getUint32(12, true),
      source: source === undefined || source === 'none' ? 'manual' : source,
      startEpoch: view.getUint32(16, true),
      intervalMs: view.getUint32(28, true) || LOG_INTERVAL_MS,
      version: 4,
      recordedOn: {
        deviceId,
        modelId,
        displayNameAtCapture,
        simulated: (view.getUint8(212) & 1) !== 0,
        firmwareVersion,
        identitySource: 'roaster',
      },
      recordingOriginLogId: String(originLogId),
      thermocoupleOffsetC: thermocoupleOffsetCenti / 100,
      samples,
      name: new TextDecoder().decode(bytes.subarray(32, 64)).replace(/\0+$/, ''),
      batchMassG: view.getUint16(66, true),
      zoneCount,
      zoneAttainedSec: attained,
      roastMode,
      roastStopSec,
      roastEndReason,
      passiveTailComplete: (view.getUint8(212) & 2) === 0,
      encodedBytes,
      ...(plan ? { initialPlan: plan.initialPlan, planJournal: plan.journal } : {}),
    },
  }
}
