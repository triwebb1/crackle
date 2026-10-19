import type { CalibrationRun, CalibrationSettings, CalibrationSnapshot, RecordedOn, RoasterIdentity } from './types'

export type CalibrationCompatibility =
  | { kind: 'same-device'; compatible: true; warning?: undefined }
  | { kind: 'same-model-different-device'; compatible: true; warning: string }
  | { kind: 'unknown-source'; compatible: false; message: string }
  | { kind: 'model-mismatch'; compatible: false; message: string }

type CalibrationSource = Pick<CalibrationRun | CalibrationSnapshot, 'recordedOn'>

const compatibleIdentity = (source: RecordedOn, target: RoasterIdentity): CalibrationCompatibility => {
  if (source.identitySource !== 'roaster') {
    return {
      kind: 'unknown-source',
      compatible: false,
      message:
        'This calibration uses an operator-configured legacy identity. Bind it explicitly to a roaster before applying it.',
    }
  }
  if (source.simulated !== target.simulated) {
    return {
      kind: 'model-mismatch',
      compatible: false,
      message: 'Simulated and physical calibration evidence cannot be interchanged.',
    }
  }
  if (source.modelId !== target.modelId) {
    return {
      kind: 'model-mismatch',
      compatible: false,
      message: `This calibration describes ${source.modelId}, not the connected ${target.modelId}. It cannot be applied.`,
    }
  }
  if (source.deviceId !== target.deviceId) {
    return {
      kind: 'same-model-different-device',
      compatible: true,
      warning:
        'This calibration came from another physical roaster of the same model. Apply it only as an intentional replacement-unit starting point.',
    }
  }
  return { kind: 'same-device', compatible: true }
}

export const calibrationCompatibility = (
  source: CalibrationSource,
  target: RoasterIdentity,
): CalibrationCompatibility => compatibleIdentity(source.recordedOn, target)

export const calibrationSettingsCompatibility = (
  settings: CalibrationSettings,
  target: RoasterIdentity,
): CalibrationCompatibility => {
  const sourceDeviceId = settings.thermalSourceDeviceId
  const sourceModelId = settings.thermalSourceModelId
  if (!sourceDeviceId || !sourceModelId) {
    return {
      kind: 'unknown-source',
      compatible: false,
      message: 'This calibration does not identify the roaster model and device it describes.',
    }
  }
  if (sourceModelId !== target.modelId) {
    return {
      kind: 'model-mismatch',
      compatible: false,
      message: `This calibration describes ${sourceModelId}, not the connected ${target.modelId}. It cannot be applied.`,
    }
  }
  if (sourceDeviceId !== target.deviceId) {
    return {
      kind: 'same-model-different-device',
      compatible: true,
      warning:
        'This calibration came from another physical roaster of the same model. Apply it only as an intentional replacement-unit starting point.',
    }
  }
  return { kind: 'same-device', compatible: true }
}

/** A fit must describe one machine. Mixed controller evidence is never pooled. */
export const mixedCalibrationSources = (runs: CalibrationRun[]): string | undefined => {
  const sources = new Set(runs.map((run) => `${run.recordedOn.modelId}::${run.recordedOn.deviceId}`))
  return sources.size > 1
    ? 'Selected calibration evidence comes from more than one roaster. Fit one device at a time.'
    : undefined
}
