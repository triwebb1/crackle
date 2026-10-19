import { describe, expect, it } from 'vitest'
import { testRecordedOn } from '../testFixtures/provenance'
import { expandBaselineGrid, gridSummary, parseLevelList, programMaximumSec } from './calibrationProgram'
import {
  analyzeCalibrationRun,
  buildBaselineMap,
  comparePasses,
  curveFamily,
  fitSteadyState,
  meshKey,
  patchMatches,
  steadyState,
} from './thermalLog'
import type { CalibrationRun, CalibrationStep, ThermalSample } from './types'

const AMBIENT = 25
const TAU = 20
const SLOPE = 12
const FAN_COOLING = 3

const wobble = (index: number) => ((index % 7) - 3) * 0.02
const exponential = (from: number, to: number, seconds: number, tau: number) =>
  to - (to - from) * Math.exp(-seconds / tau)
// A base rise keeps even the coolest grid point above ambient, as an empty chamber under heat is.
const target = (step: CalibrationStep, offsetC: number) =>
  AMBIENT + 30 + SLOPE * step.heat - FAN_COOLING * step.fan + offsetC

interface RunShape {
  id?: string
  capturedAt?: string
  steps: CalibrationStep[]
  holdSeconds?: number
  ceilingC?: number
  offsetC?: number
  forcedSeconds?: number
  passiveSeconds?: number
}

// A pass whose every step is driven toward a known steady state, so the analysis has a truth to hit.
const pass = ({
  id = 'pass',
  capturedAt = '2026-07-26T10:00:00.000Z',
  steps,
  holdSeconds = 90,
  ceilingC = 320,
  offsetC = 0,
  forcedSeconds = 40,
  passiveSeconds = 800,
}: RunShape): CalibrationRun => {
  const samples: ThermalSample[] = []
  let temperature = AMBIENT
  let tMs = 0
  const push = (fan: number, heat: number) => {
    samples.push({ tMs, thermocoupleC: temperature, coldJunctionC: AMBIENT, effectiveFan: fan, effectiveHeat: heat })
    tMs += 1000
  }
  for (const step of steps) {
    const to = target(step, offsetC)
    const from = temperature
    for (let second = 0; second < holdSeconds; second += 1) {
      push(step.fan, step.heat)
      temperature = exponential(from, to, second + 1, TAU)
    }
  }
  for (let second = 0; second < forcedSeconds; second += 1) {
    push(8, 0)
    temperature = AMBIENT + (temperature - AMBIENT) * Math.exp(-1 / 45)
  }
  for (let second = 0; second < passiveSeconds; second += 1) {
    push(0, 0)
    temperature = AMBIENT + (temperature - AMBIENT) * Math.exp(-1 / 600)
  }
  // A ceiling of 0 stands for a .34-era pass, which records no ceiling and no margin at all.
  const bound = ceilingC > 0 ? { ceilingC, advanceMarginC: 15 } : {}
  return {
    id,
    capturedAt,
    recordedOn: testRecordedOn,
    form: 'grid',
    steps,
    maxStepSeconds: 120,
    minStepSeconds: 10,
    settleSeconds: 3,
    settleBandC: 5,
    ...bound,
    ambientC: AMBIENT,
    samples,
    notes: '',
  }
}

const GRID: CalibrationStep[] = expandBaselineGrid([9, 3], [1, 5, 10])

describe('serpentine grid expansion', () => {
  it('alternates direction per fan group and inserts no recovery steps', () => {
    const steps = expandBaselineGrid([9, 7, 5, 3], [1, 5, 10])
    expect(steps.map((step) => `${step.fan}:${step.heat}`).join(' ')).toBe(
      '9:1 9:5 9:10 7:10 7:5 7:1 5:1 5:5 5:10 3:10 3:5 3:1',
    )
    // Exactly fans x heats: no recovery steps between groups.
    expect(steps).toHaveLength(12)
    expect(steps.some((step) => step.heat === 0)).toBe(false)
  })

  it('keeps every fan change at the shared endpoint heat', () => {
    const steps = expandBaselineGrid([9, 7, 5], [1, 4, 7, 10])
    for (const [index, step] of steps.entries()) {
      const previous = steps[index - 1]
      if (!previous || previous.fan === step.fan) continue
      expect(step.heat).toBe(previous.heat)
    }
  })

  it('degenerates cleanly for single-axis grids', () => {
    expect(expandBaselineGrid([5], [3])).toEqual([{ fan: 5, heat: 3 }])
    expect(expandBaselineGrid([], [1, 2])).toEqual([])
    expect(expandBaselineGrid([5, 3], [])).toEqual([])
  })

  it('estimates the worst-case runtime from the expanded grid', () => {
    expect(programMaximumSec(expandBaselineGrid([9, 7, 5, 3], [1, 5, 10]), 120)).toBe(1440)
    expect(gridSummary([9, 3], [1, 5, 10])).toBe('2x3 grid, fans 9/3, heats 1/5/10')
  })

  it('validates grid axes as nonzero levels within the firmware counts', () => {
    expect(parseLevelList('9,7,5,3', 'fan', 6)).toEqual({ levels: [9, 7, 5, 3] })
    expect(parseLevelList(' 1 , 5 ,10 ', 'heat', 7)).toEqual({ levels: [1, 5, 10] })
    expect(parseLevelList('', 'fan', 6).error).toMatch(/at least one fan level/)
    expect(parseLevelList('9,7,5,3,2,1,0.5', 'fan', 6).error).toMatch(/At most 6 fan levels/)
    expect(parseLevelList('9,0', 'fan', 6).error).toMatch(/above 0.0/)
    expect(parseLevelList('9,11', 'fan', 6).error).toMatch(/above 0.0 and at most 10.0/)
    expect(parseLevelList('9,x', 'fan', 6).error).toMatch(/not a fan level/)
  })
})

describe('extrapolated steady state', () => {
  // A step cut short never plateaus, so the last-quarter mean is only a lower bound on Tss.
  const truncated = (tss: number, span: number, tau: number, fraction: number, noise = true) => {
    const stop = Math.ceil(-tau * Math.log(1 - fraction))
    return Array.from({ length: stop }, (_, second) => ({
      tSec: second,
      temperatureC: tss - span * Math.exp(-second / tau) + (noise ? wobble(second) : 0),
    }))
  }

  it('recovers the asymptote of an exponential truncated at 60 percent of its rise, within 10 percent', () => {
    const samples = truncated(250, 200, 45, 0.6)
    const fit = fitSteadyState(samples)
    expect(fit).toBeDefined()
    expect(samples[samples.length - 1].temperatureC).toBeLessThan(180)
    expect(Math.abs(fit!.steadyStateC - 250) / 250).toBeLessThan(0.1)
    expect(fit!.r2).toBeGreaterThan(0.99)
    // The direct estimator stops far short, which is exactly why the search exists.
    expect(steadyState(samples.map((sample) => sample.temperatureC))!).toBeLessThan(190)
  })

  it('recovers tau alongside the asymptote', () => {
    const fit = fitSteadyState(truncated(300, 260, 60, 0.65, false))
    expect(Math.abs(fit!.steadyStateC - 300) / 300).toBeLessThan(0.05)
    expect(Math.abs(fit!.tauSec - 60) / 60).toBeLessThan(0.1)
  })

  it('guards degenerate windows instead of inventing an asymptote', () => {
    expect(fitSteadyState([])).toBeUndefined()
    expect(
      fitSteadyState(Array.from({ length: 4 }, (_, second) => ({ tSec: second, temperatureC: 20 + second }))),
    ).toBeUndefined()
    expect(
      fitSteadyState(Array.from({ length: 30 }, (_, second) => ({ tSec: second, temperatureC: 40 }))),
    ).toBeUndefined()
    expect(
      fitSteadyState(Array.from({ length: 30 }, (_, second) => ({ tSec: second, temperatureC: 200 - second }))),
    ).toBeUndefined()
  })

  it('never marks a step limited on a pass that recorded no ceiling, as 2026-07-26.34+ passes do not', () => {
    // Same short, hot step as the legacy case below, but with no bound recorded anywhere.
    const modern = pass({ steps: [{ fan: 3, heat: 10 }], holdSeconds: 40, ceilingC: 0, passiveSeconds: 300 })
    const analysis = analyzeCalibrationRun(modern)
    expect(modern.ceilingC).toBeUndefined()
    expect(analysis.limitC).toBeUndefined()
    expect(analysis.limitedSteps).toBe(0)
    expect(analysis.skippedSteps).toBe(0)
    expect(analysis.steps[0].limited).toBe(false)
    // Extrapolation still applies, because the step was capped rather than settled.
    expect(analyzeCalibrationRun({ ...modern, maxStepSeconds: 40 }).steps[0].extrapolated).toBe(true)
  })

  it('marks a ceiling-limited step extrapolated and projects above its observed peak', () => {
    const limited = pass({ steps: [{ fan: 3, heat: 10 }], holdSeconds: 40, ceilingC: 90, passiveSeconds: 300 })
    const step = analyzeCalibrationRun(limited).steps[0]
    expect(step.limited).toBe(true)
    expect(step.extrapolated).toBe(true)
    expect(step.steadyStateR2!).toBeGreaterThan(0.9)
    expect(step.steadyStateC!).toBeGreaterThan(
      Math.max(...limited.samples.slice(0, 40).map((sample) => sample.thermocoupleC ?? 0)),
    )
  })

  it('leaves a settled step measured rather than extrapolated', () => {
    const settled = analyzeCalibrationRun(pass({ steps: GRID }))
    expect(settled.steps.every((step) => step.extrapolated === false)).toBe(true)
    expect(settled.limitedSteps).toBe(0)
  })
})

describe('mesh curve families and pass comparison', () => {
  const baseline = analyzeCalibrationRun(pass({ steps: GRID }))

  it('derives one curve per fan level, high fan first and ascending in heat', () => {
    const curves = curveFamily(baseline)
    expect(curves.map((curve) => curve.fanLevel)).toEqual([9, 3])
    expect(curves[0].points.map((point) => point.heat)).toEqual([1, 5, 10])
    // The serpentine ran fan 3 descending; the curve is still presented ascending.
    expect(curves[1].points.map((point) => point.heat)).toEqual([1, 5, 10])
    expect(curves.every((curve) => curve.points.every((point) => point.extrapolated === false))).toBe(true)
    // Less airflow settles hotter at the same heat.
    expect(curves[1].points[2].steadyStateC).toBeGreaterThan(curves[0].points[2].steadyStateC)
    expect(curves[0].points.every((point) => point.tauSec !== undefined)).toBe(true)
  })

  it('recovers a known offset between two passes, with sign', () => {
    const drifted = analyzeCalibrationRun(pass({ id: 'later', steps: GRID, offsetC: 7 }))
    const delta = comparePasses(curveFamily(drifted), curveFamily(baseline))
    expect(delta.points).toHaveLength(6)
    expect(delta.meanDeltaC!).toBeCloseTo(7, 0)
    expect(delta.meanAbsDeltaC!).toBeCloseTo(7, 0)
    expect(delta.onlyCurrent).toBe(0)
    expect(delta.onlyPrevious).toBe(0)
    // Positive means the current pass runs hotter than the one it is compared against.
    expect(delta.points.every((point) => point.deltaC > 0)).toBe(true)
    expect(comparePasses(curveFamily(baseline), curveFamily(drifted)).meanDeltaC!).toBeCloseTo(-7, 0)
  })

  it('reports near-zero drift for a repeated pass, which is the repeatability proof', () => {
    const repeat = analyzeCalibrationRun(pass({ id: 'repeat', steps: GRID }))
    const delta = comparePasses(curveFamily(repeat), curveFamily(baseline))
    expect(delta.meanAbsDeltaC!).toBeLessThan(0.01)
    expect(delta.maxAbsDeltaC!).toBeLessThan(0.01)
    expect(delta.worst).toBeDefined()
  })

  it('counts points present in only one pass instead of silently dropping them', () => {
    const partial = analyzeCalibrationRun(
      pass({
        steps: [
          { fan: 9, heat: 1 },
          { fan: 9, heat: 5 },
        ],
      }),
    )
    const delta = comparePasses(curveFamily(partial), curveFamily(baseline))
    expect(delta.points).toHaveLength(2)
    expect(delta.onlyPrevious).toBe(4)
    expect(delta.onlyCurrent).toBe(0)
    expect(comparePasses([], curveFamily(baseline)).points).toEqual([])
  })

  it('aggregates passes into a map, preferring measured points and then newer captures', () => {
    const older = pass({ id: 'older', capturedAt: '2026-01-01T00:00:00.000Z', steps: [{ fan: 9, heat: 5 }] })
    const newer = pass({
      id: 'newer',
      capturedAt: '2026-07-01T00:00:00.000Z',
      steps: [{ fan: 9, heat: 5 }],
      offsetC: 4,
    })
    const map = buildBaselineMap([older, newer])
    expect(map.runCount).toBe(2)
    expect(map.fans).toEqual([9])
    expect(map.heats).toEqual([5])
    expect(map.cells[meshKey(9, 5)].runId).toBe('newer')

    // A measured point outranks an extrapolated one even when the extrapolation is newer.
    const limited = pass({
      id: 'limited',
      capturedAt: '2026-12-01T00:00:00.000Z',
      steps: [{ fan: 9, heat: 5 }],
      holdSeconds: 40,
      ceilingC: 90,
    })
    const mixed = buildBaselineMap([newer, limited])
    expect(mixed.cells[meshKey(9, 5)].runId).toBe('newer')
    expect(mixed.cells[meshKey(9, 5)].extrapolated).toBe(false)
    expect(mixed.extrapolatedCount).toBe(0)
    expect(buildBaselineMap([]).runCount).toBe(0)
  })

  it('matches a stored patch against applied settings only when every field agrees', () => {
    const patch = { heaterGainCPerMinAt10: 39, thermalLossPerMinPerC: 0.018 }
    expect(
      patchMatches(patch, { heaterGainCPerMinAt10: 39, thermalLossPerMinPerC: 0.018, coolingFanCPerMinAt10: 22 }),
    ).toBe(true)
    expect(patchMatches(patch, { heaterGainCPerMinAt10: 39, thermalLossPerMinPerC: 0.02 })).toBe(false)
    expect(patchMatches(patch, { heaterGainCPerMinAt10: 39 })).toBe(false)
    // An empty patch is never "applied": it asserts nothing.
    expect(patchMatches({}, { heaterGainCPerMinAt10: 39 })).toBe(false)
  })
})
