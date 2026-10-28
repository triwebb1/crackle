import { type ModelFit, replayThermalLog } from './modelFit'
import type { CalibrationRun, CalibrationSettings, ThermalCoefficientField, ThermalSample } from './types'

/**
 * Fitting the bean-side thermal coefficients to logs of real roasts.
 *
 * This is the path that turns a roaster into ITS OWN baseline. A diagnostic air-map pass measures
 * the empty chamber, which is a different regime from a loaded roast and cannot stand in for one.
 * A loaded roast - driven by hand from Controls, which records the same 1 Hz log - is the
 * only data that describes what the model is actually asked to predict.
 *
 * ============================================================================================
 * THE SEARCH
 * ============================================================================================
 *
 * The objective is the open-loop replay RMS from `modelFit.ts`: run the recorded Fan and Heat
 * through the model and compare against the recorded temperature, seeded once and never
 * re-anchored. Minimising a flattering closed-loop score would be worse than not fitting at all.
 *
 * The search is **Hooke-Jeeves pattern search**: coordinate probing plus one extra move,
 * hand-rolled and deliberately dull.
 *
 *   1. Start from the current coefficients - the estimated baseline, or whatever is applied.
 *   2. EXPLORE: for each coefficient in turn, try one step up and one step down, keeping whichever
 *      of the three candidates scores best.
 *   3. PATTERN: if the sweep moved at all, try continuing in the same overall direction by the same
 *      total displacement, and keep that if it scores better still.
 *   4. When a whole sweep improves nothing, halve every step size and sweep again.
 *   5. Stop when the steps are smaller than the resolution worth reporting, or at the sweep cap.
 *
 * Step 3 is what makes this converge rather than stall. Heater gain and fan cooling are strongly
 * correlated in a roast log - more heat and more airflow cancel - so plain coordinate descent
 * zig-zags across that valley in ever-smaller steps and settles on the wrong point while its RMS
 * still looks respectable. The pattern move walks ALONG the valley instead of across it, at a cost
 * of one extra evaluation per sweep.
 *
 * No gradients, no random restarts. Every step can be reproduced by hand from the numbers in this
 * file, which matters more here than speed. Step sizes are proportional to each coefficient's own
 * magnitude, so one parameter cannot dominate the sweep purely because it is measured in larger
 * units.
 *
 * **Identifiability.** A fit is only as good as the excitation in the log. A roast that never moves
 * the fan says nothing about fan cooling, and one that never varies heat says nothing about gain;
 * the search will happily trade one against the other and report a small RMS either way.
 * `logExcitation` measures that from the recorded levels alone, and the result travels with the
 * fit - a confident number from an unexciting log is exactly the trap this flow exists to avoid.
 *
 * **Several logs are fitted jointly** by pooling their residuals: each log is replayed on its own,
 * from its own seed, and the squared errors are summed across all of them before the root is taken.
 * A coefficient set that suits one roast and ruins another therefore scores badly, which is the
 * whole point of fitting more than one.
 *
 * **Bounds** keep the search inside physically meaningful values. A negative fan-cooling
 * coefficient would fit some logs better while meaning "the fan heats the beans", and a loss at or
 * below zero makes the model's steady state infinite. A fit that pins itself against a bound is
 * reported rather than hidden, because it usually means the log does not constrain that
 * coefficient - a roast with the fan never moved says nothing about fan cooling.
 * ============================================================================================
 */

export const FITTED_FIELDS: ThermalCoefficientField[] = [
  'heaterGainCPerMinAt10',
  'fanCoolingCPerMinAt10',
  'coolingFanCPerMinAt10',
  'thermalLossPerMinPerC',
]

/** Physically meaningful ranges. A fit that lands on one of these is reported as pinned. */
export const COEFFICIENT_BOUNDS: Record<ThermalCoefficientField, { min: number; max: number }> = {
  // Heater gain and thermal loss are coupled: their ratio, rather than heater
  // gain alone, determines the model's steady-state temperature authority.
  heaterGainCPerMinAt10: { min: 0.1, max: 500 },
  // Keep this aligned with the controller's apply contract. Zero is both physically meaningless
  // and impossible to apply, so a preview must never advertise it as a usable fit.
  fanCoolingCPerMinAt10: { min: 0.5, max: 200 },
  coolingFanCPerMinAt10: { min: 1, max: 300 },
  thermalLossPerMinPerC: { min: 0.005, max: 2 },
}

/** One log to fit against, with the batch it was roasted at. */
export interface FitSource {
  id: string
  label: string
  samples: ThermalSample[]
  /** Present for a loaded roast; absent for an empty-chamber pass. */
  massG?: number
  ambientC?: number
  /** Loaded-roast opening turnaround is simulated but omitted from the coefficient objective. */
  scoreFromSec?: number
}

export interface LogExcitation {
  /** Distinct fan levels seen while the element was on. */
  fanLevels: number
  /** Distinct heat levels seen. */
  heatLevels: number
  /** True when fan varies at a roughly constant heat, which is what separates gain from airflow. */
  fanSweptAtConstantHeat: boolean
  /** True when there is a fan-on, heat-off tail, which is what constrains the cooling coefficient. */
  hasCoolingTail: boolean
  warnings: string[]
}

/** What a log can and cannot tell the fitter, knowable before any fitting is attempted. */
export const logExcitation = (samples: ThermalSample[]): LogExcitation => {
  const readable = samples.filter((sample) => sample.thermocoupleC !== undefined)
  const heating = readable.filter((sample) => sample.effectiveHeat > 0)
  const bucket = (value: number) => Math.round(value * 2) / 2
  const fanLevels = new Set(heating.map((sample) => bucket(sample.effectiveFan)))
  const heatLevels = new Set(heating.map((sample) => bucket(sample.effectiveHeat)))

  const byHeat = new Map<number, Set<number>>()
  for (const sample of heating) {
    const key = bucket(sample.effectiveHeat)
    if (!byHeat.has(key)) byHeat.set(key, new Set())
    byHeat.get(key)!.add(bucket(sample.effectiveFan))
  }
  const fanSweptAtConstantHeat = [...byHeat.values()].some((fans) => fans.size >= 2)
  const hasCoolingTail = readable.some((sample) => sample.effectiveHeat === 0 && sample.effectiveFan > 0)

  const warnings: string[] = []
  if (heatLevels.size < 2) warnings.push('Heat never changed, so the heater gain cannot be separated from the losses.')
  if (fanLevels.size < 2)
    warnings.push('Fan never changed while heating, so fan cooling is not constrained by this log.')
  else if (!fanSweptAtConstantHeat)
    warnings.push(
      'Fan and heat only ever moved together, so their effects cannot be told apart. Hold one and vary the other for part of a roast.',
    )
  if (!hasCoolingTail)
    warnings.push('No fan-on cooling tail, so the cooling coefficient is carried over rather than fitted.')
  return { fanLevels: fanLevels.size, heatLevels: heatLevels.size, fanSweptAtConstantHeat, hasCoolingTail, warnings }
}

export interface CoefficientFit {
  coefficients: Record<ThermalCoefficientField, number>
  /** Pooled RMS across every source, before and after. */
  rmsC: number
  startingRmsC: number
  /** Per-source scores with the fitted coefficients, so one bad log cannot hide behind the pool. */
  perSource: Array<{ id: string; label: string; fit: ModelFit | undefined }>
  sweeps: number
  /** Coefficients that finished hard against a bound: usually a sign the logs do not constrain them. */
  pinned: ThermalCoefficientField[]
  sources: number
  samples: number
  /** What the pooled logs could actually constrain, and what they could not. */
  excitation: LogExcitation
  /** Fields for which materially different seeds fit almost equally well. Do not apply these. */
  unstable: ThermalCoefficientField[]
  /** Near-best multi-start range for each fitted field. */
  seedRange: Record<ThermalCoefficientField, { min: number; max: number }>
  /** Fields held at a supplied value for the whole search rather than fitted. */
  frozen: ThermalCoefficientField[]
}

/**
 * Into the field's bounds, and always finite: `Math.max(min, Math.min(max, NaN))` is NaN, which let a
 * non-finite base coefficient ride through the whole search and come back as a NaN "fit". An
 * infinity goes to the bound it points at; NaN starts from the bounds' geometric mean, a
 * scale-sensible interior point the search can move away from.
 */
const clampTo = (field: ThermalCoefficientField, value: number) => {
  const { min, max } = COEFFICIENT_BOUNDS[field]
  if (Number.isNaN(value)) return Math.sqrt(min * max)
  return Math.max(min, Math.min(max, value))
}

/** A replay that could not be scored, or scored NaN, is the worst possible candidate - never a tie. */
const finiteScore = (value: number | undefined) =>
  value === undefined || Number.isNaN(value) ? Number.POSITIVE_INFINITY : value

const round = (field: ThermalCoefficientField, value: number) =>
  Number(value.toFixed(field === 'thermalLossPerMinPerC' ? 4 : 2))

/**
 * A useful movement scale for each coordinate.
 *
 * Basing the first probe only on the current value traps a fit that starts near a lower bound: at
 * fan cooling 0.5, a 35% probe moves only 0.175 even though the useful valley is tens of degrees C/min
 * away. These scales keep the local search deterministic while allowing it to leave a poor applied
 * calibration. Later shrink cycles still provide the same fine resolution.
 */
const SEARCH_SCALES: Record<ThermalCoefficientField, number> = {
  heaterGainCPerMinAt10: 60,
  fanCoolingCPerMinAt10: 30,
  coolingFanCPerMinAt10: 30,
  thermalLossPerMinPerC: 0.2,
}

/**
 * The pooled objective. Each source is replayed independently - its own seed, its own ambient, its
 * own batch mass - and the squared errors are summed across all of them.
 */
export const pooledRms = (sources: FitSource[], calibration: CalibrationSettings): number | undefined => {
  let squared = 0
  let count = 0
  for (const source of sources) {
    const fit = replayThermalLog(source.samples, calibration, {
      ambientC: source.ambientC,
      batchMassG: source.massG ?? calibration.referenceBatchMassG,
      scoreFromSec: source.scoreFromSec,
    })
    if (!fit) continue
    squared += fit.rmsC * fit.rmsC * fit.samples
    count += fit.samples
  }
  return count === 0 ? undefined : Math.sqrt(squared / count)
}

export interface FitOptions {
  /** How many shrink cycles to allow. Each cycle is one sweep over every coefficient. */
  maximumSweeps?: number
  /** Initial step as a fraction of each coefficient's own value. */
  initialStepFraction?: number
  /** Stop once every step is below this fraction of its coefficient. */
  toleranceFraction?: number
  /** Tests and diagnostics may request the single deterministic search without production probes. */
  checkIdentifiability?: boolean
  /**
   * Coefficients held fixed at these values for the whole search.
   *
   * Baseline-measured airflow terms enter here so heater gain and bean loss are optimised
   * AGAINST the pinned values. Fitting all four freely and swapping the airflow terms in
   * afterwards is not equivalent: heat and airflow lie along one correlated valley, so the free
   * fit's heater gain compensates for its own airflow estimate, and a post-hoc swap produces a
   * combined set whose replay error was never measured.
   */
  frozen?: Partial<Record<ThermalCoefficientField, number>>
}

/** The finite entries of `frozen`, the only ones a search honours. */
const sanitizedFrozen = (options: FitOptions): Partial<Record<ThermalCoefficientField, number>> =>
  Object.fromEntries(Object.entries(options.frozen ?? {}).filter(([, value]) => Number.isFinite(value))) as Partial<
    Record<ThermalCoefficientField, number>
  >

interface SearchResult {
  coefficients: Record<ThermalCoefficientField, number>
  rmsC: number
  sweeps: number
}

const searchFromSeed = (
  usable: FitSource[],
  base: CalibrationSettings,
  seed: Partial<Record<ThermalCoefficientField, number>>,
  options: FitOptions,
): SearchResult => {
  const maximumSweeps = options.maximumSweeps ?? 200
  const toleranceFraction = options.toleranceFraction ?? 0.0004
  let stepFraction = options.initialStepFraction ?? 0.35
  const frozen = sanitizedFrozen(options)
  const sweepFields = FITTED_FIELDS.filter((field) => frozen[field] === undefined)
  const current = Object.fromEntries(
    FITTED_FIELDS.map((field) => [field, clampTo(field, frozen[field] ?? seed[field] ?? base[field])]),
  ) as Record<ThermalCoefficientField, number>
  const score = (candidate: Record<ThermalCoefficientField, number>) =>
    finiteScore(pooledRms(usable, { ...base, ...candidate }))
  let best = score(current)
  let sweeps = 0

  while (sweeps < maximumSweeps && stepFraction > toleranceFraction) {
    const before = { ...current }
    let improved = false
    for (const field of sweepFields) {
      const step = Math.max(Math.abs(current[field]), SEARCH_SCALES[field]) * stepFraction
      for (const direction of [1, -1]) {
        const candidate = { ...current, [field]: clampTo(field, current[field] + direction * step) }
        if (candidate[field] === current[field]) continue
        const value = score(candidate)
        if (value < best - 1e-9) {
          best = value
          current[field] = candidate[field]
          improved = true
        }
      }
    }
    if (improved) {
      const projected = Object.fromEntries(
        FITTED_FIELDS.map((field) => [
          field,
          sweepFields.includes(field)
            ? clampTo(field, current[field] + (current[field] - before[field]))
            : current[field],
        ]),
      ) as Record<ThermalCoefficientField, number>
      const value = score(projected)
      if (value < best - 1e-9) {
        best = value
        for (const field of sweepFields) current[field] = projected[field]
      }
    }
    sweeps += 1
    if (!improved) stepFraction /= 2
  }

  const coefficients = Object.fromEntries(
    FITTED_FIELDS.map((field) => [field, round(field, current[field])]),
  ) as Record<ThermalCoefficientField, number>
  return { coefficients, rmsC: score(coefficients), sweeps }
}

const materiallyWide = (field: ThermalCoefficientField, min: number, max: number) => {
  const middle = Math.max(Math.abs((min + max) / 2), COEFFICIENT_BOUNDS[field].min)
  const absolute = field === 'thermalLossPerMinPerC' ? 0.08 : field === 'heaterGainCPerMinAt10' ? 15 : 10
  return max - min > Math.max(absolute, middle * 0.5)
}

/** The probe itself is cooler and more trustworthy near the end of a recording than at boot. */
export const estimateAmbientC = (samples: ThermalSample[], fallbackC = 24.5): number => {
  const values = samples
    .slice(Math.floor(samples.length * 0.8))
    .flatMap((sample) => (Number.isFinite(sample.coldJunctionC) ? [sample.coldJunctionC!] : []))
  if (values.length > 0) return Math.min(...values)
  // A junction reading anywhere in the log still beats the constant: the junction never sits
  // below true ambient, so the coolest observation is the least-wrong evidence available.
  const coolest = samples.reduce<number | undefined>(
    (minimum, sample) =>
      Number.isFinite(sample.coldJunctionC) && (minimum === undefined || sample.coldJunctionC! < minimum)
        ? sample.coldJunctionC
        : minimum,
    undefined,
  )
  return coolest ?? fallbackC
}

export const fitCoefficientsFromLog = (
  sources: FitSource[],
  base: CalibrationSettings,
  options: FitOptions = {},
): CoefficientFit | undefined => {
  // A source must produce a scoreable replay: enough readable samples AND at least one compared
  // point after its turnaround exclusion. The compared count depends only on the samples and
  // `scoreFromSec`, never on coefficients, so one replay against the base settles it — without
  // this, a loaded roast shorter than the exclusion window scores every candidate at +Infinity
  // and sails through every stability gate.
  const usable = sources.filter(
    (source) =>
      source.samples.filter((sample) => sample.thermocoupleC !== undefined).length > 5 &&
      replayThermalLog(source.samples, base, {
        ambientC: source.ambientC,
        batchMassG: source.massG ?? base.referenceBatchMassG,
        scoreFromSec: source.scoreFromSec,
      }) !== undefined,
  )
  if (usable.length === 0) return undefined

  const startingRmsC = finiteScore(pooledRms(usable, base))
  const frozen = sanitizedFrozen(options)
  // Probe the most correlation-prone free coordinate. Fan cooling is the historic offender; once a
  // baseline freezes it, heater gain becomes the widest remaining axis of the heat/airflow valley.
  const probeField: ThermalCoefficientField =
    frozen.fanCoolingCPerMinAt10 === undefined ? 'fanCoolingCPerMinAt10' : 'heaterGainCPerMinAt10'
  const probeValues = probeField === 'fanCoolingCPerMinAt10' ? [0.5, 5, 35, 100] : [5, 30, 120, 400]
  const seeds =
    options.checkIdentifiability === false || frozen[probeField] !== undefined
      ? [{}]
      : [{}, ...probeValues.map((value) => ({ [probeField]: value }))]
  const searches = seeds.map((seed) => searchFromSeed(usable, base, seed, options))
  const selected = searches.reduce((best, candidate) => (candidate.rmsC < best.rmsC ? candidate : best))
  const coefficients = selected.coefficients
  // Never hand back a "fit" that is not a set of numbers the controller could apply.
  if (FITTED_FIELDS.some((field) => !Number.isFinite(coefficients[field]))) return undefined
  const nearBest = searches.filter((candidate) => candidate.rmsC <= selected.rmsC + Math.max(1, selected.rmsC * 0.4))
  const seedRange = Object.fromEntries(
    FITTED_FIELDS.map((field) => {
      const values = nearBest.map((candidate) => candidate.coefficients[field])
      return [field, { min: Math.min(...values), max: Math.max(...values) }]
    }),
  ) as CoefficientFit['seedRange']
  const unstable = FITTED_FIELDS.filter((field) => materiallyWide(field, seedRange[field].min, seedRange[field].max))
  const fitted = { ...base, ...coefficients }

  return {
    coefficients,
    rmsC: selected.rmsC,
    startingRmsC,
    perSource: usable.map((source) => ({
      id: source.id,
      label: source.label,
      fit: replayThermalLog(source.samples, fitted, {
        ambientC: source.ambientC,
        batchMassG: source.massG ?? base.referenceBatchMassG,
        scoreFromSec: source.scoreFromSec,
      }),
    })),
    sweeps: selected.sweeps,
    // A frozen coefficient sits wherever the baseline put it; only searched fields can report the
    // "search ran into a bound" signal.
    pinned: FITTED_FIELDS.filter(
      (field) =>
        frozen[field] === undefined &&
        (coefficients[field] <= COEFFICIENT_BOUNDS[field].min + 1e-6 ||
          coefficients[field] >= COEFFICIENT_BOUNDS[field].max - 1e-6),
    ),
    sources: usable.length,
    samples: usable.reduce((sum, source) => sum + source.samples.length, 0),
    excitation: logExcitation(usable.flatMap((source) => source.samples)),
    unstable,
    seedRange,
    frozen: FITTED_FIELDS.filter((field) => frozen[field] !== undefined),
  }
}

/**
 * The airflow terms an empty-chamber baseline directly measured, ready to hand to
 * `fitCoefficientsFromLog` as its `frozen` option. Empty-chamber evidence isolates airflow; the
 * loaded roast then fits heater gain and bean-side loss AGAINST those pinned values instead of
 * letting all four slide along one flat error valley. A field absent from the baseline remains the
 * loaded-roast fit's responsibility. `fitAgainstBaseline` decides which of these pins to use.
 */
export const baselinePinnedAirflow = (
  baseline: Partial<Record<ThermalCoefficientField, number>>,
): Partial<Record<ThermalCoefficientField, number>> => {
  const pinned: Partial<Record<ThermalCoefficientField, number>> = {}
  for (const field of ['fanCoolingCPerMinAt10', 'coolingFanCPerMinAt10'] as const) {
    const value = baseline[field]
    if (!Number.isFinite(value)) continue
    // The apply contract is the outer authority. A baseline measurement outside the plausible
    // range pins at the nearest applicable value, at apply precision, so the set the search
    // scored, the set the preview shows, and the set that is saved are all the same set — and
    // the recorded fit RMS was actually measured against it.
    pinned[field] = round(field, clampTo(field, value!))
  }
  return pinned
}

/**
 * Whether the loaded roasts themselves determined heating-mode airflow: the term was searched
 * rather than frozen, the logs vary Fan at a constant Heat, and the multi-start probe found one
 * answer rather than a valley.
 */
export const heatingAirflowResolved = (fit: CoefficientFit) =>
  !fit.frozen.includes('fanCoolingCPerMinAt10') &&
  fit.excitation.fanSweptAtConstantHeat &&
  !fit.unstable.includes('fanCoolingCPerMinAt10') &&
  !fit.pinned.includes('fanCoolingCPerMinAt10')

/**
 * The production fit: loaded roasts against an empty-chamber baseline.
 *
 * Heat-off airflow (`coolingFanCPerMinAt10`) is the same physics with or without beans, so a
 * baseline value is always pinned. Airflow WHILE HEATING is not: an empty chamber measures air
 * cooling bare metal, while in a roast the same airflow sets how fast heat moves through a bean
 * bed. Measured on one SR800, the empty chamber put Fan 10 at 2.9 °C/min of heating-mode cooling;
 * roasts that varied Fan at constant Heat put it at 13-15, and short-horizon prediction of their
 * hot zones at about 21. The Journey law inverts this term to choose Fan, so the chamber value made
 * every Fan move about five times stronger than modelled.
 *
 * So the loaded roasts fit heating-mode airflow whenever they resolve it (see
 * `heatingAirflowResolved`); the baseline's value is the fallback for roasts that never moved
 * Fan while heating or that leave it in a valley, which is the only case the baseline pin was
 * needed for. Without identifiability probing nothing can be called resolved, so both pins apply.
 */
export const fitAgainstBaseline = (
  sources: FitSource[],
  base: CalibrationSettings,
  baseline: Partial<Record<ThermalCoefficientField, number>>,
  options: FitOptions = {},
): CoefficientFit | undefined => {
  const pins = baselinePinnedAirflow(baseline)
  const { fanCoolingCPerMinAt10: chamberHeatingAirflow, ...heatOffPins } = pins
  if (chamberHeatingAirflow !== undefined && options.checkIdentifiability !== false) {
    const loadedAirflow = fitCoefficientsFromLog(sources, base, { ...options, frozen: heatOffPins })
    if (!loadedAirflow || heatingAirflowResolved(loadedAirflow)) return loadedAirflow
  }
  return fitCoefficientsFromLog(sources, base, { ...options, frozen: pins })
}

/**
 * Assembles the saved patch from both evidence kinds. When the fit was produced by
 * `fitAgainstBaseline` (the production path), the overwrite here is a no-op and the fit's
 * reported RMS describes exactly the set being saved. For a fit produced without pinning, baseline
 * airflow still outranks a free-fit guess, except heating-mode airflow the loaded roasts resolved.
 */
export const combineSegmentedCalibration = (
  fit: CoefficientFit | undefined,
  baseline: Partial<Record<ThermalCoefficientField, number>>,
): Partial<Record<ThermalCoefficientField, number>> => {
  if (!fit) return { ...baseline }
  const pins = baselinePinnedAirflow(baseline)
  if (heatingAirflowResolved(fit)) delete pins.fanCoolingCPerMinAt10
  return { ...fit.coefficients, ...pins }
}

export const unresolvedUnstableFields = (
  fit: CoefficientFit | undefined,
  baseline: Partial<Record<ThermalCoefficientField, number>>,
) =>
  fit?.unstable.filter(
    (field) =>
      !((field === 'fanCoolingCPerMinAt10' || field === 'coolingFanCPerMinAt10') && Number.isFinite(baseline[field])),
  ) ?? []

/** A stored pass is a loaded roast exactly when it recorded the batch it was roasted with. */
export const isLoadedRun = (run: CalibrationRun) => (run.massG ?? 0) > 0

export const fitSourceFromRun = (run: CalibrationRun, label: string): FitSource => ({
  id: run.id,
  label,
  samples: run.samples,
  massG: isLoadedRun(run) ? run.massG : undefined,
  ambientC: estimateAmbientC(run.samples, run.ambientC),
  scoreFromSec: isLoadedRun(run) ? 180 : undefined,
})
