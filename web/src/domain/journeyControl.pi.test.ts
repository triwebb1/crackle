import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterThermalIntent } from '../data/demo'
import { effectiveLevels } from './actuatorFloors'
import { summarizeControlCorrections } from './controlResidual'
import type { JourneyControlState } from './journeyControl'
import {
  INTEGRAL_HOLDOFF_SEC,
  initialJourneyControlState,
  journeyControlStep,
  journeyPlan,
  MAX_CORRECTION_C_PER_MIN,
  MAX_INTEGRAL_C_PER_MIN,
} from './journeyControl'
import { thermalStep } from './thermalModel'
import type { CalibrationSettings, ControlCorrection, ThermalIntent, ThermalSegment } from './types'

/**
 * The feedback layer, tested the only way it can honestly be tested: against a plant whose
 * coefficients are NOT the ones the controller was given.
 *
 * The design assumes the calibration is wrong all the time, so a control law verified only
 * against a model of itself has been verified against nothing. Every run below drives the real
 * `thermalStep` plant with one coefficient set (the truth) while `journeyControlStep` inverts a
 * different one (the model), and asks whether the roast still lands on its plan.
 *
 * The plant is the same equation the inversion documents:
 *
 *     dT/dt = massFactor x (4 + (heat/10) x heaterGain - (fan/10) x fanCooling - loss x (T - ambient))
 *
 * with the measured rate reaching the commanded one through the `sensorLagSec` first-order pole.
 */
const AMBIENT_C = 24.5

const intentOf = (segments: ThermalSegment[]): ThermalIntent => ({ ...starterThermalIntent, id: 'pi-test', segments })

interface ClosedLoopRow {
  elapsedSec: number
  beanTempC: number
  /**
   * The target the CONTROL was holding: the current zone's nominal ramp anchored at the time the
   * roast actually entered that zone. On a single-zone feasible journey this is identical to
   * `plan.temperatureAt`, which is why every long-standing case below reads the same as it did.
   */
  goalC: number
  /** Anchored target minus measured. Positive means the roast is behind the target it is chasing. */
  errorC: number
  /** What the plan says on paper at this second, kept alongside so the two can be compared. */
  clockGoalC: number
  correction: ControlCorrection
  fan: number
  heat: number
  zoneIndex: number
  zoneEntrySec: number
}

interface ClosedLoopOptions {
  intent: ThermalIntent
  /** The roaster. */
  truth: CalibrationSettings
  /** What the controller believes the roaster is. Deliberately not `truth`. */
  model: CalibrationSettings
  seconds: number
  /** Seconds for which the probe reports nothing at all. */
  dropout?: { fromSec: number; toSec: number }
}

const runClosedLoop = ({ intent, truth, model, seconds, dropout }: ClosedLoopOptions): ClosedLoopRow[] => {
  const plan = journeyPlan(intent)
  const batchMassG = truth.referenceBatchMassG
  let state = initialJourneyControlState()
  let beanTempC = intent.segments[0].startC
  let rorCPerMin: number | undefined
  const rows: ClosedLoopRow[] = []

  for (let elapsedSec = 0; elapsedSec <= seconds; elapsedSec += 1) {
    const blind = dropout !== undefined && elapsedSec >= dropout.fromSec && elapsedSec <= dropout.toSec
    const step = journeyControlStep(state, {
      plan,
      elapsedSec,
      beanTempC: blind ? Number.NaN : beanTempC,
      ambientC: AMBIENT_C,
      batchMassG,
      calibration: model,
    })
    state = step.state
    // The roaster applies its own floors, exactly as the firmware does, before the plant sees them.
    const levels = effectiveLevels({ fan: step.command.fan, heat: step.command.heat })
    const result = thermalStep(
      {
        previousBeanTempC: beanTempC,
        previousRorCPerMin: rorCPerMin,
        fan: levels.fan,
        heat: levels.heat,
        cooling: step.command.cooling,
        batchMassG,
        ambientC: AMBIENT_C,
      },
      truth,
    )
    beanTempC = result.beanTempC
    rorCPerMin = result.rorCPerMin
    rows.push({
      elapsedSec,
      beanTempC,
      goalC: step.command.goalC,
      errorC: step.command.goalC - beanTempC,
      clockGoalC: plan.temperatureAt(elapsedSec),
      correction: step.correction,
      fan: levels.fan,
      heat: levels.heat,
      zoneIndex: step.zoneIndex,
      zoneEntrySec: step.zoneEntrySec,
    })
  }
  return rows
}

/** A state literal that is a real `JourneyControlState`: zone anchor at the start, integral set. */
const stateWith = (integralRateCPerMin: number, lastSampleSec?: number) => ({
  ...initialJourneyControlState(),
  integralRateCPerMin,
  lastSampleSec,
})

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const fromSecond = (rows: ClosedLoopRow[], sec: number) => rows.filter((row) => row.elapsedSec >= sec)
const lastSeconds = (rows: ClosedLoopRow[], span: number) =>
  rows.filter((row) => row.elapsedSec > rows[rows.length - 1].elapsedSec - span)

/**
 * A long, comfortably feasible climb. Nothing here is meant to saturate: the whole point is to see
 * whether the integral removes a model error, so the plant must have room to be corrected.
 */
const feasibleClimb = intentOf([
  { id: 'climb', startC: 25, endC: 200, durationSec: 900, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
])

describe('holding the plan with a wrong model', () => {
  /**
   * The acceptance bound, and the reason a direct heat trim is not enough.
   *
   * A direct heat trim is proportional only, worth an effective gain of about 1.06 °C/min per C
   * (0.16 heat per C times 6.6 °C/min per heat level). Against these same wrong-model runs that trim
   * settles at a PERMANENT offset of 7.3 to 8.3 °C - a proportional controller cannot do anything
   * else with a constant rate deficit - and would fail every case below by a wide margin. The
   * evidence stays in this comment rather than alive as a second code path.
   */
  const cases: Array<{ label: string; model: CalibrationSettings }> = [
    {
      label: 'heater gain over-estimated by 20% (the controller under-heats)',
      model: { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 1.2 },
    },
    {
      label: 'heater gain under-estimated by 20% (the controller over-heats)',
      model: { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 0.8 },
    },
    {
      label: 'thermal loss over-estimated by 30%',
      model: { ...defaultCalibration, thermalLossPerMinPerC: defaultCalibration.thermalLossPerMinPerC * 1.3 },
    },
  ]

  for (const { label, model } of cases) {
    it(`tracks within 2 °C after settling with ${label}`, () => {
      const rows = runClosedLoop({ intent: feasibleClimb, truth: defaultCalibration, model, seconds: 900 })
      const settled = fromSecond(rows, 90)
      const worst = Math.max(...settled.map((row) => Math.abs(row.errorC)))
      expect(worst).toBeLessThan(2)
      // The integral is what removes the offset: the mean error, not the mean absolute error.
      expect(Math.abs(mean(lastSeconds(rows, 120).map((row) => row.errorC)))).toBeLessThan(1.25)
    })
  }

  it('does it by holding a non-zero integral, which is the model bias made visible', () => {
    const cold = { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 1.2 }
    const hot = { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 0.8 }
    const coldRun = runClosedLoop({ intent: feasibleClimb, truth: defaultCalibration, model: cold, seconds: 900 })
    const hotRun = runClosedLoop({ intent: feasibleClimb, truth: defaultCalibration, model: hot, seconds: 900 })
    // A model that thinks the heater is stronger than it is has to be pushed harder, and the sign
    // of the integral says exactly that. This is the number the post-roast refit consumes.
    expect(mean(lastSeconds(coldRun, 120).map((row) => row.correction.integralRatePerMin))).toBeGreaterThan(4)
    expect(mean(lastSeconds(hotRun, 120).map((row) => row.correction.integralRatePerMin))).toBeLessThan(-4)
  })

  it('needs no correction at all when the model happens to be right', () => {
    const rows = runClosedLoop({
      intent: feasibleClimb,
      truth: defaultCalibration,
      model: defaultCalibration,
      seconds: 900,
    })
    expect(Math.max(...fromSecond(rows, 90).map((row) => Math.abs(row.errorC)))).toBeLessThan(1)
    // Near zero, not exactly zero: the sensor lag is real and the inversion does not model it.
    expect(Math.abs(mean(lastSeconds(rows, 120).map((row) => row.correction.integralRatePerMin)))).toBeLessThan(1)
  })

  it('never exceeds the authority it was given, however wrong the model is', () => {
    const veryWrong = { ...defaultCalibration, thermalLossPerMinPerC: defaultCalibration.thermalLossPerMinPerC * 3 }
    const rows = runClosedLoop({ intent: feasibleClimb, truth: defaultCalibration, model: veryWrong, seconds: 900 })
    for (const row of rows) {
      expect(Math.abs(row.correction.totalRatePerMin)).toBeLessThanOrEqual(MAX_CORRECTION_C_PER_MIN + 1e-9)
      expect(Math.abs(row.correction.integralRatePerMin)).toBeLessThanOrEqual(MAX_INTEGRAL_C_PER_MIN + 1e-9)
    }
    // And the deviation that remains is REPORTED rather than corrected away. A model this wrong is
    // supposed to produce a visibly failing roast, not a quietly rescued one.
    expect(Math.max(...fromSecond(rows, 300).map((row) => Math.abs(row.errorC)))).toBeGreaterThan(5)
  })
})

/**
 * An unreachable stretch followed by a reachable one. Without conditional integration the integral
 * charges to its clamp while the plant is pinned, and then has to be discharged by an error of the
 * opposite sign - which is an overshoot, paid for in roasted coffee.
 */
describe('windup across an infeasible stretch', () => {
  const unreachableThenGentle = intentOf([
    // 80 °C/min for three minutes. Heat 10 at the fan floor is worth about 60 °C/min, so this cannot
    // be followed and the roast falls a long way behind on purpose.
    { id: 'impossible', startC: 25, endC: 265, durationSec: 180, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
    // Then a near-hold the plant can easily reach, so the roast catches up from below.
    { id: 'reachable', startC: 265, endC: 270, durationSec: 600, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
  ])

  const rows = runClosedLoop({
    intent: unreachableThenGentle,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 780,
  })

  it('really is infeasible, or the test proves nothing', () => {
    const stretch = rows.filter((row) => row.elapsedSec > 60 && row.elapsedSec <= 180)
    expect(stretch.every((row) => row.correction.saturated)).toBe(true)
    expect(Math.max(...stretch.map((row) => row.errorC))).toBeGreaterThan(20)
  })

  it('freezes the integral while the plant has nothing left to give', () => {
    const saturated = rows.filter((row) => row.elapsedSec >= INTEGRAL_HOLDOFF_SEC && row.elapsedSec <= 180)
    // Not merely bounded: it does not accumulate at all. The error is large and positive throughout,
    // so an unguarded integrator would be welded to +8 °C/min by the end of the stretch.
    expect(Math.max(...saturated.map((row) => row.correction.integralRatePerMin))).toBeLessThan(0.5)
  })

  it('bounds the overshoot once the plan becomes reachable again', () => {
    const recovery = rows.filter((row) => row.elapsedSec > 180)
    // Negative error is the roast sitting ABOVE its plan.
    const overshootC = Math.max(0, ...recovery.map((row) => -row.errorC))
    expect(overshootC).toBeLessThan(3)
  })

  it('catches back up rather than staying behind', () => {
    expect(Math.abs(rows[rows.length - 1].errorC)).toBeLessThan(2)
  })
})

/**
 * A dead probe. The decision recorded in `journeyControlStep` is holdover: no error, no correction,
 * an untouched integral, and the inversion solved against the plan's own temperature. The rejected
 * alternative was substituting the last good reading, which drives a confident and increasingly
 * wrong correction for exactly as long as the dropout lasts.
 */
describe('a measurement dropout', () => {
  const model = { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 1.2 }
  const rows = runClosedLoop({
    intent: feasibleClimb,
    truth: defaultCalibration,
    model,
    seconds: 900,
    dropout: { fromSec: 400, toSec: 430 },
  })
  const blind = rows.filter((row) => row.elapsedSec >= 400 && row.elapsedSec <= 430)

  it('runs feed-forward only, with no correction at all', () => {
    expect(blind).toHaveLength(31)
    expect(blind.every((row) => row.correction.holdover)).toBe(true)
    expect(blind.every((row) => row.correction.totalRatePerMin === 0)).toBe(true)
    expect(blind.every((row) => row.correction.proportionalRatePerMin === 0)).toBe(true)
    // `saturated` is about the plant running out of room. A dropout is a different failure and gets
    // its own flag, so a summary can exclude both for different reasons.
    expect(blind.every((row) => row.correction.saturated)).toBe(false)
  })

  it('freezes the integral at exactly the value it had, rather than decaying or resetting it', () => {
    const before = rows.find((row) => row.elapsedSec === 399)!.correction.integralRatePerMin
    expect(before).toBeGreaterThan(1)
    for (const row of blind) expect(row.correction.integralRatePerMin).toBe(before)
  })

  it('resumes cleanly, with no transient the roast would notice', () => {
    const recovery = rows.filter((row) => row.elapsedSec > 430 && row.elapsedSec <= 520)
    expect(Math.max(...recovery.map((row) => Math.abs(row.errorC)))).toBeLessThan(3.5)
    // And it ends exactly where an uninterrupted run would.
    const clean = runClosedLoop({ intent: feasibleClimb, truth: defaultCalibration, model, seconds: 900 })
    expect(Math.abs(rows[rows.length - 1].errorC - clean[clean.length - 1].errorC)).toBeLessThan(0.5)
  })
})

describe('the step is pure', () => {
  it('gives byte-identical results for two identical input sequences', () => {
    const model = { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 0.8 }
    const first = runClosedLoop({ intent: feasibleClimb, truth: defaultCalibration, model, seconds: 600 })
    const second = runClosedLoop({ intent: feasibleClimb, truth: defaultCalibration, model, seconds: 600 })
    expect(second).toEqual(first)
  })

  it('does not mutate the state it is handed', () => {
    const plan = journeyPlan(feasibleClimb)
    const state = stateWith(2.5, 100)
    const snapshot = { ...state }
    const step = journeyControlStep(state, {
      plan,
      elapsedSec: 101,
      beanTempC: 90,
      ambientC: AMBIENT_C,
      batchMassG: defaultCalibration.referenceBatchMassG,
      calibration: defaultCalibration,
    })
    expect(state).toEqual(snapshot)
    expect(step.state).not.toBe(state)
  })

  it('reports the feed-forward command alongside the applied one, so the residual is recoverable', () => {
    const plan = journeyPlan(feasibleClimb)
    // 30 °C behind plan: the correction should clamp and the applied heat should exceed the model's.
    const step = journeyControlStep(stateWith(0, 299), {
      plan,
      elapsedSec: 300,
      beanTempC: plan.temperatureAt(300) - 30,
      ambientC: AMBIENT_C,
      batchMassG: defaultCalibration.referenceBatchMassG,
      calibration: defaultCalibration,
    })
    expect(step.correction.totalRatePerMin).toBeCloseTo(MAX_CORRECTION_C_PER_MIN, 6)
    expect(step.command.heat).toBeGreaterThan(step.feedForward.heat)
    expect(step.feedForward.commandedRateCPerMin).toBeCloseTo(step.feedForward.requiredRateCPerMin, 6)
    expect(step.command.commandedRateCPerMin - step.command.requiredRateCPerMin).toBeCloseTo(
      MAX_CORRECTION_C_PER_MIN,
      6,
    )
  })
})

/**
 * The reason the correction is recorded at all. A roast run against a wrong model leaves behind a
 * series whose mean integral term is a measurement of how wrong, in the units the plan is written
 * in - and that is what the post-roast refit will consume.
 */
describe('the correction read back as a model bias', () => {
  const midRoast = (rows: ClosedLoopRow[]) =>
    summarizeControlCorrections(
      rows.filter((row) => row.elapsedSec >= 300 && row.elapsedSec <= 900).map((row) => row.correction),
    )

  it('recovers the sign and the rough size of the error that was injected', () => {
    const under = midRoast(
      runClosedLoop({
        intent: feasibleClimb,
        truth: defaultCalibration,
        seconds: 900,
        model: { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 1.2 },
      }),
    )
    const over = midRoast(
      runClosedLoop({
        intent: feasibleClimb,
        truth: defaultCalibration,
        seconds: 900,
        model: { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 0.8 },
      }),
    )
    // A model that over-rates the heater under-commands it, so the loop had to push up all roast.
    expect(under.meanIntegralRatePerMin).toBeGreaterThan(3)
    expect(over.meanIntegralRatePerMin).toBeLessThan(-3)
    // Steady, not chasing: the RMS sits close to the mean in both directions.
    expect(under.rmsIntegralRatePerMin).toBeLessThan(Math.abs(under.meanIntegralRatePerMin) * 1.5)
    expect(over.rmsIntegralRatePerMin).toBeLessThan(Math.abs(over.meanIntegralRatePerMin) * 1.5)
    // And the loop held the plan while it was measuring that: the bias is not paid for in deviation.
    expect(under.meanAbsErrorC).toBeLessThan(1)
    expect(over.meanAbsErrorC).toBeLessThan(1)
  })

  it('reads back nothing when the model was right', () => {
    const exact = midRoast(
      runClosedLoop({ intent: feasibleClimb, truth: defaultCalibration, model: defaultCalibration, seconds: 900 }),
    )
    expect(Math.abs(exact.meanIntegralRatePerMin)).toBeLessThan(1)
  })
})

describe('helpful integral unwind at an actuator limit', () => {
  const stepAt = (intent: ThermalIntent, integralRateCPerMin: number, beanOffsetC: number) => {
    const plan = journeyPlan(intent)
    const elapsedSec = 120
    return journeyControlStep(stateWith(integralRateCPerMin, elapsedSec - 1), {
      plan,
      elapsedSec,
      beanTempC: plan.temperatureAt(elapsedSec) + beanOffsetC,
      ambientC: AMBIENT_C,
      batchMassG: defaultCalibration.referenceBatchMassG,
      calibration: defaultCalibration,
    })
  }

  it('unwinds a positive integral while the heater command remains high-limited', () => {
    const intent = intentOf([
      { id: 'hot-limit', startC: 25, endC: 265, durationSec: 180, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
    ])
    const step = stepAt(intent, MAX_INTEGRAL_C_PER_MIN, 1)
    expect(step.correction.saturated).toBe(true)
    expect(step.correction.integralRatePerMin).toBeLessThan(MAX_INTEGRAL_C_PER_MIN)
  })

  it('unwinds a negative integral while a heated zone cannot go any lower', () => {
    // Heat pinned high and airflow capped: the zone cannot shed heat any faster, yet an error of the
    // opposite sign must still unwind the -8 term instead of leaving it welded to its clamp.
    const intent = intentOf([
      { id: 'cold-limit', startC: 200, endC: 200, durationSec: 600, fanMin: 1, fanMax: 2, heatMin: 9, heatMax: 10 },
    ])
    const step = stepAt(intent, -MAX_INTEGRAL_C_PER_MIN, -1)
    expect(step.command.cooling).toBe(false)
    expect(step.correction.saturated).toBe(true)
    expect(step.correction.integralRatePerMin).toBeGreaterThan(-MAX_INTEGRAL_C_PER_MIN)
  })

  it('holds the integral through a cooling zone, where the correction cannot reach the actuator', () => {
    // A cooling zone always commands Fan 10 / Heat 0: nothing to integrate.
    const intent = intentOf([
      { id: 'cooling', startC: 250, endC: 25, durationSec: 180, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
    ])
    for (const [integral, offset] of [
      [-MAX_INTEGRAL_C_PER_MIN, -1],
      [2.5, 3],
      [2.5, -3],
    ] as const) {
      const step = stepAt(intent, integral, offset)
      expect(step.command.cooling).toBe(true)
      expect(step.command).toMatchObject({ fan: 10, heat: 0 })
      expect(step.correction.integralRatePerMin).toBe(integral)
    }
  })
})

describe('the integral holdoff', () => {
  it('accumulates nothing through the charge transient', () => {
    const rows = runClosedLoop({
      intent: feasibleClimb,
      truth: defaultCalibration,
      model: { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 1.2 },
      seconds: 120,
    })
    for (const row of rows.filter((candidate) => candidate.elapsedSec < INTEGRAL_HOLDOFF_SEC)) {
      expect(row.correction.integralRatePerMin).toBe(0)
    }
    // And then it does start, or the holdoff would just be a disabled integrator.
    expect(rows[rows.length - 1].correction.integralRatePerMin).toBeGreaterThan(0.5)
  })

  it('integrates on sample timestamps, and refuses to integrate across a gap it did not observe', () => {
    const plan = journeyPlan(feasibleClimb)
    const at = (state: JourneyControlState, elapsedSec: number) =>
      journeyControlStep(state, {
        plan,
        elapsedSec,
        beanTempC: plan.temperatureAt(elapsedSec) - 2,
        ambientC: AMBIENT_C,
        batchMassG: defaultCalibration.referenceBatchMassG,
        calibration: defaultCalibration,
      })

    // A one-second step and a four-second step accumulate in proportion to their own dt.
    const oneSecond = at(stateWith(0, 299), 300).correction.integralRatePerMin
    const fourSeconds = at(stateWith(0, 296), 300).correction.integralRatePerMin
    expect(fourSeconds).toBeCloseTo(oneSecond * 4, 6)

    // A 60 s stall is clamped to nothing at all rather than integrated as sixty seconds of error.
    expect(at(stateWith(0, 240), 300).correction.integralRatePerMin).toBe(0)
    // A first sample has no dt to integrate over.
    expect(at(stateWith(0), 300).correction.integralRatePerMin).toBe(0)
  })
})
