import { MOCK_SR800_MODEL_ID, SR800_MODEL_ID } from '../domain/roasterModel'
import type { RecordedOn } from '../domain/types'

export const DEMO_SOURCE_DEVICE_ID = 'crackle-dev-sim-sr800'
export const DEMO_RECORDED_ON: RecordedOn = {
  deviceId: DEMO_SOURCE_DEVICE_ID,
  modelId: MOCK_SR800_MODEL_ID,
  displayNameAtCapture: 'Crackle simulated SR800',
  simulated: true,
  simulatesModelId: SR800_MODEL_ID,
  firmwareVersion: '2026-07-26.40-mock',
  identitySource: 'roaster',
}
