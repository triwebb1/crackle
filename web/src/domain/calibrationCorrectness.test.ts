import { describe, expect, it } from 'vitest'
import { testRecordedOn } from '../testFixtures/provenance'
import { expandBaselineGrid } from './calibrationProgram'
import {
  analyzeCalibrationRun,
  buildBaselineMap,
  curveFamily,
  fitAsymptote,
  parseThermalCsv,
  runToCsv,
  SUSPECT_DROP_C,
  steadyState,
  suspectFanLevels,
} from './thermalLog'
import type { CalibrationRun, CalibrationStep, ThermalSample } from './types'

/**
 * Regressions built from the FIRST REAL BASELINE MAP, which came back physically impossible.
 *
 * With a 5 °C settle band held for only 3 s, every step passed the settle test on the mid-transient
 * slope of its transition: steps "settled" in about 13 s, taus came back at 3-5 s, and the fan-4 row
 * read 138, 131, 115 °C for heats 1, 5, 10 - hotter settings producing a COOLER chamber. Nothing was
 * wrong with the roaster. The analysis had trusted a `settled` flag that meant nothing, and read a
 * tail mean off a curve that was nowhere near its plateau.
 *
 * The fixture below reproduces exactly that: a serpentine where every step is truncated at 20% of
 * its rise. The always-fit analysis must recover the true monotonic ordering from it.
 */
const AMBIENT = 24.5
const FAN_LEVELS = [1, 4]
const HEAT_LEVELS = [1, 5, 10]
// The truth the roaster would have reached, monotonic in heat and lower at higher airflow.
const trueSteadyState = (fan: number, heat: number) => AMBIENT + (240 - 9 * fan) * (heat / 10) ** 0.85
const TAU_SEC = 90
// Every step advances after closing only a fifth of its gap - the failure seen on real hardware.
const TRUNCATION = 0.2

const truncatedSerpentine = (): { steps: CalibrationStep[]; samples: ThermalSample[] } => {
  const steps = expandBaselineGrid(FAN_LEVELS, HEAT_LEVELS)
  const samples: ThermalSample[] = []
  let tMs = 0
  let temperature = AMBIENT
  for (const step of steps) {
    const target = trueSteadyState(step.fan, step.heat)
    // Hold each step only until it has travelled TRUNCATION of the way to its asymptote.
    const holdSec = Math.ceil(-TAU_SEC * Math.log(1 - TRUNCATION))
    const start = temperature
    for (let second = 0; second <= holdSec; second += 1) {
      temperature = target - (target - start) * Math.exp(-second / TAU_SEC)
      samples.push({
        tMs,
        thermocoupleC: Number(temperature.toFixed(2)),
        coldJunctionC: AMBIENT,
        effectiveFan: step.fan,
        effectiveHeat: step.heat,
      })
      tMs += 1000
    }
  }
  // Cooling: forced while the fan runs, then free decay once it stops.
  for (let second = 0; second < 120; second += 1) {
    temperature = AMBIENT + (temperature - AMBIENT) * Math.exp(-1 / 40)
    samples.push({
      tMs,
      thermocoupleC: Number(temperature.toFixed(2)),
      coldJunctionC: AMBIENT,
      effectiveFan: 8,
      effectiveHeat: 0,
    })
    tMs += 1000
  }
  for (let second = 0; second < 600; second += 1) {
    temperature = AMBIENT + (temperature - AMBIENT) * Math.exp(-1 / 300)
    samples.push({
      tMs,
      thermocoupleC: Number(temperature.toFixed(2)),
      coldJunctionC: AMBIENT,
      effectiveFan: 0,
      effectiveHeat: 0,
    })
    tMs += 1000
  }
  return { steps, samples }
}

const runOf = (
  steps: CalibrationStep[],
  samples: ThermalSample[],
  overrides: Partial<CalibrationRun> = {},
): CalibrationRun => ({
  id: 'calibration-truncated',
  capturedAt: '2026-07-26T10:00:00.000Z',
  form: 'grid',
  steps,
  maxStepSeconds: 180,
  minStepSeconds: 20,
  settleSeconds: 15,
  settleBandC: 1.5,
  ambientC: AMBIENT,
  samples,
  notes: '',
  ...overrides,
  recordedOn: overrides.recordedOn ?? testRecordedOn,
})

describe('always-fit steady state', () => {
  it('recovers the true monotonic ordering from a serpentine truncated at 20 percent of every rise', () => {
    const { steps, samples } = truncatedSerpentine()
    const analysis = analyzeCalibrationRun(runOf(steps, samples))
    const curves = curveFamily(analysis)

    // Nothing was skipped: every declared step matched a segment in the log.
    expect(analysis.steps.every((step) => step.sampleCount > 0)).toBe(true)

    for (const curve of curves) {
      const ordered = [...curve.points].sort((a, b) => a.heat - b.heat)
      expect(ordered).toHaveLength(HEAT_LEVELS.length)
      // The whole point: steady state must RISE with heat. The tail mean did the opposite.
      for (let index = 1; index < ordered.length; index += 1) {
        expect(ordered[index].steadyStateC).toBeGreaterThan(ordered[index - 1].steadyStateC)
      }
      // And it must land near the truth, not merely in the right order.
      for (const point of ordered) {
        const truth = trueSteadyState(curve.fanLevel, point.heat)
        expect(Math.abs(point.steadyStateC - truth) / truth).toBeLessThan(0.15)
      }
    }

    // No row can be suspect once the fit is trusted.
    expect(suspectFanLevels(curves)).toEqual([])
  })

  it('proves the tail mean alone would have produced the impossible falling row', () => {
    const { steps, samples } = truncatedSerpentine()

    // The old behavior, computed directly off the same log: the mean of each step's own tail.
    const tailMean = (fan: number, heat: number) =>
      steadyState(
        samples
          .filter((sample) => sample.effectiveFan === fan && sample.effectiveHeat === heat)
          .map((sample) => sample.thermocoupleC!),
      )!
    const naive = HEAT_LEVELS.map((heat) => tailMean(4, heat))
    // A serpentine walks the second fan group's heats DOWNWARD, so those steps approach from above
    // and their tail means overstate the cool end while understating the hot one. That asymmetry is
    // exactly what inverted the observed fan-4 row - and it is present here too.
    expect(naive.some((value, index) => index > 0 && value < naive[index - 1])).toBe(true)

    // The always-fit analysis, on the identical log, is monotonic instead.
    const analysis = analyzeCalibrationRun(runOf(steps, samples))
    const fitted = HEAT_LEVELS.map(
      (heat) => analysis.steps.find((step) => step.fanLevel === 4 && step.heatLevel === heat)!.steadyStateC!,
    )
    expect(fitted.every((value, index) => index === 0 || value > fitted[index - 1])).toBe(true)

    // Every truncated step is reported as fitted, never as a measurement.
    expect(analysis.steps.filter((step) => !step.recovery).every((step) => step.quality !== 'measured')).toBe(true)
    expect(analysis.steps.filter((step) => step.extrapolated).length).toBeGreaterThan(0)
  })

  it('reports a step it cannot identify as unreliable rather than as a confident number', () => {
    // Two seconds of a 90 s response carries no curvature: nothing can be fitted from it.
    const steps: CalibrationStep[] = [{ fan: 4, heat: 5 }]
    const samples: ThermalSample[] = Array.from({ length: 6 }, (_, second) => ({
      tMs: second * 1000,
      thermocoupleC: AMBIENT + second * 12,
      coldJunctionC: AMBIENT,
      effectiveFan: 4,
      effectiveHeat: 5,
    }))
    const step = analyzeCalibrationRun(runOf(steps, samples)).steps[0]
    expect(step.quality).not.toBe('extrapolated')
    // An unreliable step never reports a time constant: a tau fitted against the wrong asymptote is
    // exactly the 3-second nonsense the first map produced.
    if (step.quality === 'unreliable') expect(step.tauSec).toBeUndefined()
  })

  it('keeps a genuinely settled step measured, with its own tail mean', () => {
    const steps: CalibrationStep[] = [{ fan: 4, heat: 5 }]
    const target = trueSteadyState(4, 5)
    const samples: ThermalSample[] = Array.from({ length: 600 }, (_, second) => ({
      tMs: second * 1000,
      thermocoupleC: Number((target - (target - AMBIENT) * Math.exp(-second / TAU_SEC)).toFixed(2)),
      coldJunctionC: AMBIENT,
      effectiveFan: 4,
      effectiveHeat: 5,
    }))
    const step = analyzeCalibrationRun(runOf(steps, samples)).steps[0]
    expect(step.quality).toBe('measured')
    expect(step.extrapolated).toBe(false)
    expect(step.steadyStateC).toBeCloseTo(target, 0)
    expect(step.approach).toBeGreaterThan(0.95)
  })

  it('fits a falling step against its own asymptote, in the same search', () => {
    const from = 200
    const to = 80
    const samples = Array.from({ length: 30 }, (_, second) => ({
      tSec: second,
      temperatureC: to + (from - to) * Math.exp(-second / TAU_SEC),
    }))
    const fit = fitAsymptote(samples)
    expect(fit).toBeDefined()
    expect(fit!.steadyStateC).toBeGreaterThan(to - 25)
    expect(fit!.steadyStateC).toBeLessThan(from)
    // A flat series identifies nothing in either direction.
    expect(
      fitAsymptote(Array.from({ length: 30 }, (_, second) => ({ tSec: second, temperatureC: 150 }))),
    ).toBeUndefined()
  })
})

describe('captured stock Fan-1 endpoint', () => {
  it('measures a declared 1:10 step at Fan 1 without inventing a high-Heat floor', () => {
    const steps: CalibrationStep[] = [
      { fan: 1, heat: 1 },
      { fan: 1, heat: 10 },
    ]
    const samples: ThermalSample[] = []
    let tMs = 0
    for (const [fan, heat, target] of [
      [1, 1, 90],
      [1, 10, 260],
    ] as const) {
      for (let second = 0; second < 400; second += 1) {
        samples.push({
          tMs,
          thermocoupleC: Number((target - (target - AMBIENT) * Math.exp(-second / TAU_SEC)).toFixed(2)),
          coldJunctionC: AMBIENT,
          effectiveFan: fan,
          effectiveHeat: heat,
        })
        tMs += 1000
      }
    }
    const analysis = analyzeCalibrationRun(runOf(steps, samples))
    const hot = analysis.steps[1]
    expect(hot.sampleCount).toBeGreaterThan(0)
    expect(hot.floored).toBe(false)
    expect(hot.declaredFanLevel).toBe(1)
    expect(hot.fanLevel).toBe(1)
    expect(hot.steadyStateC).toBeDefined()

    const map = buildBaselineMap([runOf(steps, samples)])
    expect(map.flooredCount).toBe(0)
    expect(Object.keys(map.cells)).toContain('1:10')
  })
})

describe('suspect rows', () => {
  it('flags a fan row that falls with heat and leaves a rising one alone', () => {
    const falling = [
      {
        fanLevel: 4,
        points: [
          { heat: 1, steadyStateC: 138, extrapolated: false },
          { heat: 5, steadyStateC: 131, extrapolated: false },
          { heat: 10, steadyStateC: 115, extrapolated: false },
        ],
      },
    ]
    expect(suspectFanLevels(falling)).toEqual([4])

    const rising = [
      {
        fanLevel: 4,
        points: [
          { heat: 1, steadyStateC: 115, extrapolated: false },
          { heat: 5, steadyStateC: 190, extrapolated: false },
          { heat: 10, steadyStateC: 260, extrapolated: false },
        ],
      },
    ]
    expect(suspectFanLevels(rising)).toEqual([])

    // Noise inside the tolerance is not a physics violation.
    const jittery = [
      {
        fanLevel: 4,
        points: [
          { heat: 1, steadyStateC: 115, extrapolated: false },
          { heat: 5, steadyStateC: 115 - (SUSPECT_DROP_C - 0.5), extrapolated: false },
        ],
      },
    ]
    expect(suspectFanLevels(jittery)).toEqual([])
  })
})

describe('client-side CSV export', () => {
  it('round-trips a stored pass through the same parser that reads the controller log', () => {
    const samples: ThermalSample[] = [
      { tMs: 0, thermocoupleC: 24.75, coldJunctionC: 24.5, effectiveFan: 4, effectiveHeat: 0 },
      // A faulted probe writes blank columns, and must come back undefined rather than 0 °C.
      { tMs: 1000, thermocoupleC: undefined, coldJunctionC: undefined, effectiveFan: 4, effectiveHeat: 5 },
      { tMs: 2000, thermocoupleC: 61.5, coldJunctionC: 24.6, effectiveFan: 4, effectiveHeat: 5 },
    ]
    const csv = runToCsv(runOf([{ fan: 4, heat: 5 }], samples))
    expect(csv.split('\n')[0]).toBe('t_ms,thermocouple_c,cold_junction_c,effective_fan,effective_heat')
    expect(parseThermalCsv(csv)).toEqual(samples)
  })
})
