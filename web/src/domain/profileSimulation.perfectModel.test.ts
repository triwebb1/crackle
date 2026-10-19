import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterThermalIntent } from '../data/demo'
import { previewCalibration } from './calibrationProvenance'
import { zoneRoles } from './controlResidual'
import { heldTargetPath, simulatedChartZones } from './liveJourney'
import { targetPoints } from './model'
import { modeledMass, NO_ASSUMED_ERROR, simulateJourney } from './profileSimulation'
import { roastRuntimeEnvelopeSec } from './roastProgram'
import type { CalibrationSettings, ThermalIntent } from './types'

/**
 * ================================================================================================
 * A PERFECT-MODEL RUN HAS NOTHING TO BE WRONG ABOUT
 * ================================================================================================
 *
 * With both assumed-error fields at zero there is no error, so the simulation must respond exactly
 * as expected - on the chart and in every reported figure. This file is the standing proof that the
 * arithmetic agrees. One plausible failure would be a preview model taken from the controller's
 * applied coefficients (`previewCalibration`) while the simulated roaster is built from some other
 * rung of the same ladder - a controller fighting a roaster it does not match, at zero assumed
 * error, invisibly. It is not what happens: `simulateJourney` builds both sides from
 * the ONE `calibration` it was handed, and `truthCalibration` returns that very object when no error
 * is assumed. These tests pin that, at the coefficient level and at the tracking level, so it cannot
 * quietly stop being true.
 *
 * What looks like a tracking error on such a chart is a TIME shift drawn as a temperature gap - see
 * `liveJourney.ts` and the last describe below. The tracking bounds here are the ones
 * `journeyControl.pi.test.ts` validates the loop against; a perfect-model run must be well inside
 * them, because the only error left in it is the sensor lag the inversion does not model.
 */

/** What the roaster reports it is holding, deliberately not what the app's own fit says. */
const deviceCoefficients = {
  heaterGainCPerMinAt10: 58.4,
  fanCoolingCPerMinAt10: 21.5,
  coolingFanCPerMinAt10: 30,
  thermalLossPerMinPerC: 0.193,
  fitId: 'fit-controller-applied',
}

/** The app's own fit. Every coefficient differs from the device's, so the rung in use is provable. */
const appCalibration: CalibrationSettings = {
  ...defaultCalibration,
  heaterGainCPerMinAt10: 47.66,
  fanCoolingCPerMinAt10: 14.73,
  coolingFanCPerMinAt10: 31.36,
  thermalLossPerMinPerC: 0.1783,
}

/** The top rung of the ladder: the coefficients the roast will actually be solved against. */
const controllerModel = previewCalibration(appCalibration, deviceCoefficients)

const MASS_G = 225

const run = (calibration: CalibrationSettings, volumeMl?: number, profile: ThermalIntent = starterThermalIntent) =>
  simulateJourney({ profile, calibration, massG: MASS_G, volumeMl, assumedError: NO_ASSUMED_ERROR })

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

/** The rows of the zones the loop genuinely authors: not the charge ramp, not the cooling tail. */
const controlledRows = (simulation: ReturnType<typeof run>, profile: ThermalIntent = starterThermalIntent) => {
  const roles = zoneRoles(profile.segments)
  return simulation.rows.filter((row) => roles[row.zoneIndex] === 'controlled' && row.correction !== undefined)
}

describe('at zero assumed error the simulated roaster IS the control model', () => {
  it('runs the plan and the roaster on one identical coefficient set', () => {
    const simulation = run(controllerModel)
    // Not "equal to": the same object. There is no second set for anything to drift into.
    expect(simulation.truth).toBe(controllerModel)
    expect(simulation.assumedError).toEqual(NO_ASSUMED_ERROR)
  })

  it('uses the controller-set rung, not the app fit underneath it', () => {
    expect(controllerModel.heaterGainCPerMinAt10).toBe(deviceCoefficients.heaterGainCPerMinAt10)
    expect(controllerModel.thermalLossPerMinPerC).toBe(deviceCoefficients.thermalLossPerMinPerC)
    // And only the four thermal coefficients travel: the mass the model is referenced to is the
    // app's, and it is the SAME number on both sides of the simulation, which is the other half of
    // the trap - a plant scaled to one batch size and a controller scaled to another.
    expect(controllerModel.referenceBatchMassG).toBe(appCalibration.referenceBatchMassG)
    expect(run(controllerModel).truth.referenceBatchMassG).toBe(controllerModel.referenceBatchMassG)
  })

  /**
   * The acceptance bound. `journeyControl.pi.test.ts` requires a mean absolute error under 1 °C from a
   * loop fighting a 20% heater-gain error; a run with NO error at all has only the sensor lag left to
   * be wrong about and must be far inside that.
   */
  it('holds its target in the controlled zones to a fraction of a degree', () => {
    const simulation = run(controllerModel)
    const errors = controlledRows(simulation).map((row) => Math.abs(row.correction!.errorC))
    expect(errors.length).toBeGreaterThan(300)
    expect(mean(errors)).toBeLessThan(0.5)
    expect(Math.max(...errors)).toBeLessThan(1.5)
    // Per zone as well as overall, so one long well-tracked zone cannot average out a bad one.
    for (const zone of simulation.zones.filter((candidate) => candidate.role === 'controlled')) {
      const zoneErrors = simulation.rows
        .filter((row) => row.zoneIndex === zone.zoneIndex && row.correction)
        .map((row) => Math.abs(row.correction!.errorC))
      expect(mean(zoneErrors)).toBeLessThan(0.51)
    }
  })

  it('reads back no model bias, because there is no model error to read', () => {
    const simulation = run(controllerModel)
    expect(Math.abs(simulation.residual.bias.meanIntegralRatePerMin)).toBeLessThan(1)
    expect(simulation.residual.bias.meanAbsErrorC).toBeLessThan(0.5)
    expect(simulation.residual.bias.saturatedSamples).toBe(0)
  })

  /**
   * Mass is the calibrated input on both sides. Volume remains a recorded covariate until measured
   * evidence supports a separate physical term; it must not silently rewrite batch mass.
   */
  it('does not invent a mass correction when a volume is supplied', () => {
    expect(modeledMass(MASS_G, 360)).toBeCloseTo(MASS_G, 3)
    const errors = controlledRows(run(controllerModel, 360)).map((row) => Math.abs(row.correction!.errorC))
    expect(mean(errors)).toBeLessThan(0.5)
    expect(Math.max(...errors)).toBeLessThan(1.5)
  })

  /** The same statement for the rung below, so this is a property of the simulation, not of one set. */
  it('is just as true against the app fit alone', () => {
    const errors = controlledRows(run(appCalibration)).map((row) => Math.abs(row.correction!.errorC))
    expect(mean(errors)).toBeLessThan(0.5)
    expect(Math.max(...errors)).toBeLessThan(1.5)
  })
})

describe('the live Thorough light espresso regression', () => {
  const profile: ThermalIntent = {
    ...starterThermalIntent,
    id: 'through-light-espresso-revision-6',
    name: 'Thorough light espresso',
    revision: 6,
    segments: [
      { id: 'z1', startC: 25, endC: 180, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
      { id: 'z2', startC: 180, endC: 210, durationSec: 180, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
      { id: 'z3', startC: 210, endC: 220, durationSec: 180, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
      { id: 'z4', startC: 220, endC: 223, durationSec: 180, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
      { id: 'z5', startC: 223, endC: 50, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    ],
  }
  const appliedCalibration: CalibrationSettings = {
    ...defaultCalibration,
    heaterGainCPerMinAt10: 34.69,
    fanCoolingCPerMinAt10: 2.76,
    coolingFanCPerMinAt10: 23.66,
    thermalLossPerMinPerC: 0.159,
  }

  it('does not abandon the 13-minute plan at the old six-minute Zone 1 deadline', () => {
    const simulation = simulateJourney({
      profile,
      calibration: appliedCalibration,
      massG: 250,
      assumedError: NO_ASSUMED_ERROR,
    })

    expect(profile.segments.reduce((sum, zone) => sum + zone.durationSec, 0)).toBe(780)
    expect(roastRuntimeEnvelopeSec(780)).toBe(2160)
    expect(simulation.completedSec).toBeGreaterThan(360)
    expect(simulation.samples.at(-1)?.elapsedSec).toBe(simulation.completedSec)
    // The immediate-fan law (no mass floor, no reduction walk) reaches Zone 1's endpoint 77 seconds
    // sooner and finishes the whole plan 30 seconds sooner than a gradual-airflow law would
    // (1321 s / 467 s).
    expect(simulation.completedSec).toBe(21 * 60 + 31)
    expect(simulation.abandonedZoneIndex).toBeUndefined()
    expect(simulation.zones.every((zone) => zone.attained)).toBe(true)
    expect(simulation.zones[0].attainedSec).toBe(7 * 60 + 30)
  })

  it.each([
    { massG: 150, volumeMl: 250, heaterGainErrorPercent: 0, thermalLossErrorPercent: 0 },
    { massG: 168, volumeMl: 280, heaterGainErrorPercent: -30, thermalLossErrorPercent: 0 },
    { massG: 206, volumeMl: 300, heaterGainErrorPercent: 0, thermalLossErrorPercent: 30 },
    { massG: 250, volumeMl: 340, heaterGainErrorPercent: -30, thermalLossErrorPercent: 30 },
    { massG: 300, volumeMl: 400, heaterGainErrorPercent: 30, thermalLossErrorPercent: -30 },
  ])(
    'ends $massG g / $volumeMl ml / heater $heaterGainErrorPercent% / loss $thermalLossErrorPercent% only by attainment or the whole envelope',
    ({ massG, volumeMl, heaterGainErrorPercent, thermalLossErrorPercent }) => {
      const simulation = simulateJourney({
        profile,
        calibration: appliedCalibration,
        massG,
        volumeMl,
        assumedError: { heaterGainErrorPercent, thermalLossErrorPercent },
      })

      if (simulation.abandonedZoneIndex === undefined) {
        expect(simulation.zones.at(-1)?.attained).toBe(true)
        expect(simulation.completedSec).toBeLessThanOrEqual(2160)
      } else {
        expect(simulation.completedSec).toBe(2160)
      }
    },
  )
})

/**
 * What a perfect-model run IS allowed to deviate by: time. The charge ramp asks for a climb no
 * roaster of this size delivers, so it arrives late - and because zones advance by attainment, every
 * later zone is carried along with it. That is the finding the panel reports as an overrun, and it
 * is the only deviation the chart may show.
 */
describe('the deviation that survives a perfect model is duration, not temperature', () => {
  const simulation = run(appCalibration)

  it('overruns the charge ramp and still attains every zone', () => {
    expect(simulation.zones[0].role).toBe('ramp')
    expect(simulation.zones[0].overrunSec).toBeGreaterThan(15)
    expect(simulation.zones.every((zone) => zone.attained)).toBe(true)
    expect(simulation.abandonedZoneIndex).toBeUndefined()
    // Not an unreachable endpoint - a slow one. The two are different findings and must not merge.
    expect(simulation.zones.some((zone) => zone.infeasible)).toBe(false)
  })

  /**
   * The visible regression. The nominal goal is read off the profile's own clock, so
   * once the ramp has overrun it sits tens of degrees away from a run that is tracking perfectly. The
   * chart draws BOTH - the plan where the profile put it, and the target the control really held -
   * and it is the second one the trace rides.
   */
  it('rides the target the control held, while the nominal clock is far from it', () => {
    const held = heldTargetPath(simulation.zones, simulation.completedSec)
    const nominal = targetPoints(starterThermalIntent)
    const at = (path: Array<{ timeSec: number; temperatureC: number }>, timeSec: number) => {
      if (timeSec <= path[0].timeSec) return path[0].temperatureC
      for (let index = 1; index < path.length; index += 1) {
        const previous = path[index - 1]
        const current = path[index]
        if (timeSec <= current.timeSec) {
          const span = Math.max(1e-6, current.timeSec - previous.timeSec)
          return (
            previous.temperatureC +
            (current.temperatureC - previous.temperatureC) * ((timeSec - previous.timeSec) / span)
          )
        }
      }
      return path[path.length - 1].temperatureC
    }

    const roles = zoneRoles(starterThermalIntent.segments)
    const controlled = simulation.rows.filter((row) => roles[row.zoneIndex] === 'controlled')
    const sampleAt = new Map(simulation.samples.map((sample) => [sample.elapsedSec, sample.beanTempC]))
    const heldGap = controlled.map((row) =>
      Math.abs(at(held, row.elapsedSec) - (sampleAt.get(row.elapsedSec) ?? Number.NaN)),
    )
    const nominalGap = controlled.map((row) =>
      Math.abs(at(nominal, row.elapsedSec) - (sampleAt.get(row.elapsedSec) ?? Number.NaN)),
    )

    expect(mean(heldGap)).toBeLessThan(0.5)
    // And the nominal line drawn ALONE is nowhere near it, which is what would read as an error.
    expect(mean(nominalGap)).toBeGreaterThan(10)
  })

  /** The marks that say so: an overrun bar for the ramp, drawn from the zone the run really entered. */
  it('hands the chart the zones it needs to draw that difference as time', () => {
    const drawn = simulatedChartZones(simulation.zones)
    expect(drawn[0].entrySec).toBe(0)
    expect(drawn[0].overrunSec).toBeGreaterThan(15)
    expect(drawn[0].attainedSec).toBeDefined()
    // Planned boundaries stay on the profile's clock however far the run has slipped.
    expect(drawn[1].plannedStartSec).toBe(starterThermalIntent.segments[0].durationSec)
  })

  it('marks a zone the run never reached as never entered, so no bar is drawn for it', () => {
    // A zone asking for 300 °C is unreachable, so the run is abandoned inside it and the zones after
    // it were never seen. `entrySec: 0` on an unentered zone would draw a bar from the roast's start.
    const impossible: ThermalIntent = {
      ...starterThermalIntent,
      segments: [
        { id: 'a', startC: 25, endC: 300, durationSec: 120, fanMin: 5, fanMax: 9, heatMin: 3, heatMax: 4 },
        { id: 'b', startC: 300, endC: 310, durationSec: 120, fanMin: 5, fanMax: 9, heatMin: 3, heatMax: 9 },
      ],
    }
    const stuck = run(appCalibration, undefined, impossible)
    expect(stuck.abandonedZoneIndex).toBe(0)
    expect(stuck.zones[1].entered).toBe(false)
    expect(simulatedChartZones(stuck.zones)[1].entrySec).toBeUndefined()
    expect(heldTargetPath(stuck.zones, stuck.completedSec).at(-1)!.temperatureC).toBe(300)
  })
})
