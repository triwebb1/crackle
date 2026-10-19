import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterThermalIntent } from '../data/demo'
import { journeyPoints } from './journeyEdit'
import { adaptiveTargetPoints, effectiveThermalIntent, targetPoints } from './model'
import { simulateProfileSnapshot } from './profileSimulation'

const goal = effectiveThermalIntent(starterThermalIntent, 24.5, defaultCalibration.coolingTargetMarginC)

/**
 * The core simulation bug: the panel drew its goal from `adaptiveTargetPoints`, which re-anchors
 * every zone to its MEASURED completion. That is right while a roast is running and wrong for a
 * snapshot - a simulation that runs long dragged the first zone's endpoint to the far edge and
 * stacked the rest beyond it, so the goal rendered as one straight line while the editor drew the
 * real shape, with the zone markers (drawn from the nominal points) floating off it entirely.
 *
 * There is one source now.
 */
describe('one source for the zone path', () => {
  it('is literally the same function the editor chart draws from', () => {
    expect(targetPoints(goal)).toEqual(
      journeyPoints(goal.segments).map((point) => ({ timeSec: point.timeSec, temperatureC: point.temperatureC })),
    )
  })

  it('is genuinely non-linear: the zones do not sit on one straight line', () => {
    const points = targetPoints(goal)
    expect(points.length).toBeGreaterThanOrEqual(4)
    const slope = (from: { timeSec: number; temperatureC: number }, to: { timeSec: number; temperatureC: number }) =>
      (to.temperatureC - from.temperatureC) / Math.max(1, to.timeSec - from.timeSec)
    const slopes = points.slice(1).map((point, index) => slope(points[index], point))
    expect(new Set(slopes.map((value) => value.toFixed(4))).size).toBeGreaterThan(1)
  })

  it('reproduces the failure the nominal path fixes', () => {
    // A simulation that completes no zone: the adaptive path collapses onto the run length.
    const stalled = [
      {
        elapsedSec: 900,
        beanTempC: 60,
        rorCPerMin: 0,
        requestedFan: 5,
        effectiveFan: 5,
        requestedHeat: 5,
        effectiveHeat: 5,
        phase: 'DRYING' as const,
      },
    ]
    const adaptive = adaptiveTargetPoints(goal, stalled, 900)
    expect(adaptive[1].timeSec).toBe(900)
    expect(adaptive[adaptive.length - 1].timeSec).toBeGreaterThan(1200)
    // The nominal path is unmoved by what the simulation happened to do.
    expect(targetPoints(goal)[1].timeSec).toBe(goal.segments[0].durationSec)
  })
})

/**
 * The predicted line models a controller tracking the goal, so it should approximately track it.
 * The deviation is the reading - it is calibration and feasibility information - but a prediction
 * that flatlines hundreds of degrees away is a broken model, not a finding.
 */
describe('a multi-zone journey against the shipped calibration', () => {
  const samples = simulateProfileSnapshot({
    profile: starterThermalIntent,
    calibration: defaultCalibration,
    massG: 225,
  })

  it('produces a run of a plausible length that actually climbs', () => {
    expect(samples.length).toBeGreaterThan(120)
    const peak = Math.max(...samples.map((sample) => sample.beanTempC))
    expect(peak).toBeGreaterThan(190)
    expect(peak).toBeLessThan(260)
  })

  it('tracks the goal within a sane band rather than saturating', () => {
    const points = targetPoints(goal)
    const goalAt = (elapsedSec: number) => {
      const next = points.findIndex((point) => point.timeSec >= elapsedSec)
      if (next <= 0) return points[0].temperatureC
      const from = points[next - 1]
      const to = points[next]
      const span = Math.max(1, to.timeSec - from.timeSec)
      return from.temperatureC + (to.temperatureC - from.temperatureC) * ((elapsedSec - from.timeSec) / span)
    }
    const heating = samples.filter(
      (sample) => sample.elapsedSec > 0 && sample.elapsedSec <= points[points.length - 2].timeSec,
    )
    const errors = heating.map((sample) => Math.abs(sample.beanTempC - goalAt(sample.elapsedSec)))
    const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length
    expect(mean).toBeLessThan(30)
    expect(Math.max(...errors)).toBeLessThan(60)
  })

  it('varies fan and heat across the zones instead of pinning them', () => {
    const heats = new Set(samples.map((sample) => sample.effectiveHeat.toFixed(1)))
    const fans = new Set(samples.map((sample) => sample.effectiveFan.toFixed(1)))
    expect(heats.size).toBeGreaterThan(2)
    expect(fans.size).toBeGreaterThan(2)
    // And it does not simply hold one level from two minutes in to the end.
    const lateHeats = new Set(
      samples.filter((sample) => sample.elapsedSec > 120).map((sample) => sample.effectiveHeat.toFixed(1)),
    )
    expect(lateHeats.size).toBeGreaterThan(1)
  })

  it('reaches every zone, so the run is not cut off by its own safety cap', () => {
    const finalZone = goal.segments[goal.segments.length - 1]
    expect(samples.at(-1)!.beanTempC).toBeLessThan(finalZone.startC)
    expect(samples.some((sample) => sample.phase === 'COOLING')).toBe(true)
  })

  /**
   * A batch mass of zero or NaN would make the mass factor infinite and the feed-forward garbage.
   * Mass moved off the profile in 0.7.0, so the guard matters more than it did.
   */
  it('survives a missing or nonsense batch mass rather than distorting everything', () => {
    for (const massG of [0, -50, Number.NaN]) {
      const guarded = simulateProfileSnapshot({ profile: starterThermalIntent, calibration: defaultCalibration, massG })
      expect(guarded.length).toBeGreaterThan(10)
      expect(guarded.every((sample) => Number.isFinite(sample.beanTempC))).toBe(true)
    }
  })
})
