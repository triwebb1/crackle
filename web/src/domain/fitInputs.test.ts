import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { testRecordedOn } from '../testFixtures/provenance'
import { logExcitation } from './coefficientFit'
import { excitationGrade, fitFingerprint, fitInputFromRun, fitReadiness, fitStaleness, hashValues } from './fitInputs'
import { thermalStep } from './thermalModel'
import type { CalibrationRun, CalibrationSnapshot, RoastRun, ThermalSample } from './types'

const AMBIENT = 21

const samples = (steps: Array<{ fan: number; heat: number; seconds: number }>): ThermalSample[] => {
  const out: ThermalSample[] = []
  let temperatureC = AMBIENT
  let rorCPerMin: number | undefined
  let seconds = 0
  out.push({
    tMs: 0,
    thermocoupleC: temperatureC,
    coldJunctionC: AMBIENT,
    effectiveFan: steps[0].fan,
    effectiveHeat: steps[0].heat,
  })
  for (const step of steps) {
    for (let second = 0; second < step.seconds; second += 1) {
      const result = thermalStep(
        {
          previousBeanTempC: temperatureC,
          previousRorCPerMin: rorCPerMin,
          fan: step.fan,
          heat: step.heat,
          cooling: step.heat === 0,
          batchMassG: 225,
          ambientC: AMBIENT,
        },
        defaultCalibration,
      )
      temperatureC = result.beanTempC
      rorCPerMin = result.rorCPerMin
      seconds += 1
      out.push({
        tMs: seconds * 1000,
        thermocoupleC: temperatureC,
        coldJunctionC: AMBIENT,
        effectiveFan: step.fan,
        effectiveHeat: step.heat,
      })
    }
  }
  return out
}

const EXCITED = [
  { fan: 4, heat: 7, seconds: 90 },
  { fan: 9, heat: 7, seconds: 90 },
  { fan: 6, heat: 4, seconds: 90 },
  { fan: 6, heat: 9, seconds: 90 },
  { fan: 9, heat: 0, seconds: 90 },
]

const run = (over: Partial<CalibrationRun> = {}): CalibrationRun => ({
  id: 'run-1',
  capturedAt: '2026-07-20T10:00:00.000Z',
  form: 'steps',
  steps: [],
  maxStepSeconds: 300,
  minStepSeconds: 20,
  settleSeconds: 15,
  settleBandC: 1.5,
  ambientC: AMBIENT,
  samples: samples(EXCITED),
  notes: '',
  massG: 225,
  ...over,
  recordedOn: over.recordedOn ?? testRecordedOn,
})

const roast = (over: Partial<RoastRun> = {}): RoastRun => ({
  id: 'roast-1',
  name: 'Guji filter',
  startedAt: '2026-07-20T09:00:00.000Z',
  profile: {
    id: 'p',
    name: 'p',
    revision: 1,
    strategy: 'timed',
    createdAt: '',
    updatedAt: '',
    metadata: { intent: '' },
    notes: '',
    points: [],
    coolFan: 9,
    coolDurationSec: 90,
  },
  beanLotId: 'bean-guji',
  notes: '',
  controllerVersion: 'test',
  recordedOn: testRecordedOn,
  outcome: 'complete',
  samples: [],
  events: [],
  measurements: { startingMassG: 225, startingVolumeMl: 350, finalMassG: 190, finalVolumeMl: 420 },
  ...over,
})

describe('the fingerprint of a fit', () => {
  it('is stable across selection order and repeated calls', () => {
    const a = fitInputFromRun(run({ id: 'a' }), roast({ id: 'ra' }))
    const b = fitInputFromRun(run({ id: 'b' }), roast({ id: 'rb' }))
    expect(fitFingerprint([a, b])).toEqual(fitFingerprint([b, a]))
    expect(fitFingerprint([a, b])).toEqual(fitFingerprint([a, b]))
    expect(fitFingerprint([a, b]).runIds).toEqual(['a', 'b'])
  })

  it('changes when any measurement the fit consumed changes', () => {
    const before = fitInputFromRun(run(), roast())
    const after = fitInputFromRun(
      run(),
      roast({ measurements: { startingMassG: 225, startingVolumeMl: 350, finalMassG: 191, finalVolumeMl: 420 } }),
    )
    expect(fitFingerprint([after]).measurementHash).not.toBe(fitFingerprint([before]).measurementHash)
  })

  it('changes when the batch weight on the log changes', () => {
    const before = fitInputFromRun(run({ massG: 225 }), roast())
    const after = fitInputFromRun(run({ massG: 240 }), roast())
    expect(fitFingerprint([after]).measurementHash).not.toBe(fitFingerprint([before]).measurementHash)
  })

  it('does not change for things the fit never consumed', () => {
    const before = fitInputFromRun(run(), roast())
    const after = fitInputFromRun(run({ notes: 'rewritten' }), roast({ name: 'Renamed' }))
    expect(fitFingerprint([after]).measurementHash).toBe(fitFingerprint([before]).measurementHash)
  })

  it('hashes deterministically and distinguishes an absent value from a zero', () => {
    expect(hashValues(['a', 1])).toBe(hashValues(['a', 1]))
    expect(hashValues(['a', undefined])).not.toBe(hashValues(['a', 0]))
    expect(hashValues([])).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('staleness of a saved fit', () => {
  const inputs = [fitInputFromRun(run(), roast())]
  const snapshot: CalibrationSnapshot = {
    id: 'snap',
    name: 'Fitted',
    createdAt: '2026-07-20T11:00:00.000Z',
    recordedOn: testRecordedOn,
    runIds: ['run-1'],
    patch: { heaterGainCPerMinAt10: 60 },
    curves: [],
    inputs,
    fingerprint: fitFingerprint(inputs),
  }

  it('is fresh while its inputs still say what they said', () => {
    expect(fitStaleness(snapshot, inputs)).toEqual({ stale: false })
  })

  /** The late-arriving-measurement case: roasted mass is weighed after the fit was run. */
  it('flags an edit to a measurement it was fitted from', () => {
    const later = [
      fitInputFromRun(
        run(),
        roast({ measurements: { startingMassG: 225, startingVolumeMl: 350, finalMassG: 188, finalVolumeMl: 430 } }),
      ),
    ]
    const check = fitStaleness(snapshot, later)
    expect(check.stale).toBe(true)
    expect(check.reason).toBe('measurements-changed')
    expect(check.detail).toContain('Refitting will produce a new calibration')
  })

  it('reports a vanished input differently from a changed one', () => {
    const check = fitStaleness(snapshot, [])
    expect(check.stale).toBe(true)
    expect(check.reason).toBe('input-missing')
  })

  it('says nothing about a calibration that was never a fit', () => {
    expect(fitStaleness({ ...snapshot, fingerprint: undefined, inputs: undefined }, [])).toEqual({ stale: false })
  })

  it('ignores runs that were not among its inputs', () => {
    const withStranger = [...inputs, fitInputFromRun(run({ id: 'other' }), roast({ id: 'other-roast' }))]
    expect(fitStaleness(snapshot, withStranger).stale).toBe(false)
  })
})

describe('what a candidate run brings to a fit', () => {
  it('includes a loaded, well-driven roast by default', () => {
    const readiness = fitReadiness(run(), roast())
    expect(readiness.fittable).toBe(true)
    expect(readiness.includedByDefault).toBe(true)
    expect(readiness.reasons).toEqual([])
    expect(readiness.missingMeasurements).toEqual([])
  })

  it('excludes an empty-chamber pass by default, with the reason stated', () => {
    const readiness = fitReadiness(run({ massG: undefined }), roast())
    expect(readiness.fittable).toBe(false)
    expect(readiness.includedByDefault).toBe(false)
    expect(readiness.reasons.join(' ')).toContain('empty-chamber pass')
  })

  it('excludes a log with nothing to replay', () => {
    expect(fitReadiness(run({ samples: [] })).fittable).toBe(false)
  })

  it('reports missing covariates without excluding the run for them', () => {
    const readiness = fitReadiness(run(), roast({ measurements: { startingMassG: 225 } }))
    expect(readiness.fittable).toBe(true)
    expect(readiness.missingMeasurements).toEqual(['green volume', 'roasted mass', 'roasted volume'])
  })

  it('says so when there is no roast behind the log at all', () => {
    expect(fitReadiness(run()).missingMeasurements).toEqual(['no linked roast measurements'])
  })

  it('grades excitation in one word', () => {
    expect(excitationGrade(logExcitation(samples(EXCITED)))).toBe('good')
    expect(
      excitationGrade(
        logExcitation(
          samples([
            { fan: 8, heat: 8, seconds: 60 },
            { fan: 6, heat: 6, seconds: 60 },
          ]),
        ),
      ),
    ).toBe('partial')
    expect(excitationGrade(logExcitation(samples([{ fan: 7, heat: 7, seconds: 90 }])))).toBe('poor')
  })
})
