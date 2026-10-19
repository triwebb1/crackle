import { describe, expect, it } from 'vitest'
import { faultNotice } from './faultBanner'
import type { ControllerStatus } from './types'

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: Date.now(),
  firmwareVersion: '2026-07-26.34',
  bootId: '3',
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

describe('fault banner', () => {
  it('stays silent on a healthy controller', () => {
    expect(faultNotice(status())).toBeUndefined()
    expect(faultNotice(status({ lifecycle: 'RUNNING' }))).toBeUndefined()
    expect(faultNotice(status({ lifecycle: 'STANDBY' }))).toBeUndefined()
    // A disconnected controller is not a fault; the lifecycle badge already says so.
    expect(faultNotice(status({ connected: false, stale: true }))).toBeUndefined()
    expect(faultNotice(status({ connected: false, stale: true, fault: 'Signal timed out' }))).toBeUndefined()
  })

  it('raises overtemperature as the critical case, naming the protocol that latched it', () => {
    const notice = faultNotice(status({ fault: 'overtemperature', lifecycle: 'FAULT' }))
    expect(notice?.severity).toBe('critical')
    expect(notice?.label).toBe('Overtemperature')
    expect(notice?.headline).toBe('FAULT: Overtemperature - actuation disabled until the roaster is power-cycled')
    expect(notice?.detail).toMatch(/its overheat limit or more while Heat was on/)
    expect(notice?.detail).toMatch(/Power-cycle the roaster/)
  })

  it('quotes the limit the firmware reports, and the cooldown while it runs', () => {
    const cooling = faultNotice(
      status({
        fault: 'overtemperature',
        lifecycle: 'FAULT',
        overtempLimitC: 260,
        overtempCooldownRemainingMs: 150_000,
      }),
    )
    expect(cooling?.detail).toMatch(/read 260 °C or more/)
    expect(cooling?.detail).toMatch(/cooldown at Fan 10 \(about 3 min left\); Stop ends it/)
    const done = faultNotice(
      status({ fault: 'overtemperature', lifecycle: 'FAULT', overtempLimitC: 280, overtempCooldownRemainingMs: 0 }),
    )
    expect(done?.detail).toMatch(/read 280 °C or more/)
    expect(done?.detail).toMatch(/ran a cooldown/)
  })

  it('raises any other latched actuator fault as serious, humanizing its name', () => {
    const notice = faultNotice(status({ fault: 'zero_cross_lost', lifecycle: 'FAULT' }))
    expect(notice?.severity).toBe('serious')
    expect(notice?.label).toBe('Zero cross lost')
    expect(notice?.headline).toContain('FAULT: Zero cross lost')
    expect(notice?.detail).toMatch(/never auto-resumes/)

    const unknown = faultNotice(status({ fault: 'something_new' }))
    expect(unknown?.label).toBe('Something new')
    expect(unknown?.severity).toBe('serious')
    expect(unknown?.detail).toMatch(/power-cycled/)
  })

  it('explains recoverable stale telemetry without asking for a power cycle', () => {
    const notice = faultNotice(status({ fault: 'thermal_stale', lifecycle: 'FAULT' }))
    expect(notice?.label).toBe('Temperature updates paused')
    expect(notice?.headline).toContain('Heat stopped safely')
    expect(notice?.detail).toContain('fresh readings return')
    expect(notice?.detail).toContain('no power cycle is needed')
  })

  it('treats the manual-conflict latch as the same class of hard stop', () => {
    const byFlag = faultNotice(status({ manualLockout: true, lifecycle: 'MANUAL_LOCKOUT' }))
    expect(byFlag?.fault).toBe('manual_conflict')
    expect(byFlag?.severity).toBe('serious')
    expect(byFlag?.detail).toMatch(/no web clear/)
    // The lifecycle alone is enough, since lockout dominates whatever the firmware reports.
    expect(faultNotice(status({ lifecycle: 'MANUAL_LOCKOUT' }))?.fault).toBe('manual_conflict')
  })

  it('lets an actuator fault outrank a simultaneous lockout', () => {
    expect(faultNotice(status({ fault: 'overtemperature', manualLockout: true }))?.fault).toBe('overtemperature')
  })

  it('ignores the firmware none sentinel and blank strings', () => {
    expect(faultNotice(status({ fault: 'none' }))).toBeUndefined()
    expect(faultNotice(status({ fault: '   ' }))).toBeUndefined()
    expect(faultNotice(status({ fault: undefined }))).toBeUndefined()
  })
})
