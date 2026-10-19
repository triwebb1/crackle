import { describe, expect, it } from 'vitest'
import { testRecordedOn } from '../testFixtures/provenance'
import {
  calibrationCompatibility,
  calibrationSettingsCompatibility,
  mixedCalibrationSources,
} from './calibrationCompatibility'
import type { CalibrationRun, CalibrationSnapshot, RoasterIdentity } from './types'

const target: RoasterIdentity = {
  deviceId: 'device-a',
  modelId: 'freshroast-sr800',
  displayName: 'SR800',
  simulated: false,
}
const snapshot = (deviceId = 'device-a', modelId = target.modelId): CalibrationSnapshot => ({
  id: 'snapshot',
  name: 'fit',
  createdAt: new Date(0).toISOString(),
  recordedOn: { ...testRecordedOn, deviceId, modelId },
  runIds: [],
  patch: {},
  curves: [],
})
const run = (deviceId: string, modelId = target.modelId): CalibrationRun => ({
  id: deviceId,
  capturedAt: new Date(0).toISOString(),
  recordedOn: { ...testRecordedOn, deviceId, modelId },
  form: 'steps',
  steps: [],
  maxStepSeconds: 30,
  minStepSeconds: 10,
  settleSeconds: 5,
  settleBandC: 2,
  samples: [],
  notes: '',
})

describe('calibration ownership', () => {
  it('accepts the same device and warns for another device of the same model', () => {
    expect(calibrationCompatibility(snapshot(), target).kind).toBe('same-device')
    expect(calibrationCompatibility(snapshot('device-b'), target)).toMatchObject({
      kind: 'same-model-different-device',
      compatible: true,
    })
  })
  it('hard-refuses a model mismatch', () => {
    expect(calibrationCompatibility(snapshot('device-b', 'other-model'), target)).toMatchObject({
      kind: 'model-mismatch',
      compatible: false,
    })
  })
  it('requires persisted provenance on the applied settings too', () => {
    expect(
      calibrationSettingsCompatibility(
        {
          heaterGainCPerMinAt10: 1,
          fanCoolingCPerMinAt10: 1,
          coolingFanCPerMinAt10: 1,
          thermalLossPerMinPerC: 0.1,
          referenceBatchMassG: 225,
          coolingTargetMarginC: 5,
          updatedAt: new Date(0).toISOString(),
        },
        target,
      ),
    ).toMatchObject({ kind: 'unknown-source', compatible: false })
    expect(
      calibrationSettingsCompatibility(
        {
          heaterGainCPerMinAt10: 1,
          fanCoolingCPerMinAt10: 1,
          coolingFanCPerMinAt10: 1,
          thermalLossPerMinPerC: 0.1,
          referenceBatchMassG: 225,
          coolingTargetMarginC: 5,
          updatedAt: new Date(0).toISOString(),
          thermalSourceDeviceId: 'device-a',
          thermalSourceModelId: 'freshroast-sr800',
        },
        target,
      ),
    ).toMatchObject({ kind: 'same-device', compatible: true })
  })
  it('does not pool evidence from multiple physical roasters', () => {
    expect(mixedCalibrationSources([run('device-a'), run('device-b')])).toContain('more than one roaster')
    expect(mixedCalibrationSources([run('device-a'), run('device-a')])).toBeUndefined()
  })
})
