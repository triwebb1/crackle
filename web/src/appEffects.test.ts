import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { reconcileManualEvent } from './domain/manualControl'
import { parseRoute, routeHash } from './domain/routing'
import { testRecordedOn } from './testFixtures/provenance'

const SOURCE = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('recording-origin boundaries in app effects', () => {
  it('commits immutable origins for normal reconciliation and repair', () => {
    const start = SOURCE.indexOf('const importDeviceRoasts = useCallback')
    const end = SOURCE.indexOf('const deviceLogIds', start)
    const importer = SOURCE.slice(start, end)
    expect(importer).toContainCode('const decisionKey = recordingKey(entry.recordingOrigin)')
    // Both manual and profiled candidates complete a staged record where one matches, still keyed
    // by the immutable origin.
    expect(importer).toContainCode('run: reconciliation.run, logId: reconciliation.logId')
    expect(importer).toContainCode('reconcileProfiledArchiveRun({')
    expect(importer).toContainCode('ledgerRepairIds.push(decisionKey)')
    expect(importer).not.toContainCode('logId: entry.id')
    expect(importer).not.toContainCode('ledgerRepairIds.push(entry.id)')
  })

  it('marks origin ledger keys but deletes current storage ids during a cascade', () => {
    const start = SOURCE.indexOf('const cascadeDelete = useCallback')
    const end = SOURCE.indexOf('BACKUP, RESTORE', start)
    const cascade = SOURCE.slice(start, end)
    expect(cascade).toContainCode('markDeviceLogsImported(plan.recordingLedgerKeys)')
    expect(cascade).toContainCode('for (const logId of plan.recordingIds)')
    expect(cascade).not.toContainCode('markDeviceLogsImported(plan.recordingIds)')
  })
})
/**
 * ============================================================================================
 * THE LOADED GUN IN THE DEPENDENCY ARRAY
 * ============================================================================================
 *
 * The manual-history reconciler runs from an effect. Declaring `manualEvents` among its
 * dependencies would make it its own trigger: it appends an event, `manualEvents` gets a new
 * identity, the effect fires again against the same observation, and round it goes.
 *
 * It would terminate - but only because `reconcileManualEvent` is idempotent, and that is a property
 * of the CALLEE. The caller would be relying on a guarantee it does not own and cannot see. One
 * future reconciler that disagreed with itself, or one that grew a clock-dependent branch, and the
 * app would spin.
 *
 * The effect therefore depends on the OBSERVATION - the live status and readiness - and reads the
 * current history through a ref, which is up to date on every render without being a reason to
 * re-run.
 *
 * A source-level pin, deliberately. The dependency array is not observable from rendered output or
 * from any exported function, so the only place this contract can be stated is where it is written.
 * The behaviour it protects is covered from the other side by `domain/manualControl.test.ts`, and
 * the second test below states the half of the contract that is genuinely testable: what the effect
 * calls must still be safe to call twice on the same observation.
 */
describe('the manual reconciler effect cannot trigger itself', () => {
  const effect = (() => {
    const start = SOURCE.indexOf('const derived = reconcileManualEvent({')
    expect(start, 'the reconcile effect is no longer recognisable in App.tsx').toBeGreaterThan(-1)
    const end = SOURCE.indexOf('}, [', start)
    return SOURCE.slice(start, SOURCE.indexOf(')', end) + 1)
  })()

  it('excludes the history it writes to from its dependency array', () => {
    const deps = /\}, \[([^\]]*)\]\)/.exec(effect)?.[1] ?? ''
    expect(deps).not.toContainCode('manualEvents')
    // What it DOES depend on: the observation that could produce an event, and nothing else.
    expect(
      deps
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .sort(),
    ).toEqual(['currentRecordedOn', 'liveStatus', 'ready'])
  })

  it('reads the newest event through a ref rather than through a dependency', () => {
    expect(effect).toContainCode('latest: manualEventsRef.current.at(-1)')
    expect(SOURCE).toContainCode('manualEventsRef.current = manualEvents')
  })

  /**
   * The behaviour a `manualEvents` dependency would have provided, restated as the thing that
   * actually has to hold: an unchanged observation produces one event, not a stream of them. With the effect
   * edge-triggered this is what a second render against the same status would do.
   */
  it('still produces nothing the second time it sees the same observation', () => {
    const observation = {
      manual: { active: true, fanLevel: 6, heatLevel: 4 },
      observedAtMs: 10_000,
      nowMs: 10_000,
      temperatureC: 120.4,
      recordedOn: testRecordedOn,
    }
    const first = reconcileManualEvent({ ...observation, latest: undefined })
    expect(first).toBeDefined()
    expect(reconcileManualEvent({ ...observation, latest: first })).toBeUndefined()
  })
})

/**
 * ============================================================================================
 * THE BACK BUTTON, AND THE LOOP IT COULD HAVE BECOME
 * ============================================================================================
 *
 * Back must return to the tab/page the user was just on, not leave the Crackle site.
 *
 * The mapping between a screen and its address is pure and is tested as such in
 * `domain/routing.test.ts`. What cannot be reached from there is the WIRING, and the wiring has one
 * rule that matters more than the rest: `popstate` fires AFTER the browser has already moved, so a
 * handler that pushes in response is a handler that fights the user's own Back press. The only push
 * on that path is the refusal - declining the unsaved-work prompt has to put the address back - and
 * that is exactly what the assertions below allow and nothing more.
 *
 * A source-level pin for the same reason the reconciler above has one: a listener registration is
 * not observable from rendered output or from any exported function.
 */
describe('view navigation is browser history', () => {
  it('uses the fragment, which is the only address a flash-served single page can deep-link with', () => {
    expect(SOURCE).toContainCode('parseRoute(window.location.hash)')
    expect(routeHash({ view: 'history', runId: 'run-1' })).toBe('#/history/run-1')
    expect(parseRoute('#/history/run-1')).toEqual({ view: 'history', runId: 'run-1' })
  })

  it('writes one entry per arrival and normalises the first one in place', () => {
    expect(SOURCE).toContainCode("window.history.pushState(target, '', routeHash(target))")
    expect(SOURCE).toContainCode("window.history.replaceState(routeRef.current, '', routeHash(routeRef.current))")
    // Standing still is not an arrival, or leaving a tab would take two Backs.
    expect(SOURCE).toContainCode('if (sameRoute(target, current)) return true')
  })

  const restore = (() => {
    const start = SOURCE.indexOf('const restore = () => {')
    expect(start, 'the popstate handler is no longer recognisable in App.tsx').toBeGreaterThan(-1)
    return SOURCE.slice(start, SOURCE.indexOf("window.addEventListener('popstate'", start))
  })()

  it('never pushes from the pop path except to undo a refusal', () => {
    const pushes = [...restore.matchAll(/window\.history\.pushState/g)]
    expect(pushes).toHaveLength(1)
    // And that one push restores where the app still IS, rather than where the browser went.
    expect(restore).toContainCode('const current = routeRef.current')
    expect(restore).toContainCode("window.history.pushState(current, '', routeHash(current))")
    // Only leaving the VIEW asks; History-to-History keeps the editor and its dirty flag.
    expect(restore).toContainCode(
      'navigationNeedsConfirm(current.view, next.view, unsavedRef.current) && !window.confirm(LEAVE_WITHOUT_SAVING)',
    )
  })

  it('registers the listener once, reading the dirty flag through a ref rather than a dependency', () => {
    expect(SOURCE).toContainCode("window.addEventListener('popstate', restore)")
    expect(SOURCE).toContainCode("return () => window.removeEventListener('popstate', restore)")
    expect(SOURCE).toContainCode('unsavedRef.current = unsaved')
    expect(SOURCE).toContainCode('routeRef.current = route')
  })
})

/**
 * ============================================================================================
 * A QUEUED WRITE IS NOT A FAILURE
 * ============================================================================================
 *
 * A "changes waiting for the roaster to go idle" line beside a manual command that succeeded is the
 * document write queue holding the manual event history behind the firmware's idle gate - exactly
 * the designed behaviour, on a path that has just worked. Rendering it in the alarm wash of
 * `storage-error-banner` would teach the user to read a normal state as a fault, and on the one
 * screen where a red banner beside a heat command is worst.
 *
 * Source-level, because the banner is app-shell chrome with no exported function behind it.
 */
describe('the queued-write line is a quiet note, not an alarm', () => {
  const line = (() => {
    const start = SOURCE.indexOf('{dataSync.queued > 0')
    expect(start, 'the queued-write line is no longer recognisable in App.tsx').toBeGreaterThan(-1)
    return SOURCE.slice(start, SOURCE.indexOf('</div>', start) + 6)
  })()

  it('never renders in the error wash, and never claims the alert role', () => {
    expect(line).not.toContainCode('storage-error-banner')
    expect(line).toContainCode('role="status"')
    expect(line).not.toContainCode('role="alert"')
  })

  it('says every working edit is safe without guessing what kind of record changed', () => {
    expect(line).toContainCode('working {dataSync.queued === 1')
    expect(line).toContainCode('safe in this browser')
    expect(line).toContainCode('written to the roaster when it next idles')
    expect(line).not.toContainCode('notes and event history')
  })
})

describe('terminal library sync feedback is global', () => {
  it('renders the data-layer message in app chrome as a nonfatal status', () => {
    const start = SOURCE.indexOf('{dataSync.message &&')
    expect(start).toBeGreaterThan(-1)
    const line = SOURCE.slice(start, SOURCE.indexOf('</div>', start) + 6)
    expect(line).toContainCode('sync-state-banner terminal')
    expect(line).toContainCode('role="status"')
    expect(line).toContainCode('{dataSync.message}')
  })
})

describe('manual controller sessions have one run document across browsers', () => {
  it('derives the late-join run id from controller identity instead of browser randomness', () => {
    const start = SOURCE.indexOf('/** Attach a newly opened browser to a manual roast already running')
    const end = SOURCE.indexOf('/**\n   * The live manual curve', start)
    const recovery = SOURCE.slice(start, end)
    expect(recovery).toContainCode('manualRoastRunId(liveStatus.bootId, roast.sessionId)')
    expect(recovery).not.toContainCode("newId('run')")
  })

  /**
   * A RECORDED manual roast's identity is the record staged durably on the roaster before Start -
   * every browser reads the same document, so the id need not be derived from the acknowledgement. The non-recorded path keeps the controller-identity
   * derivation, because there is no staged record to share.
   */
  it('keeps one durable identity: the staged record when recording, controller identity otherwise', () => {
    const start = SOURCE.indexOf('const startManualRoast = async')
    const end = SOURCE.indexOf('const setManualRoast = async', start)
    const startFlow = SOURCE.slice(start, end)
    // The staged record is written (and its id fixed) BEFORE the Start command is issued.
    const staging = startFlow.indexOf('executeDeviceRoastStart(stagedRun')
    const startCommand = startFlow.indexOf('start: () => controllerRef.current!.startRoast(args)')
    expect(staging).toBeGreaterThan(-1)
    expect(startCommand).toBeGreaterThan(staging)
    expect(startFlow).toContainCode('const runId = stagedRun?.id ?? manualRoastRunId(deviceBootId, result.sessionId)')
  })

  it('keeps one volatile live record until the matching controller archive is durable', () => {
    expect(SOURCE).toContainCode('const manualWorkingRunRef = useRef<RoastRun>()')
    expect(SOURCE).toContainCode('[workingManual, ...storedRuns.filter((run) => run.id !== workingManual.id)]')
    expect(SOURCE).toContainCode('manualWorkingRunRef.current = recovered')
    expect(SOURCE).not.toContainCode('persistManualRun(')
    expect(SOURCE).not.toContainCode('if (sync.queued === 0 && !sync.message) manualWorkingRunRef.current = undefined')
    expect(SOURCE).toContainCode(
      'The archive importer clears this overlay only after the matching device recording is durable',
    )
    expect(SOURCE).toContainCode('manualWorkingRunRef.current = undefined')
  })
})

describe('an empty controller library remains usable', () => {
  it('renders the app without a selected catalog profile and defaults Roast to Manual', () => {
    expect(SOURCE).toContainCode('activeSession?.profile ?? selectedLibraryProfile ?? EMPTY_LIBRARY_MANUAL_PROFILE')
    expect(SOURCE).toContainCode(
      'setManualMode(restoredRun?.manualRoast !== undefined || loaded.profiles.length === 0)',
    )
    expect(SOURCE).toContainCode('setManualMode(profiles.length === 0 ? true : manual)')
    expect(SOURCE).toContainCode('if (!ready) return <div className="app-loading"')
    expect(SOURCE).not.toContainCode('if (!ready || !selectedProfile)')
  })
})

describe('startup does not flash an unverified device library', () => {
  it('waits for local storage, the first status, and device attach when a document store exists', () => {
    expect(SOURCE).toContainCode('const ready = liveOnlyControllerWorkReady')
    expect(SOURCE).toContainCode(
      '|| (localLibraryReady && statusChecked && (status.dataStore === undefined || deviceLibraryReady))',
    )
    expect(SOURCE).toContainCode('setStatusChecked(true)')
    const start = SOURCE.indexOf('if (!localLibraryReady || !statusChecked || !dataStoreSupported) return')
    const end = SOURCE.indexOf('const adoptLocalData', start)
    const attach = SOURCE.slice(start, end)
    expect(attach.indexOf('await crackleData.attach(')).toBeGreaterThan(-1)
    expect(attach.indexOf('setDeviceLibraryReady(true)')).toBeGreaterThan(attach.indexOf('await crackleData.attach('))
    expect(attach).toContainCode('const loaded = await reloadFromStore()')
  })

  it('opens an identity-bound cached library offline instead of spinning forever', () => {
    const start = SOURCE.indexOf('if (!statusChecked || libraryInitializationStartedRef.current) return')
    const end = SOURCE.indexOf('// The data layer announces every reconciliation', start)
    const bootstrap = SOURCE.slice(start, end)
    expect(bootstrap).toContainCode('if (!status.connected && liveStatus.connected) return')
    expect(bootstrap).toContainCode('await crackleData.observedDeviceBinding()')
    expect(bootstrap).toContainCode('const warnings = await crackleData.initialize()')
    expect(bootstrap).toContainCode('const loaded = await reloadFromStore()')
    expect(bootstrap).toContainCode('setLocalLibraryReady(true)')
  })

  it('labels an offline browser cache as unverified', () => {
    expect(SOURCE).toContainCode('Browser library not yet verified')
    expect(SOURCE).toContainCode("it has not been checked against the roaster's library")
  })

  it('keeps a cached library and actuator writes fail-closed after an identity or attach failure', () => {
    expect(SOURCE).toContainCode('const [deviceAttachFailure, setDeviceAttachFailure]')
    expect(SOURCE).toContainCode('const mutationBlockedReason = deviceAttachFailure ?? (!localLibraryReady')
    expect(SOURCE).toContainCode('const actuatorMutationBlockedReason = deviceAttachFailure ??')
    const start = SOURCE.indexOf('if (!localLibraryReady || !statusChecked || !dataStoreSupported) return')
    const end = SOURCE.indexOf('const adoptLocalData', start)
    const attach = SOURCE.slice(start, end)
    expect(attach).toContainCode('setDeviceAttachFailure(message)')
    expect(attach).toContainCode('setStorageError(message)')
    expect(attach).toContainCode('setDeviceAttachFailure(undefined)')
  })

  it('rehydrates compact documents only after an archive lookup at the current revision proves immutable origin', () => {
    const start = SOURCE.indexOf('if (!localLibraryReady || !statusChecked || !dataStoreSupported) return')
    const end = SOURCE.indexOf('const adoptLocalData', start)
    const attach = SOURCE.slice(start, end)
    // One list read per state revision; every archive change advances it.
    expect(attach).toContainCode('const archive = await archiveForHydration()')
    expect(attach).toContainCode('hydrationArchive.stateRev === stateRev')
    expect(attach).toContainCode('const archive = controller.deviceLogs()')
    expect(attach).toContainCode('controller.fetchDeviceLogFile(exact.storageAddress.logId)')
    expect(attach).toContainCode('validateCrkRecording(bytes, exact.storageAddress.logId)')
    expect(attach).toContainCode('validation.summary.recordingOrigin')
    expect(attach).not.toContainCode('fetchDeviceLogCsv')
    expect(attach).not.toContainCode('archivePromise')
  })
})

describe('acknowledgement-first catalog mutations', () => {
  it('passes the live mutation reason into both persistent catalog editors', () => {
    expect(SOURCE).toContainCode('<ProfileEditor profiles={orderedProfiles}')
    expect(SOURCE).toContainCode(
      "deleteBlockedReason={deleteBlocked} mutationBlockedReason={mutationBlockedReason ?? modelBlockedReason('author')} previewBlockedReason={modelBlockedReason('preview')} onDeleteProfile=",
    )
    expect(SOURCE).toContainCode('<BeansView beans={orderedBeans}')
    expect(SOURCE).toContainCode(
      'deleteBlockedReason={deleteBlocked} mutationBlockedReason={mutationBlockedReason} onSelect=',
    )
  })

  it('does not publish a legacy import until every device write is acknowledged', () => {
    const start = SOURCE.indexOf('const importArchive = async')
    const end = SOURCE.indexOf('const saveOverrideRevision', start)
    const flow = SOURCE.slice(start, end)
    expect(flow).toContainCode('for (const write of writes) await write()')
    expect(flow.indexOf('for (const write of writes) await write()')).toBeLessThan(
      flow.indexOf('if (nextRuns) setRuns(nextRuns)'),
    )
    expect(flow.indexOf('for (const write of writes) await write()')).toBeLessThan(
      flow.indexOf('if (nextProfiles) setProfiles(nextProfiles)'),
    )
    expect(flow).not.toContainCode('persist(crackleData.saveRun')
    expect(flow).not.toContainCode('persist(crackleData.saveProfile')
  })
})

describe('controller convergence wiring', () => {
  it('installs the transport mutation gate for the app lifetime', () => {
    expect(SOURCE).toContainCode('setControllerMutationGate(() => controllerMutationReasonRef.current)')
    expect(SOURCE).toContainCode('controllerMutationReasonRef.current = actuatorMutationBlockedReason')
    expect(SOURCE).toContainCode('catalogMutationReasonRef.current = mutationBlockedReason')
    expect(SOURCE).toContainCode('return () => {')
    expect(SOURCE).toContainCode('setControllerMutationGate(undefined)')
    expect(SOURCE).toContainCode('setControllerModelGate(undefined)')
  })

  it('uses one lease-owning controller and aborts only before the destructive restore boundary', () => {
    expect(SOURCE).toContainCode('const controllerRef = useRef<HttpControllerClient | null>(null)')
    expect(SOURCE).toContainCode('const restoreController = controllerRef.current!')
    expect(SOURCE).toContainCode('restoreBackup(backup, restoreController')
    expect(SOURCE).toContainCode('if (formatted) {')
    expect(SOURCE).toContainCode('The roaster remains in incomplete restore mode')
    expect(SOURCE).toContainCode('} else {\n        try {\n          await crackleData.abortDeviceRestore()')
    expect(SOURCE).not.toContainCode(
      'if (formatted) await crackleData.resetAfterDeviceFormat()\n        await crackleData.abortDeviceRestore()',
    )
    expect(SOURCE).not.toContainCode('restoreBackup(backup, new HttpControllerClient()')
  })

  it('revision-fences authoritative backup reads', () => {
    expect(SOURCE).toContainCode('await crackleData.revisionFenced(async () =>')
    expect(SOURCE).toContainCode('crackleData.documentPayloads()')
    expect(SOURCE).toContainCode('controller.fetchDeviceLogFile(storageAddress.logId)')
  })

  it('keys active-plan refresh to controller identity and plan revision', () => {
    expect(SOURCE).toContainCode('liveStatus.roast?.planRev')
    expect(SOURCE).toContainCode('controllerRef.current!.fetchActiveRoastPlan()')
    expect(SOURCE).toContainCode('profileFromActiveRoastPlan(displayedActiveRoastPlan, undefined, profiles)')
  })
})

describe('active-plan effect stability', () => {
  it('depends on primitive device identity fields rather than the churned status object', () => {
    const start = SOURCE.indexOf(
      'useEffect(() => {\n    const roast = liveStatus.roast',
      SOURCE.indexOf('refreshActiveRoastPlan'),
    )
    const end = SOURCE.indexOf('])\n', start)
    const effect = SOURCE.slice(start, end)
    expect(effect).toContainCode('liveStatus.roast?.planRev')
    expect(effect).toContainCode('liveStatus.roast?.sessionId')
    expect(effect).not.toMatch(/\[liveStatus[,\]]/)
  })

  it('wires completion Save and Discard without rewriting the device plan snapshot', () => {
    expect(SOURCE).toContainCode('onSaveActivePlanRevision={saveActivePlanRevision}')
    expect(SOURCE).toContainCode('onDiscardActivePlanRevision={discardActivePlanRevision}')
    expect(SOURCE).toContainCode('setHandledActivePlanEditsKey')
    expect(SOURCE).not.toContainCode('setActiveRoastPlan((plan) => plan ? { ...plan, planRev: 1')
  })
})

describe('background storage work stays bounded and quiet', () => {
  it('lists recordings only initially, after a settle/waiting panel, or for an archive consumer', () => {
    const start = SOURCE.indexOf('const archiveSupported =')
    const end = SOURCE.indexOf('const selectedLibraryProfile', start)
    const effect = SOURCE.slice(start, end)
    expect(effect).toContainCode("view === 'history' || view === 'settings'")
    expect(effect).toContainCode("outcome === 'complete'")
    // The per-episode budget is the shared schedule (replenished each fresh episode,
    // uncapped only while the post-roast panel visibly waits on this very read).
    expect(effect).toContainCode('archiveRetryDelayMs(archiveRetryCountRef.current, awaitingManualReconciliation)')
    expect(effect).toContainCode('if (!timerRetry) archiveRetryCountRef.current = 0')
    expect(effect).toContainCode('justSettled')
    expect(effect.indexOf("outcome === 'complete'")).toBeLessThan(
      effect.indexOf('archiveImportAttemptedRef.current = true'),
    )
  })

  it('batches Controls events and never presents its retry as the current page edit', () => {
    const start = SOURCE.indexOf('const appendManualEvent =')
    const end = SOURCE.indexOf('const clearManualEvents =', start)
    const effect = SOURCE.slice(start, end)
    expect(effect).toContainCode('saveManualEvents(pending)')
    expect(effect).toContainCode('manualHistoryFlushNonce')
    expect(effect).toContainCode('retryableManualHistoryFailure(message)')
    expect(effect).toContainCode('setManualHistorySaveError(message)')
    expect(effect).not.toContainCode('setStorageError(message)')
    expect(SOURCE).toContainCode('Controls worked, but their event history is not saved yet.')
    expect(SOURCE).toContainCode('Retry saving')
  })
})
