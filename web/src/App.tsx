import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import packageMetadata from '../package.json'
import { AppShell } from './components/AppShell'
import { type BackupConflictDecision, BackupConflictDialog } from './components/BackupConflictDialog'
import { BeansView } from './components/BeansView'
import { CalibrationView } from './components/CalibrationView'
import { CrackleMark } from './components/CrackleMark'
import { HistoryView } from './components/HistoryView'
import { LibraryPending } from './components/LibraryPending'
import { ManualView } from './components/ManualView'
import { ProfileEditor, type ProfileSuggestions } from './components/ProfileEditor'
import { ReferenceView } from './components/ReferenceView'
import { appendProfiledRoastSample, profileFromActiveRoastPlan, RoastView } from './components/RoastView'
import { SettingsView } from './components/SettingsView'
import {
  type ActiveRoastPlan,
  type CommandResult,
  HttpControllerClient,
  type LiveSnapshot,
  setControllerModelGate,
  setControllerMutationGate,
} from './controller/client'
import {
  activeConfiguredTarget,
  configuredRoasterTargets,
  type TargetVerificationFailure,
  targetHttpUrl,
  targetNavigationUrl,
  targetSwitchBlockedReason,
  targetVerificationFailure,
} from './controller/targets'
import { backupExportCompletion, recordingIdsForBackup } from './data/backupExportCompletion'
import {
  BACKUP_TYPE_LABELS,
  BACKUP_TYPES,
  type BackupMissingRecording,
  type BackupRecording,
  type BackupType,
  backupFileName,
  buildBackup,
  collectionsForTypes,
  parseBackup,
} from './data/backupFile'
import { backupLibrary, type ConflictChoice, importChanges, planImport } from './data/backupImport'
import { applyBackupImport, requireWholeBackupForRestore } from './data/backupImportApply'
import { incompleteRestoreMessage, restoreBackup, restoreLeftDocumentsMissing } from './data/backupRestore'
import { defaultCalibration } from './data/calibration'
import { decodeCrkThermalSamples, validateCrkRecording } from './data/crkValidator'
import { crackleData, type DataSyncState } from './data/deviceStore'
import type { CollectionName } from './data/documentSerializer'
import { downloadFile } from './data/download'
import { MANUAL_EVENT_CAP, richSeedEnabled } from './data/repository'
import { collisionsById, mergeById, type ParsedArchive } from './domain/archive'
import { defaultProfileRevisions, defaultProfiles } from './domain/defaultProfiles'
import type { DeviceArchive, DeviceArchiveState, DeviceLogEntry } from './domain/deviceLogs'
import {
  deviceRoastRun,
  deviceRoastSamples,
  duplicateRecordingMerges,
  importableDeviceRoasts,
  orphanedStagedRunNote,
  orphanedStagedRuns,
  reconcileManualArchiveRun,
  reconcileProfiledArchiveRun,
} from './domain/deviceRoastImport'
import {
  executeDeviceRoastStart,
  provisionalDeviceRoastRun,
  provisionalManualRoastRun,
} from './domain/deviceRoastStart'
import { faultNotice } from './domain/faultBanner'
import { newId } from './domain/ids'
import {
  liveBlocksFullStatus,
  liveIndicatesActuation,
  mergeLiveSnapshot,
  statusIndicatesActuation,
} from './domain/liveStatus'
import { liveSampleGap, liveSequenceGap, mergeRecordingPrefix, RecordingResync } from './domain/liveTraceResync'
import { predictedManualLevels, reconcileManualEvent } from './domain/manualControl'
import { manualRoastRunId, mergeDeviceManualEvents, profileFromManualRoast } from './domain/manualRoast'
import { correctedLegacyRunName, effectiveThermalIntent, profileFromRun, resolveRunName } from './domain/model'
import { liveReadoutTarget } from './domain/navigation'
import { orderProfiles } from './domain/profileOrder'
import { profileGoalAt } from './domain/profileSimulation'
import { calibrationRecordingKey, recordedOnFromRoaster, recordingKey, sameRecording } from './domain/provenance'
import { lastRoastedMassG } from './domain/recommendations'
import {
  beanIsDirty,
  LEAVE_WITHOUT_SAVING,
  profileIsDirty,
  summarizeBeanChange,
  summarizeProfileChange,
} from './domain/revisionDiff'
import { type ModelSpecificOperation, resolveActiveRoaster, unsupportedModelReason } from './domain/roasterModel'
import { manualRoastStartArgs, type RoastStartArgs, sanitizeRoastName } from './domain/roastProgram'
import { parseRoute, type Route, routeHash, sameRoute } from './domain/routing'
import { isStatusStale, startBlockedReason } from './domain/startGate'
import { type CascadePlan, cascadeBlockedReason, volumeUsedBytes } from './domain/storage'
import { dedupeRecordings, type StagedField, thermalSamplesToCsv } from './domain/thermalLog'
import type {
  AppView,
  BatchMeasurements,
  BeanLot,
  BeanRevision,
  CalibrationRun,
  CalibrationSettings,
  CalibrationSnapshot,
  ControllerStatus,
  ManualEvent,
  ManualRoastChange,
  Profile,
  ProfileRevision,
  RecordingOrigin,
  RoastRun,
  ThermalCoefficientField,
  TimedProfile,
} from './domain/types'
import { weakWifiNotice } from './domain/wifiSignal'

/** What the backup manifest calls this app. Package metadata is the one release-version authority. */
const APP_VERSION = packageMetadata.version
const COMMAND_STATUS_RECONCILE_DELAY_MS = 1250
// How long one recordings-list read serves hydration requests at an unchanged state revision.
const HYDRATION_ARCHIVE_REUSE_MS = 30_000
const INITIAL_LIVE_STATUS_WAIT_MS = 3500
const LIVE_FALLBACK_AFTER_MS = 8000
/*
 * Waking from a lock or a background tab: a page whose newest live frame is
 * older than this when it becomes visible again replaces its socket and probes `/api/live` at once,
 * rather than waiting out timers that iOS froze. Frames arrive at 1 Hz, so a healthy page is never
 * this old.
 */
const LIVE_RESUME_STALE_MS = 4000
/** A page still without a fresh frame after this long replaces its socket again, at most this often. */
const LIVE_STALE_RECONNECT_MS = 20_000
/** A `/api/live` probe older than this is treated as lost: a suspended request may never settle. */
const LIVE_REFRESH_ABANDON_MS = 8000

const profileDownload = (profiles: Profile[]) =>
  downloadFile(
    `crackle-profiles-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ format: 'crackle-profiles', version: 2, exportedAt: new Date().toISOString(), profiles }, null, 2),
    'application/json',
  )

const disconnectedStatus: ControllerStatus = {
  lifecycle: 'DISCONNECTED',
  connected: false,
  stale: true,
  receivedAtMs: 0,
  firmwareVersion: 'unavailable',
  bootId: 'unknown',
  manualLockout: false,
  thermocoupleValid: false,
  capabilities: {
    apiVersion: 'diagnostic-v0',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
}

export const thermocoupleOffsetBlockedReason = (
  status: ControllerStatus,
  mutationBlockedReason?: string,
): string | undefined => {
  if (mutationBlockedReason) return mutationBlockedReason
  if (!status.connected) return 'The roaster is not connected.'
  if (status.stale) return 'The roaster status is stale. Wait for a current reading before changing this setting.'
  if (status.restoreMaintenance?.active) return 'A restore is in progress. Wait for it to finish.'
  if (status.roast?.active) return 'A roast is running. Change this setting when the roaster is idle.'
  if (status.calibration?.active) return 'Calibration is running. Change this setting after calibration finishes.'
  if (status.manual?.active || status.manualLockout || status.lifecycle === 'MANUAL_LOCKOUT')
    return 'Controls are active. Stop them before changing this setting.'
  if (status.lifecycle === 'RUNNING') return 'The roaster is running. Change this setting when it is idle.'
  return undefined
}

/** Flash writes are deliberately paused while zero-cross timing or a recording owns the volume. */
export const catalogActivityBlockedReason = (status: ControllerStatus): string | undefined => {
  if (status.roast?.active) return 'The roast is still running. Save after it returns to Standby.'
  if (status.calibration?.active) return 'The calibration pass is still running. Save after it returns to Standby.'
  if (status.manual?.active) return 'Manual controls are active. Stop them before saving.'
  if (status.thermalLog?.active && status.thermalLog.unsaved)
    return 'The latest thermal recording is still being finalized. Save becomes available when recording finishes.'
  return undefined
}

/** Expected controller deferrals are working-state feedback, never global storage failures. */
export const expectedDocumentStorageDeferral = (message?: string): boolean => {
  const normalized = message?.toLowerCase() ?? ''
  return (
    normalized.includes('document storage waits until actuation') ||
    normalized.includes('document storage waits for the current thermal recording') ||
    normalized.includes('bulk data waits for the current actuation or recording')
  )
}

/** Background Controls bookkeeping retries quietly; it is not a user-initiated catalog edit. */
export const retryableManualHistoryFailure = (message?: string): boolean => {
  const normalized = message?.toLowerCase() ?? ''
  return (
    expectedDocumentStorageDeferral(message) ||
    normalized.includes('another storage transfer is in progress') ||
    normalized.includes('roaster is busy serving other requests') ||
    normalized.includes('controller storage is already in use') ||
    normalized.includes('connection ended before')
  )
}

/** Preserve the last authoritative archive while a transient list request is retried. */
export const archiveImportDisposition = (state: DeviceArchiveState): 'complete' | 'deferred' =>
  state === 'busy' || state === 'unreachable' ? 'deferred' : 'complete'

/**
 * The timer schedule behind one archive deferral episode.
 *
 * The device persists a finished recording only while idle, and a manual roast's archive write can
 * hold its single storage worker for tens of seconds - during which the list read answers an
 * explicit busy. A short budget that is never replenished (1.5 s + 3 s) sits entirely inside that
 * window, so the post-roast panel would wait forever while History-on-arrival would succeed.
 * The schedule out-waits a realistic persist, every NEW deferral episode starts with the full
 * budget again, and a browser whose post-roast panel is visibly waiting on reconciliation keeps
 * retrying at the final interval instead of stopping - the open panel is the evidence that someone
 * is waiting on exactly this read. Reads only: no mutation is ever admitted on a retry's behalf.
 */
export const ARCHIVE_RETRY_DELAYS_MS = [1500, 3000, 6000, 12000]
export const archiveRetryDelayMs = (retriesSoFar: number, awaitingReconciliation: boolean): number | undefined =>
  retriesSoFar < ARCHIVE_RETRY_DELAYS_MS.length
    ? ARCHIVE_RETRY_DELAYS_MS[retriesSoFar]
    : awaitingReconciliation
      ? ARCHIVE_RETRY_DELAYS_MS[ARCHIVE_RETRY_DELAYS_MS.length - 1]
      : undefined

/** Connectivity/sync notices are obsolete once this browser has current controller-owned data. */
export const obsoleteRecoveredStorageAlert = (message?: string): boolean => {
  const normalized = message?.toLowerCase() ?? ''
  return (
    normalized.includes('wait for the browser to finish syncing the roaster library') ||
    normalized.includes('wait for the roaster library to finish syncing') ||
    normalized.includes('reconnect and wait for its library')
  )
}

/** Routine initial synchronization belongs in the quiet read-only state, not a flashing red alert. */
export const visibleGlobalStorageError = (message?: string): string | undefined =>
  expectedDocumentStorageDeferral(message) || obsoleteRecoveredStorageAlert(message) ? undefined : message
/** Shared fail-closed gate for restore and recovery formatting; catalog health is deliberately absent. */
export const storageReplacementBlockedReason = (
  status: ControllerStatus,
  sync: Pick<DataSyncState, 'queued'>,
): string | undefined => {
  if (!status.connected) return 'The roaster is not answering, so its storage cannot be replaced right now.'
  if (status.stale) return 'Wait for a current roaster status before replacing storage.'
  if (!status.roaster) return 'Wait for the roaster to report its stable device identity before replacing storage.'
  if (status.dataStore === undefined)
    return 'This roaster keeps no library of its own, so there is no storage to replace.'
  if (status.roast?.active) return 'A roast is running. Storage replacement waits until it has stopped.'
  if (status.calibration?.active || status.manual?.active)
    return 'A calibration or manual session is running. Storage replacement waits until it has stopped.'
  if (status.lifecycle === 'RUNNING')
    return 'The roaster is running. Storage replacement waits until everything has stopped.'
  if (sync.queued > 0)
    return `${sync.queued} unsaved change${sync.queued === 1 ? ' is' : 's are'} still waiting to reach the roaster. Storage replacement becomes available after ${sync.queued === 1 ? 'it has' : 'they have'} finished.`
  return undefined
}

const unique = <T,>(values: T[]) => [...new Set(values)].filter((value) => value !== '' && value != null)
const byStartedAt = (runs: RoastRun[]) => [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))

export type LiveContinuityIssue = 'reboot' | 'stalled-or-reorder'

/**
 * A compact live frame is usable when it belongs to this boot and does not move backwards.
 *
 * The device snapshots state frequently while the browser receives a compact 1 Hz feed. Rendering a chart,
 * switching routes, or background-tab throttling may skip any number of intermediate snapshots;
 * the next immutable snapshot is still current authority. A duplicate is ignored as cached transport
 * activity; a changed boot or backward frame requires reconciliation.
 */
export const liveContinuityIssue = (
  previous: Pick<LiveSnapshot, 'bootId' | 'streamSeq'> | undefined,
  next: Pick<LiveSnapshot, 'bootId' | 'streamSeq'>,
): LiveContinuityIssue | undefined => {
  if (!previous?.bootId || previous.streamSeq === undefined || !next.bootId || next.streamSeq === undefined)
    return undefined
  if (previous.bootId !== next.bootId) return 'reboot'
  const delta = (next.streamSeq - previous.streamSeq) >>> 0
  if (delta === 0) return undefined
  if (delta > 0 && delta <= 0x7fff_ffff) return undefined
  return 'stalled-or-reorder'
}

/** Render read-only live work while the full status contract is deliberately deferred. */
export const liveOnlyControllerWorkShellReady = (
  statusChecked: boolean,
  status: ControllerStatus,
  live?: LiveSnapshot,
): boolean => statusChecked && !status.connected && liveBlocksFullStatus(live)

/**
 * Why the catalog screens (Profiles, Beans, History) cannot render yet, or undefined once the
 * library is open. Outside the live-only shell the whole app waits for the library, so the only
 * reachable case is a browser opened while the roaster is running: full status, and with it the
 * library, is deferred until the outputs and recording are idle.
 */
export const libraryPendingReason = (localLibraryReady: boolean, liveOnlyShell: boolean): string | undefined =>
  localLibraryReady
    ? undefined
    : liveOnlyShell
      ? 'A browser opened during a roast reads the roaster library once the roast and its recording finish. The live roast is on the Roast page.'
      : 'Opening the roaster library.'

/**
 * Whether the roast setup still shows the device's last session plan. While a profiled roast runs
 * the device plan is authoritative. After it ends the device keeps reporting that plan until the
 * next Start, so the setup keeps showing it only until the operator chooses a profile (or Roast
 * again) for that ended session; from then on Start runs what was chosen.
 */
export const setupBindsToSessionPlan = (
  sessionActive: boolean,
  sessionId: string | undefined,
  choiceAfterSessionId: string | undefined,
): boolean => sessionActive || sessionId === undefined || choiceAfterSessionId !== sessionId

export interface ManualTraceIdentity {
  bootId: string
  sessionId: string
  logId?: string
}

/** The device tuple that fences an asynchronous active-manual CSV read. */
export const manualTraceIdentity = (status: ControllerStatus): ManualTraceIdentity | undefined => {
  const roast = status.roast
  if (roast?.mode !== 'manual' || !roast.sessionId || (!roast.active && roast.endReason === undefined)) return undefined
  const logId = (status.thermalLog as (ControllerStatus['thermalLog'] & { logId?: string }) | undefined)?.logId
  return { bootId: status.bootId, sessionId: roast.sessionId, ...(logId ? { logId } : {}) }
}

export interface LiveRecordingIdentity {
  kind: 'manual' | 'profiled'
  sessionKey: string
  logId?: string
}

/**
 * The recording a live-stream discontinuity must re-read: an ACTIVE device roast that is being
 * recorded, keyed the way the matching sample buffer is keyed. Nothing else is worth a resync -
 * the join-time hydration handles a session's first read and the archive edge handles its last.
 */
export const liveRecordingIdentity = (status: ControllerStatus): LiveRecordingIdentity | undefined => {
  const roast = status.roast
  if (roast?.active !== true || status.thermalLog?.source !== 'roast') return undefined
  const manual = manualTraceIdentity(status)
  if (manual)
    return {
      kind: 'manual',
      sessionKey: manualTraceSessionKey(manual),
      ...(manual.logId ? { logId: manual.logId } : {}),
    }
  const profiled = profiledTraceSessionKey(status)
  if (!profiled) return undefined
  const logId = (status.thermalLog as (ControllerStatus['thermalLog'] & { logId?: string }) | undefined)?.logId
  return { kind: 'profiled', sessionKey: profiled, ...(logId ? { logId } : {}) }
}

export interface LiveTraceSources {
  /** The roaster's roast block, as merged from the live stream. */
  deviceRoast?: Pick<NonNullable<ControllerStatus['roast']>, 'active' | 'mode'>
  /** The session record this browser holds, if any. */
  activeSession?: Pick<RoastRun, 'manualRoast' | 'outcome' | 'samples'>
  /** The device-keyed live buffers, and whether each is keyed to the roast the roaster reports now. */
  profiled: RoastRun['samples']
  profiledCurrent: boolean
  manual: RoastRun['samples']
  manualCurrent: boolean
}

/**
 * Which samples the Roast page draws.
 *
 * While the roaster is EXECUTING a roast, the chart is that roast and nothing else: only the
 * device-keyed buffer for its session may draw, whatever record this browser happens to hold.
 * Otherwise a mid-roast refresh can show a remnant image of the previous roast: a reload whose
 * first live poll misses the status window initializes the library (online, or from the offline
 * mirror) and restores a retained 'running' record as the active session, and that manual session
 * record's samples would stand in for the live journey for the rest of the roast.
 *
 * Once the roaster is idle, the record is the roast: a completed session's archived samples - the
 * whole recording, cooling tail included - beat the display-only live buffer, and a running
 * browser session draws its own buffer as before.
 */
export const selectLiveTrace = ({
  deviceRoast,
  activeSession,
  profiled,
  profiledCurrent,
  manual,
  manualCurrent,
}: LiveTraceSources): RoastRun['samples'] => {
  if (deviceRoast?.active === true && deviceRoast.mode !== 'none') {
    if (deviceRoast.mode === 'manual') return manualCurrent ? manual : []
    return profiledCurrent ? profiled : []
  }
  if (activeSession?.manualRoast) return activeSession.outcome === 'running' ? manual : activeSession.samples
  if (activeSession && activeSession.outcome !== 'running' && activeSession.samples.length > 0)
    return activeSession.samples
  if (profiledCurrent && profiled.length > 0) return profiled
  if (!activeSession && manualCurrent && manual.length > 0) return manual
  return activeSession?.samples ?? []
}

export const unsettledRoastRecordingId = (status: ControllerStatus): string | undefined => {
  const thermal = status.thermalLog as (ControllerStatus['thermalLog'] & { logId?: string }) | undefined
  if (thermal?.source !== 'roast' || (!thermal.active && !thermal.unsaved)) return undefined
  return thermal.logId
}

/**
 * The browser-side "pending setup" stash is retired: a device-executed roast's setup fields
 * (starting volume, ambient, bean selection) are staged in the ROASTER's document store as a
 * complete run record before Start fires, so every browser sees the whole record from the moment
 * the roast begins. This only clears the abandoned key left by older builds.
 */
export const purgeLegacyPendingRoastSetup = () => {
  try {
    globalThis.localStorage?.removeItem('crackle:pending-roast-setup')
  } catch {
    /* cosmetic cleanup only */
  }
}

/**
 * Why the expanded History record for this run may not render yet (all-or-nothing rendering:
 * no view shows partial data while loading). A run staged at Start - or a stopped manual roast
 * whose recording has not reconciled - is an incomplete record by construction: its curve,
 * outcome, and header facts arrive with the device recording. Until reconciliation settles, the
 * expanded record is an explicit loading state carrying the reason, in the app's worded-gate
 * idiom. Settled records - including legacy browser-only roasts with nothing pending - render
 * in full immediately.
 */
export const historyDetailPendingReason = (
  run: RoastRun,
  status: ControllerStatus,
  archiveListDeferred = false,
): string | undefined => {
  const awaitingManualRecording =
    run.manualRoast !== undefined &&
    run.manualRoast.incomplete === true &&
    run.manualRoast.pendingRecording !== undefined &&
    !run.manualRoast.logId
  if (run.outcome !== 'running' && !awaitingManualRecording) return undefined
  if (status.roaster && run.recordedOn.deviceId !== status.roaster.deviceId) {
    return 'This roast ran on a different roaster. Connect that roaster so Crackle can finish this record from its recording.'
  }
  const sameRoast =
    status.roast?.name === undefined || sanitizeRoastName(status.roast.name) === sanitizeRoastName(run.name)
  if (run.outcome === 'running' && status.roast?.active === true && sameRoast) {
    return 'The roast is still running on the roaster. The complete record arrives when it finishes.'
  }
  const thermal = status.thermalLog
  if (thermal?.source === 'roast' && (thermal.active === true || thermal.unsaved === true)) {
    return "The roaster is finishing and saving this roast's recording."
  }
  if (!status.connected || status.stale) {
    return 'Reconnect to the roaster so Crackle can reconcile the finished recording into this record.'
  }
  if (archiveListDeferred) {
    return 'The roaster is still writing the recording to its storage. Crackle is retrying automatically.'
  }
  return "Waiting for the roaster's finished recording to be reconciled into this record. If it never arrives, the recording was lost and this record can be deleted."
}

export interface ManualRecordingFinalization {
  phase: 'waiting' | 'finishing' | 'saving' | 'reconciling'
  detail: string
}

/**
 * Explain the authoritative post-Stop recording phase without claiming the roast is reusable early.
 *
 * `archiveListDeferred` is whether the latest archive list read was explicitly deferred by a busy
 * roaster: the reconciling banner then says what is actually happening - the roaster is still
 * writing the recording to its storage - and that Crackle keeps retrying by itself, instead of a
 * vague busy notice that reads like the operator must do something.
 */
export const manualRecordingFinalization = (
  run: RoastRun | undefined,
  status: ControllerStatus,
  archiveListDeferred = false,
): ManualRecordingFinalization | undefined => {
  if (!run?.manualRoast || run.outcome === 'running' || (!run.manualRoast.incomplete && run.manualRoast.logId))
    return undefined
  if (!status.connected || status.stale)
    return {
      phase: 'waiting',
      detail: 'Reconnect to the roaster for a current reading before Crackle verifies and imports this recording.',
    }
  const thermal = status.thermalLog
  if (thermal?.source === 'roast' && thermal.active)
    return {
      phase: 'finishing',
      detail: 'Heat is off. The roaster is finishing this recording.',
    }
  if (thermal?.source === 'roast' && thermal.unsaved)
    return {
      phase: 'saving',
      detail: 'The roaster is saving and verifying the recording.',
    }
  if (thermal?.source === 'roast' && thermal.active === false && thermal.unsaved === false)
    return {
      phase: 'reconciling',
      detail: archiveListDeferred
        ? 'The roaster is still saving the recording to its storage. Crackle is retrying automatically - no need to leave this page.'
        : 'The roaster has finished the recording. Crackle is importing it into History automatically; details can be saved the moment it arrives.',
    }
  return {
    phase: 'waiting',
    detail:
      'Waiting for the roaster to report the final recording state before Crackle reconciles it into History. Crackle keeps checking automatically.',
  }
}
/** The sample buffer may render only for the same device boot and roast session that filled it. */
export const profiledTraceSessionKey = (status: ControllerStatus): string | undefined => {
  const roast = status.roast
  if (
    !roast?.sessionId ||
    roast.mode === 'manual' ||
    roast.mode === 'none' ||
    (!roast.active && roast.endReason === undefined)
  )
    return undefined
  return `${status.bootId}:${roast.sessionId}`
}
export const manualTraceSessionKey = (identity: ManualTraceIdentity) => `${identity.bootId}:${identity.sessionId}`
export const manualTraceRequestKey = (identity: ManualTraceIdentity) =>
  `${manualTraceSessionKey(identity)}:${identity.logId ?? 'ram'}`

/**
 * Device samples win duplicate seconds; newer browser-only seconds remain until the next fetch.
 * One merge law for every trace - manual and profiled, join-time hydration and mid-roast resync.
 */
export const mergeManualTrace = mergeRecordingPrefix

/** The active plan is authoritative only as an exact identity tuple, never by partial/wildcard match. */
export const activePlanMatchesController = (plan: ActiveRoastPlan | undefined, status: ControllerStatus): boolean =>
  Boolean(
    plan &&
      status.roast?.sessionId &&
      status.roast.planRev !== undefined &&
      plan.bootId === status.bootId &&
      plan.sessionId === status.roast.sessionId &&
      plan.planRev === status.roast.planRev,
  )

const recoveryRequiresActivePlan = (status: ControllerStatus): boolean => {
  const roast = status.roast
  return Boolean(
    roast &&
      roast.mode !== 'manual' &&
      roast.mode !== 'none' &&
      roast.sessionId &&
      roast.planRev !== undefined &&
      (roast.active || roast.endReason !== undefined),
  )
}

/**
 * Live actuation is safe again once fresh connected status and any controller-owned plan agree.
 * Catalog reconciliation has its own mutation gate and must not strand Stop or actuator controls.
 */
export const telemetryRecoveryAllowsControls = (
  status: ControllerStatus,
  recoveredPlan: ActiveRoastPlan | undefined,
): boolean =>
  status.connected && (!recoveryRequiresActivePlan(status) || activePlanMatchesController(recoveredPlan, status))

export interface AcceptedPlanBridge {
  plan: ActiveRoastPlan
  previousPlanRev: number
  acceptedAtMs: number
}

export interface ActivePlanDisplay {
  plan?: ActiveRoastPlan
  reconciling: boolean
}

const nextPlanRevision = (revision: number): number => (revision >= 0xffffffff ? 1 : revision + 1)

/**
 * PATCH returned the roaster's accepted successor before the next status frame arrived. That exact
 * one-revision bridge may be displayed read-only; it is never permission to submit another edit.
 */
export const resolveActivePlanDisplay = (
  plan: ActiveRoastPlan | undefined,
  status: ControllerStatus,
  bridge: AcceptedPlanBridge | undefined,
  nowMs = Date.now(),
): ActivePlanDisplay => {
  if (activePlanMatchesController(plan, status)) return { plan, reconciling: false }
  const roast = status.roast
  const bridged =
    plan &&
    bridge?.plan === plan &&
    roast?.sessionId &&
    roast.planRev !== undefined &&
    nowMs - bridge.acceptedAtMs <= 10_000 &&
    plan.bootId === status.bootId &&
    plan.sessionId === roast.sessionId &&
    roast.planRev === bridge.previousPlanRev &&
    plan.planRev === nextPlanRevision(bridge.previousPlanRev)
  return bridged ? { plan, reconciling: true } : { reconciling: false }
}

const activePlanDecisionPrefix = (plan: ActiveRoastPlan) =>
  `__active-plan-decision__:${plan.bootId ?? 'missing'}:${plan.sessionId ?? 'missing'}:${plan.planRev ?? 'missing'}:`
/**
 * The unsaved-work guard is about LEAVING A VIEW: only a change of view can unmount the editor
 * holding work that exists nowhere but this tab. Moving within one view (`#/history/run-A` to
 * `#/history`) neither asks nor forgets that the editor is dirty - clearing the flag there would
 * let the NEXT real navigation discard the work silently.
 */
export const navigationNeedsConfirm = (fromView: string, toView: string, unsaved: boolean): boolean =>
  unsaved && fromView !== toView
export const navigationClearsDirty = (fromView: string, toView: string): boolean => fromView !== toView

export const activePlanDecisionKey = (plan: ActiveRoastPlan, decision: 'saved' | 'discarded') =>
  `${activePlanDecisionPrefix(plan)}${decision}`

/** A non-catalog planning shell used only to open Manual setup when the controller has no profiles. */
const EMPTY_LIBRARY_MANUAL_PROFILE: TimedProfile = {
  id: 'manual-empty-library',
  name: 'Manual roast',
  revision: 0,
  strategy: 'timed',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
  metadata: { intent: 'Manual roast' },
  notes: '',
  points: [{ id: 'manual-empty-start', timeSec: 0, fan: 4, heat: 0 }],
  coolFan: 9,
  coolDurationSec: 90,
}

export default function App() {
  const browserOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  const browserSearch = typeof window === 'undefined' ? '' : window.location.search
  const roasterTargets = useMemo(
    () => configuredRoasterTargets(import.meta.env.DEV && import.meta.env.MODE === 'development', browserOrigin),
    [browserOrigin],
  )
  const configuredTarget = useMemo(
    () => activeConfiguredTarget(roasterTargets, browserSearch),
    [browserSearch, roasterTargets],
  )
  const controllerRef = useRef<HttpControllerClient | null>(null)
  if (!controllerRef.current) controllerRef.current = new HttpControllerClient(configuredTarget)
  const [targetSwitching, setTargetSwitching] = useState(false)
  const [targetSwitchFailure, setTargetSwitchFailure] = useState<TargetVerificationFailure & { targetId: string }>()
  const telemetryDegradedRef = useRef(false)
  // Transport commands and catalog documents have different convergence needs.
  // A safe actuator instruction needs fresh device identity, not a finished manifest reload.
  const controllerMutationReasonRef = useRef<string | undefined>('The roaster has not been verified yet.')
  const controllerModelReasonRef = useRef<(operation: ModelSpecificOperation) => string | undefined>(
    () => 'The roaster has not reported its model yet.',
  )
  const catalogMutationReasonRef = useRef<string | undefined>('The roaster library has not been verified yet.')
  useEffect(() => {
    setControllerMutationGate(() => controllerMutationReasonRef.current)
    setControllerModelGate((operation) => controllerModelReasonRef.current(operation))
    return () => {
      setControllerMutationGate(undefined)
      setControllerModelGate(undefined)
    }
  }, [])
  /**
   * Which screen is open, and the History deep link if there is one, held as ONE value because
   * they are one address. See `domain/routing.ts` for why that address is a fragment. The initial
   * read is from the URL, so a pasted or reloaded deep link opens where it says rather than at the
   * Roast page with the link silently discarded.
   */
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  const view = route.view
  const focusRunId = route.runId
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [beans, setBeans] = useState<BeanLot[]>([])
  const [runs, setRuns] = useState<RoastRun[]>([])
  const [selectedRoastId, setSelectedRoastId] = useState('')
  const [selectedEditorId, setSelectedEditorId] = useState('')
  const [selectedBeanId, setSelectedBeanId] = useState<string>()
  const [overlayId, setOverlayId] = useState<string>()
  const [activeRunId, setActiveRunId] = useState<string>()
  const [manualMode, setManualMode] = useState(false)
  /** The ended device session for which the operator has since chosen what to roast next. */
  const [setupChoiceAfterSession, setSetupChoiceAfterSession] = useState<string>()
  const [manualBusy, setManualBusy] = useState(false)
  // Stop is a safety-direction command, so an Apply already in flight must not
  // withhold it. Only a second Stop waits on this state.
  const [manualStopBusy, setManualStopBusy] = useState(false)
  const [manualMessage, setManualMessage] = useState('')
  const [manualError, setManualError] = useState('')
  const [manualProfileDraftName, setManualProfileDraftName] = useState('')
  const [manualLiveSamples, setManualLiveSamples] = useState<RoastRun['samples']>([])
  const manualSampleSessionRef = useRef('')
  const manualHydrationRequestRef = useRef('')
  /** The bounded mid-roast recording re-read; see `domain/liveTraceResync.ts`. */
  const liveResyncRef = useRef<RecordingResync>()
  /** The last sample either collector accepted, so a hole in the roaster's clock is visible at once. */
  const lastCollectedSampleRef = useRef<{ sessionKey: string; elapsedSec: number }>()
  // Accepted manual instructions observed from the roaster's commanded levels, one entry per
  // change. Browser-ephemeral presentation: session documents journal only this browser's own
  // acknowledged Applies, and the meta-document Controls history cannot sync while the firmware's
  // flash-write idle gate holds, so live status is the one cross-browser record during the roast.
  const [deviceManualEvents, setDeviceManualEvents] = useState<RoastRun['events']>([])
  const deviceManualLevelsRef = useRef<{ sessionKey: string; fan: number; heat: number }>()
  const [manualObservedActiveRunId, setManualObservedActiveRunId] = useState<string>()
  const [pendingRevision, setPendingRevision] = useState<RoastRun>()
  const [repeatRoastSetup, setRepeatRoastSetup] = useState<{
    sourceRunId: string
    profile: Profile
    measurements: BatchMeasurements
  }>()
  const [pendingCalibrationRoastId, setPendingCalibrationRoastId] = useState<string>()
  const [calibration, setCalibration] = useState<CalibrationSettings>(defaultCalibration)
  const [calibrationRuns, setCalibrationRuns] = useState<CalibrationRun[]>([])
  const [calibrationSnapshots, setCalibrationSnapshots] = useState<CalibrationSnapshot[]>([])
  const [manualEvents, setManualEvents] = useState<ManualEvent[]>([])
  // Controls history is a volatile working edit while flash is locked. It may be
  // committed only after the device reports the actuator idle.
  const pendingManualEventsRef = useRef<Map<string, ManualEvent>>(new Map())
  const pendingManualEventsClearRef = useRef(false)
  const flushingManualEventsRef = useRef(false)
  const manualHistoryRetryTimerRef = useRef<number>()
  const manualHistoryRetryDelayRef = useRef(1250)
  const [manualHistoryFlushNonce, setManualHistoryFlushNonce] = useState(0)
  const [manualHistorySaveError, setManualHistorySaveError] = useState<string>()
  const [profileRevisions, setProfileRevisions] = useState<ProfileRevision[]>([])
  const [beanRevisions, setBeanRevisions] = useState<BeanRevision[]>([])
  // Which open editor is holding unsaved work. Reported by the editors themselves, because only
  // they know whether the draft in front of the user still matches what is stored.
  const [profileDirty, setProfileDirty] = useState(false)
  const [beanDirty, setBeanDirty] = useState(false)
  const [roastDetailsDirty, setRoastDetailsDirty] = useState(false)
  const [manualPlanDirty, setManualPlanDirty] = useState(false)
  const [historyDirty, setHistoryDirty] = useState(false)
  const [status, setStatus] = useState<ControllerStatus>(disconnectedStatus)
  const [live, setLive] = useState<LiveSnapshot>()
  const [activeRoastPlan, setActiveRoastPlan] = useState<ActiveRoastPlan>()
  const [acceptedPlanBridge, setAcceptedPlanBridge] = useState<AcceptedPlanBridge>()
  const [activeRoastPlanLoading, setActiveRoastPlanLoading] = useState(false)
  const [activeRoastPlanError, setActiveRoastPlanError] = useState<string>()
  const [handledActivePlanEditsKey, setHandledActivePlanEditsKey] = useState<string>()
  const [savingActivePlanRevision, setSavingActivePlanRevision] = useState(false)
  const [profiledLiveSamples, setProfiledLiveSamples] = useState<RoastRun['samples']>([])
  const [profiledHistoryNotice, setProfiledHistoryNotice] = useState<string>()
  const [telemetryDegraded, setTelemetryDegraded] = useState(false)
  const profiledSampleSessionRef = useRef('')
  const profiledHydrationSessionRef = useRef('')
  const previousLiveFrameRef = useRef<Pick<LiveSnapshot, 'bootId' | 'streamSeq'>>()
  const continuityRecoveryRef = useRef<Promise<void>>()
  const completedStatusRevisionRef = useRef<string>()
  const [nowMs, setNowMs] = useState(() => Date.now())
  // Full status owns capabilities and durable metadata; accepted compact telemetry owns freshness.
  // Duplicate/reordered frames never reach this merge, so they cannot extend mutation authority.
  const liveStatus = useMemo<ControllerStatus>(() => {
    const merged = mergeLiveSnapshot(status, live)
    return { ...merged, stale: isStatusStale(merged, nowMs) }
  }, [live, nowMs, status])
  const liveStatusRef = useRef(liveStatus)
  liveStatusRef.current = liveStatus
  const [localLibraryReady, setLocalLibraryReady] = useState(false)
  const libraryInitializationStartedRef = useRef(false)
  const [statusChecked, setStatusChecked] = useState(false)
  const [deviceLibraryReady, setDeviceLibraryReady] = useState(false)
  /** A configured-target identity or attach failure leaves any prior cache visible but read-only. */
  const [deviceAttachFailure, setDeviceAttachFailure] = useState<string>()
  // A cold refresh may safely render compact controller-owned work before full status. Controller
  // and catalog mutation gates use accepted merged live freshness until same-boot idle.
  const liveOnlyControllerWorkReady = liveOnlyControllerWorkShellReady(statusChecked, status, live)
  const ready =
    liveOnlyControllerWorkReady ||
    (localLibraryReady && statusChecked && (status.dataStore === undefined || deviceLibraryReady))
  const catalogPendingReason = libraryPendingReason(localLibraryReady, liveOnlyControllerWorkReady)
  const [storageError, setStorageError] = useState<string>()
  const [, setStorageRevision] = useState(0)
  const [liveConnection, setLiveConnection] = useState<'websocket' | 'fallback'>('fallback')

  /*
   * Which recordings the controller is currently holding, from the last reconciliation - the whole
   * entries rather than only their ids, because the Storage panel weighs them, the cascade plan
   * costs them, and the pre-roast retention warning names and dates them. This is also what makes
   * "imported - remove from controller" appear for a copy that actually still exists.
   */
  const [deviceLogs, setDeviceLogs] = useState<DeviceLogEntry[]>([])
  /**
   * Whether this browser has completed at least one authoritative archive list for the connected
   * roaster. Until it has, surfaces that render or weigh recordings (Settings storage, cascade
   * impact) show an explicit loading state instead of an empty archive that later mutates
   * (all-or-nothing rendering).
   */
  const [deviceArchiveListed, setDeviceArchiveListed] = useState(false)
  const deviceArchiveListedRef = useRef(deviceArchiveListed)
  deviceArchiveListedRef.current = deviceArchiveListed
  const [backupConflictPrompt, setBackupConflictPrompt] = useState<{
    count: number
    names: string[]
    resolve: (decision: BackupConflictDecision) => void
  }>()
  /** The shared ledger of recordings this library has taken in, read out of the `meta` document. */
  const [importedLogIds, setImportedLogIds] = useState<string[]>([])
  const [statusNonce, setStatusNonce] = useState(0)
  const [dataSync, setDataSync] = useState<DataSyncState>(() => crackleData.syncState())
  const activeRoasterModel = resolveActiveRoaster(liveStatus.roaster)
  const modelBlockedReason = (operation: ModelSpecificOperation) =>
    unsupportedModelReason(activeRoasterModel, operation)
  controllerModelReasonRef.current = modelBlockedReason
  const mutationBlockedReason =
    deviceAttachFailure ??
    (!localLibraryReady
      ? 'Wait for the browser to finish opening and verifying the roaster library before making changes.'
      : telemetryDegraded
        ? 'Live telemetry continuity was interrupted. Wait for the roaster to be reconciled before making changes.'
        : !liveStatus.connected
          ? 'The roaster is not connected. Reconnect and wait for its library before making changes.'
          : isStatusStale(liveStatus, nowMs)
            ? 'The roaster status is stale. Wait for a current reading before making changes.'
            : (crackleData.visibleMutationBlockedReason() ?? catalogActivityBlockedReason(liveStatus)))
  const actuatorMutationBlockedReason =
    deviceAttachFailure ??
    (telemetryDegraded
      ? 'Live telemetry continuity was interrupted. Wait for current roaster status before changing outputs.'
      : !statusChecked
        ? 'Waiting for current roaster status before changing outputs.'
        : !liveStatus.connected
          ? 'The roaster is not connected.'
          : isStatusStale(liveStatus, nowMs)
            ? 'The roaster status is stale. Wait for a current reading before changing outputs.'
            : liveStatus.restoreMaintenance?.active || liveStatus.restoreMaintenance?.incomplete
              ? 'Storage maintenance is unfinished. Complete it in Settings before changing outputs.'
              : undefined)
  controllerMutationReasonRef.current = actuatorMutationBlockedReason
  catalogMutationReasonRef.current = mutationBlockedReason
  /**
   * A live manual session may temporarily be a browser working edit when the controller accepts
   * heat/fan control but refuses its run document (for example, a full library). Keep exactly that
   * one explicit draft visible; every committed library row still comes from the controller.
   */
  const manualWorkingRunRef = useRef<RoastRun>()
  const importingRef = useRef(false)
  const [recordingImportInFlight, setRecordingImportInFlight] = useState(false)

  const clearObsoleteActuationStorageAlert = () => {
    setStorageError((current) => (expectedDocumentStorageDeferral(current) ? undefined : current))
  }

  const persist = (operation: Promise<unknown>) => {
    void operation.then(
      () => setStorageRevision((value) => value + 1),
      (error) => setStorageError(error instanceof Error ? error.message : 'A local data change could not be saved'),
    )
  }

  /**
   * Pull the whole library out of the data layer into render state.
   *
   * Called once at boot and again whenever the data layer says its copy changed - which now includes
   * "the controller answered and it disagreed with this browser". Selections are deliberately NOT
   * touched here: a sync landing while the user is looking at a profile must not move them.
   */
  const reloadFromStore = useCallback(async () => {
    const [
      storedProfiles,
      storedBeans,
      storedRuns,
      storedCalibration,
      storedCalibrationRuns,
      storedSnapshots,
      storedManualEvents,
      storedProfileRevisions,
      storedBeanRevisions,
      storedImported,
    ] = await Promise.all([
      crackleData.profiles(),
      crackleData.beans(),
      crackleData.runs(),
      crackleData.calibration(),
      crackleData.calibrationRuns(),
      crackleData.calibrationSnapshots(),
      crackleData.manualEvents(),
      crackleData.profileRevisions(),
      crackleData.beanRevisions(),
      crackleData.importedDeviceLogIds(),
    ])
    setImportedLogIds([...storedImported])
    const workingManual = manualWorkingRunRef.current
    const visibleRuns = workingManual
      ? [workingManual, ...storedRuns.filter((run) => run.id !== workingManual.id)]
      : storedRuns
    const sortedRuns = byStartedAt(visibleRuns)
    setProfiles(storedProfiles)
    setBeans(storedBeans)
    setRuns(sortedRuns)
    setCalibration(storedCalibration ?? defaultCalibration)
    /*
     * Byte-identical copies of one recording are collapsed AS THEY ARE READ.
     *
     * Earlier builds could bring the same stored recording in over and over, so a browser that ran
     * one may hold several rows that are one recording. Calibrate refuses to make more of them, but
     * nothing it can do removes the ones already there - and left alone they are
     * rows to scroll past, ticks that change nothing, and duplicate votes in the pooled surface. So
     * they are dropped on the way in, oldest copy kept because that is the one a saved calibration
     * may already name by id, and the next write of the calibrations document makes it permanent.
     */
    setCalibrationRuns(dedupeRecordings(storedCalibrationRuns))
    setCalibrationSnapshots(storedSnapshots)
    setManualEvents(storedManualEvents)
    setProfileRevisions(storedProfileRevisions)
    setBeanRevisions(storedBeanRevisions)
    return { profiles: storedProfiles, beans: storedBeans, runs: sortedRuns }
  }, [])

  useEffect(() => {
    if (!statusChecked || libraryInitializationStartedRef.current) return
    // A live-only active snapshot is not proof that the disconnected default HTTP
    // status is an offline controller. Wait for the deferred authoritative status.
    if (!status.connected && liveStatus.connected) return
    if (status.connected && !status.roaster) return
    libraryInitializationStartedRef.current = true
    void (async () => {
      try {
        if (status.connected) {
          try {
            await crackleData.bindObservedDevice(status.roaster!.deviceId)
            setDeviceAttachFailure(undefined)
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'The configured roaster identity could not be verified'
            setDeviceAttachFailure(message)
            throw error
          }
        } else if (!(await crackleData.observedDeviceBinding())) {
          setLocalLibraryReady(true)
          return
        }
        const warnings = await crackleData.initialize()
        const loaded = await reloadFromStore()
        // A record staged at Start belongs to the ROASTER's execution, not to a browser session:
        // while the roast runs, the manual join effect adopts it with current device identity, and
        // afterwards the archive reconciliation completes it. Adopting it here would present a
        // sessionless record as a steerable session.
        let restoredRun = loaded.runs.find((run) => run.outcome === 'running' && run.deviceRoastPending === undefined)
        if (restoredRun?.manualRoast && !restoredRun.manualRoast.incomplete) {
          // A persisted running run means this page was absent for some interval. Another browser
          // may have issued accepted changes during that gap, so the local requested path is no
          // longer provably complete until the controller recording reconciles it.
          const manualRoast = { ...restoredRun.manualRoast, incomplete: true }
          restoredRun = { ...restoredRun, manualRoast }
          setRuns((current) => current.map((run) => (run.id === restoredRun!.id ? restoredRun! : run)))
          await crackleData.updateRun(restoredRun.id, { manualRoast })
        }
        setSelectedRoastId(restoredRun?.profile.id ?? loaded.profiles[0]?.id ?? '')
        setSelectedEditorId(loaded.profiles[0]?.id ?? '')
        setSelectedBeanId(restoredRun?.beanLotId ?? loaded.beans[0]?.id)
        setActiveRunId(restoredRun?.id)
        setManualMode(restoredRun?.manualRoast !== undefined || loaded.profiles.length === 0)
        setManualLiveSamples(restoredRun?.manualRoast ? restoredRun.samples : [])
        if (warnings.length > 0) setStorageError(warnings[0])
        setLocalLibraryReady(true)
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : 'Crackle could not open local storage')
      }
    })()
  }, [liveStatus.connected, reloadFromStore, status.connected, status.roaster?.deviceId, statusChecked])

  // The data layer announces every reconciliation, every queue drain and every mode change.
  useEffect(
    () =>
      crackleData.subscribe(() => {
        const sync = crackleData.syncState()
        setDataSync(sync)
        // A zero-length queue does not prove the active working roast was accepted:
        // revisioned writes fail closed instead of queueing while outputs are active.
        // The archive importer clears this overlay only after the matching device recording is durable.
        void reloadFromStore()
      }),
    [reloadFromStore],
  )

  /**
   * The live trace is the roaster's recording. Whenever this browser has provably missed part of the
   * stream for the SAME session - a locked phone, a dropped socket, a hole in the frame
   * sequence, a jump in the roaster's clock between accepted samples - the recorded prefix is read
   * back and merged in by roaster second. The join-time hydration effects below are keyed to the
   * session and so run once; this is what runs again. The identity is re-read on both sides of the
   * await, so a read that outlives its roast merges into nothing.
   */
  useEffect(() => {
    const resync = new RecordingResync({
      // Consecutive discontinuities compound the re-read spacing only within one roast session.
      session: () => {
        const identity = liveRecordingIdentity(liveStatusRef.current)
        return identity ? `${identity.kind}:${identity.sessionKey}` : undefined
      },
      read: async () => {
        const identity = liveRecordingIdentity(liveStatusRef.current)
        if (!identity) return undefined
        const controller = controllerRef.current!
        let hydrated: RoastRun['samples'] = []
        if (identity.logId) {
          try {
            hydrated = deviceRoastSamples(await controller.fetchDeviceLogCsv(identity.logId))
          } catch {
            /* the reserved log may still be RAM-only */
          }
        }
        if (hydrated.length === 0) hydrated = deviceRoastSamples(await controller.fetchThermalCsv())
        const current = liveRecordingIdentity(liveStatusRef.current)
        if (!current || current.kind !== identity.kind || current.sessionKey !== identity.sessionKey) return undefined
        return hydrated
      },
      apply: (hydrated) => {
        const identity = liveRecordingIdentity(liveStatusRef.current)
        if (!identity) return
        if (identity.kind === 'manual') {
          if (manualSampleSessionRef.current !== identity.sessionKey) return
          setManualLiveSamples((current) => mergeRecordingPrefix(hydrated, current))
          return
        }
        if (profiledSampleSessionRef.current !== identity.sessionKey) return
        setProfiledLiveSamples((current) => mergeRecordingPrefix(hydrated, current))
      },
    })
    liveResyncRef.current = resync
    // The phone-lock case: the tab was suspended, so no socket event and no frame can say so first.
    const resume = () => {
      if (document.visibilityState !== 'hidden') resync.request('page-resume')
    }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('pageshow', resume)
    return () => {
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('pageshow', resume)
      resync.dispose()
      if (liveResyncRef.current === resync) liveResyncRef.current = undefined
    }
  }, [])

  /**
   * Full status is read on attach and coalesced idle revision edges; compact live values stream
   * continuously with a bounded HTTP fallback. A connected WebSocket already carries every
   * actuation-active bit, so its active interval defers the large synchronous
   * status response and reconciles once on the idle edge.
   */
  useEffect(() => {
    const controller = controllerRef.current!
    let disposed = false
    let streamConnected = false
    let streamEverConnected = false
    let streamGeneration = 0
    let latestLive: LiveSnapshot | undefined
    let deferredStatusRefresh = false
    let refreshAfterStreamConnect = false
    let initialStatusPending = true
    let initialStatusTimer: number | undefined
    let statusRefreshInFlight = false
    // When the in-flight `/api/live` probe started (0 = none). A timestamp rather than a flag: a request
    // issued just before the phone locked may never settle, and must not block every later probe.
    let liveRefreshStartedAt = 0
    // Starts at page load, so the stale re-kick never preempts the first connection attempt.
    let lastStreamKickAt = Date.now()

    const recoverContinuity = (preserveLive = false) => {
      if (continuityRecoveryRef.current) return continuityRecoveryRef.current
      telemetryDegradedRef.current = true
      setTelemetryDegraded(true)
      if (!preserveLive) setLive(undefined)
      // A sequence gap is never permission to run the large synchronous handler while outputs may
      // still be active. Compact same-boot idle evidence will call recovery again after releasing
      // the controller-owned transport latch.
      if (controller.fullStatusDeferred()) {
        deferredStatusRefresh = true
        return Promise.resolve()
      }
      const recovery = (async () => {
        const nextStatus = await controller.status()
        if (disposed) return
        setStatus(nextStatus)
        if (nextStatus.connected) completedStatusRevisionRef.current = nextStatus.stateRev
        crackleData.observeStatus(nextStatus)
        setStatusChecked(true)
        setNowMs(Date.now())
        const planRequired = recoveryRequiresActivePlan(nextStatus)
        let recoveredPlan: ActiveRoastPlan | undefined
        if (planRequired) {
          try {
            const candidate = await controller.fetchActiveRoastPlan()
            if (activePlanMatchesController(candidate, nextStatus)) recoveredPlan = candidate
            else setActiveRoastPlanError('The roaster plan changed while live telemetry was being reconciled.')
          } catch (error) {
            setActiveRoastPlanError(error instanceof Error ? error.message : 'The roast plan could not be reconciled')
          }
        }
        if (disposed) return
        if (telemetryRecoveryAllowsControls(nextStatus, recoveredPlan)) {
          if (recoveredPlan) {
            setActiveRoastPlan(recoveredPlan)
            setActiveRoastPlanError(undefined)
          }
          previousLiveFrameRef.current = undefined
          telemetryDegradedRef.current = false
          setTelemetryDegraded(false)
        }
        if (nextStatus.dataStore?.mounted) await crackleData.refresh()
        if (disposed) return
        setDataSync(crackleData.syncState())
      })()
        .catch((error: unknown) => {
          // Fire-and-forget callers (`void recoverContinuity(...)`) must not leak a rejection: the
          // library refresh failure is shown as a storage error; telemetry recovery retries on the next frame.
          if (disposed) return
          setStorageError(
            error instanceof Error && error.message
              ? error.message
              : 'The roaster library could not be refreshed after live telemetry recovered.',
          )
          setDataSync(crackleData.syncState())
        })
        .finally(() => {
          continuityRecoveryRef.current = undefined
        })
      continuityRecoveryRef.current = recovery
      return recovery
    }

    const acceptLive = (next: LiveSnapshot) => {
      if (disposed) return
      const wasStatusUnsafe = liveBlocksFullStatus(latestLive)
      const previousFrame = previousLiveFrameRef.current
      const duplicate =
        next.connected &&
        previousFrame !== undefined &&
        previousFrame.bootId === next.bootId &&
        previousFrame.streamSeq !== undefined &&
        previousFrame.streamSeq === next.streamSeq
      // A repeated cached snapshot proves transport life, not fresh device state.
      // Do not refresh readings, library currency, or mutation authority from it.
      if (duplicate) return
      // Transport loss is absence of evidence, never idle evidence. Retain the last connected frame
      // until another connected compact snapshot replaces it.
      if (next.connected) latestLive = next
      if (next.connected) {
        const continuity = liveContinuityIssue(previousLiveFrameRef.current, next)
        // A forward hole is not a continuity fault - the next snapshot is still authoritative - but
        // it is missed telemetry, and the roaster's recording has what was missed.
        if (liveSequenceGap(previousLiveFrameRef.current, next)) liveResyncRef.current?.request('sequence-gap')
        previousLiveFrameRef.current = { bootId: next.bootId, streamSeq: next.streamSeq }
        if (continuity) {
          // A stalled or backward same-boot frame removes mutation authority, not the read-only
          // telemetry already on screen. A reboot clears the old boot's presentation entirely.
          void recoverContinuity(continuity === 'stalled-or-reorder')
          if (continuity === 'reboot') return
        }
      }
      const isActuating = liveIndicatesActuation(next)
      const statusUnsafe = isActuating || (next.connected && next.thermalLogActive === true)
      const idleRevisionNeedsStatus =
        next.connected &&
        !statusUnsafe &&
        next.stateRev !== undefined &&
        next.stateRev !== completedStatusRevisionRef.current
      if (next.connected && statusUnsafe && initialStatusPending) setStatusChecked(true)
      if (telemetryDegradedRef.current) {
        if (next.connected) {
          setLive(next)
          setNowMs(Date.now())
        }
        if (next.connected && !statusUnsafe && !controller.fullStatusDeferred()) void recoverContinuity(true)
        return
      }
      setLive(next)
      crackleData.observeRevision({
        connected: next.connected,
        bootId: next.bootId,
        stateRev: next.stateRev,
        active: statusUnsafe || idleRevisionNeedsStatus,
      })
      setNowMs(Date.now())
      if (
        next.connected &&
        !statusUnsafe &&
        (initialStatusPending ||
          wasStatusUnsafe ||
          deferredStatusRefresh ||
          refreshAfterStreamConnect ||
          idleRevisionNeedsStatus)
      ) {
        initialStatusPending = false
        if (initialStatusTimer !== undefined) window.clearTimeout(initialStatusTimer)
        initialStatusTimer = undefined
        deferredStatusRefresh = false
        refreshAfterStreamConnect = false
        void refreshStatus(true)
      }
    }

    const refreshStatus = async (_required = false) => {
      // This check is duplicated by HttpControllerClient.status() deliberately: this effect avoids
      // treating a cached contract as fresh, while the controller guard makes every other caller
      // fail-safe too.
      if (controller.fullStatusDeferred() || liveBlocksFullStatus(latestLive)) {
        deferredStatusRefresh = true
        return
      }
      if (telemetryDegradedRef.current) {
        await recoverContinuity()
        return
      }
      if (statusRefreshInFlight) return
      statusRefreshInFlight = true
      const next = await controller.status().finally(() => {
        statusRefreshInFlight = false
      })
      if (disposed || controller.fullStatusDeferred()) return
      initialStatusPending = false
      if (initialStatusTimer !== undefined) window.clearTimeout(initialStatusTimer)
      initialStatusTimer = undefined
      setStatus(next)
      if (next.connected) completedStatusRevisionRef.current = next.stateRev
      // The data layer watches status for two things: whether this controller has a document store
      // at all, and the moment it goes idle so a queue held by the firmware's flash-write gate can
      // drain without the user pressing anything.
      crackleData.observeStatus(next)
      setStatusChecked(true)
      setNowMs(Date.now())
    }
    const refreshLive = async (probeConnectedStream = false) => {
      // A failed fetch may consume its entire three-second timeout. The one-second scheduler must
      // never stack more sockets behind it, especially when several sleeping browsers wake at once.
      if (liveRefreshStartedAt !== 0 && Date.now() - liveRefreshStartedAt < LIVE_REFRESH_ABANDON_MS) return
      const startedAt = Date.now()
      liveRefreshStartedAt = startedAt
      const generation = streamGeneration
      try {
        const next = await controller.live()
        if (disposed || generation !== streamGeneration) return
        if (streamConnected && (!probeConnectedStream || !next.connected)) return
        acceptLive(next)
      } finally {
        if (liveRefreshStartedAt === startedAt) liveRefreshStartedAt = 0
      }
    }
    const newestFrameAgeMs = () => (latestLive ? Date.now() - latestLive.receivedAtMs : Infinity)
    const kickStream = () => {
      lastStreamKickAt = Date.now()
      stopStream.reconnect()
      liveRefreshStartedAt = 0
      void refreshLive(true)
    }
    const recoverAfterWake = () => {
      if (document.visibilityState === 'hidden') return
      if (newestFrameAgeMs() < LIVE_RESUME_STALE_MS) return
      kickStream()
    }
    const stopStream = controller.subscribeLive(acceptLive, (connected) => {
      if (streamConnected !== connected) streamGeneration += 1
      streamConnected = connected
      // A stream that comes back after it was up has missed frames; the first connect has not.
      if (connected && streamEverConnected) liveResyncRef.current?.request('stream-reconnect')
      if (connected) streamEverConnected = true
      if (connected) refreshAfterStreamConnect = true
      setLiveConnection(connected ? 'websocket' : 'fallback')
    })
    // Cold load gives compact telemetry first refusal. If neither WebSocket nor `/api/live` produces
    // a connected frame, one bounded fallback status request keeps older/unreachable devices usable.
    void refreshLive()
    initialStatusTimer = window.setTimeout(() => {
      if (!initialStatusPending) return
      initialStatusPending = false
      void refreshStatus(true)
    }, INITIAL_LIVE_STATUS_WAIT_MS)
    const fallback = window.setInterval(() => {
      setNowMs(Date.now())
      const freshFrameLate =
        latestLive?.connected === true && Date.now() - latestLive.receivedAtMs > LIVE_FALLBACK_AFTER_MS
      if (!streamConnected || freshFrameLate) void refreshLive(streamConnected)
      // Still nothing current after a while, visible: replace the socket again rather than trust it.
      if (
        document.visibilityState !== 'hidden' &&
        newestFrameAgeMs() > LIVE_STALE_RECONNECT_MS &&
        Date.now() - lastStreamKickAt > LIVE_STALE_RECONNECT_MS
      )
        kickStream()
    }, 1000)
    document.addEventListener('visibilitychange', recoverAfterWake)
    window.addEventListener('pageshow', recoverAfterWake)
    window.addEventListener('online', recoverAfterWake)
    window.addEventListener('focus', recoverAfterWake)
    return () => {
      disposed = true
      stopStream()
      document.removeEventListener('visibilitychange', recoverAfterWake)
      window.removeEventListener('pageshow', recoverAfterWake)
      window.removeEventListener('online', recoverAfterWake)
      window.removeEventListener('focus', recoverAfterWake)
      window.clearInterval(fallback)
      if (initialStatusTimer !== undefined) window.clearTimeout(initialStatusTimer)
    }
  }, [])

  // A failed edit can leave a global sync warning visible while the device is unavailable. Once
  // both telemetry and the authoritative document mirror are current, that warning describes an
  // old state and must not survive until a full-page refresh.
  useEffect(() => {
    if (!liveStatus.connected || liveStatus.stale || telemetryDegraded || dataSync.health !== 'current') return
    setStorageError((current) => (obsoleteRecoveredStorageAlert(current) ? undefined : current))
  }, [dataSync.health, liveStatus.connected, liveStatus.stale, telemetryDegraded])

  const currentRecordedOn = useMemo(
    () => (liveStatus.roaster ? recordedOnFromRoaster(liveStatus.roaster, liveStatus.firmwareVersion) : undefined),
    [liveStatus.firmwareVersion, liveStatus.roaster],
  )
  const weakWifi = liveStatus.connected ? weakWifiNotice(liveStatus.liveTransport?.wifiRssiDbm) : undefined
  const targetWasBusyRef = useRef(false)
  const targetBusyNow = Boolean(
    liveStatus.roast?.active ||
      liveStatus.calibration?.active ||
      liveStatus.manual?.active ||
      liveStatus.manualLockout ||
      liveStatus.lifecycle === 'RUNNING' ||
      liveStatus.restoreMaintenance?.active,
  )
  if (liveStatus.connected) targetWasBusyRef.current = targetBusyNow
  const configuredTargetSwitchBlockedReason =
    !liveStatus.connected && targetWasBusyRef.current
      ? 'The previous roaster disconnected while it was active. Reconnect it and verify idle before switching.'
      : targetSwitchBlockedReason({
          status: liveStatus,
          profileDirty,
          beanDirty,
          pendingWrites: dataSync.queued,
          switching: targetSwitching,
          manualRecordingSettlementPending: Boolean(manualWorkingRunRef.current),
          recordingImportPending: recordingImportInFlight,
        })
  const roasterTargetPresentations = roasterTargets.map((target) => {
    const active = target.id === configuredTarget.id
    const identity = active ? liveStatus.roaster : undefined
    return {
      id: target.id,
      name: identity?.displayName ?? target.label,
      model: identity?.modelId ?? 'Identity reported after connection',
      address: target.address,
      simulated: identity?.simulated ?? (target.kind === 'mock' ? true : undefined),
      connected: active ? liveStatus.connected : undefined,
      stale: active ? liveStatus.stale : undefined,
      firmwareVersion: active && liveStatus.connected ? liveStatus.firmwareVersion : undefined,
    }
  })
  const activeRoasterPresentation = roasterTargetPresentations.find((target) => target.id === configuredTarget.id)

  const switchRoasterTarget = async (targetId: string) => {
    if (targetId === configuredTarget.id || targetSwitching) return
    if (configuredTargetSwitchBlockedReason) {
      setStorageError(configuredTargetSwitchBlockedReason)
      return
    }
    const target = roasterTargets.find((candidate) => candidate.id === targetId)
    if (!target) return
    setTargetSwitching(true)
    setTargetSwitchFailure(undefined)
    try {
      const candidateStatus = await new HttpControllerClient(target).status()
      if (!candidateStatus.connected) throw new Error(candidateStatus.fault ?? `${target.label} did not answer.`)
      if (!candidateStatus.roaster)
        throw new Error(
          `${target.label} does not report stable device identity. Update that roaster to the current Crackle firmware before selecting it.`,
        )
      if (target.kind === 'mock' && candidateStatus.roaster.simulated !== true)
        throw new Error(`${target.label} answered as a physical roaster, so Crackle refused the target.`)
      if (target.kind === 'physical' && candidateStatus.roaster.simulated === true)
        throw new Error(`${target.label} answered as a simulator, so Crackle refused the target.`)
      if (typeof window !== 'undefined') window.location.assign(targetNavigationUrl(window.location.href, target.id))
    } catch (error) {
      setTargetSwitchFailure({
        ...targetVerificationFailure(
          target,
          error instanceof Error ? error.message : 'The selected roaster could not be verified.',
        ),
        targetId: target.id,
      })
    } finally {
      setTargetSwitching(false)
    }
  }
  const activeThermalLogId = (
    liveStatus.thermalLog as (ControllerStatus['thermalLog'] & { logId?: string }) | undefined
  )?.logId
  const refreshActiveRoastPlan = useCallback(async () => {
    const roast = liveStatus.roast
    const retainedPlanIdentified =
      roast &&
      roast.mode !== 'manual' &&
      roast.mode !== 'none' &&
      roast.sessionId !== undefined &&
      roast.planRev !== undefined &&
      (roast.active || roast.endReason !== undefined)
    if (!retainedPlanIdentified) return
    setActiveRoastPlanLoading(true)
    setActiveRoastPlanError(undefined)
    try {
      const plan = await controllerRef.current!.fetchActiveRoastPlan()
      if (!activePlanMatchesController(plan, liveStatus)) {
        throw new Error('The plan returned by the roaster belongs to a different boot, session, or plan revision.')
      }
      setActiveRoastPlan(plan)
    } catch (error) {
      setActiveRoastPlanError(
        error instanceof Error ? error.message : 'The exact roast plan could not be read from the roaster',
      )
    } finally {
      setActiveRoastPlanLoading(false)
    }
  }, [
    liveStatus.bootId,
    liveStatus.roast?.active,
    liveStatus.roast?.endReason,
    liveStatus.roast?.mode,
    liveStatus.roast?.planRev,
    liveStatus.roast?.sessionId,
  ])

  useEffect(() => {
    const roast = liveStatus.roast
    if (!roast || roast.mode === 'manual' || roast.mode === 'none' || !roast.sessionId || roast.planRev === undefined)
      return
    if (!roast.active && roast.endReason === undefined) return
    void refreshActiveRoastPlan()
  }, [
    liveStatus.bootId,
    liveStatus.roast?.active,
    liveStatus.roast?.endReason,
    liveStatus.roast?.mode,
    liveStatus.roast?.planRev,
    liveStatus.roast?.sessionId,
    refreshActiveRoastPlan,
  ])
  useEffect(() => {
    const identity = manualTraceIdentity(liveStatus)
    if (!identity) return
    const sessionKey = manualTraceSessionKey(identity)
    const requestKey = manualTraceRequestKey(identity)
    if (manualSampleSessionRef.current !== sessionKey) {
      manualSampleSessionRef.current = sessionKey
      manualHydrationRequestRef.current = ''
      setManualLiveSamples([])
    }
    if (manualHydrationRequestRef.current === requestKey) return
    manualHydrationRequestRef.current = requestKey
    let disposed = false
    void (async () => {
      const controller = controllerRef.current!
      let hydrated: RoastRun['samples'] = []
      if (identity.logId) {
        try {
          hydrated = deviceRoastSamples(await controller.fetchDeviceLogCsv(identity.logId))
        } catch {
          /* active recording may still be RAM-only */
        }
      }
      // A provisional archive can be a valid header-only occurrence while the fuller samples remain
      // in RAM. Fall back on parsed sample count, not on whether the CSV string was non-empty.
      if (hydrated.length === 0) {
        try {
          hydrated = deviceRoastSamples(await controller.fetchThermalCsv())
        } catch {
          /* keep the live frames already visible */
        }
      }
      if (disposed) return
      const currentIdentity = manualTraceIdentity(liveStatusRef.current)
      if (!currentIdentity || manualTraceRequestKey(currentIdentity) !== requestKey) return
      if (hydrated.length > 0) setManualLiveSamples((current) => mergeManualTrace(hydrated, current))
    })()
    return () => {
      disposed = true
    }
  }, [
    activeThermalLogId,
    liveStatus.bootId,
    liveStatus.roast?.active,
    liveStatus.roast?.endReason,
    liveStatus.roast?.mode,
    liveStatus.roast?.sessionId,
  ])

  useEffect(() => {
    const roast = liveStatus.roast
    const sessionKey = profiledTraceSessionKey(liveStatus)
    if (!roast || !sessionKey || liveStatus.thermalLog?.source !== 'roast') return
    const thermalLog = liveStatus.thermalLog
    const hydrationKey = `${sessionKey}:${activeThermalLogId ?? 'no-log'}:${thermalLog?.unsaved ? 'ram' : 'stored'}`
    if (profiledHydrationSessionRef.current === hydrationKey) return
    profiledHydrationSessionRef.current = hydrationKey
    profiledSampleSessionRef.current = sessionKey
    setProfiledLiveSamples([])
    setProfiledHistoryNotice('Reading earlier temperature history from the roaster...')
    let disposed = false
    void (async () => {
      const controller = controllerRef.current!
      let hydrated: RoastRun['samples'] = []
      if (activeThermalLogId) {
        try {
          hydrated = deviceRoastSamples(await controller.fetchDeviceLogCsv(activeThermalLogId))
        } catch {
          /* the reserved log may still be RAM-only */
        }
      }
      // A provisional flash entry can legitimately contain only the CSV header. The live RAM route
      // is then the roaster's fuller truth; fall back on sample count, not merely a non-empty string.
      if (hydrated.length === 0) {
        try {
          hydrated = deviceRoastSamples(await controller.fetchThermalCsv())
        } catch {
          /* an active recording or older firmware may refuse the live RAM log */
        }
      }
      if (disposed) return
      if (hydrated.length === 0) {
        setProfiledHistoryNotice(
          'The roaster has not exposed earlier temperature samples yet. Live samples will appear here as they arrive.',
        )
        return
      }
      // By roaster second, the roaster winning: the frames collected while the read was in flight
      // overlap its tail, and an append-only fold would have drawn them out of order.
      setProfiledLiveSamples((current) => mergeRecordingPrefix(hydrated, current))
      setProfiledHistoryNotice(undefined)
    })()
    return () => {
      disposed = true
    }
  }, [
    activeThermalLogId,
    liveStatus.bootId,
    liveStatus.roast?.active,
    liveStatus.roast?.endReason,
    liveStatus.roast?.mode,
    liveStatus.roast?.sessionId,
    liveStatus.thermalLog?.source,
    liveStatus.thermalLog?.unsaved,
  ])
  useEffect(() => {
    const roast = liveStatus.roast
    if (!live?.connected || !roast?.active || roast.mode === 'manual') return
    const elapsedSec = live.roastElapsedSec
    const beanTempC = live.temperatureC
    const effectiveFan = live.effectiveFan
    const effectiveHeat = live.effectiveHeat
    if (
      elapsedSec === undefined ||
      beanTempC === undefined ||
      effectiveFan === undefined ||
      effectiveHeat === undefined
    )
      return
    const sessionKey = `${live.bootId ?? liveStatus.bootId}:${roast.sessionId ?? 'unknown'}`
    const lastCollected = lastCollectedSampleRef.current
    if (lastCollected?.sessionKey === sessionKey && liveSampleGap(lastCollected.elapsedSec, elapsedSec))
      liveResyncRef.current?.request('sample-gap')
    lastCollectedSampleRef.current = { sessionKey, elapsedSec }
    setProfiledLiveSamples((current) => {
      const base = profiledSampleSessionRef.current === sessionKey ? current : []
      profiledSampleSessionRef.current = sessionKey
      return appendProfiledRoastSample(base, {
        elapsedSec,
        beanTempC,
        requestedFan: live.requestedFan ?? roast.commandedFan ?? effectiveFan,
        effectiveFan,
        requestedHeat: live.requestedHeat ?? roast.commandedHeat ?? effectiveHeat,
        effectiveHeat,
      })
    })
  }, [
    live,
    liveStatus.bootId,
    liveStatus.roast?.active,
    liveStatus.roast?.commandedFan,
    liveStatus.roast?.commandedHeat,
    liveStatus.roast?.mode,
    liveStatus.roast?.sessionId,
  ])

  // A latched fault is the one thing that must be visible from whichever screen is open.
  const fault = useMemo(() => faultNotice(liveStatus), [liveStatus])

  /**
   * Manual history is reconciled against every poll, not only while the Manual view is open, so a
   * run that ended while the tab was elsewhere - or closed - shows up with its end reason on the
   * next poll or the next load. It runs against the live-merged status, so a fault stop appears
   * immediately after the next streamed observation. `reconcileManualEvent` is idempotent, which is
   * what makes it safe to re-run whenever the status or the clock changes.
   *
   * THE DEPENDENCY THAT IS NOT THERE. Depending on `manualEvents` would make this effect its own
   * trigger: it appends an event, the array identity changes, the effect fires again on the same
   * observation. The domain function is idempotent so it would terminate - but "the loop stops
   * because the function it calls happens to return undefined the second time" is a property of the
   * callee, not of the caller, and one future reconciler that disagreed with itself would spin the
   * app forever. The observation is what this reacts to, so the observation is what it depends on;
   * the history is read through a ref, which is current on every render without being a trigger.
   */
  const manualEventsRef = useRef<ManualEvent[]>(manualEvents)
  manualEventsRef.current = manualEvents
  useEffect(() => {
    if (!ready) return
    if (!currentRecordedOn) return
    const derived = reconcileManualEvent({
      manual: liveStatus.manual,
      latest: manualEventsRef.current.at(-1),
      observedAtMs: liveStatus.receivedAtMs,
      nowMs: Date.now(),
      temperatureC: liveStatus.temperatureC,
      recordedOn: currentRecordedOn,
    })
    if (derived) appendManualEvent(derived)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the event history is read through a ref by design
  }, [currentRecordedOn, liveStatus, ready])
  /**
   * A command may request one prompt contract reconciliation. Wait long enough
   * for the 1 Hz compact fallback to publish actuation first; starting an 8 KiB
   * synchronous response in the command-to-first-frame gap can starve thermal
   * sampling. If the current merged state is active, the live idle edge above
   * owns the eventual full refresh.
   */
  useEffect(() => {
    if (statusNonce === 0) return
    const controller = controllerRef.current!
    let disposed = false
    const timer = window.setTimeout(() => {
      if (controller.fullStatusDeferred() || statusIndicatesActuation(liveStatusRef.current)) return
      void controller.status().then((next) => {
        if (disposed || controller.fullStatusDeferred()) return
        setStatus(next)
        if (next.connected) completedStatusRevisionRef.current = next.stateRev
        crackleData.observeStatus(next)
        setNowMs(Date.now())
      })
    }, COMMAND_STATUS_RECONCILE_DELAY_MS)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [statusNonce])
  const refreshStatus = useCallback(() => setStatusNonce((value) => value + 1), [])

  /*
   * ==========================================================================================
   * ATTACHING TO THE CONTROLLER'S OWN LIBRARY
   * ==========================================================================================
   *
   * The presence of `status.dataStore` is the feature detection, exactly as `log_archive` is for
   * recordings. Once it appears, the controller's copy becomes the truth: the data layer loads it,
   * IndexedDB becomes a mirror of it, and this component simply re-reads through its subscription.
   * On firmware without the store nothing here ever runs and the app stays browser-local.
   *
   * The raw archive fetcher is handed over because a current run document carries only a bounded
   * fallback series beside its recording identity. A browser that has never seen that roast rebuilds
   * the detailed curve only after the `.crk` header proves its immutable producer identity; after retention removes it,
   * the fallback keeps History useful without exceeding the 16 KB document cap.
   */
  const dataStoreSupported = liveStatus.dataStore !== undefined
  useEffect(() => {
    if (!localLibraryReady || !statusChecked || !dataStoreSupported) return
    const controller = controllerRef.current!
    let disposed = false
    // One recordings-list read serves every hydration request at the same state revision: every
    // archive change advances the revision, and the downloaded bytes' identity is proved below
    // regardless. Re-reading the list per recording cost a multi-second storage walk each.
    let hydrationArchive: { stateRev?: string; atMs: number; archive: Promise<DeviceArchive> } | undefined
    const archiveForHydration = () => {
      const stateRev = statusRef.current.stateRev
      if (
        hydrationArchive &&
        stateRev !== undefined &&
        hydrationArchive.stateRev === stateRev &&
        Date.now() - hydrationArchive.atMs < HYDRATION_ARCHIVE_REUSE_MS
      )
        return hydrationArchive.archive
      const archive = controller.deviceLogs()
      const memo = { stateRev, atMs: Date.now(), archive }
      hydrationArchive = memo
      archive.then(
        (result) => {
          if (result.state !== 'available' && hydrationArchive === memo) hydrationArchive = undefined
        },
        () => {
          if (hydrationArchive === memo) hydrationArchive = undefined
        },
      )
      return archive
    }
    void (async () => {
      try {
        await crackleData.bindObservedDevice(liveStatus.roaster!.deviceId)
        await crackleData.attach(controller, async (request) => {
          // A storage slot is mutable. Read the archive at the current revision, then prove the
          // downloaded bytes' immutable producer identity before they enter the browser mirror.
          const archive = await archiveForHydration()
          if (archive.state !== 'available') return { kind: 'unavailable' }
          const addressed = request.storageAddress
            ? archive.logs.find((entry) => recordingKey(entry.storageAddress) === recordingKey(request.storageAddress!))
            : undefined
          if (addressed && recordingKey(addressed.recordingOrigin) !== recordingKey(request.recordingOrigin)) {
            return {
              kind: 'mismatch',
              message:
                'A stored recording address now belongs to different evidence. Crackle refused to hydrate the record from the wrong recording.',
            }
          }
          const exact =
            addressed ??
            archive.logs.find((entry) => recordingKey(entry.recordingOrigin) === recordingKey(request.recordingOrigin))
          if (!exact) return { kind: 'unavailable' }
          const bytes = await controller.fetchDeviceLogFile(exact.storageAddress.logId)
          const validation = validateCrkRecording(bytes, exact.storageAddress.logId)
          if (
            !validation.ok ||
            recordingKey(validation.summary.recordingOrigin) !== recordingKey(request.recordingOrigin)
          ) {
            return {
              kind: 'mismatch',
              message:
                'The downloaded recording belongs to different evidence. Crackle refused to hydrate the record from the wrong recording.',
            }
          }
          const samples = decodeCrkThermalSamples(bytes, exact.storageAddress.logId)
          return samples ? { kind: 'ok', samples } : { kind: 'unavailable' }
        })
        setDeviceAttachFailure(undefined)
        const loaded = await reloadFromStore()
        if (disposed) return
        setSelectedRoastId((current) =>
          loaded.profiles.some((profile) => profile.id === current) ? current : (loaded.profiles[0]?.id ?? ''),
        )
        setSelectedEditorId((current) =>
          loaded.profiles.some((profile) => profile.id === current) ? current : (loaded.profiles[0]?.id ?? ''),
        )
        if (loaded.profiles.length === 0) setManualMode(true)
      } catch (error) {
        if (!disposed) {
          const message = error instanceof Error ? error.message : 'Crackle could not verify the roaster library'
          setDeviceAttachFailure(message)
          setStorageError(message)
        }
      } finally {
        if (!disposed) setDeviceLibraryReady(true)
      }
    })()
    return () => {
      disposed = true
    }
  }, [dataStoreSupported, liveStatus.roaster?.deviceId, localLibraryReady, reloadFromStore, statusChecked])

  /*
   * A new roaster starts with the default profiles. Once its library is verified current and the
   * roaster is idle, a library that has never held a profiles document receives Espresso Express
   * (the temperature journey, listed and selected first) and its timed companion in one write.
   * A refusal - another browser installed them first, or the roaster became busy - leaves the
   * library as the roaster has it; the reload below shows whichever copy won.
   */
  const defaultProfilesAttemptRef = useRef<string>()
  useEffect(() => {
    if (!deviceLibraryReady || dataSync.health !== 'current' || mutationBlockedReason) return
    if (!crackleData.profilesDocumentAbsent()) return
    const deviceId = liveStatus.roaster?.deviceId ?? ''
    if (defaultProfilesAttemptRef.current === deviceId) return
    defaultProfilesAttemptRef.current = deviceId
    void (async () => {
      const now = new Date().toISOString()
      const defaults = defaultProfiles(now)
      try {
        if (!(await crackleData.installDefaultProfiles(defaults, defaultProfileRevisions(defaults, now)))) return
      } catch {
        // Not installed by this browser; the reload shows the roaster's library as it stands.
      }
      const loaded = await reloadFromStore()
      setSelectedRoastId((current) =>
        loaded.profiles.some((profile) => profile.id === current) ? current : (loaded.profiles[0]?.id ?? ''),
      )
      setSelectedEditorId((current) =>
        loaded.profiles.some((profile) => profile.id === current) ? current : (loaded.profiles[0]?.id ?? ''),
      )
      // Manual mode was forced only because the library had no profiles. The install runs only on an
      // idle roaster, so no manual roast is in progress to be displaced.
      if (loaded.profiles.length > 0) setManualMode(false)
    })()
  }, [dataSync.health, deviceLibraryReady, liveStatus.roaster?.deviceId, mutationBlockedReason, reloadFromStore])

  const adoptLocalData = useCallback(async () => {
    await crackleData.adoptLocalData()
  }, [])
  const dismissAdoption = useCallback(() => {
    void crackleData.dismissAdoption()
  }, [])

  /*
   * ==========================================================================================
   * IMPORTING THE ROASTS THE CONTROLLER RAN
   * ==========================================================================================
   *
   * The browser was not there. A roast may have started on a phone, finished after the laptop was
   * closed, or run entirely while this app was not open - that is the whole point of moving
   * execution onto the device - so the archive is reconciled against the controller's own recordings
   * rather than written as the roast happens.
   *
   * It runs on load and on every visit to History, and it is safe to run as often as it likes:
   * `importableDeviceRoasts` filters against the repository's ledger of ids already considered, and
   * every run's id is derived from the controller's log id, so a second import of the same recording
   * would write the same record rather than a second one. See `domain/deviceRoastImport.ts` for why
   * both halves of that are needed.
   *
   * The refs are what keep this callback stable across every render: it is fired from an effect, and
   * a callback that changed identity whenever a profile did would re-fire the import on every save.
   */
  const profilesRef = useRef<Profile[]>(profiles)
  profilesRef.current = profiles
  const runsRef = useRef<RoastRun[]>(runs)
  runsRef.current = runs
  const beansRef = useRef<BeanLot[]>(beans)
  beansRef.current = beans
  const firmwareRef = useRef(status.firmwareVersion)
  firmwareRef.current = status.firmwareVersion
  // Read by the cascade gate and the export manifest, both of which are callbacks that must not be
  // rebuilt on every full-status reconciliation just to see the newest status.
  const statusRef = useRef(status)
  statusRef.current = status

  /*
   * ==========================================================================================
   * STAGING A DEVICE-EXECUTED ROAST'S RECORD ON THE ROASTER, BEFORE START
   * ==========================================================================================
   *
   * The complete run record - volume, ambient, bean lot id and snapshot, mass, name, profile
   * snapshot, outcome `running` - is durably written to the roaster's document store BEFORE the
   * Start command fires. The write is a fail-closed precondition: if it is refused, Start does not
   * fire and the refusal is shown; a busy refusal is surfaced, never blind-retried (the
   * storage-priority retry contract covers reads, not this mutation). Every browser that syncs the
   * library sees the whole record immediately; the archive reconciliation later completes it in
   * place. The old localStorage stash is gone; its abandoned key is cleared once below.
   */
  const legacyStashPurgedRef = useRef(false)
  if (!legacyStashPurgedRef.current) {
    legacyStashPurgedRef.current = true
    purgeLegacyPendingRoastSetup()
  }
  /**
   * The recording each staged run was observed to open - from the Start acknowledgement or live
   * status. Known only to this browser (the flash-write gate closes once outputs run, so it cannot
   * be persisted mid-roast); other browsers reconcile the shared record by name and start time.
   */
  const pendingDeviceRecordingsRef = useRef(new Map<string, RecordingOrigin>())
  /**
   * The last record this browser staged, and whether its Start was accepted. A retry after a
   * refused Start whose cleanup also failed reuses the same id, so retries can never pile up
   * duplicate records.
   */
  const stagedDeviceRunRef = useRef<{ id: string; started: boolean }>()
  const selectedProfileRef = useRef<Profile>()

  const startDeviceRoast = useCallback(
    async (setup: {
      args: RoastStartArgs
      record: boolean
      measurements: BatchMeasurements
      beanLotId?: string
    }): Promise<CommandResult> => {
      const current = liveStatusRef.current
      const recordedOn = current.roaster ? recordedOnFromRoaster(current.roaster, current.firmwareVersion) : undefined
      const profile = selectedProfileRef.current
      if (!recordedOn || !profile) {
        return {
          ok: false,
          message: 'The roaster has not reported its device identity yet, so the roast record cannot be staged.',
        }
      }
      const blocked = catalogMutationReasonRef.current
      if (blocked)
        return { ok: false, message: `The roast was not started. Its record must reach the roaster first: ${blocked}` }
      // Reuse the id of a leftover staged record from a refused Start whose removal failed.
      const leftover = stagedDeviceRunRef.current
      const reusableId =
        leftover &&
        !leftover.started &&
        runsRef.current.some(
          (run) => run.id === leftover.id && run.deviceRoastPending && run.outcome === 'running' && !run.deviceRoast,
        )
          ? leftover.id
          : undefined
      const bean = beansRef.current.find((item) => item.id === setup.beanLotId)
      const run = provisionalDeviceRoastRun({
        id: reusableId ?? newId('run'),
        name: setup.args.name,
        profile,
        measurements: { ...setup.measurements, ambientC: current.ambientC },
        beanLotId: setup.beanLotId,
        beanLot: bean,
        recordedOn,
        firmwareVersion: current.firmwareVersion,
        bootId: current.bootId,
        startedAt: new Date().toISOString(),
      })
      stagedDeviceRunRef.current = { id: run.id, started: false }
      const outcome = await executeDeviceRoastStart(run, {
        saveRun: (record) => crackleData.saveRun(record),
        deleteRun: (id) => crackleData.deleteRun(id),
        markRunAborted: (id, note) =>
          crackleData.updateRun(id, { outcome: 'aborted', completedAt: new Date().toISOString(), notes: note }),
        start: () => controllerRef.current!.startRoast(setup.record ? setup.args : { ...setup.args, record: '0' }),
      })
      if (!outcome.ok && outcome.stage === 'record') {
        return {
          ok: false,
          message: `The roast was not started. The roaster did not accept its run record: ${outcome.message}`,
        }
      }
      if (!outcome.ok && outcome.cleanup === 'kept') {
        // The Start may have committed. Keep the staged record, and treat it as started so a retry
        // never reuses (and a refused retry never deletes) the record of a roast that may be running.
        stagedDeviceRunRef.current = { id: run.id, started: true }
        setRuns((items) => byStartedAt([run, ...items.filter((item) => item.id !== run.id)]))
        refreshStatus()
        return { ok: false, outcomeUnknown: true, message: outcome.message }
      }
      if (!outcome.ok) {
        if (outcome.cleanup === 'removed') {
          stagedDeviceRunRef.current = undefined
          setRuns((items) => items.filter((item) => item.id !== run.id))
          return { ok: false, message: outcome.message }
        }
        if (outcome.cleanup === 'aborted') {
          stagedDeviceRunRef.current = undefined
          setRuns((items) =>
            byStartedAt([
              { ...run, outcome: 'aborted', completedAt: new Date().toISOString() },
              ...items.filter((item) => item.id !== run.id),
            ]),
          )
          return {
            ok: false,
            message: `${outcome.message} The staged run record could not be removed, so it was marked aborted in History.`,
          }
        }
        setRuns((items) => byStartedAt([run, ...items.filter((item) => item.id !== run.id)]))
        return {
          ok: false,
          message: `${outcome.message} The staged run record also could not be removed; starting again will reuse it.`,
        }
      }
      stagedDeviceRunRef.current = { id: run.id, started: true }
      setRuns((items) => byStartedAt([run, ...items.filter((item) => item.id !== run.id)]))
      if (outcome.result.logId && typeof outcome.result.logId === 'string') {
        pendingDeviceRecordingsRef.current.set(run.id, { deviceId: recordedOn.deviceId, logId: outcome.result.logId })
      }
      refreshStatus()
      return outcome.result as CommandResult
      // eslint-disable-next-line react-hooks/exhaustive-deps -- every input is read through a ref by design
    },
    [refreshStatus],
  )

  /**
   * Attach the recording identity to the staged record the moment live status reports which log
   * the running profiled roast is being written to - the exact join the reconciliation prefers,
   * the same way a manual session records its `pendingRecording`. In-memory only: the flash-write
   * gate is closed while outputs run.
   */
  useEffect(() => {
    const staged = stagedDeviceRunRef.current
    const roast = liveStatus.roast
    if (!staged?.started || !roast?.active || roast.mode === 'manual' || !currentRecordedOn) return
    if (pendingDeviceRecordingsRef.current.has(staged.id)) return
    if (liveStatus.thermalLog?.source !== 'roast' || !liveStatus.thermalLog.logId) return
    const run = runsRef.current.find((item) => item.id === staged.id)
    // The name fences the join: a staged record must not claim a different roast's recording.
    if (!run || (roast.name && sanitizeRoastName(run.name) !== sanitizeRoastName(roast.name))) return
    pendingDeviceRecordingsRef.current.set(staged.id, {
      deviceId: currentRecordedOn.deviceId,
      logId: liveStatus.thermalLog.logId,
    })
  }, [currentRecordedOn, liveStatus.roast, liveStatus.thermalLog])

  /**
   * Repair: two run records claiming one recording are one roast recorded twice. Fold each group
   * into the record the roast setup staged (keeping every value the user entered on either copy)
   * and delete the other copies - keeper saved first, so a failure part-way loses nothing. Runs only
   * when catalog writes are allowed; a refusal is retried by the next archive pass.
   */
  const foldDuplicateRecordings = async () => {
    if (catalogMutationReasonRef.current) return
    const merges = duplicateRecordingMerges(await crackleData.runs())
    for (const merge of merges) {
      try {
        // Rebased onto the keeper as it stands now: an edit made since the snapshot is kept.
        const written = await crackleData.saveReconciledRun(merge.keep, merge.basis)
        for (const id of merge.removeIds) await crackleData.deleteRun(id)
        setRuns((current) =>
          byStartedAt([
            ...current.filter((run) => run.id !== written.id && !merge.removeIds.includes(run.id)),
            written,
          ]),
        )
      } catch {
        // Left for the next pass; both copies still exist, so nothing is lost.
      }
    }
  }

  /**
   * Settle staged records that can never be completed: staged under an earlier boot, with the
   * roaster idle and the archive listed in full, and no recording that could still join them. They
   * become aborted with a note instead of waiting as "running" forever.
   */
  const settleOrphanedStagedRuns = async (logs: DeviceLogEntry[]) => {
    // The merged live status, not the full document: full status is deferred while anything
    // actuates, and a stale boot id would make another browser's fresh Start look orphaned.
    const busy = () => {
      const current = liveStatusRef.current
      return Boolean(
        catalogMutationReasonRef.current ||
          current.roast?.active ||
          current.thermalLog?.active ||
          current.thermalLog?.unsaved,
      )
    }
    if (busy()) return
    const bootId = liveStatusRef.current.bootId
    for (const orphan of orphanedStagedRuns(await crackleData.runs(), logs, bootId)) {
      if (busy() || liveStatusRef.current.bootId !== bootId) return
      try {
        const note = orphanedStagedRunNote(orphan.reason)
        const notes = orphan.run.notes.trim() ? [orphan.run.notes.trim(), note].join('\n\n') : note
        const patch: Partial<RoastRun> = {
          outcome: 'aborted',
          completedAt: orphan.run.startedAt,
          notes,
          deviceRoastPending: undefined,
        }
        await crackleData.updateRun(orphan.run.id, patch)
        setRuns((items) => items.map((run) => (run.id === orphan.run.id ? { ...run, ...patch } : run)))
      } catch {
        // Retried by the next archive pass.
      }
    }
  }

  const importDeviceRoasts = useCallback(async (): Promise<'complete' | 'deferred'> => {
    if (importingRef.current) return 'deferred'
    importingRef.current = true
    setRecordingImportInFlight(true)
    try {
      const controller = controllerRef.current!
      const archive = await controller.deviceLogs()
      if (archive.state !== 'available') {
        const disposition = archiveImportDisposition(archive.state)
        if (disposition === 'complete') {
          setDeviceLogs([])
          setDeviceArchiveListed(true)
        }
        return disposition
      }
      setDeviceLogs(archive.logs)
      setDeviceArchiveListed(true)
      const alreadyImported = await crackleData.importedDeviceLogIds()
      const pending = importableDeviceRoasts(
        archive.logs,
        alreadyImported,
        unsettledRoastRecordingId(statusRef.current),
      )
      if (pending.length === 0) {
        await foldDuplicateRecordings()
        await settleOrphanedStagedRuns(archive.logs)
        return 'complete'
      }
      const candidates: Array<{
        run: RoastRun
        logId: string
        localRunId?: string
        basis?: RoastRun
        entry: DeviceLogEntry
        reconstructed: RoastRun
      }> = []
      const claimedLocalRuns = new Set<string>()
      const ledgerRepairIds: string[] = []
      for (const entry of pending) {
        const decisionKey = recordingKey(entry.recordingOrigin)
        // A prior pass may have durably saved the merged local run and failed only while writing the
        // import ledger. Repair that bookkeeping from the immutable recording origin without depending on the
        // controller CSV still being readable.
        if (
          runsRef.current.some(
            (run) => run.deviceRoast && sameRecording(run.deviceRoast.recordingOrigin, entry.recordingOrigin),
          )
        ) {
          ledgerRepairIds.push(decisionKey)
          continue
        }
        try {
          // A current compact archive contains both the exact plan and its thermal samples. Decode
          // it locally; CSV remains only the compatibility fallback for a legacy archive.
          let archiveBytes: Uint8Array | undefined
          let archiveCsv: string | undefined
          if (entry.version === 4) {
            try {
              archiveBytes = await controller.fetchDeviceLogFile(entry.id)
              const archiveSamples = decodeCrkThermalSamples(archiveBytes, entry.id)
              if (archiveSamples) archiveCsv = thermalSamplesToCsv(archiveSamples)
            } catch {
              // Keep importing from CSV; absence of optional provenance must not hide the roast.
            }
          }
          const csv = archiveCsv ?? (await controller.fetchDeviceLogCsv(entry.id))
          const reconstructed = deviceRoastRun({
            entry,
            csv,
            profiles: profilesRef.current,
            archive: archiveBytes,
            firmwareVersion: firmwareRef.current,
            importedAtMs: Date.now(),
          })
          if (reconstructed.manualRoast) {
            const reconciliation = reconcileManualArchiveRun({
              entry,
              reconstructed,
              localRuns: runsRef.current,
              claimedLocalRunIds: claimedLocalRuns,
            })
            if (reconciliation.kind === 'ledger-repair') {
              ledgerRepairIds.push(reconciliation.logId)
              continue
            }
            if (reconciliation.kind === 'merge') claimedLocalRuns.add(reconciliation.localRunId)
            candidates.push({
              run: reconciliation.run,
              logId: reconciliation.logId,
              entry,
              reconstructed,
              ...(reconciliation.kind === 'merge'
                ? {
                    localRunId: reconciliation.localRunId,
                    basis: runsRef.current.find((run) => run.id === reconciliation.localRunId),
                  }
                : {}),
            })
          } else {
            // A device-executed profiled roast COMPLETES the record Start staged on the roaster
            // (recording linkage, outcome, thermal series; header-carried facts such as the batch
            // mass win) rather than synthesizing a second record from the header.
            const reconciliation = reconcileProfiledArchiveRun({
              entry,
              reconstructed,
              localRuns: runsRef.current,
              claimedLocalRunIds: claimedLocalRuns,
              pendingRecordingByRunId: pendingDeviceRecordingsRef.current,
            })
            if (reconciliation.kind === 'merge') claimedLocalRuns.add(reconciliation.localRunId)
            candidates.push({
              run: reconciliation.run,
              logId: reconciliation.logId,
              entry,
              reconstructed,
              ...(reconciliation.kind === 'merge'
                ? {
                    localRunId: reconciliation.localRunId,
                    basis: runsRef.current.find((run) => run.id === reconciliation.localRunId),
                  }
                : {}),
            })
          }
        } catch {
          // A recording that could not be read is left OUT of the ledger, so the next visit retries
          // it. A failed fetch is not a decision about the roast.
        }
      }
      const imported: RoastRun[] = []
      const importedIds: string[] = []
      // The roaster's CURRENT library, read once more before any standalone record is written. The
      // join above ran against this page's snapshot, taken before seconds of recording downloads; a
      // page that had just reloaded, or another browser's pass, may have seen a different library.
      // Without this, one pass can reconstruct a second record while another completes the staged
      // one, and History shows the same roast twice.
      await crackleData.syncFromDevice().catch(() => undefined)
      const libraryNow = await crackleData.runs()
      for (const candidate of candidates) {
        try {
          if (!candidate.localRunId) {
            if (
              libraryNow.some(
                (run) => run.deviceRoast && recordingKey(run.deviceRoast.recordingOrigin) === candidate.logId,
              )
            ) {
              // Another pass already wrote a record for this recording: nothing to add.
              importedIds.push(candidate.logId)
              continue
            }
            const rejoin = candidate.reconstructed.manualRoast
              ? reconcileManualArchiveRun({
                  entry: candidate.entry,
                  reconstructed: candidate.reconstructed,
                  localRuns: libraryNow,
                  claimedLocalRunIds: claimedLocalRuns,
                })
              : reconcileProfiledArchiveRun({
                  entry: candidate.entry,
                  reconstructed: candidate.reconstructed,
                  localRuns: libraryNow,
                  claimedLocalRunIds: claimedLocalRuns,
                  pendingRecordingByRunId: pendingDeviceRecordingsRef.current,
                })
            if (rejoin.kind === 'ledger-repair') {
              importedIds.push(candidate.logId)
              continue
            }
            if (rejoin.kind === 'merge') {
              claimedLocalRuns.add(rejoin.localRunId)
              candidate.run = rejoin.run
              candidate.localRunId = rejoin.localRunId
              candidate.basis = libraryNow.find((run) => run.id === rejoin.localRunId)
            }
          }
          // The ledger is a commit record, not a fetch record. Save the roast first and only mark
          // this controller id handled after that write has succeeded, otherwise a transient local
          // storage error would make the only durable device copy invisible to every later retry.
          // A merge rebases onto the record as it stands NOW, so an edit made while this pass was
          // fetching recordings survives; a standalone reconstruction has nothing to rebase onto.
          let written = candidate.run
          if (candidate.localRunId) written = await crackleData.saveReconciledRun(candidate.run, candidate.basis)
          else await crackleData.saveRun(candidate.run)
          imported.push(written)
          importedIds.push(candidate.logId)
          // The staged record is complete now; its in-memory recording join has served its purpose.
          if (candidate.localRunId) {
            pendingDeviceRecordingsRef.current.delete(candidate.localRunId)
            if (stagedDeviceRunRef.current?.id === candidate.localRunId) stagedDeviceRunRef.current = undefined
          }
        } catch {
          // A failed write leaves this recording out of the ledger too, so the next pass retries it.
        }
      }
      if (importedIds.length > 0 || ledgerRepairIds.length > 0) {
        await crackleData.markDeviceLogsImported([...importedIds, ...ledgerRepairIds])
      }
      if (imported.length > 0) {
        const working = manualWorkingRunRef.current
        const finalizedWorking = working && imported.some((entry) => entry.id === working.id)
        if (finalizedWorking) {
          manualWorkingRunRef.current = undefined
          const finalized = imported.find((entry) => entry.id === working.id)
          if (finalized?.manualRoast) setManualLiveSamples(finalized.samples)
          setManualMessage('')
          setManualError((current) =>
            current.startsWith('The roaster is still controlling this roast') ? '' : current,
          )
          setStorageError((current) =>
            current?.includes('Document storage waits until actuation') ? undefined : current,
          )
        }
        setRuns((current) =>
          byStartedAt([...current.filter((run) => !imported.some((entry) => entry.id === run.id)), ...imported]),
        )
      }
      await foldDuplicateRecordings()
      await settleOrphanedStagedRuns(archive.logs)
      return 'complete'
    } catch {
      // Reconciliation retries after a bounded delay or the next archive-consuming view.
      return 'deferred'
    } finally {
      importingRef.current = false
      setRecordingImportInFlight(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every input is read through a ref by design
  }, [])

  /**
   * Archive housekeeping: a recording whose roast is already here, removed from the controller.
   *
   * Offered, never automatic - and only for recordings this controller library has already handled.
   * The shared ledger is the authority here rather than the currently visible run rows: deleting a
   * roast record must not strand its recording forever, and every stored run now carries a bounded
   * fallback curve before the full-resolution recording is eligible for removal.
   */
  const deviceLogIds = useMemo(() => deviceLogs.map((entry) => entry.id), [deviceLogs])
  const prunableLogIds = useMemo(() => {
    // Calibration evidence is already preserved by its acknowledged CalibrationRun document. It
    // does not travel through the roast-import ledger, so include its exact source log here rather
    // than asking the user to preserve the same recording forever.
    const preserved = new Set(importedLogIds)
    for (const run of calibrationRuns)
      if (run.sourceLogId) preserved.add(recordingKey({ deviceId: run.recordedOn.deviceId, logId: run.sourceLogId }))
    return deviceLogs.filter((entry) => preserved.has(recordingKey(entry.recordingOrigin))).map((entry) => entry.id)
  }, [calibrationRuns, deviceLogIds, importedLogIds])
  const pruneDeviceLogs = useCallback(
    async (logIds: string[]) => {
      if (logIds.length === 0) return
      const blocked = catalogMutationReasonRef.current
      if (blocked) {
        setStorageError(blocked)
        return
      }
      const safeRoast = logIds.filter((id) =>
        runsRef.current.some(
          (run) =>
            (run.deviceRoast?.storageAddress.logId === id || run.manualRoast?.logId === id) && run.samples.length > 0,
        ),
      )
      const calibrationEvidence = logIds.filter((id) => {
        const entry = deviceLogs.find((candidate) => candidate.storageAddress.logId === id)
        return (
          entry !== undefined &&
          calibrationRuns.some((run) => calibrationRecordingKey(run) === recordingKey(entry.recordingOrigin))
        )
      })
      const permanent = logIds.filter((id) => !safeRoast.includes(id) && !calibrationEvidence.includes(id))
      const consequences: string[] = []
      if (safeRoast.length > 0)
        consequences.push(
          `${safeRoast.length} recording${safeRoast.length === 1 ? ' has' : 's have'} a stored roast with a compact fallback curve; ${safeRoast.length === 1 ? 'its roast record remains' : 'their roast records remain'}.`,
        )
      if (calibrationEvidence.length > 0)
        consequences.push(
          `${calibrationEvidence.length} recording${calibrationEvidence.length === 1 ? ' is' : 's are'} preserved as calibration evidence; ${calibrationEvidence.length === 1 ? 'its evidence row remains' : 'their evidence rows remain'}.`,
        )
      if (permanent.length > 0)
        consequences.push(
          `${permanent.length} recording${permanent.length === 1 ? ' has' : 's have'} no preserved fallback. Deleting ${permanent.length === 1 ? 'it' : 'them'} permanently removes that detailed history.`,
        )
      const consequence = consequences.join(' ')
      if (
        !window.confirm(
          `Delete ${logIds.length} thermal recording${logIds.length === 1 ? '' : 's'} from the roaster?\n\n${consequence}`,
        )
      )
        return
      const controller = controllerRef.current!
      const removed: string[] = []
      for (const id of logIds) {
        const result = await controller.deleteDeviceLog(id)
        if (result.ok) removed.push(id)
        else if (result.message) setStorageError(result.message)
      }
      setDeviceLogs((current) => current.filter((entry) => !removed.includes(entry.id)))
    },
    [calibrationRuns, deviceLogs],
  )

  /*
   * On load, on arrival at History or Settings, and again the moment a roast stops executing. Ordinary navigation
   * does not re-list every recording. Never run WHILE a roast executes: its log is still being written,
   * its header is not final, and `/logs/<id>.csv` would serve a moving target.
   *
   * The dependencies are deliberately booleans rather than the status objects they come from. A
   * status document is a fresh object on every reconciliation, so depending on `liveStatus.logArchive`
   * would re-list the archive every five seconds to discover nothing had changed.
   */
  const archiveSupported = liveStatus.logArchive !== undefined
  const deviceRoastRunning = liveStatus.roast?.active === true
  const deviceRoastRecordingPending =
    liveStatus.thermalLog?.source === 'roast' &&
    (liveStatus.thermalLog.active === true || liveStatus.thermalLog.unsaved === true)
  const activeSession = runs.find((run) => run.id === activeRunId)
  /*
   * The post-roast session panel is open and waiting on exactly this import (the roaster reports
   * the recording finished; only the archive read stands between the user and Save), or it is
   * waiting on a final recording state a connected roaster has yet to report. Either way someone
   * is looking at the wait, so the read keeps retrying instead of demanding a navigation to
   * History to fire the view-arrival trigger (which would otherwise leave a wall of many minutes).
   */
  const manualFinalizationPhase = manualRecordingFinalization(activeSession, liveStatus)?.phase
  const awaitingManualReconciliation =
    manualFinalizationPhase === 'reconciling' ||
    (manualFinalizationPhase === 'waiting' && liveStatus.connected && !liveStatus.stale)
  const archiveImportAttemptedRef = useRef(false)
  const archiveWasBusyRef = useRef(false)
  const archiveRetryTimerRef = useRef<number>()
  const archiveRetryCountRef = useRef(0)
  const archiveRetryNonceRef = useRef(0)
  const archiveDeviceIdRef = useRef<string>()
  const [archiveImportNonce, setArchiveImportNonce] = useState(0)
  const [archiveListDeferred, setArchiveListDeferred] = useState(false)
  useEffect(() => {
    const deviceId = liveStatus.roaster?.deviceId
    if (archiveDeviceIdRef.current !== deviceId) {
      archiveDeviceIdRef.current = deviceId
      archiveImportAttemptedRef.current = false
      archiveRetryCountRef.current = 0
      setDeviceArchiveListed(false)
    }
    const busy = deviceRoastRunning || deviceRoastRecordingPending
    const justSettled = archiveWasBusyRef.current && !busy
    archiveWasBusyRef.current = busy
    if (!ready || !archiveSupported || busy) return
    const initial = !archiveImportAttemptedRef.current
    // Calibration consumes the same roast/log join as History. Revisiting it must re-attempt a
    // promotion that was interrupted by a controller reboot instead of leaving a stale picker.
    const archiveConsumer = view === 'history' || view === 'settings' || view === 'calibrate'
    // A nonce this pass has not consumed yet is a scheduled timer retry firing; anything else that
    // starts an import below is a fresh trigger and therefore a fresh deferral episode.
    const timerRetry = archiveImportNonce !== archiveRetryNonceRef.current
    archiveRetryNonceRef.current = archiveImportNonce
    if (!initial && !justSettled && !archiveConsumer && !timerRetry && !awaitingManualReconciliation) return
    // Every new episode replenishes the whole retry budget. Only a timer continuation
    // keeps spending the current one, so one long-exhausted episode can never silence the next.
    if (!timerRetry) archiveRetryCountRef.current = 0
    void importDeviceRoasts().then((outcome) => {
      setArchiveListDeferred(outcome === 'deferred')
      if (outcome === 'complete') {
        archiveImportAttemptedRef.current = true
        if (archiveRetryTimerRef.current !== undefined) {
          window.clearTimeout(archiveRetryTimerRef.current)
          archiveRetryTimerRef.current = undefined
        }
        if (!awaitingManualReconciliation) {
          archiveRetryCountRef.current = 0
          return
        }
        // A complete list can still predate the finished recording reaching the index, and the
        // session panel is still waiting on it - keep polling until the recording reconciles.
      }
      if (archiveRetryTimerRef.current !== undefined) return
      const delay = archiveRetryDelayMs(archiveRetryCountRef.current, awaitingManualReconciliation)
      if (delay === undefined) return
      archiveRetryCountRef.current += 1
      archiveRetryTimerRef.current = window.setTimeout(() => {
        archiveRetryTimerRef.current = undefined
        setArchiveImportNonce((value) => value + 1)
      }, delay)
    })
  }, [
    archiveImportNonce,
    archiveSupported,
    awaitingManualReconciliation,
    deviceRoastRecordingPending,
    deviceRoastRunning,
    importDeviceRoasts,
    liveStatus.roaster?.deviceId,
    ready,
    view,
  ])

  const selectedLibraryProfile =
    repeatRoastSetup?.profile ?? profiles.find((profile) => profile.id === selectedRoastId) ?? profiles[0]
  const manualOwnershipBlockedReason = useMemo(() => {
    if (!activeSession?.manualRoast || activeSession.outcome !== 'running') return undefined
    const roast = liveStatus.roast
    if (activeSession.manualRoast.deviceBootId && activeSession.manualRoast.deviceBootId !== liveStatus.bootId) {
      return 'This browser session belongs to an earlier controller boot; review the current roast before sending a change'
    }
    if (roast?.active && roast.mode !== 'manual') {
      return 'The roaster is running a profiled roast; this saved manual session cannot steer it'
    }
    if (!activeSession.manualRoast.deviceSessionId) {
      return 'This saved session predates atomic manual-roast identity; review the current roast before sending controls'
    }
    if (roast?.active && roast.mode === 'manual' && roast.sessionId !== activeSession.manualRoast.deviceSessionId) {
      return 'The roaster is running a different manual session; this saved session cannot steer it'
    }
    if (
      roast?.active &&
      roast.mode === 'manual' &&
      activeSession.manualRoast.deviceName &&
      sanitizeRoastName(roast.name ?? '') !== activeSession.manualRoast.deviceName
    ) {
      return 'The roaster is running a different manual roast; this saved session cannot steer it'
    }
    if (
      roast?.active &&
      roast.mode === 'manual' &&
      activeSession.manualRoast.deviceStartedEpoch &&
      roast.startedEpoch &&
      activeSession.manualRoast.deviceStartedEpoch !== roast.startedEpoch
    ) {
      return 'The roaster is running a newer manual roast with the same name; this saved session cannot steer it'
    }
    return undefined
  }, [activeSession, liveStatus.bootId, liveStatus.roast])
  const manualControlBlockedReason = useMemo(() => {
    if (!activeSession?.manualRoast || activeSession.outcome !== 'running') return undefined
    if (manualOwnershipBlockedReason) return manualOwnershipBlockedReason
    if (!liveStatus.roast?.active || liveStatus.roast.mode !== 'manual')
      return 'Waiting for the roaster to report this manual roast as active'
    return undefined
  }, [activeSession, liveStatus.roast, manualOwnershipBlockedReason])
  const profiledDeviceActive = liveStatus.roast?.active === true && liveStatus.roast.mode !== 'manual'
  const profiledDeviceSession = Boolean(
    liveStatus.roast?.sessionId &&
      liveStatus.roast.mode !== 'manual' &&
      liveStatus.roast.mode !== 'none' &&
      (profiledDeviceActive || liveStatus.roast.endReason !== undefined),
  )
  const activePlanExpected = Boolean(
    liveStatus.roast &&
      liveStatus.roast.mode !== 'manual' &&
      liveStatus.roast.mode !== 'none' &&
      liveStatus.roast.sessionId &&
      liveStatus.roast.planRev !== undefined &&
      (liveStatus.roast.active || liveStatus.roast.endReason !== undefined),
  )
  const activePlanDisplay = resolveActivePlanDisplay(activeRoastPlan, liveStatus, acceptedPlanBridge)
  const displayedActiveRoastPlan = activePlanDisplay.plan
  const activePlanDecisionHandled = Boolean(
    displayedActiveRoastPlan &&
      importedLogIds.some((id) => id.startsWith(activePlanDecisionPrefix(displayedActiveRoastPlan))),
  )
  const sessionPlanBindsSetup = setupBindsToSessionPlan(
    profiledDeviceActive,
    liveStatus.roast?.sessionId,
    setupChoiceAfterSession,
  )
  const authoritativeActiveProfile = useMemo(
    () =>
      profiledDeviceSession && sessionPlanBindsSetup && displayedActiveRoastPlan
        ? profileFromActiveRoastPlan(displayedActiveRoastPlan, undefined, profiles)
        : undefined,
    [displayedActiveRoastPlan, profiledDeviceSession, profiles, sessionPlanBindsSetup],
  )
  const selectedProfile =
    authoritativeActiveProfile ?? activeSession?.profile ?? selectedLibraryProfile ?? EMPTY_LIBRARY_MANUAL_PROFILE
  selectedProfileRef.current = selectedProfile
  const rawTarget = selectedProfile
    ? profileGoalAt(selectedProfile, authoritativeActiveProfile ? [authoritativeActiveProfile] : profiles)
    : undefined
  const ambientReferenceC = activeSession?.measurements?.ambientC ?? liveStatus.ambientC ?? 24.5
  const targetIntent = useMemo(
    () =>
      rawTarget ? effectiveThermalIntent(rawTarget, ambientReferenceC, calibration.coolingTargetMarginC) : undefined,
    [ambientReferenceC, calibration.coolingTargetMarginC, rawTarget],
  )
  const overlay = runs.find((run) => run.id === overlayId)
  const profiledSamplesCurrent = profiledTraceSessionKey(liveStatus) === profiledSampleSessionRef.current
  // The device-manual trace stands on its own: with no browser session at all, a manual device
  // roast still draws from the same device-keyed buffer the hydration and live effects fill.
  const deviceManualIdentity = manualTraceIdentity(liveStatus)
  const deviceManualTraceCurrent =
    deviceManualIdentity !== undefined && manualTraceSessionKey(deviceManualIdentity) === manualSampleSessionRef.current
  const liveSamples = selectLiveTrace({
    deviceRoast: liveStatus.roast,
    activeSession,
    profiled: profiledLiveSamples,
    profiledCurrent: profiledSamplesCurrent,
    manual: manualLiveSamples,
    manualCurrent: deviceManualTraceCurrent,
  })
  /**
   * Device-observed steps fill in what this browser's own journal cannot know: instructions
   * another browser applied while this one was closed or joined late. They extend only the live
   * manual presentation - a completed session's journal is its own finished record.
   */
  const liveEvents = useMemo(() => {
    const own = activeSession?.events ?? []
    if (!deviceManualIdentity) return own
    if (activeSession && (!activeSession.manualRoast || activeSession.outcome !== 'running')) return own
    return mergeDeviceManualEvents(own, deviceManualEvents)
  }, [activeSession, deviceManualEvents, deviceManualIdentity])
  const lastSample = liveSamples.at(-1)

  useEffect(() => {
    if (!activeSession?.manualRoast || activeSession.outcome !== 'running' || manualControlBlockedReason) return
    if (liveStatus.roast?.active !== true || liveStatus.roast.mode !== 'manual') return
    setManualObservedActiveRunId(activeSession.id)
    const thermalLogId = liveStatus.thermalLog?.source === 'roast' ? liveStatus.thermalLog.logId : undefined
    const deviceStartedEpoch = activeSession.manualRoast.deviceStartedEpoch ?? liveStatus.roast.startedEpoch
    const pendingRecording =
      activeSession.manualRoast.pendingRecording ??
      (thermalLogId && currentRecordedOn
        ? {
            recordingOrigin: { deviceId: currentRecordedOn.deviceId, logId: thermalLogId },
            storageAddress: { deviceId: currentRecordedOn.deviceId, logId: thermalLogId },
          }
        : undefined)
    if (
      deviceStartedEpoch !== activeSession.manualRoast.deviceStartedEpoch ||
      pendingRecording !== activeSession.manualRoast.pendingRecording
    ) {
      const manualRoast = { ...activeSession.manualRoast, deviceStartedEpoch, pendingRecording }
      const updated = { ...activeSession, manualRoast }
      manualWorkingRunRef.current = updated
      setRuns((current) => current.map((run) => (run.id === activeSession.id ? updated : run)))
    }
  }, [activeSession, currentRecordedOn, liveStatus.roast, liveStatus.thermalLog, manualControlBlockedReason])

  /** Attach a newly opened browser to a manual roast already running on the controller. */
  useEffect(() => {
    const roast = liveStatus.roast
    if (!ready || activeSession || !roast?.active || roast.mode !== 'manual' || !currentRecordedOn) return
    const elapsedSec = Math.max(0, roast.elapsedSec ?? 0)
    /*
     * The record Start staged on the roaster IS this roast's record - every browser reads it from
     * the device library. Adopt it as the working session rather than inventing a second identity
     * beside it, attaching the live device identity (boot, session, epoch, recording) the staged
     * copy could not carry: the flash-write gate was already closed when those were reported.
     */
    const thermalLogId = liveStatus.thermalLog?.source === 'roast' ? liveStatus.thermalLog.logId : undefined
    const staged = runsRef.current.find(
      (run) =>
        run.deviceRoastPending !== undefined &&
        run.outcome === 'running' &&
        run.manualRoast !== undefined &&
        !run.manualRoast.deviceSessionId &&
        sanitizeRoastName(run.name) === sanitizeRoastName(roast.name ?? ''),
    )
    if (staged?.manualRoast && roast.sessionId) {
      const adopted: RoastRun = {
        ...staged,
        manualRoast: {
          ...staged.manualRoast,
          deviceBootId: liveStatus.bootId,
          deviceSessionId: roast.sessionId,
          deviceStartedEpoch: roast.startedEpoch,
          incomplete: true,
          ...(thermalLogId
            ? {
                pendingRecording: {
                  recordingOrigin: { deviceId: currentRecordedOn.deviceId, logId: thermalLogId },
                  storageAddress: { deviceId: currentRecordedOn.deviceId, logId: thermalLogId },
                },
              }
            : {}),
        },
      }
      manualWorkingRunRef.current = adopted
      setManualMode(true)
      setManualObservedActiveRunId(adopted.id)
      setManualProfileDraftName(`${adopted.name} profile`)
      setActiveRunId(adopted.id)
      setRuns((current) => current.map((run) => (run.id === adopted.id ? adopted : run)))
      setManualMessage(
        'Joined the manual roast running on the roaster; its record was staged at Start. Earlier exact requests may only be recoverable as delivered levels from its recording.',
      )
      return
    }
    const startedAt = roast.startedEpoch
      ? new Date(roast.startedEpoch * 1000).toISOString()
      : new Date(Date.now() - elapsedSec * 1000).toISOString()
    const runId = manualRoastRunId(liveStatus.bootId, roast.sessionId)
    if (!runId) {
      setManualError(
        'The roaster is running a manual roast but has not reported its session identity yet. Waiting to attach safely.',
      )
      return
    }
    const fan = roast.commandedFan ?? liveStatus.effectiveFan ?? 4
    const heat = roast.commandedHeat ?? liveStatus.effectiveHeat ?? 0
    const synthetic: TimedProfile = {
      id: `manual-profile-${runId}`,
      name: 'Manual roast',
      revision: 0,
      strategy: 'timed',
      createdAt: startedAt,
      updatedAt: startedAt,
      metadata: { intent: 'Manual roast' },
      notes: 'Recovered from a manual roast already running on the controller.',
      points: [{ id: `manual-point-${runId}-0`, timeSec: 0, fan, heat }],
      coolFan: 9,
      coolDurationSec: 90,
    }
    const change: ManualRoastChange = {
      id: newId('manual-change-recovered'),
      elapsedSec: 0,
      requestedFan: fan,
      requestedHeat: heat,
      effectiveFan: liveStatus.effectiveFan ?? fan,
      effectiveHeat: liveStatus.effectiveHeat ?? heat,
      temperatureC: liveStatus.temperatureC,
      source: 'firmware',
    }
    const recovered: RoastRun = {
      id: runId,
      name: roast.name ?? 'Manual roast',
      startedAt,
      profile: synthetic,
      notes: '',
      recordedOn: currentRecordedOn,
      controllerVersion: liveStatus.firmwareVersion,
      measurements: roast.batchMassG ? { startingMassG: roast.batchMassG, ambientC: roast.ambientC } : undefined,
      outcome: 'running',
      samples: [],
      events: [
        { id: newId('manual-recovered'), elapsedSec, type: 'SYSTEM', label: 'Joined manual roast already in progress' },
      ],
      manualRoast: {
        changes: [change],
        deviceBootId: liveStatus.bootId,
        deviceName: sanitizeRoastName(roast.name ?? 'Manual roast'),
        deviceStartedEpoch: roast.startedEpoch,
        deviceSessionId: roast.sessionId,
        incomplete: true,
        ...(liveStatus.thermalLog?.source === 'roast' && liveStatus.thermalLog.logId
          ? {
              pendingRecording: {
                recordingOrigin: { deviceId: currentRecordedOn.deviceId, logId: liveStatus.thermalLog.logId },
                storageAddress: { deviceId: currentRecordedOn.deviceId, logId: liveStatus.thermalLog.logId },
              },
            }
          : {}),
      },
    }
    manualWorkingRunRef.current = recovered
    setManualMode(true)
    setManualObservedActiveRunId(recovered.id)
    // Preserve any same-session trace already collected. Device CSV hydration fills an empty trace.
    setManualProfileDraftName(`${recovered.name} profile`)
    setActiveRunId(recovered.id)
    setRuns((current) => [recovered, ...current])
    setManualMessage(
      'Joined the manual roast already running on the roaster. Earlier exact requests may only be recoverable as delivered levels from its recording.',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one recovery edge, once no local session exists
  }, [
    activeSession?.id,
    currentRecordedOn,
    liveStatus.bootId,
    liveStatus.roast?.active,
    liveStatus.roast?.mode,
    liveStatus.roast?.sessionId,
    liveStatus.thermalLog?.logId,
    liveStatus.thermalLog?.source,
    ready,
  ])

  /**
   * The live manual curve is deliberately browser-ephemeral and bounded to one point per device
   * second. The firmware's 1 Hz archive is the durable copy; writing a run document four times a
   * second would only fill the idle-gated queue with obsolete intermediate versions.
   *
   * It is keyed to the DEVICE session, never to this browser's session document: the roaster is
   * authoritative, so a browser that joined mid-roast - or holds no session at all - must still
   * draw the roast it is watching. Session ownership gates commands, not presentation.
   */
  useEffect(() => {
    const roast = liveStatus.roast
    if (roast?.active !== true || roast.mode !== 'manual' || !roast.sessionId) return
    const beanTempC = liveStatus.temperatureC
    const elapsedSec = Math.floor(roast.elapsedSec ?? 0)
    const effectiveFan = liveStatus.effectiveFan
    const effectiveHeat = liveStatus.effectiveHeat
    if (beanTempC === undefined || effectiveFan === undefined || effectiveHeat === undefined) return
    const sessionKey = `${liveStatus.bootId}:${roast.sessionId}`
    const lastCollected = lastCollectedSampleRef.current
    if (lastCollected?.sessionKey === sessionKey && liveSampleGap(lastCollected.elapsedSec, elapsedSec))
      liveResyncRef.current?.request('sample-gap')
    lastCollectedSampleRef.current = { sessionKey, elapsedSec }
    setManualLiveSamples((current) => {
      const base = manualSampleSessionRef.current === sessionKey ? current : []
      manualSampleSessionRef.current = sessionKey
      return appendProfiledRoastSample(base, {
        elapsedSec,
        beanTempC,
        requestedFan: live?.requestedFan ?? roast.commandedFan ?? effectiveFan,
        effectiveFan,
        requestedHeat: live?.requestedHeat ?? roast.commandedHeat ?? effectiveHeat,
        effectiveHeat,
      })
    })
  }, [
    live?.requestedFan,
    live?.requestedHeat,
    liveStatus.bootId,
    liveStatus.effectiveFan,
    liveStatus.effectiveHeat,
    liveStatus.roast?.active,
    liveStatus.roast?.commandedFan,
    liveStatus.roast?.commandedHeat,
    liveStatus.roast?.elapsedSec,
    liveStatus.roast?.mode,
    liveStatus.roast?.sessionId,
    liveStatus.temperatureC,
  ])

  /**
   * Each observed change of the roaster's commanded manual levels becomes a step event. The first
   * observation only seeds the baseline: at join time the current command is an instruction that
   * was accepted earlier, and inventing its timestamp would misplace it on the chart.
   */
  useEffect(() => {
    const roast = liveStatus.roast
    if (roast?.active !== true || roast.mode !== 'manual' || !roast.sessionId) return
    const fan = roast.commandedFan
    const heat = roast.commandedHeat
    if (fan === undefined || heat === undefined) return
    const sessionKey = `${liveStatus.bootId}:${roast.sessionId}`
    const previous = deviceManualLevelsRef.current
    if (previous?.sessionKey !== sessionKey) {
      deviceManualLevelsRef.current = { sessionKey, fan, heat }
      setDeviceManualEvents([])
      return
    }
    if (Math.abs(previous.fan - fan) <= 0.02 && Math.abs(previous.heat - heat) <= 0.02) return
    deviceManualLevelsRef.current = { sessionKey, fan, heat }
    const elapsedSec = Math.max(0, Math.floor(roast.elapsedSec ?? 0))
    setDeviceManualEvents((current) =>
      [
        ...current,
        {
          id: newId('device-manual-step'),
          elapsedSec,
          type: 'OVERRIDE' as const,
          label: `Fan ${fan.toFixed(1)} / Heat ${heat.toFixed(1)}`,
          detail: 'Accepted on the roaster',
        },
      ].slice(-120),
    )
  }, [
    liveStatus.bootId,
    liveStatus.roast?.active,
    liveStatus.roast?.commandedFan,
    liveStatus.roast?.commandedHeat,
    liveStatus.roast?.elapsedSec,
    liveStatus.roast?.mode,
    liveStatus.roast?.sessionId,
  ])

  const suggestions = useMemo<ProfileSuggestions>(
    () => ({
      intents: unique([...profiles, ...runs.map((run) => run.profile)].map((profile) => profile.metadata.intent)),
    }),
    [profiles, runs],
  )

  // The profile document's array is controller-authoritative, including its nav order.
  const orderedProfiles = profiles
  const roastSetupProfiles = repeatRoastSetup
    ? [repeatRoastSetup.profile, ...orderedProfiles.filter((profile) => profile.id !== repeatRoastSetup.profile.id)]
    : orderedProfiles
  const orderedBeans = beans
  const defaultMassG = useMemo(() => lastRoastedMassG(runs), [runs])
  const reorderProfiles = useCallback(async (ids: string[]) => {
    const blocked = catalogMutationReasonRef.current
    if (blocked) {
      setStorageError(blocked)
      return
    }
    try {
      await crackleData.reorderProfiles(ids)
      setProfiles((current) => orderProfiles(current, ids))
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The roaster did not accept this profile order')
    }
  }, [])
  const reorderBeans = useCallback(async (ids: string[]) => {
    const blocked = catalogMutationReasonRef.current
    if (blocked) {
      setStorageError(blocked)
      return
    }
    try {
      await crackleData.reorderBeans(ids)
      setBeans((current) => orderProfiles(current, ids))
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The roaster did not accept this bean order')
    }
  }, [])

  const startBlocked = useMemo(
    () =>
      mutationBlockedReason ??
      modelBlockedReason('start') ??
      startBlockedReason({
        profile: selectedProfile,
        status: liveStatus,
        hasOpenSession: Boolean(activeSession),
        nowMs,
      }),
    [activeSession, liveStatus, mutationBlockedReason, nowMs, selectedProfile],
  )
  const manualStartBlocked = useMemo(() => {
    if (actuatorMutationBlockedReason) return actuatorMutationBlockedReason
    if (modelBlockedReason('start')) return modelBlockedReason('start')
    if (activeSession) return 'Resolve the open roast session before starting another roast'
    if (!liveStatus.connected) return 'The roaster is not connected'
    if (isStatusStale(liveStatus, nowMs)) return 'The roaster has stopped reporting'
    if (liveStatus.roast === undefined) return 'Manual roast control is not installed on this roaster'
    if (liveStatus.capabilities.manualRoast !== true)
      return 'This firmware can run saved profiles but does not offer first-class manual roasts'
    if (liveStatus.manualLockout || liveStatus.lifecycle === 'MANUAL_LOCKOUT') return 'Manual controls are latched off'
    if (liveStatus.fault || liveStatus.lifecycle === 'FAULT')
      return liveStatus.fault ?? 'The roaster has latched a fault'
    if (liveStatus.thermalLog?.available === false)
      return 'Thermal recording memory is unavailable; restart or service the roaster before roasting'
    if (liveStatus.roast.active) return 'Another roast is already running'
    if (liveStatus.calibration?.active || liveStatus.manual?.active) return 'Another program is already running'
    if (liveStatus.lifecycle !== 'READY' && liveStatus.lifecycle !== 'STANDBY')
      return `The roaster is ${liveStatus.lifecycle.replaceAll('_', ' ').toLowerCase()}, not ready to start`
    return undefined
  }, [activeSession, actuatorMutationBlockedReason, activeRoasterModel, liveStatus, nowMs])

  const revisionDraft = useMemo(
    () => (pendingRevision ? profileFromRun(pendingRevision) : undefined),
    [pendingRevision],
  )

  // Why a cascade cannot run right now, if it cannot. Deletes are never queued, so the panels say so.
  // A cascade weighed against an archive this browser has not listed yet would understate its own
  // impact, so the recordings list is part of the data set the delete surfaces wait for.
  const deleteBlocked = useMemo(
    () =>
      mutationBlockedReason ??
      cascadeBlockedReason({
        mode: dataSync.mode,
        offline: dataSync.offline,
        connected: liveStatus.connected,
        lifecycle: liveStatus.lifecycle,
      }) ??
      (archiveSupported && !deviceArchiveListed
        ? "Crackle is still reading the roaster's recordings. Delete becomes available when that list is complete."
        : undefined),
    [
      archiveSupported,
      dataSync.mode,
      dataSync.offline,
      deviceArchiveListed,
      liveStatus.connected,
      liveStatus.lifecycle,
      mutationBlockedReason,
    ],
  )

  // Whatever is driving the header numbers is the screen the header takes you to.
  const readoutTarget = useMemo(
    () => liveReadoutTarget({ status: liveStatus, roastInProgress: activeSession?.outcome === 'running' }),
    [activeSession?.outcome, liveStatus],
  )

  /**
   * The unsaved-changes guard. Only the editor actually on screen can lose work, so only its dirty
   * flag counts; a draft abandoned three screens ago was discarded when its editor unmounted, and
   * prompting about it later would be a lie. The same wording covers internal navigation and the
   * browser's own tab-close dialog.
   *
   * The rule for what may raise it: ONLY work that exists nowhere but this browser tab.
   * Changes that are already on the roaster never qualify. In particular, an unanswered "save the
   * edited journey?" decision after a roast whose plan was edited or overridden mid-roast is held
   * by the roaster itself: it survives leaving, reloading, and switching browsers, and the Roast
   * page keeps offering it until it is answered. Nothing is lost by leaving, so it is not a reason
   * to ask. A guard that fires when nothing is at risk trains the user to click through it, which
   * is the one outcome worse than no guard.
   */
  const unsaved =
    (view === 'profiles' && profileDirty) ||
    (view === 'beans' && beanDirty) ||
    (view === 'roast' && (roastDetailsDirty || manualPlanDirty)) ||
    (view === 'history' && historyDirty)
  /*
   * The two things the popstate listener has to know, read through refs. It is registered ONCE -
   * a listener that re-bound on every dirty keystroke would be a listener that is briefly absent
   * on every dirty keystroke - so neither may be a dependency.
   */
  const routeRef = useRef(route)
  routeRef.current = route
  const unsavedRef = useRef(unsaved)
  unsavedRef.current = unsaved

  /**
   * Arriving somewhere, and saying so in the address bar.
   *
   * A catalog link is consumed by arriving at it: the run id belongs to the History entry and to no
   * other, so leaving History drops it and the next visit is a plain archive rather than one that
   * re-opens a roast the user finished with weeks ago. That falls out of the route rather than
   * being remembered separately.
   */
  const clearDirtyFlags = useCallback(() => {
    setProfileDirty(false)
    setBeanDirty(false)
    setRoastDetailsDirty(false)
    setManualPlanDirty(false)
    setHistoryDirty(false)
  }, [])

  /**
   * Ask the guard's question without moving: may this tab leave its current view for `next`?
   * Hand-offs whose side effects must land before the target renders ask this FIRST, apply their
   * side effects only on yes, and then navigate with `confirmed` so the user is not asked twice.
   */
  const leaveAllowed = useCallback((next: AppView): boolean => {
    if (!navigationNeedsConfirm(routeRef.current.view, next, unsavedRef.current)) return true
    return window.confirm(LEAVE_WITHOUT_SAVING)
  }, [])

  /** Returns true when the tab is now at the target (it moved, or was already there). */
  const navigate = useCallback(
    (next: AppView, runId?: string, options: { confirmed?: boolean } = {}): boolean => {
      const target: Route = runId ? { view: next, runId } : { view: next }
      const current = routeRef.current
      // No entry for standing still. Otherwise a tab pressed twice would need two Backs to leave it.
      if (sameRoute(target, current)) return true
      if (!options.confirmed && !leaveAllowed(next)) return false
      if (navigationClearsDirty(current.view, next)) clearDirtyFlags()
      routeRef.current = target
      setRoute(target)
      window.history.pushState(target, '', routeHash(target))
      return true
    },
    [clearDirtyFlags, leaveAllowed],
  )

  /**
   * Back and Forward, which are navigation like any other and are the whole point of the exercise.
   *
   * The browser has already moved the address by the time this fires, so this branch never pushes:
   * a push from the pop path is the loop that turns one Back press into an unpoppable stack. The one
   * exception is the refusal - declining the unsaved-work prompt has to put the address back where
   * it was, or the URL would describe a screen the app is not showing.
   *
   * Registered once, and the initial `replaceState` runs beside it so that the first entry in the
   * stack is a real route: without it, Back from the second screen would restore an entry with no
   * state and the app would read the bare URL it was loaded with.
   */
  useEffect(() => {
    window.history.replaceState(routeRef.current, '', routeHash(routeRef.current))
    const restore = () => {
      const next = parseRoute(window.location.hash)
      const current = routeRef.current
      if (
        navigationNeedsConfirm(current.view, next.view, unsavedRef.current) &&
        !window.confirm(LEAVE_WITHOUT_SAVING)
      ) {
        window.history.pushState(current, '', routeHash(current))
        return
      }
      if (navigationClearsDirty(current.view, next.view)) clearDirtyFlags()
      routeRef.current = next
      setRoute(next)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [clearDirtyFlags])

  useEffect(() => {
    if (!unsaved) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = LEAVE_WITHOUT_SAVING
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [unsaved])

  // Dev server only: `richSeedEnabled` is false in every built bundle, so the prop stays undefined
  // and Settings renders no such control at all.
  const reloadDemoData = useCallback(async () => {
    await crackleData.resetDemoData()
    window.location.reload()
  }, [])

  const powerCycleMock = useCallback(async (): Promise<string> => {
    const message = await controllerRef.current!.powerCycleMock()
    refreshStatus()
    return message
  }, [refreshStatus])

  const setMockProbeAvailable = useCallback(async (available: boolean): Promise<string> => {
    return controllerRef.current!.setMockProbeAvailable(available)
  }, [])

  const dropMockLiveStream = useCallback(async (): Promise<string> => {
    return controllerRef.current!.dropMockLiveStream()
  }, [])

  /**
   * A save that changed nothing writes no history row. The differ that decides that is the same one
   * the dirty guard uses, so "the editor says there is nothing to save" and "no revision was
   * recorded" can never disagree.
   */
  const saveProfile = async (profile: Profile): Promise<boolean> => {
    const blocked = catalogMutationReasonRef.current ?? controllerModelReasonRef.current('author')
    if (blocked) {
      setStorageError(blocked)
      return false
    }
    const previous = profiles.find((item) => item.id === profile.id)
    const changed = !previous || profileIsDirty(profile, previous)
    // The editor already disables a clean Save. Keep the persistence boundary equally strict for
    // programmatic callers: a no-op must not replace the controller document or consume flash.
    if (previous && !changed) {
      setProfileDirty(false)
      return true
    }
    const revision: ProfileRevision | undefined = changed
      ? {
          id: newId('profile-revision'),
          profileId: profile.id,
          revision: profile.revision,
          savedAt: new Date().toISOString(),
          summary: previous ? summarizeProfileChange(previous, profile) : 'Created',
          profile: structuredClone(profile),
        }
      : undefined
    try {
      await crackleData.saveProfileWithRevision(profile, revision)
      // Only an acknowledged device write (or a browser-only repository) may become render state.
      setProfiles((current) =>
        current.some((item) => item.id === profile.id)
          ? current.map((item) => (item.id === profile.id ? profile : item))
          : [profile, ...current],
      )
      if (revision) setProfileRevisions((current) => [revision, ...current])
      setSelectedEditorId(profile.id)
      setSelectedRoastId(profile.id)
      setProfileDirty(false)
      setStorageRevision((value) => value + 1)
      return true
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The roaster did not accept this profile change')
      return false
    }
  }

  const saveBean = async (bean: BeanLot): Promise<boolean> => {
    const blocked = catalogMutationReasonRef.current
    if (blocked) {
      setStorageError(blocked)
      return false
    }
    const previous = beans.find((item) => item.id === bean.id)
    const changed = !previous || beanIsDirty(bean, previous)
    const revision: BeanRevision | undefined = changed
      ? {
          id: newId('bean-revision'),
          beanId: bean.id,
          savedAt: new Date().toISOString(),
          summary: previous ? summarizeBeanChange(previous, bean) : 'Created',
          bean: structuredClone(bean),
        }
      : undefined
    try {
      await crackleData.saveBean(bean)
      if (revision) await crackleData.saveBeanRevision(revision)
      setBeans((current) =>
        current.some((item) => item.id === bean.id)
          ? current.map((item) => (item.id === bean.id ? bean : item))
          : [bean, ...current],
      )
      if (revision) setBeanRevisions((current) => [revision, ...current])
      setSelectedBeanId(bean.id)
      setBeanDirty(false)
      setStorageRevision((value) => value + 1)
      return true
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The roaster did not accept this bean change')
      return false
    }
  }
  // Explicit bean-profile links do not exist, so deleting a lot has nothing to unpick
  // from any profile. Historical roasts keep their own bean snapshot, as they always have.
  const deleteBean = async (id: string) => {
    const blocked = catalogMutationReasonRef.current
    if (blocked) {
      setStorageError(blocked)
      return false
    }
    try {
      await crackleData.deleteBean(id)
      await crackleData.deleteBeanRevisions(id)
      setBeans((current) => current.filter((bean) => bean.id !== id))
      setSelectedBeanId((selected) =>
        selected === id ? beansRef.current.find((bean) => bean.id !== id)?.id : selected,
      )
      setBeanRevisions((current) => current.filter((revision) => revision.beanId !== id))
      return true
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The roaster did not accept this bean deletion')
      return false
    }
  }

  /** Delete the recipe only after the controller acknowledges its authoritative document. */
  const deleteProfile = async (id: string) => {
    const blocked = catalogMutationReasonRef.current
    if (blocked) {
      setStorageError(blocked)
      return false
    }
    try {
      await crackleData.deleteProfile(id)
      setProfiles((current) => current.filter((profile) => profile.id !== id))
      setProfileRevisions((current) => current.filter((revision) => revision.profileId !== id))
      const fallbackId = profilesRef.current.find((profile) => profile.id !== id)?.id ?? ''
      setSelectedEditorId((selected) => (selected === id ? fallbackId : selected))
      setSelectedRoastId((selected) => (selected === id ? fallbackId : selected))
      return true
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The roaster did not accept this profile deletion')
      return false
    }
  }
  /** The latest entity deletes, so the memoized cascade never calls a stale render's closure. */
  const entityDeleteRef = useRef({ deleteProfile, deleteBean })
  entityDeleteRef.current = { deleteProfile, deleteBean }
  /*
   * ==========================================================================================
   * THE CASCADE - run documents, then their recordings, and the ledger first of all
   * ==========================================================================================
   *
   * Order matters and is not arbitrary. The imported-recordings ledger is marked BEFORE anything is
   * deleted, so that a cascade which fails halfway - a controller that went busy, a recording delete
   * that answered 404 - cannot leave a recording on the device that the next archive reconciliation
   * would happily re-import as a brand new roast. A half-finished delete must never resurrect what
   * it already removed.
   *
   * Nothing here is queued. `deleteRunsNow` talks to the controller directly and reports what the
   * device actually confirmed, because a cascade that fired at some unannounced later moment - on a
   * library another browser had since changed - is not a delete anyone consented to.
   */
  const cascadeDelete = useCallback(
    async (plan: CascadePlan): Promise<string> => {
      const convergenceBlocked = catalogMutationReasonRef.current
      if (convergenceBlocked) throw new Error(convergenceBlocked)
      const blocked = cascadeBlockedReason({
        mode: crackleData.syncState().mode,
        offline: crackleData.syncState().offline,
        connected: statusRef.current.connected,
        lifecycle: statusRef.current.lifecycle,
      })
      if (blocked) throw new Error(blocked)
      if (statusRef.current.logArchive !== undefined && !deviceArchiveListedRef.current) {
        throw new Error(
          "Crackle is still reading the roaster's recordings. Delete becomes available when that list is complete.",
        )
      }

      if (plan.recordingLedgerKeys.length > 0) await crackleData.markDeviceLogsImported(plan.recordingLedgerKeys)
      const { deleted, failed } = await crackleData.deleteRunsNow(plan.runIds)
      setRuns((current) => current.filter((run) => !deleted.includes(run.id)))
      setOverlayId((current) => (current && deleted.includes(current) ? undefined : current))
      setActiveRunId((current) => (current && deleted.includes(current) ? undefined : current))

      const controller = controllerRef.current!
      const removedRecordings: string[] = []
      for (const logId of plan.recordingIds) {
        const result = await controller.deleteDeviceLog(logId)
        if (result.ok) removedRecordings.push(logId)
      }
      setDeviceLogs((current) => current.filter((entry) => !removedRecordings.includes(entry.id)))

      // The entity itself goes last: while its roasts were still there, it was still describing them.
      const entityDeleted =
        plan.subject === 'profile'
          ? await entityDeleteRef.current.deleteProfile(plan.id)
          : await entityDeleteRef.current.deleteBean(plan.id)
      await reloadFromStore()

      const trouble =
        failed.length > 0
          ? ` ${failed.length} roast${failed.length === 1 ? '' : 's'} could not be removed (${failed[0].message}); nothing else was affected.`
          : ''
      const done = `Deleted ${deleted.length} roast${deleted.length === 1 ? '' : 's'} and ${removedRecordings.length} recording${removedRecordings.length === 1 ? '' : 's'} from the roaster.${trouble}`
      if (!entityDeleted) {
        const noun = plan.subject === 'profile' ? 'profile' : 'bean lot'
        throw new Error(
          `${done} The ${noun} itself could not be deleted from the roaster; see the storage message and try again.`,
        )
      }
      return done
      // eslint-disable-next-line react-hooks/exhaustive-deps -- status and entity deletes are read through refs by design
    },
    [reloadFromStore],
  )

  /*
   * ==========================================================================================
   * BACKUP, RESTORE, AND ONE KIND AT A TIME
   * ==========================================================================================
   *
   * One backup action exports all data and configuration as a zip file; one restore action applies
   * such a file to the device.
   *
   * The file format is `data/backupFile.ts`; the conflict rule is `data/backupImport.ts`; the write
   * sequence is `data/backupRestore.ts`. What lives HERE is only the part that needs the app: which
   * recordings to ask for, and putting the answer in front of the user.
   *
   * Recordings are fetched one at a time and uploaded one at a time as raw archive bodies.
   * streams each file to a temp path in bounded chunks and validates it before rename. Sequential
   * transfer still keeps progress and failures attributable to one recording. One that will not
   * read is NAMED in the manifest rather than silently absent from a backup the user then trusts.
   */
  const buildBackupFile = useCallback(async (types: BackupType[]): Promise<string> => {
    const controller = controllerRef.current!
    const roaster = statusRef.current.roaster
    if (!roaster)
      throw new Error(
        'The roaster has not reported its device and model identity yet, so Crackle cannot create a trustworthy backup.',
      )
    const whole = types.length === BACKUP_TYPES.length
    const captured = await crackleData.revisionFenced(async () => {
      const [payloads, authoritativeRuns] = await Promise.all([crackleData.documentPayloads(), crackleData.runs()])
      const collections: Partial<Record<CollectionName, string>> = {}
      for (const name of collectionsForTypes(types, whole)) collections[name] = payloads.collections[name]
      const wantedRuns = types.includes('runs') ? payloads.runs : []
      const freshArchive = types.includes('runs') ? await controller.deviceLogs() : undefined
      const runRecordingIds = types.includes('runs')
        ? authoritativeRuns.flatMap((run) => (run.deviceRoast ? [run.deviceRoast.storageAddress.logId] : []))
        : []
      const wantedRecordingIds = recordingIdsForBackup(
        whole,
        freshArchive?.state === 'available',
        freshArchive?.state === 'available' ? freshArchive.logs.map((entry) => entry.id) : [],
        runRecordingIds,
      )
      const recordings: BackupRecording[] = []
      const missingRecordings: BackupMissingRecording[] = []
      for (const id of wantedRecordingIds) {
        const archiveEntry =
          freshArchive?.state === 'available' ? freshArchive.logs.find((entry) => entry.id === id) : undefined
        const linkedRun = authoritativeRuns.find((run) => run.deviceRoast?.storageAddress.logId === id)
        const origin = archiveEntry?.recordingOrigin ?? linkedRun?.deviceRoast?.recordingOrigin
        const storageAddress = archiveEntry?.storageAddress ?? linkedRun?.deviceRoast?.storageAddress
        if (!origin || !storageAddress) {
          throw new Error(`Recording ${id} has no trustworthy device provenance, so it was not exported.`)
        }
        const descriptor = { key: recordingKey(origin), origin, storageAddress }
        try {
          recordings.push({ ...descriptor, bytes: await controller.fetchDeviceLogFile(storageAddress.logId) })
        } catch (error) {
          missingRecordings.push({
            ...descriptor,
            reason: error instanceof Error ? error.message : 'the roaster did not answer',
          })
        }
      }
      return { collections, wantedRuns, freshArchive, recordings, missingRecordings }
    })
    const { collections, wantedRuns, freshArchive, recordings, missingRecordings } = captured
    if (freshArchive?.state === 'available') setDeviceLogs(freshArchive.logs)

    const createdAt = new Date().toISOString()
    const { bytes, manifest } = buildBackup({
      createdAt,
      appVersion: APP_VERSION,
      deviceId: roaster.deviceId,
      modelId: roaster.modelId,
      deviceDisplayName: roaster.displayName,
      firmwareVersion: statusRef.current.firmwareVersion,
      bootId: statusRef.current.bootId,
      // Used and total both describe the VOLUME, from the one source that reports it - pairing
      // `/data`'s own footprint with the whole volume's total would read as a nearly empty roaster.
      deviceUsedBytes: volumeUsedBytes(statusRef.current.logArchive, statusRef.current.dataStore, deviceLogs),
      deviceTotalBytes: statusRef.current.dataStore?.totalBytes,
      types,
      collections,
      runs: wantedRuns,
      recordings,
      missingRecordings,
      appliedCalibration: statusRef.current.appliedCoefficients,
    })
    downloadFile(backupFileName(types, createdAt), bytes, 'application/zip')
    const completion = backupExportCompletion(whole, missingRecordings.length)
    // The stamp means a complete recovery copy exists, not merely that a zip reached Downloads.
    if (completion.shouldMarkExported) await crackleData.markExported(createdAt)
    const counted = whole
      ? `${manifest.counts.runs} roasts, ${manifest.counts.recordings} recordings, ${manifest.counts.profiles} profiles and ${manifest.counts.beans} bean lots`
      : types.map((type) => BACKUP_TYPE_LABELS[type].toLowerCase()).join(' and ')
    return `Saved ${counted} to ${backupFileName(types, createdAt)}.${completion.notice}`
    // eslint-disable-next-line react-hooks/exhaustive-deps -- status is read through a ref by design
  }, [])

  const exportEverything = useCallback(() => buildBackupFile([...BACKUP_TYPES]), [buildBackupFile])
  const exportOneType = useCallback((type: BackupType) => buildBackupFile([type]), [buildBackupFile])

  /**
   * Replace everything on the roaster with what is in the file.
   *
   * The file is read and every document inside it parsed BEFORE the roaster is touched: a backup
   * that turns out to be unreadable must never turn out to be unreadable after the volume has been
   * erased. After that the sequence belongs to `restoreBackup`, and this only reloads the app's
   * world through the same path a boot uses.
   */
  const restoreFromBackup = useCallback(
    async (file: File, onProgress: (line: string) => void): Promise<string> => {
      const backup = parseBackup(new Uint8Array(await file.arrayBuffer()))
      requireWholeBackupForRestore(backup, {
        totalBytes: statusRef.current.dataStore?.totalBytes,
        writeFloorBytes: statusRef.current.dataStore?.writeFloorBytes,
        identity: statusRef.current.roaster,
      })
      await crackleData.beginDeviceRestore()
      const restoreController = controllerRef.current!
      let formatted = false
      let outcome: Awaited<ReturnType<typeof restoreBackup>>
      try {
        outcome = await restoreBackup(backup, restoreController, onProgress, () => {
          formatted = true
          crackleData.deviceFormatConfirmed()
        })
        // A document that failed to write after the erase means the library on the roaster is
        // partial. Committing maintenance would publish it as authoritative, so refuse: the catch
        // below keeps maintenance incomplete and names what failed, and the user restores again.
        if (restoreLeftDocumentsMissing(outcome).length > 0) throw new Error(incompleteRestoreMessage(outcome))
        await crackleData.resetAfterDeviceFormat()
        onProgress('reading the roaster back')
        await crackleData.reconcileDeviceRestore()
        await reloadFromStore()
        if (!crackleData.finishDeviceRestore()) throw new Error('The restored library could not be unlocked safely.')
      } catch (error) {
        let cleanupMessage = ''
        if (formatted) {
          // Abort only means "nothing was changed" before the format boundary. Once storage has been
          // erased or any restore write can have landed, clearing the marker would expose a partial
          // library as authoritative. Keep maintenance incomplete so recovery remains mandatory.
          try {
            await crackleData.resetAfterDeviceFormat()
          } catch (cleanupError) {
            cleanupMessage = ` Browser cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : 'unknown cleanup failure'}.`
          }
          cleanupMessage += ' The roaster remains in incomplete restore mode; restore a complete backup before editing.'
        } else {
          try {
            await crackleData.abortDeviceRestore()
          } catch (cleanupError) {
            cleanupMessage = ` Restore abort also failed: ${cleanupError instanceof Error ? cleanupError.message : 'unknown cleanup failure'}.`
          }
        }
        const message = error instanceof Error ? error.message : 'The restore failed.'
        throw new Error(`${message}${cleanupMessage}`)
      }
      await importDeviceRoasts()
      return outcome.message
    },
    [importDeviceRoasts, reloadFromStore],
  )

  /**
   * Merge a file into the library, asking about conflicts exactly once.
   *
   * The user chooses once, for all conflicts, between keeping what is on the device and keeping
   * what is in the import.
   *
   * One question, phrased as the two answers rather than as "replace?" - and asked only when there
   * is something to ask about. Everything then uses the ordinary acknowledged write path. A stale,
   * offline or running roaster does not acquire an authoritative browser-side import;
   * retry after the mutation gate reports current and idle.
   */
  const importBackupFile = useCallback(
    async (file: File): Promise<string> => {
      const backup = parseBackup(new Uint8Array(await file.arrayBuffer()))
      const input = {
        backup,
        incoming: backupLibrary(backup),
        current: {
          profiles,
          profileRevisions,
          beans,
          beanRevisions,
          runs,
          snapshots: calibrationSnapshots,
          calibrationPasses: calibrationRuns,
        },
        deviceRecordingKeys: deviceLogs.map((entry) => recordingKey(entry.recordingOrigin)),
      }
      const plan = planImport(input)
      if (plan.conflicts.length === 0 && plan.added === 0 && plan.recordings.length === 0) {
        return `Everything in that file is already on the roaster${plan.identical > 0 ? `, all ${plan.identical} of them identical` : ''} — nothing was changed.`
      }
      let choice: ConflictChoice = 'import'
      if (plan.conflicts.length > 0) {
        const decision = await new Promise<BackupConflictDecision>((resolve) => {
          setBackupConflictPrompt({
            count: plan.conflicts.length,
            names: plan.conflicts.slice(0, 3).map((conflict) => conflict.label),
            resolve,
          })
        })
        if (decision === 'cancel') return 'Import cancelled. Nothing was changed.'
        choice = decision
      }
      const changes = importChanges(input, choice)

      const currentStatus = statusRef.current
      const canRestoreRecordings =
        currentStatus.connected && !currentStatus.roast?.active && currentStatus.lifecycle !== 'RUNNING'
      const applied = await applyBackupImport(
        changes,
        backup,
        controllerRef.current!,
        crackleData,
        canRestoreRecordings,
      )
      await reloadFromStore()

      const kinds = plan.types.map((type) => BACKUP_TYPE_LABELS[type].toLowerCase()).join(', ')
      const addedCount = applied.addedDocumentsSaved
      const replacedCount = applied.replacedDocumentsSaved
      const added = ` ${addedCount} added.`
      const replaced =
        replacedCount > 0
          ? ` ${replacedCount} existing record${replacedCount === 1 ? ' was' : 's were'} replaced by the file's version.`
          : ''
      const kept = changes.keptCount > 0 ? ` The roaster's own version was kept for ${changes.keptCount}.` : ''
      const identical = plan.identical > 0 ? ` ${plan.identical} were already identical and were skipped.` : ''
      const curves =
        applied.recordingsRestored > 0
          ? ` ${applied.recordingsRestored} missing recording${applied.recordingsRestored === 1 ? '' : 's'} ${applied.recordingsRestored === 1 ? 'was' : 'were'} put back first.`
          : ''
      const omittedRuns =
        applied.skippedRunIds.length > 0
          ? ` ${applied.skippedRunIds.length} roast record${applied.skippedRunIds.length === 1 ? ' was' : 's were'} not imported because ${applied.skippedRunIds.length === 1 ? 'its' : 'their'} recording could not be restored.`
          : ''
      const trouble =
        applied.failures.length > 0
          ? ` ${applied.failures.length} item${applied.failures.length === 1 ? '' : 's'} failed: ${applied.failures.map((failure) => `${failure.what} (${failure.message})`).join('; ')}.`
          : ''
      const pending =
        applied.queued > 0
          ? ` ${applied.queued} change${applied.queued === 1 ? ' is' : 's are'} safely queued until the roaster can accept ${applied.queued === 1 ? 'it' : 'them'}.`
          : ''
      const syncIssue = applied.syncMessage ? ` ${applied.syncMessage}` : ''
      return `Imported ${kinds}:${added}${replaced}${kept}${identical}${curves}${omittedRuns}${trouble}${pending}${syncIssue}`
    },
    [
      beanRevisions,
      beans,
      calibrationRuns,
      calibrationSnapshots,
      deviceLogs,
      profileRevisions,
      profiles,
      reloadFromStore,
      runs,
    ],
  )

  /**
   * A restore erases the volume, so it may not run while the roaster is doing anything at all. The
   * firmware refuses it too - the format endpoint is idle-only - but a button that is going to be
   * refused should say so before it is pressed rather than after.
   */
  const restoreBlockedReason = useMemo(
    () => storageReplacementBlockedReason(liveStatus, dataSync),
    [
      dataSync.queued,
      liveStatus.calibration?.active,
      liveStatus.connected,
      liveStatus.dataStore,
      liveStatus.lifecycle,
      liveStatus.manual?.active,
      liveStatus.roast?.active,
      liveStatus.roaster,
      liveStatus.stale,
    ],
  )
  const formatStorage = useCallback(async (): Promise<string> => {
    const current = statusRef.current
    const blocked = storageReplacementBlockedReason(current, crackleData.syncState())
    if (blocked) throw new Error(blocked)
    const needsFormat = current.logArchive?.needsFormat === true
    const recoveryIncomplete = current.restoreMaintenance?.incomplete === true
    if (!needsFormat && !recoveryIncomplete) return 'Storage is already mounted and current; no recovery was needed.'
    const deviceId = current.roaster?.deviceId
    if (!deviceId) throw new Error('The roaster did not report a stable device identity.')

    const controller = controllerRef.current!
    const recovery = await crackleData.beginDeviceStorageRecovery(deviceId)
    let formatted = !recovery.formatRequired
    try {
      if (recovery.formatRequired) {
        const result = await controller.formatDeviceStorage()
        if (!result.ok) throw new Error(result.message ?? 'The roaster refused to format storage.')
        formatted = true
        crackleData.deviceFormatConfirmed()
      }
      await crackleData.resetAfterDeviceFormat()
      await crackleData.reconcileDeviceRestore()
      await reloadFromStore()
      const nextStatus = await controller.status()
      setStatus(nextStatus)
      if (nextStatus.connected) completedStatusRevisionRef.current = nextStatus.stateRev
      crackleData.observeStatus(nextStatus)
      crackleData.observeRevision({
        connected: nextStatus.connected,
        bootId: nextStatus.bootId,
        stateRev: nextStatus.stateRev,
      })
      setStatusChecked(true)
      setNowMs(Date.now())
      const storageReady =
        nextStatus.connected &&
        !nextStatus.stale &&
        nextStatus.logArchive?.mounted === true &&
        nextStatus.logArchive.needsFormat !== true &&
        nextStatus.dataStore?.mounted === true &&
        nextStatus.restoreMaintenance?.active !== true &&
        nextStatus.restoreMaintenance?.incomplete !== true
      if (!storageReady) {
        throw new Error(
          'Storage changed, but the roaster has not yet confirmed mounted storage and completed maintenance. Refresh status before recording.',
        )
      }
      if (!crackleData.finishDeviceRestore()) throw new Error('The empty roaster library could not be unlocked safely.')
    } catch (error) {
      let cleanup = ''
      if (!formatted) {
        try {
          await crackleData.abortDeviceRestore()
        } catch (cleanupError) {
          const released = crackleData.releaseDeviceStorageRecoveryForRetry()
          cleanup = ` Storage-maintenance cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : 'unknown failure'}. ${
            released ? 'Retry recovery to claim a fresh maintenance lease.' : 'Reload before retrying recovery.'
          }`
        }
      } else {
        cleanup = crackleData.releaseDeviceStorageRecoveryForRetry()
          ? ' Retry recovery to claim a fresh maintenance lease; the browser will not restore stale data.'
          : ' Storage recovery remains incomplete; retry before editing.'
      }
      throw new Error(`${error instanceof Error ? error.message : 'Storage formatting failed.'}${cleanup}`)
    }

    await crackleData.refresh()
    await reloadFromStore()
    await importDeviceRoasts()
    return 'Storage is mounted with an empty library and is ready to record.'
  }, [importDeviceRoasts, reloadFromStore])

  const thermocoupleOffsetBlocked = useMemo(
    () => thermocoupleOffsetBlockedReason(liveStatus, crackleData.visibleMutationBlockedReason()),
    [dataSync, liveStatus],
  )
  const saveThermocoupleOffset = useCallback(async (offsetC: number): Promise<string> => {
    if (!Number.isFinite(offsetC) || offsetC < -25 || offsetC > 25) {
      throw new Error('Thermocouple correction must be between -25.0 and 25.0 °C')
    }
    const current = liveStatusRef.current
    const blocked = thermocoupleOffsetBlockedReason(current, crackleData.visibleMutationBlockedReason())
    if (blocked) throw new Error(blocked)
    if (current.thermocoupleOffsetC === undefined) {
      throw new Error('This firmware does not report its thermocouple correction, so it cannot be edited here.')
    }
    const nextOffset = Math.round(offsetC * 100) / 100
    if (
      !window.confirm(
        `Change the roaster thermocouple correction from ${current.thermocoupleOffsetC.toFixed(2)} °C to ${nextOffset.toFixed(2)} °C?\n\nThe roaster will apply this correction once to every temperature it reports and records.`,
      )
    )
      return 'The thermocouple correction was not changed.'

    const controller = controllerRef.current!
    const result = await controller.setThermocoupleOffset(nextOffset)
    if (!result.ok) throw new Error(result.message ?? 'The roaster refused the thermocouple correction')
    const nextStatus = await controller.status()
    setStatus(nextStatus)
    if (nextStatus.connected) completedStatusRevisionRef.current = nextStatus.stateRev
    crackleData.observeStatus(nextStatus)
    crackleData.observeRevision({
      connected: nextStatus.connected,
      bootId: nextStatus.bootId,
      stateRev: nextStatus.stateRev,
    })
    setStatusChecked(true)
    setNowMs(Date.now())
    const saved = nextStatus.thermocoupleOffsetC ?? result.thermocoupleOffsetC
    if (saved === undefined)
      throw new Error('The roaster saved the setting but did not report its current correction after refresh.')
    return `Thermocouple correction is now ${saved.toFixed(2)} °C on the roaster.`
  }, [])
  const fetchCalibrationRecording = useCallback((logId?: string) => {
    const controller = controllerRef.current!
    return logId ? controller.fetchDeviceLogCsv(logId) : controller.fetchThermalCsv()
  }, [])

  const saveCalibrationRun = async (run: CalibrationRun) => {
    await crackleData.saveCalibrationRun(run)
    setCalibrationRuns((current) =>
      current.some((item) => item.id === run.id)
        ? current.map((item) => (item.id === run.id ? run : item))
        : [run, ...current],
    )
  }

  const deleteCalibrationRun = async (id: string) => {
    await crackleData.deleteCalibrationRun(id)
    setCalibrationRuns((current) => current.filter((run) => run.id !== id))
  }

  const saveCalibrationSnapshot = async (snapshot: CalibrationSnapshot) => {
    await crackleData.saveCalibrationSnapshot(snapshot)
    setCalibrationSnapshots((current) =>
      current.some((item) => item.id === snapshot.id)
        ? current.map((item) => (item.id === snapshot.id ? snapshot : item))
        : [snapshot, ...current],
    )
  }

  const deleteCalibrationSnapshot = async (id: string) => {
    await crackleData.deleteCalibrationSnapshot(id)
    setCalibrationSnapshots((current) => current.filter((snapshot) => snapshot.id !== id))
  }

  const appendManualEvent = (event: ManualEvent) => {
    setManualEvents((current) =>
      [...current.filter((row) => row.id !== event.id), event].sort((a, b) => a.atMs - b.atMs).slice(-MANUAL_EVENT_CAP),
    )
    // A command acknowledgement arrives before the next status frame can report RUNNING. Treat
    // every Controls event as volatile until a later authoritative idle observation; otherwise the
    // just-accepted Start looks idle here and its companion document write is predictably refused.
    pendingManualEventsRef.current.set(event.id, event)
  }

  useEffect(() => {
    const idle =
      liveStatus.connected &&
      liveStatus.lifecycle !== 'RUNNING' &&
      !liveStatus.roast?.active &&
      !liveStatus.calibration?.active &&
      !liveStatus.manual?.active &&
      !liveStatus.thermalLog?.active
    if (
      !idle ||
      mutationBlockedReason ||
      flushingManualEventsRef.current ||
      (pendingManualEventsRef.current.size === 0 && !pendingManualEventsClearRef.current)
    )
      return
    const pending = [...pendingManualEventsRef.current.values()]
    const pendingIds = new Set(pending.map((event) => event.id))
    const clearFirst = pendingManualEventsClearRef.current
    flushingManualEventsRef.current = true
    void (async () => {
      if (clearFirst) {
        await crackleData.clearManualEvents()
        pendingManualEventsClearRef.current = false
      }
      await crackleData.saveManualEvents(pending)
      for (const event of pending) pendingManualEventsRef.current.delete(event.id)
      manualHistoryRetryDelayRef.current = 1250
      if (manualHistoryRetryTimerRef.current !== undefined) {
        window.clearTimeout(manualHistoryRetryTimerRef.current)
        manualHistoryRetryTimerRef.current = undefined
      }
      setManualHistorySaveError(undefined)
      setStorageRevision((value) => value + 1)
    })()
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'The idle roaster could not store the Controls history'
        // This write records already-acknowledged Controls history; it is not an edit the user made
        // on the page now in view. Keep it pending and retry known transient contention quietly.
        if (retryableManualHistoryFailure(message)) {
          setManualHistorySaveError(undefined)
          if (manualHistoryRetryTimerRef.current === undefined) {
            const delay = manualHistoryRetryDelayRef.current
            manualHistoryRetryDelayRef.current = Math.min(10000, delay * 2)
            manualHistoryRetryTimerRef.current = window.setTimeout(() => {
              manualHistoryRetryTimerRef.current = undefined
              setManualHistoryFlushNonce((value) => value + 1)
            }, delay)
          }
        } else {
          setManualHistorySaveError(message)
        }
      })
      .finally(() => {
        flushingManualEventsRef.current = false
        const newerEventWaiting = [...pendingManualEventsRef.current.keys()].some((id) => !pendingIds.has(id))
        if (newerEventWaiting && manualHistoryRetryTimerRef.current === undefined) {
          setManualHistoryFlushNonce((value) => value + 1)
        }
      })
  }, [
    liveStatus.calibration?.active,
    liveStatus.lifecycle,
    liveStatus.manual?.active,
    liveStatus.roast?.active,
    liveStatus.thermalLog?.active,
    manualHistoryFlushNonce,
    mutationBlockedReason,
  ])

  const clearManualEvents = () => {
    setManualEvents([])
    pendingManualEventsRef.current.clear()
    const outputsLocked =
      liveStatusRef.current.lifecycle === 'RUNNING' ||
      liveStatusRef.current.roast?.active === true ||
      liveStatusRef.current.manual?.active === true
    if (outputsLocked) {
      pendingManualEventsClearRef.current = true
      return
    }
    persist(crackleData.clearManualEvents())
  }

  /**
   * Adopt a fitted coefficient set as the one this browser plans with.
   *
   * Applying to the browser and then pushing to the roaster is one act, not two: Apply applies to
   * the controller. Splitting it - pre-filling the Settings form, asking the user to unlock, review
   * and approve a second time, then sending the same numbers with a SEPARATE button - describes one
   * decision as two. Calibrate therefore owns the whole act, shows the exact old/new diff in its own
   * confirmation, and calls this only once the ROASTER has accepted the set - so this never runs
   * against a roaster that refused, and there is no half-applied state to explain. Settings keeps
   * its lock for hand-editing, which is the case that lock was written for.
   */
  const applyCalibrationPatch = async (
    patch: Partial<Record<StagedField, number>>,
    source: { runId?: string; capturedAt?: string; deviceId: string; modelId: string },
  ): Promise<{ ok: boolean; message?: string }> => {
    const now = new Date().toISOString()
    const fields = (Object.keys(patch) as StagedField[]).filter((field) => Number.isFinite(patch[field]))
    if (fields.length === 0) return { ok: false, message: 'That calibration carries no coefficients to apply' }
    const updated: CalibrationSettings = {
      ...calibration,
      ...Object.fromEntries(fields.map((field) => [field, patch[field]])),
      updatedAt: now,
      thermalStagedAt: now,
      thermalSourceDeviceId: source.deviceId,
      thermalSourceModelId: source.modelId,
      thermalSourceRunId: source.runId,
      thermalSourceCapturedAt: source.capturedAt,
    }
    try {
      await crackleData.saveCalibration(updated)
    } catch (failure) {
      return {
        ok: false,
        message: failure instanceof Error ? failure.message : 'The calibration could not be saved in this browser',
      }
    }
    setCalibration(updated)
    setStorageRevision((revision) => revision + 1)
    return { ok: true }
  }

  const thermalFields = [
    'heaterGainCPerMinAt10',
    'fanCoolingCPerMinAt10',
    'coolingFanCPerMinAt10',
    'thermalLossPerMinPerC',
  ] as ThermalCoefficientField[]
  const deviceThermalSetComplete = thermalFields.every((field) =>
    Number.isFinite(liveStatus.appliedCoefficients?.[field]),
  )
  const authoritativeCalibration = useMemo<CalibrationSettings>(
    () =>
      deviceThermalSetComplete
        ? {
            ...calibration,
            ...Object.fromEntries(thermalFields.map((field) => [field, liveStatus.appliedCoefficients![field]])),
          }
        : calibration,
    [calibration, deviceThermalSetComplete, liveStatus.appliedCoefficients],
  )
  const appliedThermalPatch = useMemo(
    () => Object.fromEntries(thermalFields.map((field) => [field, authoritativeCalibration[field]])),
    [authoritativeCalibration],
  )

  const deleteRun = async (id: string) => {
    const blocked = catalogMutationReasonRef.current
    if (blocked) {
      setStorageError(blocked)
      return
    }
    try {
      await crackleData.deleteRun(id)
      if (manualWorkingRunRef.current?.id === id) manualWorkingRunRef.current = undefined
      setRuns((current) => current.filter((run) => run.id !== id))
      if (overlayId === id) setOverlayId(undefined)
      if (activeRunId === id) setActiveRunId(undefined)
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The roaster did not accept this roast deletion')
    }
  }

  /**
   * Patches compose against the LATEST known run, never the render-time `runs` closure: overlapping
   * manual commands (an Apply whose acknowledgement lands after Stop) must not rebuild the record
   * from a stale snapshot and resurrect `outcome: 'running'`. A function patch is resolved against
   * that latest run, so list-valued fields (changes, events) append rather than replace.
   */
  const updateRun = async (
    id: string,
    patchOrBuild: Partial<RoastRun> | ((latest: RoastRun) => Partial<RoastRun>),
    propagateError = false,
  ): Promise<boolean> => {
    const working = manualWorkingRunRef.current?.id === id ? manualWorkingRunRef.current : undefined
    const current = working ?? runsRef.current.find((run) => run.id === id)
    if (!current) return false
    const patch = typeof patchOrBuild === 'function' ? patchOrBuild(current) : patchOrBuild
    const correctedName = correctedLegacyRunName(current)
    const persistedPatch: Partial<RoastRun> = correctedName === current.name ? patch : { ...patch, name: correctedName }
    const updated = { ...current, ...persistedPatch }
    if (working && updated.manualRoast) {
      // This is the one explicit working overlay: controller actuation was already acknowledged.
      // It is replaced only by the matching authoritative archive import after final recording. It cannot
      // truthfully acknowledge a details save because the final run document does not exist yet.
      manualWorkingRunRef.current = updated
      setRuns((items) => items.map((run) => (run.id === id ? updated : run)))
      return false
    }
    const blocked = catalogMutationReasonRef.current
    if (blocked) {
      setStorageError(blocked)
      return false
    }
    try {
      await crackleData.updateRun(id, persistedPatch)
      setRuns((items) => items.map((run) => (run.id === id ? { ...run, ...persistedPatch } : run)))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The roaster did not accept this roast change'
      setStorageError(message)
      if (propagateError) throw new Error(message)
      return false
    }
  }
  const saveMeasurements = (id: string, measurements: BatchMeasurements) => updateRun(id, { measurements })
  const saveNotes = (id: string, notes: string) => updateRun(id, { notes })
  const saveRoastDetails = async (
    id: string,
    measurements: BatchMeasurements,
    notes: string,
    score: number | undefined,
  ) => {
    if (manualWorkingRunRef.current?.id === id)
      throw new Error('Wait for the roaster recording to finish before saving these details.')
    const accepted = await updateRun(id, { measurements, notes, score }, true)
    if (!accepted)
      throw new Error('The roaster did not confirm these roast details. Review the sync message and try again.')
  }

  const importArchive = async (archive: ParsedArchive): Promise<string> => {
    const blocked = catalogMutationReasonRef.current
    if (blocked) throw new Error(blocked)
    const summary: string[] = []
    let nextRuns: RoastRun[] | undefined
    let nextProfiles: Profile[] | undefined
    const writes: Array<() => Promise<unknown>> = []
    if (archive.runs.length > 0) {
      const collisions = collisionsById(runs, archive.runs)
      const replace =
        collisions.length > 0 &&
        window.confirm(
          `${collisions.length} imported roast${collisions.length === 1 ? '' : 's'} already exist in this archive. Replace the stored copies?`,
        )
      const { merged, added, replaced } = mergeById(runs, archive.runs, replace)
      nextRuns = byStartedAt(merged)
      for (const run of [...added, ...replaced]) writes.push(() => crackleData.saveRun(run))
      summary.push(`${added.length} roast${added.length === 1 ? '' : 's'} added, ${replaced.length} replaced`)
    }
    if (archive.profiles.length > 0) {
      const collisions = collisionsById(profiles, archive.profiles)
      const replace =
        collisions.length > 0 &&
        window.confirm(
          `${collisions.length} imported profile${collisions.length === 1 ? '' : 's'} already exist. Replace the stored copies?`,
        )
      const { merged, added, replaced } = mergeById(profiles, archive.profiles, replace)
      nextProfiles = merged
      for (const profile of [...added, ...replaced]) writes.push(() => crackleData.saveProfile(profile))
      summary.push(`${added.length} profile${added.length === 1 ? '' : 's'} added, ${replaced.length} replaced`)
    }
    // Each save is an authoritative document exchange with the roaster. Keep
    // imports sequential rather than opening a socket per archive row.
    for (const write of writes) await write()
    if (nextRuns) setRuns(nextRuns)
    if (nextProfiles) setProfiles(nextProfiles)
    if (writes.length > 0) setStorageRevision((value) => value + 1)
    return summary.join(' / ')
  }

  const saveOverrideRevision = async () => {
    if (!revisionDraft || (await saveProfile(revisionDraft))) setPendingRevision(undefined)
  }

  const saveActivePlanRevision = async () => {
    const plan = displayedActiveRoastPlan
    if (!plan || savingActivePlanRevision) return
    if (liveStatus.roast?.endReason !== 'completed') {
      setStorageError(
        'Only a journey the roaster completed can become a reusable profile revision. This roast and its edit history remain saved in History.',
      )
      return
    }
    const blocked = catalogMutationReasonRef.current
    if (blocked) {
      setStorageError(blocked)
      return
    }
    setSavingActivePlanRevision(true)
    const exact = profileFromActiveRoastPlan(plan, undefined, profiles)
    const existing = plan.profileId ? profiles.find((profile) => profile.id === plan.profileId) : undefined
    const now = new Date().toISOString()
    const saved: Profile = existing
      ? { ...exact, id: existing.id, revision: existing.revision + 1, createdAt: existing.createdAt, updatedAt: now }
      : { ...exact, id: newId('profile'), revision: 1, createdAt: now, updatedAt: now }
    const revision: ProfileRevision = {
      id: newId('profile-revision'),
      profileId: saved.id,
      revision: saved.revision,
      savedAt: now,
      summary: existing ? summarizeProfileChange(existing, saved) : 'Created from edited live roast plan',
      profile: structuredClone(saved),
    }
    const decisionKey = activePlanDecisionKey(plan, 'saved')
    try {
      await crackleData.saveProfileWithRevision(saved, revision)
      // The meta entry is the durable, device-owned answer to the completion prompt. Its reserved
      // prefix cannot collide with numeric recording ids and is preserved by whole backup/restore.
      await crackleData.markDeviceLogsImported([decisionKey])
      setProfiles((current) =>
        current.some((profile) => profile.id === saved.id)
          ? current.map((profile) => (profile.id === saved.id ? saved : profile))
          : [saved, ...current],
      )
      setProfileRevisions((current) => [revision, ...current])
      setImportedLogIds((current) => [...new Set([...current, decisionKey])])
      setSelectedEditorId(saved.id)
      setSelectedRoastId(saved.id)
      setHandledActivePlanEditsKey(`${plan.bootId ?? ''}:${plan.sessionId ?? ''}:${plan.planRev ?? ''}`)
      setStorageRevision((value) => value + 1)
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The edited live plan could not be saved')
    } finally {
      setSavingActivePlanRevision(false)
    }
  }

  const discardActivePlanRevision = async () => {
    const plan = displayedActiveRoastPlan
    if (!plan || savingActivePlanRevision) return
    const blocked = catalogMutationReasonRef.current
    if (blocked) {
      setStorageError(blocked)
      return
    }
    setSavingActivePlanRevision(true)
    const decisionKey = activePlanDecisionKey(plan, 'discarded')
    try {
      await crackleData.markDeviceLogsImported([decisionKey])
      setImportedLogIds((current) => [...new Set([...current, decisionKey])])
      setHandledActivePlanEditsKey(`${plan.bootId ?? ''}:${plan.sessionId ?? ''}:${plan.planRev ?? ''}`)
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : 'The discard decision could not be stored on the roaster',
      )
    } finally {
      setSavingActivePlanRevision(false)
    }
  }
  // A roast name in a catalog table is a link to that roast, and the address it goes to says so.
  const openRun = useCallback((run: RoastRun) => navigate('history', run.id), [navigate])

  const useRunAsProfile = (run: RoastRun) => {
    const blocked = controllerModelReasonRef.current('author')
    if (blocked) {
      setStorageError(blocked)
      return
    }
    // Ask before handing off: a Cancel must leave nothing applied.
    if (!leaveAllowed('profiles')) return
    setPendingRevision(run)
    navigate('profiles', undefined, { confirmed: true })
  }

  const roastAgain = (run: RoastRun) => {
    const current = liveStatusRef.current
    if (current.roast?.active || current.lifecycle === 'RUNNING') {
      setStorageError('Wait for the active roast to finish before preparing another roast.')
      return
    }
    const measurements: BatchMeasurements = {
      ...(run.measurements?.startingMassG !== undefined ? { startingMassG: run.measurements.startingMassG } : {}),
      ...(run.measurements?.startingVolumeMl !== undefined
        ? { startingVolumeMl: run.measurements.startingVolumeMl }
        : {}),
    }
    // Ask before handing off: a Cancel must leave the open session and selections untouched.
    if (!leaveAllowed('roast')) return
    setRepeatRoastSetup({ sourceRunId: run.id, profile: structuredClone(run.profile), measurements })
    setSelectedRoastId(run.profile.id)
    setSetupChoiceAfterSession(current.roast?.sessionId)
    setSelectedBeanId(run.beanLotId && beans.some((bean) => bean.id === run.beanLotId) ? run.beanLotId : undefined)
    setManualMode(false)
    setActiveRunId(undefined)
    setManualMessage('')
    setManualError('')
    navigate('roast', undefined, { confirmed: true })
  }

  const abandonSession = () => {
    if (!activeSession || !window.confirm('Mark this disconnected roast session as aborted?')) return
    const elapsedSec = activeSession.samples.at(-1)?.elapsedSec ?? 0
    const event = {
      id: newId('abort'),
      elapsedSec,
      type: 'ABORT' as const,
      label: 'Session marked aborted',
      detail: 'Closed locally because the roaster could not be reached to confirm how it ended.',
    }
    updateRun(activeSession.id, {
      outcome: 'aborted',
      completedAt: new Date().toISOString(),
      events: [...activeSession.events, event],
    })
  }

  const startRoast = async (measurements: BatchMeasurements, beanLotId?: string, name?: string) => {
    if (!selectedProfile || startBlocked || !currentRecordedOn) return
    const bean = beans.find((item) => item.id === beanLotId)
    const run: RoastRun = {
      id: newId('run'),
      name: resolveRunName(name, selectedProfile, new Date(), bean, measurements.startingMassG),
      startedAt: new Date().toISOString(),
      recordedOn: currentRecordedOn,
      profile: structuredClone(selectedProfile),
      beanLotId,
      beanLotSnapshot: bean ? structuredClone(bean) : undefined,
      notes: '',
      controllerVersion: liveStatus.firmwareVersion,
      measurements: { ...measurements, ambientC: liveStatus.ambientC },
      outcome: 'running',
      samples: [],
      events: [],
    }
    try {
      await crackleData.saveRun(run)
      setActiveRunId(run.id)
      setRuns((current) => [run, ...current])
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The roaster did not accept this roast record')
    }
  }

  const setControlsFromRoastPage = async (levels: { fan: number; heat: number }) => {
    if (manualBusy || !currentRecordedOn || liveStatusRef.current.manual?.active !== true) return false
    setManualBusy(true)
    const result = await controllerRef.current!.setManual(levels)
    setManualBusy(false)
    if (!result.ok) {
      setManualError(result.message ?? 'The roaster refused that Controls change')
      setManualMessage('')
      return false
    }
    const requestedFan = result.requestedFan ?? levels.fan
    const requestedHeat = result.requestedHeat ?? levels.heat
    const effective = predictedManualLevels({ fan: requestedFan, heat: requestedHeat })
    appendManualEvent({
      id: newId('control-event'),
      atMs: Date.now(),
      kind: 'apply',
      fan: result.effectiveFan ?? effective.fan,
      heat: result.effectiveHeat ?? effective.heat,
      temperatureC: liveStatusRef.current.temperatureC,
      source: 'local',
      recordedOn: currentRecordedOn,
      detail: `Requested Fan ${requestedFan.toFixed(1)} / Heat ${requestedHeat.toFixed(1)}.`,
    })
    setManualError('')
    setManualMessage(result.message ?? 'Fan and heat updated')
    refreshStatus()
    return true
  }

  const startManualRoast = async (setup: {
    measurements: BatchMeasurements
    beanLotId?: string
    name?: string
    fan: number
    heat: number
    record: boolean
  }) => {
    if (manualBusy || !currentRecordedOn) return
    const requestedAt = new Date().toISOString()
    const bean = beans.find((item) => item.id === setup.beanLotId)
    const namingProfile: TimedProfile = {
      id: 'manual-profile-pending',
      name: 'Manual roast',
      revision: 0,
      strategy: 'timed',
      createdAt: requestedAt,
      updatedAt: requestedAt,
      metadata: { intent: 'Manual roast' },
      notes: 'Per-roast instruction snapshot. Save after the roast to create a reusable profile.',
      points: [{ id: 'manual-point-pending-0', timeSec: 0, fan: setup.fan, heat: setup.heat }],
      coolFan: 9,
      coolDurationSec: 90,
    }
    const runName = resolveRunName(
      setup.name,
      namingProfile,
      new Date(requestedAt),
      bean,
      setup.measurements.startingMassG,
    )
    const args = manualRoastStartArgs({
      name: runName,
      massG: setup.measurements.startingMassG,
      fan: setup.fan,
      heat: setup.heat,
    })
    if (typeof args === 'string') {
      setManualError(args)
      setManualMessage('')
      return
    }
    setManualBusy(true)
    /*
     * A recordable manual roast gets the same treatment as a profiled one: the
     * complete record - volume, ambient, bean lot and snapshot, mass, name - is durably staged on
     * the roaster BEFORE Start, fail closed. A non-recorded roast stages nothing: no recording will
     * ever reconcile it, so its record remains this browser's working session as before.
     */
    let stagedRun: RoastRun | undefined
    if (setup.record) {
      const blocked = catalogMutationReasonRef.current
      if (blocked) {
        setManualBusy(false)
        setManualError(`The roast was not started. Its record must reach the roaster first: ${blocked}`)
        setManualMessage('')
        return
      }
      const leftover = stagedDeviceRunRef.current
      const reusableId =
        leftover &&
        !leftover.started &&
        runsRef.current.some(
          (run) => run.id === leftover.id && run.deviceRoastPending && run.outcome === 'running' && !run.deviceRoast,
        )
          ? leftover.id
          : undefined
      stagedRun = {
        ...provisionalManualRoastRun({
          id: reusableId ?? newId('run'),
          name: args.name,
          profile: namingProfile,
          measurements: { ...setup.measurements, ambientC: liveStatus.ambientC },
          beanLotId: setup.beanLotId,
          beanLot: bean,
          recordedOn: currentRecordedOn,
          firmwareVersion: liveStatus.firmwareVersion,
          bootId: liveStatus.bootId,
          startedAt: requestedAt,
          fan: setup.fan,
          heat: setup.heat,
        }),
      }
      stagedDeviceRunRef.current = { id: stagedRun.id, started: false }
      const staging = await executeDeviceRoastStart(stagedRun, {
        saveRun: (record) => crackleData.saveRun(record),
        deleteRun: (id) => crackleData.deleteRun(id),
        markRunAborted: (id, note) =>
          crackleData.updateRun(id, { outcome: 'aborted', completedAt: new Date().toISOString(), notes: note }),
        start: () => controllerRef.current!.startRoast(args),
      })
      setManualBusy(false)
      if (!staging.ok && staging.stage === 'record') {
        setManualError(`The roast was not started. The roaster did not accept its run record: ${staging.message}`)
        setManualMessage('')
        return
      }
      if (!staging.ok && staging.cleanup === 'kept') {
        // Outcome unknown: the roast may be running. Keep the staged record untouched.
        stagedDeviceRunRef.current = { id: stagedRun.id, started: true }
        const kept = stagedRun
        setRuns((items) => byStartedAt([kept, ...items.filter((item) => item.id !== kept.id)]))
        setManualError(staging.message)
        setManualMessage('')
        refreshStatus()
        return
      }
      if (!staging.ok) {
        if (staging.cleanup === 'removed') {
          stagedDeviceRunRef.current = undefined
          setRuns((items) => items.filter((item) => item.id !== stagedRun!.id))
          setManualError(staging.message)
        } else if (staging.cleanup === 'aborted') {
          stagedDeviceRunRef.current = undefined
          setRuns((items) =>
            byStartedAt([
              { ...stagedRun!, outcome: 'aborted', completedAt: new Date().toISOString() },
              ...items.filter((item) => item.id !== stagedRun!.id),
            ]),
          )
          setManualError(
            `${staging.message} The staged run record could not be removed, so it was marked aborted in History.`,
          )
        } else {
          setRuns((items) => byStartedAt([stagedRun!, ...items.filter((item) => item.id !== stagedRun!.id)]))
          setManualError(
            `${staging.message} The staged run record also could not be removed; starting again will reuse it.`,
          )
        }
        setManualMessage('')
        return
      }
      stagedDeviceRunRef.current = { id: stagedRun.id, started: true }
      const stagedResult = staging.result as CommandResult
      if (stagedResult.logId && currentRecordedOn) {
        pendingDeviceRecordingsRef.current.set(stagedRun.id, {
          deviceId: currentRecordedOn.deviceId,
          logId: stagedResult.logId,
        })
      }
      return finishManualRoastStart(stagedResult, stagedRun, setup, bean, requestedAt, namingProfile, runName)
    }
    const result = await controllerRef.current!.startRoast({ ...args, record: '0' })
    setManualBusy(false)
    if (!result.ok) {
      setManualError(result.message ?? 'The roaster refused the manual roast')
      setManualMessage('')
      if (result.outcomeUnknown) refreshStatus()
      return
    }
    return finishManualRoastStart(result, undefined, setup, bean, requestedAt, namingProfile, runName)
  }

  /** Everything after an acknowledged manual Start: working-session identity and presentation. */
  const finishManualRoastStart = (
    result: CommandResult,
    stagedRun: RoastRun | undefined,
    setup: { measurements: BatchMeasurements; beanLotId?: string; fan: number; heat: number; record: boolean },
    bean: BeanLot | undefined,
    requestedAt: string,
    namingProfile: TimedProfile,
    runName: string,
  ) => {
    if (!currentRecordedOn) return
    const predictedEffective = predictedManualLevels({ fan: setup.fan, heat: setup.heat })
    const deviceBootId = result.bootId ?? liveStatus.bootId
    // The staged record already carries this roast's durable identity; a session acknowledgement
    // enriches it, but its absence does not discard the record.
    const runId = stagedRun?.id ?? manualRoastRunId(deviceBootId, result.sessionId)
    if (!runId) {
      setManualMode(true)
      setManualError(
        'The roaster started the manual roast but did not return its session identity. Refreshing status so this browser can attach safely.',
      )
      setManualMessage('')
      refreshStatus()
      return
    }
    const startedAt =
      result.startedEpoch && result.startedEpoch > 0 ? new Date(result.startedEpoch * 1000).toISOString() : requestedAt
    const deviceName = sanitizeRoastName(result.name || runName)
    const synthetic: TimedProfile = {
      ...namingProfile,
      id: `manual-profile-${runId}`,
      createdAt: startedAt,
      updatedAt: startedAt,
      points: [{ ...namingProfile.points[0], id: `manual-point-${runId}-0` }],
    }
    const change: ManualRoastChange = {
      id: newId('manual-change'),
      elapsedSec: result.elapsedSec ?? 0,
      requestedFan: result.requestedFan ?? setup.fan,
      requestedHeat: result.requestedHeat ?? setup.heat,
      effectiveFan: result.effectiveFan ?? predictedEffective.fan,
      effectiveHeat: result.effectiveHeat ?? predictedEffective.heat,
      temperatureC: liveStatus.temperatureC,
      source: 'local',
    }
    const run: RoastRun = {
      id: runId,
      name: deviceName,
      startedAt,
      recordedOn: currentRecordedOn,
      profile: synthetic,
      beanLotId: setup.beanLotId,
      beanLotSnapshot: bean ? structuredClone(bean) : undefined,
      notes: '',
      controllerVersion: liveStatus.firmwareVersion,
      measurements: { ...setup.measurements, ambientC: liveStatus.ambientC },
      outcome: 'running',
      samples: [],
      events: [
        {
          id: newId('manual-start'),
          elapsedSec: 0,
          type: 'OVERRIDE',
          label: `Fan ${setup.fan.toFixed(1)} / Heat ${setup.heat.toFixed(1)}`,
          detail: 'Initial manual instruction accepted',
        },
      ],
      // The staged marker survives on the working session so reconciliation and session recovery
      // recognize the durable record staged at Start.
      ...(stagedRun?.deviceRoastPending ? { deviceRoastPending: stagedRun.deviceRoastPending } : {}),
      manualRoast: {
        changes: [change],
        deviceBootId,
        deviceName,
        deviceStartedEpoch: result.startedEpoch,
        deviceSessionId: result.sessionId,
        incomplete: true,
        ...(result.logId
          ? {
              pendingRecording: {
                recordingOrigin: { deviceId: currentRecordedOn.deviceId, logId: result.logId },
                storageAddress: { deviceId: currentRecordedOn.deviceId, logId: result.logId },
              },
            }
          : {}),
      },
    }
    manualWorkingRunRef.current = run
    setManualMode(true)
    setManualObservedActiveRunId(undefined)
    const acknowledgedSessionKey = `${deviceBootId}:${result.sessionId}`
    if (manualSampleSessionRef.current !== acknowledgedSessionKey) {
      manualSampleSessionRef.current = acknowledgedSessionKey
      manualHydrationRequestRef.current = ''
      setManualLiveSamples([])
    }
    setManualProfileDraftName(`${deviceName} profile`)
    setActiveRunId(run.id)
    setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
    clearObsoleteActuationStorageAlert()
    setManualError('')
    setManualMessage(
      result.message ??
        'Manual roast started. Keep this page open to make adjustments; the roaster safely holds the last instruction.',
    )
    refreshStatus()
  }

  const setManualRoast = async (levels: { fan: number; heat: number }) => {
    if (!activeSession?.manualRoast || activeSession.outcome !== 'running' || manualBusy || manualControlBlockedReason)
      return false
    setManualBusy(true)
    const result = await controllerRef.current!.setRoast(levels, activeSession.manualRoast.deviceSessionId!)
    setManualBusy(false)
    if (!result.ok) {
      setManualError(result.message ?? 'The roaster refused that change')
      setManualMessage('')
      return false
    }
    const acknowledgementMismatch =
      (activeSession.manualRoast.deviceBootId &&
        result.bootId &&
        activeSession.manualRoast.deviceBootId !== result.bootId) ||
      (activeSession.manualRoast.deviceName &&
        result.name &&
        activeSession.manualRoast.deviceName !== sanitizeRoastName(result.name)) ||
      (activeSession.manualRoast.deviceStartedEpoch &&
        result.startedEpoch &&
        activeSession.manualRoast.deviceStartedEpoch !== result.startedEpoch) ||
      (activeSession.manualRoast.deviceSessionId !== undefined &&
        result.sessionId !== activeSession.manualRoast.deviceSessionId)
    if (acknowledgementMismatch) {
      setManualError(
        'The roaster acknowledged a different manual session. This saved roast was not changed; refresh and review the active roast.',
      )
      setManualMessage('')
      refreshStatus()
      return false
    }
    const elapsedSec = Math.max(
      0,
      result.elapsedSec ?? liveStatus.roast?.elapsedSec ?? liveSamples.at(-1)?.elapsedSec ?? 0,
    )
    const requested = { fan: result.requestedFan ?? levels.fan, heat: result.requestedHeat ?? levels.heat }
    const predictedEffective = predictedManualLevels(requested)
    const effective = {
      fan: result.effectiveFan ?? predictedEffective.fan,
      heat: result.effectiveHeat ?? predictedEffective.heat,
    }
    const change: ManualRoastChange = {
      id: newId('manual-change'),
      elapsedSec,
      requestedFan: requested.fan,
      requestedHeat: requested.heat,
      effectiveFan: effective.fan,
      effectiveHeat: effective.heat,
      temperatureC: liveStatus.temperatureC,
      source: 'local',
    }
    const appliedSession = activeSession.manualRoast
    const patch = (latest: RoastRun): Partial<RoastRun> => ({
      manualRoast: {
        ...(latest.manualRoast ?? appliedSession),
        changes: [...(latest.manualRoast?.changes ?? appliedSession.changes), change],
      },
      events: [
        ...latest.events,
        {
          id: newId('manual-change-event'),
          elapsedSec,
          type: 'OVERRIDE',
          label: `Fan ${requested.fan.toFixed(1)} / Heat ${requested.heat.toFixed(1)}`,
          detail:
            effective.fan === requested.fan
              ? 'Manual instruction accepted'
              : `Manual instruction accepted; safety airflow applied fan ${effective.fan.toFixed(1)}`,
        },
      ],
    })
    updateRun(activeSession.id, patch)
    clearObsoleteActuationStorageAlert()
    setManualError('')
    setManualMessage(result.message ?? 'Fan and heat updated')
    refreshStatus()
    return true
  }

  const stopManualRoast = async () => {
    if (manualStopBusy) return
    const authoritative = liveStatusRef.current
    const roast = authoritative.roast
    if (!roast?.active) return
    if (roast.mode === 'manual' && !roast.sessionId) {
      setManualError(
        'The roaster has not reported the active manual session identity yet. Stop was not sent without that safety identity.',
      )
      setManualMessage('')
      refreshStatus()
      return
    }
    const expectedBootId = authoritative.bootId
    const expectedSessionId = roast.sessionId
    setManualStopBusy(true)
    const result = await controllerRef.current!.stopRoast(roast.mode === 'manual' ? expectedSessionId : undefined)
    setManualStopBusy(false)
    if (!result.ok) {
      setManualError(result.message ?? 'The roaster did not acknowledge Stop')
      setManualMessage('')
      return false
    }
    const acknowledgementMismatch =
      (result.bootId && result.bootId !== expectedBootId) ||
      (expectedSessionId !== undefined && result.sessionId !== expectedSessionId)
    if (acknowledgementMismatch) {
      setManualError(
        'Stop was acknowledged for a different controller session. Refreshing the roaster state before allowing another command.',
      )
      setManualMessage('')
      refreshStatus()
      return
    }
    if (!result.endReason) {
      clearObsoleteActuationStorageAlert()
      setManualError('')
      setManualMessage(
        result.message ?? 'Stop was acknowledged. Waiting for the roaster to report how the roast ended.',
      )
      refreshStatus()
      return
    }
    const workingSession =
      activeSession?.manualRoast &&
      activeSession.outcome === 'running' &&
      activeSession.manualRoast.deviceSessionId === expectedSessionId
        ? activeSession
        : undefined
    if (!workingSession) {
      clearObsoleteActuationStorageAlert()
      setManualError('')
      setManualMessage(result.message ?? 'Stop was acknowledged. Heat is off; the fan is cooling for 10 seconds.')
      refreshStatus()
      return false
    }
    const elapsedSec = Math.max(1, result.elapsedSec ?? roast.elapsedSec ?? liveSamples.at(-1)?.elapsedSec ?? 1)
    const outcome = result.endReason === 'stopped' ? ('complete' as const) : ('aborted' as const)
    const endReason = result.endReason
    const stopEvent: RoastRun['events'][number] = {
      id: newId('manual-stop-event'),
      elapsedSec,
      type: outcome === 'complete' ? 'SYSTEM' : 'SAFETY',
      label: outcome === 'complete' ? 'Manual roast stopped' : 'Manual roast ended safely',
      detail:
        outcome === 'complete'
          ? 'Heat is off; the fan cools for 10 seconds, then stops.'
          : `The roaster reported ${endReason.replaceAll('_', ' ')}.`,
    }
    const patch = (latest: RoastRun): Partial<RoastRun> => {
      const manual = latest.manualRoast ?? workingSession.manualRoast!
      return {
        completedAt: new Date().toISOString(),
        outcome,
        samples: manualLiveSamples,
        events: [...latest.events, stopEvent],
        manualRoast: { ...manual, changes: manual.changes ?? [], stoppedElapsedSec: elapsedSec, endReason },
      }
    }
    updateRun(workingSession.id, patch)
    clearObsoleteActuationStorageAlert()
    setManualProfileDraftName((current) => current || `${workingSession.name} profile`)
    setManualError('')
    setManualMessage(
      result.message ??
        (outcome === 'complete'
          ? 'Manual roast stopped. Heat is off; the fan is cooling for 10 seconds.'
          : `Manual roast ended: ${result.endReason.replaceAll('_', ' ')}.`),
    )
    refreshStatus()
  }

  /**
   * Header Stop stays the unconditional safety command: it must never wait for a confirmation,
   * current session identity, or catalog state. When it acknowledges an active manual roast, apply
   * the same operator-owned terminal state as the roast panel's session-fenced Stop. The recording
   * remains controller-owned and the normal archive importer replaces this working run only after
   * the matching recording is durable.
   */
  const stopFromHeader = async (): Promise<CommandResult> => {
    const authoritative = liveStatusRef.current
    const roast = authoritative.roast
    const result = await controllerRef.current!.stopAll()
    if (!result.ok) return result

    if (roast?.active && roast.mode === 'manual') {
      const workingSession = manualWorkingRunRef.current
      if (
        workingSession?.manualRoast &&
        workingSession.outcome === 'running' &&
        workingSession.manualRoast.deviceSessionId === roast.sessionId
      ) {
        const elapsedSec = Math.max(1, roast.elapsedSec ?? manualLiveSamples.at(-1)?.elapsedSec ?? 1)
        const stopEvent: RoastRun['events'][number] = {
          id: newId('manual-stop-event'),
          elapsedSec,
          type: 'SYSTEM',
          label: 'Manual roast stopped',
          detail: 'Heat is off; the fan cools for 10 seconds, then stops.',
        }
        const headerManual = workingSession.manualRoast
        updateRun(workingSession.id, (latest) => {
          const manual = latest.manualRoast ?? headerManual
          return {
            completedAt: new Date().toISOString(),
            outcome: 'complete',
            samples: manualLiveSamples,
            events: [...latest.events, stopEvent],
            manualRoast: {
              ...manual,
              changes: manual.changes ?? [],
              stoppedElapsedSec: elapsedSec,
              endReason: 'stopped',
            },
          }
        })
        setManualProfileDraftName((current) => current || `${workingSession.name} profile`)
        setManualError('')
        setManualMessage('Manual roast stopped. Heat is off; the fan is cooling for 10 seconds.')
      }
    }

    refreshStatus()
    return result
  }

  const saveManualProfile = async () => {
    if (!activeSession?.manualRoast) return
    if (activeSession.manualRoast.incomplete || !activeSession.manualRoast.logId) {
      setManualError(
        'The roaster recording must finish and be imported before these instructions can be saved as a profile.',
      )
      setManualMessage('')
      return
    }
    // Saving closes this session and opens Profiles, which discards unsaved roast details. Ask
    // BEFORE anything is saved or closed; on Cancel nothing happens at all.
    if (!leaveAllowed('profiles')) return
    const completed = {
      ...activeSession,
      samples: manualLiveSamples.length > 0 ? manualLiveSamples : activeSession.samples,
    }
    const profile = profileFromManualRoast(completed, {
      profileId: newId('profile'),
      name: manualProfileDraftName,
      createdAt: new Date().toISOString(),
    })
    if (typeof profile === 'string') {
      setManualError(profile)
      setManualMessage('')
      return
    }
    if (!(await saveProfile(profile))) return
    setActiveRunId(undefined)
    setManualMode(false)
    setManualMessage('')
    setManualError('')
    navigate('profiles', undefined, { confirmed: true })
  }

  /** Reconcile a fault/lease/expiry ending that happened without this browser pressing Stop. */
  useEffect(() => {
    if (!activeSession?.manualRoast || activeSession.outcome !== 'running') return
    if (manualObservedActiveRunId !== activeSession.id) return
    const roast = liveStatus.roast
    if (roast?.mode !== 'manual' || roast.active || roast.endReason === undefined) return
    if (activeSession.manualRoast.deviceBootId && activeSession.manualRoast.deviceBootId !== liveStatus.bootId) return
    if (
      activeSession.manualRoast.deviceName &&
      sanitizeRoastName(roast.name ?? '') !== activeSession.manualRoast.deviceName
    )
      return
    if (activeSession.manualRoast.deviceSessionId && roast.sessionId !== activeSession.manualRoast.deviceSessionId)
      return
    const elapsedSec = Math.max(1, roast.elapsedSec ?? manualLiveSamples.at(-1)?.elapsedSec ?? 1)
    const outcome = roast.endReason === 'stopped' ? ('complete' as const) : ('aborted' as const)
    const endReason = roast.endReason
    const sessionManual = activeSession.manualRoast
    // Resolved against the latest working run, so a Stop recorded meanwhile is not rebuilt from
    // this render's snapshot (and is not stopped twice).
    const patch = (latest: RoastRun): Partial<RoastRun> =>
      latest.outcome !== 'running'
        ? {}
        : {
            completedAt: new Date().toISOString(),
            outcome,
            samples: manualLiveSamples,
            events: [
              ...latest.events,
              {
                id: `manual-end-${latest.id}-${endReason}`,
                elapsedSec,
                type: outcome === 'complete' ? 'SYSTEM' : 'SAFETY',
                label: outcome === 'complete' ? 'Manual roast stopped' : 'Manual roast ended safely',
                detail: `The roaster reported ${endReason.replaceAll('_', ' ')}.`,
              },
            ],
            manualRoast: { ...(latest.manualRoast ?? sessionManual), stoppedElapsedSec: elapsedSec, endReason },
          }
    updateRun(activeSession.id, patch)
    setManualProfileDraftName((current) => current || `${activeSession.name} profile`)
    setManualMessage(
      outcome === 'complete' ? 'Manual roast stopped.' : `Manual roast ended: ${roast.endReason.replaceAll('_', ' ')}.`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- this reacts only to the device end edge
  }, [
    activeSession?.id,
    activeSession?.outcome,
    liveStatus.roast?.active,
    liveStatus.roast?.endReason,
    liveStatus.roast?.mode,
  ])

  const manualRecordingFinalizationState = manualRecordingFinalization(activeSession, liveStatus, archiveListDeferred)

  const visibleStorageError = visibleGlobalStorageError(storageError)
  if (!ready)
    return (
      <div className="app-loading">
        <span className="brand-seal">
          <CrackleMark size={30} />
        </span>
        <strong>Crackle</strong>
        <small>{visibleStorageError ?? 'Opening roast desk'}</small>
        {visibleStorageError && (
          <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
            Retry
          </button>
        )}
      </div>
    )

  return (
    <>
      <AppShell
        view={view}
        onView={navigate}
        lifecycle={liveStatus.lifecycle}
        status={liveStatus}
        nowMs={nowMs}
        readoutTarget={readoutTarget}
        activeRoaster={activeRoasterPresentation}
        roasterTargets={roasterTargetPresentations}
        onActiveRoasterChange={(id) => {
          void switchRoasterTarget(id)
        }}
        activeRoasterChangeBlockedReason={configuredTargetSwitchBlockedReason}
        onStopAll={stopFromHeader}
      >
        {fault && (
          <div className={`fault-banner ${fault.severity}`} role="alert">
            <strong>{fault.headline}</strong>
            <span>{fault.detail}</span>
          </div>
        )}
        {weakWifi && (
          <div className="storage-error-banner" role="status">
            <span>{weakWifi}</span>
          </div>
        )}
        {visibleStorageError && (
          <div className="storage-error-banner" role="alert">
            <span>{visibleStorageError}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss storage error"
              onClick={() => setStorageError(undefined)}
            >
              x
            </button>
          </div>
        )}
        {manualHistorySaveError && (
          <div className="storage-error-banner" role="alert">
            <span>
              <strong>Controls worked, but their event history is not saved yet. </strong>
              {manualHistorySaveError}
            </span>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setManualHistorySaveError(undefined)
                setManualHistoryFlushNonce((value) => value + 1)
              }}
            >
              Retry saving
            </button>
          </div>
        )}
        {targetSwitchFailure && (
          <div className="storage-error-banner" role="alert">
            <span>
              <strong>Roaster not switched. </strong>
              {targetSwitchFailure.message}
              {targetSwitchFailure.detail && <small>Diagnostic: {targetSwitchFailure.detail}</small>}
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={targetSwitching}
              onClick={() => void switchRoasterTarget(targetSwitchFailure.targetId)}
            >
              Retry
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss roaster connection error"
              onClick={() => setTargetSwitchFailure(undefined)}
            >
              x
            </button>
          </div>
        )}
        {/*
      Two quiet lines, never a modal. The roaster being unreachable is not data loss: the library
      stays readable and an open editor keeps its working draft, but no device-owned state changes
      until the browser has re-established the roaster's current library.
    */}
        {dataSync.attached && dataSync.offline && (
          <div className="storage-error-banner" role="status">
            <span>
              The roaster is not answering, so this browser copy is read-only. Open editor drafts remain in the page,
              but nothing will be committed until the roaster reconnects and its library is current.
            </span>
          </div>
        )}
        {!liveStatus.connected && !dataSync.attached && (
          <div className="sync-state-banner queued" role="status">
            <strong>Browser library not yet verified</strong>
            <span>
              The roaster is offline. This browser copy remains available, but it has not been checked against the
              roaster's library.
            </span>
          </div>
        )}
        {/*
      This counter is retained for explicit whole-library adoption/dev reseed and migration of an
      outbox written by an older build. Ordinary user edits use acknowledged revisioned writes and
      never become committed browser state while waiting for an idle roaster.
    */}
        {dataSync.queued > 0 && !dataSync.offline && (
          <div className="sync-state-banner queued" role="status">
            <strong>
              {dataSync.queued} working {dataSync.queued === 1 ? 'edit is' : 'edits are'} safe in this browser
            </strong>
            <span>{dataSync.queued === 1 ? 'It will' : 'They will'} be written to the roaster when it next idles.</span>
          </div>
        )}
        {dataSync.message && (
          <div className="sync-state-banner terminal" role="status">
            <strong>Library sync needs attention</strong>
            <span>{dataSync.message}</span>
          </div>
        )}
        {/*
      Migration notices for an outbox written by an older build. If the roaster changed before that
      finished payload returned, device truth wins and the user is told which legacy intent was
      dropped. Current-session ordinary edits never enter this path.
    */}
        {(dataSync.notices ?? []).map((notice) => (
          <div key={notice} className="storage-error-banner" role="status">
            <span>{notice}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss edit notice"
              onClick={() => crackleData.dismissNotice(notice)}
            >
              x
            </button>
          </div>
        ))}
        {view === 'roast' && (
          <RoastView
            profile={selectedProfile}
            profiles={roastSetupProfiles}
            beans={orderedBeans}
            targetIntent={targetIntent}
            overlay={overlay}
            runs={runs}
            activeSession={activeSession}
            status={liveStatus}
            activePlan={displayedActiveRoastPlan}
            activePlanLoading={activeRoastPlanLoading || (activePlanExpected && !displayedActiveRoastPlan)}
            activePlanReconciling={activePlanDisplay.reconciling}
            activePlanError={activeRoastPlanError}
            liveHistoryNotice={profiledHistoryNotice}
            onActivePlanAccepted={(plan, previousPlanRev) => {
              setActiveRoastPlan(plan)
              setAcceptedPlanBridge({ plan, previousPlanRev, acceptedAtMs: Date.now() })
              setActiveRoastPlanError(undefined)
            }}
            onRefreshActivePlan={refreshActiveRoastPlan}
            onSaveActivePlanRevision={saveActivePlanRevision}
            onDiscardActivePlanRevision={discardActivePlanRevision}
            activePlanRevisionHandled={
              activePlanDecisionHandled ||
              handledActivePlanEditsKey ===
                `${displayedActiveRoastPlan?.bootId ?? ''}:${displayedActiveRoastPlan?.sessionId ?? ''}:${displayedActiveRoastPlan?.planRev ?? ''}`
            }
            activePlanRevisionSaving={savingActivePlanRevision}
            calibration={calibration}
            calibrationSnapshots={calibrationSnapshots}
            calibrationRuns={calibrationRuns}
            ambientC={ambientReferenceC}
            elapsedSec={
              lastSample?.elapsedSec ?? (liveStatus.roast?.active ? Math.floor(liveStatus.roast.elapsedSec ?? 0) : 0)
            }
            samples={liveSamples}
            events={liveEvents}
            startBlockedReason={manualMode ? manualStartBlocked : startBlocked}
            modelBlockedReason={modelBlockedReason('apply-calibration')}
            setupMeasurements={repeatRoastSetup?.measurements}
            defaultMassG={defaultMassG}
            selectedBeanId={selectedBeanId}
            onBean={setSelectedBeanId}
            onProfile={(id) => {
              setRepeatRoastSetup(undefined)
              setSelectedRoastId(id)
              setSetupChoiceAfterSession(liveStatus.roast?.active ? undefined : liveStatus.roast?.sessionId)
            }}
            manualMode={manualMode}
            onManualMode={(manual) => {
              setRepeatRoastSetup(undefined)
              setManualMode(profiles.length === 0 ? true : manual)
              setManualMessage('')
              setManualError('')
            }}
            onOverlay={setOverlayId}
            onStart={startRoast}
            onStartDeviceRoast={startDeviceRoast}
            onStartManual={(setup) => {
              void startManualRoast(setup)
            }}
            onSetManual={(levels) =>
              liveStatus.manual?.active && !activeSession?.manualRoast
                ? setControlsFromRoastPage(levels)
                : setManualRoast(levels)
            }
            onStopManual={() => {
              void stopManualRoast()
            }}
            manualBusy={manualBusy}
            manualStopBusy={manualStopBusy}
            manualMessage={manualMessage}
            manualError={manualError}
            manualControlBlockedReason={manualControlBlockedReason}
            manualOwnershipBlockedReason={manualOwnershipBlockedReason}
            manualRecordingFinalization={manualRecordingFinalizationState}
            detailsSaveBlockedReason={activeSession?.outcome !== 'running' ? mutationBlockedReason : undefined}
            manualProfileBlockedReason={
              activeSession?.manualRoast && (activeSession.manualRoast.incomplete || !activeSession.manualRoast.logId)
                ? 'The complete controller recording must arrive before these instructions can be saved as a profile.'
                : activeSession?.manualRoast
                  ? mutationBlockedReason
                  : undefined
            }
            manualCalibrationBlockedReason={
              activeSession?.manualRoast &&
              (activeSession.manualRoast.incomplete ||
                !activeSession.deviceRoast ||
                !activeSession.measurements?.startingMassG)
                ? 'A complete controller recording and starting batch weight are required before this roast can be used as calibration evidence.'
                : undefined
            }
            manualProfileDraftName={manualProfileDraftName}
            onManualProfileDraftName={setManualProfileDraftName}
            onSaveManualProfile={saveManualProfile}
            onUseManualAsCalibrationEvidence={() => {
              if (activeSession && leaveAllowed('calibrate')) {
                setPendingCalibrationRoastId(activeSession.id)
                navigate('calibrate', undefined, { confirmed: true })
              }
            }}
            onSkipManualProfile={() => {
              setActiveRunId(undefined)
              setManualMessage('')
              setManualError('')
            }}
            onMeasurements={(measurements) => activeRunId && saveMeasurements(activeRunId, measurements)}
            onNotes={(notes) => activeRunId && saveNotes(activeRunId, notes)}
            onSaveDetails={async (measurements, notes, score) => {
              if (!activeRunId) throw new Error('No roast is open to save.')
              await saveRoastDetails(activeRunId, measurements, notes, score)
            }}
            onDetailsDirtyChange={setRoastDetailsDirty}
            onPlannedStepsDirtyChange={setManualPlanDirty}
            onCloseSession={() => setActiveRunId(undefined)}
            onAbandonSession={abandonSession}
            revisionAvailable={Boolean(revisionDraft)}
            onSaveRevision={saveOverrideRevision}
            onDismissRevision={() => setPendingRevision(undefined)}
            deviceLogs={deviceLogs}
            importedLogIds={importedLogIds}
            nowMs={nowMs}
            onRefreshStatus={refreshStatus}
            onOpenCalibrate={() => navigate('calibrate')}
            controller={controllerRef.current}
          />
        )}
        {view === 'profiles' && catalogPendingReason && (
          <LibraryPending eyebrow="Profile workshop" title="Profiles" reason={catalogPendingReason} />
        )}
        {view === 'profiles' && !catalogPendingReason && (
          <ProfileEditor
            profiles={orderedProfiles}
            selectedId={selectedEditorId}
            suggestions={suggestions}
            runs={runs}
            calibration={calibration}
            revisions={profileRevisions}
            snapshots={calibrationSnapshots}
            deviceCoefficients={liveStatus.appliedCoefficients}
            defaultMassG={defaultMassG}
            runBytes={dataSync.runBytes}
            deviceLogs={deviceLogs}
            deleteBlockedReason={deleteBlocked}
            mutationBlockedReason={mutationBlockedReason ?? modelBlockedReason('author')}
            previewBlockedReason={modelBlockedReason('preview')}
            onDeleteProfile={deleteProfile}
            onCascadeDelete={cascadeDelete}
            onDirtyChange={setProfileDirty}
            revisionDraft={revisionDraft}
            onRevisionConsumed={() => setPendingRevision(undefined)}
            onSelect={setSelectedEditorId}
            onSave={saveProfile}
            onExport={() => profileDownload(profiles)}
            onReorder={reorderProfiles}
            onOpenRun={openRun}
          />
        )}
        {view === 'reference' && <ReferenceView />}
        {view === 'beans' && catalogPendingReason && (
          <LibraryPending eyebrow="Green coffee catalog" title="Bean lots" reason={catalogPendingReason} />
        )}
        {view === 'beans' && !catalogPendingReason && (
          <BeansView
            beans={orderedBeans}
            runs={runs}
            revisions={beanRevisions}
            selectedId={selectedBeanId}
            runBytes={dataSync.runBytes}
            deviceLogs={deviceLogs}
            deleteBlockedReason={deleteBlocked}
            mutationBlockedReason={mutationBlockedReason}
            onSelect={setSelectedBeanId}
            onSave={saveBean}
            onDelete={deleteBean}
            onCascadeDelete={cascadeDelete}
            onDirtyChange={setBeanDirty}
            onOpenRun={openRun}
            onReorder={reorderBeans}
          />
        )}
        {view === 'manual' && (
          <ManualView
            status={liveStatus}
            nowMs={nowMs}
            modelBlockedReason={modelBlockedReason('start')}
            controller={controllerRef.current}
            events={manualEvents}
            onEvent={appendManualEvent}
            onClearEvents={clearManualEvents}
            onOpenRoast={() => {
              if (navigate('roast')) setManualMode(true)
            }}
          />
        )}
        {view === 'calibrate' && (
          <CalibrationView
            controller={controllerRef.current}
            initialLoadedRoastId={pendingCalibrationRoastId}
            onInitialLoadedRoastConsumed={() => setPendingCalibrationRoastId(undefined)}
            status={liveStatus}
            nowMs={nowMs}
            calibrationBlockedReason={actuatorMutationBlockedReason ?? modelBlockedReason('calibrate')}
            applyCalibrationBlockedReason={mutationBlockedReason ?? modelBlockedReason('apply-calibration')}
            catalogMutationBlockedReason={mutationBlockedReason}
            runs={calibrationRuns}
            snapshots={calibrationSnapshots}
            appliedPatch={appliedThermalPatch}
            onSaveRun={saveCalibrationRun}
            onDeleteRun={deleteCalibrationRun}
            onSaveSnapshot={saveCalibrationSnapshot}
            onDeleteSnapshot={deleteCalibrationSnapshot}
            onFetchCalibrationRecording={fetchCalibrationRecording}
            onApply={applyCalibrationPatch}
            appliedCalibration={authoritativeCalibration}
            roasts={runs}
          />
        )}
        {view === 'history' && catalogPendingReason && (
          <LibraryPending eyebrow="Archive" title="Roast history" reason={catalogPendingReason} />
        )}
        {view === 'history' && !catalogPendingReason && (
          <HistoryView
            runs={runs}
            overlayId={overlayId}
            focusRunId={focusRunId}
            activeRoasterId={liveStatus.roaster?.deviceId}
            activeRoasterName={liveStatus.roaster?.displayName}
            detailPendingReason={(run) => historyDetailPendingReason(run, liveStatus, archiveListDeferred)}
            onOverlay={setOverlayId}
            onDelete={deleteRun}
            onSaveDetails={saveRoastDetails}
            onDirtyChange={setHistoryDirty}
            onImport={importArchive}
            onUseAsProfile={useRunAsProfile}
            onRoastAgain={roastAgain}
          />
        )}
        {view === 'settings' && (
          <SettingsView
            status={liveStatus}
            liveConnection={liveConnection}
            activeRoaster={activeRoasterPresentation}
            roasterTargets={roasterTargetPresentations}
            onActiveRoasterChange={(id) => {
              void switchRoasterTarget(id)
            }}
            activeRoasterChangeBlockedReason={configuredTargetSwitchBlockedReason}
            firmwareUpdateHref={targetHttpUrl(configuredTarget, '/update')}
            rawStatusHref={targetHttpUrl(configuredTarget, '/api/status')}
            profiles={profiles}
            beans={beans}
            runs={runs}
            calibrationPasses={calibrationRuns}
            calibrationSnapshots={calibrationSnapshots}
            deviceLogs={deviceLogs}
            deviceLogsListed={!archiveSupported || deviceArchiveListed}
            importedLogIds={importedLogIds}
            onExportEverything={exportEverything}
            onExportType={exportOneType}
            onImportBackup={importBackupFile}
            onRestoreBackup={restoreFromBackup}
            onFormatStorage={formatStorage}
            restoreBlockedReason={restoreBlockedReason}
            prunableLogIds={prunableLogIds}
            onPruneDeviceLogs={(logIds) => {
              void pruneDeviceLogs(logIds)
            }}
            onDeleteRun={deleteRun}
            onDeleteProfile={deleteProfile}
            onDeleteBean={deleteBean}
            onDeleteCalibrationSnapshot={deleteCalibrationSnapshot}
            storedCalibration={calibration}
            onCalibrationChange={(value) => {
              setCalibration(value)
              setStorageRevision((revision) => revision + 1)
            }}
            onOpenCalibrate={() => navigate('calibrate')}
            onReloadDemoData={richSeedEnabled() ? reloadDemoData : undefined}
            onPowerCycleMock={richSeedEnabled() && liveStatus.roaster?.simulated ? powerCycleMock : undefined}
            onSetMockProbeAvailable={
              richSeedEnabled() && liveStatus.roaster?.simulated ? setMockProbeAvailable : undefined
            }
            onDropMockLiveStream={richSeedEnabled() && liveStatus.roaster?.simulated ? dropMockLiveStream : undefined}
            dataSync={dataSync}
            onAdoptData={adoptLocalData}
            onDismissAdoption={dismissAdoption}
            onThermocoupleOffsetChange={saveThermocoupleOffset}
            thermocoupleOffsetBlockedReason={thermocoupleOffsetBlocked}
          />
        )}
      </AppShell>
      {backupConflictPrompt && (
        <BackupConflictDialog
          count={backupConflictPrompt.count}
          names={backupConflictPrompt.names}
          onDecision={(decision) => {
            const { resolve } = backupConflictPrompt
            setBackupConflictPrompt(undefined)
            resolve(decision)
          }}
        />
      )}
    </>
  )
}
