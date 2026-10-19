import { describe, expect, it } from 'vitest'
import {
  CALIBRATION_LIMITS,
  calibrationStartBlockedReason,
  DEFAULT_MAX_STEP_SECONDS,
  DEFAULT_MIN_STEP_SECONDS,
  DEFAULT_SETTLE_BAND_C,
  DEFAULT_SETTLE_SECONDS,
  formatStepPairs,
  parseStepPairs,
  programMaximumSec,
  resolveProgramForm,
} from './calibrationProgram'
import type { ControllerStatus } from './types'

const NOW = 1_800_000_000_000

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: NOW - 1000,
  firmwareVersion: '2026-07-26.30',
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

const gate = (overrides: Partial<Parameters<typeof calibrationStartBlockedReason>[0]> = {}) =>
  calibrationStartBlockedReason({ status: status(), nowMs: NOW, busy: false, ...overrides })

describe('calibration settle contract', () => {
  it('matches the controller defaults for a deliberate, narrow settling observation', () => {
    expect(DEFAULT_MAX_STEP_SECONDS).toBe(300)
    expect(DEFAULT_MIN_STEP_SECONDS).toBe(20)
    expect(DEFAULT_SETTLE_SECONDS).toBe(20)
    expect(DEFAULT_SETTLE_BAND_C).toBe(0.2)
    expect(CALIBRATION_LIMITS.settleBandC.min).toBe(0.2)
  })
})

describe('fan:heat step-pair parsing', () => {
  it('accepts one to twelve pairs in range, tolerating spaces and a trailing comma', () => {
    expect(parseStepPairs('3:1,3:5,5:5')).toEqual({
      steps: [
        { fan: 3, heat: 1 },
        { fan: 3, heat: 5 },
        { fan: 5, heat: 5 },
      ],
    })
    expect(parseStepPairs(' 3 : 1 , 5.5:2.5 ')).toEqual({
      steps: [
        { fan: 3, heat: 1 },
        { fan: 5.5, heat: 2.5 },
      ],
    })
    expect(parseStepPairs('3:4,')).toEqual({ steps: [{ fan: 3, heat: 4 }] })
    expect(parseStepPairs('10:10')).toEqual({ steps: [{ fan: 10, heat: 10 }] })
    expect(parseStepPairs(Array.from({ length: 12 }, () => '3:1').join(',')).steps).toHaveLength(12)
  })

  it('accepts fan-only recovery steps and fan-zero passive-decay steps', () => {
    expect(parseStepPairs('5:0')).toEqual({ steps: [{ fan: 5, heat: 0 }] })
    expect(parseStepPairs('3:5,0:0')).toEqual({
      steps: [
        { fan: 3, heat: 5 },
        { fan: 0, heat: 0 },
      ],
    })
  })

  it('rejects fan 0 with heat, exactly as the firmware pair parser does', () => {
    expect(parseStepPairs('0:5').error).toMatch(/fan 0 is only allowed with heat 0/)
    expect(parseStepPairs('3:1,0:0.5').error).toMatch(/fan 0 is only allowed with heat 0/)
    expect(parseStepPairs('0:5').steps).toEqual([])
  })

  it('rejects empty, oversized, malformed, and out-of-range lists', () => {
    expect(parseStepPairs('').error).toMatch(/at least one/)
    expect(parseStepPairs('  ,  ').error).toMatch(/at least one/)
    expect(parseStepPairs(Array.from({ length: 13 }, () => '3:1').join(',')).error).toMatch(/at most 12/)
    expect(parseStepPairs('3').error).toMatch(/not a fan:heat pair/)
    expect(parseStepPairs('3:').error).toMatch(/not a fan:heat pair/)
    expect(parseStepPairs(':3').error).toMatch(/not a fan:heat pair/)
    expect(parseStepPairs('3:1:2').error).toMatch(/not a fan:heat pair/)
    expect(parseStepPairs('3:abc').error).toMatch(/not a fan:heat pair/)
    expect(parseStepPairs('3:-1').error).toMatch(/not a fan:heat pair/)
    expect(parseStepPairs('3:10.5').error).toMatch(/outside 0.0 to 10.0/)
    expect(parseStepPairs('10.5:3').error).toMatch(/outside 0.0 to 10.0/)
  })

  it('round-trips through the display formatter', () => {
    expect(formatStepPairs(parseStepPairs('3:1,3:3,5:3').steps)).toBe('3:1,3:3,5:3')
    expect(formatStepPairs([])).toBe('')
  })

  it('reports the worst-case length, since adaptive settling can only shorten it', () => {
    expect(
      programMaximumSec(
        [
          { fan: 3, heat: 1 },
          { fan: 3, heat: 5 },
        ],
        120,
      ),
    ).toBe(240)
    expect(programMaximumSec([], 120)).toBe(0)
  })
})

/**
 * One program form with an EXPLICIT mode. Inferring the mode from whether the sequence field has
 * content would change the program as a side effect of typing, and the operator could not see what
 * was going to run. The mode is a control, and only the selected input is
 * validated - a half-typed sequence cannot block a grid pass.
 */
describe('the program form and its explicit mode', () => {
  const form = (overrides: Partial<Parameters<typeof resolveProgramForm>[0]> = {}) =>
    resolveProgramForm({ fansRaw: '1,4,7,10', heatsRaw: '1,5,10', stepsRaw: '', mode: 'grid', ...overrides })

  it('runs the grid in grid mode', () => {
    const resolved = form()
    expect(resolved.form).toBe('grid')
    expect(resolved.overridden).toBe(false)
    expect(resolved.fans).toEqual([1, 4, 7, 10])
    expect(resolved.heats).toEqual([1, 5, 10])
    expect(resolved.steps).toHaveLength(12)
    // Expanded serpentine, exactly as the firmware expands it.
    expect(formatStepPairs(resolved.steps.slice(0, 6))).toBe('1:1,1:5,1:10,4:10,4:5,4:1')
    expect(resolved.error).toBeUndefined()
  })

  it('ignores the sequence field entirely while grid mode is selected', () => {
    // Content left in the other input can no longer change what runs.
    expect(form({ stepsRaw: '3:1,3:5' }).form).toBe('grid')
    expect(form({ stepsRaw: '3:1,3:5' }).steps).toHaveLength(12)
    expect(form({ stepsRaw: 'garbage' }).error).toBeUndefined()
  })

  it('runs exactly the sequence in explicit mode', () => {
    const resolved = form({ mode: 'steps', stepsRaw: '3:1,3:5,3:10' })
    expect(resolved.form).toBe('steps')
    expect(resolved.overridden).toBe(true)
    expect(resolved.steps).toEqual([
      { fan: 3, heat: 1 },
      { fan: 3, heat: 5 },
      { fan: 3, heat: 10 },
    ])
    // The grid is not merged in, not partially applied, and not silently reordered.
    expect(resolved.fans).toEqual([])
    expect(resolved.heats).toEqual([])
  })

  it('validates only the input the selected mode uses', () => {
    // A broken grid is irrelevant in explicit mode.
    expect(form({ mode: 'steps', fansRaw: 'nonsense', stepsRaw: '3:1' }).error).toBeUndefined()
    // A broken sequence is the error in explicit mode, even beside a valid grid.
    expect(form({ mode: 'steps', stepsRaw: '0:5' }).error).toMatch(/fan 0 is only allowed with heat 0/)
    expect(form({ mode: 'steps', stepsRaw: '0:5' }).steps).toEqual([])
    expect(form({ mode: 'steps', stepsRaw: '' }).error).toMatch(/at least one/)
    expect(form({ fansRaw: '' }).error).toMatch(/at least one fan level/)
    expect(form({ heatsRaw: '0' }).error).toMatch(/must be above 0.0/)
    expect(form({ fansRaw: 'x' }).steps).toEqual([])
  })
})

describe('calibration start gate', () => {
  it('allows a start only when every condition holds', () => {
    expect(gate()).toBeUndefined()
  })

  it('blocks on controller state exactly like the roast gate does', () => {
    expect(gate({ status: status({ connected: false }) })).toBe('The roaster is not connected')
    expect(gate({ nowMs: NOW + 60_000 })).toBe('The roaster has stopped reporting')
    expect(gate({ status: status({ manualLockout: true }) })).toBe('Stop manual controls before starting calibration')
    expect(gate({ status: status({ manual: { active: true } }) })).toBe(
      'Stop manual controls before starting calibration',
    )
    expect(gate({ status: status({ fault: 'fan_stalled' }) })).toBe('fan_stalled')
  })

  it('explains controller-owned readiness and preserves old-firmware compatibility', () => {
    expect(gate({ status: status({ calibrationReady: false, calibrationReadiness: 'sensor_invalid' }) })).toBe(
      'The thermocouple must report a valid temperature before calibration can start',
    )
    expect(gate({ status: status({ calibrationReady: false, calibrationReadiness: 'sensor_fault_latched' }) })).toBe(
      'The thermocouple fault is latched; power-cycle the roaster before calibration',
    )
    expect(gate({ status: status({ calibrationReady: false, calibrationReadiness: 'too_hot' }) })).toBe(
      'Let the empty roaster cool to 60 °C or below before calibration',
    )
    expect(
      gate({
        status: status({ calibrationReady: false, calibrationReadiness: 'stabilizing', calibrationStableForMs: 6_250 }),
      }),
    ).toBe('Keep the empty roaster steady for 4 more seconds')
    expect(
      gate({
        status: status({ calibrationReady: true, calibrationReadiness: 'ready', calibrationStableForMs: 10_000 }),
      }),
    ).toBeUndefined()
    expect(gate({ status: status({ calibrationReady: undefined }) })).toBeUndefined()
  })

  it('fails closed without the diagnostic-tests capability and while a program runs', () => {
    const noDiagnostics = status({
      capabilities: {
        apiVersion: 'runner-v1',
        autonomousTimedPrograms: false,
        thermalExecution: false,
        diagnosticTests: false,
      },
    })
    expect(gate({ status: noDiagnostics })).toBe('This firmware does not offer calibration runs')
    expect(
      gate({
        status: status({ calibration: { active: true, stepIndex: 1, stepCount: 4, lastStepAdvance: 'settled' } }),
      }),
    ).toBe('A calibration program is already running')
    expect(gate({ status: status({ calibration: { active: false, endReason: 'completed' } }) })).toBeUndefined()
  })

  it('requires writable recording storage for baseline evidence without blocking calibration apply', () => {
    const memoryUnavailable = status({
      thermalLog: { available: false, active: false },
      logArchive: { mounted: true, needsFormat: false },
    })
    const needsFormat = status({ logArchive: { mounted: false, needsFormat: true } })
    const unavailable = status({ logArchive: { mounted: false, needsFormat: false } })
    const mounted = status({ logArchive: { mounted: true, needsFormat: false } })
    expect(gate({ status: memoryUnavailable })).toBe(
      'Thermal recording memory is unavailable; restart or service the roaster before calibration',
    )
    expect(gate({ status: needsFormat })).toBe('Format roaster storage in Settings before recording a baseline')
    expect(gate({ status: unavailable })).toBe(
      'Roaster recording storage is unavailable; restore it before calibration',
    )
    expect(gate({ status: mounted })).toBeUndefined()
    expect(gate({ status: needsFormat, requiresRecordingStorage: false })).toBeUndefined()
    expect(gate({ status: status({ restoreMaintenance: { active: true, incomplete: true } }) })).toBe(
      'Finish storage maintenance in Settings before starting calibration',
    )
    expect(
      gate({
        status: status({ restoreMaintenance: { active: false, incomplete: true } }),
        requiresRecordingStorage: false,
      }),
    ).toBe('Finish storage maintenance in Settings before starting calibration')
  })

  it('surfaces parameter errors and in-flight commands', () => {
    expect(gate({ paramError: 'Enter at least one fan:heat step' })).toBe('Enter at least one fan:heat step')
    expect(gate({ busy: true })).toBe('A calibration command is in flight')
  })

  it('no longer demands a typed word: the proof-phase ceremony retired with the arm endpoint', () => {
    // A confirm dialog in the view is the remaining pocket-tap protection; the gate itself is pure.
    expect(gate()).toBeUndefined()
  })
})
