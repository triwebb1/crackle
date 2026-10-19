import {
  type JourneyResidualReport,
  type JourneyZoneRow,
  summarizeJourneyZones,
  type ZoneRole,
  zoneRoles,
} from './controlResidual'
import { ESTIMATED_BASELINE_COEFFICIENTS, ESTIMATED_BASELINE_MASS_G } from './estimatedBaseline'
import {
  initialJourneyControlState,
  journeyControlStep,
  journeyPlan,
  zoneCompleted,
  zoneFeasibility,
} from './journeyControl'
import { effectiveLevels, effectiveThermalIntent } from './model'
import { roastRuntimeEnvelopeSec, timedRoastSteps } from './roastProgram'
import { SIMULATED_ROASTER_SENSOR_MODEL, thermalStep } from './thermalModel'
import type {
  CalibrationSettings,
  ControlCorrection,
  Profile,
  TelemetrySample,
  ThermalIntent,
  TimedProfile,
} from './types'

/**
 * The simulation's ONLY source of inaccuracy, and it is opt-in.
 *
 * Predicted duration, predicted finish and furthest-off-goal mean nothing for a pure simulation,
 * which should be perfectly accurate. They matter only with an error variable in the input, so the
 * simulation can evaluate how the algorithm adjusts for that error. A loop that drives the plant
 * with the SAME coefficients it hands the controller reports an "accuracy" that measures the sensor
 * lag and nothing else, and that is no prediction of a real roast.
 *
 * So the split the `journeyControl.pi.test.ts` harness uses is lifted into the simulation
 * itself: the PLANT runs on one coefficient set (the truth) and the CONTROLLER inverts another (the
 * model, which is whatever calibration is loaded). These percentages are how far the truth is
 * assumed to sit from the model - the real roaster's heater being weaker than believed is
 * `heaterGainErrorPercent: -20`. Zero, the default, means truth === model and the run is a pure
 * feasibility statement about the PROFILE with no accuracy claim in it at all.
 *
 * The bound is +/-30%, which is the range the PI acceptance tests actually validate: they hold the
 * plan within 2 °C at +/-20% heater gain and +30% thermal loss, and demonstrate a visibly failing
 * roast (rather than a quietly rescued one) at +200%. Outside the validated range the panel would be
 * reporting behaviour nothing has checked.
 */
export interface AssumedModelError {
  /** How far the REAL heater gain sits from the believed one, in percent. */
  heaterGainErrorPercent: number
  /** How far the REAL passive thermal loss sits from the believed one, in percent. */
  thermalLossErrorPercent: number
}

export const NO_ASSUMED_ERROR: AssumedModelError = { heaterGainErrorPercent: 0, thermalLossErrorPercent: 0 }
export const MAX_ASSUMED_ERROR_PERCENT = 30

export const hasAssumedError = (error: AssumedModelError | undefined): boolean =>
  error !== undefined && (error.heaterGainErrorPercent !== 0 || error.thermalLossErrorPercent !== 0)

export interface ProfileSimulationInput {
  profile: Profile
  calibration: CalibrationSettings
  massG: number
  volumeMl?: number
  /** Absent or all-zero is a perfect-model run: the plant IS the controller's model. */
  assumedError?: AssumedModelError
}

/** What a simulation falls back to when it is handed no usable mass at all. */
export const DEFAULT_BATCH_MASS_G = 225

// A malformed zone can invert its own limits; the bounds are ordered before clamping.
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(Math.min(minimum, maximum), Math.min(Math.max(minimum, maximum), value))

/**
 * Current scientific boundary: complete net thermal rate is adjusted by measured batch mass. Volume
 * and bulk density remain recorded covariates; neither is converted into guessed surface area.
 */
export const modeledMass = (massG: number, _volumeMl?: number) => massG

/** The ambient the simulation assumes, matching the thermal model's own default. */
const AMBIENT_C = 24.5
/** The ambient substituted for a non-finite reading anywhere the control law is driven advisorily. */
export const DEFAULT_AMBIENT_C = AMBIENT_C

/**
 * A non-finite ambient, mass or coefficient flows straight through the control law's arithmetic to
 * `command.heat = NaN`. The browser drives that law only advisorily (simulation, the live chart), so
 * its callers substitute finite defaults rather than draw nonsense: ambient 24.5 °C, the default
 * batch mass, and the estimated-baseline coefficients.
 */
export const finiteAmbientC = (ambientC: number | undefined): number =>
  ambientC !== undefined && Number.isFinite(ambientC) ? ambientC : DEFAULT_AMBIENT_C

export const finiteBatchMassG = (massG: number | undefined): number =>
  massG !== undefined && Number.isFinite(massG) && massG > 0 ? massG : DEFAULT_BATCH_MASS_G

/** The calibration with every non-finite control field replaced by its default; identity if none is. */
export const finiteControlCalibration = (calibration: CalibrationSettings): CalibrationSettings => {
  const defaults: Record<string, number> = {
    ...ESTIMATED_BASELINE_COEFFICIENTS,
    referenceBatchMassG: ESTIMATED_BASELINE_MASS_G,
    coolingTargetMarginC: 5,
  }
  let repaired: CalibrationSettings | undefined
  for (const [field, fallback] of Object.entries(defaults)) {
    const value = (calibration as unknown as Record<string, unknown>)[field]
    if (typeof value === 'number' && Number.isFinite(value)) continue
    // `coolingTargetMarginC` may legitimately be absent on an older record; only a present
    // non-finite value, or a missing coefficient, is repaired.
    if (value === undefined && field === 'coolingTargetMarginC') continue
    repaired ??= { ...calibration }
    ;(repaired as unknown as Record<string, number>)[field] = fallback
  }
  return repaired ?? calibration
}

const appendStep = (
  samples: TelemetrySample[],
  elapsedSec: number,
  fan: number,
  heat: number,
  cooling: boolean,
  batchMassG: number,
  calibration: CalibrationSettings,
  correction?: ControlCorrection,
) => {
  const previous = samples.at(-1)
  const levels = effectiveLevels(fan, heat)
  const result = thermalStep(
    {
      previousBeanTempC: previous?.beanTempC,
      previousRorCPerMin: previous?.rorCPerMin,
      fan: levels.effectiveFan,
      heat: levels.effectiveHeat,
      cooling,
      batchMassG,
    },
    calibration,
    SIMULATED_ROASTER_SENSOR_MODEL,
  )
  samples.push({
    elapsedSec,
    beanTempC: result.beanTempC,
    rorCPerMin: result.rorCPerMin,
    requestedFan: levels.requestedFan,
    effectiveFan: levels.effectiveFan,
    requestedHeat: levels.requestedHeat,
    effectiveHeat: levels.effectiveHeat,
    phase: cooling ? 'COOLING' : 'DRYING',
    // Timed profiles run open loop, so they carry no correction at all rather than a row of zeroes.
    ...(correction ? { correction } : {}),
  })
}

const simulateTimed = (profile: TimedProfile, calibration: CalibrationSettings, batchMassG: number) => {
  const samples: TelemetrySample[] = []
  const steps = timedRoastSteps(profile)
  if (steps.length === 0) return samples
  const duration = steps.reduce((total, step) => total + step.durationSec, 0)
  let stepIndex = 0
  let stepEndsAtSec = steps[0].durationSec
  for (let elapsedSec = 0; elapsedSec <= duration; elapsedSec += 1) {
    while (stepIndex < steps.length - 1 && elapsedSec >= stepEndsAtSec) {
      stepIndex += 1
      stepEndsAtSec += steps[stepIndex].durationSec
    }
    const step = steps[stepIndex]
    appendStep(samples, elapsedSec, step.fan, step.heat, step.heat === 0, batchMassG, calibration)
  }
  return samples
}

/** A last resort against a pathological profile, so the browser cannot be locked up by one. */
export const MAX_SIMULATION_SEC = 7200

export interface SimulatedZone {
  zoneIndex: number
  zoneId: string
  role: ZoneRole
  startC: number
  endC: number
  nominalDurationSec: number
  /** When the roast entered the zone, and when it attained the endpoint. */
  entrySec: number
  attainedSec?: number
  /**
   * Whether the run reached this zone at all. Stated rather than inferred from `entrySec`, which is
   * reported as 0 for a zone that was never entered and is indistinguishable from the first zone's
   * real entry - a chart that guessed drew an overrun bar for a zone the roast never saw.
   */
  entered: boolean
  simulatedDurationSec: number
  /** Simulated minus nominal. In a PERFECT-model run this is infeasibility, not model error. */
  overrunSec: number
  attained: boolean
  /** The zone's endpoint is beyond what its own Fan and Heat band can hold. See `zoneFeasibility`. */
  infeasible: boolean
  reachableC: number
  /** Where the simulation actually got to inside the zone: hottest if rising, coldest if cooling. */
  plateauC: number
  /**
   * Cooling zones only: how far the temperature climbed back after entering the zone. The plant
   * model cools monotonically, so this is ~0 by construction and saying so is the honest reading -
   * a real roaster's surface probe DOES rebound as the fan slows, and this model does not know that.
   */
  reboundC: number
}

export interface JourneySimulation {
  samples: TelemetrySample[]
  zones: SimulatedZone[]
  /** Per-sample zone attribution: the input `controlResidual` splits the run by. */
  rows: JourneyZoneRow[]
  residual: JourneyResidualReport
  /** The coefficients the PLANT ran on. Equal to the controller's unless an error was assumed. */
  truth: CalibrationSettings
  assumedError: AssumedModelError
  /** Set when the device-matched whole-profile runtime envelope expired inside this zone. */
  abandonedZoneIndex?: number
  completedSec: number
}

const clampPercent = (value: number) =>
  Number.isFinite(value) ? clamp(value, -MAX_ASSUMED_ERROR_PERCENT, MAX_ASSUMED_ERROR_PERCENT) : 0

/**
 * The roaster the simulated plant actually is, given what the controller believes it is. Only the
 * two coefficients the PI acceptance tests perturb are touched; inventing error in the others would
 * be reporting behaviour nothing has validated.
 */
export const truthCalibration = (model: CalibrationSettings, assumedError?: AssumedModelError): CalibrationSettings => {
  if (!hasAssumedError(assumedError)) return model
  const error = assumedError as AssumedModelError
  return {
    ...model,
    heaterGainCPerMinAt10: model.heaterGainCPerMinAt10 * (1 + clampPercent(error.heaterGainErrorPercent) / 100),
    thermalLossPerMinPerC: model.thermalLossPerMinPerC * (1 + clampPercent(error.thermalLossErrorPercent) / 100),
  }
}

/**
 * A temperature journey, simulated as a modelled plant following a derived plan.
 *
 * The control law is `journeyControlStep`, which inverts the same thermal model this loop then runs
 * forward and closes a PI loop on the result - see `journeyControl.ts` for the algebra. Four things
 * matter here:
 *
 * - The required trajectory comes from the zone's own NOMINAL ramp, anchored where the roast entered
 *   the zone, so a roast that falls behind does not quietly re-plan around its own failure.
 * - **Zones step on ATTAINMENT, never on a clock.** The loop cannot show a predicted line sitting
 *   below zone 1's endpoint while zone 2 is running, because there is no code path that advances a
 *   zone without the plant having reached its temperature. That was the reported bug.
 * - Fan is derived rather than parked at a zone midpoint. It may fall when the requested RoR needs
 *   more thermal authority, but an easier next zone does not automatically reopen it.
 * - The plant and the controller are TWO coefficient sets. With no assumed error they are the same
 *   object and the run is a pure feasibility statement about the profile; with one, the plant is
 *   perturbed and the controller is not, which is the only way a simulation can say anything honest
 *   about accuracy at all.
 *
 * The run ends when the final zone is attained - not on a clock either - or when the same
 * whole-profile runtime envelope as the firmware expires. Individual zones deliberately have no
 * private timeout: a slow early zone may use the allowance the complete roast owns.
 */
const simulateThermal = (
  intent: ThermalIntent,
  calibration: CalibrationSettings,
  batchMassG: number,
  assumedError: AssumedModelError,
): JourneySimulation => {
  const effectiveIntent = effectiveThermalIntent(intent, AMBIENT_C, calibration.coolingTargetMarginC)
  const plan = journeyPlan(effectiveIntent)
  const truth = truthCalibration(calibration, assumedError)
  const samples: TelemetrySample[] = []
  const rows: JourneyZoneRow[] = []
  const segments = effectiveIntent.segments
  const empty: JourneySimulation = {
    samples,
    zones: [],
    rows,
    truth,
    assumedError,
    completedSec: 0,
    residual: summarizeJourneyZones(segments, rows),
  }
  if (segments.length === 0 || plan.totalSec <= 0) return empty

  const roles = zoneRoles(segments)
  const lastIndex = segments.length - 1
  const entrySec = segments.map(() => Number.NaN)
  const attainedSec = segments.map<number | undefined>(() => undefined)
  const plateauC = segments.map(() => Number.NaN)
  entrySec[0] = 0

  let controlState = initialJourneyControlState()
  let abandonedZoneIndex: number | undefined
  let completedSec = 0
  const runtimeEnvelopeSec = Math.min(MAX_SIMULATION_SEC, roastRuntimeEnvelopeSec(plan.totalSec))

  for (let elapsedSec = 0; elapsedSec <= MAX_SIMULATION_SEC; elapsedSec += 1) {
    const previous = samples.at(-1)
    const beanTempC = previous?.beanTempC ?? segments[0].startC
    const step = journeyControlStep(controlState, {
      plan,
      elapsedSec,
      beanTempC,
      ambientC: AMBIENT_C,
      batchMassG,
      calibration,
    })
    if (step.zoneIndex !== controlState.zoneIndex) {
      /*
       * The step recognised the arrival at `elapsedSec`, but the SAMPLE that attained the endpoint is
       * the one the step was handed - a controller always acts on the last measurement, in a
       * simulation exactly as in a roast. The zone is entered when the control picks it up and
       * attained when the temperature crossed, which are one sample apart and are both true.
       */
      const crossedSec = previous?.elapsedSec ?? elapsedSec
      for (let index = controlState.zoneIndex; index < step.zoneIndex; index += 1) attainedSec[index] = crossedSec
      entrySec[step.zoneIndex] = step.zoneEntrySec
    }
    controlState = step.state
    const { command } = step
    // The plant runs on `truth`; the controller above ran on `calibration`. That is the whole split.
    appendStep(samples, elapsedSec, command.fan, command.heat, command.cooling, batchMassG, truth, step.correction)
    rows.push({ elapsedSec, zoneIndex: step.zoneIndex, correction: step.correction })
    completedSec = elapsedSec

    const reachedC = samples[samples.length - 1].beanTempC
    const zone = segments[step.zoneIndex]
    const rising = zone.endC >= zone.startC
    const seen = plateauC[step.zoneIndex]
    plateauC[step.zoneIndex] = Number.isNaN(seen)
      ? reachedC
      : rising
        ? Math.max(seen, reachedC)
        : Math.min(seen, reachedC)

    // Attainment is read off the temperature the plant just produced, not the one the step saw, so
    // the final zone finishes on the sample that reached it rather than one second later.
    if (step.zoneIndex === lastIndex && zoneCompleted(zone, reachedC, elapsedSec - step.zoneEntrySec)) {
      attainedSec[lastIndex] = elapsedSec
      break
    }
    if (elapsedSec >= runtimeEnvelopeSec) {
      abandonedZoneIndex = step.zoneIndex
      break
    }
  }

  const zones = segments.map((zone, zoneIndex): SimulatedZone => {
    const entered = Number.isFinite(entrySec[zoneIndex])
    const entry = entered ? entrySec[zoneIndex] : Number.NaN
    const exit = attainedSec[zoneIndex] ?? (entered ? completedSec : Number.NaN)
    const simulatedDurationSec = entered ? Math.max(0, exit - entry) : 0
    const feasibility = zoneFeasibility(zone, { batchMassG, ambientC: AMBIENT_C }, truth)
    const coolingEntryC = entered
      ? (samples.find((sample) => sample.elapsedSec >= entry)?.beanTempC ?? zone.startC)
      : zone.startC
    const peakAfterEntry = entered
      ? Math.max(
          ...samples.filter((sample) => sample.elapsedSec >= entry).map((sample) => sample.beanTempC),
          coolingEntryC,
        )
      : coolingEntryC
    return {
      zoneIndex,
      zoneId: zone.id,
      role: roles[zoneIndex],
      startC: zone.startC,
      endC: zone.endC,
      nominalDurationSec: Math.max(0, zone.durationSec),
      entrySec: entered ? entry : 0,
      attainedSec: attainedSec[zoneIndex],
      entered,
      simulatedDurationSec,
      overrunSec: entered ? simulatedDurationSec - Math.max(0, zone.durationSec) : 0,
      attained: attainedSec[zoneIndex] !== undefined,
      infeasible: feasibility.infeasible,
      reachableC: feasibility.reachableC,
      plateauC: Number.isNaN(plateauC[zoneIndex]) ? zone.startC : plateauC[zoneIndex],
      reboundC: zone.endC < zone.startC && entered ? Math.max(0, peakAfterEntry - coolingEntryC) : 0,
    }
  })

  return {
    samples,
    zones,
    rows,
    residual: summarizeJourneyZones(segments, rows, {
      finalZoneAttained: attainedSec[lastIndex] !== undefined,
      endSec: completedSec,
    }),
    truth,
    assumedError,
    abandonedZoneIndex,
    completedSec,
  }
}

/**
 * The full journey reading: samples, per-zone verdicts, and the residual split by zone role. The
 * panel wants all of it; `simulateProfileSnapshot` keeps returning only the samples, because every
 * other caller in the app is drawing a chart.
 */
export const simulateJourney = ({
  profile,
  calibration: rawCalibration,
  massG,
  volumeMl,
  assumedError,
}: ProfileSimulationInput): JourneySimulation => {
  const calibration = finiteControlCalibration(rawCalibration)
  const batchMassG = modeledMass(finiteBatchMassG(massG), volumeMl)
  const error = assumedError ?? NO_ASSUMED_ERROR
  if (profile.strategy === 'timed') {
    const samples = simulateTimed(profile, calibration, batchMassG)
    return {
      samples,
      zones: [],
      rows: [],
      truth: calibration,
      assumedError: error,
      completedSec: samples.at(-1)?.elapsedSec ?? 0,
      residual: summarizeJourneyZones([], []),
    }
  }
  return simulateThermal(profile, calibration, batchMassG, error)
}

export const simulateProfileSnapshot = ({
  profile,
  calibration: rawCalibration,
  massG,
  volumeMl,
  assumedError,
}: ProfileSimulationInput) => {
  // `Math.max(1, NaN)` is NaN, so a bare max guard lets a missing mass through and every downstream
  // figure becomes NaN. Mass is not part of the profile; it comes from a form, so a field that is
  // momentarily empty must not be able to poison the whole simulation.
  const calibration = finiteControlCalibration(rawCalibration)
  const batchMassG = modeledMass(finiteBatchMassG(massG), volumeMl)
  return profile.strategy === 'timed'
    ? simulateTimed(profile, calibration, batchMassG)
    : simulateThermal(profile, calibration, batchMassG, assumedError ?? NO_ASSUMED_ERROR).samples
}

export const profileGoalAt = (profile: Profile, _profiles: Profile[]) =>
  profile.strategy === 'thermal-intent' ? profile : undefined
