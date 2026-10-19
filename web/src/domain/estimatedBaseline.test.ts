import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import {
  CANONICAL_COOLING,
  CANONICAL_SR800_ROAST,
  CANONICAL_TOLERANCE_C,
  CANONICAL_WAYPOINTS,
  ESTIMATED_BASELINE_AMBIENT_C,
  ESTIMATED_BASELINE_COEFFICIENTS,
  ESTIMATED_BASELINE_MASS_G,
} from './estimatedBaseline'
import { thermalStep } from './thermalModel'

/**
 * The shipped constants are only worth shipping if the model still produces the roast they were
 * derived from. This is that check: it pins the behaviour a first-time operator sees before any
 * calibration exists, so neither an edit to the model nor an edit to the numbers can move it
 * quietly.
 */
const simulateCanonical = (calibration = defaultCalibration) => {
  const series: Array<{ atSec: number; temperatureC: number; fan: number; heat: number }> = []
  let temperatureC = ESTIMATED_BASELINE_AMBIENT_C
  let rorCPerMin: number | undefined
  const finish = CANONICAL_SR800_ROAST[CANONICAL_SR800_ROAST.length - 1].untilSec
  for (let atSec = 0; atSec <= finish; atSec += 1) {
    const step =
      CANONICAL_SR800_ROAST.find((candidate) => atSec < candidate.untilSec) ??
      CANONICAL_SR800_ROAST[CANONICAL_SR800_ROAST.length - 1]
    const result = thermalStep(
      {
        previousBeanTempC: temperatureC,
        previousRorCPerMin: rorCPerMin,
        fan: step.fan,
        heat: step.heat,
        cooling: step.heat === 0,
        batchMassG: ESTIMATED_BASELINE_MASS_G,
        ambientC: ESTIMATED_BASELINE_AMBIENT_C,
      },
      calibration,
    )
    temperatureC = result.beanTempC
    rorCPerMin = result.rorCPerMin
    series.push({ atSec, temperatureC, fan: step.fan, heat: step.heat })
  }
  return series
}

describe('the estimated starting baseline', () => {
  const series = simulateCanonical()
  const at = (atSec: number) => series.find((sample) => sample.atSec === atSec)!.temperatureC

  it('is what the app actually ships', () => {
    for (const [field, value] of Object.entries(ESTIMATED_BASELINE_COEFFICIENTS)) {
      expect(defaultCalibration[field as keyof typeof ESTIMATED_BASELINE_COEFFICIENTS]).toBe(value)
    }
    expect(defaultCalibration.referenceBatchMassG).toBe(ESTIMATED_BASELINE_MASS_G)
  })

  it('reproduces every canonical waypoint within tolerance', () => {
    for (const waypoint of CANONICAL_WAYPOINTS) {
      const modelled = at(waypoint.atSec)
      expect(
        Math.abs(modelled - waypoint.temperatureC),
        `${waypoint.label}: modelled ${modelled.toFixed(1)} °C`,
      ).toBeLessThanOrEqual(CANONICAL_TOLERANCE_C)
    }
  })

  it('climbs monotonically to a plausible drop temperature and no further', () => {
    const peak = Math.max(...series.map((sample) => sample.temperatureC))
    expect(peak).toBeGreaterThan(200)
    expect(peak).toBeLessThan(225)
    const heating = series.filter((sample) => sample.heat > 0)
    for (let index = 1; index < heating.length; index += 1) {
      expect(heating[index].temperatureC).toBeGreaterThanOrEqual(heating[index - 1].temperatureC - 0.01)
    }
  })

  it('cools to a safe handling temperature in the time an SR800 takes', () => {
    const coolStart = series.find((sample) => sample.heat === 0)!
    const safe = series.find((sample) => sample.atSec > coolStart.atSec && sample.temperatureC <= CANONICAL_COOLING.toC)
    expect(coolStart.temperatureC).toBeGreaterThan(CANONICAL_COOLING.fromC)
    expect(safe, 'never reached a safe handling temperature').toBeDefined()
    const minutes = (safe!.atSec - coolStart.atSec) / 60
    expect(minutes).toBeGreaterThanOrEqual(CANONICAL_COOLING.minimumMinutes)
    expect(minutes).toBeLessThanOrEqual(CANONICAL_COOLING.maximumMinutes)
  })

  it('is a real estimate, not a coincidence: perturbing a coefficient breaks the shape', () => {
    const softer = simulateCanonical({
      ...defaultCalibration,
      heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 0.7,
    })
    const middleAnchor = CANONICAL_WAYPOINTS[1]
    const modelled = softer.find((sample) => sample.atSec === middleAnchor.atSec)!.temperatureC
    expect(Math.abs(modelled - middleAnchor.temperatureC)).toBeGreaterThan(CANONICAL_TOLERANCE_C)
  })
})
