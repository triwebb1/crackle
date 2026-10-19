import { isStatusStale } from './startGate'
import type { CalibrationForm, CalibrationStep, ControllerStatus } from './types'

// Firmware 2026-07-26.36 bounds, mirrored so an obviously bad request never leaves the browser.
export const CALIBRATION_LIMITS = {
  maximumSteps: 12,
  maximumProgramSteps: 48,
  maximumGridFans: 6,
  maximumGridHeats: 7,
  level: { min: 0, max: 10 },
  maxStepSeconds: { min: 15, max: 300 },
  minStepSeconds: { min: 5, max: 120 },
  settleSeconds: { min: 2, max: 30 },
  settleBandC: { min: 0.2, max: 10 },
} as const

/**
 * Firmware 2026-07-26.36 defaults. A wide band held briefly - 5 °C for 3 s - passes on the
 * mid-transient slope of a large transition: every step reports `settled` in about 13 s, taus come
 * back at 3-5 s, and a fan row can read as DECREASING with heat. A narrow band held for much longer
 * is what makes a settled advance mean settled. The analysis does not trust that flag either, but
 * the program should still be right at the source.
 */
export const DEFAULT_MIN_STEP_SECONDS = 20
export const DEFAULT_MAX_STEP_SECONDS = 300
export const DEFAULT_SETTLE_SECONDS = 20
export const DEFAULT_SETTLE_BAND_C = 0.2
// Coarse grids are deliberate: large transitions settle unambiguously and the phase-power mapping
// between points is smooth, so wide spacing measures more in less time than a fine grid would.
export const DEFAULT_GRID_FANS = [1, 4, 7, 10]
export const DEFAULT_GRID_HEATS = [1, 5, 10]

export interface ParsedSteps {
  steps: CalibrationStep[]
  error?: string
}

export interface ParsedLevels {
  levels: number[]
  error?: string
}

const level = (token: string) => (/^\d+(\.\d+)?$/.test(token) ? Number(token) : Number.NaN)

/**
 * "3:1, 3:5, 5:5" -> [{fan:3,heat:1}, {fan:3,heat:5}, {fan:5,heat:5}].
 *
 * Up to 12 comma-separated `fan:heat` pairs, each level 0.0-10.0. Heat 0 is a fan-only recovery
 * step; fan 0 is legal only alongside heat 0, which is a passive-decay step. This mirrors the
 * firmware's own `parseStepPairsArg`, so the browser rejects what the controller would reject.
 */
export const parseStepPairs = (raw: string): ParsedSteps => {
  const cells = raw
    .split(',')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
  if (cells.length === 0) return { steps: [], error: 'Enter at least one fan:heat step' }
  if (cells.length > CALIBRATION_LIMITS.maximumSteps)
    return { steps: [], error: `The firmware accepts at most ${CALIBRATION_LIMITS.maximumSteps} steps` }
  const steps: CalibrationStep[] = []
  for (const cell of cells) {
    const parts = cell.split(':').map((part) => part.trim())
    if (parts.length !== 2 || parts.some((part) => part.length === 0))
      return { steps: [], error: `"${cell}" is not a fan:heat pair` }
    const [fan, heat] = parts.map(level)
    if (!Number.isFinite(fan) || !Number.isFinite(heat)) return { steps: [], error: `"${cell}" is not a fan:heat pair` }
    if (fan < 0 || fan > 10 || heat < 0 || heat > 10) return { steps: [], error: `"${cell}" is outside 0.0 to 10.0` }
    if (fan === 0 && heat > 0)
      return { steps: [], error: `"${cell}" needs fan above 0; fan 0 is only allowed with heat 0` }
    steps.push({ fan, heat })
  }
  return { steps }
}

export const formatStepPairs = (steps: CalibrationStep[]) => steps.map((pair) => `${pair.fan}:${pair.heat}`).join(',')

// Baseline grid axes: every level must be nonzero, because a grid axis of 0 has no meaning.
export const parseLevelList = (raw: string, label: string, maximum: number): ParsedLevels => {
  const cells = raw
    .split(',')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
  if (cells.length === 0) return { levels: [], error: `Enter at least one ${label} level` }
  if (cells.length > maximum) return { levels: [], error: `At most ${maximum} ${label} levels` }
  const levels: number[] = []
  for (const cell of cells) {
    const value = level(cell)
    if (!Number.isFinite(value)) return { levels: [], error: `"${cell}" is not a ${label} level` }
    if (value <= 0 || value > 10) return { levels: [], error: `"${cell}" must be above 0.0 and at most 10.0` }
    levels.push(value)
  }
  return { levels }
}

/**
 * Expands a baseline grid exactly as the firmware does, in serpentine order: each fan group
 * traverses the heat list in the opposite direction to the previous one, so every fan change
 * happens at the shared endpoint heat and no recovery steps are needed. Every transition is
 * therefore a measurement - heat steps at constant fan, fan steps at constant heat - and the grid
 * is exactly fans x heats steps. Descending fans leave the hottest, lowest-airflow points last.
 */
export const expandBaselineGrid = (fans: number[], heats: number[]): CalibrationStep[] =>
  fans.flatMap((fan, index) => (index % 2 === 1 ? [...heats].reverse() : heats).map((heat) => ({ fan, heat })))

export const gridSummary = (fans: number[], heats: number[]) =>
  `${fans.length}x${heats.length} grid, fans ${fans.join('/')}, heats ${heats.join('/')}`

export interface ProgramFormInput {
  fansRaw: string
  heatsRaw: string
  stepsRaw: string
  /**
   * Which input is in force. Inferring this from whether the sequence field has content would
   * change the mode as a side effect of typing, and the operator could not see what the program
   * was going to be. It is a control the operator sets.
   */
  mode: CalibrationForm
}

export interface ResolvedProgramForm {
  form: CalibrationForm
  /** True when the explicit sequence is filled in and is therefore what will run. */
  overridden: boolean
  fans: number[]
  heats: number[]
  steps: CalibrationStep[]
  error?: string
}

/**
 * One program form with an explicit mode.
 *
 * The firmware accepts either a `fans`/`heats` grid or a `steps` list, and the form mirrors that
 * with a segmented control rather than by guessing from field contents. Only the selected mode is
 * validated, so a half-typed sequence sitting in a collapsed field cannot block a grid pass, and
 * the summary under Start always describes the program that would actually run.
 */
export const resolveProgramForm = ({ fansRaw, heatsRaw, stepsRaw, mode }: ProgramFormInput): ResolvedProgramForm => {
  if (mode === 'steps') {
    const parsed = parseStepPairs(stepsRaw)
    return { form: 'steps', overridden: true, fans: [], heats: [], steps: parsed.steps, error: parsed.error }
  }
  const fans = parseLevelList(fansRaw, 'fan', CALIBRATION_LIMITS.maximumGridFans)
  const heats = parseLevelList(heatsRaw, 'heat', CALIBRATION_LIMITS.maximumGridHeats)
  const error = fans.error ?? heats.error
  return {
    form: 'grid',
    overridden: false,
    fans: fans.levels,
    heats: heats.levels,
    steps: error ? [] : expandBaselineGrid(fans.levels, heats.levels),
    error,
  }
}

export interface CalibrationGateInput {
  status: ControllerStatus
  nowMs: number
  paramError?: string
  busy: boolean
  /** Baseline runs write evidence to the recording archive; applying a calibration does not. */
  requiresRecordingStorage?: boolean
}

/**
 * Start is an explicit allow-list, exactly like the roast start gate: connected, fresh, no lockout,
 * no fault, the diagnosticTests capability advertised, no program already running, and valid
 * parameters. The proof-phase typed confirmation is gone with the arm ceremony; a single confirm
 * dialog remains as pocket-tap protection. This gate governs a diagnostic program only; it grants
 * nothing to roast execution, which stays blocked by startGate.ts.
 */
export const calibrationReadinessBlockedReason = (status: ControllerStatus): string | undefined => {
  if (status.calibrationReady !== false) return undefined
  if (status.calibrationReadiness === 'sensor_invalid')
    return 'The thermocouple must report a valid temperature before calibration can start'
  if (status.calibrationReadiness === 'sensor_fault_latched')
    return 'The thermocouple fault is latched; power-cycle the roaster before calibration'
  if (status.calibrationReadiness === 'too_hot')
    return 'Let the empty roaster cool to 60 °C or below before calibration'
  if (status.calibrationReadiness === 'stabilizing') {
    const remainingSec = Math.max(1, Math.ceil((10_000 - (status.calibrationStableForMs ?? 0)) / 1000))
    return `Keep the empty roaster steady for ${remainingSec} more second${remainingSec === 1 ? '' : 's'}`
  }
  return 'The roaster is checking that the probe is cool and stable'
}

export const calibrationStartBlockedReason = ({
  status,
  nowMs,
  paramError,
  busy,
  requiresRecordingStorage = true,
}: CalibrationGateInput): string | undefined => {
  if (busy) return 'A calibration command is in flight'
  if (!status.connected) return 'The roaster is not connected'
  if (isStatusStale(status, nowMs)) return 'The roaster has stopped reporting'
  if (status.manualLockout || status.lifecycle === 'MANUAL_LOCKOUT' || status.manual?.active)
    return 'Stop manual controls before starting calibration'
  if (status.fault || status.lifecycle === 'FAULT') return status.fault ?? 'The roaster has latched a fault'
  if (!status.capabilities.diagnosticTests) return 'This firmware does not offer calibration runs'
  if (status.calibration?.active) return 'A calibration program is already running'
  if (status.restoreMaintenance?.active || status.restoreMaintenance?.incomplete) {
    return 'Finish storage maintenance in Settings before starting calibration'
  }
  if (requiresRecordingStorage && status.thermalLog?.available === false) {
    return 'Thermal recording memory is unavailable; restart or service the roaster before calibration'
  }
  if (requiresRecordingStorage && status.logArchive?.needsFormat) {
    return 'Format roaster storage in Settings before recording a baseline'
  }
  if (requiresRecordingStorage && status.logArchive && !status.logArchive.mounted) {
    return 'Roaster recording storage is unavailable; restore it before calibration'
  }
  const readiness = calibrationReadinessBlockedReason(status)
  if (readiness) return readiness
  if (paramError) return paramError
  return undefined
}

// A worst case, not a duration: adaptive settling usually shortens it.
export const programMaximumSec = (steps: CalibrationStep[], maxStepSeconds: number) => steps.length * maxStepSeconds
