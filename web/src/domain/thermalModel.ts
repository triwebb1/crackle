import type { SimulationSensorModel, ThermalModelSettings } from './types'

/** The shared probe response used by both browser profile simulation and the development roaster. */
export const SIMULATED_ROASTER_SENSOR_MODEL: SimulationSensorModel = {
  probeOffsetC: 0,
  sensorLagSec: 5,
}

export interface ThermalStepInput {
  previousBeanTempC?: number
  previousRorCPerMin?: number
  fan: number
  heat: number
  /**
   * Retained for source compatibility with older callers. Plant mode is derived from the actual
   * Heat/Fan pair so simulation, replay, and the development roaster cannot select different physics.
   */
  cooling?: boolean
  batchMassG: number
  ambientC?: number
}

export type ThermalPlantMode = 'heating' | 'forced-cooling' | 'passive'

/** One branch selector for every thermal-model consumer. */
export const thermalPlantMode = (fan: number, heat: number): ThermalPlantMode =>
  heat > 0 ? 'heating' : fan > 0 ? 'forced-cooling' : 'passive'

export interface ThermalStepResult {
  beanTempC: number
  rorCPerMin: number
}

export const thermalStep = (
  input: ThermalStepInput,
  calibration: ThermalModelSettings,
  sensor: SimulationSensorModel = { probeOffsetC: 0, sensorLagSec: 0 },
): ThermalStepResult => {
  const ambientC = input.ambientC ?? 24.5
  const priorActualTemp = (input.previousBeanTempC ?? ambientC + sensor.probeOffsetC) - sensor.probeOffsetC
  // Mass changes thermal capacity, so it scales the complete net energy rate. Scaling only heater
  // power made equilibrium temperature fall as mass rose, even though mass changes time-to-target.
  const capacityScale = calibration.referenceBatchMassG / Math.max(1, input.batchMassG)
  const thermalLoss = Math.max(0, priorActualTemp - ambientC) * calibration.thermalLossPerMinPerC
  const mode = thermalPlantMode(input.fan, input.heat)
  const desiredRor =
    mode === 'heating'
      ? capacityScale *
        Math.max(
          -5,
          4 +
            (input.heat / 10) * calibration.heaterGainCPerMinAt10 -
            (input.fan / 10) * calibration.fanCoolingCPerMinAt10 -
            thermalLoss,
        )
      : mode === 'forced-cooling'
        ? -capacityScale * Math.max(8, (input.fan / 10) * calibration.coolingFanCPerMinAt10 + thermalLoss)
        : -capacityScale * thermalLoss
  const response = sensor.sensorLagSec <= 0 ? 1 : 1 - Math.exp(-1 / sensor.sensorLagSec)
  const rorCPerMin =
    input.previousRorCPerMin == null ? desiredRor : input.previousRorCPerMin * (1 - response) + desiredRor * response
  const actualTemp = Math.max(ambientC, priorActualTemp + rorCPerMin / 60)
  return { beanTempC: actualTemp + sensor.probeOffsetC, rorCPerMin }
}
