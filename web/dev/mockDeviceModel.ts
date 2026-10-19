import { ESTIMATED_BASELINE_COEFFICIENTS, ESTIMATED_BASELINE_MASS_G } from '../src/domain/estimatedBaseline'
import { MOCK_SR800_MODEL_ID, SR800_MODEL_ID } from '../src/domain/roasterModel'
import { SIMULATED_ROASTER_SENSOR_MODEL } from '../src/domain/thermalModel'
import type { RoasterIdentity, ThermalModelSettings } from '../src/domain/types'

/** Stable controller identity. Mock power cycles change boot identity, never this device identity. */
export const MOCK_ROASTER_IDENTITY: RoasterIdentity = {
  deviceId: 'crackle-dev-sim-sr800',
  modelId: MOCK_SR800_MODEL_ID,
  displayName: 'Crackle simulated SR800',
  simulated: true,
  simulatesModelId: SR800_MODEL_ID,
}

/** Synthetic-only probe behavior. These values are not SR800 calibration settings. */
export const MOCK_SENSOR_MODEL = SIMULATED_ROASTER_SENSOR_MODEL
export const MOCK_SENSOR_NOISE_C = 0.18

/** The mock's initial believed model; applied device coefficients replace its four measured terms. */
export const MOCK_THERMAL_MODEL: ThermalModelSettings = {
  referenceBatchMassG: ESTIMATED_BASELINE_MASS_G,
  ...ESTIMATED_BASELINE_COEFFICIENTS,
}
