import {
  analyzeCalibrationRun,
  type BaselineMap,
  type CalibrationAnalysis,
  curveFamily,
  meshKey,
  type SteadyStateQuality,
  suspectFanLevels,
} from './thermalLog'
import type { CalibrationRun } from './types'

/**
 * The three things a calibrated roaster has to be able to answer, expressed against one physical
 * model rather than three separate tables of numbers.
 *
 * The chamber is first order. From any starting temperature, at a fixed fan and heat,
 *
 *     T(t) = T_settled(fan, heat) + (T_start - T_settled) * e^(-t/tau)
 *
 * so the settled surface answers "what will it sit at", and tau - which is dominated by airflow,
 * because airflow is what moves the heat - answers "how long until it gets there", in BOTH
 * directions. Heating up and cooling down are the same equation with the sign of (T_start -
 * T_settled) reversed; there is no second model for cooling and there should not be one.
 *
 * Rearranged for the question actually asked - how long from here to within epsilon of there -
 *
 *     t = tau * ln(|T_start - T_settled| / epsilon)
 *
 * Nothing in this module smooths a measurement into a curve. Every tau is one fitted step, kept
 * with the fan and heat it was measured at, its direction, and its R2; a fan level nobody measured
 * produces a BORROWED tau that says so, not an interpolated one that does not.
 */

/**
 * How close to settled counts as settled. Two degrees is the smallest band the settle detector is
 * ever run at, so claiming to resolve a transition finer than that would be claiming more than the
 * measurement can support.
 */
export const DEFAULT_TRANSITION_TOLERANCE_C = 2

/** Levels are echoes of commanded milli-values, so this only absorbs formatting jitter. */
const SAME_LEVEL = 0.05
const bucket = (value: number) => Math.round(value * 10) / 10

export type StepDirection = 'rising' | 'falling'

/**
 * Where a tau came from. A driven step and a cooling tail are both first-order fits, but they are
 * not the same evidence: a step is fitted against its own searched asymptote and carries the R2 of
 * that search, while a tail is fitted against ambient and carries no R2 at all.
 */
export type TauKind = 'step' | 'cooling-tail' | 'passive-tail'

export interface TauObservation {
  runId: string
  capturedAt: string
  stepIndex: number
  fan: number
  heat: number
  tauSec: number
  /** Only a searched three-parameter step fit produces one. A tail fit does not. */
  r2?: number
  direction: StepDirection
  quality: SteadyStateQuality
  kind: TauKind
  /** One phrase naming the measured step this number is, for the calculator to quote. */
  source: string
}

const stepObservations = (analysis: CalibrationAnalysis, runId: string, capturedAt: string): TauObservation[] =>
  analysis.steps.flatMap((step) => {
    if (step.recovery || step.tauSec === undefined || step.startC === undefined || step.steadyStateC === undefined)
      return []
    const direction: StepDirection = step.steadyStateC >= step.startC ? 'rising' : 'falling'
    return [
      {
        runId,
        capturedAt,
        stepIndex: step.index,
        fan: bucket(step.fanLevel),
        heat: bucket(step.heatLevel),
        tauSec: step.tauSec,
        r2: step.steadyStateR2,
        direction,
        quality: step.quality,
        kind: 'step' as const,
        source: `step ${step.index + 1}, fan ${step.fanLevel.toFixed(1)} heat ${step.heatLevel.toFixed(1)}, ${direction}`,
      },
    ]
  })

/**
 * Every tau one pass measured, including its two tails.
 *
 * The tails matter as much as the steps: forced cooling at high fan is the fastest transition the
 * machine can make, and fan-off passive decay is the slowest, so between them they bracket the
 * whole cool-down question. They are marked as tails rather than being quietly
 * mixed in with the driven steps, because they carry no R2 and were fitted against ambient.
 */
export const tauObservationsFrom = (
  analysis: CalibrationAnalysis,
  runId: string,
  capturedAt: string,
): TauObservation[] => {
  const observations = stepObservations(analysis, runId, capturedAt)
  const forced = analysis.forced
  if (forced?.tauSec !== undefined && forced.fanLevel > 0) {
    observations.push({
      runId,
      capturedAt,
      stepIndex: -1,
      fan: bucket(forced.fanLevel),
      heat: 0,
      tauSec: forced.tauSec,
      direction: 'falling',
      quality: 'measured',
      kind: 'cooling-tail',
      source: `forced cooling tail, fan ${forced.fanLevel.toFixed(1)}, over ${forced.seconds.toFixed(0)} s`,
    })
  }
  if (analysis.passiveTauSec !== undefined) {
    observations.push({
      runId,
      capturedAt,
      stepIndex: -2,
      fan: 0,
      heat: 0,
      tauSec: analysis.passiveTauSec,
      direction: 'falling',
      quality: 'measured',
      kind: 'passive-tail',
      source: 'passive decay tail, fan off',
    })
  }
  return observations
}

export const tauObservations = (runs: CalibrationRun[]): TauObservation[] =>
  runs.flatMap((run) => tauObservationsFrom(analyzeCalibrationRun(run), run.id, run.capturedAt))

const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export interface FanTau {
  fan: number
  /** The median of what was measured at this fan: one bad step cannot drag it. */
  tauSec: number
  observations: TauObservation[]
  rising: number
  falling: number
  lowSec: number
  highSec: number
  /** The weakest fit among the observations that carry an R2; undefined when none do. */
  worstR2?: number
}

export interface ResponseSummaryRow {
  fan: number
  medianSec: number
  lowSec: number
  highSec: number
  observations: number
  rising: number
  falling: number
  quality: 'strong' | 'mixed' | 'limited'
}

/** A bounded, user-facing summary of response speed, one row per measured fan level. */
export const responseSummary = (byFan: FanTau[]): ResponseSummaryRow[] =>
  byFan.map((entry) => {
    const spread = entry.highSec - entry.lowSec
    const quality: ResponseSummaryRow['quality'] =
      entry.observations.length < 2
        ? 'limited'
        : (entry.worstR2 !== undefined && entry.worstR2 < 0.8) || spread > entry.tauSec
          ? 'mixed'
          : 'strong'
    return {
      fan: entry.fan,
      medianSec: entry.tauSec,
      lowSec: entry.lowSec,
      highSec: entry.highSec,
      observations: entry.observations.length,
      rising: entry.rising,
      falling: entry.falling,
      quality,
    }
  })

/**
 * Tau grouped by the fan it was measured at, and by nothing else.
 *
 * Airflow does the moving, so fan is the axis tau is a function of. Heat is deliberately NOT
 * averaged out into a second dimension here - the spread across heats at one fan is left visible as
 * low-to-high, because if it is wide then tau is not purely a function of fan on this machine and
 * that is a finding, not noise to be hidden.
 */
export const tauByFan = (observations: TauObservation[]): FanTau[] => {
  const groups = new Map<number, TauObservation[]>()
  for (const observation of observations) {
    const fan = bucket(observation.fan)
    const held = groups.get(fan)
    if (held) held.push(observation)
    else groups.set(fan, [observation])
  }
  return [...groups.entries()]
    .map(([fan, group]) => {
      const taus = group.map((observation) => observation.tauSec)
      const scored = group.flatMap((observation) => (observation.r2 === undefined ? [] : [observation.r2]))
      return {
        fan,
        tauSec: median(taus)!,
        observations: [...group].sort((a, b) => a.heat - b.heat),
        rising: group.filter((observation) => observation.direction === 'rising').length,
        falling: group.filter((observation) => observation.direction === 'falling').length,
        lowSec: Math.min(...taus),
        highSec: Math.max(...taus),
        worstR2: scored.length === 0 ? undefined : Math.min(...scored),
      }
    })
    .sort((a, b) => a.fan - b.fan)
}

export interface TauChoice {
  /** The fan the tau actually came from, which is not always the fan that was asked for. */
  fan: number
  requestedFan: number
  tauSec: number
  /** True when nothing was measured at the requested fan and a neighbour's tau was used instead. */
  borrowed: boolean
  observations: TauObservation[]
  worstR2?: number
  detail: string
}

/**
 * Which tau to use for a transition to a given fan.
 *
 * The destination fan is what governs the approach: once the new levels are commanded, it is the
 * new airflow that carries the chamber to its new settled point. When that fan was never measured
 * the nearest measured one is used and the answer says so - borrowing a neighbour's tau is a
 * defensible estimate, and presenting it as a measurement is not.
 */
export const tauForFan = (byFan: FanTau[], fan: number): TauChoice | undefined => {
  if (byFan.length === 0) return undefined
  const exact = byFan.find((entry) => Math.abs(entry.fan - fan) <= SAME_LEVEL)
  const chosen = exact ?? [...byFan].sort((a, b) => Math.abs(a.fan - fan) - Math.abs(b.fan - fan))[0]
  const spread = chosen.highSec - chosen.lowSec
  return {
    fan: chosen.fan,
    requestedFan: fan,
    tauSec: chosen.tauSec,
    borrowed: exact === undefined,
    observations: chosen.observations,
    worstR2: chosen.worstR2,
    detail: `${chosen.observations.length} measured step${chosen.observations.length === 1 ? '' : 's'} at fan ${chosen.fan.toFixed(1)}, ${chosen.lowSec.toFixed(0)}-${chosen.highSec.toFixed(0)} s${spread > chosen.tauSec * 0.5 ? ' (wide spread, so tau is not purely a function of fan here)' : ''}`,
  }
}

/**
 * How a settled temperature was arrived at. Only `measured` is a reading; everything below it is an
 * inference of some kind and is labelled with which kind.
 */
export type SettledBasis = 'measured' | 'fitted' | 'unreliable' | 'interpolated' | 'outside'

export interface SettledEstimate {
  temperatureC: number
  basis: SettledBasis
  detail: string
}

const interpolate = (lowX: number, lowY: number, highX: number, highY: number, x: number) =>
  highX === lowX ? lowY : lowY + (highY - lowY) * ((x - lowX) / (highX - lowX))

interface RowValue {
  temperatureC: number
  outside: boolean
}

/** One fan row of the map, read at an arbitrary heat by straight-line interpolation between cells. */
const rowAt = (map: BaselineMap, fan: number, heat: number): RowValue | undefined => {
  const points = map.heats
    .flatMap((candidate) => {
      const cell = map.cells[meshKey(fan, candidate)]
      return cell ? [{ heat: bucket(candidate), temperatureC: cell.steadyStateC }] : []
    })
    .sort((a, b) => a.heat - b.heat)
  if (points.length === 0) return undefined
  if (points.length === 1)
    return { temperatureC: points[0].temperatureC, outside: Math.abs(points[0].heat - heat) > SAME_LEVEL }
  const first = points[0]
  const last = points[points.length - 1]
  if (heat <= first.heat) return { temperatureC: first.temperatureC, outside: heat < first.heat - SAME_LEVEL }
  if (heat >= last.heat) return { temperatureC: last.temperatureC, outside: heat > last.heat + SAME_LEVEL }
  const upper = points.findIndex((point) => point.heat >= heat)
  const low = points[upper - 1]
  const high = points[upper]
  return { temperatureC: interpolate(low.heat, low.temperatureC, high.heat, high.temperatureC, heat), outside: false }
}

/**
 * The settled temperature at any fan and heat, read off the measured surface.
 *
 * An exact measured cell is returned as itself, carrying its own quality. Anything else is
 * interpolated between the cells that bracket it, and a request outside the measured rectangle is
 * CLAMPED rather than extrapolated - a straight line run off the end of a curved surface is exactly
 * the confident wrong answer this project exists to avoid.
 */
export const settledAt = (map: BaselineMap, fan: number, heat: number): SettledEstimate | undefined => {
  const exact = map.cells[meshKey(fan, heat)]
  if (exact) {
    const basis: SettledBasis =
      exact.quality === 'unreliable' ? 'unreliable' : exact.extrapolated ? 'fitted' : 'measured'
    return {
      temperatureC: exact.steadyStateC,
      basis,
      detail:
        basis === 'measured'
          ? `Measured at fan ${bucket(fan).toFixed(1)} heat ${bucket(heat).toFixed(1)}`
          : basis === 'fitted'
            ? `Fitted from a step cut short${exact.r2 === undefined ? '' : `, R2 ${exact.r2.toFixed(3)}`}`
            : 'That step never settled and the fit identified nothing, so this is a lower bound',
    }
  }
  const rows = map.fans
    .flatMap((candidate) => {
      const value = rowAt(map, candidate, heat)
      return value ? [{ fan: bucket(candidate), ...value }] : []
    })
    .sort((a, b) => a.fan - b.fan)
  if (rows.length === 0) return undefined
  const first = rows[0]
  const last = rows[rows.length - 1]
  const outsideFan = fan < first.fan - SAME_LEVEL || fan > last.fan + SAME_LEVEL
  const value =
    fan <= first.fan
      ? first
      : fan >= last.fan
        ? last
        : (() => {
            const upper = rows.findIndex((row) => row.fan >= fan)
            const low = rows[upper - 1]
            const high = rows[upper]
            return {
              temperatureC: interpolate(low.fan, low.temperatureC, high.fan, high.temperatureC, fan),
              outside: low.outside || high.outside,
            }
          })()
  const outside = outsideFan || value.outside
  return {
    temperatureC: value.temperatureC,
    basis: outside ? 'outside' : 'interpolated',
    detail: outside
      ? `Outside the measured grid (fan ${first.fan.toFixed(1)}-${last.fan.toFixed(1)}, heat ${map.heats[0]}-${map.heats[map.heats.length - 1]}), so this is the nearest measured edge rather than a reading`
      : `Interpolated between measured points, fan ${first.fan.toFixed(1)}-${last.fan.toFixed(1)}`,
  }
}

/**
 * t = tau * ln(|dT| / epsilon).
 *
 * A gap already inside the tolerance takes no time at all, and is returned as zero rather than as a
 * negative logarithm.
 */
export const transitionSeconds = (deltaC: number, tauSec: number, toleranceC: number): number | undefined => {
  if (!(tauSec > 0) || !(toleranceC > 0) || !Number.isFinite(deltaC)) return undefined
  const gap = Math.abs(deltaC)
  if (gap <= toleranceC) return 0
  return tauSec * Math.log(gap / toleranceC)
}

/* ------------------------------------------------ moves: what a change of setting actually costs */

/**
 * Whether this move was WALKED or is merely computed.
 *
 * The distinction is the whole point of the readout that replaced the transition calculator. Every
 * serpentine step of a baseline pass IS a measured move - the chamber really went from the previous
 * settled point to this one, and the step's own fitted time constant says how long that took. A pair
 * nobody ever walked can still be answered, from the settled surface and the fitted time constants,
 * but it is an inference and it says so.
 */
export type MoveBasis = 'measured' | 'predicted'

export interface TransitionMove {
  fromFan: number
  fromHeat: number
  toFan: number
  toHeat: number
  fromC?: number
  toC?: number
  deltaC?: number
  /** t = tau ln(|dT| / epsilon). Undefined when nothing supports an answer at all. */
  secondsToSettle?: number
  basis: MoveBasis
  tauSec?: number
  /** The fan the time constant was measured at, which is not always the destination fan. */
  tauFan?: number
  borrowedTau: boolean
  worstR2?: number
  /** How many stored passes walked this exact move. Zero for a predicted one. */
  walked: number
  /** The weaker of the two settled temperatures behind it. */
  endpoint: SettledBasis
}

export const moveKey = (fromFan: number, fromHeat: number, toFan: number, toHeat: number) =>
  `${bucket(fromFan)}:${bucket(fromHeat)}>${bucket(toFan)}:${bucket(toHeat)}`

const ENDPOINT_RANK: Record<SettledBasis, number> = {
  measured: 0,
  fitted: 1,
  interpolated: 2,
  unreliable: 3,
  outside: 4,
}
const weaker = (a: SettledBasis, b: SettledBasis) => (ENDPOINT_RANK[a] >= ENDPOINT_RANK[b] ? a : b)

const movesFromAnalysis = (analysis: CalibrationAnalysis, toleranceC: number): TransitionMove[] => {
  const moves: TransitionMove[] = []
  for (let index = 1; index < analysis.steps.length; index += 1) {
    const previous = analysis.steps[index - 1]
    const step = analysis.steps[index]
    // A recovery step is a step the program inserted to get somewhere, not a setting anybody chose.
    if (previous.recovery || step.recovery) continue
    if (previous.steadyStateC === undefined || step.steadyStateC === undefined || step.tauSec === undefined) continue
    const deltaC = step.steadyStateC - previous.steadyStateC
    moves.push({
      fromFan: bucket(previous.fanLevel),
      fromHeat: bucket(previous.heatLevel),
      toFan: bucket(step.fanLevel),
      toHeat: bucket(step.heatLevel),
      fromC: previous.steadyStateC,
      toC: step.steadyStateC,
      deltaC,
      secondsToSettle: transitionSeconds(deltaC, step.tauSec, toleranceC),
      basis: 'measured',
      tauSec: step.tauSec,
      tauFan: bucket(step.fanLevel),
      borrowedTau: false,
      worstR2: step.steadyStateR2,
      walked: 1,
      endpoint: step.quality === 'unreliable' ? 'unreliable' : step.quality === 'extrapolated' ? 'fitted' : 'measured',
    })
  }
  return moves
}

/**
 * Every move the stored passes actually walked, pooled.
 *
 * Two passes that walked the same pair are one row: the median of what they measured, with the count
 * kept so a single observation cannot pass itself off as a repeatable figure.
 */
export const measuredMoves = (
  runs: CalibrationRun[],
  toleranceC = DEFAULT_TRANSITION_TOLERANCE_C,
): TransitionMove[] => {
  const groups = new Map<string, TransitionMove[]>()
  for (const run of runs) {
    for (const move of movesFromAnalysis(analyzeCalibrationRun(run), toleranceC)) {
      const key = moveKey(move.fromFan, move.fromHeat, move.toFan, move.toHeat)
      const held = groups.get(key)
      if (held) held.push(move)
      else groups.set(key, [move])
    }
  }
  return [...groups.values()].map((group) => {
    const scored = group.flatMap((move) => (move.worstR2 === undefined ? [] : [move.worstR2]))
    return {
      ...group[0],
      fromC: median(group.map((move) => move.fromC as number))!,
      toC: median(group.map((move) => move.toC as number))!,
      deltaC: median(group.map((move) => move.deltaC as number))!,
      secondsToSettle: median(
        group.flatMap((move) => (move.secondsToSettle === undefined ? [] : [move.secondsToSettle])),
      ),
      tauSec: median(group.flatMap((move) => (move.tauSec === undefined ? [] : [move.tauSec]))),
      worstR2: scored.length === 0 ? undefined : Math.min(...scored),
      walked: group.length,
      endpoint: group.map((move) => move.endpoint).reduce(weaker, 'measured' as SettledBasis),
    }
  })
}

export interface TransitionOrigin {
  fan: number
  heat: number
  /** How many measured moves start here. The default view opens on the richest one. */
  walked: number
}

/** Every setting the map covers, as a place a move can start from, richest in evidence first. */
export const transitionOrigins = (map: BaselineMap, measured: TransitionMove[]): TransitionOrigin[] => {
  const origins = map.fans.flatMap((fan) =>
    map.heats.flatMap((heat) =>
      map.cells[meshKey(fan, heat)]
        ? [
            {
              fan: bucket(fan),
              heat: bucket(heat),
              walked: measured.filter(
                (move) => Math.abs(move.fromFan - fan) <= SAME_LEVEL && Math.abs(move.fromHeat - heat) <= SAME_LEVEL,
              ).length,
            },
          ]
        : [],
    ),
  )
  return origins
}

export const defaultTransitionOrigin = (origins: TransitionOrigin[]): TransitionOrigin | undefined =>
  [...origins].sort((a, b) => b.walked - a.walked)[0]

export interface TransitionsFromInput {
  map: BaselineMap
  byFan: FanTau[]
  measured: TransitionMove[]
  fromFan: number
  fromHeat: number
  toleranceC?: number
}

/**
 * One row per destination the map covers: the move that was walked where one was, and the move as
 * computed where none was.
 *
 * This is deliberately not a calculator. Nothing is entered, nothing is solved for; the map already
 * knows every setting it covers, so the whole answer is a list, and the only choice left is which
 * row of it to read. Rows come back in the map's own fan-then-heat order so the list and the settled
 * surface can be read against each other.
 */
export const transitionsFrom = ({
  map,
  byFan,
  measured,
  fromFan,
  fromHeat,
  toleranceC = DEFAULT_TRANSITION_TOLERANCE_C,
}: TransitionsFromInput): TransitionMove[] => {
  const walked = new Map(measured.map((move) => [moveKey(move.fromFan, move.fromHeat, move.toFan, move.toHeat), move]))
  const from = settledAt(map, fromFan, fromHeat)
  return map.fans.flatMap((fan) =>
    map.heats.flatMap((heat) => {
      if (!map.cells[meshKey(fan, heat)]) return []
      if (Math.abs(fan - fromFan) <= SAME_LEVEL && Math.abs(heat - fromHeat) <= SAME_LEVEL) return []
      const found = walked.get(moveKey(fromFan, fromHeat, fan, heat))
      if (found) return [found]
      const to = settledAt(map, fan, heat)
      const tau = tauForFan(byFan, fan)
      const deltaC = from && to ? to.temperatureC - from.temperatureC : undefined
      return [
        {
          fromFan: bucket(fromFan),
          fromHeat: bucket(fromHeat),
          toFan: bucket(fan),
          toHeat: bucket(heat),
          fromC: from?.temperatureC,
          toC: to?.temperatureC,
          deltaC,
          secondsToSettle: deltaC === undefined || !tau ? undefined : transitionSeconds(deltaC, tau.tauSec, toleranceC),
          basis: 'predicted' as const,
          tauSec: tau?.tauSec,
          tauFan: tau?.fan,
          borrowedTau: tau?.borrowed ?? false,
          worstR2: tau?.worstR2,
          walked: 0,
          endpoint: weaker(from?.basis ?? 'outside', to?.basis ?? 'outside'),
        },
      ]
    }),
  )
}

export type PassGradeLevel = 'good' | 'partial' | 'poor'

export interface PassGrade {
  points: number
  measured: number
  extrapolated: number
  unreliable: number
  suspectFans: number[]
  hasCoolingTail: boolean
  hasPassiveTail: boolean
  grade: PassGradeLevel
  reasons: string[]
}

/**
 * What one empty-chamber pass is worth to the map, and where it is not to be trusted.
 *
 * This is the baseline-pass counterpart of the excitation grade a loaded roast carries. A pass is
 * never excluded by this - the user knows things about their own machine that this does not - but
 * a pass with a physically impossible row in it should not be silently feeding the surface the
 * whole app plans against.
 */
export const baselinePassGrade = (analysis: CalibrationAnalysis): PassGrade => {
  const holds = analysis.steps.filter((step) => !step.recovery && step.steadyStateC !== undefined)
  const measured = holds.filter((step) => step.quality === 'measured').length
  const extrapolated = holds.filter((step) => step.quality === 'extrapolated').length
  const unreliable = holds.filter((step) => step.quality === 'unreliable').length
  // The physics rule - steady state must rise with heat at a fixed fan - has exactly one
  // implementation, in `thermalLog`. A second copy here would be a second place for it to drift.
  const suspectFans = suspectFanLevels(curveFamily(analysis))
  const hasCoolingTail = analysis.forced?.tauSec !== undefined
  const hasPassiveTail = analysis.passiveTauSec !== undefined

  const reasons: string[] = []
  if (suspectFans.length > 0)
    reasons.push(
      `Fan ${suspectFans.map((fan) => fan.toFixed(1)).join(', ')} settles COOLER as heat rises, which is impossible: those steps never settled.`,
    )
  if (unreliable > 0)
    reasons.push(
      `${unreliable} step${unreliable === 1 ? '' : 's'} never settled and could not be fitted, so those values are lower bounds.`,
    )
  if (extrapolated > 0)
    reasons.push(
      `${extrapolated} step${extrapolated === 1 ? '' : 's'} cut short, so those settled temperatures come from the curve fit.`,
    )
  if (!hasPassiveTail) reasons.push('No fan-off decay tail, so this pass constrains no thermal-loss coefficient.')
  if (!hasCoolingTail) reasons.push('No fan-on cooling tail, so this pass measures no forced-cooling time constant.')

  const grade: PassGradeLevel =
    suspectFans.length > 0 || unreliable > holds.length / 4
      ? 'poor'
      : extrapolated > 0 || !hasPassiveTail
        ? 'partial'
        : 'good'
  return {
    points: holds.length,
    measured,
    extrapolated,
    unreliable,
    suspectFans,
    hasCoolingTail,
    hasPassiveTail,
    grade,
    reasons,
  }
}
