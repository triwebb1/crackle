import { describe, expect, it } from 'vitest'
import { CRK_V4_HEADER_BYTES, refreshV4Checksums, v4Recording } from '../testFixtures/crk'
import {
  decodeCrkCalibrationProgram,
  decodeCrkRoastPlan,
  decodeCrkThermalSamples,
  decodeStoredPlanEnvelope,
  validateCrkRecording,
} from './crkValidator'

describe('CRK v4 identity boundary', () => {
  it('accepts UINT32_MAX - 1, the highest local id the firmware can restore', () => {
    const bytes = v4Recording({ id: 0xfffffffe, payload: new Uint8Array(), sampleCount: 0 })
    expect(validateCrkRecording(bytes, '4294967294')).toMatchObject({ ok: true, summary: { version: 4 } })
  })

  it('rejects reserved UINT32_MAX even when the archive header agrees', () => {
    const bytes = v4Recording({ id: 0xffffffff, payload: new Uint8Array(), sampleCount: 0 })
    expect(validateCrkRecording(bytes, '4294967295')).toEqual({
      ok: false,
      check: 'log_id',
      message: 'the manifest carries invalid recording id 4294967295',
    })
  })

  it('rejects unprovenanced legacy headers in this unreleased product', () => {
    const legacy = new Uint8Array(104)
    const view = new DataView(legacy.buffer)
    view.setUint32(0, 0x4c4b5243, true)
    view.setUint16(4, 3, true)
    expect(validateCrkRecording(legacy, '41')).toMatchObject({ ok: false, check: 'bad_version' })
  })

  it('checks immutable producer provenance before trusting the payload', () => {
    const bytes = v4Recording()
    bytes[104] ^= 1
    expect(validateCrkRecording(bytes, '41')).toMatchObject({ ok: false, check: 'provenance' })
  })

  it('accepts firmware-compatible v4 raw recordings', () => {
    const bytes = v4Recording({ payload: new Uint8Array(12), sampleCount: 1, codec: 0 })
    expect(validateCrkRecording(bytes, '41')).toMatchObject({
      ok: true,
      summary: { codec: 0, recordingOrigin: { deviceId: 'test-device', logId: '41' } },
    })
  })

  it('decodes the stable heat-lease terminal reason from archive code 12', () => {
    const bytes = v4Recording()
    bytes[103] = 12
    refreshV4Checksums(bytes)
    expect(validateCrkRecording(bytes, '41')).toMatchObject({
      ok: true,
      summary: { roastEndReason: 'heat_lease_expired' },
    })
  })
})

const putVarint = (out: number[], value: number) => {
  let remaining = value >>> 0
  while (remaining >= 0x80) {
    out.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  out.push(remaining)
}
const zigzag = (value: number) => (value << 1) ^ (value >> 31)

const codec2JourneyRecording = (id = 41) => {
  const envelope = [0xc7, 1, 2, 1, 1, 0, 0]
  putVarint(envelope, zigzag(250))
  putVarint(envelope, zigzag(1500))
  putVarint(envelope, 120)
  envelope.push(40, 90, 30, 80)
  putVarint(envelope, 60)
  putVarint(envelope, 2)
  envelope.push(1, 1, 0, 0x42)
  putVarint(envelope, zigzag(1600))
  envelope.push(90)
  envelope[5] = envelope.length & 0xff
  envelope[6] = envelope.length >>> 8
  return v4Recording({ id, payload: Uint8Array.from(envelope), sampleCount: 0, codec: 2 })
}

describe('codec-2 roast plan provenance', () => {
  it('validates and decodes the immutable starting plan plus accepted edit journal', () => {
    const bytes = codec2JourneyRecording()
    expect(validateCrkRecording(bytes, '41')).toMatchObject({ ok: true, summary: { version: 4, codec: 2 } })
    const decoded = decodeCrkRoastPlan(bytes, '41')
    expect(decoded?.initialPlan).toEqual({
      mode: 'journey',
      zones: [{ startC: 25, endC: 150, durationSec: 120, fanMin: 4, fanMax: 9, heatMin: 3, heatMax: 8 }],
    })
    expect(decoded?.planJournal).toEqual([
      {
        elapsedSec: 60,
        planRev: 2,
        zones: [{ startC: 25, endC: 160, durationSec: 120, fanMin: 4, fanMax: 9, heatMin: 3, heatMax: 9 }],
      },
    ])
    expect(decodeStoredPlanEnvelope(decoded!.planEnvelope)).toEqual(decoded)
  })

  it('rejects a checksummed timed journal that creates a step-list hole', () => {
    const envelope = Uint8Array.from([0xc7, 1, 1, 2, 1, 22, 0, 50, 60, 30, 0, 70, 80, 45, 0, 10, 2, 3, 90, 0, 60, 0])
    const bytes = v4Recording({ payload: envelope, sampleCount: 0, codec: 2 })
    expect(validateCrkRecording(bytes, '41')).toMatchObject({ ok: false, check: 'payload_undecodable' })
    expect(decodeCrkRoastPlan(bytes, '41')).toBeUndefined()
  })

  it('rejects checksummed non-monotonic or runtime-invalid timed provenance', () => {
    const validEnvelope = () =>
      Uint8Array.from([
        0xc7, 1, 1, 2, 2, 29, 0, 40, 50, 30, 0, 50, 60, 40, 0, 5, 2, 0, 40, 60, 30, 0, 9, 3, 2, 70, 50, 45, 0,
      ])
    const expectRejected = (mutate: (envelope: Uint8Array) => void) => {
      const envelope = validEnvelope()
      mutate(envelope)
      const bytes = v4Recording({ payload: envelope, sampleCount: 0, codec: 2 })
      expect(validateCrkRecording(bytes, '41')).toMatchObject({ ok: false, check: 'payload_undecodable' })
      expect(decodeCrkRoastPlan(bytes, '41')).toBeUndefined()
    }

    expectRejected((envelope) => {
      envelope[22] = 4
    })
    expectRejected((envelope) => {
      envelope[23] = 2
    })
    expectRejected((envelope) => {
      envelope[7] = 0
    })
    expectRejected((envelope) => {
      envelope[9] = 0x09
      envelope[10] = 0x07
    })
    expectRejected((envelope) => {
      envelope[18] = 0
    })
    expectRejected((envelope) => {
      envelope[20] = 0x09
      envelope[21] = 0x07
    })
  })

  it('rejects a checksummed codec-2 payload whose plan envelope is malformed', () => {
    const bytes = codec2JourneyRecording()
    bytes[CRK_V4_HEADER_BYTES] = 0
    refreshV4Checksums(bytes)
    expect(validateCrkRecording(bytes, '41')).toMatchObject({ ok: false, check: 'payload_undecodable' })
    expect(decodeCrkRoastPlan(bytes, '41')).toBeUndefined()
  })
})
const codec2CalibrationRecording = (id = 41) => {
  const envelope = Uint8Array.from([0xc7, 1, 4, 2, 0, 18, 0, 23, 14, 3, 40, 20, 171, 0, 60, 80, 171, 0])
  return v4Recording({ id, payload: envelope, sampleCount: 0, codec: 2 })
}

describe('codec-2 calibration program provenance', () => {
  it('decodes exact steps, settle policy, and applied thermocouple offset', () => {
    expect(decodeCrkCalibrationProgram(codec2CalibrationRecording(), '41')).toEqual({
      program: {
        mode: 'calibration',
        steps: [
          { fan: 4, heat: 2, durationSec: 171 },
          { fan: 6, heat: 8, durationSec: 171 },
        ],
        maxStepSeconds: 171,
        minStepSeconds: 23,
        settleSeconds: 14,
        settleBandC: 0.3,
      },
      thermocoupleOffsetC: -3,
    })
  })

  it('rejects a calibration envelope with a journal', () => {
    const bytes = codec2CalibrationRecording()
    bytes[CRK_V4_HEADER_BYTES + 4] = 1
    refreshV4Checksums(bytes)
    expect(decodeCrkCalibrationProgram(bytes, '41')).toBeUndefined()
  })
})
describe('local CRK thermal decoding', () => {
  it('decodes the frozen raw layout without a second CSV transfer', () => {
    const payload = new Uint8Array(12)
    const view = new DataView(payload.buffer)
    view.setUint32(0, 1234, true)
    view.setInt16(4, 2012, true)
    view.setInt16(6, -32768, true)
    view.setUint16(8, 4500, true)
    view.setUint16(10, 7250, true)
    expect(decodeCrkThermalSamples(v4Recording({ payload, sampleCount: 1, codec: 0 }), '41')).toEqual([
      {
        tMs: 1234,
        thermocoupleC: 20.12,
        effectiveFan: 4.5,
        effectiveHeat: 7.25,
      },
    ])
  })

  it('decodes delta predictors, missing temperatures, and level changes locally', () => {
    const payload: number[] = []
    // t=1000, tc=20.0 C, cj=25.0 C, fan=4.0, heat=5.0
    putVarint(payload, zigzag(1000))
    putVarint(payload, zigzag(200) + 1)
    putVarint(payload, zigzag(250) + 1)
    putVarint(payload, zigzag(40))
    putVarint(payload, zigzag(50))
    // Constant 1 s delta, same tc, missing cj, fan=5.0, heat=0.0.
    putVarint(payload, zigzag(0))
    putVarint(payload, 1)
    putVarint(payload, 0)
    putVarint(payload, zigzag(10))
    putVarint(payload, zigzag(-50))
    const recording = v4Recording({ payload: Uint8Array.from(payload), sampleCount: 2, codec: 1 })

    expect(decodeCrkThermalSamples(recording, '41')).toEqual([
      { tMs: 1000, thermocoupleC: 20, coldJunctionC: 25, effectiveFan: 4, effectiveHeat: 5 },
      { tMs: 2000, thermocoupleC: 20, effectiveFan: 5, effectiveHeat: 0 },
    ])
  })

  it('skips codec-2 plan provenance before decoding its thermal stream', () => {
    const envelope = codec2CalibrationRecording().subarray(CRK_V4_HEADER_BYTES)
    const sample: number[] = []
    putVarint(sample, zigzag(1000))
    putVarint(sample, zigzag(1485) + 1)
    putVarint(sample, zigzag(420) + 1)
    putVarint(sample, zigzag(10))
    putVarint(sample, zigzag(50))
    const payload = Uint8Array.from([...envelope, ...sample])
    const recording = v4Recording({ payload, sampleCount: 1, codec: 2 })

    expect(decodeCrkThermalSamples(recording, '41')).toEqual([
      { tMs: 1000, thermocoupleC: 148.5, coldJunctionC: 42, effectiveFan: 1, effectiveHeat: 5 },
    ])
  })

  it('refuses to decode bytes whose archive identity is invalid', () => {
    const bytes = v4Recording({ payload: new Uint8Array(), sampleCount: 0 })
    bytes[104] ^= 1
    expect(decodeCrkThermalSamples(bytes, '41')).toBeUndefined()
  })
})
