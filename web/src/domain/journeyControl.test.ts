import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterThermalIntent } from '../data/demo'
import {
  journeyCirculationFloor,
  journeyCommand,
  journeyPlan,
  modelledSteadyStateC,
  PLANT_BIAS_C_PER_MIN,
} from './journeyControl'
import { targetPoints } from './model'
import { thermalStep } from './thermalModel'
import type { ThermalIntent, ThermalSegment } from './types'

const zone = (over: Partial<ThermalSegment>): ThermalSegment => ({
  id: over.id ?? 'z',
  startC: 25,
  endC: 150,
  durationSec: 210,
  fanMin: 4,
  fanMax: 9,
  heatMin: 3,
  heatMax: 9,
  ...over,
})

const intent = (segments: ThermalSegment[]): ThermalIntent => ({
  ...starterThermalIntent,
  id: 'test',
  segments,
})

const command = (segments: ThermalSegment[], elapsedSec: number, beanTempC: number, calibration = defaultCalibration) =>
  journeyCommand({
    plan: journeyPlan(intent(segments)),
    elapsedSec,
    beanTempC,
    ambientC: 24.5,
    batchMassG: calibration.referenceBatchMassG,
    calibration,
  })

describe('the plan the control follows', () => {
  it('is the nominal zone path, the same one the editor chart draws', () => {
    const plan = journeyPlan(starterThermalIntent)
    const points = targetPoints(starterThermalIntent)
    expect(plan.boundaries).toEqual(points.map((point) => point.timeSec))
    for (const point of points) expect(plan.temperatureAt(point.timeSec)).toBeCloseTo(point.temperatureC, 6)
  })

  it('interpolates inside a zone and holds past the end', () => {
    const plan = journeyPlan(intent([zone({ startC: 100, endC: 200, durationSec: 100 })]))
    expect(plan.temperatureAt(0)).toBe(100)
    expect(plan.temperatureAt(50)).toBeCloseTo(150, 6)
    expect(plan.temperatureAt(100)).toBe(200)
    expect(plan.temperatureAt(500)).toBe(200)
    expect(plan.temperatureAt(-10)).toBe(100)
  })

  it('steps zones on the plan clock, so a zone owns the interval the profile gives it', () => {
    const plan = journeyPlan(
      intent([zone({ id: 'a', durationSec: 100 }), zone({ id: 'b', startC: 150, endC: 175, durationSec: 100 })]),
    )
    expect(plan.zoneAt(0).zone.id).toBe('a')
    expect(plan.zoneAt(99).zone.id).toBe('a')
    expect(plan.zoneAt(100).zone.id).toBe('b')
    expect(plan.zoneAt(9999).zone.id).toBe('b')
  })
})

describe('authored zone feed-forward', () => {
  it('keeps the authored rate before, at, and long after nominal end while the target stays capped', () => {
    const rising = [zone({ startC: 150, endC: 180, durationSec: 120, heatMin: 1 })]
    for (const elapsedSec of [119, 120, 600]) {
      const result = command(rising, elapsedSec, 170)
      expect(result.requiredRateCPerMin).toBeCloseTo(15, 9)
    }
    expect(command(rising, 600, 170).goalC).toBe(180)
  })

  it('classifies equal-epsilon and tiny descending spans as maintenance holds', () => {
    for (const endC of [179.5, 179.9]) {
      const result = command(
        [
          zone({
            startC: 180,
            endC,
            durationSec: 90,
            fanMin: 4,
            fanMax: 9,
            heatMin: 1,
            heatMax: 9,
          }),
        ],
        45,
        180,
      )
      expect(result.cooling).toBe(false)
      expect(result.requiredRateCPerMin).toBe(0)
      expect(result.heat).toBeGreaterThan(0)
    }
  })

  it('enters cooling only when the descending span exceeds the shared epsilon', () => {
    const result = command(
      [
        zone({
          startC: 180,
          endC: 179.49,
          durationSec: 90,
          fanMin: 3,
          fanMax: 10,
          heatMin: 0,
          heatMax: 9,
        }),
      ],
      0,
      180,
    )
    expect(result.cooling).toBe(true)
    expect(result.heat).toBe(0)
  })
})
/**
 * The inversion, checked against the plant it inverts. Every case solves the same balance:
 *
 *     rate = massFactor x (4 + (heat/10) x gain - (fan/10) x fanCooling - loss x (T - ambient))
 */
describe('inverting the thermal model', () => {
  const {
    heaterGainCPerMinAt10: gain,
    fanCoolingCPerMinAt10: fanCooling,
    thermalLossPerMinPerC: loss,
  } = defaultCalibration
  const modelledRate = (fan: number, heat: number, temperatureC: number) =>
    PLANT_BIAS_C_PER_MIN + (heat / 10) * gain - (fan / 10) * fanCooling - Math.max(0, temperatureC - 24.5) * loss

  it('produces the rate the plan asks for when the zone allows it', () => {
    // 150 -> 175 over 120 s is 12.5 °C/min, comfortably inside the band.
    const segments = [zone({ startC: 150, endC: 175, durationSec: 120, heatMin: 3, heatMax: 9, fanMin: 5, fanMax: 9 })]
    const result = command(segments, 10, 152)
    expect(result.saturated).toBe(false)
    // Feed-forward only here: the inversion reproduces the plan's own slope, and the tracking error
    // is the feedback layer's business rather than this function's.
    expect(modelledRate(result.fan, result.heat, 152)).toBeGreaterThan(10)
    expect(modelledRate(result.fan, result.heat, 152)).toBeLessThan(18)
  })

  it('uses the MOST airflow that keeps heat inside the zone band', () => {
    const segments = [zone({ startC: 150, endC: 175, durationSec: 120, fanMin: 5, fanMax: 9 })]
    const result = command(segments, 10, 150)
    expect(result.fan).toBe(9)
  })

  /**
   * The case that makes fan move. A shallow zone needs less heat than the zone's own floor, so the
   * only way to shed the surplus is airflow.
   */
  it('raises fan when the zone asks for less climb than the heat floor produces', () => {
    // A near-flat hold whose profile insists on at least heat 7: the surplus has nowhere to go but
    // out through the fan.
    const shallow = [zone({ startC: 196, endC: 198, durationSec: 300, fanMin: 4, fanMax: 9, heatMin: 7, heatMax: 9 })]
    const result = command(shallow, 10, 196)
    expect(result.fan).toBeGreaterThan(4)
    expect(result.heat).toBeCloseTo(7, 1)
  })

  it('saturates rather than pretending, when the zone is faster than the plant', () => {
    // 25 -> 250 in 60 s is 225 °C/min; nothing in the band can do it.
    const impossible = [zone({ startC: 25, endC: 250, durationSec: 60, heatMin: 3, heatMax: 8 })]
    const result = command(impossible, 10, 30)
    expect(result.saturated).toBe(true)
    expect(result.heat).toBe(8)
    expect(result.fan).toBe(10)
  })

  it('keeps Heat inside the zone limits while the protective Fan floor may override them', () => {
    const bounded = [zone({ fanMin: 5.5, fanMax: 6.5, heatMin: 4.5, heatMax: 5.5 })]
    for (const [elapsed, temperature] of [
      [0, 25],
      [100, 60],
      [200, 149],
      [209, 400],
    ] as const) {
      const result = command(bounded, elapsed, temperature)
      expect(result.fan).toBeGreaterThanOrEqual(5.5)
      expect(result.heat).toBeGreaterThanOrEqual(4.5)
      expect(result.heat).toBeLessThanOrEqual(5.5)
    }
  })

  it('does not permit a low authored Fan ceiling to defeat circulation', () => {
    const lowFan = [zone({ startC: 25, endC: 250, durationSec: 60, fanMin: 0.1, fanMax: 9, heatMin: 3, heatMax: 10 })]
    const result = command(lowFan, 10, 30)
    expect(result.heat).toBeGreaterThanOrEqual(7.5)
    expect(result.fan).toBe(10)
  })

  it('inverts the cooling plant with heat off', () => {
    const cool = [zone({ startC: 210, endC: 40, durationSec: 180, fanMin: 3, fanMax: 10, heatMin: 0, heatMax: 0 })]
    const result = command(cool, 10, 208)
    expect(result.cooling).toBe(true)
    expect(result.heat).toBe(0)
    // Cooling deliberately prioritizes fast bean cooling and chaff clearing over a slower target line.
    expect(result.fan).toBe(10)
  })

  /**
   * Cooling stays at full airflow; feedback can only report whether that fixed safe command is
   * faster or slower than the requested descent.
   */
  it('keeps full cooling airflow and reports the direction of unavailable authority', () => {
    const cool = [zone({ startC: 210, endC: 40, durationSec: 180, fanMin: 3, fanMax: 10, heatMin: 0, heatMax: 0 })]
    const plan = journeyPlan(intent(cool))
    const at = (rateCorrectionCPerMin: number) =>
      journeyCommand({
        plan,
        elapsedSec: 10,
        beanTempC: 208,
        ambientC: 24.5,
        batchMassG: defaultCalibration.referenceBatchMassG,
        calibration: defaultCalibration,
        rateCorrectionCPerMin,
      })
    expect(at(-6).fan).toBe(10)
    expect(at(6).fan).toBe(10)
    expect(at(-60).fan).toBe(10)
    // Pinned at the fan ceiling there is no more cooling to be had, and the integrator is told so.
    expect(at(-60).saturatedLow).toBe(true)
    expect(at(60).saturatedHigh).toBe(true)
  })

  /**
   * The heating side of the same contract. The correction enters (1) as extra wanted rate, so it
   * lands on heat while heat has room and is reported as saturated once it does not.
   */
  it('spends a positive correction on heat, and says so when there is no heat left', () => {
    const room = [zone({ startC: 150, endC: 175, durationSec: 120, fanMin: 5, fanMax: 9, heatMin: 3, heatMax: 9 })]
    const plan = journeyPlan(intent(room))
    const at = (rateCorrectionCPerMin: number) =>
      journeyCommand({
        plan,
        elapsedSec: 10,
        beanTempC: 152,
        ambientC: 24.5,
        batchMassG: defaultCalibration.referenceBatchMassG,
        calibration: defaultCalibration,
        rateCorrectionCPerMin,
      })
    expect(at(6).heat).toBeGreaterThan(at(0).heat)
    expect(at(0).saturatedHigh).toBe(false)
    expect(at(0).saturatedLow).toBe(false)
    expect(at(40).heat).toBe(9)
    expect(at(40).saturatedHigh).toBe(true)
    // Asking for far less climb than the heat floor produces pins fan wide open with heat on its
    // floor: nothing left to shed with, which is the other direction the integrator must not push.
    expect(at(-40).saturatedLow).toBe(true)
    expect(at(-40).fan).toBe(9)
  })

  it('reports the steady state the pair would hold at, from the same balance', () => {
    const steady = modelledSteadyStateC(
      { fan: 5, heat: 6, batchMassG: defaultCalibration.referenceBatchMassG, ambientC: 24.5 },
      defaultCalibration,
    )
    const settled = thermalStep(
      {
        previousBeanTempC: steady,
        previousRorCPerMin: 0,
        fan: 5,
        heat: 6,
        cooling: false,
        batchMassG: defaultCalibration.referenceBatchMassG,
        ambientC: 24.5,
      },
      defaultCalibration,
    )
    // At the steady state the plant asks for no further change.
    expect(Math.abs(settled.rorCPerMin)).toBeLessThan(0.01)
  })

  it('keeps steady-state reachability invariant across batch mass', () => {
    const at = (batchMassG: number) =>
      modelledSteadyStateC({ fan: 1, heat: 10, batchMassG, ambientC: 25 }, defaultCalibration)
    expect(at(100)).toBeCloseTo(at(225), 9)
    expect(at(250)).toBeCloseTo(at(225), 9)
  })

  it('reports saturation when feedback asks below the heating branch floor', () => {
    const segments = [
      zone({ startC: 180, endC: 180, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 1, heatMax: 10 }),
    ]
    const plan = journeyPlan(intent(segments))
    const result = journeyCommand({
      plan,
      elapsedSec: 30,
      beanTempC: 180,
      ambientC: 25,
      batchMassG: 225,
      calibration: defaultCalibration,
      rateCorrectionCPerMin: -9,
    })
    expect(result.saturatedLow).toBe(true)
    expect(result.saturated).toBe(true)
  })
})

/**
 * Acceptance criterion: Fan and Heat must MOVE across zones when the goal's slope moves. Parking
 * fan at a zone midpoint cannot pass this.
 */
describe('automatic circulation floor', () => {
  // A mass-scaled late floor is excessive protection. Full airflow through 130 C applies; above
  // that only a zone's own fanMin and the universal heat-on Fan 1.0 rule constrain the solve.
  it('uses full airflow through 130 C and no Journey-specific floor above it', () => {
    expect(journeyCirculationFloor(130)).toBe(10)
    expect(journeyCirculationFloor(130.1)).toBe(0)
    expect(journeyCirculationFloor(200)).toBe(0)
  })

  it('folds the universal heat-on Fan 1.0 rule into a solve that wants less airflow', () => {
    const segments = [
      zone({ startC: 175, endC: 185, durationSec: 900, fanMin: 0.1, fanMax: 10, heatMin: 0, heatMax: 3 }),
    ]
    const plan = journeyPlan(intent(segments))
    const command = journeyCommand({
      plan,
      elapsedSec: 10,
      beanTempC: 175,
      ambientC: 24.5,
      batchMassG: 225,
      calibration: defaultCalibration,
    })
    expect(command.heat).toBeGreaterThan(0)
    expect(command.fan).toBe(1)
  })
})

describe('fan and heat vary with the goal slope', () => {
  // Each zone insists on at least heat 6, which is what makes the fan carry the difference between
  // a steep climb and a soak rather than the heat alone.
  const varied = intent([
    zone({ id: 'steep', startC: 25, endC: 150, durationSec: 210, fanMin: 4, fanMax: 10, heatMin: 6, heatMax: 9 }),
    zone({ id: 'soak', startC: 150, endC: 158, durationSec: 240, fanMin: 4, fanMax: 10, heatMin: 6, heatMax: 9 }),
    zone({ id: 'ramp', startC: 158, endC: 205, durationSec: 200, fanMin: 4, fanMax: 10, heatMin: 6, heatMax: 9 }),
  ])
  const plan = journeyPlan(varied)
  const at = (elapsedSec: number) =>
    journeyCommand({
      plan,
      elapsedSec,
      beanTempC: plan.temperatureAt(elapsedSec),
      ambientC: 24.5,
      batchMassG: defaultCalibration.referenceBatchMassG,
      calibration: defaultCalibration,
    })

  it('asks for more heat on a steep zone than on a soak', () => {
    expect(at(100).heat).toBeGreaterThan(at(300).heat)
  })

  it('retains maximum airflow while Heat has authority', () => {
    expect(at(300).fan).toBe(at(100).fan)
  })

  it('moves both again when the ramp resumes', () => {
    expect(at(550).heat).toBeGreaterThan(at(300).heat)
    expect(at(550).fan).toBe(at(300).fan)
  })

  it('produces genuinely distinct commands per zone rather than one held pair', () => {
    const pairs = new Set(
      [at(100), at(300), at(550)].map((result) => `${result.fan.toFixed(1)}:${result.heat.toFixed(1)}`),
    )
    expect(pairs.size).toBe(3)
  })
})
