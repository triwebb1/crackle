import { ESTIMATED_BASELINE_COEFFICIENTS, ESTIMATED_BASELINE_MASS_G } from '../domain/estimatedBaseline'
import type { CalibrationSettings } from '../domain/types'

/**
 * The shipped calibration. The electrical mapping is the firmware's own configuration; the four
 * thermal coefficients are the ESTIMATED bean-scale baseline documented in `estimatedBaseline.ts` -
 * chosen so the model reproduces a canonical SR800 roast rather than picked arbitrarily, and
 * labelled as an estimate everywhere a derived temperature is shown.
 */
export const defaultCalibration: CalibrationSettings = {
  referenceBatchMassG: ESTIMATED_BASELINE_MASS_G,
  ...ESTIMATED_BASELINE_COEFFICIENTS,
  coolingTargetMarginC: 5,
  updatedAt: new Date().toISOString(),
}
