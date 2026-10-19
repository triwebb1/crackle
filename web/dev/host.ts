/**
 * What a program running on the mock controller is allowed to see.
 *
 * The manual session, the roast executor and the calibration program are all siblings on the real
 * device - they sit above the actuator, own their own Heat leases, and share the same immediate
 * stop behavior - so they are given the same narrow view here rather than a reference to the whole
 * device. It keeps the dependency graph acyclic and it keeps a program from reaching sideways into
 * another program's state, which is the bug this shape exists to prevent.
 */

import type { CalibrationSettings } from '../src/domain/types'
import type { Actuator } from './actuator'
import type { Archive } from './archive'
import type { Plant } from './plant'

export interface AppliedCoefficients {
  heater_gain: number
  fan_cooling: number
  cooling_fan: number
  loss_per_min: number
  fit_id: string
  applied_epoch: number
}

export interface ProgramHost {
  /** The simulated clock, in milliseconds since boot. Never `Date.now()`. */
  readonly nowMs: number
  readonly actuator: Actuator
  readonly archive: Archive
  readonly plant: Plant
  /** The thermocouple, or undefined when the reading is invalid or stale. */
  reading(): number | undefined
  /** Unix seconds from the simulated clock, so a seeded log can be dated in the past. */
  epochSeconds(): number
  /** The coefficients the DEVICE holds, which is what a journey inverts. */
  applied(): AppliedCoefficients | undefined
  /** Those coefficients as a full model, for `journeyControlStep`. */
  modelCalibration(): CalibrationSettings
}
