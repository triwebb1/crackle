import { logExcitation } from './coefficientFit'
import { formatLocalDateTime } from './dateTime'
import { type RoastMetrics, roastMetrics } from './roastMetrics'
import type { BatchMeasurements, CalibrationRun, CalibrationSnapshot, RoastRun } from './types'

/**
 * What a fitted calibration was fitted FROM, and whether that is still true.
 *
 * Two problems this solves, and they are the same problem seen from either end.
 *
 * **Late-arriving measurements.** Roasted mass and volume are weighed after the batch has cooled,
 * which is minutes to hours after the log was recorded and often after a fit has already been run.
 * A calibration fitted before those numbers arrived was fitted from a different dataset than the
 * one now on screen, and nothing said so.
 *
 * **Silent drift.** Measurements get corrected. A mistyped final mass, a volume measured properly
 * the second time. Every correction invalidates any fit that consumed it, and a saved calibration
 * has no way to notice.
 *
 * A fingerprint fixes both: it is the input run ids plus a hash of exactly the measurement values
 * the fit used. If the fingerprint no longer matches what those runs say today, the calibration is
 * stale and says so. A stale calibration is never rewritten - refitting saves a NEW one, because
 * the old one may already have been applied and a record of what was applied has to stay true.
 */

export interface FitInputRecord {
  runId: string
  capturedAt: string
  label: string
  /** The batch this log was roasted with, for a loaded run. */
  massG?: number
  /** Which bean lot, when the log was linked to a roast. */
  beanLotId?: string
  beanLotName?: string
  /** The roast this log came from, when it came from one. */
  roastRunId?: string
  roastName?: string
  /** The covariates a future absorption-versus-expansion regression will need. */
  metrics?: RoastMetrics
  measurements?: BatchMeasurements
}

/**
 * FNV-1a over a canonical rendering of the values that matter. Hand-rolled because a dependency for
 * thirty-two bits of change detection would be absurd, and because the exact algorithm is
 * irrelevant - all that is required is that the same inputs give the same string and different ones
 * almost certainly do not.
 */
export const hashValues = (parts: Array<string | number | undefined>): string => {
  const canonical = parts.map((part) => (part === undefined ? '~' : String(part))).join('')
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The measurement values a fit consumes from one input, in a fixed order. */
const inputValues = (input: FitInputRecord): Array<string | number | undefined> => [
  input.runId,
  input.massG,
  input.measurements?.startingMassG,
  input.measurements?.startingVolumeMl,
  input.measurements?.finalMassG,
  input.measurements?.finalVolumeMl,
]

export interface FitFingerprint {
  runIds: string[]
  /** A hash of every measurement value the fit consumed. */
  measurementHash: string
}

export const fitFingerprint = (inputs: FitInputRecord[]): FitFingerprint => {
  // Sorted, so the order runs were selected in cannot change the fingerprint.
  const ordered = [...inputs].sort((a, b) => a.runId.localeCompare(b.runId))
  return {
    runIds: ordered.map((input) => input.runId),
    measurementHash: hashValues(ordered.flatMap(inputValues)),
  }
}

/**
 * Build the record of one fit input from whatever is known about it: the log itself always, the
 * roast it came from when there is one.
 */
export const fitInputFromRun = (run: CalibrationRun, roast?: RoastRun): FitInputRecord => ({
  runId: run.id,
  capturedAt: run.capturedAt,
  label: roast ? roast.name : `${formatLocalDateTime(run.capturedAt)}${run.massG ? ` / ${run.massG} g` : ''}`,
  massG: run.massG,
  beanLotId: roast?.beanLotId,
  beanLotName: roast?.beanLotSnapshot?.name,
  roastRunId: roast?.id,
  roastName: roast?.name,
  measurements: roast?.measurements,
  metrics: roast ? roastMetrics(roast.measurements) : undefined,
})

export type StaleReason = 'measurements-changed' | 'input-missing'

export interface StalenessCheck {
  stale: boolean
  reason?: StaleReason
  detail?: string
}

/**
 * Is this saved calibration still a fit of what its inputs currently say?
 *
 * Compares the stored fingerprint against one rebuilt from the runs and roasts as they are now. A
 * missing input is reported separately from a changed one, because they mean different things: the
 * first says the evidence is gone, the second says it moved.
 */
export const fitStaleness = (snapshot: CalibrationSnapshot, currentInputs: FitInputRecord[]): StalenessCheck => {
  if (!snapshot.fingerprint) return { stale: false }
  const available = new Set(currentInputs.map((input) => input.runId))
  const missing = snapshot.fingerprint.runIds.filter((runId) => !available.has(runId))
  if (missing.length > 0) {
    return {
      stale: true,
      reason: 'input-missing',
      detail: `${missing.length} of the ${snapshot.fingerprint.runIds.length} logs this was fitted from ${missing.length === 1 ? 'is' : 'are'} no longer stored.`,
    }
  }
  const rebuilt = fitFingerprint(currentInputs.filter((input) => snapshot.fingerprint!.runIds.includes(input.runId)))
  if (rebuilt.measurementHash !== snapshot.fingerprint.measurementHash) {
    return {
      stale: true,
      reason: 'measurements-changed',
      detail:
        'The measurements on the roasts this was fitted from have been edited since. Refitting will produce a new calibration; this one is left as the record of what was applied.',
    }
  }
  return { stale: false }
}

export interface FitReadiness {
  /** Whether this run can contribute to a coefficient fit at all. */
  fittable: boolean
  /** Why not, or what it cannot constrain. */
  reasons: string[]
  /** How much of the covariate set this run carries, for the future regression. */
  missingMeasurements: string[]
  excitation: ReturnType<typeof logExcitation>
  /** Default selection state in the fit picker. */
  includedByDefault: boolean
}

/**
 * What a candidate run brings to a fit, and what it does not.
 *
 * A run is excluded by default when it cannot contribute - no batch mass means the model's mass
 * factor is a guess, and no readable samples means there is nothing to replay - but never hidden,
 * and never forced: the reason is shown and the checkbox still works, because the user knows
 * things about their own roasts that this cannot.
 */
export const fitReadiness = (run: CalibrationRun, roast?: RoastRun): FitReadiness => {
  const excitation = logExcitation(run.samples)
  const readable = run.samples.filter((sample) => sample.thermocoupleC !== undefined).length
  const reasons: string[] = []
  if (readable < 30) reasons.push('Too few readable samples to replay.')
  if (!(run.massG ?? 0))
    reasons.push('No batch weight recorded, so this is an empty-chamber pass rather than a loaded roast.')
  const fittable = reasons.length === 0
  return {
    fittable,
    reasons: [...reasons, ...excitation.warnings],
    missingMeasurements: roast ? missingFor(roast.measurements) : ['no linked roast measurements'],
    excitation,
    includedByDefault: fittable,
  }
}

const missingFor = (measurements?: BatchMeasurements): string[] => {
  const missing: string[] = []
  if (!(measurements?.startingMassG ?? 0)) missing.push('green mass')
  if (!(measurements?.startingVolumeMl ?? 0)) missing.push('green volume')
  if (!(measurements?.finalMassG ?? 0)) missing.push('roasted mass')
  if (!(measurements?.finalVolumeMl ?? 0)) missing.push('roasted volume')
  return missing
}

/** A one-word grade for the excitation badge. */
export const excitationGrade = (excitation: ReturnType<typeof logExcitation>): 'good' | 'partial' | 'poor' => {
  if (excitation.warnings.length === 0) return 'good'
  if (excitation.fanSweptAtConstantHeat || excitation.heatLevels >= 2) return 'partial'
  return 'poor'
}
