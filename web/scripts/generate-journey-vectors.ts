/**
 * Cross-language test vectors for the firmware's C++ port of the journey control law.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * `firmware/crackle/crackle/sr800_journey_control.cpp` is a hand port of
 * `web/src/domain/journeyControl.ts`. Two implementations of a control law that decides how much
 * heat to put into a batch of green coffee for twenty minutes is exactly the kind of duplication
 * that drifts silently: a clamp order swapped, a `>=` turned into a `>`, a constant rounded. The
 * roast would still run. It would just run a slightly different roast than the one the browser
 * simulated, and nobody would find out until a batch came out wrong.
 *
 * So the browser is made the ORACLE. This script drives the real `journeyControlStep` through
 * twelve scenarios and records, per second, exactly what went in and exactly what came out. The firmware's
 * host test (`firmware/crackle/tests/journey_control_vector_test.cpp`) replays every one of those
 * steps through the C++ port and requires agreement to 1e-4 on every field.
 *
 * **If a mismatch appears, the PORT is wrong.** Never regenerate the vector to make a failing test
 * pass - that converts the guarantee into a rubber stamp. Regenerate only when the TypeScript
 * control law itself is deliberately changed, and expect the port to change with it.
 *
 * The scenarios are chosen to exercise the parts of the law that a naive port gets wrong:
 *
 *   1. `nominal` - a five-zone journey on a plant that matches the model. Exercises zone-anchored
 *      targeting, direction-aware attainment across four rising zones and a cooling zone, the
 *      maximum-feasible-airflow solve, the full-airflow-through-130 floor, and actuator fold-back.
 *   2. `weak_heater` - the same journey with the PLANT 20% weaker than the controller believes. The
 *      integral has to build and hold a steady non-zero bias; a port that mis-scales `Ki` or
 *      mis-guards `dt` diverges here within a minute.
 *   3. `saturated_windup` - an impossible ramp followed by a reachable near-hold. This is the
 *      conditional-integration case: the integral must FREEZE while the plant is pinned and then
 *      resume, and the saturation-direction revert must re-solve from the frozen value.
 *   4. `dropout` - a mid-roast probe failure. Correction zero, integral frozen, feed-forward solved
 *      against the PLAN's temperature rather than the last good reading, and a clean resume.
 *   5. `heavy_mass_immediate_reduction` - 240 g crossing 130 C. Pins that Fan falls from the forced
 *      10 straight to the solver's output in ONE tick (no 0.05/s walk-down toward a mass-derived
 *      floor), and that no mass floor exists above 130 C.
 *   6. `heat_on_fan_floor` - a shallow hot zone whose maximum-airflow solve wants Fan below 1 while
 *      Heat is on. Pins the universal heat-on Fan 1.0 command floor and its heat re-solve.
 *   7. `overshoot_lag_recovery` - a recorded 225 g Journey roast replayed: its plan, the fit the
 *      device had applied, and a plant hotter and far more airflow-sensitive than that fit, with
 *      the ~8 s actuation dead time and ~10 s probe lag the recording measured. Pins the Heat-first
 *      allocation (Fan stays at 1.0 through zone 3 while Heat moves), the lag-compensated rate
 *      term relaxing while measured RoR is still above the slope, and the -12 cooling bound.
 *
 * Run:  npx vite-node scripts/generate-journey-vectors.ts
 * Out:  firmware/crackle/tests/vectors/journey_control_vectors.json
 *
 * This script only READS from `web/src`; it adds nothing to the app bundle and is not part of the
 * vitest suite (which globs `src/**` only).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultCalibration } from '../src/data/calibration'
import { starterThermalIntent } from '../src/data/demo'
import { effectiveLevels } from '../src/domain/actuatorFloors'
import type { JourneyControlState } from '../src/domain/journeyControl'
import { initialJourneyControlState, journeyControlStep, journeyPlan } from '../src/domain/journeyControl'
import { thermalStep } from '../src/domain/thermalModel'
import type { CalibrationSettings, ThermalIntent, ThermalSegment } from '../src/domain/types'

const AMBIENT_C = 24.5
const BATCH_MASS_G = 225

const intentOf = (segments: ThermalSegment[]): ThermalIntent => ({ ...starterThermalIntent, id: 'vector', segments })

/**
 * The columns of every step row, in order. The firmware test reads this array and looks each field
 * up by name, so adding a column here does not silently shift the C++ side's expectations.
 */
const COLUMNS = [
  // Inputs the firmware replays verbatim.
  'elapsedSec',
  'beanTempC',
  // Outputs it must reproduce.
  'fan',
  'heat',
  'unconstrainedHeat',
  'targetC',
  'integral',
  'total',
  'zoneIndex',
  'zoneEntrySec',
  'errorC',
  'proportional',
  'requiredRate',
  'commandedRate',
  'feedForwardFan',
  'feedForwardHeat',
  // The Heat-first allocation base and the rate feedback. A rate that could not yet be estimated
  // is written as `null` and read back as NaN, exactly like a missing sample.
  'baselineRate',
  'measuredRate',
  'predictedRate',
  'rateTerm',
  // Flags, emitted as 0/1 so the row stays a flat numeric array.
  'cooling',
  'saturated',
  'holdover',
  'saturatedHigh',
  'saturatedLow',
  'heatSlewLimited',
  'holdingAtZoneEnd',
  'zoneAdvanced',
  'zoneCompleted',
] as const

const flag = (value: boolean) => (value ? 1 : 0)

/**
 * Six decimals on the outputs. The firmware asserts to 1e-4, so this is two orders of magnitude of
 * headroom; the inputs are written at full precision because the C++ side re-derives everything
 * from them and a rounded input would make the comparison test the rounding rather than the port.
 */
const round = (value: number) => {
  if (!Number.isFinite(value)) return 0
  return Number(value.toFixed(6))
}
/** A value whose absence is meaningful stays NaN (written as `null`) rather than collapsing to 0. */
const roundOrNaN = (value: number) => (Number.isFinite(value) ? round(value) : Number.NaN)

interface ScenarioOptions {
  name: string
  description: string
  intent: ThermalIntent
  /** What the roaster really is. */
  truth: CalibrationSettings
  /** What the controller was handed - deliberately not always `truth`. */
  model: CalibrationSettings
  seconds: number
  /** Seconds across which the probe reports nothing at all. */
  dropout?: { fromSec: number; toSec: number }
  batchMassG?: number
  /** Repeating sample gaps; used to pin control-law cadence clamps. */
  cadenceSec?: number[]
  /** Device-owned plan replacements applied without resetting controller state. */
  planPatches?: Array<{ elapsedSec: number; intent: ThermalIntent }>
  /**
   * Plant realism for the lag scenario: a command reaches the plant this many seconds after it is
   * issued, and the probe follows the plant through a first-order lag. Both default to the
   * instantaneous plant every other scenario uses.
   */
  actuationDelaySec?: number
  sensorLagSec?: number
}

const runScenario = ({
  name,
  description,
  intent,
  truth,
  model,
  seconds,
  dropout,
  batchMassG = BATCH_MASS_G,
  cadenceSec,
  planPatches = [],
  actuationDelaySec = 0,
  sensorLagSec = 0,
}: ScenarioOptions) => {
  let plan = journeyPlan(intent)
  const orderedPatches = [...planPatches].sort((left, right) => left.elapsedSec - right.elapsedSec)
  let patchIndex = 0
  let state: JourneyControlState = initialJourneyControlState()
  let beanTempC = intent.segments[0].startC
  let rorCPerMin: number | undefined
  const steps: number[][] = []
  const pendingLevels: Array<{ fan: number; heat: number; cooling: boolean }> = []

  let elapsedSec = 0
  let cadenceIndex = 0
  while (elapsedSec <= seconds) {
    while (patchIndex < orderedPatches.length && orderedPatches[patchIndex].elapsedSec <= elapsedSec) {
      plan = journeyPlan(orderedPatches[patchIndex].intent)
      patchIndex += 1
    }
    const blind = dropout !== undefined && elapsedSec >= dropout.fromSec && elapsedSec <= dropout.toSec
    const observedC = blind ? Number.NaN : beanTempC
    const step = journeyControlStep(state, {
      plan,
      elapsedSec,
      beanTempC: observedC,
      ambientC: AMBIENT_C,
      batchMassG,
      calibration: model,
    })
    state = step.state

    steps.push([
      elapsedSec,
      // A dropout is written as `null` in JSON; the firmware turns it back into a NaN.
      blind ? Number.NaN : beanTempC,
      round(step.command.fan),
      round(step.command.heat),
      round(step.command.unconstrainedHeat),
      round(step.command.goalC),
      round(step.correction.integralRatePerMin),
      round(step.correction.totalRatePerMin),
      step.zoneIndex,
      round(step.zoneEntrySec),
      round(step.correction.errorC),
      round(step.correction.proportionalRatePerMin),
      round(step.command.requiredRateCPerMin),
      round(step.command.commandedRateCPerMin),
      round(step.feedForward.fan),
      round(step.feedForward.heat),
      round(step.command.baselineRateCPerMin),
      roundOrNaN(step.rate.measuredRateCPerMin),
      roundOrNaN(step.rate.predictedRateCPerMin),
      round(step.rate.rateRatePerMin),
      flag(step.command.cooling),
      flag(step.correction.saturated),
      flag(step.correction.holdover),
      flag(step.command.saturatedHigh),
      flag(step.command.saturatedLow),
      flag(step.command.heatSlewLimited),
      flag(step.command.holdingAtZoneEnd),
      flag(step.zoneAdvanced),
      flag(step.zoneCompleted),
    ])

    // Advance the PLANT with the truth coefficients, through the actuator's own floors, so the
    // temperature series the firmware replays is one a real closed loop could have produced.
    const levels = effectiveLevels({ fan: step.command.fan, heat: step.command.heat })
    // The actuation dead time: the plant runs the command issued `actuationDelaySec` ago.
    pendingLevels.push({ ...levels, cooling: step.command.cooling })
    const applied = pendingLevels.length > actuationDelaySec ? pendingLevels.shift()! : pendingLevels[0]
    const result = thermalStep(
      {
        previousBeanTempC: beanTempC,
        previousRorCPerMin: rorCPerMin,
        fan: applied.fan,
        heat: applied.heat,
        cooling: applied.cooling,
        batchMassG,
        ambientC: AMBIENT_C,
      },
      truth,
      { probeOffsetC: 0, sensorLagSec },
    )
    beanTempC = result.beanTempC
    rorCPerMin = result.rorCPerMin
    const cadence = cadenceSec?.[cadenceIndex % cadenceSec.length] ?? 1
    elapsedSec += cadence
    cadenceIndex += 1
  }

  return {
    name,
    description,
    ambientC: AMBIENT_C,
    batchMassG,
    calibration: {
      heaterGainCPerMinAt10: model.heaterGainCPerMinAt10,
      fanCoolingCPerMinAt10: model.fanCoolingCPerMinAt10,
      coolingFanCPerMinAt10: model.coolingFanCPerMinAt10,
      thermalLossPerMinPerC: model.thermalLossPerMinPerC,
      referenceBatchMassG: model.referenceBatchMassG,
    },
    zones: intent.segments.map((segment) => ({
      startC: segment.startC,
      endC: segment.endC,
      durationSec: segment.durationSec,
      fanMin: segment.fanMin,
      fanMax: segment.fanMax,
      heatMin: segment.heatMin,
      heatMax: segment.heatMax,
    })),
    planPatches: orderedPatches.map((patch) => ({
      elapsedSec: patch.elapsedSec,
      zones: patch.intent.segments.map((segment) => ({
        startC: segment.startC,
        endC: segment.endC,
        durationSec: segment.durationSec,
        fanMin: segment.fanMin,
        fanMax: segment.fanMax,
        heatMin: segment.heatMin,
        heatMax: segment.heatMax,
      })),
    })),
    steps,
  }
}

// The demo five-zone journey: four rising zones with different bands plus a trailing cooling zone.
const demoJourney = intentOf(starterThermalIntent.segments)

// An impossible ramp - 80 C/min for three minutes - then a near-hold the plant reaches easily.
const windupJourney = intentOf([
  { id: 'impossible', startC: 25, endC: 265, durationSec: 180, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
  { id: 'reachable', startC: 265, endC: 270, durationSec: 600, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
])

// A long, comfortably feasible climb: nothing saturates, so the dropout is the only event in it.
const feasibleClimb = intentOf([
  { id: 'climb', startC: 25, endC: 200, durationSec: 900, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
])

const coolThenHeat = intentOf([
  { id: 'cool', startC: 180, endC: 100, durationSec: 120, fanMin: 4, fanMax: 10, heatMin: 0, heatMax: 0 },
  { id: 'reheat', startC: 100, endC: 165, durationSec: 300, fanMin: 3, fanMax: 9, heatMin: 1, heatMax: 10 },
])

const holdJourney = intentOf([
  { id: 'hold', startC: 160, endC: 160, durationSec: 180, fanMin: 3, fanMax: 9, heatMin: 1, heatMax: 10 },
])

// 240 g with a slow zone above 130 C (Fan holds wide open) followed by a steep push whose required
// Heat no longer fits at Fan 10. At the boundary the solver's Fan falls by whole levels in ONE tick,
// with no rate-limited walk-down toward a mass-derived floor. The boundary out of `open` also pins an
// immediate Fan INCREASE: an earlier Fan reduction is never retained across a zone boundary.
const heavyMassJourney = intentOf([
  { id: 'open', startC: 25, endC: 170, durationSec: 300, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
  { id: 'settle', startC: 170, endC: 185, durationSec: 420, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
  { id: 'push', startC: 185, endC: 225, durationSec: 90, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
  { id: 'cool', startC: 225, endC: 50, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 0 },
])

// A shallow, hot, low-Heat-ceiling zone: the maximum-airflow solve asks for Fan below 1 while Heat
// stays on, so the universal heat-on Fan 1.0 floor must bind and the Heat re-solve must follow it.
const heatOnFloorJourney = intentOf([
  { id: 'shallow-hot', startC: 175, endC: 185, durationSec: 900, fanMin: 0.1, fanMax: 10, heatMin: 0, heatMax: 3 },
])

const patchJourney = intentOf([
  { id: 'first', startC: 25, endC: 150, durationSec: 360, fanMin: 4, fanMax: 9, heatMin: 1, heatMax: 9 },
  { id: 'second', startC: 150, endC: 195, durationSec: 300, fanMin: 4, fanMax: 9, heatMin: 1, heatMax: 10 },
])
const patchedJourney = intentOf([
  { id: 'first', startC: 25, endC: 160, durationSec: 420, fanMin: 4, fanMax: 9, heatMin: 1, heatMax: 9 },
  { id: 'second', startC: 160, endC: 200, durationSec: 300, fanMin: 4, fanMax: 9, heatMin: 1, heatMax: 10 },
])

/**
 * A recorded 225 g Journey roast: its plan (zone 1 locked at Fan 10 / Heat 10, zone 3 the
 * 180 -> 215 C climb at 17.5 °C/min where the fan excursion happened), the calibration the device
 * had applied, and a plant that is what the recording showed the roaster to be: hotter than its fit
 * (the fit predicts 13.3 °C/min at Fan 1 / Heat 10 where the roaster ran 22+) and far more
 * airflow-sensitive in heating mode than the fitted 2.94 °C/min. Under a Fan-first correction law
 * this plant reproduces the recording: Fan 1 -> 10 in seconds with Heat pinned at 10, RoR
 * collapsing, zone 3 late.
 */
const overshootJourney = intentOf([
  { id: 'charge', startC: 28.8, endC: 150, durationSec: 120, fanMin: 10, fanMax: 10, heatMin: 10, heatMax: 10 },
  { id: 'drive', startC: 150, endC: 180, durationSec: 60, fanMin: 5, fanMax: 10, heatMin: 5, heatMax: 10 },
  { id: 'develop', startC: 180, endC: 215, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
  { id: 'finish', startC: 215, endC: 233, durationSec: 60, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
  { id: 'cool', startC: 233, endC: 50, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 0 },
])
const overshootAppliedFit: CalibrationSettings = {
  ...defaultCalibration,
  heaterGainCPerMinAt10: 49.2,
  fanCoolingCPerMinAt10: 2.94,
  coolingFanCPerMinAt10: 19.67,
  thermalLossPerMinPerC: 0.2443,
  referenceBatchMassG: 225,
}
const overshootRoaster: CalibrationSettings = {
  ...overshootAppliedFit,
  heaterGainCPerMinAt10: 62,
  fanCoolingCPerMinAt10: 12,
}

const weakPlant: CalibrationSettings = {
  ...defaultCalibration,
  heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 0.8,
}

const scenarios = [
  runScenario({
    name: 'nominal',
    description:
      'Five-zone demo journey, plant matches the model. Zone attainment, maximum-feasible airflow, the circulation floor and actuator fold-back all fire; the correction stays small.',
    intent: demoJourney,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 900,
  }),
  runScenario({
    name: 'weak_heater',
    description:
      'The same journey with the PLANT 20% weaker than the controller believes. The integral must build and hold a steady positive bias.',
    intent: demoJourney,
    truth: weakPlant,
    model: defaultCalibration,
    seconds: 900,
  }),
  runScenario({
    name: 'saturated_windup',
    description:
      'An unreachable 80 C/min ramp followed by a reachable near-hold. The integral must FREEZE while the plant is pinned (conditional integration and the saturation-direction revert), then resume.',
    intent: windupJourney,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 780,
  }),
  runScenario({
    name: 'hold_zone',
    description: 'A true start-equals-end zone pins the maintenance-hold path in both implementations.',
    intent: holdJourney,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 240,
  }),
  runScenario({
    name: 'mid_roast_plan_patch',
    description:
      'At 120 seconds the device-owned plan is replaced in place while control state and zone anchor continue.',
    intent: patchJourney,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 540,
    planPatches: [{ elapsedSec: 120, intent: patchedJourney }],
  }),
  runScenario({
    name: 'non_reference_mass',
    description: 'The feasible climb at 300 g pins the reference-mass scaling across TypeScript and C++.',
    intent: feasibleClimb,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 420,
    batchMassG: 300,
  }),
  runScenario({
    name: 'cool_then_heat',
    description:
      'A cooling zone followed by a heating zone pins direction changes and the return to a heat-bearing solve.',
    intent: coolThenHeat,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 420,
  }),
  runScenario({
    name: 'irregular_cadence',
    description: 'Irregular 1/2/7/1/12-second samples pin both integration and heat-slew delta-time clamps.',
    intent: feasibleClimb,
    truth: weakPlant,
    model: defaultCalibration,
    seconds: 420,
    cadenceSec: [1, 2, 7, 1, 12],
  }),
  runScenario({
    name: 'heavy_mass_immediate_reduction',
    description:
      'At 240 g a slow zone above 130 C holds Fan wide open, then a steep push demands more Heat than Fan 10 permits: Fan falls by whole levels in one tick. No mass floor, no reduction rate limit, no retained reduction.',
    intent: heavyMassJourney,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 1020,
    batchMassG: 240,
  }),
  runScenario({
    name: 'heat_on_fan_floor',
    description:
      'A shallow hot zone whose maximum-airflow solve wants Fan below 1 with Heat on. The universal heat-on Fan 1.0 command floor binds and the Heat solve is folded back through it.',
    intent: heatOnFloorJourney,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 300,
  }),
  runScenario({
    name: 'overshoot_lag_recovery',
    description:
      'A recorded 225 g Journey roast replayed: its plan and the fit the device had applied against a hotter, airflow-sensitive plant with 8 s actuation dead time and 10 s probe lag. Pins Heat-first correction allocation (Fan holds 1.0 through zone 3), the lag-compensated rate term relaxing before RoR crosses the slope, and the -12 °C/min cooling bound.',
    intent: overshootJourney,
    truth: overshootRoaster,
    model: overshootAppliedFit,
    seconds: 780,
    actuationDelaySec: 8,
    sensorLagSec: 10,
  }),
  runScenario({
    name: 'dropout',
    description:
      'A feasible climb against a 20%-wrong model with the probe dead from 400 s to 430 s. Correction zero, integral frozen, feed-forward solved against the PLAN temperature, clean resume.',
    intent: feasibleClimb,
    truth: defaultCalibration,
    model: { ...defaultCalibration, heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 1.2 },
    seconds: 900,
    dropout: { fromSec: 400, toSec: 430 },
  }),
]

const document = {
  generator: 'web/scripts/generate-journey-vectors.ts',
  source: 'web/src/domain/journeyControl.ts',
  note: 'The TypeScript control law is the oracle. If the C++ port disagrees, fix the PORT, never this file.',
  constants: {
    trackingKpRatePerC: 3.0,
    trackingIntegralTimeSec: 45,
    trackingDerivativeTimeSec: 10,
    trackingRateGain: 0.5,
    rateWindowSec: 10,
    rateLeadSec: 10,
    maxRateLeadCPerMin: 10,
    rateHistorySec: 30,
    rateHistoryCapacity: 32,
    maxCorrectionCPerMin: 15,
    maxIntegralCPerMin: 8,
    maxCoolingCorrectionCPerMin: 12,
    maxCoolingIntegralCPerMin: 8,
    maxIntegrationStepSec: 5,
    staleSampleGapSec: 15,
    maxHeatSlewPerSec: 0.25,
    maxHeatSlewStepSec: 1,
    integralHoldoffSec: 20,
    plantBiasCPerMin: 4,
    minimumModelledCoolingCPerMin: 8,
    zoneHoldEpsilonC: 0.5,
    actuatorMinimumPositiveFan: 0.1,
    /** Heat on means Fan 1.0 or higher, on every command path. */
    heatOnMinimumFan: 1,
    fullAirflowUntilC: 130,
  },
  columns: COLUMNS,
  scenarios,
}

const here = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(here, '../../firmware/crackle/tests/vectors/journey_control_vectors.json')
mkdirSync(dirname(outputPath), { recursive: true })
// `NaN` is not JSON, so a blind sample is written as `null` and read back as a missing measurement.
writeFileSync(
  outputPath,
  `${JSON.stringify(document, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value))}\n`,
)

const totalSteps = scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0)
console.log(`wrote ${outputPath}`)
console.log(`${scenarios.length} scenarios, ${totalSteps} steps, ${COLUMNS.length} columns`)
for (const scenario of scenarios) {
  console.log(`  ${scenario.name}: ${scenario.steps.length} steps, ${scenario.zones.length} zones`)
}
