/**
 * The manual session, and the instruction lease that bounds it.
 *
 * The lease is the whole reason this file is interesting. An instruction is good for 30 minutes, and
 * 30 minutes after the last accepted `set` the WHOLE instruction expires: the session ends with a
 * full stop (`end_reason: instruction_expired`). Any new `set` - the same levels repeated, or
 * different ones - resets the clock.
 *
 * **Nothing about a client being connected enters into it**, and the mock has to get that right or
 * development would keep re-teaching the rule this replaced. The predecessor was a 60 s client
 * keepalive: closing the browser cut the heat, and the safeguard lived in a web page rather than on
 * the device. It does not any more, in the firmware or here.
 *
 * A fan-only session expires too, and that is the correction this file most recently needed. It used
 * to model expiry as "stop renewing the Heat lease and let the actuator's own 30 s bound drop it",
 * which is an earlier draft of the firmware and has two visible tells: a fan-only session never ended
 * at all, and a heat-bearing one stayed `active` for up to 30 s past its limit. A fan-only setting is
 * an instruction like any other, and a session that lingered would go on blocking programs and
 * holding Wi-Fi awake - see `firmware/crackle/README.md`, "The instruction lease".
 */

import type { ManualEndReason } from '../src/domain/types'
import { MANUAL_INSTRUCTION_LIMIT_MS, round1 } from './config'
import type { ProgramHost } from './host'

export class ManualSession {
  active = false
  fanLevel = 0
  heatLevel = 0
  endReason?: ManualEndReason
  /** Time at the CURRENT applied levels, so re-applying new levels restarts it. */
  private levelsSetAtMs = 0
  /** When the instruction in force was issued, whatever it asked for. The lease clock. */
  private lastSetAtMs = 0

  sinceMs(nowMs: number) {
    return this.active ? Math.max(0, nowMs - this.levelsSetAtMs) : 0
  }
  instructionAgeMs(nowMs: number) {
    return this.active ? Math.max(0, nowMs - this.lastSetAtMs) : 0
  }

  /** Apply levels. Returns the actuator's refusal text, or undefined on acceptance. */
  set(host: ProgramHost, fan: number, heat: number): string | undefined {
    const nowMs = host.nowMs
    const refusal = host.actuator.request(nowMs, round1(fan), round1(heat))
    if (refusal) return refusal
    if (!this.active) {
      // Manual Controls is an operating tool, not a roast-recording workflow. The explicit Manual
      // Roast path owns archived temperature curves and instruction journals.
      this.active = true
      this.endReason = undefined
    }
    if (round1(fan) !== this.fanLevel || round1(heat) !== this.heatLevel) {
      this.levelsSetAtMs = nowMs
    }
    this.fanLevel = round1(fan)
    this.heatLevel = round1(heat)
    this.lastSetAtMs = nowMs
    return undefined
  }

  /** End the session and stop every output immediately. */
  stop(host: ProgramHost, reason: ManualEndReason = 'stopped') {
    if (!this.active) return
    this.active = false
    this.endReason = reason
    this.fanLevel = 0
    this.heatLevel = 0
    host.actuator.stop(host.nowMs, host.plant.probeC)
  }

  /** One control pass. Returns true while the session still owns the actuator. */
  tick(host: ProgramHost, leaseExpired: boolean): boolean {
    if (!this.active) return false

    // First, and asking nothing about what the instruction was for. The firmware ends the session on
    // the age of the last accepted `set` alone (`>`, not `>=`), so a fan-only session expires on the
    // same tick a heat-bearing one would, and neither outlives its limit by an actuator lease.
    if (this.instructionAgeMs(host.nowMs) > MANUAL_INSTRUCTION_LIMIT_MS) {
      this.stop(host, 'instruction_expired')
      return false
    }
    if (leaseExpired) {
      // Heat stopped with the instruction still in date, so the renewal below was refused rather
      // than withheld. The firmware reports that as its own reason, and so does this.
      this.stop(host, 'heat_lease_expired')
      return false
    }
    if (host.actuator.fault !== 'none') {
      this.stop(host, 'fault')
      return false
    }

    if (this.heatLevel > 0 && host.actuator.effectiveHeat <= 0) return true
    host.actuator.request(host.nowMs, this.fanLevel, this.heatLevel)
    return true
  }
}
