import type { ControllerStatus } from './types'

export type FaultSeverity = 'critical' | 'serious'

export interface FaultNotice {
  fault: string
  label: string
  severity: FaultSeverity
  headline: string
  detail: string
}

const humanize = (fault: string) => {
  const words = fault.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// Firmware 2026-07-26.34 and later enforce hard-stop protections at the firmware level. Thermal telemetry
// staleness is deliberately different: it ends the active operation but clears after fresh readings
// and the short cooling hold, so it must never instruct the operator to power-cycle.
const overtemperatureDetail = (status: ControllerStatus) => {
  const limit = status.overtempLimitC === undefined ? 'its overheat limit' : `${Math.round(status.overtempLimitC)} °C`
  const cooling =
    (status.overtempCooldownRemainingMs ?? 0) > 0
      ? ` The fan is running a cooldown at Fan 10 (about ${Math.ceil((status.overtempCooldownRemainingMs ?? 0) / 60_000)} min left); Stop ends it.`
      : ' The fan ran a cooldown at Fan 10 until the probe stayed below the limit for three minutes.'
  return `The bean probe read ${limit} or more while Heat was on, so Heat was cut at once and locked off.${cooling} Power-cycle the roaster before any further work.`
}

const DETAIL: Record<string, string> = {
  manual_conflict:
    'The front panel on the roaster was turned while Crackle was holding the outputs. There is no web clear for this latch.',
  zero_cross_lost:
    'Mains zero-cross timing was lost on the heat side for longer than the coast policy allows. Heat never auto-resumes after this latch.',
}

/**
 * The one actuator-protection surface. Hard latches stay off until a power cycle; thermal telemetry
 * staleness instead ends the operation and clears only after fresh readings and cooling. It is
 * rendered full width at the top of every view rather than inside the screen that
 * happens to be open, because the operator may be looking at any of them when it latches.
 */
export const faultNotice = (status: ControllerStatus): FaultNotice | undefined => {
  if (!status.connected) return undefined
  const fault = status.fault?.trim()
  if (fault && fault !== 'none') {
    if (fault === 'thermal_stale') {
      return {
        fault,
        label: 'Temperature updates paused',
        severity: 'serious',
        headline: 'Temperature updates paused — Heat stopped safely',
        detail:
          'The controller stopped receiving fresh temperature updates while Heat was on, so it ended the operation and ran the short fan hold. It clears this condition after fresh readings return; no power cycle is needed.',
      }
    }
    return {
      fault,
      label: humanize(fault),
      // Overtemperature is the protocol that replaced the program ceiling; it outranks everything.
      severity: fault === 'overtemperature' ? 'critical' : 'serious',
      headline: `FAULT: ${humanize(fault)} - actuation disabled until the roaster is power-cycled`,
      detail:
        fault === 'overtemperature'
          ? overtemperatureDetail(status)
          : (DETAIL[fault] ??
            'The roaster latched an actuator fault. Actuation stays disabled until it is power-cycled.'),
    }
  }
  // A manual-conflict latch is not an actuator fault but is equally hard: it also has no web clear.
  if (status.manualLockout || status.lifecycle === 'MANUAL_LOCKOUT') {
    return {
      fault: 'manual_conflict',
      label: 'Manual conflict',
      severity: 'serious',
      headline: 'FAULT: Manual conflict - actuation disabled until the roaster is power-cycled',
      detail: DETAIL.manual_conflict,
    }
  }
  return undefined
}
