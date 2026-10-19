import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { testRecordedOn } from '../testFixtures/provenance'
import { calibrationProvenance, previewCalibration, usingControllerModel } from './calibrationProvenance'
import type { CalibrationSettings, CalibrationSnapshot } from './types'

const patch = { heaterGainCPerMinAt10: 41.2, thermalLossPerMinPerC: 0.021 }

const snapshot = (over: Partial<CalibrationSnapshot> = {}): CalibrationSnapshot => ({
  recordedOn: testRecordedOn,
  id: 'snap',
  name: 'July baseline 4x3',
  createdAt: '2026-07-20T10:00:00.000Z',
  runIds: ['run'],
  ambientC: 24.5,
  patch,
  curves: [],
  ...over,
})

const applied = (over: Partial<CalibrationSettings> = {}): CalibrationSettings => ({ ...defaultCalibration, ...over })

/**
 * A prediction drawn against uncalibrated defaults looks exactly like one drawn against a measured
 * roaster - same axes, same confident line. Distinguishing them is the whole job.
 */
describe('where the applied thermal model came from', () => {
  it('names the saved calibration when the live coefficients are exactly its patch', () => {
    const provenance = calibrationProvenance(applied(patch), [snapshot()], defaultCalibration)
    expect(provenance.grade).toBe('calibrated')
    expect(provenance.calibrated).toBe(true)
    expect(provenance.label).toContain('Model: calibrated from July baseline 4x3')
    expect(provenance.snapshotName).toBe('July baseline 4x3')
    expect(provenance.detail).toContain('measured on this roaster')
  })

  it('prefers the newest match when two saved calibrations carry the same patch', () => {
    const older = snapshot({ id: 'a', name: 'Older', createdAt: '2026-05-01T10:00:00.000Z' })
    const newer = snapshot({ id: 'b', name: 'Newer', createdAt: '2026-07-01T10:00:00.000Z' })
    expect(calibrationProvenance(applied(patch), [older, newer], defaultCalibration).snapshotName).toBe('Newer')
  })

  it('still claims provenance from the staging stamp when the snapshot is gone', () => {
    const provenance = calibrationProvenance(
      applied({ ...patch, thermalSourceCapturedAt: '2026-06-15T09:00:00.000Z' }),
      [],
      defaultCalibration,
    )
    expect(provenance.calibrated).toBe(true)
    expect(provenance.label).toContain('calibrated from a pass on')
    expect(provenance.detail).toContain('no longer in the library')
  })

  /**
   * The middle state. Calling the shipped constants "uncalibrated" made a considered estimate sound
   * like noise; calling them calibrated would be a lie. They get their own honest wording.
   */
  it('names the shipped values an estimate, neither calibrated nor noise', () => {
    const provenance = calibrationProvenance(applied(), [snapshot()], defaultCalibration)
    expect(provenance.grade).toBe('estimated')
    expect(provenance.calibrated).toBe(false)
    expect(provenance.label).toBe('Model: estimated starting baseline (not fitted from your machine)')
    expect(provenance.detail).toContain('typical SR800 roast')
    expect(provenance.detail).toContain('plausible but unverified')
  })

  it('recognises the estimate by its own values, not by "nothing was edited"', () => {
    // An unrelated field moving must not turn the estimate into "hand-entered".
    const provenance = calibrationProvenance(applied({ coolingTargetMarginC: 7 }), [], defaultCalibration)
    expect(provenance.grade).toBe('estimated')
  })

  it('warns plainly for hand-entered coefficients', () => {
    const provenance = calibrationProvenance(applied({ heaterGainCPerMinAt10: 44 }), [snapshot()], defaultCalibration)
    expect(provenance.grade).toBe('manual')
    expect(provenance.calibrated).toBe(false)
    expect(provenance.detail).toContain('entered by hand')
    expect(provenance.detail).toContain('SHAPE only')
  })

  it('never claims provenance from a saved calibration that derived nothing', () => {
    const empty = snapshot({ patch: {} })
    expect(calibrationProvenance(applied(), [empty], defaultCalibration).grade).toBe('estimated')
  })
})

/**
 * ============================================================================================
 * WHICH MODEL A PREVIEW IS DRAWN WITH
 * ============================================================================================
 *
 * The roast is solved ON THE CONTROLLER against the controller's own applied set. A preview drawn
 * with anything else answers a question nobody asked - and then reports the gap it created itself as
 * a disagreement. So the controller's set is the top rung of the ladder, and this pins it.
 */
describe('the model source ladder', () => {
  const device = {
    heaterGainCPerMinAt10: 52,
    fanCoolingCPerMinAt10: 19,
    coolingFanCPerMinAt10: 28,
    thermalLossPerMinPerC: 0.17,
    fitId: 'fit-2026-07-27',
    updatedAt: '2026-07-27T09:00:00.000Z',
  }

  it("takes the controller's coefficients over the app's whenever it reports any", () => {
    const merged = previewCalibration(applied({ heaterGainCPerMinAt10: 66 }), device)
    expect(merged.heaterGainCPerMinAt10).toBe(52)
    expect(merged.thermalLossPerMinPerC).toBe(0.17)
    // Only the four thermal coefficients travel; the rest is the app's own and the device has no
    // opinion about it.
    expect(merged.coolingTargetMarginC).toBe(defaultCalibration.coolingTargetMarginC)
  })

  it("falls back to the app's own fit when the controller holds none", () => {
    const merged = previewCalibration(applied({ heaterGainCPerMinAt10: 66 }), undefined)
    expect(merged.heaterGainCPerMinAt10).toBe(66)
    expect(usingControllerModel(undefined)).toBe(false)
    expect(usingControllerModel({ fitId: 'fit-only' })).toBe(false)
    expect(usingControllerModel(device)).toBe(true)
  })

  it('keeps an applied provisional bridge honest after reload and fences it by fit id', () => {
    const provisional = snapshot({
      patch: {
        heaterGainCPerMinAt10: device.heaterGainCPerMinAt10,
        fanCoolingCPerMinAt10: device.fanCoolingCPerMinAt10,
        coolingFanCPerMinAt10: device.coolingFanCPerMinAt10,
        thermalLossPerMinPerC: device.thermalLossPerMinPerC,
      },
      inheritedCoefficients: {
        thermalLossPerMinPerC: { source: 'roaster-applied', value: device.thermalLossPerMinPerC },
      },
      applicationFitId: 'provisional:snap',
    })
    const activeBridge = calibrationProvenance(applied(), [provisional], defaultCalibration, {
      ...device,
      fitId: 'provisional:snap',
    })
    expect(activeBridge.grade).toBe('provisional')
    expect(activeBridge.calibrated).toBe(false)
    expect(activeBridge.detail).toContain('not measured')

    const laterLoadedFit = calibrationProvenance(applied(), [provisional], defaultCalibration, {
      ...device,
      fitId: 'loaded-fit',
    })
    expect(laterLoadedFit.grade).toBe('calibrated')
  })
  it('says on screen that the preview is the roaster’s own set, and names the fit', () => {
    const provenance = calibrationProvenance(applied(), [], defaultCalibration, device)
    expect(provenance.grade).toBe('calibrated')
    expect(provenance.label).toBe('Model: the calibration applied on the roaster (fit fit-2026-07-27)')
    expect(provenance.detail).toContain('what it will try to follow')
  })

  it('names the applied set by the saved calibration it came from, when one matches the fit id', () => {
    const saved = snapshot({ name: 'Spring blend fit', applicationFitId: device.fitId })
    expect(calibrationProvenance(applied(), [saved], defaultCalibration, device).label).toBe(
      'Model: Spring blend fit, applied on the roaster',
    )
  })

  it('keeps the old ladder underneath, untouched, when there is no controller set', () => {
    expect(calibrationProvenance(applied(), [], defaultCalibration, undefined).grade).toBe('estimated')
  })
})
