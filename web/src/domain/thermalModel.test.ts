import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { thermalStep } from './thermalModel'

describe('calibrated thermal preview model', () => {
  it('responds to externally configured heater gain', () => {
    const input = { fan: 5, heat: 5, cooling: false, batchMassG: 225 }
    const baseline = thermalStep(input, defaultCalibration)
    const stronger = thermalStep(input, {
      ...defaultCalibration,
      heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 1.5,
    })
    const weaker = thermalStep(input, {
      ...defaultCalibration,
      heaterGainCPerMinAt10: defaultCalibration.heaterGainCPerMinAt10 * 0.5,
    })
    expect(stronger.rorCPerMin).toBeGreaterThan(baseline.rorCPerMin)
    expect(weaker.rorCPerMin).toBeLessThan(baseline.rorCPerMin)
  })

  it('scales heating response by batch mass', () => {
    const light = thermalStep({ fan: 5, heat: 5, cooling: false, batchMassG: 150 }, defaultCalibration)
    const heavy = thermalStep({ fan: 5, heat: 5, cooling: false, batchMassG: 300 }, defaultCalibration)
    expect(light.rorCPerMin).toBeGreaterThan(heavy.rorCPerMin)
  })

  it('uses the configured cooling coefficient and probe offset', () => {
    const result = thermalStep(
      { previousBeanTempC: 200, previousRorCPerMin: 0, fan: 10, heat: 0, cooling: true, batchMassG: 225 },
      { ...defaultCalibration, coolingFanCPerMinAt10: 30 },
      { sensorLagSec: 0, probeOffsetC: 1.5 },
    )
    expect(result.rorCPerMin).toBeLessThan(-30)
    expect(result.beanTempC).toBeGreaterThan(199)
  })

  it('uses mass as thermal capacity without changing fixed-input equilibrium', () => {
    const calibration = { ...defaultCalibration, thermalLossPerMinPerC: 0.2 }
    const fan = 1
    const heat = 6
    const ambientC = 25
    const equilibriumC =
      ambientC +
      (4 + (heat / 10) * calibration.heaterGainCPerMinAt10 - (fan / 10) * calibration.fanCoolingCPerMinAt10) /
        calibration.thermalLossPerMinPerC
    const at = (batchMassG: number) =>
      thermalStep(
        {
          previousBeanTempC: equilibriumC,
          previousRorCPerMin: 0,
          fan,
          heat,
          cooling: false,
          batchMassG,
          ambientC,
        },
        calibration,
      )
    expect(at(150).rorCPerMin).toBeCloseTo(0, 9)
    expect(at(300).rorCPerMin).toBeCloseTo(0, 9)
  })

  it('uses passive loss rather than the forced-cooling floor when both outputs are off', () => {
    const calibration = { ...defaultCalibration, thermalLossPerMinPerC: 0.05 }
    const result = thermalStep(
      { previousBeanTempC: 100, fan: 0, heat: 0, cooling: true, batchMassG: 225, ambientC: 25 },
      calibration,
    )
    expect(result.rorCPerMin).toBeCloseTo(-3.75, 6)
  })
})
