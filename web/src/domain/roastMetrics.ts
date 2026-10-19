import type { BatchMeasurements } from './types'

/**
 * What a roast's recorded measurements imply, once they are all present.
 *
 * These are the covariates a future cross-run regression will need: how much a batch expanded, how
 * much mass it lost, and how its density moved. None of them is modelled yet - see the note at the
 * bottom of this file - but every one of them is cheap to derive, impossible to reconstruct later
 * if it was never recorded, and useful on its own to anyone reading a roast back.
 *
 * Every figure is null-safe and returns `undefined` rather than a plausible-looking zero: a batch
 * whose final volume was never measured has no expansion ratio, and saying 0 would be a lie that
 * later averages into a fitted coefficient.
 */
export interface RoastMetrics {
  /** Green bulk density, g/ml. */
  greenDensityGPerMl?: number
  /** Roasted bulk density, g/ml. Always lower: the bean expands while it loses mass. */
  roastedDensityGPerMl?: number
  /** Volume after over volume before. The headline expansion figure. */
  expansionRatio?: number
  /** Mass lost as a percentage of green mass - largely water, hence a moisture proxy. */
  massLossPercent?: number
  /** Density lost as a percentage of green density. */
  densityLossPercent?: number
}

const ratio = (numerator?: number, denominator?: number) =>
  numerator !== undefined &&
  denominator !== undefined &&
  Number.isFinite(numerator) &&
  Number.isFinite(denominator) &&
  numerator > 0 &&
  denominator > 0
    ? numerator / denominator
    : undefined

export const roastMetrics = (measurements?: BatchMeasurements): RoastMetrics => {
  const greenDensityGPerMl = ratio(measurements?.startingMassG, measurements?.startingVolumeMl)
  const roastedDensityGPerMl = ratio(measurements?.finalMassG, measurements?.finalVolumeMl)
  const expansionRatio = ratio(measurements?.finalVolumeMl, measurements?.startingVolumeMl)
  const massRatio = ratio(measurements?.finalMassG, measurements?.startingMassG)
  const densityRatio = ratio(roastedDensityGPerMl, greenDensityGPerMl)
  return {
    greenDensityGPerMl,
    roastedDensityGPerMl,
    expansionRatio,
    massLossPercent: massRatio === undefined ? undefined : (1 - massRatio) * 100,
    densityLossPercent: densityRatio === undefined ? undefined : (1 - densityRatio) * 100,
  }
}

/** Which measurements a roast is still missing, for the completeness badges on the fit selector. */
export const missingMeasurements = (measurements?: BatchMeasurements): string[] => {
  const missing: string[] = []
  if (!(measurements?.startingMassG ?? 0)) missing.push('green mass')
  if (!(measurements?.startingVolumeMl ?? 0)) missing.push('green volume')
  if (!(measurements?.finalMassG ?? 0)) missing.push('roasted mass')
  if (!(measurements?.finalVolumeMl ?? 0)) missing.push('roasted volume')
  return missing
}

export const hasExpansionData = (measurements?: BatchMeasurements) =>
  roastMetrics(measurements).expansionRatio !== undefined

/** For a table cell: a number at a sensible precision, or a dash. */
export const formatMetric = (value: number | undefined, places = 2, suffix = '') =>
  value === undefined ? '--' : `${value.toFixed(places)}${suffix}`

/**
 * ============================================================================================
 * WHY THERE IS NO EXPANSION COEFFICIENT IN THE THERMAL MODEL YET
 * ============================================================================================
 *
 * A bean that expands changes the thing the model is describing while the model is describing it:
 * bulk density falls, the packed bed opens up, and the airflow that was removing a fixed amount of
 * heat starts removing a different amount. It is a real effect and it plainly belongs in the model
 * eventually.
 *
 * It is not in the model now because there is no dataset to fit it from. An expansion coefficient
 * would need roasts that vary in expansion while holding everything else steady, and enough of them
 * that the fitted term is distinguishable from noise in the coefficients it would sit beside -
 * heater gain and fan cooling are already strongly correlated with each other on a single log.
 * Inventing the term before that data exists would produce a number that looks like a measurement,
 * lands in a saved calibration, and is never questioned again.
 *
 * So the groundwork ships and the coefficient does not: these covariates are recorded per roast,
 * carried into every calibration fitted from those roasts, and displayed. When the run count
 * supports a regression of absorption against expansion, the dataset will already be there, and it
 * will have been collected without anyone having to remember to collect it.
 * ============================================================================================
 */
