import type { DeviceCoefficients } from './deviceLogs'
import { ESTIMATED_BASELINE_COEFFICIENTS } from './estimatedBaseline'
import { fieldList } from './provisionalCalibration'
import { patchMatches } from './thermalLog'
import type { CalibrationSettings, CalibrationSnapshot, ThermalCoefficientField } from './types'

/**
 * Where the applied thermal coefficients came from - and, more to the point, whether they came from
 * anywhere at all.
 *
 * A simulation drawn against uncalibrated defaults looks exactly like one drawn against a measured
 * roaster: same axes, same confident line, same numbers on it. That is the dangerous case, because
 * the shape is roughly right and the temperatures are not, and nothing on screen distinguishes the
 * two. Every screen that shows a derived temperature states this instead of assuming it.
 */
export const THERMAL_FIELDS: ThermalCoefficientField[] = [
  'heaterGainCPerMinAt10',
  'fanCoolingCPerMinAt10',
  'coolingFanCPerMinAt10',
  'thermalLossPerMinPerC',
]

/**
 * Three honest states, not two.
 *
 * - `calibrated`: the live coefficients are traceable to a real pass on this roaster.
 * - `estimated`: they are the shipped starting baseline - documented, chosen to reproduce a
 *   canonical SR800 roast, and therefore plausible in SHAPE and roughly right in temperature, but
 *   never measured on this machine.
 * - `manual`: neither. Somebody typed them.
 *
 * The middle state is the one that was missing. Calling the shipped constants "uncalibrated" made
 * them sound like noise when they are a considered estimate, and calling them calibrated would be a
 * lie; either way the user cannot tell how much weight a predicted temperature deserves.
 */
export type ProvenanceGrade = 'calibrated' | 'provisional' | 'estimated' | 'manual'

export interface CalibrationProvenance {
  grade: ProvenanceGrade
  /** True only when the live coefficients are traceable to a real calibration pass. */
  calibrated: boolean
  /** One line, for a badge. */
  label: string
  /** One sentence, for the caption underneath it. */
  detail: string
  snapshotName?: string
}

const asDate = (iso?: string) => {
  if (!iso) return undefined
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleDateString()
}

/**
 * ============================================================================================
 * THE MODEL A PREVIEW IS ALLOWED TO USE
 * ============================================================================================
 *
 * The roast is solved ON THE CONTROLLER, against the coefficients the CONTROLLER is holding. So when
 * the controller has an applied set, a preview drawn against anything else is answering a question
 * nobody asked - and the gap between the two then surfaces as a warning about a disagreement that
 * only existed because the preview chose to disagree.
 *
 * The ladder, top rung first:
 *
 *   1. **The controller's applied set**, whenever it reports one. Preview and roast then agree by
 *      construction, and there is nothing to warn about in ordinary use.
 *   2. This app's active fit, when the controller holds none (older firmware, or nothing applied).
 *   3. The shipped estimated baseline, which is what the app's fit already falls back to.
 *
 * Only the four thermal coefficients travel. Everything else in a `CalibrationSettings` - the
 * electrical mapping, the probe offset, the cooling margin - is the app's own and the device has no
 * opinion about it.
 *
 * **A note nobody may delete.** Nothing in a `CalibrationSettings` or a `ThermalCoefficientPatch`
 * records which REGIME its four numbers describe: a pass-derived fit describes the empty CHAMBER
 * and a roast-derived fit describes the bean model everything here consumes. The coefficient sets
 * differ across the board (loss, gains, and the balance between them), so a chamber set driven
 * through the bean model equilibrates far below any roast temperature - the measured symptom is a
 * simulation pinned near 90 °C with heat at its ceiling. The two are indistinguishable at the type
 * level, so a lower rung is a GUESS about scale as well as about values - which is exactly why
 * `roastPreflight` refuses to descend one at all, and why adopting a patch as the live model stays a
 * deliberate act behind the Calibrate diff.
 */
export const previewCalibration = (
  app: CalibrationSettings,
  device: DeviceCoefficients | undefined,
): CalibrationSettings => {
  if (!device) return app
  const merged = { ...app }
  for (const field of THERMAL_FIELDS) {
    const value = device[field]
    if (typeof value === 'number' && Number.isFinite(value)) merged[field] = value
  }
  return merged
}

/** True when the controller reported enough of a set for `previewCalibration` to have used it. */
export const usingControllerModel = (device: DeviceCoefficients | undefined): boolean =>
  device !== undefined && THERMAL_FIELDS.some((field) => typeof device[field] === 'number')

export const calibrationProvenance = (
  calibration: CalibrationSettings,
  snapshots: CalibrationSnapshot[],
  defaults: CalibrationSettings,
  device?: DeviceCoefficients,
): CalibrationProvenance => {
  const matchingProvisional = device
    ? [...snapshots]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .find((snapshot) => {
          const inherited = Object.keys(snapshot.inheritedCoefficients ?? {}) as ThermalCoefficientField[]
          const fitMatches =
            !device.fitId || !snapshot.applicationFitId ? true : device.fitId === snapshot.applicationFitId
          return (
            inherited.length > 0 &&
            fitMatches &&
            patchMatches(snapshot.patch, device as Record<string, number | undefined>)
          )
        })
    : undefined
  if (matchingProvisional) {
    const inherited = Object.keys(matchingProvisional.inheritedCoefficients ?? {}) as ThermalCoefficientField[]
    return {
      grade: 'provisional',
      calibrated: false,
      label: `Model: provisional empty-chamber calibration (${fieldList(inherited)} inherited)`,
      detail: `The roaster is using this set, but ${fieldList(inherited)} came unchanged from its previous calibration and was not measured by the empty-chamber pass. Capture a loaded roast, then fit and apply it to replace this provisional bridge.`,
      snapshotName: matchingProvisional.name,
    }
  }
  // The top rung: what the roaster itself is holding, which is what the roast will actually use.
  if (usingControllerModel(device)) {
    // Named by the saved calibration it was applied from when one matches; otherwise by the fit id
    // the roaster stores, which is still a stable handle for provenance.
    const named = device?.fitId ? snapshots.find((snapshot) => snapshot.applicationFitId === device.fitId) : undefined
    const fit = device?.fitId ? ` (fit ${device.fitId})` : ''
    const when = asDate(device?.updatedAt)
    return {
      grade: 'calibrated',
      calibrated: true,
      label: named
        ? `Model: ${named.name}, applied on the roaster`
        : `Model: the calibration applied on the roaster${fit}`,
      detail: `This preview uses the same numbers the roaster will${when ? `, applied on ${when}` : ''}, so what is drawn here is what it will try to follow.`,
    }
  }

  const applied = Object.fromEntries(THERMAL_FIELDS.map((field) => [field, calibration[field]])) as Record<
    string,
    number | undefined
  >

  // The strongest claim: a saved calibration whose patch is exactly what is live.
  const match = [...snapshots]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((snapshot) => Object.keys(snapshot.patch).length > 0 && patchMatches(snapshot.patch, applied))
  if (match) {
    const inherited = Object.keys(match.inheritedCoefficients ?? {}) as ThermalCoefficientField[]
    if (inherited.length > 0) {
      return {
        grade: 'provisional',
        calibrated: false,
        label: `Model: provisional empty-chamber calibration (${fieldList(inherited)} inherited)`,
        detail: `${fieldList(inherited)} was inherited from the roaster's previous calibration, not measured by this pass. Capture a loaded roast, then fit and apply it to replace this provisional bridge.`,
        snapshotName: match.name,
      }
    }
    const when = asDate(match.createdAt)
    return {
      grade: 'calibrated',
      calibrated: true,
      label: `Model: calibrated from ${match.name}${when ? `, ${when}` : ''}`,
      detail:
        'These coefficients were measured on this roaster, so predicted temperatures are meaningful and not only indicative.',
      snapshotName: match.name,
    }
  }

  // A weaker but still real claim: staged from a pass whose saved calibration has since been edited
  // or deleted. The provenance stamp survives even when the snapshot does not.
  const stagedOn = asDate(calibration.thermalSourceCapturedAt ?? calibration.thermalStagedAt)
  if (stagedOn) {
    return {
      grade: 'calibrated',
      calibrated: true,
      label: `Model: calibrated from a pass on ${stagedOn}`,
      detail:
        'These coefficients were staged from a real calibration pass, though the saved calibration they came from is no longer in the library.',
    }
  }

  // The shipped estimate, recognised by its own documented values rather than by "unchanged", so
  // it is still identified after an unrelated field like the probe offset has been edited.
  const estimated = THERMAL_FIELDS.every((field) => calibration[field] === ESTIMATED_BASELINE_COEFFICIENTS[field])
  if (estimated) {
    return {
      grade: 'estimated',
      calibrated: false,
      label: 'Model: estimated starting baseline (not fitted from your machine)',
      detail:
        'These are the shipped constants, chosen so the model reproduces a typical SR800 roast. Shape and rough temperatures are plausible but unverified - roast, ingest the log as a loaded run, and fit to replace them with your own.',
    }
  }

  const untouched = THERMAL_FIELDS.every((field) => calibration[field] === defaults[field])
  return {
    grade: 'manual',
    calibrated: false,
    label: 'Model uses hand-entered coefficients',
    detail: untouched
      ? 'These coefficients match no calibration pass and no shipped baseline. Simulate for SHAPE only, not for temperatures.'
      : 'These coefficients were entered by hand rather than measured from a pass. Simulate for SHAPE only, not for temperatures.',
  }
}
