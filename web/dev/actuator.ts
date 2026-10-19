/**
 * The simulated SR800 actuator: the layer every program has to go through to reach the plant.
 *
 * It is modelled at exactly the level the HTTP contract exposes and no deeper. There is no
 * zero-cross stream and no MCPWM here, because nothing a browser can observe distinguishes them -
 * what a browser sees is the three things this class enforces:
 *
 *   1. **Level normalization.** `effectiveLevels` from `src/domain/actuatorFloors.ts`, imported
 *      rather than re-derived. Zero stays off and any nonzero Fan request is normalized to at least
 *      public level 0.1; captured stock behavior permits that endpoint at every Heat setting.
 *   2. **Fan qualification.** Heat does not become effective the instant it is asked for; the fan
 *      has to be turning first. So `effective_heat` lags `heat_req`, which is the distinction
 *      between requested and effective levels the whole UI is built around.
 *   3. **The renewable Heat lease.** Heat persists only while something keeps renewing it. Nothing
 *      renews, Heat stops - which is what makes the manual instruction lease and the roast executor's
 *      renewals observable rather than notional.
 */
import { effectiveLevels, minimumFanForHeat } from '../src/domain/actuatorFloors'
import {
  clamp,
  FAN_QUALIFY_MS,
  HEAT_LEASE_MS,
  OVERTEMP_C,
  OVERTEMP_COOLDOWN_MS,
  OVERTEMP_HOLD_MS,
  round3,
} from './config'

export type ActuatorMode = 'idle' | 'running'

export class Actuator {
  mode: ActuatorMode = 'idle'
  /** What a program asked for, before floors. */
  requestedFan = 0
  requestedHeat = 0
  /** What is actually being driven, floors and qualification included. */
  effectiveFan = 0
  effectiveHeat = 0
  fault = 'none'
  leaseRenewals = 0
  /**
   * The manual-control conflict latch. Nothing in the mock sets it - there is no physical panel to
   * conflict with - but the field is reported so the app's `MANUAL_LOCKOUT` path stays exercisable
   * by editing the persisted state file.
   */
  conflictLatched = false

  private leaseExpiresAtMs = 0
  private fanRunningSinceMs?: number
  private heatRequestedSinceMs?: number
  private overtemperatureSinceMs?: number
  /** While non-zero, the overtemperature cooldown runs until this time. */
  overtempCooldownUntilMs = 0
  private thermalInputValid = true

  /** Whether anything at all is going on - the "another operation is active" gate every start uses. */
  get busy(): boolean {
    return this.mode !== 'idle'
  }

  /** Heat was requested but has not become effective yet, and for how long. */
  qualificationStalledMs(nowMs: number): number {
    if (
      !this.thermalInputValid ||
      this.requestedHeat <= 0 ||
      this.effectiveHeat > 0 ||
      this.heatRequestedSinceMs === undefined
    )
      return 0
    return nowMs - this.heatRequestedSinceMs
  }

  /**
   * A program's command. Returns the actuator's own refusal text, or undefined on acceptance - the
   * firmware passes that text straight through to the caller, so the mock produces one to pass.
   */
  request(nowMs: number, fan: number, heat: number): string | undefined {
    if (this.conflictLatched) return 'ESP actuation is disabled until the roaster is power-cycled.'
    if (this.fault !== 'none') return `Actuator fault: ${this.fault}`
    const previousRequestedHeat = this.requestedHeat
    const wantsHeat = heat > 0
    if (wantsHeat && !this.thermalInputValid) return 'Heat needs a fresh, fault-free thermocouple reading.'
    if (wantsHeat && this.overtemperatureSinceMs !== undefined) return `Heat is refused at or above ${OVERTEMP_C} C.`

    this.requestedFan = clamp(fan, 0, 10)
    this.requestedHeat = clamp(heat, 0, 10)
    if (this.requestedFan > 0) {
      this.fanRunningSinceMs ??= nowMs
    } else {
      this.fanRunningSinceMs = undefined
    }
    if (wantsHeat) {
      if (
        previousRequestedHeat <= 0 ||
        (minimumFanForHeat(this.requestedHeat) > minimumFanForHeat(previousRequestedHeat) &&
          this.effectiveFan < minimumFanForHeat(this.requestedHeat))
      ) {
        this.heatRequestedSinceMs = nowMs
      }
      /*
       * The lease is renewed by a command carrying Heat, but only once it is halfway spent. A
       * journey commands at 1 Hz and a manual page re-affirms every 25 s; counting every one of
       * those as a renewal would make `lease_renewals` a tick counter instead of the lease-health
       * number the status document is supposed to be reporting.
       */
      if (this.leaseExpiresAtMs === 0) {
        this.leaseExpiresAtMs = nowMs + HEAT_LEASE_MS
      } else if (this.leaseExpiresAtMs - nowMs <= HEAT_LEASE_MS / 2) {
        this.leaseExpiresAtMs = nowMs + HEAT_LEASE_MS
        this.leaseRenewals += 1
      }
    } else {
      this.heatRequestedSinceMs = undefined
      this.leaseExpiresAtMs = 0
    }
    this.mode = 'running'
    this.settle(nowMs)
    return undefined
  }

  /** A transient missing sample cuts effective heat without inventing a latched sensor fault. */
  updateThermalInput(valid: boolean, nowMs: number) {
    const recovered = valid && !this.thermalInputValid
    this.thermalInputValid = valid
    // Firmware cannot renew Heat while telemetry is absent, but recovery is allowed to resume
    // within the roast holdover budget. Do not let the first healthy tick consume that stale lease.
    if (recovered && this.requestedHeat > 0 && nowMs > this.leaseExpiresAtMs) {
      this.leaseExpiresAtMs = nowMs + HEAT_LEASE_MS
    }
    if (this.mode === 'running') this.settle(nowMs)
  }

  /**
   * Stop every output immediately - except an overtemperature cooldown, which only an operator Stop
   * (`cancelOvertempCooldown`) ends early. Mirrors the firmware core.
   */
  stop(nowMs: number, probeC: number) {
    void nowMs
    void probeC
    if (this.overtempCooldownUntilMs !== 0) return
    this.requestedFan = 0
    this.requestedHeat = 0
    this.effectiveHeat = 0
    this.heatRequestedSinceMs = undefined
    this.leaseExpiresAtMs = 0
    this.shutDown()
  }

  /** Heat is already latched off; run the fan at 10 to clear the hot chamber. */
  beginOvertempCooldown(nowMs: number) {
    this.requestedHeat = 0
    this.effectiveHeat = 0
    this.heatRequestedSinceMs = undefined
    this.leaseExpiresAtMs = 0
    this.requestedFan = 10
    this.effectiveFan = 10
    this.fanRunningSinceMs ??= nowMs
    this.mode = 'running'
    this.overtempCooldownUntilMs = nowMs + OVERTEMP_COOLDOWN_MS
  }

  /** The operator's Stop: ends the cooldown, so Stop always means every output off. */
  cancelOvertempCooldown(nowMs: number, probeC: number) {
    if (this.overtempCooldownUntilMs === 0) return
    this.overtempCooldownUntilMs = 0
    this.stop(nowMs, probeC)
  }

  /** Everything off. */
  shutDown() {
    this.mode = 'idle'
    this.requestedFan = 0
    this.requestedHeat = 0
    this.effectiveFan = 0
    this.effectiveHeat = 0
    this.fanRunningSinceMs = undefined
    this.heatRequestedSinceMs = undefined
    this.leaseExpiresAtMs = 0
  }

  /**
   * One simulation step. Returns the events a program needs to react to: an expired lease or the
   * sustained-overtemperature latch.
   */
  tick(nowMs: number, dtMs: number, probeC: number): { leaseExpired: boolean; overtemperature: boolean } {
    let leaseExpired = false
    void dtMs
    let overtemperature = false

    // The overtemperature protocol: the limit held for OVERTEMP_HOLD_MS while Heat is requested or on
    // cuts Heat, latches, and starts the cooldown; a reading still over the limit keeps it going.
    if (probeC >= OVERTEMP_C) {
      this.overtemperatureSinceMs ??= nowMs
      const sustained = nowMs - this.overtemperatureSinceMs >= OVERTEMP_HOLD_MS
      if (sustained && this.fault === 'none' && (this.requestedHeat > 0 || this.effectiveHeat > 0)) {
        this.fault = 'overtemperature'
        overtemperature = true
      } else if (sustained && this.overtempCooldownUntilMs !== 0) {
        this.overtempCooldownUntilMs = nowMs + OVERTEMP_COOLDOWN_MS
      }
    } else {
      this.overtemperatureSinceMs = undefined
    }
    if (this.overtempCooldownUntilMs !== 0 && nowMs >= this.overtempCooldownUntilMs) {
      this.overtempCooldownUntilMs = 0
      this.shutDown()
    }

    if (this.mode !== 'running') return { leaseExpired, overtemperature }

    if (this.requestedHeat > 0 && nowMs > this.leaseExpiresAtMs && this.thermalInputValid) {
      // Nothing renewed the lease. A missing probe is handled by the roast's explicit holdover
      // window instead, so the terminal reason remains sensor_lost rather than a false lease fault.
      this.shutDown()
      leaseExpired = true
    }

    if (this.mode === 'running') this.settle(nowMs)
    return { leaseExpired, overtemperature }
  }

  /**
   * Recompute what is actually being driven from what was last requested. Called at the end of a
   * tick and again once the programs have issued their commands, so a command and the log sample
   * that records it describe the same instant rather than being one tick apart.
   */
  settle(nowMs: number) {
    if (this.mode !== 'running') return
    const levels = effectiveLevels({ fan: this.requestedFan, heat: this.requestedHeat })
    const qualified = this.heatRequestedSinceMs !== undefined && nowMs - this.heatRequestedSinceMs >= FAN_QUALIFY_MS
    const heatAllowed = qualified && this.fault === 'none' && this.thermalInputValid
    this.effectiveFan = round3(levels.fan)
    this.effectiveHeat = heatAllowed ? round3(levels.heat) : 0
  }
}
