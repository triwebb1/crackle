import { describe, expect, it } from 'vitest'
import type { ControllerStatus } from '../domain/types'
import {
  activeConfiguredTarget,
  configuredRoasterTargets,
  targetHttpUrl,
  targetNavigationUrl,
  targetSwitchBlockedReason,
  targetVerificationFailure,
} from './targets'

const idle = (): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: 1,
  firmwareVersion: 'x',
  bootId: '1',
  manualLockout: false,
  thermocoupleValid: true,
  capabilities: { apiVersion: 'x', autonomousTimedPrograms: false, thermalExecution: false, diagnosticTests: true },
})

describe('configured roaster targets', () => {
  it('offers an isolated mock and physical proxy in local development', () => {
    const targets = configuredRoasterTargets(true, 'http://127.0.0.1:5173')
    expect(targets.map((target) => target.id)).toEqual(['mock', 'physical'])
    expect(targets[1]).toMatchObject({ baseUrl: 'http://127.0.0.1:5173', pathPrefix: '/__crackle/physical' })
    expect(targetHttpUrl(targets[1], '/api/status')).toBe('http://127.0.0.1:5173/__crackle/physical/api/status')
    expect(activeConfiguredTarget(targets, '?roaster=physical').kind).toBe('physical')
  })

  it('keeps firmware-hosted production same-origin', () => {
    expect(configuredRoasterTargets(false, 'http://crackle.local')).toEqual([
      { id: 'current', label: 'This roaster', kind: 'physical', address: 'http://crackle.local', baseUrl: '' },
    ])
  })

  it('builds a full-page handoff URL without losing the current route fragment', () => {
    expect(targetNavigationUrl('http://127.0.0.1:5173/?x=1#/roast', 'physical')).toBe(
      'http://127.0.0.1:5173/?x=1&roaster=physical#/roast',
    )
    expect(targetNavigationUrl('http://127.0.0.1:5173/?roaster=physical#/history', 'mock')).toBe(
      'http://127.0.0.1:5173/#/history',
    )
  })

  it('blocks switching for every active or unsaved state', () => {
    expect(
      targetSwitchBlockedReason({
        status: { ...idle(), roast: { active: true, mode: 'manual', saturated: false, holdover: false } },
        profileDirty: false,
        beanDirty: false,
        pendingWrites: 0,
        switching: false,
      }),
    ).toMatch(/roast/i)
    expect(
      targetSwitchBlockedReason({
        status: idle(),
        profileDirty: true,
        beanDirty: false,
        pendingWrites: 0,
        switching: false,
      }),
    ).toMatch(/working catalog edit/i)
    expect(
      targetSwitchBlockedReason({
        status: idle(),
        profileDirty: false,
        beanDirty: false,
        pendingWrites: 2,
        switching: false,
      }),
    ).toMatch(/2 device writes/i)
    expect(
      targetSwitchBlockedReason({
        status: idle(),
        profileDirty: false,
        beanDirty: false,
        pendingWrites: 0,
        switching: false,
        manualRecordingSettlementPending: true,
      }),
    ).toMatch(/manual roast.*saved/i)
    expect(
      targetSwitchBlockedReason({
        status: idle(),
        profileDirty: false,
        beanDirty: false,
        pendingWrites: 0,
        switching: false,
        recordingImportPending: true,
      }),
    ).toMatch(/recordings.*reconciled/i)
    expect(
      targetSwitchBlockedReason({
        status: idle(),
        profileDirty: false,
        beanDirty: false,
        pendingWrites: 0,
        switching: false,
      }),
    ).toBeUndefined()
  })

  it('translates only unreachable target failures and preserves device explanations', () => {
    const physical = configuredRoasterTargets(true, 'http://127.0.0.1:5173')[1]
    expect(targetVerificationFailure(physical, 'HTTP 500')).toEqual({
      message: expect.stringMatching(/could not be reached.*current roaster remains selected.*retry/i),
      detail: 'HTTP 500',
    })
    expect(targetVerificationFailure(physical, 'The thermocouple service is unavailable')).toEqual({
      message: 'The thermocouple service is unavailable',
    })
    expect(targetVerificationFailure(physical, 'The operation timed out')).toEqual({
      message: expect.stringMatching(/did not answer.*current roaster remains selected/i),
      detail: 'The operation timed out',
    })
  })
})
