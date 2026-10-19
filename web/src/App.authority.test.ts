import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  activePlanDecisionKey,
  activePlanMatchesController,
  historyDetailPendingReason,
  liveContinuityIssue,
  liveOnlyControllerWorkShellReady,
  liveRecordingIdentity,
  manualRecordingFinalization,
  manualTraceIdentity,
  manualTraceRequestKey,
  mergeManualTrace,
  profiledTraceSessionKey,
  purgeLegacyPendingRoastSetup,
  resolveActivePlanDisplay,
  selectLiveTrace,
  storageReplacementBlockedReason,
  telemetryRecoveryAllowsControls,
  unsettledRoastRecordingId,
} from './App'
import type { ActiveRoastPlan, LiveSnapshot } from './controller/client'
import type { ControllerStatus, RoastRun } from './domain/types'

const status = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  lifecycle: 'RUNNING',
  connected: true,
  stale: false,
  receivedAtMs: 1,
  firmwareVersion: 'test',
  bootId: 'boot-7',
  manualLockout: false,
  thermocoupleValid: true,
  capabilities: { apiVersion: 'runner', autonomousTimedPrograms: true, thermalExecution: true, diagnosticTests: true },
  roast: { active: true, mode: 'journey', sessionId: '31', planRev: 4, saturated: false, holdover: false },
  ...overrides,
})

const plan: ActiveRoastPlan = {
  active: true,
  bootId: 'boot-7',
  sessionId: '31',
  planRev: 4,
  mode: 'journey',
  steps: [],
  zones: [],
  journal: [{ edited: true }],
}

const SOURCE = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const ROAST_SOURCE = readFileSync(new URL('./components/RoastView.tsx', import.meta.url), 'utf8')

describe('controller authority tuple', () => {
  it('requires boot, session, and plan revision to match exactly', () => {
    expect(activePlanMatchesController(plan, status())).toBe(true)
    expect(activePlanMatchesController({ ...plan, bootId: undefined }, status())).toBe(false)
    expect(activePlanMatchesController({ ...plan, sessionId: '32' }, status())).toBe(false)
    expect(activePlanMatchesController({ ...plan, planRev: 5 }, status())).toBe(false)
    expect(activePlanMatchesController(plan, status({ roast: { ...status().roast!, planRev: undefined } }))).toBe(false)
  })
})

describe('accepted plan acknowledgement bridge', () => {
  it('shows only the exact accepted successor while status still reports its predecessor', () => {
    const accepted = { ...plan, planRev: 5 }
    const bridge = { plan: accepted, previousPlanRev: 4, acceptedAtMs: 1000 }
    expect(resolveActivePlanDisplay(accepted, status(), bridge, 2000)).toEqual({ plan: accepted, reconciling: true })
    expect(
      resolveActivePlanDisplay(accepted, status({ roast: { ...status().roast!, planRev: 5 } }), bridge, 2000),
    ).toEqual({ plan: accepted, reconciling: false })
  })

  it('rejects expired, skipped, wrong-session, and wrong-object bridges', () => {
    const accepted = { ...plan, planRev: 5 }
    const bridge = { plan: accepted, previousPlanRev: 4, acceptedAtMs: 1000 }
    expect(resolveActivePlanDisplay(accepted, status(), bridge, 11_001).plan).toBeUndefined()
    expect(resolveActivePlanDisplay({ ...accepted, planRev: 6 }, status(), bridge, 2000).plan).toBeUndefined()
    expect(
      resolveActivePlanDisplay(accepted, status({ roast: { ...status().roast!, sessionId: 'other' } }), bridge, 2000)
        .plan,
    ).toBeUndefined()
    expect(resolveActivePlanDisplay({ ...accepted }, status(), bridge, 2000).plan).toBeUndefined()
  })
})

describe('accepted-plan presentation continuity', () => {
  it('uses the exact accepted display bridge for the profile while keeping samples session-scoped', () => {
    expect(SOURCE).toContainCode(
      'profiledDeviceSession && sessionPlanBindsSetup && displayedActiveRoastPlan ? profileFromActiveRoastPlan(displayedActiveRoastPlan, undefined, profiles)',
    )
    expect(SOURCE).toContainCode('(profiledDeviceActive || liveStatus.roast.endReason !== undefined)')
    expect(SOURCE).toContainCode('profiled: profiledLiveSamples, profiledCurrent: profiledSamplesCurrent,')
    expect(SOURCE).not.toContainCode(': activePlanMatchesStatus && profiledLiveSamples.length > 0')
  })

  it('never raises the leave guard for a plan decision the roaster already holds', () => {
    // Saved roast and History details must not leave every page warning that leaving would lose
    // changes. The unanswered "save the edited journey?" decision is stored on the roaster and
    // offered again on the Roast page, so leaving loses nothing.
    const guardStart = SOURCE.indexOf('const unsaved =')
    const guard = SOURCE.slice(guardStart, SOURCE.indexOf('\n\n', guardStart))
    expect(guardStart).toBeGreaterThan(-1)
    expect(SOURCE).not.toContainCode('pendingActivePlanReview')
    expect(guard).not.toContainCode('activePlan')
    expect(guard).toContainCode("(view === 'history' && historyDirty)")
  })
})
describe('profiled trace session fence', () => {
  it('retains the exact ended profiled session while rejecting manual or identity changes', () => {
    const current = status({ bootId: 'boot-9', roast: { ...status().roast!, sessionId: '44' } })
    expect(profiledTraceSessionKey(current)).toBe('boot-9:44')
    expect(profiledTraceSessionKey(current)).not.toBe('boot-7:31')
    expect(
      profiledTraceSessionKey(status({ roast: { ...status().roast!, active: false, endReason: 'stopped' } })),
    ).toBe('boot-7:31')
    expect(
      profiledTraceSessionKey(status({ roast: { ...status().roast!, active: false, endReason: undefined } })),
    ).toBeUndefined()
    expect(profiledTraceSessionKey(status({ roast: { ...status().roast!, mode: 'manual' } }))).toBeUndefined()
  })

  it('hydrates an ended profiled session only from the roaster recording source', () => {
    const hydrationStart = SOURCE.indexOf('const sessionKey = profiledTraceSessionKey(liveStatus)')
    const hydrationEnd = SOURCE.indexOf('useEffect(() => {', hydrationStart + 1)
    const hydration = SOURCE.slice(hydrationStart, hydrationEnd)
    expect(hydration).toContainCode("liveStatus.thermalLog?.source !== 'roast'")
    expect(hydration).toContainCode(
      'hydrated = deviceRoastSamples(await controller.fetchDeviceLogCsv(activeThermalLogId))',
    )
    expect(hydration).toContainCode('hydrated = deviceRoastSamples(await controller.fetchThermalCsv())')
    expect(hydration.indexOf('fetchDeviceLogCsv')).toBeLessThan(hydration.indexOf('fetchThermalCsv'))
    expect(hydration).toContainCode('liveStatus.roast?.endReason')
    expect(hydration).toContainCode('liveStatus.thermalLog?.source')
  })
})
describe('manual trace authority', () => {
  it('keys hydration to boot, manual-roast session, and recording identity', () => {
    const active = status({
      bootId: 'boot-9',
      roast: { active: true, mode: 'manual', sessionId: '44', saturated: false, holdover: false },
      thermalLog: { active: true, samples: 20, capacity: 100, intervalMs: 1000, source: 'roast', logId: '81' },
    })
    const identity = manualTraceIdentity(active)
    expect(identity).toEqual({ bootId: 'boot-9', sessionId: '44', logId: '81' })
    expect(manualTraceRequestKey(identity!)).toBe('boot-9:44:81')
    expect(manualTraceIdentity(status())).toBeUndefined()
  })

  /**
   * The roaster is authoritative, so a browser that joined mid-roast - or never held the session
   * at all - must still collect and draw the manual roast it is watching. Session ownership gates
   * commands, never presentation. These pin the two wiring halves of spectator support:
   * the live buffer is keyed to the DEVICE session, and its display does not require a
   * browser-local session document or browser-local manual mode.
   */
  it('collects the live manual trace keyed to the device session, not to a browser session', () => {
    const start = SOURCE.indexOf('The live manual curve is deliberately browser-ephemeral')
    const end = SOURCE.indexOf('const suggestions = useMemo', start)
    const collector = SOURCE.slice(start, end)
    expect(collector).toContainCode("roast?.active !== true || roast.mode !== 'manual' || !roast.sessionId")
    expect(collector).toContainCode('manualSampleSessionRef.current === sessionKey ? current : []')
    expect(collector).not.toContainCode('activeSession')
    expect(collector).not.toContainCode('manualControlBlockedReason')
  })

  it('presents the device-manual trace and observed steps without a browser session', () => {
    expect(SOURCE).toContainCode('manual: manualLiveSamples, manualCurrent: deviceManualTraceCurrent,')
    expect(SOURCE).toContainCode('mergeDeviceManualEvents(own, deviceManualEvents)')
  })

  it('merges by device second, lets the device win overlap, and keeps a newer live tail', () => {
    const sample = (elapsedSec: number, beanTempC: number) => ({
      elapsedSec,
      beanTempC,
      rorCPerMin: 0,
      requestedFan: 4,
      effectiveFan: 4,
      requestedHeat: 5,
      effectiveHeat: 5,
      phase: 'DRYING' as const,
    })
    const current = [sample(10, 100), sample(11, 101), sample(13, 103)] as RoastRun['samples']
    const device = [sample(0, 25), sample(10, 99), sample(12, 102)] as RoastRun['samples']
    const merged = mergeManualTrace(device, current)
    expect(merged.map((row) => row.elapsedSec)).toEqual([0, 10, 11, 12, 13])
    expect(merged.find((row) => row.elapsedSec === 10)?.beanTempC).toBe(99)
  })
})

describe('provisional roast recording authority', () => {
  it('keeps a recording out of archive reconciliation until its tail is finalized', () => {
    const current = status({
      thermalLog: {
        active: true,
        unsaved: false,
        samples: 20,
        capacity: 100,
        intervalMs: 1000,
        source: 'roast',
        logId: '81',
      },
    })
    expect(unsettledRoastRecordingId(current)).toBe('81')
    expect(
      unsettledRoastRecordingId(status({ thermalLog: { active: false, unsaved: true, source: 'roast', logId: '81' } })),
    ).toBe('81')
    expect(
      unsettledRoastRecordingId(
        status({ thermalLog: { active: false, unsaved: false, source: 'roast', logId: '81' } }),
      ),
    ).toBeUndefined()
    expect(
      unsettledRoastRecordingId(status({ thermalLog: { active: true, source: 'calibration', logId: '82' } })),
    ).toBeUndefined()
  })
})

describe('manual recording finalization presentation', () => {
  const run = { outcome: 'complete', manualRoast: { changes: [], incomplete: true } } as unknown as RoastRun

  it('follows device finishing, saving, and reconciliation without promising a cooling wait', () => {
    expect(
      manualRecordingFinalization(
        run,
        status({
          lifecycle: 'READY',
          roast: undefined,
          thermalLog: { active: true, unsaved: false, source: 'roast', logId: '81' },
        }),
      )?.phase,
    ).toBe('finishing')
    expect(
      manualRecordingFinalization(
        run,
        status({
          lifecycle: 'READY',
          roast: undefined,
          thermalLog: { active: true, unsaved: false, source: 'roast', logId: '81' },
        }),
      )?.detail,
    ).not.toContainCode('three minutes')
    const saving = manualRecordingFinalization(
      run,
      status({
        lifecycle: 'READY',
        roast: undefined,
        thermalLog: { active: false, unsaved: true, source: 'roast', logId: '81' },
      }),
    )
    expect(saving?.phase).toBe('saving')
    expect(saving?.detail).toBe('The roaster is saving and verifying the recording.')
    expect(saving?.detail).not.toContainCode('detailed')
    expect(
      manualRecordingFinalization(
        run,
        status({
          lifecycle: 'READY',
          roast: undefined,
          thermalLog: { active: false, unsaved: false, source: 'roast', logId: '81' },
        }),
      )?.phase,
    ).toBe('reconciling')
  })

  it('does not claim the recording finished without a current authoritative status', () => {
    const disconnected = manualRecordingFinalization(
      run,
      status({ connected: false, stale: true, lifecycle: 'DISCONNECTED', roast: undefined, thermalLog: undefined }),
    )
    expect(disconnected?.phase).toBe('waiting')
    expect(disconnected?.detail).not.toContainCode('has finished')
    expect(disconnected?.detail).toContainCode('Reconnect')

    const stale = manualRecordingFinalization(
      run,
      status({
        connected: true,
        stale: true,
        lifecycle: 'READY',
        roast: undefined,
        thermalLog: { active: false, unsaved: false, source: 'roast', logId: '81' },
      }),
    )
    expect(stale?.phase).toBe('waiting')
    expect(stale?.detail).not.toContainCode('has finished')
  })

  it('clears only after the authoritative archive has reconciled', () => {
    const complete = { ...run, manualRoast: { changes: [], incomplete: false, logId: 'device:mock#81' } } as RoastRun
    expect(manualRecordingFinalization(complete, status({ lifecycle: 'READY', roast: undefined }))).toBeUndefined()
  })

  /**
   * A vague busy banner gives no sign of whether the archive read is progressing or has given up.
   * The reconciling banner states the actual wait - the roaster still saving when the list read was
   * deferred, the import otherwise - and that Crackle retries by itself either way.
   */
  it('says what the reconciling wait is and that Crackle retries automatically', () => {
    const deviceDone = status({
      lifecycle: 'READY',
      roast: undefined,
      thermalLog: { active: false, unsaved: false, source: 'roast', logId: '81' },
    })
    const deferred = manualRecordingFinalization(run, deviceDone, true)
    expect(deferred?.phase).toBe('reconciling')
    expect(deferred?.detail).toContainCode('still saving the recording')
    expect(deferred?.detail).toContainCode('retrying automatically')
    const importing = manualRecordingFinalization(run, deviceDone)
    expect(importing?.phase).toBe('reconciling')
    expect(importing?.detail).toContainCode('automatically')
    expect(importing?.detail).not.toContainCode('still saving')
  })
})

/**
 * A retry budget that is never replenished means that after one exhausted deferral episode, later
 * episodes schedule zero timer retries until a complete read or a device change - leaving the
 * post-roast panel waiting indefinitely while a History visit would succeed. These pins hold the
 * per-episode budget in the archive-import effect itself.
 */
describe('archive deferral episode budget', () => {
  const effectStart = SOURCE.indexOf('const timerRetry = archiveImportNonce !== archiveRetryNonceRef.current')
  const effect = SOURCE.slice(effectStart, SOURCE.indexOf('const selectedLibraryProfile', effectStart))

  it('replenishes the retry budget at the start of every fresh deferral episode', () => {
    expect(effectStart).toBeGreaterThan(-1)
    expect(effect).toContainCode('if (!timerRetry) archiveRetryCountRef.current = 0')
    // No fixed cap across episodes: it would starve later ones.
    expect(SOURCE).not.toContainCode('archiveRetryCountRef.current >= 2')
    expect(effect).toContainCode('archiveRetryDelayMs(archiveRetryCountRef.current, awaitingManualReconciliation)')
  })

  it('treats the waiting post-roast panel as its own retry trigger, not navigation', () => {
    expect(effect).toContainCode(
      'if (!initial && !justSettled && !archiveConsumer && !timerRetry && !awaitingManualReconciliation) return',
    )
    // Even a complete list keeps polling while the panel waits on the recording reconciling.
    expect(effect).toContainCode('if (!awaitingManualReconciliation) {')
    // And the retry loop only ever reads; no mutation path is touched from a timer.
    expect(effect).toContainCode('void importDeviceRoasts()')
  })
})
describe('live sequence continuity', () => {
  it('accepts duplicates and arbitrarily large forward sampling gaps, but catches restart and reorder', () => {
    expect(liveContinuityIssue({ bootId: 'a', streamSeq: 10 }, { bootId: 'a', streamSeq: 13 })).toBeUndefined()
    expect(liveContinuityIssue({ bootId: 'a', streamSeq: 0xffff_ffff }, { bootId: 'a', streamSeq: 1 })).toBeUndefined()
    expect(liveContinuityIssue({ bootId: 'a', streamSeq: 10 }, { bootId: 'a', streamSeq: 10 })).toBeUndefined()
    expect(liveContinuityIssue({ bootId: 'a', streamSeq: 10 }, { bootId: 'a', streamSeq: 40_000 })).toBeUndefined()
    expect(liveContinuityIssue({ bootId: 'a', streamSeq: 40 }, { bootId: 'a', streamSeq: 10 })).toBe(
      'stalled-or-reorder',
    )
    expect(liveContinuityIssue({ bootId: 'a', streamSeq: 10 }, { bootId: 'b', streamSeq: 1 })).toBe('reboot')
  })

  it('treats duplicate frames as transport-only evidence and does not refresh authority', () => {
    const effect = SOURCE.slice(SOURCE.indexOf('const acceptLive ='), SOURCE.indexOf('const refreshStatus ='))
    const duplicateGuard = effect.slice(effect.indexOf('const duplicate ='), effect.indexOf('// Transport loss'))
    expect(duplicateGuard).toContainCode('if (duplicate) return')
    expect(duplicateGuard.indexOf('if (duplicate) return')).toBeLessThan(effect.indexOf('setLive(next)'))
  })

  it('does not poll full status while compact live transport is healthy', () => {
    const effect = SOURCE.slice(
      SOURCE.indexOf('let initialStatusPending = true'),
      SOURCE.indexOf('const currentRecordedOn = useMemo'),
    )
    expect(effect).not.toContainCode('setInterval(() => { void refreshStatus() }, 5000)')
    expect(effect).toContainCode('if (!streamConnected || freshFrameLate) void refreshLive(streamConnected)')
    expect(effect).toContainCode('idleRevisionNeedsStatus')
    expect(effect).toContainCode('active: statusUnsafe || idleRevisionNeedsStatus')
    expect(effect).toContainCode('refreshAfterStreamConnect || idleRevisionNeedsStatus')
    expect(effect).toContainCode('if (statusRefreshInFlight) return')
    expect(effect.indexOf('completedStatusRevisionRef.current = next.stateRev')).toBeLessThan(
      effect.indexOf('crackleData.observeStatus(next)'),
    )
    expect(SOURCE).toContainCode('const LIVE_FALLBACK_AFTER_MS = 8000')
  })

  it('uses accepted merged live telemetry rather than the aging full status timestamp for mutation freshness', () => {
    const start = SOURCE.indexOf('const mutationBlockedReason =')
    const end = SOURCE.indexOf('controllerMutationReasonRef.current', start)
    const gates = SOURCE.slice(start, end)
    expect(gates).toContainCode('!liveStatus.connected')
    expect(gates).toContainCode('!statusChecked')
    expect(gates).toContainCode('isStatusStale(liveStatus, nowMs)')
    expect(gates).toContainCode('catalogActivityBlockedReason(liveStatus)')
    expect(SOURCE).toContainCode(
      "detailsSaveBlockedReason={activeSession?.outcome !== 'running' ? mutationBlockedReason : undefined}",
    )
    expect(SOURCE).toContainCode(': activeSession?.manualRoast ? mutationBlockedReason : undefined}')
    expect(SOURCE).toContainCode(
      "calibrationBlockedReason={actuatorMutationBlockedReason ?? modelBlockedReason('calibrate')}",
    )
    expect(SOURCE).not.toContainCode(
      "calibrationBlockedReason={mutationBlockedReason ?? modelBlockedReason('calibrate')}",
    )
    expect(gates).toContainCode('liveStatus.restoreMaintenance?.active')
    expect(gates).not.toContainCode('isStatusStale(status, nowMs)')
  })

  it('renders cold controller work for every compact actuation signal and the passive log tail', () => {
    const offline = status({ connected: false, stale: true, lifecycle: 'DISCONNECTED' })
    const frame = (overrides: Partial<LiveSnapshot>): LiveSnapshot => ({
      receivedAtMs: 10,
      connected: true,
      calibrationActive: false,
      manualActive: false,
      roastActive: false,
      ...overrides,
    })
    for (const live of [
      frame({ calibrationActive: true }),
      frame({ manualActive: true }),
      frame({ roastActive: true }),
      frame({ effectiveFan: 4 }),
      frame({ effectiveHeat: 6 }),
      frame({ thermalLogActive: true, thermalLogSource: 'calibration', thermalLogId: '82' }),
    ])
      expect(liveOnlyControllerWorkShellReady(true, offline, live)).toBe(true)
    expect(liveOnlyControllerWorkShellReady(true, offline, frame({}))).toBe(false)
    expect(liveOnlyControllerWorkShellReady(false, offline, frame({ effectiveFan: 4 }))).toBe(false)
    expect(liveOnlyControllerWorkShellReady(true, status(), frame({ effectiveFan: 4 }))).toBe(false)
    expect(SOURCE).toContainCode(
      'const statusUnsafe = isActuating || (next.connected && next.thermalLogActive === true)',
    )
    expect(SOURCE).toContainCode('if (next.connected && statusUnsafe && initialStatusPending) setStatusChecked(true)')
  })

  it('keeps same-boot gap telemetry visible while authority remains degraded', () => {
    const effect = SOURCE.slice(SOURCE.indexOf('const acceptLive ='), SOURCE.indexOf('const refreshStatus ='))
    expect(effect).toContainCode("void recoverContinuity(continuity === 'stalled-or-reorder')")
    expect(effect).toContainCode("if (continuity === 'reboot') return")
    const degraded = effect.slice(
      effect.indexOf('if (telemetryDegradedRef.current)'),
      effect.indexOf('setLive(next)', effect.indexOf('if (telemetryDegradedRef.current)')) + 'setLive(next)'.length,
    )
    expect(degraded).toContainCode('setLive(next)')
    expect(SOURCE).toContainCode('const actuatorMutationBlockedReason = deviceAttachFailure ?? (telemetryDegraded')
    expect(SOURCE).toContainCode('if (controller.fullStatusDeferred() || liveBlocksFullStatus(latestLive))')
  })

  it('never turns transport loss or continuity recovery into an active full-status request', () => {
    const effect = SOURCE.slice(
      SOURCE.indexOf('let initialStatusPending = true'),
      SOURCE.indexOf('// The streamed readout is merged here'),
    )
    expect(effect).toContainCode('if (controller.fullStatusDeferred())')
    expect(effect).toContainCode('if (next.connected) latestLive = next')
    expect(effect).not.toContainCode('else latestLive = undefined')
    expect(effect).toContainCode('INITIAL_LIVE_STATUS_WAIT_MS')
    expect(effect.indexOf('void refreshLive()')).toBeLessThan(effect.indexOf('initialStatusTimer = window.setTimeout'))
    const recovery = effect.slice(
      effect.indexOf('const recoverContinuity = (preserveLive = false) =>'),
      effect.indexOf('const acceptLive ='),
    )
    expect(recovery.indexOf('controller.fullStatusDeferred()')).toBeLessThan(recovery.indexOf('controller.status()'))
  })

  it('reconciles only a mounted catalog without making it part of the control recovery gate', () => {
    expect(SOURCE).toContainCode('if (nextStatus.dataStore?.mounted) await crackleData.refresh()')
    expect(SOURCE).toContainCode('telemetryRecoveryAllowsControls(nextStatus, recoveredPlan)')
    const recovery = SOURCE.slice(
      SOURCE.indexOf('const recoverContinuity = (preserveLive = false) =>'),
      SOURCE.indexOf('const acceptLive =', SOURCE.indexOf('const recoverContinuity = (preserveLive = false) =>')),
    )
    expect(recovery.indexOf('telemetryRecoveryAllowsControls(nextStatus, recoveredPlan)')).toBeLessThan(
      recovery.indexOf('await crackleData.refresh()'),
    )
    expect(SOURCE).not.toContainCode('const catalogCurrent')
    expect(SOURCE).toContainCode('telemetryDegradedRef.current = true')
    expect(SOURCE).toContainCode('setControllerMutationGate(() => controllerMutationReasonRef.current)')
    expect(SOURCE).not.toContainCode('{telemetryDegraded && <div className="sync-state-banner terminal"')
    expect(SOURCE).toContainCode('const actuatorMutationBlockedReason = deviceAttachFailure ?? (telemetryDegraded')
  })
})

describe('telemetry recovery authority', () => {
  it('recovers controls from fresh connected status without requiring catalog readiness', () => {
    const idle = status({
      lifecycle: 'READY',
      roast: undefined,
      dataStore: { mounted: false, collections: {}, runs: {} },
    })
    expect(telemetryRecoveryAllowsControls(idle, undefined)).toBe(true)
    expect(telemetryRecoveryAllowsControls({ ...idle, connected: false }, undefined)).toBe(false)
  })

  it('preserves exact active-plan reconciliation for profiled roasts', () => {
    expect(telemetryRecoveryAllowsControls(status(), undefined)).toBe(false)
    expect(telemetryRecoveryAllowsControls(status(), plan)).toBe(true)
    expect(telemetryRecoveryAllowsControls(status(), { ...plan, planRev: 5 })).toBe(false)
    expect(telemetryRecoveryAllowsControls(status({ roast: { ...status().roast!, mode: 'manual' } }), undefined)).toBe(
      true,
    )
  })
})

describe('storage recovery authority', () => {
  const idle = status({
    lifecycle: 'READY',
    roast: undefined,
    roaster: { deviceId: 'device-1', modelId: 'freshroast-sr800', displayName: 'Test roaster', simulated: false },
    dataStore: { mounted: false, collections: {}, runs: {} },
  })

  it('uses current idle status rather than invalid catalog readiness as the destructive gate', () => {
    expect(storageReplacementBlockedReason(idle, { queued: 0 })).toBeUndefined()
    expect(storageReplacementBlockedReason({ ...idle, stale: true }, { queued: 0 })).toContainCode(
      'current roaster status',
    )
    expect(storageReplacementBlockedReason({ ...idle, manual: { active: true } }, { queued: 0 })).toContainCode(
      'manual session',
    )
    expect(storageReplacementBlockedReason(idle, { queued: 1 })).toContainCode('unsaved change')
  })

  it('formats only inside the recovery lock and reconciles the empty device before refresh', () => {
    const start = SOURCE.indexOf('const formatStorage = useCallback')
    const end = SOURCE.indexOf('const thermocoupleOffsetBlocked', start)
    const format = SOURCE.slice(start, end)
    expect(format).toContainCode('recoveryIncomplete')
    expect(format).toContainCode('beginDeviceStorageRecovery(deviceId)')
    expect(format).toContainCode('if (recovery.formatRequired)')
    expect(format).toContainCode('controller.formatDeviceStorage()')
    expect(format).toContainCode('crackleData.deviceFormatConfirmed()')
    expect(format).toContainCode('crackleData.resetAfterDeviceFormat()')
    expect(format).toContainCode('crackleData.reconcileDeviceRestore()')
    expect(format).toContainCode('crackleData.finishDeviceRestore()')
    expect(format).toContainCode('releaseDeviceStorageRecoveryForRetry()')
    expect(format).toContainCode('nextStatus.logArchive?.mounted === true')
    expect(format).toContainCode('nextStatus.restoreMaintenance?.incomplete !== true')
    expect(format).not.toContainCode('mutationBlockedReason')
    expect(format.indexOf('reconcileDeviceRestore()')).toBeLessThan(format.indexOf('controller.status()'))
    expect(format.indexOf('controller.status()')).toBeLessThan(format.indexOf('finishDeviceRestore()'))
    expect(SOURCE).toContainCode('onFormatStorage={formatStorage}')
  })
})
describe('manual-roast safety wiring', () => {
  it('keeps header Stop unconditional while completing and reconciling an active manual roast', () => {
    const start = SOURCE.indexOf('const stopFromHeader = async')
    const end = SOURCE.indexOf('const saveManualProfile = async', start)
    const headerStop = SOURCE.slice(start, end)
    expect(headerStop).toContainCode('controllerRef.current!.stopAll()')
    expect(headerStop).not.toContainCode('window.confirm')
    expect(headerStop).not.toContainCode('expected_session')
    expect(headerStop).toContainCode("roast?.active && roast.mode === 'manual'")
    expect(headerStop).toContainCode("outcome: 'complete'")
    expect(headerStop).toContainCode("endReason: 'stopped'")
    expect(headerStop).toContainCode('refreshStatus()')
    expect(SOURCE).toContainCode('onStopAll={stopFromHeader}')
  })

  it('sends Stop from the authoritative roast tuple without browser-ownership or Apply-busy gates', () => {
    const start = SOURCE.indexOf('const stopManualRoast = async')
    const end = SOURCE.indexOf('const saveManualProfile = async', start)
    const stop = SOURCE.slice(start, end)
    expect(stop).toContainCode('const authoritative = liveStatusRef.current')
    expect(stop).toContainCode(
      "controllerRef.current!.stopRoast(roast.mode === 'manual' ? expectedSessionId : undefined)",
    )
    expect(stop).toContainCode('if (manualStopBusy) return')
    expect(stop).not.toContainCode('manualOwnershipBlockedReason')
    expect(stop).not.toContainCode('if (manualBusy)')
  })

  it('keeps accepted profiled actuation separate from the legacy local-only run writer', () => {
    const begin = ROAST_SOURCE.slice(
      ROAST_SOURCE.indexOf('const begin = () =>'),
      ROAST_SOURCE.indexOf('// The chart owns its own options'),
    )
    expect(begin).toContainCode('if (executorPresent) { void startOnDevice(); return }')
    expect(begin.indexOf('if (executorPresent) { void startOnDevice(); return }')).toBeLessThan(
      begin.indexOf('onStart(startMeasurements'),
    )
    const legacy = SOURCE.slice(
      SOURCE.indexOf('const startRoast = async'),
      SOURCE.indexOf('const startManualRoast = async'),
    )
    expect(legacy).toContainCode('crackleData.saveRun(run)')
  })
  it('passes the editable occurrence name to the roaster executor', () => {
    const deviceStart = ROAST_SOURCE.slice(
      ROAST_SOURCE.indexOf('const startOnDevice = async'),
      ROAST_SOURCE.indexOf('const stopOnDevice = async'),
    )
    expect(deviceStart).toContainCode('name: startName.trim() || undefined')
  })

  /**
   * The one manual run-document write is the staged record BEFORE Start, made
   * while the actuator is still idle. Once outputs run, the flash-write gate holds: acceptance,
   * changes, and a late join stay in-memory until the archive reconciles the recording.
   */
  it('writes the staged record only before Start, never after acceptance, a change, or a late join', () => {
    const recoveryStart = SOURCE.indexOf('/** Attach a newly opened browser')
    const recovery = SOURCE.slice(
      recoveryStart,
      SOURCE.indexOf('const beanTempC = liveStatus.temperatureC', recoveryStart),
    )
    const start = SOURCE.slice(
      SOURCE.indexOf('const startManualRoast = async'),
      SOURCE.indexOf('const setManualRoast = async'),
    )
    const change = SOURCE.slice(
      SOURCE.indexOf('const setManualRoast = async'),
      SOURCE.indexOf('const stopManualRoast = async'),
    )
    expect(recovery).not.toContainCode('crackleData.saveRun')
    const staging = start.indexOf('executeDeviceRoastStart(stagedRun')
    const startCommand = start.indexOf('start: () => controllerRef.current!.startRoast(args)')
    expect(staging).toBeGreaterThan(-1)
    expect(startCommand).toBeGreaterThan(staging)
    // After the Start acknowledgement, no document write remains in the flow.
    const finish = start.slice(start.indexOf('const finishManualRoastStart'))
    expect(finish).not.toContainCode('crackleData.saveRun')
    expect(change).not.toContainCode('crackleData.updateRun')
    expect(start).toContainCode('const startedAt = result.startedEpoch && result.startedEpoch > 0')
    expect(start).toContainCode('new Date(result.startedEpoch * 1000).toISOString() : requestedAt')
    expect(start).toContainCode('const deviceName = sanitizeRoastName(result.name || runName)')
    expect(start).toContainCode('name: deviceName')
    expect(start).toContainCode('deviceName, deviceStartedEpoch: result.startedEpoch')

    expect(SOURCE).not.toContainCode('persistManualRun(')
  })

  it('keeps catalog convergence out of the actuator transport gate', () => {
    expect(SOURCE).toContainCode('controllerMutationReasonRef.current = actuatorMutationBlockedReason')
    expect(SOURCE).toContainCode('catalogMutationReasonRef.current = mutationBlockedReason')
    expect(SOURCE).toContainCode('if (actuatorMutationBlockedReason) return actuatorMutationBlockedReason')
  })

  it('fences manual CSV hydration against a changed boot, session, or log', () => {
    const start = SOURCE.indexOf('const identity = manualTraceIdentity(liveStatus)')
    const end = SOURCE.indexOf('const roast = liveStatus.roast', start)
    const hydration = SOURCE.slice(start, end)
    expect(hydration).toContainCode('manualTraceRequestKey(currentIdentity) !== requestKey')
    expect(hydration).toContainCode('hydrated = deviceRoastSamples(await controller.fetchDeviceLogCsv(identity.logId))')
    expect(hydration).toContainCode('if (hydrated.length === 0)')
    expect(hydration).toContainCode('hydrated = deviceRoastSamples(await controller.fetchThermalCsv())')
    expect(hydration).toContainCode('mergeManualTrace(hydrated, current)')
  })
})

/**
 * The locked phone. The trace is the ROASTER's recording; a browser that
 * misses part of the stream for the SAME session re-reads the recorded prefix and merges it in.
 * The join-time hydration is keyed to the session and runs once; these pins are what runs again.
 */
describe('live trace resync on a stream discontinuity', () => {
  it('names only an active, recording device roast as worth re-reading, keyed like its buffer', () => {
    const manual = status({
      roast: { active: true, mode: 'manual', sessionId: '44', saturated: false, holdover: false },
      thermalLog: { active: true, source: 'roast', logId: '81' } as ControllerStatus['thermalLog'],
    })
    expect(liveRecordingIdentity(manual)).toEqual({ kind: 'manual', sessionKey: 'boot-7:44', logId: '81' })
    const profiled = status({
      thermalLog: { active: true, source: 'roast', logId: '82' } as ControllerStatus['thermalLog'],
    })
    expect(liveRecordingIdentity(profiled)).toEqual({ kind: 'profiled', sessionKey: 'boot-7:31', logId: '82' })
    expect(
      liveRecordingIdentity(
        status({ thermalLog: { active: true, source: 'roast' } as ControllerStatus['thermalLog'] }),
      ),
    ).toEqual({ kind: 'profiled', sessionKey: 'boot-7:31' })
    // Ended, not recording, or recording something else: nothing to re-read mid-roast.
    expect(
      liveRecordingIdentity(
        status({
          roast: { ...status().roast!, active: false, endReason: 'completed' },
          thermalLog: { active: false, source: 'roast', logId: '82' } as ControllerStatus['thermalLog'],
        }),
      ),
    ).toBeUndefined()
    expect(liveRecordingIdentity(status())).toBeUndefined()
    expect(
      liveRecordingIdentity(
        status({ thermalLog: { active: true, source: 'calibration', logId: '9' } as ControllerStatus['thermalLog'] }),
      ),
    ).toBeUndefined()
  })

  it('re-reads the recording on reconnect, page resume, a sequence hole, and a jump between accepted samples', () => {
    const start = SOURCE.indexOf('const resync = new RecordingResync({')
    const end = SOURCE.indexOf('const stopStream = controller.subscribeLive', start)
    const wiring = SOURCE.slice(start, end)
    expect(wiring).toContainCode('const identity = liveRecordingIdentity(liveStatusRef.current)')
    expect(wiring).toContainCode('hydrated = deviceRoastSamples(await controller.fetchDeviceLogCsv(identity.logId))')
    expect(wiring).toContainCode(
      'if (hydrated.length === 0) hydrated = deviceRoastSamples(await controller.fetchThermalCsv())',
    )
    // The identity is checked again after the await: a read that outlives its roast merges nothing.
    expect(wiring).toContainCode(
      'if (!current || current.kind !== identity.kind || current.sessionKey !== identity.sessionKey) return undefined',
    )
    expect(wiring).toContainCode('setManualLiveSamples((current) => mergeRecordingPrefix(hydrated, current))')
    expect(wiring).toContainCode('setProfiledLiveSamples((current) => mergeRecordingPrefix(hydrated, current))')
    expect(wiring).toContainCode("document.addEventListener('visibilitychange', resume)")
    expect(wiring).toContainCode("window.addEventListener('pageshow', resume)")
    expect(wiring).toContainCode("resync.request('page-resume')")
    expect(wiring).toContainCode("liveResyncRef.current?.request('sequence-gap')")
    expect(SOURCE).toContainCode(
      "if (connected && streamEverConnected) liveResyncRef.current?.request('stream-reconnect')",
    )
    // Both collectors watch the roaster clock between the samples they accept.
    expect(SOURCE.match(/liveResyncRef\.current\?\.request\('sample-gap'\)/g)).toHaveLength(2)
    expect(SOURCE.match(/liveSampleGap\(lastCollected\.elapsedSec, elapsedSec\)/g)).toHaveLength(2)
  })
})

/**
 * Refreshing the Roast page mid-roast must never show a remnant image of the PREVIOUS roast. The
 * roaster cannot serve one - both hydration routes are verified against the firmware - so the risk
 * is a browser-held record: a reload whose first live poll misses the status window restores a
 * retained 'running' record as the active session, and a browser-first selection would let a
 * manual record's samples stand in for the live journey. The rule is device-first.
 */
describe('which samples the Roast page draws', () => {
  const sample = (elapsedSec: number, beanTempC: number): RoastRun['samples'][number] => ({
    elapsedSec,
    beanTempC,
    rorCPerMin: 0,
    requestedFan: 5,
    effectiveFan: 5,
    requestedHeat: 8,
    effectiveHeat: 8,
    phase: 'DRYING',
  })
  const previousManual = [sample(0, 25), sample(1, 26), sample(2, 27)]
  const previousJourney = [sample(0, 30), sample(1, 31)]
  const journeyBuffer = [sample(0, 28), sample(1, 29), sample(2, 30), sample(3, 31)]
  const manualBuffer = [sample(0, 24), sample(1, 25)]
  const retainedManual = {
    manualRoast: { changes: [], incomplete: true },
    outcome: 'running' as const,
    samples: previousManual,
  }
  const completedJourney = { outcome: 'complete' as const, samples: previousJourney }

  it('draws only the device-keyed buffer of the roast the roaster is executing, whatever record the browser holds', () => {
    const live = { active: true, mode: 'journey' as const }
    expect(
      selectLiveTrace({
        deviceRoast: live,
        activeSession: retainedManual,
        profiled: journeyBuffer,
        profiledCurrent: true,
        manual: previousManual,
        manualCurrent: false,
      }),
    ).toBe(journeyBuffer)
    expect(
      selectLiveTrace({
        deviceRoast: live,
        activeSession: completedJourney,
        profiled: journeyBuffer,
        profiledCurrent: true,
        manual: [],
        manualCurrent: false,
      }),
    ).toBe(journeyBuffer)
    // Before that buffer is keyed to the session there is nothing honest to draw - not another roast.
    expect(
      selectLiveTrace({
        deviceRoast: live,
        activeSession: retainedManual,
        profiled: [],
        profiledCurrent: false,
        manual: previousManual,
        manualCurrent: false,
      }),
    ).toEqual([])
    const manual = { active: true, mode: 'manual' as const }
    expect(
      selectLiveTrace({
        deviceRoast: manual,
        activeSession: completedJourney,
        profiled: journeyBuffer,
        profiledCurrent: true,
        manual: manualBuffer,
        manualCurrent: true,
      }),
    ).toBe(manualBuffer)
    expect(
      selectLiveTrace({
        deviceRoast: manual,
        activeSession: retainedManual,
        profiled: [],
        profiledCurrent: false,
        manual: manualBuffer,
        manualCurrent: true,
      }),
    ).toBe(manualBuffer)
  })

  it('lets the completed archive record replace the live buffer once the roaster is idle', () => {
    const idle = { active: false, mode: 'journey' as const }
    expect(
      selectLiveTrace({
        deviceRoast: idle,
        activeSession: completedJourney,
        profiled: journeyBuffer,
        profiledCurrent: true,
        manual: [],
        manualCurrent: false,
      }),
    ).toBe(previousJourney)
    // The ended roast before its archive completes the record: the live buffer, cooling tail and all.
    const staged = { outcome: 'running' as const, samples: [] }
    expect(
      selectLiveTrace({
        deviceRoast: idle,
        activeSession: staged,
        profiled: journeyBuffer,
        profiledCurrent: true,
        manual: [],
        manualCurrent: false,
      }),
    ).toBe(journeyBuffer)
    expect(
      selectLiveTrace({
        deviceRoast: undefined,
        activeSession: undefined,
        profiled: journeyBuffer,
        profiledCurrent: true,
        manual: [],
        manualCurrent: false,
      }),
    ).toBe(journeyBuffer)
    expect(
      selectLiveTrace({
        deviceRoast: idle,
        activeSession: retainedManual,
        profiled: [],
        profiledCurrent: false,
        manual: manualBuffer,
        manualCurrent: true,
      }),
    ).toBe(manualBuffer)
    expect(
      selectLiveTrace({
        deviceRoast: idle,
        activeSession: { ...retainedManual, outcome: 'complete' },
        profiled: [],
        profiledCurrent: false,
        manual: manualBuffer,
        manualCurrent: false,
      }),
    ).toBe(previousManual)
    expect(
      selectLiveTrace({
        deviceRoast: idle,
        activeSession: undefined,
        profiled: [],
        profiledCurrent: false,
        manual: manualBuffer,
        manualCurrent: true,
      }),
    ).toBe(manualBuffer)
  })
})

describe('device-owned final-plan decision', () => {
  it('uses a reserved non-recording key that survives in the existing device meta document', () => {
    const key = activePlanDecisionKey(plan, 'discarded')
    expect(key).toBe('__active-plan-decision__:boot-7:31:4:discarded')
    expect(/^\d+$/.test(key)).toBe(false)
    expect(['1', '2', '31'].includes(key)).toBe(false)
    expect(SOURCE).toContainCode('await crackleData.markDeviceLogsImported([decisionKey])')
  })
})

describe('archive reconciliation ledger identity', () => {
  it('commits immutable origin keys for normal imports and ledger repair', () => {
    const start = SOURCE.indexOf('const importDeviceRoasts = useCallback')
    const end = SOURCE.indexOf('const deviceLogIds', start)
    const importer = SOURCE.slice(start, end)
    expect(importer).toContainCode('const decisionKey = recordingKey(entry.recordingOrigin)')
    // Both manual and profiled candidates complete a staged record where one matches, still keyed
    // by the immutable origin.
    expect(importer).toContainCode('run: reconciliation.run, logId: reconciliation.logId')
    expect(importer).toContainCode('ledgerRepairIds.push(decisionKey)')
    expect(importer).not.toContainCode('logId: entry.id')
    expect(importer).not.toContainCode('ledgerRepairIds.push(entry.id)')
  })
})

describe('reconnected roast trace recovery', () => {
  it('tries the exact reserved log, falls back to live RAM CSV, and labels a partial curve honestly', () => {
    expect(SOURCE).toContainCode('controller.fetchDeviceLogCsv(activeThermalLogId)')
    expect(SOURCE).toContainCode('controller.fetchThermalCsv()')
    expect(SOURCE).toContainCode("let hydrated: RoastRun['samples'] = []")
    expect(SOURCE).toContainCode('if (hydrated.length === 0)')
    expect(SOURCE).toContainCode('setProfiledLiveSamples((current) => mergeRecordingPrefix(hydrated, current))')
    expect(SOURCE).toContainCode('Live samples will appear here as they arrive')
  })
})

describe('recording deletion consequences', () => {
  it('distinguishes fallback-backed curves from permanent detailed-history loss', () => {
    const deletion = SOURCE.slice(
      SOURCE.indexOf('const pruneDeviceLogs'),
      SOURCE.indexOf('/*\n   * On load', SOURCE.indexOf('const pruneDeviceLogs')),
    )
    expect(deletion).toContainCode('run.samples.length > 0')
    expect(deletion).toContainCode('calibrationRecordingKey(run) === recordingKey(entry.recordingOrigin)')
    expect(deletion).toContainCode('preserved as calibration evidence')
    expect(deletion).toContainCode('no preserved fallback')
    expect(deletion).toContainCode('permanently removes that detailed history')
    expect(deletion).toContainCode('catalogMutationReasonRef.current')
    expect(deletion).toContainCode('Delete ${logIds.length} thermal recording')
    expect(deletion).not.toContainCode('Delete ${logIds.length} detailed thermal recording')
  })
})
describe('calibration documents wait for roaster acknowledgement', () => {
  it('publishes saves and deletions only after each backing mutation resolves', () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('const saveCalibrationRun = async'),
      SOURCE.indexOf('const appendManualEvent'),
    )
    const saveRun = block.slice(block.indexOf('const saveCalibrationRun'), block.indexOf('const deleteCalibrationRun'))
    expect(saveRun.indexOf('await crackleData.saveCalibrationRun(run)')).toBeLessThan(
      saveRun.indexOf('setCalibrationRuns('),
    )
    const deleteRun = block.slice(
      block.indexOf('const deleteCalibrationRun'),
      block.indexOf('const saveCalibrationSnapshot'),
    )
    expect(deleteRun.indexOf('await crackleData.deleteCalibrationRun(id)')).toBeLessThan(
      deleteRun.indexOf('setCalibrationRuns('),
    )
    const saveSnapshot = block.slice(
      block.indexOf('const saveCalibrationSnapshot'),
      block.indexOf('const deleteCalibrationSnapshot'),
    )
    expect(saveSnapshot.indexOf('await crackleData.saveCalibrationSnapshot(snapshot)')).toBeLessThan(
      saveSnapshot.indexOf('setCalibrationSnapshots('),
    )
    const deleteSnapshot = block.slice(block.indexOf('const deleteCalibrationSnapshot'))
    expect(deleteSnapshot.indexOf('await crackleData.deleteCalibrationSnapshot(id)')).toBeLessThan(
      deleteSnapshot.indexOf('setCalibrationSnapshots('),
    )
    expect(block).not.toContainCode('persist(crackleData.saveCalibration')
    expect(block).not.toContainCode('persist(crackleData.deleteCalibration')
  })

  it('treats acknowledged calibration source logs as safe detailed-recording deletions', () => {
    const pruning = SOURCE.slice(SOURCE.indexOf('const prunableLogIds'), SOURCE.indexOf('const pruneDeviceLogs'))
    expect(pruning).toContainCode(
      'preserved.add(recordingKey({ deviceId: run.recordedOn.deviceId, logId: run.sourceLogId }))',
    )
    expect(pruning).toContainCode('preserved.has(recordingKey(entry.recordingOrigin))')
    expect(pruning).toContainCode('[calibrationRuns, deviceLogIds, importedLogIds]')
    expect(SOURCE).toContainCode('}, [calibrationRuns, deviceLogs])')
  })
})

describe('committed render state waits for acknowledgement', () => {
  it('does not replace profile or bean catalog state before the roaster save resolves', () => {
    const profileSave = SOURCE.slice(
      SOURCE.indexOf('const saveProfile = async'),
      SOURCE.indexOf('const saveBean = async'),
    )
    expect(profileSave.indexOf('await crackleData.saveProfileWithRevision(profile, revision)')).toBeLessThan(
      profileSave.indexOf('setProfiles('),
    )
    const beanSave = SOURCE.slice(
      SOURCE.indexOf('const saveBean = async'),
      SOURCE.indexOf('// Explicit bean-profile links'),
    )
    expect(beanSave.indexOf('await crackleData.saveBean(bean)')).toBeLessThan(beanSave.indexOf('setBeans('))
    expect(SOURCE).not.toContainCode('Changes are saved here and will sync when it comes back')
    expect(SOURCE).toContainCode('this browser copy is read-only')
  })
})
describe('authoritative roast-plan archive import', () => {
  it('loads provenance and samples from one compact archive with CSV as a legacy fallback', () => {
    expect(SOURCE).toContainCode('if (entry.version === 4)')
    expect(SOURCE).toContainCode('archiveBytes = await controller.fetchDeviceLogFile(entry.id)')
    expect(SOURCE).toContainCode('const archiveSamples = decodeCrkThermalSamples(archiveBytes, entry.id)')
    expect(SOURCE).toContainCode('const csv = archiveCsv ?? await controller.fetchDeviceLogCsv(entry.id)')
    expect(SOURCE).toContainCode('archive: archiveBytes')
    expect(SOURCE.indexOf('archiveBytes = await controller.fetchDeviceLogFile(entry.id)')).toBeLessThan(
      SOURCE.indexOf('const archiveSamples = decodeCrkThermalSamples(archiveBytes, entry.id)'),
    )
    expect(SOURCE.indexOf('const archiveSamples = decodeCrkThermalSamples(archiveBytes, entry.id)')).toBeLessThan(
      SOURCE.indexOf('const csv = archiveCsv ?? (await controller.fetchDeviceLogCsv(entry.id))'),
    )
    expect(SOURCE).toContainCode("view === 'history' || view === 'settings' || view === 'calibrate'")
  })
})
/**
 * All-or-nothing rendering: a History record whose reconciliation has not settled renders an
 * explicit loading state with its reason, never a partial record that later mutates in place. The
 * record staged at Start is exactly such a record while it runs.
 */
describe('history detail all-or-nothing gate', () => {
  const staged = (overrides: Partial<RoastRun> = {}) =>
    ({
      name: 'Haitian Blue',
      outcome: 'running',
      samples: [],
      events: [],
      recordedOn: { deviceId: 'dev-1' },
      deviceRoastPending: { bootId: 'boot-7' },
      ...overrides,
    }) as unknown as RoastRun

  it('settled records render immediately, including legacy browser-only roasts', () => {
    expect(
      historyDetailPendingReason(staged({ outcome: 'complete', deviceRoastPending: undefined }), status()),
    ).toBeUndefined()
    expect(
      historyDetailPendingReason(staged({ outcome: 'aborted', deviceRoastPending: undefined }), status()),
    ).toBeUndefined()
  })

  it('names the running roast, the saving recording, the busy archive, and the silent wait', () => {
    const running = status({
      roast: { active: true, mode: 'journey', name: 'Haitian Blue' } as ControllerStatus['roast'],
    })
    expect(historyDetailPendingReason(staged(), running)).toContainCode('still running')
    const saving = status({
      roast: { active: false, mode: 'journey' } as ControllerStatus['roast'],
      thermalLog: { source: 'roast', active: false, unsaved: true } as ControllerStatus['thermalLog'],
    })
    expect(historyDetailPendingReason(staged(), saving)).toContainCode('saving')
    const idle = status({ roast: { active: false, mode: 'none' } as ControllerStatus['roast'] })
    expect(historyDetailPendingReason(staged(), idle, true)).toContainCode('retrying automatically')
    expect(historyDetailPendingReason(staged(), idle, false)).toContainCode('reconciled')
  })

  it('does not claim a different roast is this record', () => {
    const otherRoast = status({
      roast: { active: true, mode: 'journey', name: 'Different roast' } as ControllerStatus['roast'],
    })
    expect(historyDetailPendingReason(staged(), otherRoast)).not.toContainCode('still running')
  })

  it('gates a stopped manual roast whose recording has not reconciled, but never a finished legacy one', () => {
    const stoppedAwaiting = staged({
      outcome: 'complete',
      deviceRoastPending: undefined,
      manualRoast: {
        changes: [],
        incomplete: true,
        pendingRecording: {
          recordingOrigin: { deviceId: 'dev-1', logId: '9' },
          storageAddress: { deviceId: 'dev-1', logId: '9' },
        },
      },
    } as unknown as Partial<RoastRun>)
    expect(
      historyDetailPendingReason(
        stoppedAwaiting,
        status({ roast: { active: false, mode: 'none' } as ControllerStatus['roast'] }),
      ),
    ).toBeDefined()
    const legacyUnrecorded = staged({
      outcome: 'complete',
      deviceRoastPending: undefined,
      manualRoast: { changes: [], incomplete: true },
    } as unknown as Partial<RoastRun>)
    expect(historyDetailPendingReason(legacyUnrecorded, status())).toBeUndefined()
  })

  it('asks for the recording roaster when this record belongs to another device', () => {
    const foreign = status({ roaster: { deviceId: 'other-roaster' } as ControllerStatus['roaster'] })
    expect(historyDetailPendingReason(staged(), foreign)).toContainCode('different roaster')
  })

  it('is wired into the expanded record ahead of every editable field', () => {
    const HISTORY_SOURCE = readFileSync(new URL('./components/HistoryView.tsx', import.meta.url), 'utf8')
    const gate = HISTORY_SOURCE.indexOf('const pendingReason = detailPendingReason?.(run)')
    expect(gate).toBeGreaterThan(-1)
    expect(HISTORY_SOURCE.indexOf('Loading this roast…')).toBeGreaterThan(gate)
    expect(gate).toBeLessThan(HISTORY_SOURCE.indexOf('record-source-detail'))
    expect(SOURCE).toContainCode(
      'detailPendingReason={(run) => historyDetailPendingReason(run, liveStatus, archiveListDeferred)}',
    )
  })
})

describe('the localStorage pending-setup stash is gone', () => {
  it('only purges the abandoned key and never writes it', () => {
    expect(SOURCE.match(/crackle:pending-roast-setup/g)?.length).toBe(1)
    expect(SOURCE).not.toContainCode("localStorage?.setItem('crackle:pending-roast-setup'")
    const store = new Map<string, string>()
    store.set('crackle:pending-roast-setup', '{"startedAtMs":1}')
    const localStorageStub = {
      removeItem: (key: string) => {
        store.delete(key)
      },
    } as unknown as Storage
    Object.defineProperty(globalThis, 'localStorage', { value: localStorageStub, configurable: true })
    purgeLegacyPendingRoastSetup()
    expect(store.has('crackle:pending-roast-setup')).toBe(false)
  })

  it('stages the complete record on the roaster before the Start command instead', () => {
    const startFlow = SOURCE.slice(
      SOURCE.indexOf('const startDeviceRoast = useCallback'),
      SOURCE.indexOf('const importDeviceRoasts'),
    )
    const staging = startFlow.indexOf('executeDeviceRoastStart(run, {')
    const command = startFlow.indexOf('start: () => controllerRef.current!.startRoast(')
    expect(staging).toBeGreaterThan(-1)
    expect(command).toBeGreaterThan(staging)
    expect(startFlow).toContainCode('provisionalDeviceRoastRun({')
    // Fail closed: a refused record write means Start never fires, and the reason shows.
    expect(startFlow).toContainCode('The roast was not started. The roaster did not accept its run record:')
  })
})
