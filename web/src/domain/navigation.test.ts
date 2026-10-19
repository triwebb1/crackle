import { describe, expect, it } from 'vitest'
import { liveReadoutHint, liveReadoutTarget } from './navigation'
import type { ControllerStatus } from './types'

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: 0,
  firmwareVersion: '2026-07-26.36',
  bootId: '4',
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

const target = (overrides: Partial<ControllerStatus> = {}, roastInProgress = false) =>
  liveReadoutTarget({ status: status(overrides), roastInProgress })

describe('where the header readout goes', () => {
  it('opens Manual for a manual hold', () => {
    expect(target({ manual: { active: true, fanLevel: 4, heatLevel: 6 } })).toBe('manual')
  })

  it('opens Roast for a roast in progress', () => {
    expect(target({}, true)).toBe('roast')
  })

  it('opens Calibrate for a running calibration program', () => {
    expect(target({ calibration: { active: true, stepIndex: 2, stepCount: 12 } })).toBe('calibrate')
  })

  it('falls back to Manual with nothing running, because that is where you make it move', () => {
    expect(target()).toBe('manual')
    expect(target({ manual: { active: false }, calibration: { active: false } })).toBe('manual')
  })

  it('prefers the most direct owner of the numbers when more than one could claim them', () => {
    // A manual hold drives fan and heat itself, so it wins over a roast session left open.
    expect(target({ manual: { active: true, fanLevel: 4, heatLevel: 0 } }, true)).toBe('manual')
    // A roast session is closer to the numbers than a calibration program that is also flagged.
    expect(target({ calibration: { active: true } }, true)).toBe('roast')
  })

  it('names the destination, so the control says what it will do before it is pressed', () => {
    expect(liveReadoutHint('manual')).toBe('Open manual control')
    expect(liveReadoutHint('roast')).toBe('Open the roast in progress')
    expect(liveReadoutHint('calibrate')).toBe('Open the running calibration program')
  })
})
