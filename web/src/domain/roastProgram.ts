import { isFloored, minimumFanForHeat } from './actuatorFloors'
import { THERMAL_FIELDS } from './calibrationProvenance'
import {
  type CoefficientDivergence,
  type CoefficientField,
  coefficientDivergence,
  coefficientLabel,
  DEVICE_COEFFICIENT_PLACES,
  type DeviceCoefficients,
  sanitizeFitId,
} from './deviceLogs'
import { zoneFeasibility } from './journeyControl'
import { manualParamError } from './manualControl'
import { isAuthoredCoolingZone } from './model'
import type {
  CalibrationRun,
  CalibrationSettings,
  CalibrationSnapshot,
  ControllerStatus,
  Profile,
  RoastEndReason,
  RoastRun,
  ThermalIntent,
  ThermalSegment,
  TimedProfile,
} from './types'

/**
 * Handing a whole roast to the controller, in the exact terms `POST /api/roast/start` accepts.
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ============================================================================================
 *
 * Requirement: an operator can start a roast, close the browser, and expect the controller to keep
 * running it. So the browser does not run a roast; it DEFINES one, hands the whole plan over in a
 * single request, and afterwards is a spectator with no privileged role. Nothing in the roast path depends on this tab still being open, and nothing here
 * may ever acquire such a dependency.
 *
 * That makes serialization load-bearing in a way a display function is not. What leaves this file is
 * the entire specification of an unattended twenty-minute run driving a 1500 W heating element, and
 * the controller will run exactly what it is given. Two rules follow, and both are enforced below:
 *
 *   1. **Every bound the firmware checks is checked here first**, in the firmware's own units, so a
 *      request that would be refused never leaves the browser and the operator is told why in words
 *      rather than through an HTTP status.
 *   2. **Anything the firmware sanitizes is sanitized here first.** The roast name is reduced to the
 *      firmware's alphabet before it is sent, so what comes back in `status.roast.name` is
 *      byte-identical to what went out - which is what lets the history import match a recording to
 *      a profile by name at all. This is the same discipline `sanitizeFitId` already applies to the
 *      applied-calibration round trip, for the same reason.
 *
 * ============================================================================================
 * MODEL FEASIBILITY IS ADVISORY
 * ============================================================================================
 *
 * The controller never silently advances past a temperature it did not attain. It also owns a
 * finite runtime envelope: twice the plan's nominal duration plus ten minutes, followed by an
 * immediate full stop and `envelope_timeout`. That device boundary is authoritative; a browser
 * model estimate is useful evidence but cannot become a second, stricter safety policy.
 *
 * So `zoneFeasibility` runs against every zone, at the calibration the DEVICE is actually holding -
 * that set or none at all, never a substitute. An estimated miss is a WARNING, with the fit error,
 * replay error, requested target, model ceiling, and measured reachability when available. Actual
 * firmware gates - malformed plans, absent calibration, sensor faults, or an active operation -
 * remain blockers.
 */

/** The firmware's confirmation token, mirrored so a stray request cannot satisfy it. */
export const START_ROAST_CONFIRM = 'START_ROAST'

/**
 * The device-owned runtime envelope for timed and Journey roasts. The firmware stops only after
 * this whole-plan allowance expires; individual zones have no private timeout because Journey
 * advancement is temperature-gated.
 */
export const ROAST_ENVELOPE_MULTIPLIER = 2
export const ROAST_ENVELOPE_MARGIN_SEC = 600
export const roastRuntimeEnvelopeSec = (nominalSec: number): number =>
  Math.max(0, Math.floor(nominalSec)) * ROAST_ENVELOPE_MULTIPLIER + ROAST_ENVELOPE_MARGIN_SEC

/** Every bound `POST /api/roast/start` enforces, in the firmware's own units. */
export const ROAST_LIMITS = {
  mass: { min: 20, max: 2000, default: 225 },
  steps: { min: 1, max: 24 },
  zones: { min: 1, max: 12 },
  stepSeconds: { min: 1, max: 1800 },
  zoneSeconds: { min: 5, max: 1800 },
  level: { min: 0, max: 10 },
  /** A non-zero level below this is lifted to it by the firmware, so it is lifted here too. */
  levelFloor: 0.1,
  endC: { min: 0, max: 300 },
  nameBytes: 32,
} as const

/**
 * The firmware sanitizes `name` exactly as it sanitizes `fit_id`, except that a space survives:
 * anything outside `[A-Za-z0-9._:- ]` becomes `-`, the result is truncated to 32 bytes, and a name
 * that sanitizes to nothing becomes `roast`. Doing it here rather than discovering it in the echo is
 * what makes the name a reliable join key for the history import.
 */
export const DEFAULT_ROAST_NAME = 'roast'
const NAME_ALPHABET = /[A-Za-z0-9._:\- ]/

/**
 * Done over BYTES rather than over characters, because the firmware's limit is 32 bytes and its
 * substitution is per byte. A three-byte character becomes three dashes on the device, and a
 * character-wise version here would produce one - so the name that came back would differ from the
 * name that went out, and the history import's only join key would be broken for exactly the names
 * most likely to need it. Every output byte is ASCII, so the resulting string's length IS its byte
 * length and the truncation is exact.
 *
 * Nothing is trimmed: the firmware substitutes an empty result and nothing else, and quietly
 * trimming here would be a second divergence of the same kind.
 */
export const sanitizeRoastName = (value: string): string => {
  let reduced = ''
  for (const byte of new TextEncoder().encode(value)) {
    if (reduced.length >= ROAST_LIMITS.nameBytes) break
    const char = String.fromCharCode(byte)
    reduced += NAME_ALPHABET.test(char) ? char : '-'
  }
  return reduced.length === 0 ? DEFAULT_ROAST_NAME : reduced
}

/** A level in the firmware's own serialization: one decimal, with the non-zero floor applied. */
// The floor is applied BEFORE rounding: rounding first turned any value below 0.05 into 0, so a
// nonzero level that validated (e.g. a fan maximum of 0.04) went out as "off".
const level = (value: number): string => {
  const bounded = Math.max(0, Math.min(ROAST_LIMITS.level.max, value))
  const floored = bounded > 0 && bounded < ROAST_LIMITS.levelFloor ? ROAST_LIMITS.levelFloor : bounded
  return String(Math.round(floored * 10) / 10)
}

const seconds = (value: number) => Math.max(0, Math.round(value))

export interface RoastStepPlan {
  fan: number
  heat: number
  durationSec: number
}

/**
 * A timed profile as the ordered `fan:heat:seconds` steps it has always meant.
 *
 * The reading is the editor's own, not a new one: a point is held until the next point's time, and
 * the LAST point is held for `coolDurationSec` - which is literally what editing the last row's
 * duration cell writes. The one extra rule mirrors `simulateTimed`: a profile with no authored
 * terminal cooling point keeps its final authored dwell and then gets the trailing cool window as
 * an explicit final step at `coolFan`, so safety never erases an authored Heat instruction.
 */
export const timedRoastSteps = (profile: TimedProfile): RoastStepPlan[] => {
  const sorted = [...profile.points].sort((a, b) => a.timeSec - b.timeSec)
  if (sorted.length === 0) return []
  const coolSec = seconds(Number.isFinite(profile.coolDurationSec) ? profile.coolDurationSec : 0)
  const endsWithCooling = sorted.at(-1)?.heat === 0
  const steps = sorted.map((point, index) => ({
    fan: point.fan,
    heat: point.heat,
    durationSec: index < sorted.length - 1 ? seconds(sorted[index + 1].timeSec - point.timeSec) : coolSec,
  }))
  if (endsWithCooling) return steps.filter((step) => step.durationSec > 0)
  // No terminal cooling row was authored. Preserve the final point's dwell, then append the same
  // bounded cooling window the preview runs; a safety transformation must not erase authored Heat.
  return [...steps, { fan: profile.coolFan, heat: 0, durationSec: coolSec }].filter((step) => step.durationSec > 0)
}

// Heat on means Fan 1.0 or higher (a heat-carrying bed must circulate). The firmware lifts a lower authored
// fan at parse time, so it is lifted here first — what goes out is what the device will echo back.
export const serializeTimedSteps = (steps: RoastStepPlan[]): string =>
  steps
    .map(
      (step) =>
        `${level(Math.max(step.fan, minimumFanForHeat(step.heat)))}:${level(step.heat)}:${seconds(step.durationSec)}`,
    )
    .join(',')

/**
 * A journey's zones in the documented six-field form. **Zone start temperatures are never
 * authored**: zone 0 starts at `start` and every later zone starts where the one before it ended,
 * which is the same relinking the profile editor does, so only the endpoint travels.
 *
 * Durations are always sent as explicit seconds rather than as the `r<rate>` form. The rate form is
 * a convenience for a hand-typed request; a derived duration that the firmware then range-checks is
 * one more place the browser's arithmetic and the device's could part company for no benefit.
 */
export const serializeJourneyZones = (segments: ThermalSegment[]): string => {
  const endOnWire = (zone: ThermalSegment) => Math.round(zone.endC * 10) / 10
  return segments
    .map((zone, index) => {
      const endC = endOnWire(zone)
      // The device relinks: zone N starts where zone N-1's WIRE endpoint is.
      const deviceStartC = index === 0 ? zone.startC : endOnWire(segments[index - 1])
      // A zone handed over as cooling that the device would NOT solve as cooling (its relinked span
      // is inside the hold band or rising) must not arrive as a heat-allowed hold: its Heat band
      // travels as 0:0. `effectiveThermalIntent` already produces such zones; this is the wire's own
      // guarantee for any caller.
      const unheated = isAuthoredCoolingZone(zone) && !isAuthoredCoolingZone({ startC: deviceStartC, endC })
      return [
        endC,
        seconds(zone.durationSec),
        level(zone.fanMin),
        level(zone.fanMax),
        unheated ? level(0) : level(zone.heatMin),
        unheated ? level(0) : level(zone.heatMax),
      ].join(':')
    })
    .join(';')
}

const outside = (value: number, { min, max }: { min: number; max: number }) =>
  !Number.isFinite(value) || value < min || value > max

/** Every bound the firmware would reject a `steps=` argument for, checked before it is sent. */
export const timedStepsError = (steps: RoastStepPlan[]): string | undefined => {
  if (steps.length < ROAST_LIMITS.steps.min || steps.length > ROAST_LIMITS.steps.max) {
    return `A timed roast needs 1 to ${ROAST_LIMITS.steps.max} steps; this profile makes ${steps.length}`
  }
  for (const [index, step] of steps.entries()) {
    const at = `Step ${index + 1}`
    if (outside(step.fan, ROAST_LIMITS.level) || outside(step.heat, ROAST_LIMITS.level))
      return `${at}: fan and heat must be between 0.0 and 10.0`
    if (step.fan === 0 && step.heat > 0) return `${at}: fan 0 is only allowed with heat 0`
    if (outside(step.durationSec, ROAST_LIMITS.stepSeconds))
      return `${at}: each step must run 1 to 1800 seconds, and this one is ${seconds(step.durationSec)}`
  }
  return undefined
}

/** Every bound the firmware would reject a `zones=` argument for, checked before it is sent. */
export const journeyZonesError = (segments: ThermalSegment[]): string | undefined => {
  if (segments.length < ROAST_LIMITS.zones.min || segments.length > ROAST_LIMITS.zones.max) {
    return `A journey roast needs 1 to ${ROAST_LIMITS.zones.max} zones; this profile has ${segments.length}`
  }
  for (const [index, zone] of segments.entries()) {
    const at = `Zone ${index + 1}`
    if (outside(zone.endC, ROAST_LIMITS.endC)) return `${at}: the end temperature must be between 0 and 300 °C`
    if (outside(zone.durationSec, ROAST_LIMITS.zoneSeconds)) return `${at}: a zone must be 5 to 1800 seconds long`
    for (const field of ['fanMin', 'fanMax', 'heatMin', 'heatMax'] as const) {
      if (outside(zone[field], ROAST_LIMITS.level)) return `${at}: ${field} must be between 0.0 and 10.0`
    }
    if (zone.fanMin > zone.fanMax) return `${at}: the fan minimum is above its maximum`
    if (zone.heatMin > zone.heatMax) return `${at}: the heat minimum is above its maximum`
    if (zone.fanMax <= 0) return `${at}: the fan maximum must be above 0 - a roast always needs airflow`
  }
  return undefined
}

export const massError = (massG: number | undefined): string | undefined =>
  massG === undefined || outside(massG, ROAST_LIMITS.mass) || !Number.isInteger(massG)
    ? `Batch weight must be a whole number of grams between ${ROAST_LIMITS.mass.min} and ${ROAST_LIMITS.mass.max}`
    : undefined

/**
 * The form-encoded arguments of one `POST /api/roast/start`, ready to send and easy to assert on.
 *
 * `record` is the firmware's optional detail selector: `'0'` stores the same authoritative roast
 * archive at a compact 10 s cadence; absence keeps 1 s detail. `record=1` would only be a redundant
 * second spelling of the default.
 */
export type RoastStartArgs =
  | ({ mode: 'timed'; confirm: string; name: string; mass: string; steps: string; record?: '0' } & ProfileIdentityArgs)
  | ({
      mode: 'journey'
      confirm: string
      name: string
      mass: string
      zones: string
      start: string
      record?: '0'
    } & ProfileIdentityArgs)
  | { mode: 'manual'; confirm: string; name: string; mass: string; fan: string; heat: string; record?: '0' }

export interface ManualRoastRequestInput {
  name: string
  massG?: number
  fan: number
  heat: number
}

/** Build the one safe, validated hand-off that begins a manual roast on the controller. */
export const manualRoastStartArgs = ({ name, massG, fan, heat }: ManualRoastRequestInput): RoastStartArgs | string => {
  const badMass = massError(massG)
  if (badMass) return badMass
  const badLevels = manualParamError({ fan, heat })
  if (badLevels) return badLevels
  return {
    mode: 'manual',
    confirm: START_ROAST_CONFIRM,
    name: sanitizeRoastName(name),
    mass: String(Math.round(massG as number)),
    fan: level(fan),
    heat: level(heat),
  }
}

export interface RoastRequestInput {
  profile: Profile
  /** Per-occurrence name; defaults to the profile name only for legacy callers. */
  name?: string
  /** The EFFECTIVE journey - cooling endpoints already lifted to ambient plus the margin. */
  intent?: ThermalIntent
  massG?: number
  /** The journey's start temperature. Defaults to the current probe reading on the device. */
  startC?: number
}

/**
 * The request, or the first reason there is not one. A caller that gets a string has something to
 * render; a caller that gets args has something the firmware will accept.
 */
/** Which saved profile a device-run roast executes. The roaster reports it back with the active plan. */
export interface ProfileIdentityArgs {
  profile_id?: string
  profile_revision?: string
}

/**
 * The saved profile's id and revision, sent with Start so the roaster's active plan names the profile
 * the operator chose rather than only the roast. Omitted for a plan with no stored identity; the
 * firmware accepts at most 64 characters from this set.
 */
export const profileIdentityArgs = (profile: Profile): ProfileIdentityArgs =>
  /^[A-Za-z0-9._:-]{1,64}$/.test(profile.id) && Number.isInteger(profile.revision) && profile.revision > 0
    ? { profile_id: profile.id, profile_revision: String(profile.revision) }
    : {}

export const roastStartArgs = ({
  profile,
  name,
  intent,
  massG,
  startC,
}: RoastRequestInput): RoastStartArgs | string => {
  const badMass = massError(massG)
  if (badMass) return badMass
  const shared = {
    confirm: START_ROAST_CONFIRM,
    name: sanitizeRoastName(name || profile.name),
    mass: String(Math.round(massG as number)),
    ...profileIdentityArgs(profile),
  }
  if (profile.strategy === 'timed') {
    const steps = timedRoastSteps(profile)
    return timedStepsError(steps) ?? { mode: 'timed' as const, ...shared, steps: serializeTimedSteps(steps) }
  }
  const segments = intent?.segments ?? profile.segments
  return (
    journeyZonesError(segments) ?? {
      mode: 'journey' as const,
      ...shared,
      zones: serializeJourneyZones(segments),
      start: String(Math.round((startC ?? segments[0]?.startC ?? 25) * 10) / 10),
    }
  )
}

/**
 * ============================================================================================
 * THE PRE-START GATE
 * ============================================================================================
 *
 * Three questions, in the order they matter, all answered before the request is built:
 *
 *   1. Is the DEVICE in a state that can accept a roast? This mirrors the firmware's own gate order
 *      so the answer arrives as a sentence beside the button rather than as an HTTP status.
 *   2. For a journey, does the device hold applied calibration coefficients? The firmware answers
 *      409 without them, because there is nothing to invert; asking here is the same check moved to
 *      where it can be acted on.
 *   3. What does the applied model estimate each zone can reach at its own limits? This is advisory
 *      evidence, asked only when question 2 answered yes, and never replaces the firmware runtime
 *      envelope or silently changes the authored endpoint.
 *
 * **A note nobody may delete.** Nothing in a `CalibrationSettings`, a `ThermalCoefficientPatch` or a
 * `DeviceCoefficients` records which REGIME its four numbers describe. A fit derived from a
 * calibration pass describes the empty CHAMBER; a fit derived from loaded roasts describes the bean
 * model this gate reasons about. The sets differ across the board, and a chamber set driven through
 * the bean model settles far below any roast temperature. The two are indistinguishable at the type level, which is precisely why the roaster's own
 * applied set is the only source trusted here: it is the set that will run the roast, so whatever
 * scale it is on is the scale the roast happens on. The same note is on `previewCalibration`.
 */
export interface RoastPreflightInput {
  profile: Profile
  intent?: ThermalIntent
  status: ControllerStatus
  massG?: number
  ambientC: number
  /** The coefficients the APP believes in, for the divergence warning. */
  calibration: CalibrationSettings
  nowMs: number
  /** Whether the browser thinks a command is already in flight. */
  busy?: boolean
  /** Saved fit provenance used only to qualify model predictions, never to invent coefficients. */
  calibrationSnapshots?: CalibrationSnapshot[]
  /** Matching calibration evidence can prove a target was attained inside a zone's actuator range. */
  calibrationRuns?: CalibrationRun[]
  /** Retained roast curves remain available when duplicate calibration samples were compacted. */
  roastRuns?: RoastRun[]
}

export interface RoastPreflight {
  /** Reasons Start is impossible. Empty means it may be pressed. */
  blockers: string[]
  /** Model predictions worth reviewing. These never override the controller's runtime envelope. */
  warnings: string[]
  /**
   * The one thing worth knowing that is not a reason to stop: a fit this app holds and the
   * controller does not. Absent whenever the two sets agree, which is the ordinary case.
   */
  calibrationMismatch?: CalibrationMismatchNotice
  /**
   * Per zone, what its own limits reach and what it asks for. Journeys only, and only once the
   * roaster holds a set to judge them against - see `feasibilityModel`. Empty is "not asked", never
   * "all fine".
   */
  zones: Array<{ index: number; askedC: number; reachableC: number; infeasible: boolean; rising: boolean }>
  /** True when the one thing standing in the way is a calibration the roaster has not been given. */
  needsCalibration: boolean
}

/**
 * The model zone feasibility is allowed to use: the roaster's own applied set, or nothing.
 *
 * There is deliberately no third rung. The roast is solved on the controller by inverting the set in
 * its own NVS and nothing else, so a verdict computed from any other coefficients is a verdict about
 * a roaster that does not exist. Even as a warning, that would be physically meaningless arithmetic.
 *
 * The old fallback ladder guessed with this app's active fit, and that fit may be on an entirely
 * different REGIME: a calibration pass measures the empty CHAMBER, not the loaded bean model (the
 * trap documented at length in `data/demoDataset.ts`). Evaluated against a chamber-scale model, four perfectly ordinary zones
 * "settled" at 92-107 °C at heat 8-9 and a runnable roast was refused with four sentences of
 * physically meaningless arithmetic.
 *
 * So: all four coefficients from the device, or `undefined` and no verdict at all. Everything else
 * in the returned settings is the app's own - the reference batch mass, the probe offset, the
 * cooling margin - because the device has no opinion about any of it, exactly as in
 * `previewCalibration`.
 */
const feasibilityModel = (
  applied: DeviceCoefficients | undefined,
  app: CalibrationSettings,
): CalibrationSettings | undefined => {
  if (applied === undefined) return undefined
  const model = { ...app }
  for (const field of THERMAL_FIELDS) {
    const value = applied[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    model[field] = value
  }
  return model
}

const STALE_AFTER_MS = 15000

/**
 * The two sentences the browser and the firmware both have to be able to say. Declared once because
 * the gate says them BEFORE the request and `roastStartFailure` says them again if the device
 * refuses anyway, and two copies of a safety sentence is how they end up disagreeing.
 */
const LATCHED = 'ESP actuation is latched off after a manual-control conflict, and only a power cycle clears it.'
const NEEDS_CALIBRATION =
  'A journey roast needs calibration coefficients applied on the roaster. Fit and apply a calibration first, or run this roast in timed mode.'

/**
 * ============================================================================================
 * "MY CALIBRATION AND THE ROASTER'S ARE DIFFERENT" - SAID WITHOUT ALARMING ANYONE
 * ============================================================================================
 *
 * This notice must say clearly what is wrong and what the user needs to do. Engine vocabulary
 * ("inverts"), humanized property identifiers ("heater gain c per min at10"), missing values, or an
 * action buried in the last clause of one long paragraph all defeat that.
 *
 * So it is not a sentence at all. It is four parts, and the caller renders them as four
 * things:
 *
 *   1. **One headline**, stating the situation plainly and in the first line: a fit exists here that
 *      the controller has never been given.
 *   2. **The values as a table**, controller against this app, each named exactly as
 *      `COEFFICIENT_LABELS` names it on every other screen, at the precision the firmware
 *      serializes at - so the number on screen is the number being compared.
 *   3. **The action as a button**, not as a sentence pointing at another page. `applyCalibration`
 *      is one request; the banner that reports the disagreement is the right place to end it.
 *   4. **One reassurance line.** Zones advance when the roaster actually reaches a temperature and
 *      the in-roast feedback holds the curve, so a coefficient difference moves predicted TIMING
 *      and nothing else.
 *
 * There are two true headlines, because there are two situations, and the difference is which set
 * the preview in front of the user was drawn with. `previewCalibration` puts the controller's set
 * on the top rung, so the first is the ordinary case and the second only appears where a preview has
 * deliberately been drawn against a candidate fit.
 */
export const CALIBRATION_APPLY_ACTION = 'Apply my calibration to the roaster'

/** One coefficient, both readings, ready to render as a row. */
export interface CoefficientComparisonRow {
  field: CoefficientField
  label: string
  controller: string
  app: string
}

export interface CalibrationMismatchNotice {
  headline: string
  rows: CoefficientComparisonRow[]
  reassurance: string
}

export const coefficientComparison = (divergence: CoefficientDivergence): CoefficientComparisonRow[] =>
  divergence.fields.map((entry) => {
    const places = DEVICE_COEFFICIENT_PLACES[entry.field]
    return {
      field: entry.field,
      label: coefficientLabel(entry.field),
      controller: entry.device === undefined ? 'not reported' : entry.device.toFixed(places),
      app: entry.app.toFixed(places),
    }
  })

const HOLDS_EITHER_WAY = 'The roast holds its targets either way.'

export const calibrationMismatchNotice = (
  divergence: CoefficientDivergence,
  { usingControllerSet }: { usingControllerSet: boolean },
): CalibrationMismatchNotice => ({
  headline: usingControllerSet
    ? "Your latest calibration hasn't been applied to the roaster — the roast and this preview both use the older set the roaster is holding."
    : "Your latest calibration hasn't been applied to the roaster — the roast will use the older set the roaster is holding, and only this preview is drawn with yours.",
  rows: coefficientComparison(divergence),
  reassurance: HOLDS_EITHER_WAY,
})

/**
 * Why the controller cannot be given coefficients right now, or nothing when it can.
 *
 * The firmware answers 409 to `/api/calibration/apply` unless it is idle, so the button that offers
 * to end the disagreement says WHY it is unavailable rather than failing on press. Same order as the
 * start gate: unreachable first, then the thing that is running.
 */
export const calibrationApplyBlockedReason = (status: ControllerStatus): string | undefined => {
  if (!status.connected) return 'The roaster cannot be reached'
  if (status.roast?.active) return 'A roast is running, and coefficients can only be stored while the roaster is idle'
  if (status.lifecycle === 'RUNNING') {
    return 'The roaster is still running, and coefficients can only be stored while it is idle'
  }
  if (status.calibration?.active || status.manual?.active)
    return 'Another program is running, and coefficients can only be stored while the roaster is idle'
  return undefined
}

const observedMaximumWithinZone = (
  zone: ThermalSegment,
  snapshot: CalibrationSnapshot | undefined,
  runs: CalibrationRun[],
  roastRuns: RoastRun[],
): number | undefined => {
  if (!snapshot) return undefined
  const roastRunIds = new Set(
    (snapshot.inputs ?? []).map((input) => input.roastRunId).filter((id): id is string => typeof id === 'string'),
  )
  const sourceIds = new Set(snapshot.runIds)
  const fanMin = Math.min(zone.fanMin, zone.fanMax)
  const fanMax = Math.max(zone.fanMin, zone.fanMax)
  const heatMin = Math.min(zone.heatMin, zone.heatMax)
  const heatMax = Math.max(zone.heatMin, zone.heatMax)
  let maximum: number | undefined
  const consider = (temperatureC: number | undefined, effectiveFan: number, effectiveHeat: number) => {
    if (temperatureC === undefined || !Number.isFinite(temperatureC)) return
    if (effectiveFan < fanMin || effectiveFan > fanMax) return
    if (effectiveHeat < heatMin || effectiveHeat > heatMax) return
    maximum = maximum === undefined ? temperatureC : Math.max(maximum, temperatureC)
  }
  for (const run of runs) {
    if (!sourceIds.has(run.id) || run.recordedOn.deviceId !== snapshot.recordedOn.deviceId) continue
    for (const sample of run.samples) {
      consider(sample.thermocoupleC, sample.effectiveFan, sample.effectiveHeat)
    }
  }
  for (const run of roastRuns) {
    if (!roastRunIds.has(run.id) || run.recordedOn.deviceId !== snapshot.recordedOn.deviceId) continue
    for (const sample of run.samples) {
      consider(sample.beanTempC, sample.effectiveFan, sample.effectiveHeat)
    }
  }
  return maximum
}

/*
 * A program that finishes while heating ends with Heat and Fan off together (firmware
 * `finishRoast`): the 10 s Fan 10 cooling tail belongs to an operator Stop only, and the safety
 * policy forbids firmware synthesizing airflow after any other ending. So the profile is what cools
 * the beans, and a profile that does not is said out loud before Start.
 */
export const ENDS_HEATING_WARNING =
  'This profile ends while the heater is on. When it finishes, the roaster turns Heat and Fan off together and the hot beans sit still in the chamber. Add a final cooling zone so the fan cools them.'
export const TIMED_ENDS_HEATING_WARNING =
  'This profile ends while the heater is on and has no cooling time. When it finishes, the roaster turns Heat and Fan off together and the hot beans sit still in the chamber. Add a cooling step or a cooling time.'

export const roastPreflight = ({
  profile,
  intent,
  status,
  massG,
  ambientC,
  calibration,
  calibrationSnapshots = [],
  calibrationRuns = [],
  roastRuns = [],
  nowMs,
  busy,
}: RoastPreflightInput): RoastPreflight => {
  const blockers: string[] = []
  const warnings: string[] = []
  let calibrationMismatch: CalibrationMismatchNotice | undefined
  let needsCalibration = false

  if (busy) blockers.push('A roast command is already in flight')
  if (!status.connected) blockers.push('The roaster cannot be reached')
  else if (nowMs - status.receivedAtMs > STALE_AFTER_MS)
    blockers.push('The roaster has stopped reporting, so its state is unknown')
  if (status.roast === undefined) blockers.push('This firmware has no on-device roast executor')
  // The firmware's gate order, mirrored: the latch first, because nothing else can be cleared past it.
  if (status.manualLockout || status.lifecycle === 'MANUAL_LOCKOUT') blockers.push(LATCHED)
  if (status.fault) blockers.push(`Roaster fault: ${status.fault}`)
  if (status.roast?.active) blockers.push('A roast is already running on the roaster')
  if (status.calibration?.active) blockers.push('A calibration program is running')
  if (status.manual?.active) blockers.push('A manual session is running')

  const badMass = massError(massG)
  if (badMass) blockers.push(badMass)

  const journey = profile.strategy === 'thermal-intent'
  const segments = journey ? (intent?.segments ?? profile.segments) : []

  // Any plan with heat in it needs a fresh, fault-free probe - the firmware's sixth gate.
  const usesHeat = journey
    ? segments.some((zone) => zone.heatMax > 0)
    : profile.strategy === 'timed' && profile.points.some((point) => point.heat > 0)
  if (usesHeat && !status.thermocoupleValid) {
    blockers.push('No usable thermocouple reading, and the roaster refuses any plan that uses heat without one')
  }

  const zones: RoastPreflight['zones'] = []
  if (journey) {
    const shapeError = journeyZonesError(segments)
    if (shapeError) blockers.push(shapeError)
    const finalZone = segments.at(-1)
    if (finalZone && !isAuthoredCoolingZone(finalZone) && finalZone.heatMax > 0) warnings.push(ENDS_HEATING_WARNING)

    /*
     * The model feasibility is allowed to judge zones with, resolved BEFORE anything is said about
     * them. Without it there is one thing wrong here and one thing to do about it, and a list of
     * zone verdicts computed from coefficients that will not run the roast would bury it under
     * arithmetic the operator cannot act on and should not be shown.
     */
    const model = feasibilityModel(status.appliedCoefficients, calibration)
    /*
     * The condition is `!model`, not "is there an object here". A status can carry a PARTIAL applied
     * set - `{fitId}` alone is what the parser produces for a device that reports a fit id without
     * all four coefficients - and a partial set cannot solve the roast any more than an absent one
     * can. Asking about object presence let that case through the gate, enabled Start, and left the
     * firmware to refuse it with a 409. `feasibilityModel` already answers the real question, so the
     * blocker is tied to its verdict and the two can no longer disagree.
     */
    if (!model) {
      needsCalibration = true
      blockers.push(NEEDS_CALIBRATION)
    } else {
      const divergence = coefficientDivergence(status.appliedCoefficients, {
        heaterGainCPerMinAt10: calibration.heaterGainCPerMinAt10,
        fanCoolingCPerMinAt10: calibration.fanCoolingCPerMinAt10,
        coolingFanCPerMinAt10: calibration.coolingFanCPerMinAt10,
        thermalLossPerMinPerC: calibration.thermalLossPerMinPerC,
      })
      /*
       * Named field by field, with both values. The roast is solved on the controller and the
       * preview beside this gate is drawn with the controller's set too (`previewCalibration`), so
       * this is the "you fitted something you have not applied yet" notice - not a fault report.
       */
      if (divergence.diverged) calibrationMismatch = calibrationMismatchNotice(divergence, { usingControllerSet: true })
    }

    // Feasibility, against the coefficients the DEVICE is holding, or not at all.
    if (model) {
      const batchMassG = massG && massG > 0 ? massG : ROAST_LIMITS.mass.default
      const appliedFit = status.appliedCoefficients?.fitId
        ? calibrationSnapshots.find(
            (snapshot) =>
              sanitizeFitId(snapshot.applicationFitId ?? snapshot.fingerprint?.measurementHash ?? snapshot.id) ===
              status.appliedCoefficients?.fitId,
          )
        : undefined
      const modelQualification = [
        appliedFit?.fitRmsC !== undefined
          ? `its source roasts replay with ${appliedFit.fitRmsC.toFixed(1)} °C average error`
          : undefined,
      ].filter((value): value is string => value !== undefined)
      for (const [index, zone] of segments.entries()) {
        const predicted = zoneFeasibility(zone, { batchMassG, ambientC }, model)
        const observedMaximumC = predicted.rising
          ? observedMaximumWithinZone(zone, appliedFit, calibrationRuns, roastRuns)
          : undefined
        const demonstrated = observedMaximumC !== undefined && observedMaximumC >= zone.endC
        const verdict = demonstrated
          ? { ...predicted, reachableC: Math.max(predicted.reachableC, observedMaximumC), infeasible: false }
          : predicted
        zones.push({
          index,
          askedC: zone.endC,
          reachableC: verdict.reachableC,
          infeasible: verdict.infeasible,
          rising: verdict.rising,
        })
        if (!verdict.infeasible) continue
        // Both numbers, always: "infeasible" without the asked-versus-reachable pair is not
        // something an operator can act on, and the zone's own limits are what has to be edited.
        const fanMin = Math.min(zone.fanMin, zone.fanMax)
        const fanMax = Math.max(zone.fanMin, zone.fanMax)
        const heatMin = Math.min(zone.heatMin, zone.heatMax)
        const heatMax = Math.max(zone.heatMin, zone.heatMax)
        const qualifications = [
          ...modelQualification,
          observedMaximumC !== undefined
            ? `matching source evidence reached ${observedMaximumC.toFixed(0)} °C inside these actuator ranges`
            : undefined,
        ].filter((value): value is string => value !== undefined)
        const qualification =
          qualifications.length > 0 ? ` Treat that number as uncertain: ${qualifications.join(', and ')}.` : ''
        warnings.push(
          verdict.rising
            ? `Zone ${index + 1} asks for ${zone.endC.toFixed(0)} °C. Even with the strongest heating its profile ranges allow — minimum Fan ${fanMin} from ${fanMin}–${fanMax}, and maximum Heat ${heatMax} from ${heatMin}–${heatMax} — the controller's applied calibration estimates a ${Number.isFinite(verdict.reachableC) ? `${verdict.reachableC.toFixed(0)} °C steady-state ceiling` : 'non-finite steady-state ceiling'}. Batch mass changes the modelled approach time, not that equilibrium.${qualification} The roaster will still try to attain the target; if the journey cannot finish, firmware stops all outputs at twice the planned duration plus ten minutes.`
            : `Zone ${index + 1} asks to cool to ${zone.endC.toFixed(0)} °C, below the ${verdict.reachableC.toFixed(0)} °C ambient floor estimated by the applied calibration.${qualification} The roaster will still apply its bounded cooling target; firmware stops all outputs at twice the planned duration plus ten minutes if the journey cannot finish.`,
        )
      }
    }
  } else if (profile.strategy === 'timed') {
    const steps = timedRoastSteps(profile)
    const shapeError = timedStepsError(steps)
    if (shapeError) blockers.push(shapeError)
    if ((steps.at(-1)?.heat ?? 0) > 0) warnings.push(TIMED_ENDS_HEATING_WARNING)
    // Heat on means Fan 1.0 or higher (a heat-carrying bed must circulate). An older profile authored below
    // that is still runnable — the step is lifted at execution — but the lift is said out loud.
    const lifted = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.heat > 0 && isFloored(step))
    if (lifted.length > 0) {
      const described = lifted
        .slice(0, 4)
        .map(({ step, index }) => `step ${index + 1} (Fan ${step.fan} at Heat ${step.heat})`)
        .join(', ')
      warnings.push(
        `Heat needs Fan 1.0 or higher: ${described}${lifted.length > 4 ? ', …' : ''} will run at Fan 1.0. Edit the profile to clear this notice.`,
      )
    }
  }

  return { blockers, warnings, calibrationMismatch, zones, needsCalibration }
}

/**
 * ============================================================================================
 * WHAT THE CONTROLLER SAID, IN WORDS
 * ============================================================================================
 *
 * The firmware answers every refusal as `{"ok":false,"message":"..."}` with a status that names the
 * class of refusal. The status alone is not enough - three different things answer 409 - so the
 * message is read too, and the device's own text is preserved rather than replaced: when the
 * actuator refuses an opening request, the firmware passes the actuator's own words through, and
 * those words are the most specific thing anyone has.
 */
export const roastStartFailure = (httpStatus: number | undefined, message?: string): string => {
  const detail = message?.trim()
  const said = detail ? ` The roaster said: ${detail}` : ''
  const mentions = (pattern: RegExp) => detail !== undefined && pattern.test(detail)

  if (httpStatus === 401) return 'Sign in required'
  if (httpStatus === 423) return LATCHED + said
  if (httpStatus === 400)
    return `The roaster could not read the roast plan, so this profile serializes outside the ranges it accepts. Check the zone or step durations and levels.${said}`
  if (httpStatus === 409) {
    if (mentions(/zero-cross/i))
      return `The roaster could not verify stable mains timing, so no output was enabled. Check that the roaster is powered and showing Standby, then try again.${said}`
    if (mentions(/another actuator|operation.*active|test.*running|program.*active|roast.*active|manual.*active/i))
      return `The roaster is busy: a fan test, a heater proof, a calibration pass, a manual session, or a roast that has not finished.${said}`
    if (mentions(/calibration|coefficient/i)) return NEEDS_CALIBRATION + said
    if (mentions(/thermocouple|temperature|sensor|probe/i))
      return `The roaster will not start a plan that uses heat without a fresh, fault-free thermocouple reading below the overheat limit (260 °C unless the firmware was built with another).${said}`
    if (mentions(/confirm/i))
      return `The roaster rejected the confirmation token, so this browser and that firmware disagree about the roast contract.${said}`
    return `The roaster is busy: a fan test, a heater proof, a calibration pass, a manual session, or a roast that has not finished.${said}`
  }
  if (httpStatus === undefined)
    return (
      detail ??
      'The roaster did not answer, so it is unknown whether the roast started. Check its status before trying again.'
    )
  return `The roaster refused the roast (HTTP ${httpStatus}).${said}`
}

/**
 * Every `end_reason` the firmware can report, in plain language.
 *
 * A headline plus one sentence, because an end reason is usually read once, hours later, by someone
 * who wants to know whether the batch is fine.
 * The sentence says what happened to the HEAT, since that is the part that
 * decides whether there is still coffee worth having.
 *
 * Kept to one clause each on purpose: these nine strings ship in the bundle, and a paragraph per
 * reason is a paragraph nobody reads eight times out of nine.
 */
export const ROAST_END_REASONS: Record<RoastEndReason, { headline: string; detail: string }> = {
  completed: { headline: 'Completed', detail: 'It ran to the end of its plan and the outputs stopped.' },
  stopped: {
    headline: 'Stopped',
    detail: 'Heat was turned off immediately; the fan ran a 10-second cooling pass before stopping.',
  },
  fault: {
    headline: 'Ended by a fault on the roaster',
    detail: 'A manual conflict or a scheduler failure took the outputs down.',
  },
  telemetry_stale: {
    headline: 'Ended when temperature updates paused',
    detail: 'The independent safety path turned the outputs off because controller telemetry stopped updating.',
  },
  sensor_lost: {
    headline: 'Ended because the thermocouple was lost',
    detail: 'No usable reading arrived for 30 seconds, so the outputs stopped.',
  },
  qualification_stalled: {
    headline: 'Ended because heat never became effective',
    detail: 'Heat was requested but never took effect within 10 seconds. Nothing was roasted.',
  },
  step_rejected: {
    headline: 'Ended because the actuator refused a step',
    detail: 'A timed step was refused and the outputs stopped.',
  },
  renewal_rejected: {
    headline: 'Ended because a lease renewal was refused',
    detail: 'The instruction expired and both outputs stopped.',
  },
  command_rejected: {
    headline: 'Ended because a control command was refused',
    detail: 'A journey command was refused while it was not in holdover, so the thermal gate was not the explanation.',
  },
  envelope_timeout: {
    headline: 'Ended by the runtime envelope',
    detail:
      'The roast ran past twice its planned duration plus ten minutes, so the roaster stopped it. A zone endpoint was probably unreachable at its limits.',
  },
  instruction_expired: {
    headline: 'Ended because the manual instruction expired',
    detail: 'No new manual instruction arrived within 30 minutes, so Fan and Heat stopped.',
  },
  heat_lease_expired: {
    headline: 'Ended because requested Heat was no longer being delivered',
    detail: 'The roaster stopped the program after its independent Heat lease expired.',
  },
}

export const roastEndReasonText = (reason: RoastEndReason | undefined) =>
  reason === undefined ? undefined : ROAST_END_REASONS[reason]

/** How the mode reads on screen. `none` is an idle sentinel and never renders as a mode. */
export const roastModeLabel = (mode: string | undefined) =>
  mode === 'journey'
    ? 'Temperature journey'
    : mode === 'timed'
      ? 'Timed control'
      : mode === 'manual'
        ? 'Manual roast'
        : 'No program'
