import { effectiveLevels } from './actuatorFloors'
import { COEFFICIENT_LABELS } from './deviceLogs'
import type {
  CalibrationCurve,
  CalibrationCurvePoint,
  CalibrationRun,
  CalibrationStep,
  ThermalCoefficientField,
  ThermalCoefficientPatch,
  ThermalSample,
} from './types'

// GET /thermal.csv: t_ms,thermocouple_c,cold_junction_c,effective_fan,effective_heat at 1 Hz.
// Sensor columns are blank while the thermocouple is faulted, so a blank column stays undefined.
export const parseThermalCsv = (csv: string): ThermalSample[] => {
  const rows: ThermalSample[] = []
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /^t_?ms/i.test(trimmed)) continue
    const cells = trimmed.split(',').map((cell) => cell.trim())
    const cell = (index: number) =>
      cells[index] !== undefined && cells[index] !== '' && Number.isFinite(Number(cells[index]))
        ? Number(cells[index])
        : undefined
    const tMs = cell(0)
    if (tMs === undefined) continue
    rows.push({
      tMs,
      thermocoupleC: cell(1),
      coldJunctionC: cell(2),
      effectiveFan: cell(3) ?? 0,
      effectiveHeat: cell(4) ?? 0,
    })
  }
  return rows.sort((a, b) => a.tMs - b.tMs)
}

export const thermalCsvHeader = 't_ms,thermocouple_c,cold_junction_c,effective_fan,effective_heat'

export interface LinearFit {
  slope: number
  intercept: number
  r2: number
}

export const linearFit = (points: Array<{ x: number; y: number }>): LinearFit | undefined => {
  const usable = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (usable.length < 2) return undefined
  const n = usable.length
  const meanX = usable.reduce((sum, point) => sum + point.x, 0) / n
  const meanY = usable.reduce((sum, point) => sum + point.y, 0) / n
  const sxx = usable.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
  if (sxx <= 0) return undefined
  const sxy = usable.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0)
  const slope = sxy / sxx
  const intercept = meanY - slope * meanX
  const syy = usable.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0)
  const residual = usable.reduce((sum, point) => sum + (point.y - (slope * point.x + intercept)) ** 2, 0)
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return undefined
  return { slope, intercept, r2: syy <= 0 ? 1 : Math.max(0, Math.min(1, 1 - residual / syy)) }
}

// Steady state is the mean of the last quarter of a hold, where the first-order response has mostly settled.
export const steadyState = (values: number[]): number | undefined => {
  const usable = values.filter((value) => Number.isFinite(value))
  if (usable.length === 0) return undefined
  const tail = usable.slice(-Math.max(1, Math.ceil(usable.length * 0.25)))
  return tail.reduce((sum, value) => sum + value, 0) / tail.length
}

// T(t) = Tinf - (Tinf - T0) e^(-t/tau) linearizes to ln|Tinf - T(t)| = ln|Tinf - T0| - t/tau.
// Points within 5% of the asymptote are dropped: there the logarithm is dominated by sensor noise
// and by any error in the asymptote estimate itself, which would drag the slope steeply negative.
export const fitTau = (points: Array<{ tSec: number; gap: number }>, span: number): number | undefined => {
  const floor = Math.max(0.5, Math.abs(span) * 0.05)
  const usable = points.filter((point) => Number.isFinite(point.tSec) && point.gap > floor)
  if (usable.length < 3) return undefined
  const fit = linearFit(usable.map((point) => ({ x: point.tSec, y: Math.log(point.gap) })))
  if (!fit || fit.slope >= 0) return undefined
  const tau = -1 / fit.slope
  return Number.isFinite(tau) && tau > 0 ? tau : undefined
}

export const riseTau = (
  samples: Array<{ tSec: number; temperatureC: number }>,
  steadyStateC: number,
): number | undefined => {
  const first = samples[0]
  if (!first) return undefined
  const span = steadyStateC - first.temperatureC
  if (span <= 1) return undefined
  return fitTau(
    samples.map((sample) => ({ tSec: sample.tSec - first.tSec, gap: steadyStateC - sample.temperatureC })),
    span,
  )
}

export const decayTau = (
  samples: Array<{ tSec: number; temperatureC: number }>,
  asymptoteC: number,
): number | undefined => {
  const first = samples[0]
  if (!first) return undefined
  const span = first.temperatureC - asymptoteC
  if (span <= 1) return undefined
  return fitTau(
    samples.map((sample) => ({ tSec: sample.tSec - first.tSec, gap: sample.temperatureC - asymptoteC })),
    span,
  )
}

/**
 * A decay of this many samples is the least worth fitting. Below it the window is not a curve, it is
 * three points and a hope - and `fitTau` would in any case have thrown two of them away as being
 * within 5% of the asymptote.
 */
const MINIMUM_DECAY_SAMPLES = 5

/**
 * ============================================================================================
 * THE REBOUND AFTER THE FAN STOPS IS NOT DECAY, AND FITTING THROUGH IT BIASES TAU LONG
 * ============================================================================================
 *
 * When the fan stops, the chamber stops being stirred, and for roughly the first 30 seconds the
 * probe RISES: it had been sitting in moving air cooler than the mass around it, and that mass soaks
 * back into it. The firmware's own account of the tail is careful to call the clean decay the part
 * AFTER that - and then keeps the whole three minutes anyway, because closing the tail early on a
 * temperature test was withdrawn and the tail is now closed on the clock alone. Which is right: the
 * recording should hold everything that happened. It is the ANALYSIS that has to know what part of
 * it is a decay.
 *
 * Feeding the rebound to `decayTau` is not merely noisy, it is wrong in one direction. The fit
 * linearizes `ln(T - ambient)`, and during the rebound that quantity is GROWING - a positive slope
 * where the model has only negative ones. Least squares cannot reject it; it flattens the line to
 * accommodate it, and a flatter line is a LONGER tau. Tau is the thermal loss coefficient
 * (`60 / tau`), so the whole calibration inherits a chamber that sheds heat more slowly than it
 * does, and every heater and fan coefficient fitted against that loss inherits the error with it.
 *
 * So the decay starts at the peak. The maximum of the window is the honest place to start, and
 * finding it by plain argmax is safe rather than lucky: a fan-off tail is a curve falling from its
 * highest point, so late-tail sensor noise sits tens of degrees below anything in the soak and can
 * never win the maximum. The earliest sample wins a tie, so a flat top starts the fit at the top.
 *
 * THE EDGE CASES, ALL THREE OF THEM:
 *
 *   - **No rebound at all** - the tail is already falling at the first sample, so the maximum IS the
 *     first sample and nothing is trimmed. A pass that cut the fan while the chamber was already
 *     cooling behaves exactly as it did before this rule existed.
 *   - **It never turns over** - a monotonic rise for the whole window. That is a tail cut off
 *     mid-soak, or a probe that has come loose and is reading its own surroundings warming. There is
 *     no decay in it, so this reports NO fit rather than fitting the rise and calling the answer a
 *     time constant. Refusing to answer is recoverable; a plausible wrong tau is not, because it
 *     stages a coefficient that looks like every other one.
 *   - **It turns over too late** - fewer than `MINIMUM_DECAY_SAMPLES` after the peak. Same answer,
 *     same reason: what remains is not enough curve to identify anything.
 */
export const afterRebound = <T extends { temperatureC: number }>(samples: T[]): T[] | undefined => {
  if (samples.length === 0) return samples
  let peak = 0
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].temperatureC > samples[peak].temperatureC) peak = index
  }
  if (peak === 0) return samples
  return samples.length - peak >= MINIMUM_DECAY_SAMPLES ? samples.slice(peak) : undefined
}

export interface SteadyStateFit {
  steadyStateC: number
  tauSec: number
  r2: number
  // The search bracket is finite. A winner sitting on its upper edge means no interior optimum was
  // found, so the asymptote is not identified by this data - only bounded from below.
  railed: boolean
}

/**
 * Three-parameter fit for a step that never reached its plateau.
 *
 * When a step is cut short - by the operator's measurement ceiling or by the step cap - the mean of
 * its last samples is not the steady state, only a lower bound. Tss is therefore searched rather
 * than assumed: for each candidate asymptote the rise is log-linearized and scored by R2, which is
 * maximal at the true asymptote (too low leaves impossible negative gaps, too high leaves residual
 * curvature). A coarse scan brackets the peak and a golden-section search refines it, all by hand.
 */
export const fitSteadyState = (samples: Array<{ tSec: number; temperatureC: number }>): SteadyStateFit | undefined => {
  if (samples.length < 5) return undefined
  const first = samples[0]
  const last = samples[samples.length - 1]
  const peak = Math.max(...samples.map((sample) => sample.temperatureC))
  const rise = last.temperatureC - first.temperatureC
  if (rise <= 1) return undefined

  const score = (candidate: number) => {
    const points = samples.flatMap((sample) => {
      const gap = candidate - sample.temperatureC
      return gap > 1e-6 ? [{ x: sample.tSec - first.tSec, y: Math.log(gap) }] : []
    })
    if (points.length < 5) return undefined
    const fit = linearFit(points)
    return fit && fit.slope < 0 ? { r2: fit.r2, tauSec: -1 / fit.slope } : undefined
  }

  /**
   * The asymptote is above every observed sample and below some multiple of what the step has
   * already climbed. That multiple has to be generous: a step truncated at a fraction f of its rise
   * has its asymptote at roughly (1/f) times the observed climb, so the old 3x bracket could not
   * even contain the answer for anything cut off below a third. The first real baseline map was
   * truncated at about a fifth, which put every true asymptote outside the search entirely. 12x
   * covers truncation down to about 8%; beyond that the step is reported unreliable, which is the
   * honest answer. Railing against the bracket is reported rather than silently accepted.
   */
  let low = peak + Math.max(0.25, rise * 0.02)
  const ceiling = peak + rise * 12
  let high = ceiling
  let best: { candidate: number; r2: number; tauSec: number } | undefined
  const consider = (candidate: number) => {
    const scored = score(candidate)
    if (scored && Number.isFinite(scored.tauSec) && scored.tauSec > 0 && (!best || scored.r2 > best.r2))
      best = { candidate, ...scored }
  }
  const coarse = 48
  for (let index = 0; index <= coarse; index += 1) consider(low + (high - low) * (index / coarse))
  if (!best) return undefined
  // Refine inside the bracket around the coarse winner.
  const stride = (high - low) / coarse
  low = Math.max(low, best.candidate - stride)
  high = Math.min(high, best.candidate + stride)
  const phi = (Math.sqrt(5) - 1) / 2
  for (let iteration = 0; iteration < 60 && high - low > 1e-4; iteration += 1) {
    const a = high - (high - low) * phi
    const b = low + (high - low) * phi
    const scoreA = score(a)
    const scoreB = score(b)
    consider(a)
    consider(b)
    if ((scoreA?.r2 ?? -1) >= (scoreB?.r2 ?? -1)) high = b
    else low = a
  }
  return { steadyStateC: best.candidate, tauSec: best.tauSec, r2: best.r2, railed: best.candidate >= ceiling - stride }
}

/**
 * The same three-parameter fit in whichever direction the step is going.
 *
 * A serpentine walks heat DOWN as often as up, and a down-step truncated mid-transient overstates
 * its asymptote exactly as an up-step understates one. Reflecting the series about zero turns a
 * decay into a rise, so one searched, tested implementation covers both instead of two.
 */
export const fitAsymptote = (samples: Array<{ tSec: number; temperatureC: number }>): SteadyStateFit | undefined => {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last) return undefined
  const travel = last.temperatureC - first.temperatureC
  if (travel > 1) return fitSteadyState(samples)
  if (travel < -1) {
    const fit = fitSteadyState(samples.map((sample) => ({ tSec: sample.tSec, temperatureC: -sample.temperatureC })))
    return fit ? { ...fit, steadyStateC: -fit.steadyStateC } : undefined
  }
  return undefined
}

/** How far a step actually travelled toward its fitted asymptote: 1.0 is a genuine plateau. */
export const approachFraction = (
  samples: Array<{ tSec: number; temperatureC: number }>,
  steadyStateC: number,
): number | undefined => {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last) return undefined
  const span = steadyStateC - first.temperatureC
  if (Math.abs(span) < 1e-6) return undefined
  return (last.temperatureC - first.temperatureC) / span
}

/**
 * How much a reported steady state can be trusted.
 *
 * `measured` reached its plateau and is the mean of its own tail. `extrapolated` was cut short, so
 * its value comes from the curve fit and carries the fit R2. `unreliable` was cut short too, but
 * the fit could not identify an asymptote from what was logged - low R2, or a search that railed
 * against its bracket - so the number shown is only a lower bound and is marked as such rather than
 * being presented as a measurement.
 */
export type SteadyStateQuality = 'measured' | 'extrapolated' | 'unreliable'

// A step is treated as plateaued once it has closed this much of its fitted gap.
export const PLATEAU_FRACTION = 0.95
// Below this, the tail mean and the fit are saying the same thing and the distinction is noise.
export const FIT_AGREEMENT_C = 3
// A fit that explains less than this of the log-linearized rise identifies nothing usable.
export const MINIMUM_FIT_R2 = 0.9

export interface CalibrationStepAnalysis {
  index: number
  // The fan the step ACTUALLY ran at, floors included, which is where its point belongs on the mesh.
  fanLevel: number
  // The fan the program asked for. Differs only when nonzero input normalization lifted it.
  declaredFanLevel: number
  floored: boolean
  heatLevel: number
  recovery: boolean
  sampleCount: number
  startSec?: number
  durationSec?: number
  capped: boolean
  limited: boolean
  skipped: boolean
  startC?: number
  steadyStateC?: number
  quality: SteadyStateQuality
  extrapolated: boolean
  steadyStateR2?: number
  // What fraction of the fitted rise the step actually completed before it advanced.
  approach?: number
  riseOverAmbientC?: number
  tauSec?: number
}

export interface CalibrationGainFit extends LinearFit {
  fanLevel: number
  points: number
}

export interface CalibrationAnalysis {
  fanLevels: number[]
  ambientC?: number
  peakC?: number
  // Present only for passes captured while the firmware still had a program ceiling.
  limitC?: number
  limitedSteps: number
  skippedSteps: number
  steps: CalibrationStepAnalysis[]
  gains: CalibrationGainFit[]
  forced?: { tauSec?: number; fanLevel: number; ratePerMin: number; meanRiseC: number; seconds: number }
  passiveTauSec?: number
}

type ReadableSample = ThermalSample & { thermocoupleC: number }

const readable = (sample: ThermalSample): sample is ReadableSample => sample.thermocoupleC !== undefined

// Effective levels are echoes of commanded milli-values, so this only absorbs formatting jitter.
const LEVEL_EPSILON = 0.05
const sameLevel = (a: number, b: number) => Math.abs(a - b) <= LEVEL_EPSILON
const bucket = (value: number) => Math.round(value * 10) / 10

interface ActuatorSegment {
  fan: number
  heat: number
  samples: ReadableSample[]
}

/**
 * Adaptive settling means a step ends when temperature holds, not on a fixed clock, so step windows
 * cannot be derived from nominal timing any more. They are recovered from the log itself: a segment
 * is a maximal run of samples holding the same effective fan AND heat. Keying on both is what gives
 * a fan-only transition (same heat, new fan) its own settle and tau analysis.
 */
export const segmentByActuators = (samples: ReadableSample[]): ActuatorSegment[] => {
  const segments: ActuatorSegment[] = []
  for (const sample of samples) {
    const current = segments.at(-1)
    if (current && sameLevel(current.fan, sample.effectiveFan) && sameLevel(current.heat, sample.effectiveHeat))
      current.samples.push(sample)
    else segments.push({ fan: sample.effectiveFan, heat: sample.effectiveHeat, samples: [sample] })
  }
  return segments
}

/**
 * Declared steps are matched to observed segments in order, so a fan-qualification lead-in, a
 * single-sample transition, or a program cut short by the ceiling all fall out harmlessly.
 *
 * Matching remains on EFFECTIVE levels because the controller owns what actually ran. Captured
 * stock behavior permits public Fan 1 at full Heat; the only remaining lift is normalization of a
 * nonzero fan below public level 0.1.
 */
const matchDeclaredSteps = (declared: CalibrationStep[], segments: ActuatorSegment[]) => {
  const matched: Array<ActuatorSegment | undefined> = []
  let cursor = 0
  let lastUsed = -1
  for (const step of declared) {
    const expected = effectiveLevels(step)
    const found = segments.findIndex(
      (segment, index) =>
        index >= cursor &&
        segment.samples.length >= 2 &&
        sameLevel(segment.heat, step.heat) &&
        (sameLevel(segment.fan, expected.fan) || sameLevel(segment.fan, step.fan)),
    )
    matched.push(found === -1 ? undefined : segments[found])
    if (found !== -1) {
      cursor = found + 1
      lastUsed = found
    }
  }
  return { matched, tail: segments.slice(lastUsed + 1).flatMap((segment) => segment.samples) }
}

export const analyzeCalibrationRun = (run: CalibrationRun): CalibrationAnalysis => {
  const samples = run.samples.filter(readable)
  const ambientC = run.ambientC ?? run.samples.find((sample) => sample.coldJunctionC !== undefined)?.coldJunctionC
  const { matched, tail } = matchDeclaredSteps(run.steps, segmentByActuators(samples))

  // Firmware 2026-07-26.34 and later have no program ceiling, so their passes cannot be
  // ceiling-limited. Passes captured on earlier firmware recorded their ceiling and margin, and those
  // reconstruct with them; a pass without them can never be marked limited or skipped.
  const limitC =
    run.ceilingC !== undefined && run.advanceMarginC !== undefined ? run.ceilingC - run.advanceMarginC : undefined
  let limitedFan: number | undefined
  const steps = run.steps.map((step, index): CalibrationStepAnalysis => {
    const window = matched[index]?.samples ?? []
    const fitted = window.map((sample) => ({ tSec: sample.tMs / 1000, temperatureC: sample.thermocoupleC }))
    const durationSec = window.length >= 2 ? (window[window.length - 1].tMs - window[0].tMs) / 1000 : undefined
    const capped = durationSec !== undefined && durationSec >= run.maxStepSeconds - 1.5
    const limited = limitC !== undefined && step.heat > 0 && window.some((sample) => sample.thermocoupleC >= limitC)
    const skipped = window.length === 0 && limitedFan !== undefined && sameLevel(limitedFan, step.fan)
    limitedFan = limited ? step.fan : window.length > 0 ? undefined : limitedFan

    const observed = steadyState(window.map((sample) => sample.thermocoupleC))
    /**
     * The fit runs on EVERY driven step, not only on ones the firmware flagged as cut short.
     *
     * The first real baseline map is why. A loose settle band passed on the mid-transient slope of
     * each large transition, so every step reported `settled` after about 13 seconds and the tail
     * mean was read as a plateau it had nowhere near reached. The result was a fan row that fell
     * with heat - 138, 131, 115 - and taus of 3 to 5 seconds. The `settled` flag simply is not
     * evidence of a plateau, so nothing here depends on it any more: the fit decides, and where the
     * fit and the tail mean agree the step really did settle.
     */
    const projected = step.heat > 0 ? fitAsymptote(fitted) : undefined
    const approach = projected ? approachFraction(fitted, projected.steadyStateC) : undefined
    // Truncated means the step was still visibly travelling AND the two estimates disagree beyond
    // the point where the distinction is noise.
    const truncated =
      projected !== undefined &&
      observed !== undefined &&
      approach !== undefined &&
      approach < PLATEAU_FRACTION &&
      Math.abs(projected.steadyStateC - observed) > FIT_AGREEMENT_C
    const identified = projected !== undefined && projected.r2 >= MINIMUM_FIT_R2 && !projected.railed
    const quality: SteadyStateQuality = !truncated ? 'measured' : identified ? 'extrapolated' : 'unreliable'
    const useProjection = quality === 'extrapolated'
    // An unreliable step keeps its tail mean as the only number available, flagged as a lower bound.
    const steadyStateC = useProjection ? projected!.steadyStateC : observed
    // The serpentine walks heat down as well as up, so a step may be settling downward. Both
    // directions are first-order and both carry a usable time constant.
    const falling = steadyStateC !== undefined && window[0] !== undefined && steadyStateC < window[0].thermocoupleC
    const tauSec = useProjection
      ? projected!.tauSec
      : // A tau fitted against an asymptote that is not the asymptote is the 3-second nonsense the
        // first map produced, so an unreliable step reports no time constant at all.
        quality === 'unreliable' || steadyStateC === undefined
        ? undefined
        : falling
          ? decayTau(fitted, steadyStateC)
          : riseTau(fitted, steadyStateC)

    const ran = matched[index]
    return {
      index,
      // The point belongs where it actually ran. A floored step reported at its declared fan is a
      // point on a curve that was never measured.
      fanLevel: ran ? bucket(ran.fan) : bucket(effectiveLevels(step).fan || step.fan),
      declaredFanLevel: step.fan,
      floored: !sameLevel(effectiveLevels(step).fan || step.fan, step.fan),
      heatLevel: step.heat,
      // Heat 0 is a recovery or passive-decay step: it is falling, not holding at a driven level.
      recovery: step.heat <= 0,
      sampleCount: window.length,
      startSec: window[0] ? window[0].tMs / 1000 : undefined,
      durationSec,
      capped,
      limited,
      skipped,
      startC: window[0]?.thermocoupleC,
      steadyStateC,
      quality,
      extrapolated: useProjection,
      steadyStateR2: projected?.r2,
      approach,
      riseOverAmbientC: steadyStateC !== undefined && ambientC !== undefined ? steadyStateC - ambientC : undefined,
      tauSec,
    }
  })

  // A run may sweep fan as well as heat, and the two are not interchangeable, so the heating gain is
  // fitted within each fan level rather than across a mixed cloud that no single line describes.
  const holds = steps.filter((step) => !step.recovery && step.riseOverAmbientC !== undefined)
  const gains = [...new Set(holds.map((step) => bucket(step.fanLevel)))]
    .sort((a, b) => a - b)
    .flatMap((fanLevel) => {
      const points = holds
        .filter((step) => bucket(step.fanLevel) === fanLevel)
        .map((step) => ({ x: step.heatLevel, y: step.riseOverAmbientC! }))
      const fit = points.length >= 2 ? linearFit(points) : undefined
      return fit ? [{ fanLevel, ...fit, points: points.length }] : []
    })

  /*
   * The tail is forced cooling while the fan still runs, then free passive decay once it stops.
   *
   * Only the passive half is trimmed. `afterRebound` describes why: the soak is what happens when
   * the stirring STOPS, and the forced half is the half with the fan on, where the probe falls from
   * the first sample and there is nothing to skip. Trimming it there would find no peak to trim
   * anyway, but it would also quietly re-anchor a window whose whole purpose is to measure a rate
   * over its own full length.
   */
  const fanStops = tail.findIndex((sample) => sample.effectiveFan <= 0)
  const forcedTail = tail.slice(0, fanStops === -1 ? tail.length : fanStops)
  const passiveDecay = afterRebound(
    tail.slice(forcedTail.length).map((sample) => ({ tSec: sample.tMs / 1000, temperatureC: sample.thermocoupleC })),
  )

  const forcedSeconds = forcedTail.length >= 2 ? (forcedTail[forcedTail.length - 1].tMs - forcedTail[0].tMs) / 1000 : 0
  const forced =
    forcedTail.length >= 2 && forcedSeconds > 0 && ambientC !== undefined
      ? {
          fanLevel: forcedTail.reduce((sum, sample) => sum + sample.effectiveFan, 0) / forcedTail.length,
          ratePerMin:
            ((forcedTail[0].thermocoupleC - forcedTail[forcedTail.length - 1].thermocoupleC) / forcedSeconds) * 60,
          meanRiseC: forcedTail.reduce((sum, sample) => sum + sample.thermocoupleC, 0) / forcedTail.length - ambientC,
          seconds: forcedSeconds,
          tauSec: decayTau(
            forcedTail.map((sample) => ({ tSec: sample.tMs / 1000, temperatureC: sample.thermocoupleC })),
            ambientC,
          ),
        }
      : undefined

  return {
    fanLevels: [...new Set(run.steps.map((step) => bucket(step.fan)))].sort((a, b) => a - b),
    ambientC,
    peakC: samples.length > 0 ? Math.max(...samples.map((sample) => sample.thermocoupleC)) : undefined,
    limitC,
    limitedSteps: steps.filter((step) => step.limited).length,
    skippedSteps: steps.filter((step) => step.skipped).length,
    steps,
    gains,
    forced,
    passiveTauSec: ambientC === undefined || passiveDecay === undefined ? undefined : decayTau(passiveDecay, ambientC),
  }
}

// The best-supported fan group anchors the staged heating gain; ties break toward the lower fan.
export const primaryGain = (analysis: CalibrationAnalysis): CalibrationGainFit | undefined =>
  [...analysis.gains].sort((a, b) => b.points - a.points || a.fanLevel - b.fanLevel)[0]

export type StagedField =
  | 'heaterGainCPerMinAt10'
  | 'fanCoolingCPerMinAt10'
  | 'coolingFanCPerMinAt10'
  | 'thermalLossPerMinPerC'

export interface StagingEntry {
  key: string
  label: string
  value?: number
  unit: string
  basis: string
  field?: StagedField
}

export interface CalibrationStaging {
  entries: StagingEntry[]
  patch: Partial<Record<StagedField, number>>
}

const round = (value: number, places: number) => Number(value.toFixed(places))

interface Hold {
  fan: number
  heat: number
  rise: number
}

const holdsOf = (analysis: CalibrationAnalysis): Hold[] =>
  analysis.steps.flatMap((step) =>
    !step.recovery && step.riseOverAmbientC !== undefined
      ? [{ fan: step.fanLevel, heat: step.heatLevel, rise: step.riseOverAmbientC }]
      : [],
  )

/**
 * Every pair of holds at the same heat but different fan isolates the airflow term: the heating and
 * loss contributions are identical, so the difference in steady rise is entirely airflow. Pairs can
 * now come from one multi-fan run as well as from two single-fan runs compared against each other.
 */
const fanCoolingCandidates = (loss: number, holds: Hold[]) => {
  const values: number[] = []
  for (let a = 0; a < holds.length; a += 1) {
    for (let b = a + 1; b < holds.length; b += 1) {
      const [low, high] = holds[a].fan < holds[b].fan ? [holds[a], holds[b]] : [holds[b], holds[a]]
      if (Math.abs(low.heat - high.heat) > 0.05 || high.fan - low.fan < 0.1) continue
      const value = (10 * loss * (low.rise - high.rise)) / (high.fan - low.fan)
      if (Number.isFinite(value) && value > 0) values.push(value)
    }
  }
  return values
}

/**
 * Maps measured staircase behavior onto Crackle's thermal-model coefficients.
 *
 * The passive-decay tail is the anchor: with no fan and no heat, dT/dt = -(T - ambient)/tau, so
 * thermalLossPerMinPerC = 60/tau. Everything else is expressed against that loss through the model's
 * own steady-state balance, heating - airflow - loss*dT = 0. Differentiating in heat gives
 * heaterGainCPerMinAt10 = 10 * (dTss/dHeat) * loss. Subtracting two runs at different fan levels but
 * the same heat isolates the airflow term. Anything that needs an input this run does not contain is
 * reported as informational and never staged.
 */
export const stageCalibration = (
  analysis: CalibrationAnalysis,
  comparison?: CalibrationAnalysis,
): CalibrationStaging => {
  const entries: StagingEntry[] = []
  const patch: Partial<Record<StagedField, number>> = {}
  const stage = (field: StagedField, key: string, label: string, value: number, unit: string, basis: string) => {
    if (!Number.isFinite(value) || value <= 0) return
    patch[field] = value
    entries.push({ key, label, value, unit, basis, field })
  }

  const loss = analysis.passiveTauSec ? round(60 / analysis.passiveTauSec, 4) : undefined
  if (loss !== undefined)
    stage(
      'thermalLossPerMinPerC',
      'loss',
      'Thermal loss',
      loss,
      '°C/min/°C',
      `60 / passive decay tau ${analysis.passiveTauSec!.toFixed(0)} s`,
    )
  else
    entries.push({
      key: 'loss',
      label: 'Thermal loss',
      unit: '°C/min/°C',
      basis: 'No fan-off passive decay tail was captured, so no loss coefficient is derivable',
    })

  const gain = primaryGain(analysis)
  if (gain) {
    const scope = analysis.gains.length > 1 ? `, chosen from ${analysis.gains.length} fan groups` : ''
    entries.push({
      key: 'gain-slope',
      label: 'Steady rise per heat unit',
      value: round(gain.slope, 2),
      unit: 'C over ambient per heat unit',
      basis: `Linear fit over ${gain.points} heat steps at fan ${gain.fanLevel.toFixed(1)}, R2 ${gain.r2.toFixed(3)}${scope}`,
    })
    if (loss !== undefined)
      stage(
        'heaterGainCPerMinAt10',
        'heat-gain',
        COEFFICIENT_LABELS.heaterGainCPerMinAt10,
        round(10 * gain.slope * loss, 2),
        '°C/min',
        `10 x rise-per-heat-unit x thermal loss at fan ${gain.fanLevel.toFixed(1)} (R2 ${gain.r2.toFixed(3)})`,
      )
  } else {
    entries.push({
      key: 'gain-slope',
      label: 'Steady rise per heat unit',
      unit: 'C over ambient per heat unit',
      basis: 'No fan level held two or more heat steps to a steady state, so no gain fit is available',
    })
  }

  if (analysis.forced && loss !== undefined && analysis.forced.fanLevel > 0) {
    const airflow = analysis.forced.ratePerMin - loss * analysis.forced.meanRiseC
    stage(
      'coolingFanCPerMinAt10',
      'cooling-fan',
      COEFFICIENT_LABELS.coolingFanCPerMinAt10,
      round((airflow * 10) / analysis.forced.fanLevel, 2),
      '°C/min',
      `Forced cooling tail: ${analysis.forced.ratePerMin.toFixed(1)} °C/min at fan ${analysis.forced.fanLevel.toFixed(1)} over ${analysis.forced.seconds.toFixed(0)} s, less passive loss`,
    )
  } else {
    entries.push({
      key: 'cooling-fan',
      label: COEFFICIENT_LABELS.coolingFanCPerMinAt10,
      unit: '°C/min',
      basis: 'Needs a forced cooling tail and a derivable thermal loss',
    })
  }

  const holds = [...holdsOf(analysis), ...(comparison ? holdsOf(comparison) : [])]
  const candidates = loss === undefined ? [] : fanCoolingCandidates(loss, holds)
  if (candidates.length > 0) {
    const mean = candidates.reduce((sum, value) => sum + value, 0) / candidates.length
    const source = comparison ? 'this run and its comparison' : 'this run'
    stage(
      'fanCoolingCPerMinAt10',
      'fan-cooling',
      COEFFICIENT_LABELS.fanCoolingCPerMinAt10,
      round(mean, 2),
      '°C/min',
      `${candidates.length} same-heat pair${candidates.length === 1 ? '' : 's'} at different fan levels across ${source}`,
    )
  } else {
    entries.push({
      key: 'fan-cooling',
      label: COEFFICIENT_LABELS.fanCoolingCPerMinAt10,
      unit: '°C/min',
      basis:
        'Needs two holds at the same heat and different fan levels, in this run or a comparison run, plus a derivable thermal loss',
    })
  }

  return { entries, patch }
}

/**
 * The mesh. A calibration pass is primarily a picture: what the chamber settles to at each fan and
 * heat, and how fast it gets there. One curve per fan level, points ascending in heat.
 */
export const curveFamily = (analysis: CalibrationAnalysis): CalibrationCurve[] => {
  const holds = analysis.steps.filter((step) => !step.recovery && step.steadyStateC !== undefined)
  return [...new Set(holds.map((step) => bucket(step.fanLevel)))]
    .sort((a, b) => b - a)
    .map((fanLevel) => ({
      fanLevel,
      points: holds
        .filter((step) => bucket(step.fanLevel) === fanLevel)
        .map(
          (step): CalibrationCurvePoint => ({
            heat: step.heatLevel,
            steadyStateC: step.steadyStateC!,
            riseOverAmbientC: step.riseOverAmbientC,
            tauSec: step.tauSec,
            quality: step.quality,
            floored: step.floored,
            extrapolated: step.extrapolated,
            r2: step.steadyStateR2,
          }),
        )
        .sort((a, b) => a.heat - b.heat),
    }))
}

export const curvePoints = (curves: CalibrationCurve[]) =>
  curves.flatMap((curve) => curve.points.map((point) => ({ fan: curve.fanLevel, ...point })))

// More heat cannot make an empty chamber cooler. Anything past this is measurement, not physics.
export const SUSPECT_DROP_C = 2

/**
 * Physics says steady state rises monotonically with heat at a fixed fan. A row that falls is not a
 * reading, it is evidence that the steps never settled - which is what a map captured with a loose
 * settle band produces when the analysis trusts the `settled` flag. Flagging the row is what stops
 * a garbage curve from being read as authoritative, and from being staged.
 */
export const suspectFanLevels = (curves: CalibrationCurve[]): number[] =>
  curves.flatMap((curve) => {
    const ordered = [...curve.points].sort((a, b) => a.heat - b.heat)
    const falls = ordered.some(
      (point, index) => index > 0 && ordered[index - 1].steadyStateC - point.steadyStateC > SUSPECT_DROP_C,
    )
    return falls ? [curve.fanLevel] : []
  })

/**
 * Rebuilds `/thermal.csv` from a stored pass. The baseline is self-contained in the browser, so the
 * CSV is an export rather than a transport: this works for any stored pass at any time, including
 * passes imported from a file and passes whose controller has long since restarted its log.
 */
export const thermalSamplesToCsv = (samples: ThermalSample[]): string =>
  [
    thermalCsvHeader,
    ...samples.map((sample) =>
      [
        sample.tMs,
        sample.thermocoupleC ?? '',
        sample.coldJunctionC ?? '',
        sample.effectiveFan,
        sample.effectiveHeat,
      ].join(','),
    ),
  ].join('\n')

export const runToCsv = (run: CalibrationRun): string => thermalSamplesToCsv(run.samples)

/* --------------------------------------------------------------- one recording, stored once only */

/**
 * What makes two stored recordings THE SAME RECORDING.
 *
 * Importing the same stored recording from the roaster repeatedly must not fill the library with
 * copies of one report. The import path refuses to do that (see `sourceLogId`), but a library that
 * already holds copies cannot be cleaned by anything that arrives later - so they are collapsed on
 * the way in instead.
 *
 * The roaster's own log id is the key whenever a recording carries one, because it is an identity
 * the roaster assigned. Everything else is identified by what it CONTAINS: the samples themselves.
 * Two imports of one recording differ in id and in `capturedAt` - which is when the copy was made,
 * not when the roaster recorded it - and agree in every sample, so the content is the only thing
 * that can recognise them. First and last sample plus the count is enough: a second recording that
 * started at the same millisecond, ended at the same millisecond, at the same two temperatures, with
 * the same number of samples in between, is not a different run of the machine.
 */
export const recordingFingerprint = (run: CalibrationRun): string => {
  if (run.sourceLogId) return `log:${run.sourceLogId}`
  const first = run.samples[0]
  const last = run.samples[run.samples.length - 1]
  const edge = (sample: ThermalSample | undefined) =>
    sample ? `${sample.tMs}/${sample.thermocoupleC ?? ''}/${sample.effectiveFan}/${sample.effectiveHeat}` : '-'
  return `body:${run.samples.length}:${edge(first)}:${edge(last)}`
}

/**
 * The same recordings with the duplicates dropped, oldest copy kept.
 *
 * The oldest copy wins because it is the one anything else may already point at: a saved calibration
 * names its `runIds`, and dropping the copy a calibration was derived from would strand it. A
 * recording that has since been CLASSIFIED beats an unclassified copy of itself, because that
 * classification is work the user did.
 */
export const dedupeRecordings = (runs: CalibrationRun[]): CalibrationRun[] => {
  const survivor = new Map<string, string>()
  const classification = new Map<string, CalibrationRun>()
  for (const run of [...runs].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
    const key = recordingFingerprint(run)
    if (!survivor.has(key)) survivor.set(key, run.id)
    if (run.roastRunId !== undefined || run.massG !== undefined) classification.set(key, run)
  }
  const keep = new Set(survivor.values())
  return runs
    .filter((run) => keep.has(run.id))
    .map((run) => {
      const named = classification.get(recordingFingerprint(run))
      return !named || named.id === run.id
        ? run
        : { ...run, roastRunId: named.roastRunId, massG: named.massG, densityGPerMl: named.densityGPerMl }
    })
}

export const meshKey = (fan: number, heat: number) => `${bucket(fan)}:${bucket(heat)}`

export interface BaselineCell extends CalibrationCurvePoint {
  fan: number
  runId: string
  capturedAt: string
}

export interface BaselineMap {
  fans: number[]
  heats: number[]
  cells: Record<string, BaselineCell>
  runCount: number
  extrapolatedCount: number
  unreliableCount: number
  flooredCount: number
  // Fan rows whose steady state falls with heat: physically impossible, so the row is not a reading.
  suspectFans: number[]
}

// Best first: a plateau beats a fit, and a fit beats a number nothing could identify.
const QUALITY_RANK: Record<string, number> = { measured: 0, extrapolated: 1, unreliable: 2 }
const rankOf = (point: { quality?: string; extrapolated: boolean }) =>
  QUALITY_RANK[point.quality ?? (point.extrapolated ? 'extrapolated' : 'measured')] ?? 1

/**
 * Aggregates every stored pass into one fan x heat grid. The better-quality reading always beats a
 * weaker one for the same point; between two of equal quality the newer capture wins, so a repeat
 * pass supersedes an older one without deleting it.
 */
export const buildBaselineMap = (runs: CalibrationRun[]): BaselineMap => {
  const cells: Record<string, BaselineCell> = {}
  const contributing = new Set<string>()
  for (const run of runs) {
    for (const point of curvePoints(curveFamily(analyzeCalibrationRun(run)))) {
      const key = meshKey(point.fan, point.heat)
      const candidate: BaselineCell = { ...point, runId: run.id, capturedAt: run.capturedAt }
      const held = cells[key]
      const better =
        !held ||
        rankOf(candidate) < rankOf(held) ||
        (rankOf(candidate) === rankOf(held) && candidate.capturedAt > held.capturedAt)
      if (better) cells[key] = candidate
    }
    contributing.add(run.id)
  }
  const values = Object.values(cells)
  const fans = [...new Set(values.map((cell) => bucket(cell.fan)))].sort((a, b) => b - a)
  return {
    fans,
    heats: [...new Set(values.map((cell) => bucket(cell.heat)))].sort((a, b) => a - b),
    cells,
    runCount: contributing.size,
    extrapolatedCount: values.filter((cell) => cell.extrapolated).length,
    unreliableCount: values.filter((cell) => cell.quality === 'unreliable').length,
    flooredCount: values.filter((cell) => cell.floored).length,
    suspectFans: suspectFanLevels(
      fans.map((fanLevel) => ({
        fanLevel,
        points: values.filter((cell) => bucket(cell.fan) === fanLevel),
      })),
    ),
  }
}

/**
 * The pooled surface written back out as curves, which is the form a saved calibration stores.
 *
 * `curveFamily` answers "what did THIS pass find" and takes one analysis. A calibration built from
 * several ticked passes has to store what the POOL found, and the pool is exactly the baseline map -
 * one cell per fan and heat, best reading wins. So the map is the single place the merge happens and
 * this is only a change of shape, never a second merge that could disagree with the first.
 */
/** Rehydrates the saved settled surface when source recordings have been pruned or compacted. */
export const baselineMapFromCurves = (
  curves: CalibrationCurve[],
  source: { runId: string; capturedAt: string; runCount?: number },
): BaselineMap => {
  const cells: Record<string, BaselineCell> = {}
  for (const point of curvePoints(curves)) {
    cells[meshKey(point.fan, point.heat)] = { ...point, runId: source.runId, capturedAt: source.capturedAt }
  }
  const values = Object.values(cells)
  const fans = [...new Set(values.map((cell) => bucket(cell.fan)))].sort((a, b) => b - a)
  return {
    fans,
    heats: [...new Set(values.map((cell) => bucket(cell.heat)))].sort((a, b) => a - b),
    cells,
    runCount: source.runCount ?? (values.length > 0 ? 1 : 0),
    extrapolatedCount: values.filter((cell) => cell.extrapolated).length,
    unreliableCount: values.filter((cell) => cell.quality === 'unreliable').length,
    flooredCount: values.filter((cell) => cell.floored).length,
    suspectFans: suspectFanLevels(
      fans.map((fanLevel) => ({
        fanLevel,
        points: values.filter((cell) => bucket(cell.fan) === fanLevel),
      })),
    ),
  }
}

export const curvesFromBaselineMap = (map: BaselineMap): CalibrationCurve[] =>
  map.fans.flatMap((fanLevel) => {
    const points = map.heats.flatMap((heat) => {
      const cell = map.cells[meshKey(fanLevel, heat)]
      return cell
        ? [
            {
              heat: cell.heat,
              steadyStateC: cell.steadyStateC,
              riseOverAmbientC: cell.riseOverAmbientC,
              tauSec: cell.tauSec,
              quality: cell.quality,
              floored: cell.floored,
              extrapolated: cell.extrapolated,
              r2: cell.r2,
            },
          ]
        : []
    })
    return points.length > 0 ? [{ fanLevel, points }] : []
  })

export interface PassDeltaPoint {
  fan: number
  heat: number
  currentC: number
  previousC: number
  deltaC: number
  currentTauSec?: number
  previousTauSec?: number
  deltaTauSec?: number
  extrapolated: boolean
}

export interface PassDelta {
  points: PassDeltaPoint[]
  meanDeltaC?: number
  meanAbsDeltaC?: number
  maxAbsDeltaC?: number
  worst?: PassDeltaPoint
  meanAbsDeltaTauSec?: number
  onlyCurrent: number
  onlyPrevious: number
}

/**
 * Pass-to-pass drift. `deltaC` is current minus previous, so a positive delta means this pass runs
 * HOTTER at that point than the earlier one. Two passes run back to back should produce deltas near
 * zero, which is the repeatability proof; passes months apart make the drift itself the reading.
 */
export const comparePasses = (current: CalibrationCurve[], previous: CalibrationCurve[]): PassDelta => {
  const here = new Map(curvePoints(current).map((point) => [meshKey(point.fan, point.heat), point]))
  const there = new Map(curvePoints(previous).map((point) => [meshKey(point.fan, point.heat), point]))
  const points: PassDeltaPoint[] = []
  for (const [key, mine] of here) {
    const theirs = there.get(key)
    if (!theirs) continue
    points.push({
      fan: mine.fan,
      heat: mine.heat,
      currentC: mine.steadyStateC,
      previousC: theirs.steadyStateC,
      deltaC: mine.steadyStateC - theirs.steadyStateC,
      currentTauSec: mine.tauSec,
      previousTauSec: theirs.tauSec,
      deltaTauSec: mine.tauSec !== undefined && theirs.tauSec !== undefined ? mine.tauSec - theirs.tauSec : undefined,
      // A delta involving an extrapolated endpoint carries the extrapolation's uncertainty.
      extrapolated: mine.extrapolated || theirs.extrapolated,
    })
  }
  points.sort((a, b) => b.fan - a.fan || a.heat - b.heat)
  const absolute = points.map((point) => Math.abs(point.deltaC))
  const taus = points.flatMap((point) => (point.deltaTauSec === undefined ? [] : [Math.abs(point.deltaTauSec)]))
  const mean = (values: number[]) =>
    values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    points,
    meanDeltaC: mean(points.map((point) => point.deltaC)),
    meanAbsDeltaC: mean(absolute),
    maxAbsDeltaC: absolute.length === 0 ? undefined : Math.max(...absolute),
    worst:
      points.length === 0
        ? undefined
        : points.reduce((worst, point) => (Math.abs(point.deltaC) > Math.abs(worst.deltaC) ? point : worst)),
    meanAbsDeltaTauSec: mean(taus),
    onlyCurrent: [...here.keys()].filter((key) => !there.has(key)).length,
    onlyPrevious: [...there.keys()].filter((key) => !here.has(key)).length,
  }
}

/**
 * A patch is "applied" when every coefficient it names matches the live settings. The tolerance is
 * relative, because these coefficients span three orders of magnitude: an absolute epsilon that
 * suits a heat gain near 39 would call two thermal-loss values 0.018 and 0.020 identical.
 */
export const patchMatches = (patch: ThermalCoefficientPatch, settings: Record<string, number | string | undefined>) => {
  const fields = Object.keys(patch) as ThermalCoefficientField[]
  if (fields.length === 0) return false
  return fields.every((field) => {
    const applied = settings[field]
    const expected = patch[field]
    if (typeof applied !== 'number' || expected === undefined) return false
    return Math.abs(applied - expected) <= Math.max(1e-4, Math.abs(expected) * 0.001)
  })
}
