/**
 * The diagnostic calibration program, and the coefficients the device holds applied.
 *
 * ============================================================================================
 * THE PROGRAM
 * ============================================================================================
 *
 * A serpentine walk over a fan x heat grid (or an explicit step list), holding each pair until the
 * chamber settles or the step cap runs out. The advance rule is firmware 2026-07-26.36's: a minimum
 * dwell, then a settle window over which the reading must stay inside a narrow band, then a cap.
 * `last_step_advance` reports which of the two ended the step, and the analysis that consumes the
 * resulting log cares about the difference.
 *
 * The grid expansion is `expandBaselineGrid` from `src/domain/calibrationProgram.ts` - the app's own
 * copy of the firmware's serpentine - so the mock cannot walk the grid in a different order from the
 * one the browser previews.
 *
 * **Fast-forward.** A real grid pass is half an hour of dwell. Nobody reviews one in a dev loop at
 * that speed, so the mock runs the whole simulation clock faster while a calibration program is
 * active (10x by default, `CRACKLE_MOCK_CALIBRATION_SPEED`). It is the CLOCK that is scaled, not the
 * timers, so the plant still settles properly and the recorded log is a physically coherent pass -
 * it simply arrives in three minutes instead of thirty.
 *
 * ============================================================================================
 * APPLIED COEFFICIENTS
 * ============================================================================================
 *
 * Storage only, exactly as on the device: the controller is the durable source of truth any browser
 * reads back, and the firmware does not use them for control. The mock DOES use them for one thing
 * the firmware also does - inverting a journey - because that is what makes the plausibility gate
 * matter. `PLAUSIBLE` is the firmware's range check, mirrored, and a set outside it is refused with
 * a 400 rather than stored and later inverted into saturation.
 */

import { CALIBRATION_LIMITS, expandBaselineGrid } from '../src/domain/calibrationProgram'
import type { CalibrationStep, StepAdvance } from '../src/domain/types'
import { CALIBRATION_SPEED, PLAUSIBLE } from './config'
import type { AppliedCoefficients, ProgramHost } from './host'
import type { Refusal } from './roast'

export interface CalibrationParams {
  steps: CalibrationStep[]
  maxStepSeconds: number
  minStepSeconds: number
  settleSeconds: number
  settleBandC: number
}

const level = (raw: string): number | undefined => {
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= CALIBRATION_LIMITS.level.max ? value : undefined
}

const levelList = (raw: string, maximum: number, label: string): number[] | Refusal => {
  const cells = raw
    .split(',')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
  if (cells.length < 1 || cells.length > maximum)
    return { status: 400, message: `${label} must hold 1 to ${maximum} levels` }
  const levels: number[] = []
  for (const cell of cells) {
    const value = level(cell)
    if (value === undefined || value <= 0)
      return { status: 400, message: `"${cell}" is not a ${label} level above 0.0` }
    levels.push(value)
  }
  return levels
}

const bounded = (
  raw: string | null,
  fallback: number,
  range: { min: number; max: number },
  label: string,
): number | Refusal => {
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    return { status: 400, message: `${label} must be between ${range.min} and ${range.max}` }
  }
  return value
}

const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && 'status' in value

/** The `/api/calibration/start` arguments the browser sends, parsed to a program. */
export const parseCalibrationArgs = (args: URLSearchParams): CalibrationParams | Refusal => {
  let steps: CalibrationStep[]
  const rawFans = args.get('fans')
  const rawHeats = args.get('heats')
  if (rawFans !== null || rawHeats !== null) {
    const fans = levelList(rawFans ?? '', CALIBRATION_LIMITS.maximumGridFans, 'fans')
    if (isRefusal(fans)) return fans
    const heats = levelList(rawHeats ?? '', CALIBRATION_LIMITS.maximumGridHeats, 'heats')
    if (isRefusal(heats)) return heats
    if (fans.length * heats.length > CALIBRATION_LIMITS.maximumProgramSteps) {
      return { status: 400, message: `the expanded grid exceeds ${CALIBRATION_LIMITS.maximumProgramSteps} steps` }
    }
    steps = expandBaselineGrid(fans, heats)
  } else {
    const cells = (args.get('steps') ?? '')
      .split(',')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)
    if (cells.length < 1 || cells.length > CALIBRATION_LIMITS.maximumSteps) {
      return { status: 400, message: `steps must hold 1 to ${CALIBRATION_LIMITS.maximumSteps} fan:heat pairs` }
    }
    steps = []
    for (const cell of cells) {
      const parts = cell.split(':')
      if (parts.length !== 2) return { status: 400, message: `"${cell}" is not a fan:heat pair` }
      const fan = level(parts[0])
      const heat = level(parts[1])
      if (fan === undefined || heat === undefined) return { status: 400, message: `"${cell}" is outside 0.0 to 10.0` }
      if (fan === 0 && heat > 0) return { status: 400, message: `"${cell}" needs fan above 0` }
      steps.push({ fan, heat })
    }
  }

  const maxStepSeconds = bounded(args.get('step_seconds'), 300, CALIBRATION_LIMITS.maxStepSeconds, 'step_seconds')
  if (isRefusal(maxStepSeconds)) return maxStepSeconds
  const minStepSeconds = bounded(
    args.get('min_step_seconds'),
    20,
    CALIBRATION_LIMITS.minStepSeconds,
    'min_step_seconds',
  )
  if (isRefusal(minStepSeconds)) return minStepSeconds
  const settleSeconds = bounded(args.get('settle_seconds'), 20, CALIBRATION_LIMITS.settleSeconds, 'settle_seconds')
  if (isRefusal(settleSeconds)) return settleSeconds
  const rawBand = args.get('settle_band_tenths_c')
  const settleBandC = rawBand === null ? 0.2 : Number(rawBand) / 10
  if (
    !Number.isFinite(settleBandC) ||
    settleBandC < CALIBRATION_LIMITS.settleBandC.min ||
    settleBandC > CALIBRATION_LIMITS.settleBandC.max
  ) {
    return { status: 400, message: 'settle_band_tenths_c must resolve to 0.3 to 10.0 C' }
  }
  if (minStepSeconds > maxStepSeconds) return { status: 400, message: 'min_step_seconds cannot exceed step_seconds' }

  return { steps, maxStepSeconds, minStepSeconds, settleSeconds, settleBandC }
}

export class CalibrationProgram {
  active = true
  readonly startedEpoch: number
  stepIndex = 0
  lastStepAdvance?: StepAdvance
  endReason: string = 'none'
  /** How much faster than wall-clock this program's simulated time runs. */
  readonly speed: number

  private stepStartedMs: number
  private transitionOriginC?: number
  private transitionObserved = false
  private window: Array<{ atMs: number; c: number }> = []

  constructor(
    readonly params: CalibrationParams,
    host: ProgramHost,
    speed = CALIBRATION_SPEED,
  ) {
    this.stepStartedMs = host.nowMs
    this.hostNowMs = host.nowMs
    this.startedEpoch = host.epochSeconds()
    this.speed = speed
  }

  get stepCount() {
    return this.params.steps.length
  }
  get current(): CalibrationStep | undefined {
    return this.params.steps[this.stepIndex]
  }
  get stepElapsedSec() {
    return Math.max(0, (this.hostNowMs - this.stepStartedMs) / 1000)
  }
  get settleState(): 'minimum_dwell' | 'waiting_for_transition' | 'checking' | 'settled' | 'capped' {
    const heldSec = this.stepElapsedSec
    if (heldSec >= this.params.maxStepSeconds) return 'capped'
    if (heldSec < this.params.minStepSeconds) return 'minimum_dwell'
    if (!this.transitionObserved) return 'waiting_for_transition'
    const windowStartMs = this.hostNowMs - this.params.settleSeconds * 1000
    if (this.window.length < 2 || this.window[0].atMs > windowStartMs + 1000) return 'checking'
    const values = this.window.map((entry) => entry.c)
    // Firmware's band is +/- settleBandC, hence a full-window range of 2*band.
    return Math.max(...values) - Math.min(...values) <= 2 * this.params.settleBandC ? 'settled' : 'checking'
  }

  private hostNowMs = 0

  tick(host: ProgramHost, leaseExpired: boolean) {
    this.hostNowMs = host.nowMs
    if (!this.active) return
    if (host.actuator.fault !== 'none') return this.end(host, 'fault')
    if (leaseExpired) return this.end(host, 'heat_lease_expired')

    const step = this.current
    if (!step) return this.end(host, 'completed')

    const refusal = host.actuator.request(host.nowMs, step.fan, step.heat)
    if (refusal) return this.end(host, 'step_rejected')

    const reading = host.reading()
    if (reading !== undefined) {
      if (this.transitionOriginC === undefined) {
        this.transitionOriginC = reading
      } else if (!this.transitionObserved && Math.abs(reading - this.transitionOriginC) > this.params.settleBandC) {
        // Dead time is flat, but it is not a plateau. Start the stability window only after the
        // command produces a response larger than the authored +/- tolerance, exactly as firmware.
        this.transitionObserved = true
        this.window = []
      }
      if (this.transitionObserved) this.window.push({ atMs: host.nowMs, c: reading })
    }
    const windowStartMs = host.nowMs - this.params.settleSeconds * 1000
    while (this.window.length > 0 && this.window[0].atMs < windowStartMs) this.window.shift()

    const heldSec = (host.nowMs - this.stepStartedMs) / 1000
    if (heldSec >= this.params.maxStepSeconds) return this.advance(host, 'capped')
    if (heldSec < this.params.minStepSeconds || !this.transitionObserved) return
    // The configured band is a +/- tolerance; firmware therefore permits a 2*band window range.
    if (this.window.length < 2 || this.window[0].atMs > windowStartMs + 1000) return
    const values = this.window.map((entry) => entry.c)
    if (Math.max(...values) - Math.min(...values) <= 2 * this.params.settleBandC) this.advance(host, 'settled')
  }

  private advance(host: ProgramHost, how: StepAdvance) {
    this.lastStepAdvance = how
    this.stepIndex += 1
    this.stepStartedMs = host.nowMs
    this.transitionOriginC = undefined
    this.transitionObserved = false
    this.window = []
    if (this.stepIndex >= this.params.steps.length) this.end(host, 'completed')
  }

  requestStop(host: ProgramHost) {
    if (this.active) this.end(host, 'stopped')
  }

  private end(host: ProgramHost, reason: string) {
    if (!this.active) return
    this.active = false
    this.endReason = reason
    host.actuator.stop(host.nowMs, host.plant.probeC)
  }
}

/**
 * `POST /api/calibration/apply`. Every coefficient must be finite and physically plausible: a set
 * with no heater authority would be inverted into permanent maximum heat, so it is refused here as
 * the firmware refuses it, naming the field.
 */
export const parseAppliedCoefficients = (
  args: URLSearchParams,
  epochSeconds: number,
): AppliedCoefficients | Refusal => {
  const fields = ['heater_gain', 'fan_cooling', 'cooling_fan', 'loss_per_min'] as const
  const values: Record<string, number> = {}
  for (const field of fields) {
    const value = Number(args.get(field))
    const range = PLAUSIBLE[field]
    if (!Number.isFinite(value)) return { status: 400, message: `${field} is not a number` }
    if (value < range.min || value > range.max) {
      return { status: 400, message: `${field} is ${value} but must be between ${range.min} and ${range.max}` }
    }
    values[field] = value
  }
  return {
    heater_gain: values.heater_gain,
    fan_cooling: values.fan_cooling,
    cooling_fan: values.cooling_fan,
    loss_per_min: values.loss_per_min,
    // The firmware sanitizes `fit_id` to this alphabet and echoes what it stored, so the browser's
    // divergence check compares like with like.
    fit_id: (args.get('fit_id') ?? '').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 47),
    applied_epoch: epochSeconds,
  }
}

/** The applied set, as `/api/status` reports it. Absent reads as `{present: false}`. */
export const appliedCalibrationDocument = (applied: AppliedCoefficients | undefined) =>
  applied === undefined
    ? { present: false }
    : {
        present: true,
        heater_gain: Math.round(applied.heater_gain * 1000) / 1000,
        fan_cooling: Math.round(applied.fan_cooling * 1000) / 1000,
        cooling_fan: Math.round(applied.cooling_fan * 1000) / 1000,
        loss_per_min: Math.round(applied.loss_per_min * 10000) / 10000,
        fit_id: applied.fit_id,
        applied_epoch: applied.applied_epoch,
      }
