import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Archive, type LogSample, type StoredLog } from './archive'
import { ARCHIVE_RESERVE_BYTES, ARCHIVE_TOTAL_BYTES } from './config'
import {
  ARCHIVE_MAGIC,
  archiveFileBytes,
  CODEC_PLAN_DELTA_VARINT,
  CODEC_RAW,
  crc32,
  decodePlanEnvelope,
  decodeSamples,
  encodeArchiveFile,
  encodePlanEnvelope,
  encodeSamples,
  HEADER_V4_BYTES,
  PLAN_ENVELOPE_MAX_BYTES,
  PLAN_JOURNAL_MAX_EVENTS,
  readArchiveFile,
} from './crkFile'
import { MockDevice } from './device'
import { createRouter } from './routes'

/**
 * ============================================================================================
 * THE MOCK'S ARCHIVE FILE, AGAINST THE FIRMWARE'S OWN RULES
 * ============================================================================================
 *
 * A mock whose semantics differ from the device does not fail to catch a bug - it certifies one. The
 * app's backup path now downloads a stored file and uploads it back, so the mock has to have a file,
 * and the file has to be the one `sr800_log_codec` writes and validates. Every verdict name below is
 * the firmware's, and every rule is checked here rather than assumed.
 *
 * The device now streams multipart bytes to a temp file, so the format's 121,244-byte cap is the
 * actual ceiling rather than a heap-dependent promise. The mock enforces that same binary length.
 */

const samples = (count: number): LogSample[] =>
  Array.from({ length: count }, (_value, index) => [
    index * 1000,
    index === 7 ? null : Math.round((25 + index * 0.37) * 100) / 100,
    Math.round((22 + index * 0.01) * 100) / 100,
    Math.round((5 + (index % 5) * 0.1) * 10) / 10,
    Math.round((6 + (index % 3) * 0.1) * 10) / 10,
  ])

const stored = (overrides: Partial<StoredLog> = {}): StoredLog => ({
  id: '41',
  boot: 3,
  source: 'roast',
  startEpoch: 1785000000,
  intervalMs: 1000,
  version: 4,
  recordedOn: {
    deviceId: 'source-device',
    modelId: 'crackle-sr800',
    displayNameAtCapture: 'Source roaster',
    simulated: false,
    firmwareVersion: 'test-fw',
    identitySource: 'roaster',
  },
  recordingOriginLogId: '41',
  thermocoupleOffsetC: -3,
  name: 'ethiopia-yirg',
  batchMassG: 225,
  zoneCount: 3,
  zoneAttainedSec: [120, 310, null],
  samples: samples(40),
  ...overrides,
})

const withEncoded = (log: StoredLog): StoredLog =>
  log.version === 4 ? { ...log, encodedBytes: encodeSamples(log.samples).length } : log
const refreshIntegrityCrc = (file: Uint8Array) => {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  view.setUint32(
    96,
    crc32(
      Uint8Array.from([
        ...file.subarray(0, 96),
        ...file.subarray(100, HEADER_V4_BYTES),
        ...file.subarray(HEADER_V4_BYTES),
      ]),
    ),
    true,
  )
}

const encodeRawArchive = (log: StoredLog): Uint8Array => {
  const deltaFile = encodeArchiveFile({ ...log, initialPlan: undefined, planJournal: undefined })
  const payload = new Uint8Array(log.samples.length * 12)
  const raw = new DataView(payload.buffer)
  log.samples.forEach(([tMs, tcC, cjC, fan, heat], index) => {
    const at = index * 12
    raw.setUint32(at, Math.round(tMs), true)
    raw.setInt16(at + 4, tcC === null ? -32768 : Math.round(tcC * 100), true)
    raw.setInt16(at + 6, cjC === null ? -32768 : Math.round(cjC * 100), true)
    raw.setUint16(at + 8, Math.round(fan * 1000), true)
    raw.setUint16(at + 10, Math.round(heat * 1000), true)
  })
  const file = new Uint8Array(HEADER_V4_BYTES + payload.length)
  file.set(deltaFile.subarray(0, HEADER_V4_BYTES))
  file.set(payload, HEADER_V4_BYTES)
  const view = new DataView(file.buffer)
  view.setUint32(92, payload.length, true)
  view.setUint8(100, CODEC_RAW)
  refreshIntegrityCrc(file)
  return file
}
describe('the delta-varint codec', () => {
  it('round-trips every sample, including the dropout, at the archive quantum', () => {
    const original = samples(40)
    const decoded = decodeSamples(encodeSamples(original), original.length)
    expect(decoded).toHaveLength(40)
    // Temperatures come back in TENTHS - lossy on purpose, and the only arithmetic a reader may do
    // to the stored integer is divide it by ten.
    decoded?.forEach((sample, index) => {
      expect(sample[0]).toBe(original[index][0])
      if (original[index][1] === null) expect(sample[1]).toBeNull()
      // The stored value, exactly: the measurement rounded half away from zero into tenths. The
      // round trip is `decode(encode(x)) === quantize(x)`, not `=== x`, and the difference is the
      // whole reason the archive stores tenths rather than the hundredths RAM carries.
      else expect(sample[1]).toBe(Math.round((original[index][1] as number) * 10) / 10)
      expect(sample[3]).toBeCloseTo(original[index][3], 5)
    })
  })

  /** A steady 1 Hz recording is five bytes a sample: five varints, all of them one byte. */
  it('spends five bytes on a steady sample', () => {
    const steady: LogSample[] = Array.from({ length: 100 }, (_value, index) => [
      index * 1000,
      100 + index * 0.1,
      22,
      5,
      6,
    ])
    expect(encodeSamples(steady).length / 100).toBeCloseTo(5, 1)
  })

  it('refuses a payload that is a prefix of a recording rather than a recording', () => {
    const payload = encodeSamples(samples(20))
    expect(decodeSamples(payload.subarray(0, payload.length - 1), 20)).toBeUndefined()
    // And a trailing byte is as wrong as a missing one: the frame count has to end at the length.
    const extra = new Uint8Array(payload.length + 1)
    extra.set(payload)
    expect(decodeSamples(extra, 20)).toBeUndefined()
  })

  it('checksums with the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })
  it('accepts the firmware reserved raw v4 codec and enforces its fixed stride', () => {
    const original = stored({ samples: samples(12) })
    const raw = encodeRawArchive(original)
    expect(readArchiveFile(raw, '41')).toMatchObject({
      verdict: 'ok',
      log: { id: '41', samples: expect.arrayContaining([[0, 25, 22, 5, 6]]) },
    })
    expect(readArchiveFile(raw.subarray(0, raw.length - 1), '41').verdict).toBe('size_mismatch')
  })
})

describe('compact roast-plan provenance', () => {
  const initial = {
    mode: 'journey' as const,
    zones: [
      { startC: 25, endC: 150, durationSec: 180, fanMin: 2, fanMax: 8, heatMin: 1, heatMax: 10 },
      { startC: 150, endC: 205, durationSec: 240, fanMin: 3, fanMax: 10, heatMin: 0, heatMax: 9 },
    ],
  }

  it('round-trips the immutable initial plan and timestamped accepted deltas', () => {
    const journal = [
      {
        elapsed_sec: 71,
        plan_rev: 2,
        change: [initial.zones[0], { ...initial.zones[1], endC: 207, durationSec: 260 }],
      },
      {
        elapsed_sec: 140,
        plan_rev: 3,
        change: [initial.zones[0], { ...initial.zones[1], endC: 208, durationSec: 260 }],
      },
    ]
    const bytes = encodePlanEnvelope(initial, journal)
    expect(bytes.length).toBeLessThan(80)
    expect(decodePlanEnvelope(bytes)).toEqual({ initialPlan: initial, journal, bytes: bytes.length })

    const log = stored({ initialPlan: initial, planJournal: journal })
    const file = encodeArchiveFile(log)
    expect(new DataView(file.buffer).getUint8(100)).toBe(CODEC_PLAN_DELTA_VARINT)
    const restored = readArchiveFile(file, '41')
    expect(restored.verdict).toBe('ok')
    expect(restored.log?.initialPlan).toEqual(initial)
    expect(restored.log?.planJournal).toEqual(journal)
  })

  it('round-trips timed replacements and appends but refuses a step-list hole', () => {
    const timed = {
      mode: 'timed' as const,
      steps: [
        { fan: 4, heat: 5, durationSec: 30 },
        { fan: 5, heat: 6, durationSec: 40 },
      ],
    }
    const journal = [
      { elapsed_sec: 5, plan_rev: 2, step_index: 0, step: { fan: 4, heat: 6, durationSec: 30 } },
      { elapsed_sec: 9, plan_rev: 3, step_index: 2, step: { fan: 7, heat: 5, durationSec: 45 } },
    ]
    const bytes = encodePlanEnvelope(timed, journal)
    expect(decodePlanEnvelope(bytes)).toEqual({ initialPlan: timed, journal, bytes: bytes.length })

    expect(() => encodePlanEnvelope(timed, [journal[1], journal[0]])).toThrow(/elapsed_sec must not move backwards/)
    expect(() =>
      encodePlanEnvelope(timed, [
        { ...journal[0], plan_rev: 2 },
        { ...journal[1], plan_rev: 2 },
      ]),
    ).toThrow(/plan_rev must increase/)
    expect(() => encodePlanEnvelope({ mode: 'timed', steps: [{ fan: 0, heat: 5, durationSec: 30 }] })).toThrow(
      /heat with fan 0/,
    )
    expect(() => encodePlanEnvelope({ mode: 'timed', steps: [{ fan: 4, heat: 5, durationSec: 1801 }] })).toThrow(
      /1 through 1800/,
    )
    expect(() => encodePlanEnvelope(timed, [{ ...journal[0], step: { ...journal[0].step, fan: 0 } }])).toThrow(
      /heat with fan 0/,
    )
    expect(() =>
      encodePlanEnvelope(timed, [{ ...journal[0], step: { ...journal[0].step, durationSec: 1801 } }]),
    ).toThrow(/1 through 1800/)

    const backwardsElapsed = Uint8Array.from(bytes)
    backwardsElapsed[22] = 4
    expect(decodePlanEnvelope(backwardsElapsed)).toBeUndefined()
    const duplicateRevision = Uint8Array.from(bytes)
    duplicateRevision[23] = 2
    expect(decodePlanEnvelope(duplicateRevision)).toBeUndefined()
    const initialHeatWithoutFan = Uint8Array.from(bytes)
    initialHeatWithoutFan[7] = 0
    expect(decodePlanEnvelope(initialHeatWithoutFan)).toBeUndefined()
    const initialDurationTooLong = Uint8Array.from(bytes)
    initialDurationTooLong[9] = 0x09
    initialDurationTooLong[10] = 0x07
    expect(decodePlanEnvelope(initialDurationTooLong)).toBeUndefined()
    const journalHeatWithoutFan = Uint8Array.from(bytes)
    journalHeatWithoutFan[18] = 0
    expect(decodePlanEnvelope(journalHeatWithoutFan)).toBeUndefined()
    const journalDurationTooLong = Uint8Array.from(bytes)
    journalDurationTooLong[20] = 0x09
    journalDurationTooLong[21] = 0x07
    expect(decodePlanEnvelope(journalDurationTooLong)).toBeUndefined()

    expect(() =>
      encodePlanEnvelope(timed, [
        { elapsed_sec: 5, plan_rev: 2, step_index: 3, step: { fan: 7, heat: 5, durationSec: 45 } },
      ]),
    ).toThrow(/append the next one/)
    const damaged = encodePlanEnvelope(timed, [journal[0]])
    damaged[17] = 3
    expect(decodePlanEnvelope(damaged)).toBeUndefined()
  })

  it('round-trips compact requested and effective manual instructions', () => {
    const initial = { mode: 'manual' as const, fan: 4, heat: 0 }
    const journal = [
      { elapsed_sec: 0, plan_rev: 1, requested_fan: 4, requested_heat: 0, effective_fan: 4, effective_heat: 0 },
      { elapsed_sec: 2, plan_rev: 2, requested_fan: 5, requested_heat: 7, effective_fan: 5, effective_heat: 0 },
    ]
    const bytes = encodePlanEnvelope(initial, journal)
    expect(bytes.length).toBeLessThan(30)
    expect(decodePlanEnvelope(bytes)).toEqual({ initialPlan: initial, journal, bytes: bytes.length })
  })

  it('rejects internally corrupt provenance even when an attacker recomputes the CRC', () => {
    const file = encodeArchiveFile(stored({ initialPlan: initial }))
    file[HEADER_V4_BYTES] ^= 1
    refreshIntegrityCrc(file)
    expect(readArchiveFile(file, '41').verdict).toBe('payload_undecodable')
  })

  it('has explicit event and byte ceilings at the maximum accepted journal', () => {
    const journal = Array.from({ length: PLAN_JOURNAL_MAX_EVENTS }, (_value, index) => ({
      elapsed_sec: index * 90,
      plan_rev: index + 2,
      change: [initial.zones[0], { ...initial.zones[1], durationSec: 240 + index + 1 }],
    }))
    expect(encodePlanEnvelope(initial, journal).length).toBeLessThanOrEqual(PLAN_ENVELOPE_MAX_BYTES)
    expect(() => encodePlanEnvelope(initial, [...journal, journal[0]])).toThrow(/32-event/)
  })
})

describe('the archive file', () => {
  it('writes the header the firmware reads, by offset', () => {
    const file = encodeArchiveFile(stored())
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    expect(view.getUint32(0, true)).toBe(ARCHIVE_MAGIC)
    expect(view.getUint16(4, true)).toBe(4)
    expect(view.getUint8(6)).toBe(4) // ThermalLogSource::ROAST
    expect(view.getUint32(8, true)).toBe(41) // logId
    expect(view.getUint32(24, true)).toBe(40) // sampleCount
    expect(view.getUint8(64)).toBe(3) // zoneCount
    expect(view.getUint16(66, true)).toBe(225) // batchMassG
    expect(view.getUint16(68 + 4, true)).toBe(0xffff) // zone 2 never attained
    expect(view.getUint8(100)).toBe(1) // codec: delta-varint
    expect(file.length).toBe(HEADER_V4_BYTES + view.getUint32(92, true))
  })

  /** Multipart upload is binary-safe across the NUL that made `arg("plain")` unusable. */
  it('carries a NUL inside its version field', () => {
    expect(encodeArchiveFile(stored())[5]).toBe(0)
  })

  it('round-trips a v4 recording back into the same recording', () => {
    const original = withEncoded(stored())
    const read = readArchiveFile(encodeArchiveFile(original), '41')
    expect(read.verdict).toBe('ok')
    expect(read.log?.version).toBe(4)
    expect(read.log?.name).toBe('ethiopia-yirg')
    expect(read.log?.zoneAttainedSec).toEqual([120, 310, null])
    expect(read.log?.samples).toHaveLength(40)
    expect(read.log?.encodedBytes).toBe(original.encodedBytes)
  })

  it('round-trips the heat lease terminal reason at its stable firmware code', () => {
    const original = withEncoded(stored({ roastStopSec: 33, roastEndReason: 'heat_lease_expired' }))
    const file = encodeArchiveFile(original)
    expect(new DataView(file.buffer, file.byteOffset, file.byteLength).getUint8(103)).toBe(12)
    expect(readArchiveFile(file, '41').log).toMatchObject({
      roastStopSec: 33,
      roastEndReason: 'heat_lease_expired',
    })
  })

  it('fails closed on recordings without immutable producer identity', () => {
    for (const version of [1, 2, 3] as const) {
      const file = encodeArchiveFile(stored())
      new DataView(file.buffer).setUint16(4, version, true)
      expect(readArchiveFile(file, '41').verdict).toBe('bad_version')
    }
  })
  it('costs the v4 header plus the compact payload', () => {
    expect(archiveFileBytes(withEncoded(stored()))).toBe(HEADER_V4_BYTES + encodeSamples(samples(40)).length)
  })
})

describe('validation, in the firmware verdict names', () => {
  const verdictOf = (mutate: (file: Uint8Array, view: DataView) => void, id = '41') => {
    const file = Uint8Array.from(encodeArchiveFile(stored()))
    mutate(file, new DataView(file.buffer))
    return readArchiveFile(file, id).verdict
  }

  it('refuses a foreign file, a version it cannot read, and a truncated header', () => {
    expect(verdictOf((_file, view) => view.setUint32(0, 0x11223344, true))).toBe('bad_magic')
    expect(verdictOf((_file, view) => view.setUint16(4, 0, true))).toBe('bad_version')
    expect(verdictOf((_file, view) => view.setUint16(4, 5, true))).toBe('bad_version')
    expect(readArchiveFile(encodeArchiveFile(stored()).subarray(0, 20), '41').verdict).toBe('truncated_header')
  })

  it('refuses impossible header claims before it multiplies them by anything', () => {
    expect(verdictOf((_file, view) => view.setUint32(24, 0xffffffff, true))).toBe('sample_count')
    expect(verdictOf((_file, view) => view.setUint8(64, 13))).toBe('zone_count')
    expect(verdictOf((_file, view) => view.setUint8(100, 9))).toBe('bad_codec')
  })

  it('refuses a length that disagrees with the payload it declares', () => {
    expect(verdictOf((_file, view) => view.setUint32(92, view.getUint32(92, true) + 1, true))).toBe('size_mismatch')
  })

  it('refuses a flipped bit, in the payload or in the checksum itself', () => {
    expect(
      verdictOf((file) => {
        file[HEADER_V4_BYTES + 3] ^= 0xff
      }),
    ).toBe('crc_mismatch')
    expect(verdictOf((_file, view) => view.setUint32(96, view.getUint32(96, true) ^ 1, true))).toBe('crc_mismatch')
  })

  /**
   * The check a CRC cannot stand in for. Re-checksumming garbage makes it self-consistent, so the
   * payload is DECODED and required to yield exactly `sampleCount` frames ending exactly at
   * `encodedBytes`. Without it a plausible upload becomes an entry that lists fine and serves a
   * truncated CSV forever.
   */
  it('refuses a payload that checksums correctly and is not a recording', () => {
    expect(
      verdictOf((file) => {
        file.fill(0xff, HEADER_V4_BYTES)
        refreshIntegrityCrc(file)
      }),
    ).toBe('payload_undecodable')
  })

  /** A file stored under a name its header disagrees with would list an entry whose download 404s. */
  it('refuses a file whose header names a different recording', () => {
    expect(verdictOf(() => {}, '42')).toBe('log_id')
  })
})

const leasedArgs = (target: MockDevice, values: Record<string, string>) => {
  const begun = target.beginRestore(new URLSearchParams({ confirm: 'BEGIN_RESTORE' }))
  expect(begun.status).toBe(200)
  return new URLSearchParams({ ...values, restore_token: String(begun.body.restore_token) })
}

const restoreWithLease = (target: MockDevice, values: Record<string, string>, bytes: Uint8Array) =>
  target.restoreLog(leasedArgs(target, values), bytes)

describe('POST /api/logs/restore, as the device answers it', () => {
  const device = () => {
    const target = new MockDevice()
    target.archive.restore(withEncoded(stored({ id: '41' })))
    return target
  }
  const body = (log: StoredLog) => encodeArchiveFile(log)

  it('refuses without the confirm token, before it looks at anything else', () => {
    const target = device()
    const outcome = restoreWithLease(target, { id: '41' }, body(stored()))
    expect(outcome.status).toBe(409)
    expect(String(outcome.body.message)).toContain('RESTORE_LOG')
  })

  it('names the check that failed rather than saying the file is bad', () => {
    const target = device()
    const args = leasedArgs(target, { id: '9', confirm: 'RESTORE_LOG' })
    // The header says 41 and the id says 9.
    expect(target.restoreLog(args, body(stored())).body.check).toBe('log_id')
    expect(restoreWithLease(target, { id: 'x', confirm: 'RESTORE_LOG' }, body(stored())).body.check).toBe('id')
    expect(restoreWithLease(target, { id: '+1', confirm: 'RESTORE_LOG' }, body(stored())).body.check).toBe('id')
    expect(restoreWithLease(target, { id: ' 1', confirm: 'RESTORE_LOG' }, body(stored())).body.check).toBe('id')
    expect(restoreWithLease(target, { id: '4294967296', confirm: 'RESTORE_LOG' }, body(stored())).body.check).toBe('id')
    expect(restoreWithLease(target, { id: '4294967295', confirm: 'RESTORE_LOG' }, body(stored())).body.check).toBe('id')
    expect(restoreWithLease(target, { id: '41', confirm: 'RESTORE_LOG' }, Uint8Array.from([1, 2, 3])).body.check).toBe(
      'truncated_header',
    )
  })

  it('refuses an over-cap upload from its binary length, before validation', () => {
    const target = device()
    const huge = new Uint8Array(121_245)
    const outcome = restoreWithLease(target, { id: '41', confirm: 'RESTORE_LOG' }, huge)
    expect(outcome.status).toBe(413)
    expect(String(outcome.body.message)).toContain('121244')
  })

  /**
   * Restore WINS. An id that already holds a recording is overwritten, with no conflict token and no
   * version dance: a restore is not an edit, it is the user replaying an archive they already hold.
   */
  it('overwrites an existing recording and says that it did', () => {
    const target = device()
    const replacement = withEncoded(stored({ samples: samples(50) }))
    const outcome = restoreWithLease(target, { id: '41', confirm: 'RESTORE_LOG' }, body(replacement))
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ id: 41, replaced: true, samples: 50, version: 4, count: 1 })
    expect(target.archive.find('41')?.samples).toHaveLength(50)
  })

  it('auto-allocates a local address while preserving immutable foreign origin', () => {
    const target = new MockDevice()
    const source = withEncoded(stored({ id: '41', recordingOriginLogId: '17' }))
    const outcome = restoreWithLease(target, { id: 'auto', confirm: 'RESTORE_LOG' }, body(source))
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({
      id: 1,
      replaced: false,
      recording_origin: { deviceId: 'source-device', logId: '17' },
      storage_address: { deviceId: 'crackle-dev-sim-sr800', logId: '1' },
    })
    expect(target.archive.find('1')).toMatchObject({ id: '1', recordingOriginLogId: '17' })
  })

  it('allows a normal partial import without opening whole-device restore maintenance', () => {
    const target = new MockDevice()
    const before = target.stateRev
    const args = new URLSearchParams({ id: 'auto', confirm: 'RESTORE_LOG' })
    const outcome = target.restoreLog(args, body(withEncoded(stored({ recordingOriginLogId: '17' }))))
    expect(outcome.status).toBe(200)
    expect(target.stateRev).not.toBe(before)
    expect(outcome.body).toMatchObject({ state_rev: target.stateRev, recording_origin: { logId: '17' } })
  })
  /**
   * The `logseq` bump. Without it, restoring an archive onto a formatted roaster leaves the counter
   * at 1 and the next roast is written straight over restored recording #1. It only ever RISES.
   */
  it('lifts the id counter to the restored id, and never rewinds it', () => {
    const target = new MockDevice()
    expect(target.archive.nextLogId).toBe(1)
    restoreWithLease(target, { id: '41', confirm: 'RESTORE_LOG' }, body(withEncoded(stored({ id: '41' }))))
    expect(target.archive.nextLogId).toBe(42)
    // An older recording restored afterwards must not start handing out ids that already exist.
    restoreWithLease(target, { id: '7', confirm: 'RESTORE_LOG' }, body(withEncoded(stored({ id: '7' }))))
    expect(target.archive.nextLogId).toBe(42)
  })

  it('never prunes to make room - it refuses, and the client decides what to give up', () => {
    const target = new MockDevice()
    // Fill the volume to within the archive's working reserve.
    target.archive.logs = [
      { ...stored({ id: '2' }), samples: samples(4000) },
      { ...stored({ id: '3' }), samples: samples(4000) },
    ]
    const before = target.archive.logs.length
    let outcome = { status: 200 } as { status: number }
    for (let index = 0; index < 60 && outcome.status === 200; index += 1) {
      target.archive.logs.push({ ...stored({ id: String(100 + index) }), samples: samples(4000) })
      outcome = restoreWithLease(target, { id: '41', confirm: 'RESTORE_LOG' }, body(withEncoded(stored({ id: '41' }))))
    }
    expect(outcome.status).toBe(507)
    // Nothing was deleted to make room: the archive only grew by what the loop itself pushed.
    expect(target.archive.logs.length).toBeGreaterThan(before)
    expect(target.archive.lostLogs).toBe(0)
  })

  it('budgets an overwrite while the old destination and temp file coexist', () => {
    const target = new MockDevice()
    const existing = stored({ id: '41', samples: samples(4000) })
    const replacement = withEncoded(stored({ id: '41', samples: samples(50) }))
    target.archive.logs = [existing]
    let id = 100
    while (target.archive.usedBytes + archiveFileBytes(replacement) + ARCHIVE_RESERVE_BYTES <= ARCHIVE_TOTAL_BYTES) {
      target.archive.logs.push(stored({ id: String(id++), samples: samples(4000) }))
    }
    // Subtracting `existing` here would wrongly accept the write.
    expect(
      target.archive.usedBytes - archiveFileBytes(existing) + archiveFileBytes(replacement) + ARCHIVE_RESERVE_BYTES,
    ).toBeLessThanOrEqual(ARCHIVE_TOTAL_BYTES)
    const outcome = restoreWithLease(target, { id: '41', confirm: 'RESTORE_LOG' }, encodeArchiveFile(replacement))
    expect(outcome.status).toBe(507)
    expect(target.archive.find('41')?.samples).toHaveLength(4000)
  })
})

const callRestoreRoute = async (
  device: MockDevice,
  body: Buffer,
  contentType = 'application/octet-stream',
  url = '/api/logs/restore?id=41&confirm=RESTORE_LOG',
) => {
  const begun = device.beginRestore(new URLSearchParams({ confirm: 'BEGIN_RESTORE' }))
  const target = new URL(url, 'http://mock.local')
  target.searchParams.set('restore_token', String(begun.body.restore_token))
  const request = Object.assign(Readable.from([body]) as unknown as IncomingMessage, {
    method: 'POST',
    url: target.pathname + target.search,
    headers: { 'content-type': contentType },
  })
  const captured = { status: 0, body: '' }
  const response = {
    statusCode: 0,
    setHeader() {},
    end(chunk: string) {
      captured.status = response.statusCode
      captured.body = chunk
    },
  }
  expect(await createRouter(device)(request, response as unknown as ServerResponse)).toBe(true)
  return { status: captured.status, body: JSON.parse(captured.body) as Record<string, unknown> }
}

describe('recording restore raw binary wire shape', () => {
  it('preserves binary archive bytes, including the version NUL', async () => {
    const device = new MockDevice()
    device.archive.restore(withEncoded(stored({ id: '41' })))
    const replacement = encodeArchiveFile(withEncoded(stored({ samples: samples(50) })))
    expect(replacement[5]).toBe(0)
    const result = await callRestoreRoute(device, Buffer.from(replacement))
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, id: 41, replaced: true, samples: 50 })
    expect(device.archive.find('41')?.samples).toHaveLength(50)
  })

  it('checks confirmation and id before validating the archive', async () => {
    const malformed = Buffer.from('not an archive')
    const missingConfirm = await callRestoreRoute(new MockDevice(), malformed, undefined, '/api/logs/restore?id=41')
    expect(missingConfirm.status).toBe(409)
    expect(String(missingConfirm.body.message)).toContain('RESTORE_LOG')
    const reservedId = await callRestoreRoute(
      new MockDevice(),
      malformed,
      undefined,
      '/api/logs/restore?id=4294967295&confirm=RESTORE_LOG',
    )
    expect(reservedId.status).toBe(400)
    expect(reservedId.body).toMatchObject({ check: 'id' })
  })

  it('rejects a non-binary content type before treating it as an archive', async () => {
    const result = await callRestoreRoute(new MockDevice(), Buffer.from('not an archive'), 'text/plain')
    expect(result.status).toBe(415)
    expect(result.body).toMatchObject({ ok: false, check: 'upload' })
  })
})
describe('archive retention uses the whole shared volume', () => {
  it('prunes an old recording when document bytes consume the remaining reserve', () => {
    let documentBytes = 0
    const archive = new Archive(() => documentBytes)
    for (let id = 1; id <= 10; id += 1) {
      archive.restore(stored({ id: String(id), recordingOriginLogId: String(id), samples: samples(4000) }))
    }
    documentBytes = ARCHIVE_TOTAL_BYTES - ARCHIVE_RESERVE_BYTES - archive.usedBytes - 1
    expect(documentBytes).toBeGreaterThan(0)
    const before = archive.logs.length

    archive.open(0, 1785001000, 'roast', {
      roastMode: 'manual',
      initialPlan: { mode: 'manual', fan: 4, heat: 0 },
    })
    expect(archive.persistProvisionalRoast()).toBeDefined()

    expect(archive.lostLogs).toBeGreaterThan(0)
    expect(archive.logs.length).toBeLessThanOrEqual(before)
    expect(archive.usedBytes + documentBytes + ARCHIVE_RESERVE_BYTES).toBeLessThanOrEqual(ARCHIVE_TOTAL_BYTES)
  })
})
describe('the archive index after a restore', () => {
  it('wraps below the reserved uint32 ceiling and skips occupied positive ids', () => {
    const archive = new Archive()
    archive.restore(withEncoded(stored({ id: '4294967294' })))
    // Backup restore can encounter the wrapped candidate after the high id.
    archive.restore(withEncoded(stored({ id: '1' })))
    expect(archive.lastIssuedLogId).toBe(4294967294)
    expect(archive.nextLogId).toBe(2)
  })

  it('keeps wrapped local recordings newest and prunes the true oldest first', () => {
    const archive = new Archive()
    for (let id = 4294967253; id <= 4294967294; id += 1) {
      archive.restore(stored({ id: String(id), samples: samples(4000) }))
    }
    archive.open(0, 1785001000, 'manual')
    for (let index = 0; index < 35; index += 1) {
      archive.sample(index * 1000, { tcC: 100, cjC: 25, fan: 5, heat: 0 })
    }
    archive.close()
    expect(archive.persistFinished()?.id).toBe('1')
    expect(archive.lastIssuedLogId).toBe(1)
    expect(archive.logs[0].id).toBe('1')
    expect(archive.find('1')).toBeDefined()
    expect(archive.find('4294967253')).toBeUndefined()
  })

  it('reports firmware logseq rather than deriving it from a wrapped next candidate', () => {
    const target = new MockDevice()
    const outcome = restoreWithLease(
      target,
      { id: '4294967294', confirm: 'RESTORE_LOG' },
      encodeArchiveFile(withEncoded(stored({ id: '4294967294' }))),
    )
    expect(outcome.status).toBe(200)
    expect(outcome.body.logseq).toBe(4294967294)
    expect(target.archive.nextLogId).toBe(1)
    const restarted = new MockDevice()
    restarted.restore(target.snapshot())
    expect(restarted.archive.lastIssuedLogId).toBe(4294967294)
    expect(restarted.archive.nextLogId).toBe(1)
  })

  it('states the payload length and the codec for a v4 entry, because there is no stride', () => {
    const archive = new Archive()
    const log = withEncoded(stored())
    archive.restore(log)
    const entry = archive.entry(log)
    expect(entry.version).toBe(4)
    expect(entry.payload_bytes).toBe(log.encodedBytes)
    expect(entry.codec).toBe(1)
    expect(entry.bytes).toBe(HEADER_V4_BYTES + (log.encodedBytes ?? 0))
    // v2's identity fields are still there: a v3 file is a v2 file with a described payload.
    expect(entry.name).toBe('ethiopia-yirg')
    expect(entry.zone_attained_sec).toEqual([120, 310, null])
  })
})

describe('recording delete ids', () => {
  it('rejects malformed and reserved ids without deleting their numeric prefix', () => {
    const device = new MockDevice()
    device.archive.restore(withEncoded(stored({ id: '41' })))
    const remove = (id: string) => device.deleteLog(new URLSearchParams({ id, confirm: 'DELETE_LOG' }))

    for (const id of ['', '0', '-1', '+41', ' 41', '41 ', '41junk', '1.0', '4294967295', '4294967296']) {
      expect(remove(id).status, id).toBe(400)
    }
    expect(device.archive.logs.map((log) => log.id)).toContain('41')
  })

  it('accepts strict decimal syntax through the largest issued id', () => {
    const device = new MockDevice()
    device.archive.restore(withEncoded(stored({ id: '4294967294' })))
    expect(device.deleteLog(new URLSearchParams({ id: '4294967294', confirm: 'DELETE_LOG' })).status).toBe(200)
  })
})
