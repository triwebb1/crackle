import { describe, expect, it } from 'vitest'
import { joinNeeds, requirementSentence, thermalJourneyRequirements, unmetRequirements } from './requirements'
import type { ControllerStatus, ThermalIntent } from './types'

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

const intent = (calibrationStatus: ThermalIntent['calibrationStatus']): ThermalIntent => ({
  id: 'intent',
  name: 'Journey',
  revision: 1,
  strategy: 'thermal-intent',
  createdAt: '',
  updatedAt: '',
  metadata: { intent: '' },
  notes: '',
  calibrationStatus,
  segments: [],
})

describe('requirement messages', () => {
  it('drops everything that is already satisfied', () => {
    const requirements = [
      { key: 'a', need: 'a healthy thermocouple', met: true },
      { key: 'b', need: 'validated thermal calibration', met: false },
    ]
    expect(unmetRequirements(requirements).map((item) => item.key)).toEqual(['b'])
    expect(requirementSentence(requirements)).toBe('Requires validated thermal calibration.')
  })

  it('says nothing at all when nothing is missing', () => {
    expect(requirementSentence([{ key: 'a', need: 'anything', met: true }])).toBeUndefined()
    expect(requirementSentence([])).toBeUndefined()
  })

  it('joins two needs with "and" and three with commas', () => {
    expect(joinNeeds(['one'])).toBe('one')
    expect(joinNeeds(['one', 'two'])).toBe('one and two')
    expect(joinNeeds(['one', 'two', 'three'])).toBe('one, two and three')
  })

  /**
   * The Profiles page must not say a journey "requires a healthy thermocouple and validated thermal
   * calibration" while the thermocouple is healthy. Naming a satisfied condition
   * reads as a fault report about something that is fine.
   */
  it('never names a healthy thermocouple as a requirement', () => {
    const healthy = thermalJourneyRequirements(intent('experimental'), status())
    expect(requirementSentence(healthy)).toBe(
      'Requires validated thermal calibration and an installed temperature-journey runner.',
    )
    expect(requirementSentence(healthy)).not.toContain('thermocouple')
  })

  it('names the thermocouple as soon as it really is the problem', () => {
    const faulted = thermalJourneyRequirements(intent('validated'), status({ thermocoupleValid: false }))
    expect(requirementSentence(faulted)).toBe(
      'Requires a healthy thermocouple and an installed temperature-journey runner.',
    )
  })

  it('falls silent once the controller can actually do it', () => {
    const ready = thermalJourneyRequirements(
      intent('validated'),
      status({
        capabilities: {
          apiVersion: 'runner-v1',
          autonomousTimedPrograms: true,
          thermalExecution: true,
          diagnosticTests: true,
        },
      }),
    )
    expect(requirementSentence(ready)).toBeUndefined()
  })

  it('treats an absent controller as failing every controller-side requirement', () => {
    expect(requirementSentence(thermalJourneyRequirements(intent('validated'), undefined))).toBe(
      'Requires a healthy thermocouple and an installed temperature-journey runner.',
    )
  })
})
