/**
 * The roast executor: `POST /api/roast/start`, parsed and then actually run.
 *
 * ============================================================================================
 * JOURNEY MODE RUNS THE REAL CONTROL LAW
 * ============================================================================================
 *
 * `journeyControlStep` is imported from `src/domain/journeyControl.ts` and driven at 1 Hz, exactly
 * as the firmware's C++ port drives its own copy. Nothing about the law is re-implemented here.
 *
 * That is the entire point of this module. The firmware goes to considerable lengths to keep its
 * port bit-identical to the TypeScript oracle (6523 recorded vector steps asserted to 1e-4), so a
 * mock that approximated the control law with a simpler loop would be a development environment
 * whose roasts diverge from both real implementations - the one thing that must not happen. The
 * plant is simulated; the CONTROL is real.
 *
 * ============================================================================================
 * WHAT IS PARSED
 * ============================================================================================
 *
 * The argument grammar is the firmware's, and its bounds come from `ROAST_LIMITS` in
 * `src/domain/roastProgram.ts` - the same constants the browser serializes against - so a plan the
 * app builds is accepted and a plan outside the contract is refused with the same 400 the device
 * would answer. Zone start temperatures are never authored: zone 0 starts at `start` and every later
 * zone starts where the one before it ended.
 */

import { minimumFanForHeat } from '../src/domain/actuatorFloors'
import {
  initialJourneyControlState,
  type JourneyControlState,
  type JourneyPlan,
  journeyControlStep,
  journeyPlan,
} from '../src/domain/journeyControl'
import { ROAST_LIMITS, roastRuntimeEnvelopeSec, sanitizeRoastName } from '../src/domain/roastProgram'
import type { RoastEndReason, ThermalIntent, ThermalSegment } from '../src/domain/types'
import {
  clamp,
  HOLDOVER_LIMIT_MS,
  MANUAL_INSTRUCTION_LIMIT_MS,
  QUALIFICATION_TIMEOUT_MS,
  round1,
  round3,
} from './config'
import type { ProgramHost } from './host'

export type RoastMode = 'timed' | 'journey' | 'manual'

export interface TimedStep {
  fan: number
  heat: number
  durationSec: number
}

export interface RoastPlan {
  mode: RoastMode
  name: string
  batchMassG: number
  record: boolean
  steps: TimedStep[]
  zones: ThermalSegment[]
  startC: number
  nominalSec: number
  initialFan?: number
  initialHeat?: number
  profileId?: string
  profileRevision?: number
}

/** A refusal, in the firmware's own `{status, message}` terms. */
export interface Refusal {
  status: number
  message: string
}

const asLevel = (raw: string): number | undefined => {
  if (!/^\d+(\.\d+)?$/.test(raw)) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > ROAST_LIMITS.level.max) return undefined
  // A non-zero level below the floor is lifted to it, exactly as the firmware lifts it.
  return value > 0 && value < ROAST_LIMITS.levelFloor ? ROAST_LIMITS.levelFloor : value
}

/** `fan:heat:seconds` triples, 1-24 of them. */
export const parseSteps = (raw: string): TimedStep[] | Refusal => {
  const cells = raw
    .split(',')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
  if (cells.length < ROAST_LIMITS.steps.min || cells.length > ROAST_LIMITS.steps.max) {
    return { status: 400, message: `steps must hold 1 to ${ROAST_LIMITS.steps.max} fan:heat:seconds triples` }
  }
  const steps: TimedStep[] = []
  for (const cell of cells) {
    const parts = cell.split(':')
    if (parts.length !== 3) return { status: 400, message: `"${cell}" is not a fan:heat:seconds triple` }
    const fan = asLevel(parts[0].trim())
    const heat = asLevel(parts[1].trim())
    const durationSec = Number(parts[2].trim())
    if (fan === undefined || heat === undefined)
      return { status: 400, message: `"${cell}" has a level outside 0.0 to 10.0` }
    if (
      !Number.isInteger(durationSec) ||
      durationSec < ROAST_LIMITS.stepSeconds.min ||
      durationSec > ROAST_LIMITS.stepSeconds.max
    ) {
      return { status: 400, message: `"${cell}" must run 1 to 1800 seconds` }
    }
    if (fan === 0 && heat > 0)
      return { status: 400, message: `"${cell}" needs fan above 0; fan 0 is only allowed with heat 0` }
    // Heat on means Fan 1.0 or higher: an old profile's lower fan is
    // lifted at execution, exactly as the firmware parser lifts it, never refused.
    steps.push({ fan: Math.max(fan, minimumFanForHeat(heat)), heat, durationSec })
  }
  return steps
}

/**
 * `endC:duration:fanMin:fanMax:heatMin:heatMax` groups, separated by `;`. `duration` is nominal
 * seconds or `r<rate>` in C per minute, from which seconds are derived and THEN range-checked.
 */
export const parseZones = (raw: string, startC: number): ThermalSegment[] | Refusal => {
  const groups = raw
    .split(';')
    .map((group) => group.trim())
    .filter((group) => group.length > 0)
  if (groups.length < ROAST_LIMITS.zones.min || groups.length > ROAST_LIMITS.zones.max) {
    return { status: 400, message: `zones must hold 1 to ${ROAST_LIMITS.zones.max} groups` }
  }
  const segments: ThermalSegment[] = []
  let previousEndC = startC
  for (const [index, group] of groups.entries()) {
    const parts = group.split(':')
    if (parts.length !== 6)
      return { status: 400, message: `"${group}" is not endC:duration:fanMin:fanMax:heatMin:heatMax` }
    const endC = Number(parts[0].trim())
    if (!Number.isFinite(endC) || endC < ROAST_LIMITS.endC.min || endC > ROAST_LIMITS.endC.max) {
      return { status: 400, message: `"${group}" has an end temperature outside 0 to 300 C` }
    }
    const rawDuration = parts[1].trim()
    let durationSec: number
    if (/^r\d+(\.\d+)?$/i.test(rawDuration)) {
      const rate = Number(rawDuration.slice(1))
      if (!(rate > 0)) return { status: 400, message: `"${group}" has a rate of zero` }
      durationSec = Math.round((Math.abs(endC - previousEndC) / rate) * 60)
    } else {
      durationSec = Number(rawDuration)
    }
    if (
      !Number.isFinite(durationSec) ||
      durationSec < ROAST_LIMITS.zoneSeconds.min ||
      durationSec > ROAST_LIMITS.zoneSeconds.max
    ) {
      return { status: 400, message: `"${group}" resolves to ${durationSec} s, outside 5 to 1800` }
    }
    const levels = parts.slice(2).map((part) => asLevel(part.trim()))
    if (levels.some((level) => level === undefined))
      return { status: 400, message: `"${group}" has a level outside 0.0 to 10.0` }
    const [fanMin, fanMax, heatMin, heatMax] = levels as number[]
    if (fanMin > fanMax) return { status: 400, message: `"${group}" has fanMin above fanMax` }
    if (heatMin > heatMax) return { status: 400, message: `"${group}" has heatMin above heatMax` }
    if (fanMax <= 0) return { status: 400, message: `"${group}" has no airflow; fanMax must be above 0` }
    // Zone start temperatures are never authored - each zone starts where the last one ended.
    segments.push({ id: `zone-${index}`, startC: previousEndC, endC, durationSec, fanMin, fanMax, heatMin, heatMax })
    previousEndC = endC
  }
  return segments
}

const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && 'status' in value

/** Turn the form arguments into a plan, or into the refusal the firmware would answer. */
export const parseRoastArgs = (args: URLSearchParams, currentC: number | undefined): RoastPlan | Refusal => {
  const mode = args.get('mode')
  if (mode !== 'timed' && mode !== 'journey' && mode !== 'manual')
    return { status: 400, message: 'mode must be timed, journey or manual' }

  const name = sanitizeRoastName(args.get('name') ?? '')
  const rawMass = args.get('mass')
  const batchMassG = rawMass === null ? ROAST_LIMITS.mass.default : Number(rawMass)
  if (!Number.isInteger(batchMassG) || batchMassG < ROAST_LIMITS.mass.min || batchMassG > ROAST_LIMITS.mass.max) {
    return {
      status: 400,
      message: `mass must be a whole number of grams between ${ROAST_LIMITS.mass.min} and ${ROAST_LIMITS.mass.max}`,
    }
  }
  const record = args.get('record') !== '0'

  if (mode === 'manual') {
    const fan = asLevel(args.get('fan') ?? '')
    const heat = asLevel(args.get('heat') ?? '')
    if (fan === undefined || heat === undefined || fan < ROAST_LIMITS.levelFloor) {
      return { status: 400, message: 'manual fan must be 0.1 to 10.0 and heat must be 0.0 to 10.0' }
    }
    return {
      mode,
      name,
      batchMassG,
      record,
      steps: [],
      zones: [],
      startC: currentC ?? 25,
      // Heat on means Fan 1.0 or higher.
      nominalSec: 0,
      initialFan: Math.max(fan, minimumFanForHeat(heat)),
      initialHeat: heat,
    }
  }

  if (mode === 'timed') {
    const steps = parseSteps(args.get('steps') ?? '')
    if (isRefusal(steps)) return steps
    return {
      mode,
      name,
      batchMassG,
      record,
      steps,
      zones: [],
      startC: currentC ?? 25,
      nominalSec: steps.reduce((sum, step) => sum + step.durationSec, 0),
    }
  }

  const rawStart = args.get('start')
  const startC = rawStart !== null && Number.isFinite(Number(rawStart)) ? Number(rawStart) : (currentC ?? 25)
  const zones = parseZones(args.get('zones') ?? '', startC)
  if (isRefusal(zones)) return zones
  return {
    mode,
    name,
    batchMassG,
    record,
    steps: [],
    zones,
    startC,
    nominalSec: zones.reduce((sum, zone) => sum + zone.durationSec, 0),
  }
}

/** `journeyPlan` needs an intent; only its segments are ever read. */
const intentOf = (segments: ThermalSegment[]): ThermalIntent => ({
  id: 'mock-roast',
  name: 'mock-roast',
  revision: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  metadata: { intent: 'mock' },
  notes: '',
  strategy: 'thermal-intent',
  segments,
  calibrationStatus: 'experimental',
})

export class RoastProgram {
  active = true
  endReason: RoastEndReason | 'none' = 'none'
  elapsedSec = 0
  readonly startedEpoch: number
  readonly envelopeSec: number
  readonly ambientC: number

  /** Timed mode. */
  stepIndex = 0
  private stepElapsedSec = 0

  /** Journey mode. */
  zoneIndex = 0
  zoneEntrySec = 0
  zoneAttainedSec: Array<number | null>
  targetC?: number
  correctionTotal = 0
  integral = 0
  saturated = false
  holdover = false
  holdoverMs = 0
  solvedFan = 0
  solvedHeat = 0
  commandedFan = 0
  commandedHeat = 0

  private plan?: JourneyPlan
  planRevision = 1
  readonly planJournal: Array<{ elapsed_sec: number; plan_rev: number; change: ThermalSegment[] }>
  readonly timedJournal: Array<{ elapsed_sec: number; plan_rev: number; step_index: number; step: TimedStep }> = []
  readonly manualJournal: Array<{
    elapsed_sec: number
    plan_rev: number
    requested_fan: number
    requested_heat: number
    effective_fan: number
    effective_heat: number
  }> = []
  private controlState: JourneyControlState = initialJourneyControlState()
  private nextControlAtMs: number
  private readonly startedAtMs: number
  private instructionAtMs: number

  constructor(
    readonly spec: RoastPlan,
    host: ProgramHost,
    readonly sessionId: number,
  ) {
    this.startedAtMs = host.nowMs
    this.instructionAtMs = host.nowMs
    this.nextControlAtMs = host.nowMs
    this.startedEpoch = host.epochSeconds()
    /*
     * Ambient is the cold-junction temperature at the moment the roast starts, sampled once and
     * FROZEN. The board warms up inside the roaster over twenty minutes, and a drifting ambient
     * would make the plan's passive-loss term wrong in a way the PI would then have to absorb.
     */
    this.ambientC = round1(host.plant.coldJunctionReadingC())
    this.envelopeSec = spec.mode === 'manual' ? 0 : roastRuntimeEnvelopeSec(spec.nominalSec)
    this.zoneAttainedSec = spec.zones.map(() => null)
    if (spec.mode === 'journey') this.plan = journeyPlan(intentOf(spec.zones))
    this.planJournal =
      spec.mode === 'journey' ? [{ elapsed_sec: 0, plan_rev: 1, change: spec.zones.map((zone) => ({ ...zone })) }] : []
    if (spec.mode === 'manual') {
      this.commandedFan = spec.initialFan ?? 4
      this.commandedHeat = spec.initialHeat ?? 0
      this.solvedFan = this.commandedFan
      this.solvedHeat = this.commandedHeat
    }
  }

  get mode(): RoastMode {
    return this.spec.mode
  }
  get zoneCount() {
    return this.spec.zones.length
  }
  get stepCount() {
    return this.spec.steps.length
  }
  get timedStepElapsedSec() {
    return this.stepElapsedSec
  }
  get zoneNominalSec() {
    return this.spec.zones[this.zoneIndex]?.durationSec ?? 0
  }
  get zoneEndC(): number | undefined {
    return this.spec.zones[this.zoneIndex]?.endC
  }
  instructionAgeMs(nowMs: number) {
    return this.mode === 'manual' ? Math.max(0, nowMs - this.instructionAtMs) : undefined
  }

  /** Replace the device-owned plan after route-level optimistic validation. */
  applyJourneyPlan(zones: ThermalSegment[]) {
    this.spec.zones.splice(0, this.spec.zones.length, ...zones)
    this.plan = journeyPlan(intentOf(this.spec.zones))
    this.planRevision = this.planRevision >= 0xffffffff ? 1 : this.planRevision + 1
    this.planJournal.push({
      elapsed_sec: this.elapsedSec,
      plan_rev: this.planRevision,
      change: zones.map((zone) => ({ ...zone })),
    })
    while (this.zoneAttainedSec.length < zones.length) this.zoneAttainedSec.push(null)
    this.zoneAttainedSec.length = zones.length
  }

  /** Replace or append one current/upcoming timed instruction after route-level validation. */
  applyTimedStep(host: ProgramHost, index: number, step: TimedStep): string | undefined {
    if (!this.active || this.mode !== 'timed' || index < this.stepIndex || index > this.spec.steps.length)
      return 'That timed step is no longer editable.'
    if (index === this.stepIndex) {
      const refusal = host.actuator.request(host.nowMs, step.fan, step.heat)
      if (refusal) return refusal
      this.commandedFan = this.solvedFan = step.fan
      this.commandedHeat = this.solvedHeat = step.heat
    }
    if (index === this.spec.steps.length) this.spec.steps.push({ ...step })
    else this.spec.steps[index] = { ...step }
    this.planRevision = this.planRevision >= 0xffffffff ? 1 : this.planRevision + 1
    this.timedJournal.push({
      elapsed_sec: this.elapsedSec,
      plan_rev: this.planRevision,
      step_index: index,
      step: { ...step },
    })
    return undefined
  }

  /** Apply an explicitly confirmed crossed endpoint in this request, not a later timer tick. */
  applyImmediateJourneyTransition(host: ProgramHost) {
    if (this.active && this.mode === 'journey') this.journeyStep(host)
  }

  /** Commit one controller-accepted manual instruction to device-owned provenance. */
  recordManualInstruction(effectiveFan: number, effectiveHeat: number, initial = false) {
    if (!initial) this.planRevision = this.planRevision >= 0xffffffff ? 1 : this.planRevision + 1
    this.manualJournal.push({
      elapsed_sec: this.elapsedSec,
      plan_rev: this.planRevision,
      requested_fan: this.commandedFan,
      requested_heat: this.commandedHeat,
      effective_fan: effectiveFan,
      effective_heat: effectiveHeat,
    })
  }

  /** One accepted operator instruction; validation and probe gates live on the route owner. */
  setManual(host: ProgramHost, fan: number, heat: number): string | undefined {
    if (!this.active || this.mode !== 'manual') return 'No manual roast is running.'
    const refusal = host.actuator.request(host.nowMs, fan, heat)
    if (refusal) return refusal
    this.commandedFan = fan
    this.commandedHeat = heat
    this.solvedFan = fan
    this.solvedHeat = heat
    this.instructionAtMs = host.nowMs
    return undefined
  }

  /** One simulation pass. The control law itself runs at 1 Hz inside it. */
  tick(host: ProgramHost, leaseExpired: boolean) {
    if (!this.active) return
    this.elapsedSec = Math.floor((host.nowMs - this.startedAtMs) / 1000)

    if (host.actuator.fault !== 'none') {
      this.end(host, 'fault')
      return
    }
    if (this.mode !== 'manual' && this.elapsedSec > this.envelopeSec) {
      this.end(host, 'envelope_timeout')
      return
    }
    if (host.actuator.qualificationStalledMs(host.nowMs) > QUALIFICATION_TIMEOUT_MS) {
      this.end(host, 'qualification_stalled')
      return
    }
    if (leaseExpired) {
      // A roast renews its own leases, so a lease that expired means the renewal did not land.
      this.end(host, 'heat_lease_expired')
      return
    }

    if (this.mode === 'manual' && this.instructionAgeMs(host.nowMs)! > MANUAL_INSTRUCTION_LIMIT_MS) {
      this.end(host, 'instruction_expired')
      return
    }

    while (host.nowMs >= this.nextControlAtMs && this.active) {
      this.nextControlAtMs += 1000
      if (this.mode === 'timed') this.timedStep(host)
      else if (this.mode === 'journey') this.journeyStep(host)
      else this.manualStep(host)
    }
  }

  /** Reassert the device-owned last instruction so the short actuator lease remains internal. */
  private manualStep(host: ProgramHost) {
    // During a probe holdover firmware keeps the accepted instruction but does not ask the
    // thermal gate to renew unavailable Heat. Recovery resumes the retained request.
    if (this.commandedHeat > 0 && host.actuator.effectiveHeat <= 0) return
    const refusal = host.actuator.request(host.nowMs, this.commandedFan, this.commandedHeat)
    if (refusal) this.end(host, 'renewal_rejected')
  }

  /**
   * Timed steps run on their exact durations. **A Heat step's clock does not start until Heat is
   * actually effective**, so a step is the dwell that was asked for rather than that dwell minus
   * fan qualification.
   */
  private timedStep(host: ProgramHost) {
    const step = this.spec.steps[this.stepIndex]
    if (!step) return this.end(host, 'completed')

    const instructionChanged = this.commandedFan !== step.fan || this.commandedHeat !== step.heat
    if (instructionChanged || step.heat <= 0 || host.actuator.effectiveHeat > 0) {
      const refusal = host.actuator.request(host.nowMs, step.fan, step.heat)
      if (refusal) return this.end(host, 'step_rejected')
    }

    this.commandedFan = step.fan
    this.commandedHeat = step.heat
    this.solvedFan = step.fan
    this.solvedHeat = step.heat

    const heatPending = step.heat > 0 && host.actuator.effectiveHeat <= 0
    if (!heatPending) this.stepElapsedSec += 1
    if (this.stepElapsedSec < step.durationSec) return

    this.stepElapsedSec = 0
    this.stepIndex += 1
    if (this.stepIndex >= this.spec.steps.length) this.end(host, 'completed')
  }

  /** One pass of the REAL control law, against the coefficients the device holds. */
  private journeyStep(host: ProgramHost) {
    if (!this.plan) return this.end(host, 'completed')
    const readingC = host.reading()
    const previousZone = this.controlState.zoneIndex

    const result = journeyControlStep(this.controlState, {
      plan: this.plan,
      elapsedSec: this.elapsedSec,
      beanTempC: readingC ?? Number.NaN,
      ambientC: this.ambientC,
      batchMassG: this.spec.batchMassG,
      calibration: host.modelCalibration(),
    })
    this.controlState = result.state

    // Attainment is what moved the plan's time axis, so it is recorded per zone as it happens.
    if (result.zoneAdvanced) {
      for (let index = previousZone; index < result.zoneIndex; index += 1) {
        this.zoneAttainedSec[index] = this.elapsedSec
      }
      host.archive.annotate({ zoneAttainedSec: [...this.zoneAttainedSec] })
    }

    this.zoneIndex = result.zoneIndex
    this.zoneEntrySec = result.zoneEntrySec
    this.targetC = round1(result.command.goalC)
    this.correctionTotal = round3(result.correction.totalRatePerMin)
    this.integral = round3(result.correction.integralRatePerMin)
    this.saturated = result.correction.saturated
    this.holdover = result.correction.holdover
    this.solvedFan = round3(result.command.fan)
    this.solvedHeat = round3(result.command.heat)

    // 30 continuous seconds without a usable reading is `sensor_lost`; Heat stops by lease
    // non-renewal, which on this path means asking for the fan alone.
    this.holdoverMs = readingC === undefined ? this.holdoverMs + 1000 : 0
    if (this.holdoverMs > HOLDOVER_LIMIT_MS) return this.end(host, 'sensor_lost')

    // Level quantization is the actuator's, so the command is what a level really can be.
    this.commandedFan = round1(clamp(result.command.fan, 0, 10))
    this.commandedHeat = round1(clamp(result.command.heat, 0, 10))
    const refusal = host.actuator.request(host.nowMs, this.commandedFan, this.commandedHeat)
    if (refusal && !this.holdover) return this.end(host, 'command_rejected')

    // A journey completes when the FINAL zone's endpoint is attained. An unreachable endpoint
    // never completes, by design; the envelope is what ends that roast.
    if (result.zoneCompleted && result.zoneIndex >= this.spec.zones.length - 1) {
      this.zoneAttainedSec[result.zoneIndex] = this.elapsedSec
      host.archive.annotate({ zoneAttainedSec: [...this.zoneAttainedSec] })
      this.end(host, 'completed')
    }
  }

  /** Stop from outside - `POST /api/roast/stop`, or anything else that takes the actuator away. */
  requestStop(host: ProgramHost) {
    if (this.active) this.end(host, 'stopped')
  }

  private end(host: ProgramHost, reason: RoastEndReason) {
    if (!this.active) return
    this.active = false
    this.endReason = reason
    this.commandedFan = 0
    this.commandedHeat = 0
    this.solvedFan = 0
    this.solvedHeat = 0
    host.actuator.stop(host.nowMs, host.plant.probeC)
    host.archive.annotate({
      zoneAttainedSec: [...this.zoneAttainedSec],
      roastStopSec: Math.min(0xffff, this.elapsedSec),
      roastEndReason: reason,
    })
  }
}
