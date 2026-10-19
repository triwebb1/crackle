import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterProfile, starterThermalIntent } from '../data/demo'
import { correctionsBetween, summarizeControlCorrections, summarizeJourneyZones } from './controlResidual'
import { simulateJourney, simulateProfileSnapshot } from './profileSimulation'
import type { ControlCorrection } from './types'

const correction = (over: Partial<ControlCorrection> = {}): ControlCorrection => ({
  errorC: 0,
  proportionalRatePerMin: 0,
  integralRatePerMin: 0,
  totalRatePerMin: 0,
  saturated: false,
  holdover: false,
  ...over,
})

describe('summarizing what the feedback layer had to do', () => {
  it('reads a steady bias off a constructed series', () => {
    // Three seconds at +2, three at +4: mean 3, RMS sqrt((4+4+4+16+16+16)/6) = sqrt(10).
    const series = [2, 2, 2, 4, 4, 4].map((value) =>
      correction({ integralRatePerMin: value, proportionalRatePerMin: 1, totalRatePerMin: value + 1, errorC: -1 }),
    )
    const summary = summarizeControlCorrections(series)
    expect(summary.samples).toBe(6)
    expect(summary.usableSamples).toBe(6)
    expect(summary.meanIntegralRatePerMin).toBeCloseTo(3, 9)
    expect(summary.rmsIntegralRatePerMin).toBeCloseTo(Math.sqrt(10), 9)
    expect(summary.meanTotalRatePerMin).toBeCloseTo(4, 9)
    expect(summary.meanAbsErrorC).toBeCloseTo(1, 9)
  })

  /**
   * Mean and RMS together are the reading. A controller that chased in both directions averages to
   * nothing while its RMS stays large, and that says the SHAPE is wrong rather than the gain - no
   * single coefficient scaling fixes it, so the refit should not be handed a bias of zero as if the
   * model were fine.
   */
  it('separates a steady offset from a controller that spent the roast chasing', () => {
    const steady = summarizeControlCorrections(Array.from({ length: 20 }, () => correction({ integralRatePerMin: 3 })))
    const chasing = summarizeControlCorrections(
      Array.from({ length: 20 }, (_, index) => correction({ integralRatePerMin: index % 2 === 0 ? 5 : -5 })),
    )
    expect(steady.meanIntegralRatePerMin).toBeCloseTo(3, 9)
    expect(steady.rmsIntegralRatePerMin).toBeCloseTo(3, 9)
    expect(chasing.meanIntegralRatePerMin).toBeCloseTo(0, 9)
    expect(chasing.rmsIntegralRatePerMin).toBeCloseTo(5, 9)
  })

  it('counts saturated and holdover samples but never averages them into the bias', () => {
    const summary = summarizeControlCorrections([
      correction({ integralRatePerMin: 2 }),
      correction({ integralRatePerMin: 4 }),
      correction({ integralRatePerMin: 8, saturated: true }),
      correction({ integralRatePerMin: 8, saturated: true }),
      correction({ integralRatePerMin: 4, holdover: true }),
    ])
    expect(summary.samples).toBe(5)
    expect(summary.usableSamples).toBe(2)
    expect(summary.saturatedSamples).toBe(2)
    expect(summary.holdoverSamples).toBe(1)
    // 3, not 5.2: the pinned samples describe the zone's limits, not the coefficients.
    expect(summary.meanIntegralRatePerMin).toBeCloseTo(3, 9)
  })

  it('declines to score a run that carries no corrections at all', () => {
    // Every roast archived before the feedback layer existed looks exactly like this.
    const empty = summarizeControlCorrections([undefined, undefined])
    expect(empty.samples).toBe(0)
    expect(empty.meanIntegralRatePerMin).toBe(0)
    expect(empty.rmsIntegralRatePerMin).toBe(0)
    expect(summarizeControlCorrections([]).samples).toBe(0)
  })

  it('reports the counts even when nothing in the run was usable', () => {
    const summary = summarizeControlCorrections([correction({ saturated: true }), correction({ holdover: true })])
    expect(summary.samples).toBe(2)
    expect(summary.usableSamples).toBe(0)
    expect(summary.meanIntegralRatePerMin).toBe(0)
  })

  it('is order-independent and does not care where in the array a sample sits', () => {
    const series = [1, 5, 3, 9, 2].map((value) => correction({ integralRatePerMin: value }))
    expect(summarizeControlCorrections(series)).toEqual(summarizeControlCorrections([...series].reverse()))
  })
})

describe('windowing a run', () => {
  const samples = [
    { elapsedSec: 0, correction: correction({ integralRatePerMin: 1 }) },
    { elapsedSec: 100, correction: correction({ integralRatePerMin: 2 }) },
    { elapsedSec: 200, correction: correction({ integralRatePerMin: 3 }) },
    { elapsedSec: 300 },
  ]

  it('takes the inclusive slice and skips samples with no correction', () => {
    expect(correctionsBetween(samples, 100, 300).map((row) => row.integralRatePerMin)).toEqual([2, 3])
    expect(correctionsBetween(samples, 0, 0).map((row) => row.integralRatePerMin)).toEqual([1])
    expect(correctionsBetween(samples, 400, 500)).toEqual([])
  })
})

describe('journey zone boundaries', () => {
  it('closes at the next entered zone and excludes skipped controlled zones from bias', () => {
    const zones = [
      { id: 'z0', startC: 25, endC: 100, durationSec: 10, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
      { id: 'skipped', startC: 100, endC: 100, durationSec: 0, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
      { id: 'z2', startC: 100, endC: 150, durationSec: 10, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
    ]
    const report = summarizeJourneyZones(
      zones,
      [
        { elapsedSec: 0, zoneIndex: 0, correction: correction() },
        { elapsedSec: 10, zoneIndex: 2, correction: correction({ integralRatePerMin: 2 }) },
      ],
      { endSec: 20 },
    )

    expect(report.zones[0].actualDurationSec).toBe(10)
    expect(report.zones[1]).toMatchObject({ entered: false, actualDurationSec: 0 })
    expect(report.biasZoneIndexes).toEqual([2])
    expect(report.bias.meanIntegralRatePerMin).toBe(2)
  })
})

/**
 * End to end against the simulator. Note what this can and cannot show: `simulateProfileSnapshot`
 * runs the plant on the SAME coefficients it hands the controller, so by construction there is no
 * model error to read back and the residual should be near nothing. That is the useful assertion
 * here - a non-trivial bias out of a self-consistent simulation would mean the control law itself
 * was biased. The wrong-model exercise, where the plant and the model genuinely disagree, lives in
 * `journeyControl.pi.test.ts` where the two coefficient sets can be separated.
 */
describe('a simulated journey carries its own residual', () => {
  const samples = simulateProfileSnapshot({
    profile: starterThermalIntent,
    calibration: defaultCalibration,
    massG: 225,
  })

  it('records a correction on every sample of a journey', () => {
    expect(samples.length).toBeGreaterThan(120)
    expect(samples.every((sample) => sample.correction !== undefined)).toBe(true)
  })

  /**
   * The bias estimate uses the zone split rather than a hand-picked time window, for a specific
   * reason. A flat 120-500 s window straddles the charge ramp, whose target HOLDS at 150 °C until
   * the roast attains it; the PI pushes throughout that hold, so the window
   * reads a bias of 1.05 °C/min out of a simulation that has no model error in it at all. That figure
   * is a statement about an optimistic PROFILE, not about the coefficients, and handing it to a
   * refit would teach the model that its heater is weak. Restricted to the CONTROLLED zones - which
   * is what `summarizeJourneyZones` does - the same run reads 0.68 °C/min.
   */
  it('reads back almost no bias from the controlled zones, because the simulator IS the model here', () => {
    const run = simulateJourney({ profile: starterThermalIntent, calibration: defaultCalibration, massG: 225 })
    expect(run.residual.biasZoneIndexes).toEqual([1, 2, 3])
    expect(run.residual.bias.usableSamples).toBeGreaterThan(100)
    expect(Math.abs(run.residual.bias.meanIntegralRatePerMin)).toBeLessThan(1)
    expect(run.residual.bias.meanAbsErrorC).toBeLessThan(1)
    // And the flat 120-500 s window is kept as the counter-example.
    expect(
      Math.abs(summarizeControlCorrections(correctionsBetween(samples, 120, 500)).meanIntegralRatePerMin),
    ).toBeGreaterThan(run.residual.bias.meanIntegralRatePerMin)
  })

  it('leaves a timed profile with no correction series, because it runs open loop', () => {
    // A timed profile IS its commands. There is no plan to track and so nothing to correct, and an
    // absent series is more honest than a row of zeroes that a summary would happily average.
    const timed = simulateProfileSnapshot({ profile: starterProfile, calibration: defaultCalibration, massG: 225 })
    expect(timed.length).toBeGreaterThan(10)
    expect(timed.every((sample) => sample.correction === undefined)).toBe(true)
    expect(summarizeControlCorrections(timed.map((sample) => sample.correction)).samples).toBe(0)
  })
})
