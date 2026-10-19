import { COEFFICIENT_LABELS, type DeviceCoefficients } from './deviceLogs'
import type { CalibrationSnapshot, ThermalCoefficientField, ThermalCoefficientPatch } from './types'

export const THERMAL_COEFFICIENT_LABELS: Record<ThermalCoefficientField, string> = COEFFICIENT_LABELS

const FIELDS = Object.keys(THERMAL_COEFFICIENT_LABELS) as ThermalCoefficientField[]

export interface CompletedCalibrationSnapshot {
  snapshot: CalibrationSnapshot
  measuredFields: ThermalCoefficientField[]
  inheritedFields: ThermalCoefficientField[]
}

export type CompleteCalibrationResult =
  | { ok: true; value: CompletedCalibrationSnapshot }
  | { ok: false; reason: string }

const finiteFields = (patch: ThermalCoefficientPatch) =>
  FIELDS.filter((field) => typeof patch[field] === 'number' && Number.isFinite(patch[field]))

export const fieldList = (fields: ThermalCoefficientField[]) =>
  fields.map((field) => THERMAL_COEFFICIENT_LABELS[field]).join(', ')

/**
 * Makes an empty-chamber-only snapshot temporarily complete without claiming the inherited values
 * were measured by that pass.
 *
 * The roaster is the only allowed inheritance source. Browser calibration state is deliberately
 * not accepted here: it may be stale, while `status.appliedCoefficients` is what the next roast
 * will actually use. A loaded-roast fit is never patched this way; it must stand on its own.
 */
export const completeEmptyChamberSnapshot = (
  snapshot: CalibrationSnapshot,
  roasterCoefficients: DeviceCoefficients | undefined,
): CompleteCalibrationResult => {
  const finite = finiteFields(snapshot.patch)
  const inheritedFieldsAlreadyRecorded = FIELDS.filter((field) => {
    const inherited = snapshot.inheritedCoefficients?.[field]
    return inherited?.source === 'roaster-applied' && inherited.value === snapshot.patch[field]
  })
  const measuredFields = finite.filter((field) => !inheritedFieldsAlreadyRecorded.includes(field))
  const missingFields = FIELDS.filter((field) => !finite.includes(field))
  if (missingFields.length === 0) {
    return { ok: true, value: { snapshot, measuredFields, inheritedFields: inheritedFieldsAlreadyRecorded } }
  }
  if (snapshot.inputs?.length) {
    return {
      ok: false,
      reason: `This loaded-roast fit is missing ${fieldList(missingFields)}. Loaded fits must provide a complete measured set and cannot inherit those values.`,
    }
  }
  const unavailable = missingFields.filter((field) => {
    const value = roasterCoefficients?.[field]
    return typeof value !== 'number' || !Number.isFinite(value)
  })
  if (unavailable.length > 0) {
    return {
      ok: false,
      reason: `The empty-chamber pass is missing ${fieldList(missingFields)}, and the roaster does not currently report ${fieldList(unavailable)} to inherit. Record or import a loaded roast before applying this calibration.`,
    }
  }

  const inheritedFields = [...missingFields]
  const fullPatch = { ...snapshot.patch } as ThermalCoefficientPatch
  const inheritedCoefficients: NonNullable<CalibrationSnapshot['inheritedCoefficients']> = {}
  for (const field of inheritedFields) {
    const value = roasterCoefficients![field]!
    fullPatch[field] = value
    inheritedCoefficients[field] = {
      source: 'roaster-applied',
      value,
      fitId: roasterCoefficients?.fitId,
      appliedAt: roasterCoefficients?.updatedAt,
    }
  }
  const inherited = fieldList(inheritedFields)
  const provisionalName = snapshot.name.includes('Provisional - inherited ')
    ? snapshot.name
    : `${snapshot.name} - Provisional - inherited ${inherited}`

  return {
    ok: true,
    value: {
      measuredFields,
      inheritedFields,
      snapshot: {
        ...snapshot,
        name: provisionalName,
        patch: fullPatch,
        inheritedCoefficients,
        applicationFitId: `provisional:${snapshot.id}`,
      },
    },
  }
}
