import type { ControllerStatus, Profile } from './types'

export const STALE_AFTER_MS = 15000

export const isStatusStale = (status: ControllerStatus, nowMs: number) =>
  !Number.isFinite(status.receivedAtMs) || nowMs - status.receivedAtMs > STALE_AFTER_MS

export interface StartGateInput {
  profile?: Profile
  status: ControllerStatus
  hasOpenSession: boolean
  nowMs: number
}

// Start is an explicit allow-list: every condition below must hold on validated status.
export const startBlockedReason = ({ profile, status, hasOpenSession, nowMs }: StartGateInput): string | undefined => {
  if (!profile) return 'Select a roast profile'
  if (hasOpenSession) return 'Resolve the open roast session before starting another roast'
  if (!status.connected) return 'The roaster is not connected'
  if (isStatusStale(status, nowMs)) return 'The roaster has stopped reporting'
  if (status.manualLockout || status.lifecycle === 'MANUAL_LOCKOUT') return 'Manual controls are active'
  if (status.fault || status.lifecycle === 'FAULT') return status.fault ?? 'The roaster has latched a fault'
  if (status.thermalLog?.available === false)
    return 'Thermal recording memory is unavailable; restart or service the roaster before roasting'
  if (profile.strategy === 'thermal-intent') {
    if (!status.thermocoupleValid) return 'Thermocouple unavailable'
    if (profile.calibrationStatus !== 'validated') return 'Thermal calibration is not validated'
    if (!status.capabilities.thermalExecution) return 'Thermal runner is not installed'
  } else if (!status.capabilities.autonomousTimedPrograms) return 'Timed runner is not installed'
  if (status.lifecycle !== 'READY')
    return `The roaster is ${status.lifecycle.replace('_', ' ').toLowerCase()}, not ready to start`
  return undefined
}
