import { describe, expect, it } from 'vitest'
import { starterProfile, starterThermalIntent } from '../data/demo'
import { isStatusStale, STALE_AFTER_MS, startBlockedReason } from './startGate'
import type { ControllerStatus, Profile } from './types'

const NOW = 1_800_000_000_000

const statusWith = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'READY',
  connected: true,
  stale: false,
  receivedAtMs: NOW,
  firmwareVersion: '2026-07-26.26',
  bootId: '7',
  manualLockout: false,
  thermocoupleValid: true,
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  ...overrides,
})

const blocked = (status: ControllerStatus, profile: Profile = starterProfile, hasOpenSession = false) =>
  startBlockedReason({ profile, status, hasOpenSession, nowMs: NOW })

describe('roast start gate', () => {
  it('allows start only with a runner, a ready controller, and clean status', () => {
    const runnerReady = statusWith({
      capabilities: {
        apiVersion: 'runner-v1',
        autonomousTimedPrograms: true,
        thermalExecution: false,
        diagnosticTests: true,
      },
    })
    expect(blocked(runnerReady)).toBeUndefined()
    expect(
      blocked(statusWith({ capabilities: runnerReady.capabilities, thermalLog: { available: false, active: false } })),
    ).toBe('Thermal recording memory is unavailable; restart or service the roaster before roasting')
  })

  it('blocks every state reachable with the current diagnostic firmware', () => {
    expect(blocked(statusWith())).toBe('Timed runner is not installed')
    expect(blocked(statusWith({ lifecycle: 'STANDBY' }))).toBe('Timed runner is not installed')
    expect(blocked(statusWith({ lifecycle: 'MANUAL_LOCKOUT', manualLockout: true }))).toBe('Manual controls are active')
    expect(blocked(statusWith({ lifecycle: 'FAULT', fault: 'fan_stalled' }))).toBe('fan_stalled')
    expect(blocked(statusWith({ lifecycle: 'DISCONNECTED', connected: false }))).toBe('The roaster is not connected')
    expect(
      startBlockedReason({
        profile: starterProfile,
        status: statusWith(),
        hasOpenSession: false,
        nowMs: NOW + STALE_AFTER_MS + 1,
      }),
    ).toBe('The roaster has stopped reporting')
  })

  it('blocks a missing profile and an unresolved session first', () => {
    expect(startBlockedReason({ profile: undefined, status: statusWith(), hasOpenSession: false, nowMs: NOW })).toBe(
      'Select a roast profile',
    )
    expect(blocked(statusWith(), starterProfile, true)).toBe(
      'Resolve the open roast session before starting another roast',
    )
  })

  it('blocks a runner-ready controller that is not in READY', () => {
    const runner = {
      apiVersion: 'runner-v1',
      autonomousTimedPrograms: true,
      thermalExecution: true,
      diagnosticTests: true,
    }
    expect(blocked(statusWith({ lifecycle: 'STANDBY', capabilities: runner }))).toBe(
      'The roaster is standby, not ready to start',
    )
    expect(blocked(statusWith({ lifecycle: 'RUNNING', capabilities: runner }))).toBe(
      'The roaster is running, not ready to start',
    )
  })

  it('adds thermocouple and calibration conditions to a temperature journey', () => {
    const runner = {
      apiVersion: 'runner-v1',
      autonomousTimedPrograms: true,
      thermalExecution: true,
      diagnosticTests: true,
    }
    expect(blocked(statusWith({ capabilities: runner, thermocoupleValid: false }), starterThermalIntent)).toBe(
      'Thermocouple unavailable',
    )
    expect(blocked(statusWith({ capabilities: runner }), starterThermalIntent)).toBe(
      'Thermal calibration is not validated',
    )
    const validated = { ...starterThermalIntent, calibrationStatus: 'validated' as const }
    expect(blocked(statusWith({ capabilities: { ...runner, thermalExecution: false } }), validated)).toBe(
      'Thermal runner is not installed',
    )
    expect(blocked(statusWith({ capabilities: runner }), validated)).toBeUndefined()
  })

  it('treats a status older than the staleness window as stale', () => {
    expect(isStatusStale(statusWith(), NOW + STALE_AFTER_MS)).toBe(false)
    expect(isStatusStale(statusWith(), NOW + STALE_AFTER_MS + 1)).toBe(true)
    expect(isStatusStale(statusWith({ receivedAtMs: 0 }), NOW)).toBe(true)
  })
})
