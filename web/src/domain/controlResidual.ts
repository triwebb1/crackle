import type { ControlCorrection, ThermalSegment } from './types'

/**
 * Reading the model's bias off a completed roast.
 *
 * The in-roast feedback layer (`journeyControl.ts`) exists to hold the nominal plan when the
 * calibration is wrong, which it is assumed to be. Every correction it applied was recorded. This
 * module turns that series back into the one number the next calibration wants:
 *
 *   **the mean integral term is an estimate of the persistent feed-forward bias, in °C/min.**
 *
 * Why the INTEGRAL term specifically, and not the total. The proportional term is a response to
 * wherever the roast happens to be right now: it swings either side of zero as the roast crosses
 * its plan, it is large during transients and zero at the moments tracking is perfect, and its
 * average over a run is close to nothing however wrong the model is. The integral term is the part
 * that had to be held to keep the error at zero - the offset the feed-forward failed to supply. A
 * roast that averaged +3 °C/min of integral was one whose model under-predicted the heat needed by
 * 3 °C/min throughout, which at roughly 6.6 °C/min per heat level is very nearly half a heat level of
 * missing gain. That is a refit input, not noise.
 *
 * The RMS is reported alongside the mean because the two together say whether the bias is real. A
 * mean of +3 with an RMS of 3.1 is a steady offset. A mean of +0.2 with an RMS of 5 is a controller
 * that spent the roast chasing in both directions, which says the shape is wrong rather than the
 * gain, and no single coefficient scaling will fix it.
 *
 * **Samples that were not closing the loop are excluded.** A holdover sample had no measurement, so
 * its correction is a placeholder rather than an observation. A saturated sample was pinned against
 * the plant's limits, so its correction is a statement about the zone's Fan and Heat band rather
 * than about the coefficients. Both are counted and reported - a summary that dropped most of the
 * run and did not say so would be worse than no summary - but neither is averaged into the bias.
 */
export interface ControlResidualSummary {
  /** How many samples carried a correction at all. */
  samples: number
  /** How many of those were usable as a bias estimate: measured, and not against a limit. */
  usableSamples: number
  saturatedSamples: number
  holdoverSamples: number
  /** The persistent feed-forward bias estimate, in °C/min. Positive means the model under-heats. */
  meanIntegralRatePerMin: number
  /** Spread of the integral term. Close to |mean| means a steady offset; far above it means drift. */
  rmsIntegralRatePerMin: number
  /** The whole correction, averaged. Included because P and I disagreeing is itself a reading. */
  meanTotalRatePerMin: number
  /** Mean absolute tracking error over the usable samples, in C. How well the loop actually held. */
  meanAbsErrorC: number
}

const EMPTY: ControlResidualSummary = {
  samples: 0,
  usableSamples: 0,
  saturatedSamples: 0,
  holdoverSamples: 0,
  meanIntegralRatePerMin: 0,
  rmsIntegralRatePerMin: 0,
  meanTotalRatePerMin: 0,
  meanAbsErrorC: 0,
}

const finite = (value: number) => (Number.isFinite(value) ? value : 0)

/**
 * Summarize a run's correction series. Pure, order-independent, and safe on an empty or
 * pre-feedback run: no corrections means every figure is zero and `samples` says why.
 *
 * `window` narrows the summary to a slice of the roast, which is what makes the mid-roast reading
 * possible. The bias worth refitting on is the one measured while the roast was in its steady
 * climbing regime - not during the charge transient, and not through the cooling zone where the
 * heater is off and the correction means something else entirely.
 */
export const summarizeControlCorrections = (
  corrections: ReadonlyArray<ControlCorrection | undefined>,
): ControlResidualSummary => {
  const present = corrections.filter((correction): correction is ControlCorrection => correction != null)
  if (present.length === 0) return EMPTY

  const holdoverSamples = present.filter((correction) => correction.holdover).length
  const saturatedSamples = present.filter((correction) => !correction.holdover && correction.saturated).length
  const usable = present.filter((correction) => !correction.holdover && !correction.saturated)
  if (usable.length === 0) {
    return { ...EMPTY, samples: present.length, saturatedSamples, holdoverSamples }
  }

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const integrals = usable.map((correction) => finite(correction.integralRatePerMin))
  return {
    samples: present.length,
    usableSamples: usable.length,
    saturatedSamples,
    holdoverSamples,
    meanIntegralRatePerMin: mean(integrals),
    rmsIntegralRatePerMin: Math.sqrt(mean(integrals.map((value) => value * value))),
    meanTotalRatePerMin: mean(usable.map((correction) => finite(correction.totalRatePerMin))),
    meanAbsErrorC: mean(usable.map((correction) => Math.abs(finite(correction.errorC)))),
  }
}

/**
 * The mid-roast slice, by elapsed time. Kept separate from the summary itself so the choice of
 * window is the caller's and is visible at the call site rather than buried in an average.
 */
export const correctionsBetween = <T extends { elapsedSec: number; correction?: ControlCorrection }>(
  samples: ReadonlyArray<T>,
  fromSec: number,
  toSec: number,
): ControlCorrection[] =>
  samples
    .filter((sample) => sample.elapsedSec >= fromSec && sample.elapsedSec <= toSec)
    .map((sample) => sample.correction)
    .filter((correction): correction is ControlCorrection => correction != null)

/*
 * ==============================================================================================
 * PER-ZONE ACCOUNTING - one number for the whole roast was the wrong unit
 * ==============================================================================================
 *
 * The first zone is the initial ramp-up and will likely always miss its target: most profiles ask
 * for a faster climb than is possible. The middle zones are where the controller has real authority.
 * The final cooling zone is the opposite case: the surface temperature may drop quickly, then rise
 * again as the fan slows and heat inside the beans comes out, so its accuracy matters less.
 *
 * Three zones, three different meanings, and averaging them together produces a number that means
 * none of them:
 *
 *   - **ramp** (zone 0). A charge ramp into a cold mass, usually authored steeper than any roaster
 *     can climb. Its overrun IS its result - "reached 150 °C in 3:10 against a planned 2:30" - and it
 *     is EXPECTED to miss. Feeding its saturated, pinned-at-the-limit corrections into a coefficient
 *     refit would teach the model that the heater is weak when in fact the profile was optimistic.
 *   - **cooling** (the trailing descending zones). Governed by heat leaving the bean mass, not by
 *     anything commanded; a real roaster's surface reading even rebounds as the fan slows. Accuracy
 *     here is de-emphasised on purpose.
 *   - **controlled** (everything between). The zones the loop genuinely authors, and therefore the
 *     ONLY ones whose integral term is a statement about the calibration. This is what the refit
 *     consumes.
 *
 * Since zone advancement is by attainment (`journeyControl.ts`), a zone's ACTUAL duration is a
 * measurement rather than a restatement of the profile, and nominal-versus-actual is the headline
 * for the ramp and cooling zones exactly as tracking error is for the middle ones.
 */

export type ZoneRole = 'ramp' | 'controlled' | 'cooling'

/**
 * Which zones mean what. Cooling is claimed from the END backwards - a descending zone in the middle
 * of a journey is a deliberate drop the controller does author, and only the trailing run is the
 * "accuracy matters less" case. Zone 0 is the charge ramp unless it has
 * already been claimed as cooling, which would be a one-zone journey with nothing to refit from.
 */
export const zoneRoles = (zones: ReadonlyArray<ThermalSegment>): ZoneRole[] => {
  const roles: ZoneRole[] = zones.map(() => 'controlled')
  for (let index = zones.length - 1; index >= 0; index -= 1) {
    if (zones[index].endC >= zones[index].startC) break
    roles[index] = 'cooling'
  }
  if (roles.length > 0 && roles[0] === 'controlled') roles[0] = 'ramp'
  return roles
}

export interface ZoneResidualSummary {
  zoneIndex: number
  zoneId: string
  role: ZoneRole
  /** What the profile asked the zone to take. */
  nominalDurationSec: number
  /** What it actually took, measured between attainments. Zero if the zone was never entered. */
  actualDurationSec: number
  /** Actual minus nominal. Positive is an overrun; for a ramp or cooling zone this IS the metric. */
  overrunSec: number
  /** Whether the zone's end temperature was reached at all. */
  attained: boolean
  entered: boolean
  /** Samples in the zone that carried a correction. */
  samples: number
  saturatedSamples: number
  holdoverSamples: number
  /** Fraction of the zone's samples that were pinned against the plant's limits. */
  saturatedFraction: number
  /**
   * Tracking statistics over the zone's MEASURED samples - saturated ones included, unlike the bias
   * estimate below. A ramp zone is saturated almost throughout and excluding those samples would
   * leave it with no reading at all, which defeats the purpose of reporting it.
   */
  meanAbsErrorC: number
  meanIntegralRatePerMin: number
  rmsIntegralRatePerMin: number
}

export interface JourneyResidualReport {
  zones: ZoneResidualSummary[]
  /**
   * The headline model-bias estimate - the number a refit consumes - computed from the CONTROLLED
   * zones alone. Same exclusions as ever inside that window: no holdovers, no saturated samples.
   */
  bias: ControlResidualSummary
  /** Which zones fed it, so the figure can never be read as a whole-roast claim. */
  biasZoneIndexes: number[]
}

export interface JourneyZoneRow {
  elapsedSec: number
  /** The zone the control was actually in at this sample, by attainment. */
  zoneIndex: number
  correction?: ControlCorrection
}

const meanOf = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * Split a journey's correction series by the zone each sample was controlled in, and report each
 * zone on its own terms.
 *
 * Pure. `finalZoneAttained` is the caller's, because a run that simply stopped cannot tell from its
 * own rows whether the last zone arrived or was abandoned - only the loop that stopped it knows.
 * `endSec` closes the final zone's duration; without it the last sample's timestamp is used.
 */
export const summarizeJourneyZones = (
  zones: ReadonlyArray<ThermalSegment>,
  rows: ReadonlyArray<JourneyZoneRow>,
  { finalZoneAttained = false, endSec }: { finalZoneAttained?: boolean; endSec?: number } = {},
): JourneyResidualReport => {
  const roles = zoneRoles(zones)
  const entrySec = new Map<number, number>()
  let reached = -1
  for (const row of rows) {
    if (!entrySec.has(row.zoneIndex)) entrySec.set(row.zoneIndex, row.elapsedSec)
    if (row.zoneIndex > reached) reached = row.zoneIndex
  }
  const lastRowSec = rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.elapsedSec))
  const runEndSec = endSec ?? lastRowSec

  const summaries = zones.map((zone, zoneIndex): ZoneResidualSummary => {
    const entered = entrySec.has(zoneIndex)
    const entry = entrySec.get(zoneIndex) ?? 0
    // A zone ends where the next ENTERED zone began. One transition can skip malformed/zero-length
    // zones, so looking only at index + 1 would incorrectly extend the earlier zone to run end.
    const laterEntries = [...entrySec].filter(([candidate]) => candidate > zoneIndex).map(([, seconds]) => seconds)
    const exit = laterEntries.length > 0 ? Math.min(...laterEntries) : runEndSec
    const zoneRows = rows.filter((row) => row.zoneIndex === zoneIndex)
    const present = zoneRows
      .map((row) => row.correction)
      .filter((correction): correction is ControlCorrection => correction != null)
    const measured = present.filter((correction) => !correction.holdover)
    const integrals = measured.map((correction) => finite(correction.integralRatePerMin))
    const saturatedSamples = measured.filter((correction) => correction.saturated).length
    return {
      zoneIndex,
      zoneId: zone.id,
      role: roles[zoneIndex],
      nominalDurationSec: Math.max(0, zone.durationSec),
      actualDurationSec: entered ? Math.max(0, exit - entry) : 0,
      overrunSec: entered ? Math.max(0, exit - entry) - Math.max(0, zone.durationSec) : 0,
      attained: zoneIndex < reached || (zoneIndex === reached && finalZoneAttained),
      entered,
      samples: present.length,
      saturatedSamples,
      holdoverSamples: present.length - measured.length,
      saturatedFraction: measured.length === 0 ? 0 : saturatedSamples / measured.length,
      meanAbsErrorC: meanOf(measured.map((correction) => Math.abs(finite(correction.errorC)))),
      meanIntegralRatePerMin: meanOf(integrals),
      rmsIntegralRatePerMin: Math.sqrt(meanOf(integrals.map((value) => value * value))),
    }
  })

  const biasZoneIndexes = summaries
    .filter((summary) => summary.role === 'controlled' && summary.entered)
    .map((summary) => summary.zoneIndex)
  const biasCorrections = rows.filter((row) => biasZoneIndexes.includes(row.zoneIndex)).map((row) => row.correction)
  return { zones: summaries, bias: summarizeControlCorrections(biasCorrections), biasZoneIndexes }
}
