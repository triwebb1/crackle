import { describe, expect, it } from 'vitest'
import { thermocoupleOffsetBlockedReason } from './App'
import type { ControllerStatus } from './domain/types'

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'READY',
  connected: true,
  stale: false,
  receivedAtMs: Date.now(),
  firmwareVersion: 'test',
  bootId: 'boot-test',
  thermocoupleOffsetC: -3,
  manualLockout: false,
  thermocoupleValid: true,
  temperatureC: 24,
  capabilities: {
    apiVersion: 'diagnostic-v1',
    autonomousTimedPrograms: true,
    thermalExecution: true,
    diagnosticTests: true,
  },
  ...overrides,
})

describe('thermocouple correction mutation gate', () => {
  it('allows only a current, connected, idle roaster with no data mutation block', () => {
    expect(thermocoupleOffsetBlockedReason(status())).toBeUndefined()
    expect(thermocoupleOffsetBlockedReason(status(), 'Device data is still reconciling')).toBe(
      'Device data is still reconciling',
    )
    expect(thermocoupleOffsetBlockedReason(status({ connected: false }))).toContain('not connected')
    expect(thermocoupleOffsetBlockedReason(status({ stale: true }))).toContain('status is stale')
    expect(
      thermocoupleOffsetBlockedReason(
        status({ roast: { active: true, mode: 'timed', saturated: false, holdover: false } }),
      ),
    ).toContain('roast is running')
    expect(thermocoupleOffsetBlockedReason(status({ calibration: { active: true } }))).toContain(
      'Calibration is running',
    )
    expect(thermocoupleOffsetBlockedReason(status({ manual: { active: true } }))).toContain('Controls are active')
  })
})
