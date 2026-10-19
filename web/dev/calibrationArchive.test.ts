import { describe, expect, it } from 'vitest'
import type { ArchivedCalibrationProgram } from './archive'
import { decodePlanEnvelope, encodeArchiveFile, encodePlanEnvelope, readArchiveFile } from './crkFile'
import { MockDevice } from './device'

describe('mock calibration archive provenance', () => {
  const program: ArchivedCalibrationProgram = {
    mode: 'calibration',
    steps: [
      { fan: 4, heat: 2, durationSec: 180 },
      { fan: 6, heat: 8, durationSec: 180 },
    ],
    maxStepSeconds: 180,
    minStepSeconds: 20,
    settleSeconds: 10,
    settleBandC: 0.3,
  }

  it('round-trips the exact accepted program through codec 2', () => {
    const encoded = encodePlanEnvelope(program)
    expect(decodePlanEnvelope(encoded)).toEqual({ initialPlan: program, journal: [], bytes: encoded.length })
  })

  it('rejects journals on immutable calibration programs', () => {
    expect(() =>
      encodePlanEnvelope(program, [
        {
          elapsed_sec: 1,
          plan_rev: 2,
          step_index: 0,
          step: { fan: 5, heat: 5, durationSec: 60 },
        },
      ]),
    ).toThrow(/cannot carry a plan journal/)
  })

  it('persists the program accepted by the mock device into its .crk recording', () => {
    const device = new MockDevice()
    device.advance(10_500)
    const started = device.startCalibration(
      new URLSearchParams({
        confirm: 'FOUR_DASHES_CALIBRATION',
        steps: '4:2,6:8',
        step_seconds: '30',
        min_step_seconds: '5',
        settle_seconds: '2',
        settle_band_tenths_c: '10',
      }),
    )
    expect(started.status).toBe(200)
    const id = String(started.body.log_id)
    device.runUntil(() => device.archive.logs.some((log) => log.id === id), 500)
    const stored = device.archive.logs.find((log) => log.id === id)
    expect(stored).toBeDefined()
    const restored = readArchiveFile(encodeArchiveFile(stored!), id)
    expect(restored.verdict).toBe('ok')
    expect(restored.log?.initialPlan).toEqual({
      mode: 'calibration',
      steps: [
        { fan: 4, heat: 2, durationSec: 30 },
        { fan: 6, heat: 8, durationSec: 30 },
      ],
      maxStepSeconds: 30,
      minStepSeconds: 5,
      settleSeconds: 2,
      settleBandC: 1,
    })
  })
})
