import { describe, expect, it } from 'vitest'
import type { DecodedCrkRoastPlan } from '../data/crkValidator'
import type { ArchivedCalibrationProgram, ThermalSample } from '../domain/types'
import { archivedCalibrationProgramFields, loadedRoastProgramFields } from './CalibrationView'

describe('device-owned calibration recording programs', () => {
  it('copies the exact archived calibration program instead of the current editor draft', () => {
    const archived: ArchivedCalibrationProgram = {
      mode: 'calibration',
      steps: [
        { fan: 4, heat: 2, durationSec: 171 },
        { fan: 6, heat: 8, durationSec: 171 },
      ],
      maxStepSeconds: 171,
      minStepSeconds: 23,
      settleSeconds: 14,
      settleBandC: 1.7,
    }
    expect(archivedCalibrationProgramFields(archived)).toEqual({
      form: 'steps',
      steps: [
        { fan: 4, heat: 2 },
        { fan: 6, heat: 8 },
      ],
      maxStepSeconds: 171,
      minStepSeconds: 23,
      settleSeconds: 14,
      settleBandC: 1.7,
    })
  })

  it('describes a loaded roast from recorded actuator segments after codec-2 proof', () => {
    const samples: ThermalSample[] = [
      { tMs: 0, thermocoupleC: 24, effectiveFan: 4, effectiveHeat: 2 },
      { tMs: 1000, thermocoupleC: 25, effectiveFan: 4, effectiveHeat: 2 },
      { tMs: 2000, thermocoupleC: 27, effectiveFan: 7, effectiveHeat: 6 },
      { tMs: 3000, thermocoupleC: 30, effectiveFan: 7, effectiveHeat: 6 },
    ]
    const provenance: DecodedCrkRoastPlan = {
      initialPlan: { mode: 'manual', fan: 4, heat: 2 },
      planJournal: [
        { elapsedSec: 2, planRev: 2, requestedFan: 7, requestedHeat: 6, effectiveFan: 7, effectiveHeat: 6 },
      ],
      planEnvelope: 'device-owned',
    }
    expect(loadedRoastProgramFields(samples, provenance)).toMatchObject({
      form: 'steps',
      steps: [
        { fan: 4, heat: 2 },
        { fan: 7, heat: 6 },
      ],
      settleSeconds: 0,
      settleBandC: 0,
    })
  })

  it('bounds a high-churn journey summary while retaining both endpoints', () => {
    const samples = Array.from(
      { length: 240 },
      (_, index): ThermalSample => ({
        tMs: index * 1000,
        thermocoupleC: 25 + index / 10,
        effectiveFan: 4 + (index % 6) / 10,
        effectiveHeat: (index % 100) / 10,
      }),
    )
    const provenance: DecodedCrkRoastPlan = {
      initialPlan: {
        mode: 'journey',
        zones: [{ startC: 25, endC: 200, durationSec: 1200, fanMin: 4, fanMax: 9, heatMin: 0, heatMax: 10 }],
      },
      planJournal: [],
      planEnvelope: 'device-owned',
    }
    const summary = loadedRoastProgramFields(samples, provenance)
    expect(summary.steps).toHaveLength(48)
    expect(summary.steps[0]).toEqual({ fan: samples[0].effectiveFan, heat: samples[0].effectiveHeat })
    expect(summary.steps.at(-1)).toEqual({ fan: samples.at(-1)!.effectiveFan, heat: samples.at(-1)!.effectiveHeat })
    expect(summary.minStepSeconds).toBe(1)
  })
})
