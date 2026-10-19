import { describe, expect, it } from 'vitest'
import type { LiveSnapshot } from '../controller/client'
import { liveBlocksFullStatus, liveIndicatesActuation, mergeLiveSnapshot, statusIndicatesActuation } from './liveStatus'
import { isStatusStale } from './startGate'
import type { ControllerStatus } from './types'

const NOW = 1_800_000_000_000

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: NOW - 4000,
  firmwareVersion: '2026-07-26.36',
  bootId: '4',
  manualLockout: false,
  thermocoupleValid: true,
  temperatureC: 100,
  ambientC: 24,
  effectiveFan: 4,
  effectiveHeat: 5,
  actuatorMode: 'heating',
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
  ...overrides,
})

const live = (overrides: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  receivedAtMs: NOW,
  connected: true,
  temperatureC: 148.5,
  ambientC: 24.6,
  effectiveFan: 4.5,
  effectiveHeat: 7,
  actuatorMode: 'heating',
  calibrationActive: false,
  manualActive: false,
  ...overrides,
})

describe('live actuation evidence', () => {
  it('covers program flags, effective outputs, Cooling, and actuator-only legacy state', () => {
    expect(liveIndicatesActuation(live({ calibrationActive: true }))).toBe(true)
    expect(liveIndicatesActuation(live({ manualActive: true }))).toBe(true)
    expect(liveIndicatesActuation(live({ roastActive: true }))).toBe(true)
    expect(liveIndicatesActuation(live({}))).toBe(true)
    expect(liveIndicatesActuation(live({ effectiveFan: 10 }))).toBe(true)
    expect(liveIndicatesActuation(live({ actuatorMode: 'fan_startup' }))).toBe(true)
    expect(
      liveIndicatesActuation(live({ thermalLogActive: true, effectiveFan: 0, effectiveHeat: 0, actuatorMode: 'idle' })),
    ).toBe(false)
    expect(
      liveBlocksFullStatus(live({ thermalLogActive: true, effectiveFan: 0, effectiveHeat: 0, actuatorMode: 'idle' })),
    ).toBe(true)
  })

  it('defers full status work from every merged active-state signal', () => {
    const idle = status({
      lifecycle: 'STANDBY',
      actuatorMode: 'idle',
      effectiveFan: 0,
      effectiveHeat: 0,
      calibration: { active: false },
      manual: { active: false },
    })
    expect(statusIndicatesActuation(idle)).toBe(false)
    expect(statusIndicatesActuation({ ...idle, lifecycle: 'RUNNING' })).toBe(true)
    expect(statusIndicatesActuation({ ...idle, effectiveFan: 10 })).toBe(true)
    expect(statusIndicatesActuation({ ...idle, calibration: { active: true } })).toBe(true)
    expect(statusIndicatesActuation({ ...idle, connected: false, effectiveHeat: 5 })).toBe(false)
  })
  it('requires a connected stream and returns false after the idle edge', () => {
    const idle = live({
      actuatorMode: 'idle',
      effectiveFan: 0,
      effectiveHeat: 0,
      calibrationActive: false,
      manualActive: false,
      roastActive: false,
    })
    expect(liveIndicatesActuation(idle)).toBe(false)
    expect(liveIndicatesActuation({ ...idle, connected: false, effectiveHeat: 5 })).toBe(false)
  })
})
describe('live snapshot merge', () => {
  it('refreshes the moving readings and advances the arrival stamp', () => {
    const merged = mergeLiveSnapshot(status(), live())
    expect(merged).toMatchObject({
      temperatureC: 148.5,
      ambientC: 24.6,
      effectiveFan: 4.5,
      effectiveHeat: 7,
      receivedAtMs: NOW,
    })
    // The contract fields come from the status document and are never touched by the fast poll.
    expect(merged.firmwareVersion).toBe('2026-07-26.36')
    expect(merged.capabilities.diagnosticTests).toBe(true)
  })

  it('keeps a controller answering the fast poll out of staleness', () => {
    // Four seconds since the last status document, one second since the last live reading.
    const stale = status({ receivedAtMs: NOW - 20000 })
    expect(isStatusStale(stale, NOW)).toBe(true)
    expect(isStatusStale(mergeLiveSnapshot(stale, live()), NOW)).toBe(false)
  })

  it('changes nothing at all when the live poll fails', () => {
    const base = status()
    expect(mergeLiveSnapshot(base, live({ connected: false }))).toBe(base)
    expect(mergeLiveSnapshot(base, undefined)).toBe(base)
  })

  it('shows a cold-loaded active calibration from a connected compact shell without inventing contract authority', () => {
    const offline = status({ connected: false, stale: true, lifecycle: 'DISCONNECTED', calibration: undefined })
    const completedSteps = [{ index: 0, fan: 2, heat: 4, elapsedSec: 61, temperatureC: 148.26, outcome: 'settled' }]
    const merged = mergeLiveSnapshot(
      offline,
      live({
        bootId: 'boot-live',
        calibrationActive: true,
        calibrationId: '82',
        calibrationStep: 3,
        calibrationCount: 12,
        calibrationFan: 4,
        calibrationHeat: 10,
        calibrationElapsedSec: 27,
        calibrationSettleState: 'checking',
        calibrationCompletedSteps: completedSteps,
      }),
    )
    expect(merged).toMatchObject({
      connected: true,
      stale: false,
      bootId: 'boot-live',
      lifecycle: 'RUNNING',
      calibration: {
        active: true,
        logId: '82',
        stepIndex: 3,
        stepCount: 12,
        currentFanLevel: 4,
        currentHeatLevel: 10,
        stepElapsedSec: 27,
        settleState: 'checking',
        completedSteps,
      },
    })
    expect(merged.roaster).toBeUndefined()
    expect(merged.dataStore).toBeUndefined()
    expect(merged.capabilities).toEqual(offline.capabilities)
    expect(mergeLiveSnapshot(offline, live({ bootId: 'boot-live', fault: 'Thermal sensor' })).lifecycle).toBe('FAULT')
  })

  it('recovers exact controller and manual authority from a self-identifying cold live frame', () => {
    const offline = status({
      connected: false,
      stale: true,
      lifecycle: 'DISCONNECTED',
      firmwareVersion: 'unavailable',
      roaster: undefined,
      manual: undefined,
      roast: undefined,
      capabilities: {
        apiVersion: 'unavailable',
        autonomousTimedPrograms: false,
        thermalExecution: false,
        diagnosticTests: false,
      },
    })
    const merged = mergeLiveSnapshot(
      offline,
      live({
        firmwareVersion: '2026-07-26.55',
        roaster: {
          deviceId: 'esp32-aabbcc',
          modelId: 'freshroast-sr800',
          displayName: 'FreshRoast SR800',
          simulated: false,
        },
        capabilities: {
          apiVersion: 'diagnostic-v1',
          autonomousTimedPrograms: false,
          thermalExecution: false,
          diagnosticTests: true,
          manualRoast: true,
        },
        manualLockout: false,
        manualActive: true,
        manualSinceMs: 31000,
        requestedFan: 4,
        requestedHeat: 1,
        roastMode: 'none',
        roastActive: false,
        roastSaturated: false,
        roastHoldover: false,
      }),
    )
    expect(merged).toMatchObject({
      connected: true,
      lifecycle: 'RUNNING',
      firmwareVersion: '2026-07-26.55',
      manualLockout: false,
      roaster: { deviceId: 'esp32-aabbcc', modelId: 'freshroast-sr800', simulated: false },
      capabilities: { apiVersion: 'diagnostic-v1', diagnosticTests: true, manualRoast: true },
      manual: { active: true, sinceMs: 31000, fanLevel: 4, heatLevel: 1 },
      roast: { active: false, mode: 'none', saturated: false, holdover: false },
    })
    expect(merged.dataStore).toBeUndefined()
  })

  it('recovers the exact active roast session needed for safe commands after refresh', () => {
    const offline = status({ connected: false, stale: true, lifecycle: 'DISCONNECTED', roast: undefined })
    const merged = mergeLiveSnapshot(
      offline,
      live({
        roastMode: 'manual',
        roastActive: true,
        roastSessionId: '93',
        planRev: 4,
        roastName: 'Morning roast',
        roastStartedEpoch: 1785432000,
        roastBatchMassG: 225,
        roastAmbientC: 24.5,
        roastSaturated: false,
        roastHoldover: false,
        roastElapsedSec: 72,
        requestedFan: 4,
        requestedHeat: 6,
      }),
    )
    expect(merged.roast).toMatchObject({
      active: true,
      mode: 'manual',
      sessionId: '93',
      planRev: 4,
      name: 'Morning roast',
      startedEpoch: 1785432000,
      batchMassG: 225,
      ambientC: 24.5,
      elapsedSec: 72,
      commandedFan: 4,
      commandedHeat: 6,
      saturated: false,
      holdover: false,
    })
  })

  it('uses authoritative log identity for a cold calibration tail without inventing it for roast or manual tails', () => {
    const offline = status({
      connected: false,
      stale: true,
      lifecycle: 'DISCONNECTED',
      calibration: undefined,
      thermalLog: undefined,
    })
    const calibrationTail = mergeLiveSnapshot(
      offline,
      live({
        bootId: 'boot-live',
        calibrationActive: false,
        calibrationId: '82',
        calibrationEndReason: 'completed',
        thermalLogActive: true,
        thermalLogId: '82',
        thermalLogSource: 'calibration',
        effectiveFan: 0,
        effectiveHeat: 0,
        actuatorMode: 'idle',
        calibrationStep: 48,
        calibrationCount: 48,
      }),
    )
    expect(calibrationTail).toMatchObject({
      connected: true,
      lifecycle: 'STANDBY',
      calibration: { active: false, logId: '82', endReason: 'completed', stepIndex: 48, stepCount: 48 },
      thermalLog: { active: true, unsaved: true, logId: '82', source: 'calibration' },
    })
    for (const source of ['roast', 'manual'] as const) {
      const otherTail = mergeLiveSnapshot(
        offline,
        live({
          calibrationActive: false,
          calibrationId: 'old-calibration',
          calibrationEndReason: 'completed',
          thermalLogActive: true,
          thermalLogId: `${source}-9`,
          thermalLogSource: source,
          effectiveFan: 0,
          effectiveHeat: 0,
          actuatorMode: 'idle',
        }),
      )
      expect(otherTail.calibration).toBeUndefined()
      expect(otherTail.thermalLog).toMatchObject({ active: true, unsaved: true, logId: `${source}-9`, source })
      expect(otherTail.lifecycle).toBe('STANDBY')
    }
  })

  it('does not retain an idle status claim that an active recording is already saved', () => {
    const merged = mergeLiveSnapshot(
      status({
        thermalLog: { active: false, unsaved: false, logId: 'prior', source: 'calibration' },
      }),
      live({
        thermalLogActive: true,
        thermalLogId: 'current',
        thermalLogSource: 'calibration',
        effectiveFan: 0,
        effectiveHeat: 0,
        actuatorMode: 'idle',
      }),
    )

    expect(merged.thermalLog).toMatchObject({ active: true, unsaved: true, logId: 'current' })
  })

  it('raises a fault seen on the fast poll to the lifecycle within a second', () => {
    const merged = mergeLiveSnapshot(status(), live({ fault: 'overtemperature' }))
    expect(merged.fault).toBe('overtemperature')
    expect(merged.lifecycle).toBe('FAULT')
  })

  it('keeps a manual-conflict latch dominant over any fault the fast poll reports', () => {
    const merged = mergeLiveSnapshot(
      status({ manualLockout: true, lifecycle: 'MANUAL_LOCKOUT' }),
      live({ fault: 'zero_cross_lost' }),
    )
    expect(merged.lifecycle).toBe('MANUAL_LOCKOUT')
  })

  it('treats a null probe reading as a faulted thermocouple, not as 0 °C', () => {
    const merged = mergeLiveSnapshot(status(), live({ temperatureC: undefined }))
    expect(merged.thermocoupleValid).toBe(false)
    // The last known reading is retained rather than collapsing to a fake zero.
    expect(merged.temperatureC).toBe(100)
  })

  it('refreshes the program and manual flags without inventing blocks the firmware never sent', () => {
    const withBlocks = status({
      calibration: { active: false, stepIndex: 0, stepCount: 12 },
      manual: { active: false, fanLevel: 4, heatLevel: 5, sinceMs: 1000 },
      thermalLog: { active: true, samples: 10, capacity: 4800 },
    })
    const merged = mergeLiveSnapshot(
      withBlocks,
      live({
        calibrationActive: true,
        calibrationStep: 5,
        calibrationCount: 12,
        manualActive: true,
        manualSinceMs: 45000,
        requestedFan: 6,
        requestedHeat: 7,
        logSamples: 640,
      }),
    )
    expect(merged.calibration).toMatchObject({ active: true, stepIndex: 5, stepCount: 12 })
    expect(merged.manual).toMatchObject({ active: true, sinceMs: 45000, fanLevel: 6, heatLevel: 7 })
    expect(merged.thermalLog).toMatchObject({ samples: 640, capacity: 4800 })

    // A firmware that sends no manual or calibration block degrades to "no state", never to a fake one.
    const bare = mergeLiveSnapshot(status(), live({ calibrationActive: true, manualActive: true }))
    expect(bare.calibration).toBeUndefined()
    expect(bare.manual).toBeUndefined()
  })

  it('refreshes controller-owned calibration detail while full status is deferred', () => {
    const withStalePreflight = status({
      calibration: {
        active: false,
        stepIndex: 0,
        stepCount: 12,
        currentFanLevel: 0,
        currentHeatLevel: 0,
        stepElapsedSec: 0,
        settleState: 'minimum_dwell',
        completedSteps: [],
        logId: '81',
      } as ControllerStatus['calibration'],
    })
    const completedSteps = [
      { index: 0, fan: 2, heat: 4, elapsedSec: 61, temperatureC: 148.26, outcome: 'settled' },
      { index: 1, fan: 2, heat: 7, elapsedSec: 120, temperatureC: 191.5, outcome: 'capped' },
    ]
    const merged = mergeLiveSnapshot(
      withStalePreflight,
      live({
        calibrationActive: true,
        calibrationStep: 3,
        calibrationCount: 12,
        calibrationId: '82',
        calibrationFan: 4,
        calibrationHeat: 10,
        calibrationElapsedSec: 27,
        calibrationSettleState: 'checking',
        calibrationCompletedSteps: completedSteps,
      }),
    )
    expect(merged.calibration).toMatchObject({
      active: true,
      stepIndex: 3,
      stepCount: 12,
      logId: '82',
      currentFanLevel: 4,
      currentHeatLevel: 10,
      stepElapsedSec: 27,
      settleState: 'checking',
      completedSteps,
    })
  })

  it('fences completed rows when a new pass identity arrives before its first event', () => {
    const calibration = {
      active: false,
      stepIndex: 11,
      stepCount: 12,
      logId: '81',
      completedSteps: [{ index: 0, fan: 3, heat: 2, elapsedSec: 60, outcome: 'settled' }],
    } as ControllerStatus['calibration']
    expect(
      mergeLiveSnapshot(
        status({ calibration }),
        live({
          calibrationActive: true,
          calibrationId: '82',
          calibrationStep: 0,
          calibrationCount: 12,
        }),
      ).calibration,
    ).toMatchObject({ logId: '82', completedSteps: [] })
  })

  it('preserves full-status calibration detail when older live firmware omits enrichment', () => {
    const calibration = {
      active: true,
      stepIndex: 0,
      stepCount: 4,
      currentFanLevel: 3,
      currentHeatLevel: 6,
      stepElapsedSec: 12,
      settleState: 'waiting_for_transition',
      completedSteps: [{ index: 0, fan: 3, heat: 2, elapsedSec: 60, outcome: 'settled' }],
    } as ControllerStatus['calibration']
    expect(
      mergeLiveSnapshot(
        status({ calibration }),
        live({
          calibrationActive: true,
          calibrationStep: 1,
          calibrationCount: 4,
        }),
      ).calibration,
    ).toMatchObject({ ...calibration, stepIndex: 1 })
  })
})

/**
 * The roast executor at stream cadence. The 1 Hz snapshot carries the executor's whole
 * per-tick progress tuple - full status is deferred while anything actuates, so during a roast the
 * stream is the only transport there is. Fields the frame does not carry stay status-owned, because
 * a number the live payload does not carry cannot be updated by it and pretending otherwise would
 * put a stale figure behind a fast-moving label.
 */
describe('the device roast in the merged status', () => {
  const running = status({
    roast: {
      active: true,
      mode: 'journey',
      name: 'ethiopia-yirg',
      elapsedSec: 100,
      zoneIndex: 1,
      zoneCount: 5,
      targetC: 160,
      commandedFan: 6,
      commandedHeat: 7.5,
      correctionTotal: 2.1,
      saturated: false,
      holdover: false,
    },
  })

  it('retains one coherent zone tuple, including its clock, until status catches up', () => {
    const merged = mergeLiveSnapshot(
      running,
      live({
        roastActive: true,
        roastJourney: true,
        roastElapsedSec: 137,
        roastZone: 2,
        roastZones: 5,
        roastTargetC: 171.4,
      }),
    )
    expect(merged.roast).toMatchObject({ elapsedSec: 100, zoneIndex: 1, zoneCount: 5, targetC: 160, mode: 'journey' })
    // Untouched, because the live payload has nothing to say about them.
    expect(merged.roast).toMatchObject({
      name: 'ethiopia-yirg',
      commandedFan: 6,
      commandedHeat: 7.5,
      correctionTotal: 2.1,
    })
  })

  it('accepts fast target updates when they belong to the same zone', () => {
    const merged = mergeLiveSnapshot(
      running,
      live({
        roastActive: true,
        roastJourney: true,
        roastElapsedSec: 137,
        roastZone: 1,
        roastZones: 5,
        roastTargetC: 164.2,
      }),
    )
    expect(merged.roast).toMatchObject({ elapsedSec: 137, zoneIndex: 1, targetC: 164.2 })
  })

  it('lets the stream report the roast ending, within a second rather than five', () => {
    expect(mergeLiveSnapshot(running, live({ roastActive: false })).roast?.active).toBe(false)
  })

  /** A firmware without the executor sends no roast fields, so none may be invented for it. */
  it('never invents a roast block for a firmware that claims none', () => {
    expect(mergeLiveSnapshot(status(), live({ roastActive: true, roastJourney: true })).roast).toBeUndefined()
  })

  it('reads RUNNING in a browser whose last full status predates Start', () => {
    // Full status is paused while the roaster actuates, so this browser's status still says STANDBY.
    const beforeStart = status({ lifecycle: 'STANDBY' })
    expect(
      mergeLiveSnapshot(beforeStart, live({ roastActive: true, effectiveFan: 10, effectiveHeat: 10 })).lifecycle,
    ).toBe('RUNNING')
    expect(
      mergeLiveSnapshot(beforeStart, live({ effectiveFan: 0, effectiveHeat: 0, actuatorMode: 'idle' })).lifecycle,
    ).toBe('STANDBY')
  })

  it('makes a running roast read as RUNNING through the shared lifecycle rules', () => {
    expect(mergeLiveSnapshot(status({ ...running, manualLockout: true }), live({ roastActive: true })).lifecycle).toBe(
      'MANUAL_LOCKOUT',
    )
    expect(mergeLiveSnapshot(running, live({ roastActive: true, fault: 'overtemperature' })).lifecycle).toBe('FAULT')
  })

  /*
   * Regression: full status is deferred for the whole roast, so a "wait one status poll" freeze
   * never ends - the moment the device's zone advances past the stale status document's, every
   * progress field freezes at its start value for the rest of the roast. A frame with the complete
   * zone tuple carries the executor's state atomically, so it needs no confirming poll.
   */
  it('unfreezes journey progress from a complete live zone tuple with no status poll at all', () => {
    const stale = status({
      roast: {
        active: true,
        mode: 'journey',
        name: 'haitian-blue',
        elapsedSec: 0,
        zoneIndex: 0,
        zoneCount: 5,
        targetC: 118,
        saturated: false,
        holdover: false,
      },
    })
    const merged = mergeLiveSnapshot(
      stale,
      live({
        roastActive: true,
        roastJourney: true,
        roastElapsedSec: 400,
        roastZone: 2,
        roastZones: 5,
        roastTargetC: 171.4,
        roastZoneEntrySec: 330,
        roastZoneNominalSec: 135,
        roastZoneEndC: 196,
        roastCorrectionTotal: 1.4,
        roastIntegral: 0.6,
        roastSolvedFan: 1.7,
        roastSolvedHeat: 8.2,
        roastHoldoverMs: 0,
        roastZonesAttained: [121, 328, null, null, null],
      }),
    )
    expect(merged.roast).toMatchObject({
      elapsedSec: 400,
      zoneIndex: 2,
      zoneCount: 5,
      targetC: 171.4,
      zoneEntrySec: 330,
      zoneElapsedSec: 70,
      zoneNominalSec: 135,
      zoneEndC: 196,
      correctionTotal: 1.4,
      integral: 0.6,
      solvedFan: 1.7,
      solvedHeat: 8.2,
      zoneAttainedSec: [121, 328, null, null, null],
    })
  })

  it('gives a cold-joining spectator the full journey tuple before any status document', () => {
    const merged = mergeLiveSnapshot(
      status({ connected: false }),
      live({
        roastActive: true,
        roastJourney: true,
        roastMode: 'journey',
        roastElapsedSec: 400,
        roastZone: 2,
        roastZones: 5,
        roastTargetC: 171.4,
        roastZoneEntrySec: 330,
        roastZoneNominalSec: 135,
        roastZoneEndC: 196,
        roastCorrectionTotal: 1.4,
        roastZonesAttained: [121, 328, null, null, null],
      }),
    )
    expect(merged.roast).toMatchObject({
      active: true,
      mode: 'journey',
      elapsedSec: 400,
      zoneIndex: 2,
      zoneEntrySec: 330,
      zoneElapsedSec: 70,
      zoneNominalSec: 135,
      zoneEndC: 196,
      zoneAttainedSec: [121, 328, null, null, null],
    })
  })

  it('clears journey-only values when a zone-tuple frame reports a non-journey mode', () => {
    const merged = mergeLiveSnapshot(
      running,
      live({
        roastActive: true,
        roastJourney: false,
        roastMode: 'timed',
        roastElapsedSec: 40,
        roastZone: 0,
        roastZones: 0,
        roastZoneEntrySec: 0,
      }),
    )
    expect(merged.roast?.zoneEndC).toBeUndefined()
    expect(merged.roast?.correctionTotal).toBeUndefined()
  })
})
