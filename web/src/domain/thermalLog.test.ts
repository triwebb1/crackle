import { describe, expect, it } from 'vitest'
import { testRecordedOn } from '../testFixtures/provenance'
import {
  afterRebound,
  analyzeCalibrationRun,
  baselineMapFromCurves,
  buildBaselineMap,
  curvesFromBaselineMap,
  decayTau,
  dedupeRecordings,
  linearFit,
  parseThermalCsv,
  primaryGain,
  recordingFingerprint,
  riseTau,
  segmentByActuators,
  stageCalibration,
  steadyState,
  thermalCsvHeader,
} from './thermalLog'
import type { CalibrationForm, CalibrationRun, CalibrationStep, ThermalSample } from './types'

const AMBIENT = 25
const TAU = 20
const SLOPE = 12
const FAN_COOLING = 3
const MAX_STEP_SECONDS = 120
const STEPS: CalibrationStep[] = [
  { fan: 3, heat: 2 },
  { fan: 3, heat: 4 },
  { fan: 3, heat: 6 },
  { fan: 3, heat: 8 },
]

// A deterministic wobble stands in for sensor noise without making the test flaky.
const wobble = (index: number) => ((index % 7) - 3) * 0.02

const exponential = (from: number, to: number, seconds: number, tau: number) =>
  to - (to - from) * Math.exp(-seconds / tau)

// Steady rise falls with fan, which is what lets a multi-fan run separate the airflow term.
const target = (step: CalibrationStep, offsetC = 0) => AMBIENT + SLOPE * step.heat - FAN_COOLING * step.fan + offsetC

interface RunShape {
  id?: string
  capturedAt?: string
  form?: CalibrationForm
  steps?: CalibrationStep[]
  // Adaptive settling means real holds vary in length; the analysis must not assume a fixed clock.
  holdSeconds?: number[]
  forcedSeconds?: number
  passiveSeconds?: number
  ceilingC?: number
  offsetC?: number
}

const syntheticRun = ({
  id = 'synthetic',
  capturedAt = '2026-07-26T10:00:00.000Z',
  form = 'steps',
  steps = STEPS,
  holdSeconds,
  forcedSeconds = 40,
  passiveSeconds = 900,
  ceilingC = 320,
  offsetC = 0,
}: RunShape = {}): CalibrationRun => {
  const samples: ThermalSample[] = []
  let temperature = AMBIENT
  let tMs = 0
  const push = (fan: number, heat: number) => {
    samples.push({ tMs, thermocoupleC: temperature, coldJunctionC: AMBIENT, effectiveFan: fan, effectiveHeat: heat })
    tMs += 1000
  }
  for (const [index, step] of steps.entries()) {
    const to = target(step, offsetC)
    const from = temperature
    const hold = holdSeconds?.[index] ?? 60
    for (let second = 0; second < hold; second += 1) {
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
  return {
    id,
    capturedAt,
    recordedOn: testRecordedOn,
    form,
    steps,
    maxStepSeconds: MAX_STEP_SECONDS,
    minStepSeconds: 20,
    settleSeconds: 5,
    settleBandC: 2,
    ceilingC,
    advanceMarginC: 15,
    ambientC: AMBIENT,
    samples,
    notes: '',
  }
}

describe('thermal csv parsing', () => {
  it('reads the firmware log and keeps blank sensor fields undefined rather than zero', () => {
    const csv = [
      thermalCsvHeader,
      '0,24.75,23.50,0.0,0.0',
      '1000,,,5.0,0.0',
      '2000,31.25,23.60,5.0,3.0',
      '',
      '3000,40.00,,5.0,3.0',
      '   ',
    ].join('\r\n')
    const samples = parseThermalCsv(csv)
    expect(samples).toHaveLength(4)
    expect(samples[0]).toEqual({ tMs: 0, thermocoupleC: 24.75, coldJunctionC: 23.5, effectiveFan: 0, effectiveHeat: 0 })
    expect(samples[1].thermocoupleC).toBeUndefined()
    expect(samples[1].coldJunctionC).toBeUndefined()
    expect(samples[1].effectiveFan).toBe(5)
    expect(samples[3].coldJunctionC).toBeUndefined()
    expect(samples[3].thermocoupleC).toBe(40)
  })

  it('skips rows without a usable timestamp, tolerates a missing header, and sorts by time', () => {
    expect(parseThermalCsv('2000,30,24,1,2\n1000,29,24,1,2')[0].tMs).toBe(1000)
    expect(parseThermalCsv('nope,30,24,1,2\n,,,,\n1000,29,24,1,2')).toHaveLength(1)
    expect(parseThermalCsv('')).toEqual([])
    expect(parseThermalCsv(thermalCsvHeader)).toEqual([])
  })

  it('defaults absent actuator columns to zero without inventing a temperature', () => {
    expect(parseThermalCsv('1000,,')).toEqual([
      { tMs: 1000, thermocoupleC: undefined, coldJunctionC: undefined, effectiveFan: 0, effectiveHeat: 0 },
    ])
  })
})

describe('fits', () => {
  it('estimates steady state from the last quarter of a hold', () => {
    expect(steadyState([0, 0, 0, 0, 10, 10, 10, 10])).toBe(10)
    expect(steadyState([5])).toBe(5)
    expect(steadyState([])).toBeUndefined()
    expect(steadyState([Number.NaN, 4])).toBe(4)
  })

  it('recovers tau from a synthetic exponential rise within 5 percent', () => {
    const samples = Array.from({ length: 90 }, (_, second) => ({
      tSec: second,
      temperatureC: exponential(25, 145, second, 30) + wobble(second),
    }))
    const tau = riseTau(samples, 145)
    expect(tau).toBeDefined()
    expect(Math.abs(tau! - 30) / 30).toBeLessThan(0.05)
  })

  it('recovers tau from a synthetic exponential decay within 5 percent', () => {
    const samples = Array.from({ length: 600 }, (_, second) => ({
      tSec: second,
      temperatureC: 25 + 150 * Math.exp(-second / 240) + wobble(second),
    }))
    const tau = decayTau(samples, 25)
    expect(tau).toBeDefined()
    expect(Math.abs(tau! - 240) / 240).toBeLessThan(0.05)
  })

  it('guards degenerate tau cases instead of returning a nonsense constant', () => {
    expect(riseTau([], 100)).toBeUndefined()
    expect(riseTau([{ tSec: 0, temperatureC: 100 }], 100.5)).toBeUndefined()
    expect(
      riseTau(
        Array.from({ length: 40 }, (_, second) => ({ tSec: second, temperatureC: 40 })),
        120,
      ),
    ).toBeUndefined()
    expect(
      riseTau(
        Array.from({ length: 40 }, (_, second) => ({ tSec: second, temperatureC: 40 - second })),
        120,
      ),
    ).toBeUndefined()
    expect(
      decayTau(
        Array.from({ length: 40 }, (_, second) => ({ tSec: second, temperatureC: 200 })),
        25,
      ),
    ).toBeUndefined()
  })

  it('regresses exact and noisy linear data and reports R2', () => {
    const exact = linearFit([2, 4, 6, 8].map((x) => ({ x, y: 3.5 * x + 11 })))
    expect(exact?.slope).toBeCloseTo(3.5, 10)
    expect(exact?.intercept).toBeCloseTo(11, 10)
    expect(exact?.r2).toBeCloseTo(1, 10)

    const scatter = [0.3, -0.2, -0.3, 0.2]
    const noisy = linearFit([2, 4, 6, 8].map((x, index) => ({ x, y: 3.5 * x + 11 + scatter[index] })))
    expect(noisy?.slope).toBeCloseTo(3.5, 1)
    expect(noisy!.r2).toBeGreaterThan(0.98)
    expect(noisy!.r2).toBeLessThan(1)

    expect(linearFit([{ x: 1, y: 1 }])).toBeUndefined()
    expect(
      linearFit([
        { x: 1, y: 1 },
        { x: 1, y: 5 },
      ]),
    ).toBeUndefined()
    expect(
      linearFit([
        { x: 1, y: 4 },
        { x: 2, y: 4 },
      ])?.r2,
    ).toBe(1)
  })
})

describe('actuator segmentation', () => {
  const sample = (tMs: number, effectiveFan: number, effectiveHeat: number) => ({
    tMs,
    thermocoupleC: 30,
    coldJunctionC: 25,
    effectiveFan,
    effectiveHeat,
  })

  it('starts a new segment when fan changes even though heat does not', () => {
    const segments = segmentByActuators([sample(0, 3, 5), sample(1000, 3, 5), sample(2000, 5, 5), sample(3000, 5, 5)])
    expect(segments.map((segment) => [segment.fan, segment.heat])).toEqual([
      [3, 5],
      [5, 5],
    ])
    expect(segments.map((segment) => segment.samples.length)).toEqual([2, 2])
  })

  it('starts a new segment when heat changes even though fan does not', () => {
    const segments = segmentByActuators([sample(0, 3, 1), sample(1000, 3, 3), sample(2000, 3, 3)])
    expect(segments.map((segment) => segment.heat)).toEqual([1, 3])
  })

  it('absorbs formatting jitter but not a real level change', () => {
    const segments = segmentByActuators([sample(0, 3, 5), sample(1000, 3.02, 5), sample(2000, 3.4, 5)])
    expect(segments).toHaveLength(2)
  })
})

describe('calibration run analysis', () => {
  const analysis = analyzeCalibrationRun(syntheticRun())

  it('recovers each declared step from the log rather than from a fixed clock', () => {
    // Holds of 40/95/60/50 s would all be mis-sliced by nominal-timing segmentation.
    const adaptive = analyzeCalibrationRun(syntheticRun({ holdSeconds: [40, 95, 60, 50] }))
    expect(adaptive.steps.map((step) => step.sampleCount)).toEqual([40, 95, 60, 50])
    expect(adaptive.steps.map((step) => step.durationSec)).toEqual([39, 94, 59, 49])
    expect(adaptive.steps.map((step) => step.startSec)).toEqual([0, 40, 135, 195])
    expect(adaptive.steps.every((step) => step.capped === false)).toBe(true)
  })

  it('flags a step that ran to the cap instead of settling', () => {
    const capped = analyzeCalibrationRun(syntheticRun({ holdSeconds: [MAX_STEP_SECONDS, 30, 30, 30] }))
    expect(capped.steps[0].capped).toBe(true)
    expect(capped.steps[1].capped).toBe(false)
  })

  it('reports one row per step with its fan:heat pair, steady state, rise, and tau', () => {
    expect(analysis.steps).toHaveLength(4)
    expect(analysis.steps.map((step) => [step.fanLevel, step.heatLevel])).toEqual([
      [3, 2],
      [3, 4],
      [3, 6],
      [3, 8],
    ])
    expect(analysis.steps.every((step) => step.recovery === false)).toBe(true)
    expect(analysis.steps.every((step) => step.tauSec !== undefined)).toBe(true)
    expect(analysis.fanLevels).toEqual([3])
    expect(analysis.ambientC).toBe(AMBIENT)
    expect(analysis.peakC).toBeGreaterThan(100)
  })

  it('fits one gain group per fan level, close to the synthetic slope with a high R2', () => {
    expect(analysis.gains).toHaveLength(1)
    expect(analysis.gains[0].fanLevel).toBe(3)
    expect(analysis.gains[0].points).toBe(4)
    expect(Math.abs(analysis.gains[0].slope - SLOPE) / SLOPE).toBeLessThan(0.05)
    expect(analysis.gains[0].r2).toBeGreaterThan(0.999)
    expect(primaryGain(analysis)).toBe(analysis.gains[0])
  })

  it('groups the gain fit by fan level on a run that sweeps both variables', () => {
    const mixed = analyzeCalibrationRun(
      syntheticRun({
        steps: [
          { fan: 3, heat: 3 },
          { fan: 3, heat: 6 },
          { fan: 6, heat: 6 },
          { fan: 6, heat: 3 },
          { fan: 6, heat: 8 },
        ],
        holdSeconds: [90, 90, 90, 90, 90],
      }),
    )
    expect(mixed.fanLevels).toEqual([3, 6])
    expect(mixed.gains.map((fit) => fit.fanLevel)).toEqual([3, 6])
    expect(mixed.gains.map((fit) => fit.points)).toEqual([2, 3])
    // The better-supported group wins, so the staged gain rests on the most evidence.
    expect(primaryGain(mixed)?.fanLevel).toBe(6)
    for (const fit of mixed.gains) expect(Math.abs(fit.slope - SLOPE) / SLOPE).toBeLessThan(0.1)
  })

  it('gives a fan-only transition its own analysed step', () => {
    const fanOnly = analyzeCalibrationRun(
      syntheticRun({
        steps: [
          { fan: 3, heat: 5 },
          { fan: 8, heat: 5 },
        ],
        holdSeconds: [90, 90],
      }),
    )
    expect(fanOnly.steps).toHaveLength(2)
    expect(fanOnly.steps.every((step) => step.sampleCount === 90)).toBe(true)
    // Same heat, more airflow, so the second step settles lower - a down-transition, which is
    // first-order too and therefore carries its own time constant rather than none.
    expect(fanOnly.steps[1].steadyStateC!).toBeLessThan(fanOnly.steps[0].steadyStateC!)
    expect(fanOnly.steps[1].tauSec).toBeDefined()
    expect(fanOnly.gains).toEqual([])
  })

  it('splits the tail into forced cooling and passive decay', () => {
    expect(analysis.forced?.fanLevel).toBe(8)
    expect(analysis.forced?.seconds).toBe(39)
    expect(analysis.forced!.ratePerMin).toBeGreaterThan(0)
    expect(Math.abs(analysis.passiveTauSec! - 600) / 600).toBeLessThan(0.05)
  })

  it('treats a zero heat step as a recovery step and keeps it out of the gain fit', () => {
    const recovery = analyzeCalibrationRun(
      syntheticRun({
        steps: [
          { fan: 3, heat: 2 },
          { fan: 3, heat: 0 },
          { fan: 3, heat: 6 },
          { fan: 3, heat: 8 },
        ],
      }),
    )
    expect(recovery.steps[1].recovery).toBe(true)
    expect(recovery.gains[0].points).toBe(3)
  })

  it('reports a step it never observed instead of inventing a window', () => {
    const truncated = syntheticRun()
    const missing = analyzeCalibrationRun({ ...truncated, steps: [...truncated.steps, { fan: 3, heat: 10 }] })
    expect(missing.steps).toHaveLength(5)
    expect(missing.steps[4].sampleCount).toBe(0)
    expect(missing.steps[4].durationSec).toBeUndefined()
    expect(missing.steps[4].capped).toBe(false)
    expect(missing.steps[4].steadyStateC).toBeUndefined()
    // The unobserved trailing step must not swallow the cooling tail.
    expect(Math.abs(missing.passiveTauSec! - 600) / 600).toBeLessThan(0.05)
  })

  it('survives a log with no readable temperatures at all', () => {
    const blind = analyzeCalibrationRun({
      ...syntheticRun(),
      ambientC: undefined,
      samples: [{ tMs: 0, effectiveFan: 5, effectiveHeat: 3 }],
    })
    expect(blind.peakC).toBeUndefined()
    expect(blind.gains).toEqual([])
    expect(blind.passiveTauSec).toBeUndefined()
    expect(blind.steps.every((step) => step.steadyStateC === undefined)).toBe(true)
  })
})

/**
 * ============================================================================================
 * THE HEAT-SOAK REBOUND, END TO END, ON A TAIL SHAPED LIKE THE FIRMWARE'S OWN
 * ============================================================================================
 *
 * The passive tail is the anchor of the whole calibration: thermal loss is `60 / passive tau`, and
 * every heater and fan coefficient is fitted against that loss. So a tau that is biased long is not
 * a cosmetic error in one reported field, it is a chamber that the model believes holds its heat
 * better than it does, everywhere.
 *
 * And the bias has a specific cause with a specific sign. For the first half-minute after the fan
 * stops, the probe RISES - the surrounding mass soaks back into a sensor that had been sitting in
 * moving air. The firmware keeps that half-minute, deliberately: a temperature-based early exit was
 * withdrawn and the tail is closed on the clock at three minutes, so the recording holds the soak
 * and the decay together and nothing is thrown away at capture time. Knowing which part is which is
 * the ANALYSIS's job.
 *
 * The tail below is that shape, to the byte the firmware would write it in: 60 °C at fan-off, soaking
 * up to 68 °C over about thirty seconds, then a clean exponential decay to ambient with tau exactly
 * 300 s, sampled at 1 Hz, quantized to the deci-degree the log stores, and cut at 180 samples by the
 * three-minute rule. The true answer is therefore known, which is the entire point: 300.
 */
describe('the fan-off tail, with the rebound the firmware keeps and the analysis must skip', () => {
  const TRUE_PASSIVE_TAU = 300
  const SOAK_TAU = 10
  const FAN_OFF_C = 60
  const SOAK_PEAK_C = 68
  const SOAK_SECONDS = 30
  /** The firmware closes the tail on the clock at three minutes; nothing about temperature. */
  const FIRMWARE_TAIL_SECONDS = 180

  const soakThenDecay = (second: number) => {
    const climbed = (elapsed: number) => SOAK_PEAK_C - (SOAK_PEAK_C - FAN_OFF_C) * Math.exp(-elapsed / SOAK_TAU)
    if (second <= SOAK_SECONDS) return climbed(second)
    return AMBIENT + (climbed(SOAK_SECONDS) - AMBIENT) * Math.exp(-(second - SOAK_SECONDS) / TRUE_PASSIVE_TAU)
  }

  /** As the recording stores it: deci-degrees, plus this file's deterministic stand-in for noise. */
  const logged = (value: number, second: number) => Math.round((value + wobble(second)) * 10) / 10

  const fanOffTail = (shape: (second: number) => number) =>
    Array.from({ length: FIRMWARE_TAIL_SECONDS }, (_, second) => ({
      tSec: second,
      temperatureC: logged(shape(second), second),
    }))

  /** One held step so the run has something to match, then the fan-off tail as its trailing segment. */
  const runWithTail = (tail: Array<{ tSec: number; temperatureC: number }>): CalibrationRun => {
    const step: CalibrationStep = { fan: 3, heat: 4 }
    const samples: ThermalSample[] = []
    for (let second = 0; second < 60; second += 1) {
      samples.push({
        tMs: second * 1000,
        thermocoupleC: logged(exponential(AMBIENT, target(step), second, TAU), second),
        coldJunctionC: AMBIENT,
        effectiveFan: step.fan,
        effectiveHeat: step.heat,
      })
    }
    for (const sample of tail) {
      samples.push({
        tMs: (60 + sample.tSec) * 1000,
        thermocoupleC: sample.temperatureC,
        coldJunctionC: AMBIENT,
        effectiveFan: 0,
        effectiveHeat: 0,
      })
    }
    return {
      id: 'rebound',
      capturedAt: '2026-07-26T10:00:00.000Z',
      recordedOn: testRecordedOn,
      form: 'steps',
      steps: [step],
      maxStepSeconds: MAX_STEP_SECONDS,
      minStepSeconds: 20,
      settleSeconds: 5,
      settleBandC: 2,
      ceilingC: 320,
      advanceMarginC: 15,
      ambientC: AMBIENT,
      samples,
      notes: '',
    }
  }

  it('recovers the true time constant from a tail whose first thirty seconds are a rebound', () => {
    const tail = fanOffTail(soakThenDecay)
    // The tail really does rise first, or this test is not testing anything.
    expect(tail[SOAK_SECONDS].temperatureC).toBeGreaterThan(tail[0].temperatureC + 7)

    const fitted = analyzeCalibrationRun(runWithTail(tail)).passiveTauSec
    expect(fitted).toBeDefined()
    // Within 2% of 300 s. It lands at about 299.9: the trimmed window is the exponential itself.
    expect(Math.abs(fitted! - TRUE_PASSIVE_TAU) / TRUE_PASSIVE_TAU).toBeLessThan(0.02)

    /*
     * THE COUNTER-ASSERTION. This is the old behaviour, computed off the identical samples: every
     * fan-off sample fed to `decayTau`, rebound included. Least squares cannot reject a stretch
     * where `ln(T - ambient)` is GROWING; it flattens the line to accommodate it, and a flatter
     * line is a longer tau. So the error has a sign, and it is always the same sign.
     */
    const biased = decayTau(tail, AMBIENT)!
    expect(biased).toBeGreaterThan(355)
    expect(Math.abs(biased - TRUE_PASSIVE_TAU) / TRUE_PASSIVE_TAU).toBeGreaterThan(0.02)
    expect(biased).toBeGreaterThan(fitted!)
    // Which is what it costs downstream: a thermal loss (60 / tau) more than 15% too small.
    expect(60 / biased).toBeLessThan((60 / TRUE_PASSIVE_TAU) * 0.85)
  })

  it('leaves a tail that never rebounded exactly as it found it', () => {
    const plain = fanOffTail((second) => AMBIENT + (FAN_OFF_C - AMBIENT) * Math.exp(-second / TRUE_PASSIVE_TAU))
    // Falling from the first sample, so the maximum IS the first sample and nothing is trimmed.
    expect(afterRebound(plain)).toBe(plain)
    const fitted = analyzeCalibrationRun(runWithTail(plain)).passiveTauSec
    expect(Math.abs(fitted! - TRUE_PASSIVE_TAU) / TRUE_PASSIVE_TAU).toBeLessThan(0.03)
  })

  /**
   * A plausible wrong tau is worse than no tau. It stages a loss coefficient that looks exactly like
   * a good one, and the pass carries it into every other coefficient fitted against it - whereas an
   * absent one is reported as absent, and the operator runs the pass again.
   */
  it('reports no fit at all rather than a garbage one when the tail never turns over', () => {
    // A probe that has come loose and is reading its own surroundings warming: monotonic, forever.
    const stuck = fanOffTail((second) => FAN_OFF_C + second * 0.05)
    expect(afterRebound(stuck)).toBeUndefined()
    expect(analyzeCalibrationRun(runWithTail(stuck)).passiveTauSec).toBeUndefined()

    // And turning over three samples from the end is the same case: not enough curve to identify a
    // time constant, so none is offered.
    const lateTurn = fanOffTail((second) =>
      second <= 177 ? FAN_OFF_C + second * 0.2 : FAN_OFF_C + 177 * 0.2 - (second - 177) * 2,
    )
    expect(afterRebound(lateTurn)).toBeUndefined()
    expect(analyzeCalibrationRun(runWithTail(lateTurn)).passiveTauSec).toBeUndefined()
  })
})

describe('staging onto calibration coefficients', () => {
  const analysis = analyzeCalibrationRun(syntheticRun())

  it('derives thermal loss from the passive tail and the heat gain from it', () => {
    const { patch, entries } = stageCalibration(analysis)
    expect(patch.thermalLossPerMinPerC).toBeCloseTo(0.1, 2)
    expect(patch.heaterGainCPerMinAt10).toBeCloseTo(10 * primaryGain(analysis)!.slope * patch.thermalLossPerMinPerC!, 1)
    expect(entries.find((entry) => entry.key === 'loss')?.field).toBe('thermalLossPerMinPerC')
    expect(entries.find((entry) => entry.key === 'gain-slope')?.field).toBeUndefined()
    expect(entries.find((entry) => entry.key === 'gain-slope')?.basis).toMatch(/at fan 3.0/)
  })

  it('leaves fan cooling informational on a single-fan run and derives it from a second run', () => {
    const alone = stageCalibration(analysis)
    expect(alone.patch.fanCoolingCPerMinAt10).toBeUndefined()
    expect(alone.entries.find((entry) => entry.key === 'fan-cooling')?.value).toBeUndefined()

    const higher = analyzeCalibrationRun(
      syntheticRun({ id: 'fan-8', steps: STEPS.map((step) => ({ fan: 8, heat: step.heat })) }),
    )
    const paired = stageCalibration(analysis, higher)
    expect(paired.patch.fanCoolingCPerMinAt10).toBeGreaterThan(0)
    expect(paired.entries.find((entry) => entry.key === 'fan-cooling')?.field).toBe('fanCoolingCPerMinAt10')
    expect(paired.entries.find((entry) => entry.key === 'fan-cooling')?.basis).toMatch(/comparison/)
  })

  it('derives fan cooling from a single run that itself holds one heat at two fan levels', () => {
    const multiFan = analyzeCalibrationRun(
      syntheticRun({
        steps: [
          { fan: 3, heat: 4 },
          { fan: 3, heat: 8 },
          { fan: 8, heat: 8 },
          { fan: 8, heat: 4 },
        ],
        holdSeconds: [110, 110, 110, 110],
      }),
    )
    const { patch, entries } = stageCalibration(multiFan)
    expect(patch.fanCoolingCPerMinAt10).toBeGreaterThan(0)
    const basis = entries.find((entry) => entry.key === 'fan-cooling')?.basis
    expect(basis).toMatch(/2 same-heat pairs/)
    expect(basis).toMatch(/this run$/)
  })

  it('stages nothing and explains itself when no passive tail anchors the loss', () => {
    const { patch, entries } = stageCalibration({ ...analysis, passiveTauSec: undefined })
    expect(patch).toEqual({})
    expect(entries.every((entry) => entry.field === undefined)).toBe(true)
    expect(entries.find((entry) => entry.key === 'loss')?.basis).toMatch(/passive decay tail/)
  })
})

/**
 * ============================================================================================
 * ONE RECORDING IS STORED ONCE
 * ============================================================================================
 *
 * Re-importing the same recording over and over must not fill the list with copies of one report.
 * The import path refuses to do that, but a library may already hold such copies, so they are
 * collapsed as they are read.
 */
describe('recording identity', () => {
  const base = syntheticRun({ id: 'a' })

  it('recognises two imports of one roaster recording by the id the roaster gave it', () => {
    const first = { ...base, id: 'a', sourceLogId: '7', capturedAt: '2026-07-26T10:00:00.000Z' }
    const second = { ...base, id: 'b', sourceLogId: '7', capturedAt: '2026-07-27T10:00:00.000Z' }
    expect(recordingFingerprint(first)).toBe(recordingFingerprint(second))
    const kept = dedupeRecordings([first, second])
    expect(kept.map((run) => run.id)).toEqual(['a'])
  })

  it('recognises copies with no roaster id by what they contain, and keeps the oldest', () => {
    // Two imports of one recording differ in id and in capture time - which is when the COPY was
    // made - and agree in every sample. The content is the only thing that can recognise them.
    const older = { ...base, id: 'older', capturedAt: '2026-07-26T10:00:00.000Z' }
    const newer = { ...base, id: 'newer', capturedAt: '2026-07-28T10:00:00.000Z' }
    expect(dedupeRecordings([newer, older]).map((run) => run.id)).toEqual(['older'])
  })

  it('never collapses two genuinely different recordings', () => {
    const other = syntheticRun({
      id: 'b',
      steps: [
        { fan: 8, heat: 2 },
        { fan: 8, heat: 6 },
      ],
    })
    expect(dedupeRecordings([base, other])).toHaveLength(2)
  })

  /** Classification is work the user did, so it survives the copy it was done on being dropped. */
  it('carries a classification made on a duplicate onto the copy that is kept', () => {
    const older = { ...base, id: 'older', capturedAt: '2026-07-26T10:00:00.000Z' }
    const named = { ...base, id: 'newer', capturedAt: '2026-07-28T10:00:00.000Z', roastRunId: 'roast-1', massG: 225 }
    const [kept] = dedupeRecordings([older, named])
    expect(kept.id).toBe('older')
    expect(kept.roastRunId).toBe('roast-1')
    expect(kept.massG).toBe(225)
  })
})

/**
 * The pooled surface as curves: the shape a saved calibration stores. It is a change of SHAPE and
 * never a second merge - the map is the only place several passes are pooled.
 */
describe('curves from the pooled surface', () => {
  it('writes one curve per fan level, points ascending in heat, from the map itself', () => {
    const map = buildBaselineMap([
      syntheticRun({ id: 'a' }),
      syntheticRun({
        id: 'b',
        steps: [
          { fan: 8, heat: 4 },
          { fan: 8, heat: 8 },
        ],
        holdSeconds: [110, 110],
      }),
    ])
    const curves = curvesFromBaselineMap(map)
    expect(curves.map((curve) => curve.fanLevel)).toEqual(map.fans)
    for (const curve of curves) {
      expect(curve.points.length).toBeGreaterThan(0)
      expect(curve.points.map((point) => point.heat)).toEqual(
        [...curve.points.map((point) => point.heat)].sort((a, b) => a - b),
      )
    }
    // Every mapped cell is represented exactly once, so the shape change loses and invents nothing.
    expect(curves.reduce((count, curve) => count + curve.points.length, 0)).toBe(Object.keys(map.cells).length)
  })

  it('rehydrates the saved surface when source recordings no longer retain samples', () => {
    const original = buildBaselineMap([syntheticRun({ id: 'a' })])
    const restored = baselineMapFromCurves(curvesFromBaselineMap(original), {
      runId: 'snapshot-a',
      capturedAt: '2026-07-30T00:00:00.000Z',
      runCount: 2,
    })
    expect(Object.keys(restored.cells)).toEqual(Object.keys(original.cells))
    expect(restored.runCount).toBe(2)
    expect(Object.values(restored.cells).every((cell) => cell.runId === 'snapshot-a')).toBe(true)
  })

  it('has nothing to write when nothing settled', () => {
    expect(curvesFromBaselineMap(buildBaselineMap([]))).toEqual([])
  })
})
