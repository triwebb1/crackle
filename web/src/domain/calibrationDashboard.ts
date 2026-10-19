import { modelledSteadyStateC } from './journeyControl'
import { type FanTau, type SettledBasis, settledAt, tauForFan, transitionSeconds } from './meshMetrics'
import type { BaselineMap } from './thermalLog'
import type { CalibrationSettings } from './types'

export const CALIBRATION_DASHBOARD_LEVELS = Object.freeze(Array.from({ length: 11 }, (_, level) => level))
/**
 * The practical "at temperature" band, matching meshMetrics' DEFAULT_TRANSITION_TOLERANCE_C —
 * the finest resolution the settle detector itself supports. The band is the dominant term of
 * every displayed timing: the model's only heating pole is thermal loss, so each map cell pays
 * tau x ln(distance/band) with tau = 1/loss. Validated against a recorded baseline and
 * loaded roast (the latter is the sample recording in `data/captures`; loss 0.174/min, tau 5.75
 * min): a 0.2 C band adds tau x ln(10) = 13.2 minutes of pure mathematical tail to every cell,
 * which renders 15-minute practical moves as 30-40 minute surfaces. Timings answer "within 2 C and holding", not "settled to the last 0.2 C".
 */
export const DEFAULT_DASHBOARD_TOLERANCE_C = 2
export const DEFAULT_MEANINGFUL_DELTA_C = 2
export const DEFAULT_DASHBOARD_SETTLE_WINDOW_SEC = 20
export const DEFAULT_MAX_SAFE_TEMPERATURE_C = 400

export type CalibrationDashboardDirection = 'heating' | 'cooling'
export type CalibrationDashboardLoad = 'empty' | '100g' | '250g'
export type CalibrationDashboardBasis = 'calculated' | 'modelled' | 'unavailable'
type SurfaceEvidenceBasis = 'measured' | 'fitted' | 'interpolated'

export interface CalibrationDashboardCell {
  fan: number
  heat: number
  /** All duration statistics are seconds. */
  average?: number
  count: number
  min?: number
  max?: number
  stddev?: number
  basis: CalibrationDashboardBasis
  detail: string
}

export interface CalibrationDestinationHeatmap {
  direction: CalibrationDashboardDirection
  load: CalibrationDashboardLoad
  massG?: number
  /** Rows are destination Fan 0..10; columns are destination Heat 0..10. */
  cells: CalibrationDashboardCell[][]
}

export interface CalibrationDashboard {
  axes: readonly number[]
  toleranceC: number
  meaningfulDeltaC: number
  settleWindowSec: number
  heatmaps: Record<CalibrationDashboardDirection, Record<CalibrationDashboardLoad, CalibrationDestinationHeatmap>>
}

export interface CalibrationDashboardInput {
  baselineMap: BaselineMap
  emptyTauByFan: FanTau[]
  calibration: CalibrationSettings
  ambientC: number
  /** Omit expensive or unsupported load panels when a working preview has no evidence for them. */
  loads?: readonly CalibrationDashboardLoad[]
  toleranceC?: number
  meaningfulDeltaC?: number
  settleWindowSec?: number
  maxSafeTemperatureC?: number
}

interface SettledPoint {
  temperatureC: number
  basis: SurfaceEvidenceBasis | 'modelled'
  detail: string
}

interface DurationCandidate {
  seconds: number
  basis: Exclude<CalibrationDashboardBasis, 'unavailable'>
  sourceBasis?: SurfaceEvidenceBasis
}

const validSetting = (fan: number, heat: number) =>
  Number.isInteger(fan) &&
  Number.isInteger(heat) &&
  fan >= 0 &&
  fan <= 10 &&
  heat >= 0 &&
  heat <= 10 &&
  !(fan === 0 && heat > 0)

const finiteTemperature = (temperatureC: number, maxSafeTemperatureC: number) =>
  Number.isFinite(temperatureC) && temperatureC >= 0 && temperatureC <= maxSafeTemperatureC

const directionOf = (deltaC: number, meaningfulDeltaC: number): CalibrationDashboardDirection | undefined =>
  deltaC > meaningfulDeltaC ? 'heating' : deltaC < -meaningfulDeltaC ? 'cooling' : undefined

const BASIS_RANK: Record<SurfaceEvidenceBasis, number> = {
  measured: 0,
  fitted: 1,
  interpolated: 2,
}

const weakerSurfaceBasis = (a: SurfaceEvidenceBasis, b: SurfaceEvidenceBasis) =>
  BASIS_RANK[a] >= BASIS_RANK[b] ? a : b

const surfaceBasis = (basis: SettledBasis): SurfaceEvidenceBasis | undefined => {
  if (basis === 'measured') return 'measured'
  if (basis === 'fitted') return 'fitted'
  if (basis === 'interpolated') return 'interpolated'
  return undefined
}

const statistics = (
  fan: number,
  heat: number,
  candidates: DurationCandidate[],
  unavailableDetail: string,
): CalibrationDashboardCell => {
  if (candidates.length === 0) {
    return { fan, heat, count: 0, basis: 'unavailable', detail: unavailableDetail }
  }
  const values = candidates.map((candidate) => candidate.seconds)
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length
  const basis: CalibrationDashboardBasis = candidates[0].basis === 'modelled' ? 'modelled' : 'calculated'
  const sourceBasis =
    basis === 'calculated'
      ? candidates.reduce(
          (worst, candidate) => weakerSurfaceBasis(worst, candidate.sourceBasis ?? 'measured'),
          'measured' as SurfaceEvidenceBasis,
        )
      : undefined
  return {
    fan,
    heat,
    average,
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    stddev: Math.sqrt(variance),
    basis,
    detail:
      basis === 'modelled'
        ? `Modelled at this batch mass from ${values.length} valid origin setting${values.length === 1 ? '' : 's'}; no loaded-roast measurement is implied.`
        : `Calculated from ${values.length} valid origin setting${values.length === 1 ? '' : 's'} using the empty-chamber settled surface and destination-fan response evidence. Weakest source evidence: ${sourceBasis}. This synthesized timing is not a measured transition.`,
  }
}

const emptyPoint = (
  map: BaselineMap,
  fan: number,
  heat: number,
  maxSafeTemperatureC: number,
): (SettledPoint & { basis: SurfaceEvidenceBasis }) | undefined => {
  if (!validSetting(fan, heat)) return undefined
  const estimate = settledAt(map, fan, heat)
  const basis = estimate && surfaceBasis(estimate.basis)
  if (!estimate || !basis || !finiteTemperature(estimate.temperatureC, maxSafeTemperatureC)) return undefined
  return { temperatureC: estimate.temperatureC, basis, detail: estimate.detail }
}

const buildEmptyHeatmap = (
  direction: CalibrationDashboardDirection,
  map: BaselineMap,
  byFan: FanTau[],
  meaningfulDeltaC: number,
  toleranceC: number,
  settleWindowSec: number,
  maxSafeTemperatureC: number,
): CalibrationDestinationHeatmap => {
  const origins = CALIBRATION_DASHBOARD_LEVELS.flatMap((fan) =>
    CALIBRATION_DASHBOARD_LEVELS.flatMap((heat) => {
      const point = emptyPoint(map, fan, heat, maxSafeTemperatureC)
      return point ? [{ fan, heat, point }] : []
    }),
  )
  const cells = CALIBRATION_DASHBOARD_LEVELS.map((fan) =>
    CALIBRATION_DASHBOARD_LEVELS.map((heat) => {
      if (!validSetting(fan, heat)) {
        return statistics(fan, heat, [], 'Fan 0 with non-zero heat is not a valid roaster setting.')
      }
      const destination = emptyPoint(map, fan, heat, maxSafeTemperatureC)
      if (!destination) {
        return statistics(
          fan,
          heat,
          [],
          'The empty-chamber surface has no trustworthy settled temperature at this destination.',
        )
      }
      const tau = tauForFan(byFan, fan)
      if (!tau || !Number.isFinite(tau.tauSec) || tau.tauSec <= 0) {
        return statistics(fan, heat, [], 'No destination-fan response evidence supports a settling-time estimate here.')
      }
      const candidates = origins.flatMap(({ point: origin }) => {
        const deltaC = destination.temperatureC - origin.temperatureC
        if (directionOf(deltaC, meaningfulDeltaC) !== direction) return []
        const transition = transitionSeconds(deltaC, tau.tauSec, toleranceC)
        if (transition === undefined || !Number.isFinite(transition)) return []
        const endpointBasis = weakerSurfaceBasis(destination.basis, origin.basis)
        return [
          {
            seconds: transition + settleWindowSec,
            basis: 'calculated' as const,
            sourceBasis: tau.borrowed ? weakerSurfaceBasis(endpointBasis, 'interpolated') : endpointBasis,
          },
        ]
      })
      return statistics(
        fan,
        heat,
        candidates,
        `No valid empty-chamber origin differs by more than ${meaningfulDeltaC} °C in the ${direction} direction from this destination.`,
      )
    }),
  )
  return { direction, load: 'empty', cells }
}

const loadedPoint = (
  fan: number,
  heat: number,
  massG: number,
  ambientC: number,
  calibration: CalibrationSettings,
  maxSafeTemperatureC: number,
): SettledPoint | undefined => {
  if (!validSetting(fan, heat) || !(massG > 0) || !Number.isFinite(ambientC)) return undefined
  // With the element off, the runtime plant clamps at ambient even though forced airflow would put
  // the unconstrained mathematical equilibrium below ambient.
  const temperatureC =
    heat === 0 ? ambientC : modelledSteadyStateC({ fan, heat, batchMassG: massG, ambientC }, calibration)
  if (!finiteTemperature(temperatureC, maxSafeTemperatureC) || temperatureC < ambientC) return undefined
  return {
    temperatureC,
    basis: 'modelled',
    detail: `Model equilibrium at ${massG} g from the applied thermal coefficients.`,
  }
}

const decaySteps = (initialDistance: number, targetDistance: number, decayPerSecond: number): number | undefined => {
  if (initialDistance <= targetDistance) return 0
  if (!(decayPerSecond > 0 && decayPerSecond < 1)) return undefined
  const steps = Math.ceil(Math.log(targetDistance / initialDistance) / Math.log(decayPerSecond))
  return Number.isFinite(steps) && steps >= 0 ? steps : undefined
}

/**
 * Solves the same one-second plant used by roast simulation without replaying as many as 3,600
 * object-heavy `thermalStep` calls for every origin/destination pair.
 *
 * With the dashboard's zero-lag sensor, each branch is a first-order discrete decay. Heating from
 * above the destination begins with the plant's -5 °C/min clamp; forced (fan-on) heat-off cooling
 * may end with its -8 °C/min floor, while Fan 0 / Heat 0 is passive decay with no floor. Those linear portions are accounted for explicitly, so the result retains the
 * runtime plant's one-second semantics and the full confirmation window.
 */
export const modelledSettleSeconds = (
  originC: number,
  destinationC: number,
  calibration: CalibrationSettings,
  fan: number,
  heat: number,
  massG: number,
  ambientC: number,
  toleranceC: number,
  settleWindowSec: number,
): number | undefined => {
  const capacityScale = calibration.referenceBatchMassG / Math.max(1, massG)
  const lossPerMin = calibration.thermalLossPerMinPerC
  const decayPerSecond = 1 - (capacityScale * lossPerMin) / 60
  if (!(lossPerMin > 0) || !(toleranceC > 0) || !(decayPerSecond > 0 && decayPerSecond < 1)) return undefined

  let entrySec = 0
  if (heat > 0) {
    let distanceC = Math.abs(originC - destinationC)
    if (originC > destinationC) {
      const clampedDistanceC = 5 / lossPerMin
      if (distanceC > clampedDistanceC) {
        const linearSteps = Math.ceil((distanceC - clampedDistanceC) / ((capacityScale * 5) / 60))
        entrySec += linearSteps
        distanceC = Math.max(0, distanceC - linearSteps * ((capacityScale * 5) / 60))
      }
    }
    const settlingSteps = decaySteps(distanceC, toleranceC, decayPerSecond)
    if (settlingSteps === undefined) return undefined
    entrySec += settlingSteps
  } else if (!(fan > 0)) {
    // Fan 0 / Heat 0 is the plant's PASSIVE mode (`thermalPlantMode`): pure exponential decay toward
    // ambient with no -8 °C/min forced-cooling floor. Applying that floor here read about half the
    // true settle time in this cell.
    const settlingSteps = decaySteps(Math.max(0, originC - ambientC), toleranceC, decayPerSecond)
    if (settlingSteps === undefined) return undefined
    entrySec += settlingSteps
  } else {
    let distanceAboveAmbientC = Math.max(0, originC - ambientC)
    const airflowCPerMin = (fan / 10) * calibration.coolingFanCPerMinAt10
    const linearFloorCPerMin = 8
    const switchDistanceC = (linearFloorCPerMin - airflowCPerMin) / lossPerMin
    const equilibriumDistanceC = -airflowCPerMin / lossPerMin
    const exponentialTargetC = switchDistanceC > 0 ? switchDistanceC : toleranceC

    if (distanceAboveAmbientC > exponentialTargetC) {
      const settlingSteps = decaySteps(
        distanceAboveAmbientC - equilibriumDistanceC,
        exponentialTargetC - equilibriumDistanceC,
        decayPerSecond,
      )
      if (settlingSteps === undefined) return undefined
      entrySec += settlingSteps
      distanceAboveAmbientC = Math.max(
        0,
        (distanceAboveAmbientC - equilibriumDistanceC) * decayPerSecond ** settlingSteps + equilibriumDistanceC,
      )
    }
    if (distanceAboveAmbientC > toleranceC) {
      entrySec += Math.ceil((distanceAboveAmbientC - toleranceC) / ((capacityScale * linearFloorCPerMin) / 60))
    }
  }

  // Parity with the iterated one-second plant is exact except at exact linear-step boundaries,
  // where accumulated float error in the iterated subtraction can differ from this ceil by one
  // second (verified: 45 of 3,291 parity cases, all the same tie shape). Timings here are
  // presentation, so ±1 s at a tie is accepted rather than papered over with an epsilon.
  const result = entrySec + Math.max(0, settleWindowSec)
  return result <= 3600 ? result : undefined
}

const unavailableHeatmap = (
  direction: CalibrationDashboardDirection,
  load: CalibrationDashboardLoad,
  detail: string,
): CalibrationDestinationHeatmap => ({
  direction,
  load,
  massG: load === '100g' ? 100 : load === '250g' ? 250 : undefined,
  cells: CALIBRATION_DASHBOARD_LEVELS.map((fan) =>
    CALIBRATION_DASHBOARD_LEVELS.map((heat) => statistics(fan, heat, [], detail)),
  ),
})
const buildLoadedHeatmap = (
  direction: CalibrationDashboardDirection,
  load: Exclude<CalibrationDashboardLoad, 'empty'>,
  massG: number,
  calibration: CalibrationSettings,
  ambientC: number,
  meaningfulDeltaC: number,
  toleranceC: number,
  settleWindowSec: number,
  maxSafeTemperatureC: number,
): CalibrationDestinationHeatmap => {
  const origins = CALIBRATION_DASHBOARD_LEVELS.flatMap((fan) =>
    CALIBRATION_DASHBOARD_LEVELS.flatMap((heat) => {
      const point = loadedPoint(fan, heat, massG, ambientC, calibration, maxSafeTemperatureC)
      return point ? [{ fan, heat, point }] : []
    }),
  )
  const cells = CALIBRATION_DASHBOARD_LEVELS.map((fan) =>
    CALIBRATION_DASHBOARD_LEVELS.map((heat) => {
      if (!validSetting(fan, heat)) {
        return statistics(fan, heat, [], 'Fan 0 with non-zero heat is not a valid roaster setting.')
      }
      const destination = loadedPoint(fan, heat, massG, ambientC, calibration, maxSafeTemperatureC)
      if (!destination) {
        return statistics(fan, heat, [], 'The applied model has no finite, safe equilibrium at this destination.')
      }
      const candidates = origins.flatMap(({ point: origin }) => {
        const deltaC = destination.temperatureC - origin.temperatureC
        if (directionOf(deltaC, meaningfulDeltaC) !== direction) return []
        const seconds = modelledSettleSeconds(
          origin.temperatureC,
          destination.temperatureC,
          calibration,
          fan,
          heat,
          massG,
          ambientC,
          toleranceC,
          settleWindowSec,
        )
        return seconds === undefined || !Number.isFinite(seconds) ? [] : [{ seconds, basis: 'modelled' as const }]
      })
      return statistics(
        fan,
        heat,
        candidates,
        `No valid modelled origin differs by more than ${meaningfulDeltaC} °C in the ${direction} direction from this destination.`,
      )
    }),
  )
  return { direction, load, massG, cells }
}

/**
 * Which load panels a working preview may synthesize.
 *
 * The empty map needs a selected baseline surface. The 100 g / 250 g maps are pure model
 * projections from the previewed coefficients, so they appear only while the previewed fit is one
 * Save and apply would accept — a fit the apply gate refuses must never be advertised as timing
 * surfaces, which is exactly how an implausible candidate once painted 30-minute settle maps.
 */
export const workingPreviewLoads = (
  hasBaselineSurface: boolean,
  loadedFitApplyable: boolean,
): CalibrationDashboardLoad[] => [
  ...(hasBaselineSurface ? ['empty' as const] : []),
  ...(loadedFitApplyable ? ['100g' as const, '250g' as const] : []),
]

export const buildCalibrationDashboard = ({
  baselineMap,
  emptyTauByFan,
  calibration,
  ambientC,
  toleranceC = DEFAULT_DASHBOARD_TOLERANCE_C,
  settleWindowSec = DEFAULT_DASHBOARD_SETTLE_WINDOW_SEC,
  maxSafeTemperatureC = DEFAULT_MAX_SAFE_TEMPERATURE_C,
  meaningfulDeltaC = DEFAULT_MEANINGFUL_DELTA_C,
  loads = ['empty', '100g', '250g'],
}: CalibrationDashboardInput): CalibrationDashboard => {
  const safeToleranceC = Number.isFinite(toleranceC) && toleranceC > 0 ? toleranceC : DEFAULT_DASHBOARD_TOLERANCE_C
  const safeSettleWindowSec =
    Number.isFinite(settleWindowSec) && settleWindowSec >= 0 ? settleWindowSec : DEFAULT_DASHBOARD_SETTLE_WINDOW_SEC
  const safeMeaningfulDeltaC =
    Number.isFinite(meaningfulDeltaC) && meaningfulDeltaC > 0 ? meaningfulDeltaC : DEFAULT_MEANINGFUL_DELTA_C
  const safeMaximumC =
    Number.isFinite(maxSafeTemperatureC) && maxSafeTemperatureC > 0
      ? maxSafeTemperatureC
      : DEFAULT_MAX_SAFE_TEMPERATURE_C

  const includedLoads = new Set(loads)
  const heatmaps = {
    heating: {
      empty: includedLoads.has('empty')
        ? buildEmptyHeatmap(
            'heating',
            baselineMap,
            emptyTauByFan,
            safeMeaningfulDeltaC,
            safeToleranceC,
            safeSettleWindowSec,
            safeMaximumC,
          )
        : unavailableHeatmap('heating', 'empty', 'No empty-chamber evidence is selected.'),
      '100g': includedLoads.has('100g')
        ? buildLoadedHeatmap(
            'heating',
            '100g',
            100,
            calibration,
            ambientC,
            safeMeaningfulDeltaC,
            safeToleranceC,
            safeSettleWindowSec,
            safeMaximumC,
          )
        : unavailableHeatmap('heating', '100g', 'No loaded-roast evidence is selected.'),
      '250g': includedLoads.has('250g')
        ? buildLoadedHeatmap(
            'heating',
            '250g',
            250,
            calibration,
            ambientC,
            safeMeaningfulDeltaC,
            safeToleranceC,
            safeSettleWindowSec,
            safeMaximumC,
          )
        : unavailableHeatmap('heating', '250g', 'No loaded-roast evidence is selected.'),
    },
    cooling: {
      empty: includedLoads.has('empty')
        ? buildEmptyHeatmap(
            'cooling',
            baselineMap,
            emptyTauByFan,
            safeMeaningfulDeltaC,
            safeToleranceC,
            safeSettleWindowSec,
            safeMaximumC,
          )
        : unavailableHeatmap('cooling', 'empty', 'No empty-chamber evidence is selected.'),
      '100g': includedLoads.has('100g')
        ? buildLoadedHeatmap(
            'cooling',
            '100g',
            100,
            calibration,
            ambientC,
            safeMeaningfulDeltaC,
            safeToleranceC,
            safeSettleWindowSec,
            safeMaximumC,
          )
        : unavailableHeatmap('cooling', '100g', 'No loaded-roast evidence is selected.'),
      '250g': includedLoads.has('250g')
        ? buildLoadedHeatmap(
            'cooling',
            '250g',
            250,
            calibration,
            ambientC,
            safeMeaningfulDeltaC,
            safeToleranceC,
            safeSettleWindowSec,
            safeMaximumC,
          )
        : unavailableHeatmap('cooling', '250g', 'No loaded-roast evidence is selected.'),
    },
  } satisfies CalibrationDashboard['heatmaps']

  return {
    axes: CALIBRATION_DASHBOARD_LEVELS,
    toleranceC: safeToleranceC,
    settleWindowSec: safeSettleWindowSec,
    heatmaps,
    meaningfulDeltaC: safeMeaningfulDeltaC,
  }
}
