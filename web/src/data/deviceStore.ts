/**
 * ============================================================================================
 * THE CONTROLLER IS THE DATABASE
 * ============================================================================================
 *
 * Requirement: all app data lives on the controller, so every browser - phone or desktop - sees the
 * same library.
 *
 * Everything the user authors - profiles, bean lots, roast records, calibration fits - lives under
 * `/data` on the controller. **This browser is a cache over it.** IndexedDB still exists and is still
 * written on every change, but it is a mirror: on boot the DEVICE wins, and a browser holding
 * something the controller does not is holding something stale, not something authoritative.
 *
 * Everything below follows from that one inversion.
 *
 * --------------------------------------------------------------------------------------------
 * THE WORKING COPY
 * --------------------------------------------------------------------------------------------
 *
 * The device is authoritative but it is not fast, and it is on the other end of a Wi-Fi link that a
 * phone will lose in a coat pocket. So the data layer keeps an in-memory working copy, loaded once
 * on attach: the four collection documents, plus the run index. Run documents themselves are pulled
 * only when the cache does not already hold that exact version - the index reports a version per
 * run, so a library of a hundred roasts costs one request on a warm cache and one request per
 * CHANGED roast on a cold one.
 *
 * Screen reads use the working copy; background reconciliation and every device-backed write use the network.
 *
 * --------------------------------------------------------------------------------------------
 * WRITES: VERSION-CHECKED AND ACKNOWLEDGED
 * --------------------------------------------------------------------------------------------
 *
 * An ordinary device-backed mutation starts only while the reconciled manifest revision is current.
 * The authoritative mirror is restored before transport, the mutation is applied to a clone, and
 * that clone becomes working/render state only after the roaster acknowledges the versioned write.
 *
 *   1. **`409 conflict`** - refetch, replay the mutation once on fresh device state, and retry. A
 *      second conflict is surfaced rather than looped or allowed to overwrite the roaster.
 *   2. **`409 busy`** - the roaster is actuating or recording. The save fails as an uncommitted
 *      working edit; it is not promoted to browser-authoritative state or scheduled to fire later.
 *   3. **unreachable / `503`** - cached reads remain available, while mutation fails closed until
 *      the roaster and its manifest are current again.
 *
 * The older queue/outbox machinery below remains only for explicit whole-library adoption/dev reseed
 * and for safely resolving an outbox written by an earlier build. Normal profile, bean, roast,
 * calibration, import, and delete actions use `commitRevisioned` and require device acknowledgement.
 *
 * --------------------------------------------------------------------------------------------
 * WHEN THERE IS NO STORE
 * --------------------------------------------------------------------------------------------
 *
 * `status.data_store` is the feature detection, mirroring `log_archive` exactly. Firmware without it
 * - such as a 2026-07-26.35 device reached through `npm run dev:device` - never gets a `/api/data`
 * request, and the app runs on IndexedDB alone, with Settings saying so out loud.
 */

import { deviceRoastSamplesFromThermal } from '../domain/deviceRoastImport'
import { stableEquals } from '../domain/draft'
import { recordingKey } from '../domain/provenance'
import type {
  BeanLot,
  BeanRevision,
  CalibrationRun,
  CalibrationSettings,
  CalibrationSnapshot,
  ControllerStatus,
  ManualEvent,
  Profile,
  ProfileRevision,
  RecordingOrigin,
  RecordingStorageAddress,
  RoastRun,
  ThermalSample,
} from '../domain/types'
import {
  byteLength,
  COLLECTIONS,
  type CollectionName,
  type DocumentTarget,
  parseBeansDocument,
  parseCalibrationsDocument,
  parseMetaDocument,
  parseProfilesDocument,
  parseRunDocument,
  serializeBeansDocument,
  serializeCalibrationsDocument,
  serializeMetaDocument,
  serializeProfilesDocument,
  serializeRunDocument,
} from './documentSerializer'
import { type CrackleRepository, MANUAL_EVENT_CAP, REVISION_CAP, repository } from './repository'

// ------------------------------------------------------------------------------- the transport

export type DocumentRead =
  | { kind: 'ok'; payload: string; version: number }
  /** Never written. Distinct from empty: an empty document is a document. */
  | { kind: 'missing' }
  /** The envelope would not decode. Reads as version 0, so `base=0` overwrites it. */
  | { kind: 'corrupt'; version: number }
  | { kind: 'unmounted' }
  | { kind: 'unreachable' }
  | { kind: 'error'; message: string }

export type DocumentWrite =
  | { kind: 'ok'; version: number; stateRev?: string }
  | { kind: 'conflict'; version: number; stateRev?: string }
  /** The idle gate: actuation or recording is active and flash writes wait. */
  | { kind: 'busy'; message?: string }
  | { kind: 'too-large'; message?: string }
  | { kind: 'no-space'; message?: string }
  | { kind: 'unmounted' }
  | { kind: 'unreachable' }
  | { kind: 'error'; message: string }

export interface RunIndexEntry {
  id: string
  /** Payload length, not on-disk footprint. */
  bytes: number
  version: number
}

export type RunIndexRead =
  | { kind: 'ok'; runs: RunIndexEntry[]; total: number; truncated: boolean }
  | { kind: 'unmounted' }
  | { kind: 'unreachable' }
  | { kind: 'error'; message: string }

export interface ManifestCollectionEntry {
  bytes: number
  version: number
}
export interface ManifestRunEntry extends RunIndexEntry {}
export interface ManifestLogEntry {
  id: string
  bytes: number
}
export interface DeviceManifestPage {
  stateRev: string
  bootId?: string
  collections: Partial<Record<CollectionName, ManifestCollectionEntry | null>>
  runs: ManifestRunEntry[]
  logs: ManifestLogEntry[]
  nextCursor?: string
  maintenance?: 'restoring' | 'incomplete'
}
export type ManifestRead =
  | { kind: 'ok'; page: DeviceManifestPage }
  | { kind: 'unmounted' }
  | { kind: 'unreachable' }
  | { kind: 'error'; message: string }

export interface RestoreMaintenanceResult {
  ok: boolean
  token?: string
  stateRev?: string
  message?: string
  incomplete?: boolean
}

/** What the data layer needs from a controller. Implemented by `HttpControllerClient`, and faked whole in tests. */
export interface DeviceStoreClient {
  readDocument(target: DocumentTarget): Promise<DocumentRead>
  writeDocument(target: DocumentTarget, payload: string, base: number): Promise<DocumentWrite>
  listRunDocuments(): Promise<RunIndexRead>
  deleteDocument(target: DocumentTarget, base: number): Promise<DocumentWrite>
  /** Presence feature-detects the revisioned source-of-truth protocol. */
  readManifestPage?(cursor?: string): Promise<ManifestRead>
  beginRestoreMaintenance?(): Promise<RestoreMaintenanceResult>
  commitRestoreMaintenance?(token?: string): Promise<RestoreMaintenanceResult>
  abortRestoreMaintenance?(token?: string): Promise<RestoreMaintenanceResult>
}

// -------------------------------------------------------------------------------- the state

export type DataMode = 'browser' | 'device'
export type DataSyncHealth = 'connecting' | 'syncing' | 'current' | 'degraded' | 'offline'

export interface AdoptionOffer {
  profiles: number
  beans: number
  runs: number
  calibrationRuns: number
  snapshots: number
}

export interface DataSyncState {
  mode: DataMode
  attached: boolean
  /** Catalog currency is independent of live-telemetry frame health. */
  health?: DataSyncHealth
  deviceStateRev?: string
  mirrorStateRev?: string
  deviceBootId?: string
  reason?: string
  /** The controller could not be reached on the last attempt. Reads still work; mutations fail closed. */
  offline: boolean
  /** Legacy adoption/reseed work is waiting for the idle gate. Clears when that queue drains. */
  waitingForIdle: boolean
  queued: number
  lastSyncedAtMs?: number
  /** On-disk footprint of the whole `/data` tree, from the status document. */
  usedBytes?: number
  /**
   * Payload length per run document, from the run index the store serves.
   *
   * It is here rather than derived in a view because only the DEVICE knows it: a run document is
   * built by shedding history until it fits, so its size is a property of what was actually stored
   * and not something the browser can recompute from the record it is holding. The Storage panel
   * groups these by profile and by bean lot, and a cascade plan states its own weight from them.
   */
  runBytes: Record<string, number>
  /** When this library was last exported whole, from the `meta` document. */
  lastExportedAt?: string
  /** A conflict that survived its retry, or a capacity refusal. Worth showing; never fatal. */
  message?: string
  /**
   * One sentence per legacy outbox target that could not be applied after a reload because the
   * roaster moved on. Current acknowledged mutations never enter this path; these notices make an
   * older build's dropped intent explicit while keeping the roaster's version on screen.
   */
  notices?: string[]
  /** Present exactly once: an empty roaster, and a browser with something to give it. */
  adoption?: AdoptionOffer
}

interface Working {
  profiles: Profile[]
  profileRevisions: ProfileRevision[]
  beans: BeanLot[]
  beanRevisions: BeanRevision[]
  settings?: CalibrationSettings
  snapshots: CalibrationSnapshot[]
  calibrationRuns: CalibrationRun[]
  importedDeviceLogs: string[]
  manualEvents: ManualEvent[]
  lastExportedAt?: string
  runs: Map<string, RoastRun>
}

interface Pending {
  target: DocumentTarget
  /** Replayed onto freshly fetched state when the write conflicts. Must be idempotent. */
  apply: (working: Working) => void
  /** Immutable payload for adoption/reseed writes; reconciliation must never turn it into a delete. */
  snapshot?: { payload: string | null; base: number }
  /**
   * Rebuilt from the outbox on boot, with no mutation behind it: the function that made the edit
   * died with the page, and only the document it produced came back. A conflict therefore cannot be
   * rebased, and is resolved the only honest way left - keep the roaster's copy and say so.
   */
  restored?: boolean
}

export interface RecordingHydrationRequest {
  recordingOrigin: RecordingOrigin
  storageAddress?: RecordingStorageAddress
}

export type RecordingHydrationResult =
  | { kind: 'ok'; samples: ThermalSample[] }
  | { kind: 'unavailable' }
  | { kind: 'mismatch'; message: string }

/**
 * One legacy outbox entry, retained so an earlier build's pending document can be resolved safely.
 * `payload` is null for a delete and `base` preserves the version it was built on.
 */
interface OutboxEntry {
  payload: string | null
  base: number
}

/**
 * The version ledger: which run documents this browser has exchanged with a roaster, and at what
 * version. It is what lets a warm cache skip refetching an unchanged run document - the index
 * reports a version per run, and one that matches is not read again.
 */
const RUN_VERSIONS_KEY = 'deviceRunVersions'
/**
 * Legacy outbox storage. New ordinary mutations do not write it; it remains browser-local so a
 * pending entry from an older build can be reconciled without becoming controller library data.
 */
const OUTBOX_KEY = 'deviceOutbox'
const ADOPTION_KEY = 'deviceAdoptionDismissed'
const PROFILE_ORDER_KEY = 'deviceProfileOrder'
const BEAN_ORDER_KEY = 'deviceBeanOrder'
/** Mirrored into the cache too, so a browser talking to a store-less controller still remembers. */
const LAST_EXPORTED_KEY = 'lastExportedAt'
/*
 * Samples downloaded from a recording, cached in this browser by the recording's immutable identity
 * (producer device + origin log id), so a page load does not download the same evidence again. The
 * library mirror cannot hold them: it is rewritten from the compacted roaster documents, which carry
 * no samples, on every load. The index lists the stored keys so entries for recordings no longer
 * referenced can be removed.
 */
const HYDRATED_SAMPLES_KEY_PREFIX = 'hydratedRecording:'
const HYDRATED_SAMPLES_INDEX_KEY = 'hydratedRecordingIndex'
const runTarget = (id: string): DocumentTarget => `runs/${id}`
const UINT64_MAX = 18446744073709551615n

/**
 * A successful write can advance the whole local mirror without rereading the manifest only when
 * its acknowledged controller revision is the exact successor of the revision already mirrored.
 * A gap means another document changed outside this browser; missing/malformed revisions are not
 * evidence at all. Both cases deliberately fall back to full reconciliation.
 */
const isAcknowledgedSuccessor = (
  current: string | undefined,
  acknowledged: string | undefined,
): acknowledged is string => {
  if (!current || !acknowledged || !/^[1-9][0-9]*$/.test(current) || !/^[1-9][0-9]*$/.test(acknowledged)) return false
  try {
    const before = BigInt(current)
    const after = BigInt(acknowledged)
    if (before > UINT64_MAX || after > UINT64_MAX) return false
    return after === (before === UINT64_MAX ? 1n : before + 1n)
  } catch {
    return false
  }
}

const byNewest = <T>(rows: T[], savedAtOf: (row: T) => string) =>
  [...rows].sort((a, b) => savedAtOf(b).localeCompare(savedAtOf(a)))

const cappedPerSubject = <T>(rows: T[], subjectOf: (row: T) => string, savedAtOf: (row: T) => string) => {
  const counts = new Map<string, number>()
  return byNewest(rows, savedAtOf).filter((row) => {
    const subject = subjectOf(row)
    const seen = (counts.get(subject) ?? 0) + 1
    counts.set(subject, seen)
    return seen <= REVISION_CAP
  })
}

const cloneWorking = (working: Working): Working => ({
  profiles: [...working.profiles],
  profileRevisions: [...working.profileRevisions],
  beans: [...working.beans],
  beanRevisions: [...working.beanRevisions],
  settings: working.settings,
  snapshots: [...working.snapshots],
  calibrationRuns: [...working.calibrationRuns],
  importedDeviceLogs: [...working.importedDeviceLogs],
  manualEvents: [...working.manualEvents],
  lastExportedAt: working.lastExportedAt,
  runs: new Map(working.runs),
})

const emptyWorking = (): Working => ({
  profiles: [],
  profileRevisions: [],
  beans: [],
  beanRevisions: [],
  settings: undefined,
  snapshots: [],
  calibrationRuns: [],
  importedDeviceLogs: [],
  manualEvents: [],
  lastExportedAt: undefined,
  runs: new Map(),
})

const orderedByIds = <T extends { id: string }>(rows: T[], ids: string[]): T[] => {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const ordered = ids.flatMap((id) => {
    const row = byId.get(id)
    if (!row) return []
    byId.delete(id)
    return [row]
  })
  return [...ordered, ...rows.filter((row) => byId.has(row.id))]
}

const upsert = <T extends { id: string }>(rows: T[], value: T) =>
  rows.some((row) => row.id === value.id) ? rows.map((row) => (row.id === value.id ? value : row)) : [...rows, value]

/** Existing records keep their chosen position; a newly created catalog item starts at the top. */
const upsertNewest = <T extends { id: string }>(rows: T[], value: T) =>
  rows.some((row) => row.id === value.id) ? rows.map((row) => (row.id === value.id ? value : row)) : [value, ...rows]

/**
 * The data layer the app talks to.
 *
 * The method surface is deliberately the repository's, verb for verb, because every screen was
 * written against it and none of them should have to know where a bean lot is kept. What changed is
 * underneath: device mode requires a current revision, sends a versioned mutation, and advances the
 * working copy/IndexedDB mirror only after acknowledgement. Legacy browser-only mode remains local.
 */
export class CrackleData {
  private client?: DeviceStoreClient
  private working?: Working
  private adoptionCandidate?: Working
  /** Documents with invalid application payloads require explicit recovery before they can change. */
  private readonly blockedTargets = new Set<DocumentTarget>()
  private readonly versions = new Map<string, number>()
  private queue: Pending[] = []
  /** Legacy outbox entries, keyed by target; ordinary acknowledged mutations do not add them. */
  private outbox = new Map<string, OutboxEntry>()
  private outboxLoaded = false
  /** Outbox writes in order, so "entry added" can never land after "entry cleared". */
  private outboxTail: Promise<void> = Promise.resolve()
  /**
   * A destructive restore owns the device library from format through reconciliation. Normal edits
   * are refused during that window: accepting one while the volume is being replaced would either
   * replay pre-restore intent over the backup or lose the new edit on the refresh.
   */
  private restoreLocked = false
  private restoreMaintenanceToken?: string
  /** Once format is confirmed, unlock is unsafe until the former mirror and durable intent are gone. */
  private restoreResetRequired = false
  /** Present only for the special needs-format/incomplete-maintenance recovery path. */
  private storageRecoveryDeviceId?: string
  private storageRecoveryFormatted = false
  /** Cache writes that started before the restore lock was requested. */
  private activeMutations = 0
  /**
   * One drain at a time, in order, exactly as the repository serializes its own writes. Each caller
   * awaits its own turn rather than being told "a flush is already running" - which is what lets a
   * save resolve when its bytes have actually been offered to the controller.
   */
  private flushTail: Promise<void> = Promise.resolve()
  /** Reloads commit in call order, so a slow refresh begun mid-restore cannot win afterwards. */
  private reloadTail: Promise<void> = Promise.resolve()
  private reconcileScheduled = false
  /** Flash/catalog reads wait while the controller is timing-sensitive; the newest revision wins. */
  private reconcileDeferredUntilIdle = false
  private activityBlocksReconcile = false
  private wakeReconcileInstalled = false
  private attaching = false
  private hydrate?: (request: RecordingHydrationRequest) => Promise<RecordingHydrationResult>
  private hydrationInFlight?: Promise<void>
  /*
   * Samples hydrated from the roaster's recordings archive, keyed by the recording's immutable
   * identity (producer device + origin log id). They live here rather than only in `this.working`
   * because a library reload REPLACES the working copy - and reloads routinely happen while
   * hydration is still downloading (the manifest is re-read on every revision signal). Writing the
   * samples into the working copy captured when hydration began put them into an orphaned object,
   * so calibration evidence (always stored without samples, under the calibrations document cap)
   * showed "samples loading from the roaster recording" forever and no calibration could be built
   * from saved evidence.
   */
  private readonly hydratedCalibrationSamples = new Map<string, ThermalSample[]>()
  private readonly hydratedRunSamples = new Map<string, RoastRun['samples']>()
  private listeners = new Set<() => void>()
  private state: DataSyncState = {
    mode: 'browser',
    attached: false,
    health: 'current',
    offline: false,
    waitingForIdle: false,
    queued: 0,
    runBytes: {},
    notices: [],
  }

  constructor(private readonly cache: CrackleRepository = repository) {}
  /** Bind the configured target cache before loading any device-backed state. */
  bindObservedDevice(deviceId: string) {
    return this.cache.bindObservedDevice(deviceId)
  }
  observedDeviceBinding() {
    return this.cache.observedDeviceBinding()
  }

  // ------------------------------------------------------------------------------- lifecycle

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify() {
    this.state = { ...this.state, queued: this.queue.length }
    for (const listener of this.listeners) listener()
  }

  syncState(): DataSyncState {
    return this.state
  }

  /** The cache-only boot, unchanged: seeding, normalization write-backs, and legacy migrations. */
  initialize() {
    return this.cache.initialize()
  }

  /**
   * Every status poll passes through here, and it does two jobs: it decides whether this controller
   * has a store at all, and it notices the moment the roaster goes idle so a queue that has been
   * waiting on the idle gate can drain without the user pressing anything.
   */
  observeStatus(status: ControllerStatus) {
    const mode: DataMode = status.dataStore ? 'device' : 'browser'
    const usedBytes = status.dataStore?.usedBytes ?? this.state.usedBytes
    if (mode !== this.state.mode || usedBytes !== this.state.usedBytes) {
      this.state = { ...this.state, mode, usedBytes }
      this.notify()
    }
    const revisioned = status as ControllerStatus & {
      stateRev?: string
      restoreMaintenance?: { active: boolean; incomplete: boolean; expiresInMs?: number }
    }
    this.observeRevision({
      connected: status.connected,
      bootId: status.bootId,
      stateRev: revisioned.stateRev,
      active: Boolean(
        status.roast?.active ||
          status.calibration?.active ||
          status.manual?.active ||
          status.lifecycle === 'RUNNING' ||
          status.thermalLog?.active,
      ),
      maintenance: revisioned.restoreMaintenance?.incomplete
        ? 'incomplete'
        : revisioned.restoreMaintenance?.active
          ? 'restoring'
          : undefined,
    })
    if (!this.client || this.queue.length === 0) return
    const idle = status.connected && status.lifecycle !== 'RUNNING'
    if (idle)
      this.flush().catch((error: unknown) =>
        this.recordBackgroundFailure(error, 'Queued changes could not be sent to the roaster.'),
      )
  }

  /**
   * A fire-and-forget flush or reconcile that rejects is recorded in the sync message - visible,
   * never fatal - instead of surfacing as an unhandled rejection that nobody sees.
   */
  private recordBackgroundFailure(error: unknown, fallback: string) {
    const detail = error instanceof Error && error.message ? error.message : fallback
    this.state = { ...this.state, message: detail }
    this.notify()
  }

  /** Status and live frames only signal currency; the manifest proves and repairs it. */
  observeRevision(observation: {
    connected?: boolean
    bootId?: string
    stateRev?: string
    /** True while actuator or recording timing must not compete with manifest reads. */
    active?: boolean
    maintenance?: 'restoring' | 'incomplete'
  }) {
    if (observation.connected === false) {
      if (this.client && this.state.health !== 'offline') {
        this.state = { ...this.state, health: 'offline', offline: true, reason: 'The roaster is not connected.' }
        this.notify()
      }
      return
    }
    if (observation.maintenance) {
      this.state = {
        ...this.state,
        health: 'degraded',
        offline: false,
        reason:
          observation.maintenance === 'incomplete'
            ? 'The previous restore did not finish. Resume or abort it before editing.'
            : 'A restore is replacing the roaster library.',
      }
      this.notify()
      return
    }
    if (!this.client?.readManifestPage) return
    const activityEnded = this.activityBlocksReconcile && observation.active === false
    if (observation.active !== undefined) this.activityBlocksReconcile = observation.active
    if (activityEnded) void this.requestHydration()
    const bootChanged =
      observation.bootId !== undefined &&
      this.state.deviceBootId !== undefined &&
      observation.bootId !== this.state.deviceBootId
    const revisionChanged = observation.stateRev !== undefined && observation.stateRev !== this.state.mirrorStateRev
    if (!bootChanged && !revisionChanged) {
      if (!this.activityBlocksReconcile && this.reconcileDeferredUntilIdle) this.requestReconcile()
      return
    }
    this.state = {
      ...this.state,
      health: 'syncing',
      offline: false,
      deviceBootId: observation.bootId ?? this.state.deviceBootId,
      deviceStateRev: observation.stateRev ?? this.state.deviceStateRev,
      reason: undefined,
    }
    this.notify()
    if (this.activityBlocksReconcile || this.queue.length > 0) {
      this.reconcileDeferredUntilIdle = true
      return
    }
    this.requestReconcile()
  }

  canMutate() {
    return this.mutationBlockedReason() === undefined
  }

  mutationBlockedReason(): string | undefined {
    if (this.restoreLocked)
      return 'The backup restore is still in progress. Wait for it to finish before making another change.'
    if (!this.client?.readManifestPage) return undefined
    if (
      this.state.health !== 'current' ||
      !this.state.deviceStateRev ||
      this.state.deviceStateRev !== this.state.mirrorStateRev
    ) {
      return this.state.reason ?? 'Wait for the browser to finish syncing the roaster library before making changes.'
    }
    return undefined
  }

  /**
   * A reason worth putting in front of the operator.
   *
   * A new controller revision briefly makes the mirror stale while the automatic reconciliation
   * catches up. That is an ordering boundary, not an error and not something the operator can fix.
   * Keep hard failures visible, but let ordinary editors remain usable while a healthy catch-up is
   * in flight; their writes wait at `awaitMutationReady` below.
   */
  visibleMutationBlockedReason(): string | undefined {
    if (this.restoreLocked)
      return 'The backup restore is still in progress. Wait for it to finish before making another change.'
    if (!this.client?.readManifestPage) return undefined
    // Only a catch-up over an already verified mirror is transient. The first attach has no safe
    // base document yet and remains a real blocker until that initial manifest is complete.
    if (this.state.health === 'syncing' && !this.state.reason && this.state.mirrorStateRev) return undefined
    return this.mutationBlockedReason()
  }

  /**
   * Serialize a write behind a harmless revision catch-up instead of rejecting the click and
   * making the operator try again. A genuine offline, invalid-document, or maintenance state still
   * fails immediately and remains visible through `visibleMutationBlockedReason`.
   */
  private async awaitMutationReady(): Promise<void> {
    const visible = this.visibleMutationBlockedReason()
    if (visible) throw new Error(visible)
    const transient = this.mutationBlockedReason()
    if (!transient) return
    this.requestReconcile()
    await this.reloadTail
    const after = this.mutationBlockedReason()
    if (after) throw new Error(after)
  }

  private requestReconcile() {
    if (!this.client?.readManifestPage || this.reconcileScheduled || this.restoreLocked) return
    if (this.activityBlocksReconcile || this.queue.length > 0) {
      this.reconcileDeferredUntilIdle = true
      return
    }
    this.reconcileScheduled = true
    this.reload()
      .catch((error: unknown) => this.recordBackgroundFailure(error, 'The roaster library could not be refreshed.'))
      .finally(() => {
        this.reconcileScheduled = false
      })
    this.reconcileDeferredUntilIdle = false
  }

  private installWakeReconcile() {
    if (this.wakeReconcileInstalled || typeof window === 'undefined') return
    this.wakeReconcileInstalled = true
    window.addEventListener('focus', () => this.requestReconcile())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.requestReconcile()
    })
  }

  /**
   * Take the controller's copy as the truth.
   *
   * Called once, after the first status that reports `data_store`. `hydrate` validates and decodes
   * one provenance-bearing raw recording: a run document carries only a bounded fallback series, so a browser
   * that has never seen that roast reconstructs the full curve from the archive rather than treating
   * the deliberately sparse fallback as the highest-resolution copy.
   */
  async attach(
    client: DeviceStoreClient,
    hydrate?: (request: RecordingHydrationRequest) => Promise<RecordingHydrationResult>,
  ) {
    if (this.client || this.attaching) return
    this.attaching = true
    this.hydrate = hydrate
    try {
      this.client = client
      if (client.readManifestPage) {
        this.state = { ...this.state, mode: 'device', health: 'connecting', offline: false, reason: undefined }
        this.notify()
        this.installWakeReconcile()
      }
      await this.reload()
      void this.requestHydration()
    } finally {
      this.attaching = false
    }
  }

  /** The manual "refresh from controller" action, and the second half of `attach`. */
  async refresh() {
    if (!this.client) return
    if (this.restoreLocked)
      throw new Error('The backup restore owns the roaster library until its final reconciliation finishes.')
    await this.reload()
    await this.requestHydration()
  }

  /** Re-reads the roaster's library (only what its manifest says changed), without hydration. */
  async syncFromDevice() {
    if (!this.client || this.restoreLocked) return
    await this.reload()
  }

  private reload(): Promise<void> {
    const next = this.reloadTail.then(() => this.reloadNow())
    this.reloadTail = next.catch(() => undefined)
    return next
  }

  private async reloadNow() {
    const client = this.client
    if (!client) return
    if (client.readManifestPage) {
      await this.reloadRevisioned(
        client as DeviceStoreClient & { readManifestPage: NonNullable<DeviceStoreClient['readManifestPage']> },
      )
      return
    }
    let working = await this.cachedWorking()
    // BEFORE the roaster is consulted, because what is owed to it decides which of its documents may
    // overwrite what is here. On a refresh the map is already in hand and authoritative.
    await this.loadOutbox()
    // What this browser held BEFORE the roaster was consulted. A collection document is applied
    // wholesale, so this is the only moment at which the entries it drops can still be named - and
    // they have to be named, so the CACHE can be pruned of them too rather than resurrecting them
    // on the next offline boot.
    let offline = false
    let deviceHas = false
    const applied = new Set<CollectionName>()
    const absent = new Set<CollectionName>()

    // Physical controllers serve one request at a time. Keep the legacy attach
    // path sequential too; opening four document downloads together only adds
    // socket/heap pressure on the ESP32 and cannot reduce server-side work.
    const collections: Array<readonly [CollectionName, DocumentRead]> = []
    for (const name of COLLECTIONS) collections.push([name, await client.readDocument(name)] as const)
    for (const [name, read] of collections) {
      if (read.kind === 'ok') {
        deviceHas = true
        this.versions.set(name, read.version)
        try {
          this.applyCollection(working, name, read.payload)
          this.blockedTargets.delete(name)
          applied.add(name)
        } catch {
          this.blockedTargets.add(name)
          absent.add(name)
        }
      } else if (read.kind === 'missing') {
        this.blockedTargets.delete(name)
        this.versions.set(name, 0)
        absent.add(name)
      } else if (read.kind === 'corrupt') {
        deviceHas = true
        this.blockedTargets.add(name)
        this.versions.set(name, 0)
        absent.add(name)
      } else {
        offline = true
      }
    }

    /*
     * ==========================================================================================
     * STRICT DEVICE TRUTH: the roaster's copy is the library, and there is no second opinion
     * ==========================================================================================
     *
     * The browser may never hold more profiles or bean lots than the device: the two are always
     * aligned, and the browser carries no extra information of its own.
     *
     * At boot the device wins unconditionally. Applying its `profiles` document replaces the whole
     * list, and anything this browser was holding that the document does not name was stale cache,
     * so it goes from the cache as well - otherwise it would come back the moment a reload happened
     * while the roaster was unreachable, and the two would be out of step again.
     *
     * There is deliberately no push/discard/dismiss prompt. The only scenario it would guard - a
     * roaster carrying only smoke-test debris out-voting a real local library - does not arise (the
     * mock seeds itself and a real roaster is flashed with its store intact), and the prompt's cost
     * would be a browser holding roasts the roaster does not. The one migration path is ADOPTION,
     * for a roaster whose store is completely empty.
     *
     * Legacy adoption/outbox work is resolved separately. Ordinary user edits made while the
     * roaster is busy remain uncommitted and do not override this device-wins reconciliation.
     */
    const index = await client.listRunDocuments()
    let runBytes = this.state.runBytes
    if (index.kind === 'ok') {
      if (index.runs.length > 0) deviceHas = true
      runBytes = Object.fromEntries(index.runs.map((entry) => [entry.id, entry.bytes]))
    } else {
      offline = true
    }

    let adoption: AdoptionOffer | undefined
    let preserveAdoptionCandidate = false
    if (!offline && !deviceHas) {
      adoption = await this.adoptionOffer(working)
      this.adoptionCandidate = adoption ? working : undefined
      preserveAdoptionCandidate = adoption !== undefined
      working = emptyWorking()
      if (!preserveAdoptionCandidate) {
        await this.cache.clearDeviceLibraryMirror([LAST_EXPORTED_KEY, RUN_VERSIONS_KEY])
      }
    } else if (deviceHas) {
      this.adoptionCandidate = undefined
      for (const name of absent) {
        this.clearCollection(working, name)
        applied.add(name)
      }
    }

    // Resolve only legacy outbox entries after missing controller documents are normalized to empty,
    // so an earlier build's pending payload cannot revive unrelated cache rows.
    for (const [target, entry] of this.outbox) {
      if (target.startsWith('runs/')) continue
      this.applyOutbox(working, target as DocumentTarget, entry.payload)
      this.versions.set(target, entry.base)
    }

    if (index.kind === 'ok') await this.reconcileRuns(working, index.runs, deviceHas, index.truncated)
    this.working = working
    if (!preserveAdoptionCandidate) {
      await Promise.all([...applied].map((name) => this.mirrorTarget(name))).catch(() => undefined)
    }
    this.state = {
      ...this.state,
      mode: 'device',
      attached: true,
      offline,
      lastSyncedAtMs: offline ? this.state.lastSyncedAtMs : Date.now(),
      runBytes,
      lastExportedAt: working.lastExportedAt,
      adoption,
      message:
        this.blockedTargets.size > 0
          ? 'Some controller library data is invalid. Editing the affected section is blocked until the library is restored or reformatted.'
          : this.state.message,
    }
    this.notify()
    // Everything the outbox is holding is offered now, once the working copy is whole. A roaster
    // that is busy or unreachable simply says so, and the entries stay for the next boot.
    if (this.queue.length > 0) await this.flush()
  }

  private async completeManifest(
    client: DeviceStoreClient & { readManifestPage: NonNullable<DeviceStoreClient['readManifestPage']> },
  ): Promise<
    { kind: 'ok'; page: DeviceManifestPage } | { kind: 'retry' } | { kind: 'offline' | 'degraded'; reason: string }
  > {
    const first = await client.readManifestPage()
    if (first.kind !== 'ok') {
      return first.kind === 'unreachable'
        ? { kind: 'offline', reason: 'The roaster is not connected.' }
        : {
            kind: 'degraded',
            reason: first.kind === 'error' ? first.message : 'The roaster data volume is not mounted.',
          }
    }
    if (first.page.maintenance) {
      return {
        kind: 'degraded',
        reason:
          first.page.maintenance === 'incomplete'
            ? 'The previous restore did not finish. Resume or abort it before editing.'
            : 'A restore is replacing the roaster library.',
      }
    }
    const collections = { ...first.page.collections }
    const runs = new Map(first.page.runs.map((entry) => [entry.id, entry]))
    const logs = new Map(first.page.logs.map((entry) => [entry.id, entry]))
    const seen = new Set<string>()
    let cursor = first.page.nextCursor
    for (let pages = 1; cursor; pages += 1) {
      if (pages >= 1000 || seen.has(cursor))
        return { kind: 'degraded', reason: 'The roaster manifest pagination is invalid.' }
      seen.add(cursor)
      const next = await client.readManifestPage(cursor)
      if (next.kind !== 'ok') {
        return next.kind === 'unreachable'
          ? { kind: 'offline', reason: 'The roaster is not connected.' }
          : {
              kind: 'degraded',
              reason: next.kind === 'error' ? next.message : 'The roaster data volume is not mounted.',
            }
      }
      if (next.page.maintenance) return { kind: 'degraded', reason: 'A restore is replacing the roaster library.' }
      if (next.page.stateRev !== first.page.stateRev || next.page.bootId !== first.page.bootId) return { kind: 'retry' }
      Object.assign(collections, next.page.collections)
      for (const entry of next.page.runs) runs.set(entry.id, entry)
      for (const entry of next.page.logs) logs.set(entry.id, entry)
      cursor = next.page.nextCursor
    }
    return {
      kind: 'ok',
      page: {
        ...first.page,
        collections,
        runs: [...runs.values()],
        logs: [...logs.values()],
        nextCursor: undefined,
      },
    }
  }

  private async reloadRevisioned(
    client: DeviceStoreClient & { readManifestPage: NonNullable<DeviceStoreClient['readManifestPage']> },
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.state = { ...this.state, mode: 'device', health: 'syncing', offline: false, reason: undefined }
      this.notify()
      const stable = await this.completeManifest(client)
      if (stable.kind === 'retry') continue
      if (stable.kind !== 'ok') {
        this.state = {
          ...this.state,
          mode: 'device',
          attached: true,
          health: stable.kind,
          offline: stable.kind === 'offline',
          reason: stable.reason,
        }
        this.notify()
        return
      }

      const manifest = stable.page
      const cached = this.working ? cloneWorking(this.working) : await this.cachedWorking()
      const working = cloneWorking(cached)
      const nextVersions = new Map(this.versions)
      if (!this.working) {
        const cachedRunVersions = (await this.cache.meta<Record<string, number>>(RUN_VERSIONS_KEY)) ?? {}
        for (const entry of manifest.runs) {
          if (cachedRunVersions[entry.id] === entry.version && working.runs.has(entry.id)) {
            nextVersions.set(runTarget(entry.id), entry.version)
          }
        }
      }
      let retry = false
      let invalid: string | undefined

      for (const name of COLLECTIONS) {
        const entry = manifest.collections[name]
        if (!entry) {
          this.clearCollection(working, name)
          nextVersions.set(name, 0)
          this.blockedTargets.delete(name)
          continue
        }
        if (this.working && this.versions.get(name) === entry.version) continue
        const read = await client.readDocument(name)
        if (read.kind !== 'ok' || read.version !== entry.version) {
          retry = true
          break
        }
        try {
          this.applyCollection(working, name, read.payload)
          nextVersions.set(name, entry.version)
          this.blockedTargets.delete(name)
        } catch {
          this.blockedTargets.add(name)
          invalid = `The roaster ${name} document is invalid. Restore or reformat the library before editing this section.`
          break
        }
      }
      if (invalid) {
        this.state = {
          ...this.state,
          attached: true,
          health: 'degraded',
          offline: false,
          reason: invalid,
          message: invalid,
        }
        this.notify()
        return
      }
      if (retry) continue

      const listed = new Set(manifest.runs.map((entry) => entry.id))
      for (const id of [...working.runs.keys()]) if (!listed.has(id)) working.runs.delete(id)
      for (const entry of manifest.runs) {
        const target = runTarget(entry.id)
        if (nextVersions.get(target) === entry.version && working.runs.has(entry.id)) continue
        const read = await client.readDocument(target)
        if (read.kind !== 'ok' || read.version !== entry.version) {
          retry = true
          break
        }
        try {
          working.runs.set(entry.id, parseRunDocument(read.payload))
          nextVersions.set(target, entry.version)
          this.blockedTargets.delete(target)
        } catch {
          this.blockedTargets.add(target)
          invalid = `The roaster run ${entry.id} is invalid. Restore or reformat the library before editing it.`
          break
        }
      }
      if (invalid) {
        this.state = {
          ...this.state,
          attached: true,
          health: 'degraded',
          offline: false,
          reason: invalid,
          message: invalid,
        }
        this.notify()
        return
      }
      if (retry) continue
      for (const target of [...nextVersions.keys()]) {
        if (target.startsWith('runs/') && !listed.has(target.slice('runs/'.length))) nextVersions.delete(target)
      }

      const head = await client.readManifestPage()
      if (head.kind !== 'ok') {
        this.state = {
          ...this.state,
          attached: true,
          health: head.kind === 'unreachable' ? 'offline' : 'degraded',
          offline: head.kind === 'unreachable',
          reason: head.kind === 'error' ? head.message : 'The roaster manifest is unavailable.',
        }
        this.notify()
        return
      }
      if (head.page.maintenance) {
        this.state = {
          ...this.state,
          attached: true,
          health: 'degraded',
          offline: false,
          reason: 'A restore is replacing the roaster library.',
        }
        this.notify()
        return
      }
      if (head.page.stateRev !== manifest.stateRev || head.page.bootId !== manifest.bootId) continue

      const deviceHas = COLLECTIONS.some((name) => manifest.collections[name] !== null) || manifest.runs.length > 0
      let adoption: AdoptionOffer | undefined
      if (!deviceHas) {
        adoption = await this.adoptionOffer(cached)
        this.adoptionCandidate = adoption ? cached : undefined
      } else {
        this.adoptionCandidate = undefined
      }

      this.versions.clear()
      for (const [target, version] of nextVersions) this.versions.set(target, version)
      this.working = working
      if (!adoption) {
        await this.mirrorAll(working)
        await this.pruneCache(await this.cache.runs(), [...working.runs.values()], (id) => this.cache.deleteRun(id))
      }
      await this.cache.saveMeta(
        RUN_VERSIONS_KEY,
        Object.fromEntries(manifest.runs.map((entry) => [entry.id, entry.version])),
      )
      const runBytes = Object.fromEntries(manifest.runs.map((entry) => [entry.id, entry.bytes]))
      this.state = {
        ...this.state,
        mode: 'device',
        attached: true,
        health: 'current',
        offline: false,
        deviceStateRev: manifest.stateRev,
        mirrorStateRev: manifest.stateRev,
        deviceBootId: manifest.bootId,
        reason: undefined,
        lastSyncedAtMs: Date.now(),
        runBytes,
        lastExportedAt: working.lastExportedAt,
        adoption,
        message: undefined,
      }
      this.notify()
      return
    }
    this.state = {
      ...this.state,
      mode: 'device',
      attached: true,
      health: 'degraded',
      offline: false,
      reason:
        'The roaster library kept changing while it was being synchronized. Try again when the current change finishes.',
    }
    this.notify()
  }

  /** Return a value only when one controller revision brackets the entire read. */
  async revisionFenced<T>(reader: () => Promise<T>): Promise<T> {
    const client = this.client
    if (!client?.readManifestPage) return reader()
    const before = await client.readManifestPage()
    if (before.kind !== 'ok' || before.page.maintenance)
      throw new Error('The roaster library is not available for an authoritative backup.')
    const value = await reader()
    const after = await client.readManifestPage()
    if (
      after.kind !== 'ok' ||
      after.page.maintenance ||
      after.page.stateRev !== before.page.stateRev ||
      after.page.bootId !== before.page.bootId
    ) {
      throw new Error('The roaster library changed while the backup was being read. Try again.')
    }
    return value
  }

  /**
   * The outbox, read once and then owned in memory.
   *
   * Every entry becomes a queue entry marked `restored`, so the flush that follows is the ordinary
   * one - the only thing it may not do is rebase, because the mutation is gone.
   */
  private async loadOutbox() {
    if (this.outboxLoaded) return
    this.outboxLoaded = true
    let stored: Record<string, OutboxEntry> | undefined
    try {
      stored = await this.cache.meta<Record<string, OutboxEntry>>(OUTBOX_KEY)
    } catch {
      return
    }
    for (const [target, entry] of Object.entries(stored ?? {})) {
      // A shelf is not a schema. Anything that is not an entry is dropped rather than trusted.
      if (typeof entry?.base !== 'number' || (entry.payload !== null && typeof entry.payload !== 'string')) continue
      this.outbox.set(target, { payload: entry.payload, base: entry.base })
      this.queue.push({ target: target as DocumentTarget, apply: () => {}, restored: true })
    }
  }

  /** Put a queued document back over whatever the roaster just said. */
  private applyOutbox(working: Working, target: DocumentTarget, payload: string | null) {
    try {
      if (!target.startsWith('runs/')) {
        if (payload !== null) this.applyCollection(working, target as CollectionName, payload)
        return
      }
      const id = target.slice('runs/'.length)
      if (payload === null) working.runs.delete(id)
      else working.runs.set(id, parseRunDocument(payload))
    } catch {
      /* an entry that will not parse is not a reason to lose the boot */
    }
  }

  /**
   * Write the queue through to disk, so memory and disk agree at every moment one of them changes.
   *
   * The snapshot is taken when the write actually runs rather than when it is scheduled, and the
   * writes are chained, so the last state of the map is always the last thing written.
   */
  private persistOutbox(): Promise<void> {
    const write = this.outboxTail.then(() => this.cache.saveMeta(OUTBOX_KEY, Object.fromEntries(this.outbox)))
    this.outboxTail = write.catch(() => undefined)
    return write
  }

  private forget(target: DocumentTarget): Promise<void> {
    if (!this.outbox.delete(target)) return Promise.resolve()
    return this.persistOutbox()
  }

  /** Drop from the cache what the roaster's own document did not name. */
  private async pruneCache<T extends { id: string }>(cached: T[], kept: T[], remove: (id: string) => Promise<void>) {
    const survivors = new Set(kept.map((row) => row.id))
    for (const row of cached) if (!survivors.has(row.id)) await remove(row.id)
  }

  private applyCollection(working: Working, name: CollectionName, payload: string) {
    if (name === 'profiles') {
      const document = parseProfilesDocument(payload)
      working.profiles = document.profiles
      working.profileRevisions = document.profileRevisions
    } else if (name === 'beans') {
      const document = parseBeansDocument(payload)
      working.beans = document.beans
      working.beanRevisions = document.beanRevisions
    } else if (name === 'calibrations') {
      const document = parseCalibrationsDocument(payload)
      const cachedById = new Map(working.calibrationRuns.map((run) => [run.id, run]))
      working.settings = document.settings
      working.snapshots = document.snapshots
      working.calibrationRuns = document.runs.map((run) => {
        const cached = cachedById.get(run.id)
        const sameArchive =
          cached?.sourceLogId !== undefined &&
          cached.sourceLogId === run.sourceLogId &&
          cached.recordedOn.deviceId === run.recordedOn.deviceId
        return run.samples.length === 0 && cached && cached.samples.length > 0 && sameArchive
          ? { ...run, samples: cached.samples }
          : run
      })
    } else {
      const document = parseMetaDocument(payload)
      working.importedDeviceLogs = document.importedDeviceLogs
      working.manualEvents = document.manualEvents
      working.lastExportedAt = document.lastExportedAt
    }
  }

  private clearCollection(working: Working, name: CollectionName) {
    if (name === 'profiles') {
      working.profiles = []
      working.profileRevisions = []
    } else if (name === 'beans') {
      working.beans = []
      working.beanRevisions = []
    } else if (name === 'calibrations') {
      working.settings = undefined
      working.snapshots = []
      working.calibrationRuns = []
    } else {
      working.importedDeviceLogs = []
      working.manualEvents = []
      working.lastExportedAt = undefined
    }
  }

  /**
   * The run index against the cache.
   *
   * Every entry carries its version, so a run whose cached copy is already at that version is not
   * fetched at all.
   *
   * A cached run the index does not list is gone, whatever this browser remembers about it - a
   * roast deleted on the phone, or one that never reached the roaster at all. Both are the same
   * answer now: the roaster's index is the library, so the cache is brought into line with it. The
   * only case that is exempt is a roaster whose store is entirely empty, which is adoption's, not
   * reconciliation's - hence `deviceHas`.
   */
  private async reconcileRuns(
    working: Working,
    index: RunIndexEntry[],
    deviceHas: boolean,
    truncated: boolean,
  ): Promise<void> {
    const client = this.client
    if (!client) return
    const cachedVersions = (await this.cache.meta<Record<string, number>>(RUN_VERSIONS_KEY)) ?? {}
    const versions: Record<string, number> = {}
    const listed = new Set(index.map((entry) => entry.id))

    for (const entry of index) {
      this.versions.set(runTarget(entry.id), entry.version)
      // A roast with a queued write is not reconciled at all: its document is the one in the outbox,
      // at the base the outbox recorded, and the flush is what settles it. It is deliberately left
      // OUT of the version ledger too - the cache is holding an edit here, not the roaster's copy,
      // so a later boot must fetch rather than trust a version match.
      if (this.outbox.has(runTarget(entry.id))) continue
      versions[entry.id] = entry.version
      if (cachedVersions[entry.id] === entry.version && working.runs.has(entry.id)) continue
      const read = await client.readDocument(runTarget(entry.id))
      if (read.kind !== 'ok') continue
      const target = runTarget(entry.id)
      try {
        const run = parseRunDocument(read.payload)
        working.runs.set(entry.id, run)
        await this.cache.saveRun(run)
        this.blockedTargets.delete(target)
      } catch {
        working.runs.delete(entry.id)
        await this.cache.deleteRun(entry.id)
        this.blockedTargets.add(target)
      }
      this.versions.set(target, read.version)
      versions[entry.id] = read.version
    }

    // The queued documents go back on, exactly as the collections did: a roast edited or created
    // while the roaster was busy stays the user's until the roaster has had its say.
    for (const [target, entry] of this.outbox) {
      if (!target.startsWith('runs/')) continue
      this.applyOutbox(working, target as DocumentTarget, entry.payload)
      this.versions.set(target, entry.base)
    }

    if (deviceHas && !truncated) {
      for (const id of [...working.runs.keys()]) {
        // Unlisted, but owed: a roast created here while the roaster could not take it is not stale
        // cache, and deleting it is precisely the loss this outbox exists to prevent.
        if (listed.has(id) || this.outbox.has(runTarget(id))) continue
        working.runs.delete(id)
        // The cache mirrors the device, so a roast deleted on the phone leaves the PC too.
        await this.cache.deleteRun(id)
      }
    }
    await this.cache.saveMeta(RUN_VERSIONS_KEY, versions)
  }

  private async cachedWorking(): Promise<Working> {
    const [
      profiles,
      profileRevisions,
      beans,
      beanRevisions,
      settings,
      snapshots,
      calibrationRuns,
      importedDeviceLogs,
      manualEvents,
      runs,
      lastExportedAt,
      profileOrder,
      beanOrder,
    ] = await Promise.all([
      this.cache.profiles(),
      this.cache.profileRevisions(),
      this.cache.beans(),
      this.cache.beanRevisions(),
      this.cache.calibration(),
      this.cache.calibrationSnapshots(),
      this.cache.calibrationRuns(),
      this.cache.importedDeviceLogIds(),
      this.cache.manualEvents(),
      this.cache.runs(),
      this.cache.meta<string>(LAST_EXPORTED_KEY),
      this.cache.meta<string[]>(PROFILE_ORDER_KEY),
      this.cache.meta<string[]>(BEAN_ORDER_KEY),
    ])
    return {
      profiles: orderedByIds(profiles, profileOrder ?? []),
      profileRevisions,
      beans: orderedByIds(beans, beanOrder ?? []),
      beanRevisions,
      settings,
      snapshots,
      calibrationRuns,
      importedDeviceLogs: [...importedDeviceLogs],
      manualEvents,
      lastExportedAt,
      runs: new Map(runs.map((run) => [run.id, run])),
    }
  }

  /**
   * Compact controller documents can retain only an archive id when their bounded fallback sample
   * budget is exhausted. The archive is still controller-owned evidence, so reconstruct both roasts
   * and calibration passes from it rather than presenting an intact recording as "0 samples".
   */
  private requestHydration(): Promise<void> {
    if (!this.hydrationInFlight) {
      this.hydrationInFlight = this.hydrateRecordings().finally(() => {
        this.hydrationInFlight = undefined
      })
    }
    return this.hydrationInFlight
  }

  private async cachedRecordingSamples<T>(key: string): Promise<T[] | undefined> {
    try {
      const stored = await this.cache.meta<T[]>(HYDRATED_SAMPLES_KEY_PREFIX + key)
      return Array.isArray(stored) && stored.length > 0 ? stored : undefined
    } catch {
      return undefined
    }
  }

  private async storeRecordingSamples(key: string, samples: unknown[]) {
    try {
      await this.cache.saveMeta(HYDRATED_SAMPLES_KEY_PREFIX + key, samples)
    } catch {
      /* only a cache */
    }
  }

  /** Drops cached samples of recordings nothing in the library refers to any more. */
  private async pruneRecordingSamples(referenced: Set<string>) {
    try {
      const stored = (await this.cache.meta<string[]>(HYDRATED_SAMPLES_INDEX_KEY)) ?? []
      const kept: string[] = []
      for (const key of stored) {
        if (referenced.has(key)) kept.push(key)
        else await this.cache.deleteMeta(HYDRATED_SAMPLES_KEY_PREFIX + key)
      }
      for (const key of referenced) if (!kept.includes(key)) kept.push(key)
      await this.cache.saveMeta(HYDRATED_SAMPLES_INDEX_KEY, kept)
    } catch {
      /* only a cache */
    }
  }

  private async hydrateRecordings() {
    const fetchRecording = this.hydrate
    const working = this.working
    if (!fetchRecording || !working) return
    let filled = 0
    // Every recording the library refers to; cached samples of any other recording are dropped.
    const referenced = new Set<string>()
    for (const run of working.runs.values())
      if (run.deviceRoast) referenced.add(recordingKey(run.deviceRoast.recordingOrigin))
    for (const run of working.calibrationRuns) {
      const key = this.calibrationRecordingKey(run)
      if (key) referenced.add(key)
    }
    for (const run of [...working.runs.values()]) {
      const evidence = run.deviceRoast
      if (!evidence || run.samples.length > 0) continue
      const key = recordingKey(evidence.recordingOrigin)
      if (this.hydratedRunSamples.has(key)) continue
      const cachedSamples = await this.cachedRecordingSamples<RoastRun['samples'][number]>(key)
      if (cachedSamples) {
        this.hydratedRunSamples.set(key, cachedSamples)
        const current = this.working?.runs.get(run.id)
        if (current && current.samples.length === 0)
          this.working!.runs.set(run.id, { ...current, samples: cachedSamples })
        filled += 1
        continue
      }
      try {
        const result = await fetchRecording({
          recordingOrigin: evidence.recordingOrigin,
          storageAddress: evidence.storageAddress,
        })
        if (result.kind === 'mismatch') {
          if (!(this.state.notices ?? []).includes(result.message)) {
            this.state = { ...this.state, notices: [...(this.state.notices ?? []), result.message] }
            this.notify()
          }
          continue
        }
        if (result.kind !== 'ok') continue
        const samples = deviceRoastSamplesFromThermal(result.samples)
        if (samples.length === 0) continue
        this.hydratedRunSamples.set(key, samples)
        await this.storeRecordingSamples(key, samples)
        const hydrated = { ...run, samples }
        // Into whichever working copy is CURRENT now, never only the one captured at the start.
        const current = this.working?.runs.get(run.id)
        if (current && current.samples.length === 0) this.working!.runs.set(run.id, { ...current, samples })
        // Hydration mirrors controller-held archive evidence into this browser; it is not an edit.
        await this.cache.saveRun(hydrated)
        filled += 1
      } catch {
        /* a recording that will not read is retried on the next attach */
      }
    }
    for (const run of [...working.calibrationRuns]) {
      const key = this.calibrationRecordingKey(run)
      if (!key || run.samples.length > 0) continue
      if (this.hydratedCalibrationSamples.has(key)) continue
      const cachedSamples = await this.cachedRecordingSamples<ThermalSample>(key)
      if (cachedSamples) {
        this.hydratedCalibrationSamples.set(key, cachedSamples)
        const live = this.working?.calibrationRuns
        const index = live ? live.findIndex((candidate) => candidate.id === run.id) : -1
        if (live && index >= 0 && live[index].samples.length === 0)
          live[index] = { ...live[index], samples: cachedSamples }
        filled += 1
        continue
      }
      try {
        const result = await fetchRecording({
          recordingOrigin: { deviceId: run.recordedOn.deviceId, logId: run.sourceLogId! },
        })
        if (result.kind === 'mismatch') {
          if (!(this.state.notices ?? []).includes(result.message)) {
            this.state = { ...this.state, notices: [...(this.state.notices ?? []), result.message] }
            this.notify()
          }
          continue
        }
        if (result.kind !== 'ok') continue
        const samples = result.samples
        if (samples.length === 0) continue
        this.hydratedCalibrationSamples.set(key, samples)
        await this.storeRecordingSamples(key, samples)
        const hydrated = { ...run, samples }
        const live = this.working?.calibrationRuns
        const index = live ? live.findIndex((candidate) => candidate.id === run.id) : -1
        if (live && index >= 0 && live[index].samples.length === 0) live[index] = { ...live[index], samples }
        // This is a cache of the roaster's archive, not a document edit. Writing it back would merely
        // make the collection compactor discard it again and would create a false device revision.
        await this.cache.saveCalibrationRun(hydrated)
        filled += 1
      } catch {
        /* an unavailable archive is retried on the next attach or explicit refresh */
      }
    }
    await this.pruneRecordingSamples(referenced)
    if (filled > 0) this.notify()
  }

  private async adoptionOffer(working: Working): Promise<AdoptionOffer | undefined> {
    if ((await this.cache.meta<boolean>(ADOPTION_KEY)) === true) return undefined
    const offer: AdoptionOffer = {
      profiles: working.profiles.length,
      beans: working.beans.length,
      runs: working.runs.size,
      calibrationRuns: working.calibrationRuns.length,
      snapshots: working.snapshots.length,
    }
    return Object.values(offer).some((count) => count > 0) ? offer : undefined
  }

  /**
   * Push this browser's library onto an empty controller. Explicit, once, and never automatic:
   * adopting is a decision about which copy is the real one, and only the user can make it.
   */
  async adoptLocalData() {
    return this.withMutation(async () => {
      const working = this.adoptionCandidate
      if (!working || !this.client) return
      this.working = working
      this.adoptionCandidate = undefined
      await this.mirrorAll(working)
      await this.cache.saveMeta(ADOPTION_KEY, true)
      for (const name of COLLECTIONS) void this.enqueue(name, () => {}, false)
      for (const id of working.runs.keys()) void this.enqueue(runTarget(id), () => {}, false)
      this.state = { ...this.state, adoption: undefined }
      await this.flush()
    })
  }

  async dismissAdoption() {
    return this.withMutation(async () => {
      this.working = emptyWorking()
      this.adoptionCandidate = undefined
      await this.cache.clearDeviceLibraryMirror([LAST_EXPORTED_KEY, RUN_VERSIONS_KEY])
      await this.cache.saveMeta(ADOPTION_KEY, true)
      this.state = { ...this.state, adoption: undefined, lastExportedAt: undefined, runBytes: {} }
      this.notify()
    })
  }

  // ---------------------------------------------------------------------------------- the queue

  /**
   * `durable` is true for every edit and false for the two whole-library pushes, which are the only
   * callers that queue a document they did not just change. Adoption and the demo reseed enqueue the
   * entire library at once, in the foreground, against a roaster that has already answered; writing
   * each of those payloads to the outbox would copy the whole library into `meta` once per target
   * for no gain, because the cache the push is built from is what already survives a reload.
   */
  /**
   * `subject`, when given, names the one record a WHOLE-RECORD save replaces (a profile, a bean lot,
   * a run). On a version conflict the replay below re-applies `apply` onto the refetched library; for
   * a patch that is exactly right, but for a whole-record upsert it would write this browser's full
   * copy over another browser's edit to the same record and report success. So a subject that changed
   * on the roaster between this browser's copy and the refetch ends the save as a conflict instead.
   * Edits to OTHER records in the same collection document still merge by replay.
   */
  private async commitRevisioned(
    target: DocumentTarget,
    apply: (working: Working) => void,
    subject?: (working: Working) => unknown,
  ): Promise<void> {
    const client = this.client
    if (!client?.readManifestPage) throw new Error('The roaster library is not ready.')
    await this.awaitMutationReady()
    if (!this.working) throw new Error('The roaster library is not ready.')
    if (this.blockedTargets.has(target))
      throw new Error(
        'This controller document is invalid. Restore or reformat the library before editing this section.',
      )

    // Public save methods have already touched IndexedDB. Put the authoritative mirror back before
    // crossing the transport boundary; the draft is committed locally only after device ack.
    await this.mirrorTarget(target)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const draft = cloneWorking(this.working)
      apply(draft)
      const payload = this.payloadFor(target, draft)
      const writeBaseStateRev = this.state.mirrorStateRev
      const result =
        payload === undefined
          ? await client.deleteDocument(target, this.versions.get(target) ?? 0)
          : await client.writeDocument(target, payload, this.versions.get(target) ?? 0)
      if (result.kind === 'ok') {
        this.working = draft
        this.versions.set(target, result.version)
        await this.mirrorTarget(target)
        if (target.startsWith('runs/'))
          await this.rememberRunVersion(
            target.slice('runs/'.length),
            payload === undefined ? undefined : result.version,
          )
        if (
          this.state.health === 'current' &&
          this.state.mirrorStateRev === writeBaseStateRev &&
          this.state.deviceStateRev === writeBaseStateRev &&
          !this.state.adoption &&
          !this.adoptionCandidate &&
          isAcknowledgedSuccessor(writeBaseStateRev, result.stateRev)
        ) {
          let runBytes = this.state.runBytes
          if (target.startsWith('runs/')) {
            const runId = target.slice('runs/'.length)
            runBytes = { ...runBytes }
            if (payload === undefined) delete runBytes[runId]
            else runBytes[runId] = byteLength(payload)
          }
          this.state = {
            ...this.state,
            health: 'current',
            offline: false,
            waitingForIdle: false,
            deviceStateRev: result.stateRev,
            mirrorStateRev: result.stateRev,
            reason: undefined,
            lastSyncedAtMs: Date.now(),
            runBytes,
            lastExportedAt: draft.lastExportedAt,
            message: undefined,
          }
          this.notify()
          return
        }
        this.state = {
          ...this.state,
          health: 'syncing',
          offline: false,
          waitingForIdle: false,
          deviceStateRev: result.stateRev ?? this.state.deviceStateRev,
          reason: undefined,
          lastSyncedAtMs: Date.now(),
        }
        this.notify()
        await this.reloadRevisioned(
          client as DeviceStoreClient & { readManifestPage: NonNullable<DeviceStoreClient['readManifestPage']> },
        )
        return
      }
      if (result.kind === 'conflict' && attempt === 0) {
        const before = subject && this.working ? subject(this.working) : undefined
        await this.reloadRevisioned(
          client as DeviceStoreClient & { readManifestPage: NonNullable<DeviceStoreClient['readManifestPage']> },
        )
        const after = this.mutationBlockedReason()
        if (after) throw new Error(after)
        if (subject && this.working && !stableEquals(before, subject(this.working))) {
          throw new Error(
            'Another browser changed this at the same time. Your version was not saved; review the roaster copy and apply your change again.',
          )
        }
        continue
      }
      if (result.kind === 'unreachable' || result.kind === 'unmounted') {
        throw new Error(
          result.kind === 'unmounted'
            ? 'The roaster library is unavailable. Its existing copy was not replaced.'
            : 'The connection ended before this change could be confirmed. The roaster remains the source of truth; reconnect and review its copy before trying again.',
        )
      }
      if (result.kind === 'busy')
        throw new Error(result.message ?? 'The roaster is running or recording. Try again when it is idle.')
      if (result.kind === 'too-large')
        throw new Error(result.message ?? 'That change is too large for the roaster to store.')
      if (result.kind === 'no-space')
        throw new Error(result.message ?? 'The roaster is out of room. Delete some roasts or recordings and try again.')
      throw new Error(
        result.kind === 'conflict'
          ? 'Another browser changed this at the same time. Review the roaster copy and try again.'
          : result.message,
      )
    }
  }

  private enqueue(
    target: DocumentTarget,
    apply: (working: Working) => void,
    durable = true,
    subject?: (working: Working) => unknown,
  ): Promise<void> {
    if (this.restoreLocked) {
      return Promise.reject(
        new Error('The backup restore is still in progress. Wait for it to finish before making another change.'),
      )
    }
    if (this.blockedTargets.has(target)) {
      return this.mirrorTarget(target).then(() => {
        this.notify()
        throw new Error(
          'This controller document is invalid. Restore or reformat the library before editing this section.',
        )
      })
    }
    if (durable && this.client?.readManifestPage) return this.commitRevisioned(target, apply, subject)
    if (this.working) apply(this.working)
    if (!this.client) return Promise.resolve()
    const snapshot = durable
      ? undefined
      : { payload: this.payloadFor(target) ?? null, base: this.versions.get(target) ?? 0 }
    this.queue.push({ target, apply, snapshot })
    // After `apply`, so the entry holds the document as edited, and before the flush, so a reload
    // between the two finds the write still owed rather than silently dropped.
    const remembered = durable ? this.remember(target) : Promise.resolve()
    this.state = { ...this.state, queued: this.queue.length }
    return remembered.then(() => this.flush())
  }

  /**
   * Enter before the first cache await, not merely before enqueue. JavaScript runs this increment
   * synchronously, so Begin Restore can distinguish a genuinely quiet library from a save that is
   * currently between IndexedDB and its durable device-queue entry.
   */
  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    await this.awaitMutationReady()
    if (this.restoreLocked) {
      throw new Error('The backup restore is still in progress. Wait for it to finish before making another change.')
    }
    this.activeMutations += 1
    try {
      return await operation()
    } finally {
      this.activeMutations -= 1
    }
  }

  /** The queued write, as it would be posted right now: finished document, and its base version. */
  private remember(target: DocumentTarget): Promise<void> {
    const payload = this.payloadFor(target)
    this.outbox.set(target, { payload: payload ?? null, base: this.versions.get(target) ?? 0 })
    return this.persistOutbox()
  }

  /** Offer the queue to the controller now. Safe to call at any time; a busy queue simply stays. */
  flushPending() {
    return this.flush()
  }

  /**
   * Claim the data layer for a destructive restore.
   *
   * The UI disables Restore while writes are queued, but this is the authoritative check at the
   * instant before erase. The lock closes the race in which another screen saves after that check.
   */
  private async claimDeviceRestore() {
    if (this.restoreLocked) throw new Error('A restore is already in progress.')
    if (this.queue.length > 0 || this.activeMutations > 0) {
      throw new Error('The roaster still has unsaved changes waiting. Let them finish before restoring a backup.')
    }
    this.restoreLocked = true
    this.restoreResetRequired = false
    try {
      // A drain admitted before the lock can have shifted its final item out of `queue` while its
      // controller acknowledgement and durable outbox removal are still in flight.
      await this.flushTail
      await this.outboxTail
      // A refresh admitted before the lock must finish before format. Otherwise it could mirror its
      // pre-format snapshot after the empty-baseline clear.
      await this.reloadTail
      if (this.client?.beginRestoreMaintenance) {
        const result = await this.client.beginRestoreMaintenance()
        if (!result.ok || !result.token) {
          throw new Error(result.message ?? 'The roaster could not enter restore maintenance mode.')
        }
        this.restoreMaintenanceToken = result.token
      }
    } catch (error) {
      // No format boundary was crossed. A failed claim must not strand the browser behind a lock.
      this.restoreMaintenanceToken = undefined
      this.restoreLocked = false
      this.restoreResetRequired = false
      throw error
    }
  }
  /** Claim the destructive restore boundary through the ordinary current-catalog gate. */
  async beginDeviceRestore() {
    const gate = this.mutationBlockedReason()
    if (gate) throw new Error(gate)
    await this.claimDeviceRestore()
  }

  /**
   * Recover a controller whose data volume cannot mount.
   *
   * Catalog currency is intentionally not required: an unmounted volume can never become current
   * before it is formatted. Everything else remains fail-closed. The configured cache must already
   * be bound to the same live device identity, the revisioned transport and all maintenance lease
   * operations must exist, the controller must still be reachable, and the ordinary restore lock
   * and quiescence checks are unchanged. No normal mutation calls this path.
   */
  async beginDeviceStorageRecovery(expectedDeviceId: string): Promise<{ formatRequired: boolean }> {
    const expected = expectedDeviceId.trim()
    if (!expected) throw new Error('The roaster did not report a stable device identity.')
    if (
      !this.client?.readManifestPage ||
      !this.client.beginRestoreMaintenance ||
      !this.client.commitRestoreMaintenance ||
      !this.client.abortRestoreMaintenance
    ) {
      throw new Error('This roaster does not support safe storage recovery.')
    }
    if (this.state.mode !== 'device' || !this.state.attached || this.state.offline) {
      throw new Error('The roaster is not connected, so its storage cannot be formatted.')
    }
    if (!this.state.deviceStateRev) {
      throw new Error('Wait for the roaster to report its current storage revision before recovery.')
    }
    const observed = await this.cache.observedDeviceBinding()
    if (!observed || observed !== expected) {
      throw new Error(
        'The connected roaster identity does not match this browser cache, so storage recovery was refused.',
      )
    }
    if (this.restoreLocked) {
      if (this.storageRecoveryDeviceId === expected) {
        return { formatRequired: !this.storageRecoveryFormatted }
      }
      throw new Error('A restore is already in progress.')
    }
    // Only this live page can prove that its own format already crossed the destructive boundary.
    // After reload, a generic incomplete marker may instead be a partially written backup restore;
    // fail closed by formatting a fresh empty volume rather than committing unknown partial data.
    const formatAlreadyConfirmed = this.storageRecoveryDeviceId === expected && this.storageRecoveryFormatted
    await this.claimDeviceRestore()
    if (!this.restoreMaintenanceToken) {
      this.restoreLocked = false
      throw new Error('The roaster did not return a storage-maintenance token.')
    }
    this.storageRecoveryDeviceId = expected
    this.storageRecoveryFormatted = formatAlreadyConfirmed
    return { formatRequired: !formatAlreadyConfirmed }
  }

  /**
   * Drop a rejected/expired browser lease while retaining this page's proof that format completed.
   * The next recovery attempt must claim a fresh controller lease before it can reconcile or commit.
   */
  releaseDeviceStorageRecoveryForRetry(): boolean {
    if (!this.restoreLocked || !this.storageRecoveryDeviceId) return false
    this.restoreMaintenanceToken = undefined
    this.restoreLocked = false
    this.restoreResetRequired = false
    this.notify()
    return true
  }

  /** Synchronous format boundary used by the transport callback before it starts any restore write. */
  deviceFormatConfirmed() {
    if (!this.restoreLocked) throw new Error('A device format was reported outside a backup restore.')
    this.restoreResetRequired = true
    if (this.storageRecoveryDeviceId) this.storageRecoveryFormatted = true
  }

  /**
   * Release the restore lock. Only a confirmed successful format invalidates the former device
   * versions and durable outbox; a refused format leaves every pending intention exactly as it was.
   */
  async resetAfterDeviceFormat() {
    if (!this.restoreLocked) throw new Error('The device library can only be reset during a backup restore.')
    this.restoreResetRequired = true
    await this.reloadTail
    // The outbox and version ledger are device identity too. Deleting them in the SAME transaction
    // as the mirror prevents old base-0 intent from surviving a formatted controller.
    await this.cache.clearDeviceLibraryMirror([LAST_EXPORTED_KEY, OUTBOX_KEY, RUN_VERSIONS_KEY])
    this.queue = []
    this.outbox.clear()
    this.versions.clear()
    this.blockedTargets.clear()
    this.outboxLoaded = true
    this.working = undefined
    this.state = {
      ...this.state,
      queued: 0,
      waitingForIdle: false,
      runBytes: {},
      lastExportedAt: undefined,
      adoption: undefined,
    }
    this.restoreResetRequired = false
    this.notify()
  }

  /** The only reload admitted while restore owns the library; it necessarily starts from the clear mirror. */
  async reconcileDeviceRestore() {
    if (!this.restoreLocked) throw new Error('There is no backup restore to reconcile.')
    if (this.restoreResetRequired)
      throw new Error('The former browser mirror was not safely cleared, so reconciliation cannot continue.')
    if (this.client?.commitRestoreMaintenance && this.restoreMaintenanceToken) {
      const result = await this.client.commitRestoreMaintenance(this.restoreMaintenanceToken)
      if (!result.ok) throw new Error(result.message ?? 'The roaster could not commit the restored library.')
      this.restoreMaintenanceToken = undefined
    }
    await this.reload()
  }

  async abortDeviceRestore() {
    if (this.client?.abortRestoreMaintenance && this.restoreMaintenanceToken) {
      const result = await this.client.abortRestoreMaintenance(this.restoreMaintenanceToken)
      if (!result.ok) throw new Error(result.message ?? 'The roaster could not abort restore maintenance mode.')
    }
    this.restoreMaintenanceToken = undefined
    this.restoreLocked = false
    this.restoreResetRequired = false
    this.storageRecoveryDeviceId = undefined
    this.storageRecoveryFormatted = false
    this.requestReconcile()
  }

  finishDeviceRestore() {
    if (this.restoreResetRequired) {
      this.state = {
        ...this.state,
        message:
          'The roaster was erased, but this browser could not safely clear its former library. Editing and refresh remain locked; do not reload this page until the storage error is resolved.',
      }
      this.notify()
      return false
    }
    this.restoreLocked = false
    this.storageRecoveryDeviceId = undefined
    this.storageRecoveryFormatted = false
    this.notify()
    return true
  }

  private payloadFor(target: DocumentTarget, source = this.working): string | undefined {
    const working = source
    if (!working) return undefined
    if (target === 'profiles') return serializeProfilesDocument(working.profiles, working.profileRevisions)
    if (target === 'beans') return serializeBeansDocument(working.beans, working.beanRevisions)
    if (target === 'calibrations')
      return serializeCalibrationsDocument(working.settings, working.snapshots, working.calibrationRuns)
    if (target === 'meta')
      return serializeMetaDocument(working.importedDeviceLogs, working.manualEvents, working.lastExportedAt)
    const run = working.runs.get(target.slice('runs/'.length))
    return run ? serializeRunDocument(run) : undefined
  }

  private async refetch(target: DocumentTarget, replay = true): Promise<boolean> {
    const client = this.client
    const working = this.working
    if (!client || !working) return false
    const read = await client.readDocument(target)
    if (read.kind === 'ok') {
      this.versions.set(target, read.version)
      try {
        if (target.startsWith('runs/')) working.runs.set(target.slice('runs/'.length), parseRunDocument(read.payload))
        else this.applyCollection(working, target as CollectionName, read.payload)
        this.blockedTargets.delete(target)
      } catch {
        this.blockedTargets.add(target)
        return false
      }
    } else if (read.kind === 'missing' || read.kind === 'corrupt') {
      this.versions.set(target, 0)
      if (target.startsWith('runs/')) working.runs.delete(target.slice('runs/'.length))
      else this.clearCollection(working, target as CollectionName)
      if (read.kind === 'corrupt') this.blockedTargets.add(target)
      else this.blockedTargets.delete(target)
    } else {
      return false
    }
    // Every queued edit for this document is replayed, not only the one that conflicted: the
    // refetch above just overwrote the working copy the others had already been applied to.
    if (replay) for (const pending of this.queue) if (pending.target === target) pending.apply(working)
    await this.mirrorTarget(target)
    return true
  }

  private flush(): Promise<void> {
    const next = this.flushTail.then(() => this.drain())
    this.flushTail = next.catch(() => undefined)
    return next
  }

  private async drain() {
    if (!this.client) return
    try {
      while (this.queue.length > 0) {
        const target = this.queue[0].target
        const outcome = await this.push(target)
        if (outcome === 'later') break
        this.queue = this.queue.filter((pending) => pending.target !== target)
        // Cleanup precedes a rejection so callers cannot report success, while the refused intent
        // also cannot be offered again on the next boot.
        await this.forget(target)
        this.state = { ...this.state, queued: this.queue.length }
        if (outcome instanceof Error) throw outcome
      }
    } finally {
      if (this.queue.length === 0) {
        this.state = { ...this.state, waitingForIdle: false }
        if (this.reconcileDeferredUntilIdle) this.requestReconcile()
      }
      this.notify()
    }
  }

  private async push(target: DocumentTarget): Promise<'done' | 'later' | Error> {
    const client = this.client
    if (!client) return 'later'
    for (let attempt = 0; ; attempt += 1) {
      const pending = this.queue.find((item) => item.target === target)
      const payload = pending?.snapshot ? (pending.snapshot.payload ?? undefined) : this.payloadFor(target)
      const base = pending?.snapshot?.base ?? this.versions.get(target) ?? 0
      const result =
        payload === undefined
          ? await client.deleteDocument(target, base)
          : await client.writeDocument(target, payload, base)
      if (result.kind === 'ok') {
        this.versions.set(target, result.version)
        if (pending?.snapshot) {
          pending.snapshot.base = result.version
          if (this.working) {
            if (payload === undefined) {
              if (target.startsWith('runs/')) this.working.runs.delete(target.slice('runs/'.length))
              else this.clearCollection(this.working, target as CollectionName)
            } else if (target.startsWith('runs/')) {
              this.working.runs.set(target.slice('runs/'.length), parseRunDocument(payload))
            } else {
              this.applyCollection(this.working, target as CollectionName, payload)
            }
          }
        }
        this.state = {
          ...this.state,
          offline: false,
          waitingForIdle: false,
          lastSyncedAtMs: Date.now(),
          message: undefined,
        }
        await this.mirrorTarget(target)
        if (target.startsWith('runs/'))
          await this.rememberRunVersion(
            target.slice('runs/'.length),
            payload === undefined ? undefined : result.version,
          )
        return 'done'
      }
      if (result.kind === 'busy') {
        this.state = { ...this.state, waitingForIdle: true }
        return 'later'
      }
      if (result.kind === 'unreachable' || result.kind === 'unmounted') {
        this.state = { ...this.state, offline: true }
        return 'later'
      }
      if (result.kind === 'conflict') {
        /*
         * A restored entry cannot be rebased. The mutation that would have been replayed onto the
         * roaster's newer copy went with the page that made it, and the only thing left is a
         * finished document built on a base the roaster has moved past. Replaying THAT would be
         * overwriting whatever changed in the meantime with a copy that predates it - the exact
         * thing device-truth exists to prevent. So the roaster keeps its version, the entry is
         * dropped, and the user is told plainly, once, that an edit of theirs is not there.
         */
        const restored = this.queue.filter((pending) => pending.target === target && pending.restored)
        if (restored.length > 0) {
          // Anything queued behind it in THIS session still has its mutation and is still rebasable.
          const live = this.queue.some((pending) => pending.target === target && !pending.restored)
          const notice = this.overtakenNotice(target)
          // Said once. A second conflict on the same target is now the ordinary retry story.
          for (const pending of restored) pending.restored = false
          this.versions.set(target, result.version)
          await this.refetch(target)
          this.state = { ...this.state, notices: [...(this.state.notices ?? []), notice] }
          if (!live) return 'done'
          continue
        }
        if (pending?.snapshot && attempt === 0) {
          pending.snapshot.base = result.version
          this.versions.set(target, result.version)
          await this.refetch(target)
          continue
        }
        // A delete is a decision about the version the user saw. Rebasing it would delete a run
        // another browser just updated or recreated, so keep that newer controller document.
        if (payload === undefined) {
          const rolledBack = await this.refetch(target, false)
          const message = 'This item changed on another browser, so it was not deleted. The roaster copy is now shown.'
          this.state = { ...this.state, message }
          return rolledBack ? new Error(message) : 'later'
        }
        if (attempt >= 1) {
          const rolledBack = await this.refetch(target, false)
          const message =
            'Another browser changed this at the same time. The roaster kept its copy, which is now shown.'
          this.state = { ...this.state, message }
          if (!rolledBack) return 'later'
          return new Error(message)
        }
        this.versions.set(target, result.version)
        await this.refetch(target)
        continue
      }
      this.state = {
        ...this.state,
        message:
          result.kind === 'too-large'
            ? 'That change is too large for the roaster to store, so it kept its previous copy.'
            : result.kind === 'no-space'
              ? 'The roaster is out of room. Delete some roasts or recordings and try again.'
              : result.message,
      }
      const rolledBack = await this.refetch(target, false)
      if (!rolledBack) return 'later'
      return new Error(this.state.message ?? 'The roaster refused this change.')
    }
  }

  /**
   * The sentence for an edit the roaster overtook, naming what it was an edit TO.
   *
   * Read before the refetch, so it names the thing the user is looking at rather than whatever the
   * roaster is about to put in its place. There is no wire vocabulary in it and no instruction to
   * reload: the roaster's version is already on screen by the time this is shown, and all that is
   * left to say is which edit went and that it has to be made again.
   */
  private overtakenNotice(target: DocumentTarget): string {
    const name =
      target === 'profiles'
        ? 'your profiles'
        : target === 'beans'
          ? 'your bean lots'
          : target === 'calibrations'
            ? 'your calibrations'
            : target === 'meta'
              ? 'your notes and event history'
              : `the roast "${this.working?.runs.get(target.slice('runs/'.length))?.name ?? target.slice('runs/'.length)}"`
    return `An edit to ${name} made while the roaster was busy could not be applied because the roaster's copy changed. The roaster's version is shown - please re-make your edit.`
  }

  /** The user has read it. Nothing else changes: the roaster's copy was already what is on screen. */
  dismissNotice(notice: string) {
    this.state = { ...this.state, notices: (this.state.notices ?? []).filter((entry) => entry !== notice) }
    this.notify()
  }

  private async rememberRunVersion(id: string, version: number | undefined) {
    const versions = (await this.cache.meta<Record<string, number>>(RUN_VERSIONS_KEY)) ?? {}
    if (version === undefined) delete versions[id]
    else versions[id] = version
    await this.cache.saveMeta(RUN_VERSIONS_KEY, versions)
  }

  // ------------------------------------------------------------------------------------- reads

  async profiles() {
    if (this.working) return this.working.profiles
    const [profiles, order] = await Promise.all([this.cache.profiles(), this.cache.meta<string[]>(PROFILE_ORDER_KEY)])
    return orderedByIds(profiles, order ?? [])
  }
  async beans() {
    if (this.working) return this.working.beans
    const [beans, order] = await Promise.all([this.cache.beans(), this.cache.meta<string[]>(BEAN_ORDER_KEY)])
    return orderedByIds(beans, order ?? [])
  }
  async runs() {
    return (this.working ? [...this.working.runs.values()] : await this.cache.runs()).map((run) =>
      this.withHydratedRun(run),
    )
  }
  async calibrationRuns() {
    return (this.working?.calibrationRuns ?? (await this.cache.calibrationRuns())).map((run) =>
      this.withHydratedCalibration(run),
    )
  }

  private calibrationRecordingKey(run: CalibrationRun): string | undefined {
    return run.sourceLogId ? recordingKey({ deviceId: run.recordedOn.deviceId, logId: run.sourceLogId }) : undefined
  }

  private withHydratedCalibration(run: CalibrationRun): CalibrationRun {
    if (run.samples.length > 0) return run
    const key = this.calibrationRecordingKey(run)
    const samples = key ? this.hydratedCalibrationSamples.get(key) : undefined
    return samples ? { ...run, samples } : run
  }

  private withHydratedRun(run: RoastRun): RoastRun {
    if (run.samples.length > 0 || !run.deviceRoast) return run
    const samples = this.hydratedRunSamples.get(recordingKey(run.deviceRoast.recordingOrigin))
    return samples ? { ...run, samples } : run
  }
  async calibrationSnapshots() {
    return this.working?.snapshots ?? (await this.cache.calibrationSnapshots())
  }
  async manualEvents() {
    return this.working
      ? [...this.working.manualEvents].sort((a, b) => a.atMs - b.atMs)
      : await this.cache.manualEvents()
  }
  async profileRevisions() {
    return this.working
      ? byNewest(this.working.profileRevisions, (row) => row.savedAt)
      : await this.cache.profileRevisions()
  }
  async beanRevisions() {
    return this.working ? byNewest(this.working.beanRevisions, (row) => row.savedAt) : await this.cache.beanRevisions()
  }
  async calibration() {
    return this.working ? this.working.settings : await this.cache.calibration()
  }
  async importedDeviceLogIds(): Promise<Set<string>> {
    return this.working ? new Set(this.working.importedDeviceLogs) : await this.cache.importedDeviceLogIds()
  }

  // ------------------------------------------------------------------------------------ writes

  async saveProfile(profile: Profile) {
    return this.saveProfileWithRevision(profile)
  }

  /**
   * A profile and the history row describing that same Save belong to one collection document.
   * Applying them in one mutation avoids two full LittleFS replacements and prevents a successful
   * profile write from being separated from its revision by a second failed request.
   */
  async saveProfileWithRevision(profile: Profile, revision?: ProfileRevision) {
    return this.withMutation(async () => {
      const current = this.working?.profiles ?? (await this.profiles())
      const ordered = upsertNewest(current, profile)
      await this.cache.saveProfile(profile)
      await this.cache.saveMeta(
        PROFILE_ORDER_KEY,
        ordered.map((item) => item.id),
      )
      if (revision) await this.cache.saveProfileRevision(revision)
      return this.enqueue(
        'profiles',
        (working) => {
          working.profiles = upsertNewest(working.profiles, profile)
          if (revision) {
            working.profileRevisions = cappedPerSubject(
              upsert(working.profileRevisions, revision),
              (row) => row.profileId,
              (row) => row.savedAt,
            )
          }
        },
        true,
        (working) => working.profiles.find((item) => item.id === profile.id),
      )
    })
  }

  /**
   * Whether this roaster has never held a profiles document: a new or freshly formatted library.
   * An emptied library still has its document (and its edit history), so deleting every profile
   * never brings the defaults back. False while an adoption offer is pending.
   */
  profilesDocumentAbsent(): boolean {
    return (
      this.state.mode === 'device' &&
      this.working !== undefined &&
      this.state.health === 'current' &&
      !this.state.adoption &&
      !this.adoptionCandidate &&
      (this.versions.get('profiles') ?? 0) === 0
    )
  }

  /**
   * Install the default profiles into a library that has never held a profiles document, as one
   * revision-checked write. Returns false without writing when the document already exists. A second
   * browser racing the same install meets a version conflict, and the replay guard refuses because
   * the other browser's write changed the profile list; the caller treats that as already installed.
   */
  async installDefaultProfiles(profiles: Profile[], revisions: ProfileRevision[]): Promise<boolean> {
    if (!this.profilesDocumentAbsent()) return false
    return this.withMutation(async () => {
      for (const profile of profiles) await this.cache.saveProfile(profile)
      await this.cache.saveMeta(
        PROFILE_ORDER_KEY,
        profiles.map((profile) => profile.id),
      )
      for (const revision of revisions) await this.cache.saveProfileRevision(revision)
      await this.enqueue(
        'profiles',
        (working) => {
          working.profiles = [
            ...profiles,
            ...working.profiles.filter((row) => !profiles.some((profile) => profile.id === row.id)),
          ]
          working.profileRevisions = revisions.reduce(
            (rows, revision) =>
              cappedPerSubject(
                upsert(rows, revision),
                (row) => row.profileId,
                (row) => row.savedAt,
              ),
            working.profileRevisions,
          )
        },
        true,
        (working) => working.profiles.map((profile) => profile.id),
      )
      return true
    })
  }

  async reorderProfiles(ids: string[]) {
    return this.withMutation(async () => {
      const current = this.working?.profiles ?? (await this.cache.profiles())
      const ordered = orderedByIds(current, ids)
      await this.cache.saveMeta(
        PROFILE_ORDER_KEY,
        ordered.map((profile) => profile.id),
      )
      return this.enqueue('profiles', (working) => {
        working.profiles = orderedByIds(working.profiles, ids)
      })
    })
  }

  /**
   * Delete the RECIPE, and only the recipe.
   *
   * Every stored roast embeds its own snapshot of the profile it ran, so the history is untouched
   * and simply lists those roasts as unlinked. Deleting the roasts as well is a second, separate
   * decision - see `deleteRunsNow`, which is what a cascade uses and which is deliberately not this.
   */
  async deleteProfile(id: string) {
    return this.withMutation(async () => {
      await this.cache.deleteProfile(id)
      await this.cache.deleteProfileRevisions(id)
      return this.enqueue('profiles', (working) => {
        working.profiles = working.profiles.filter((profile) => profile.id !== id)
        working.profileRevisions = working.profileRevisions.filter((row) => row.profileId !== id)
      })
    })
  }

  async saveProfileRevision(revision: ProfileRevision) {
    return this.withMutation(async () => {
      await this.cache.saveProfileRevision(revision)
      return this.enqueue('profiles', (working) => {
        working.profileRevisions = cappedPerSubject(
          upsert(working.profileRevisions, revision),
          (row) => row.profileId,
          (row) => row.savedAt,
        )
      })
    })
  }

  async saveBean(bean: BeanLot) {
    return this.withMutation(async () => {
      const current = this.working?.beans ?? (await this.beans())
      const ordered = upsertNewest(current, bean)
      await this.cache.saveBean(bean)
      await this.cache.saveMeta(
        BEAN_ORDER_KEY,
        ordered.map((item) => item.id),
      )
      return this.enqueue(
        'beans',
        (working) => {
          working.beans = upsertNewest(working.beans, bean)
        },
        true,
        (working) => working.beans.find((item) => item.id === bean.id),
      )
    })
  }

  async reorderBeans(ids: string[]) {
    return this.withMutation(async () => {
      const current = this.working?.beans ?? (await this.beans())
      const ordered = orderedByIds(current, ids)
      await this.cache.saveMeta(
        BEAN_ORDER_KEY,
        ordered.map((bean) => bean.id),
      )
      return this.enqueue('beans', (working) => {
        working.beans = orderedByIds(working.beans, ids)
      })
    })
  }

  async deleteBean(id: string) {
    return this.withMutation(async () => {
      await this.cache.deleteBean(id)
      return this.enqueue('beans', (working) => {
        working.beans = working.beans.filter((bean) => bean.id !== id)
      })
    })
  }

  async saveBeanRevision(revision: BeanRevision) {
    return this.withMutation(async () => {
      await this.cache.saveBeanRevision(revision)
      return this.enqueue('beans', (working) => {
        working.beanRevisions = cappedPerSubject(
          upsert(working.beanRevisions, revision),
          (row) => row.beanId,
          (row) => row.savedAt,
        )
      })
    })
  }

  async deleteBeanRevisions(beanId: string) {
    return this.withMutation(async () => {
      await this.cache.deleteBeanRevisions(beanId)
      return this.enqueue('beans', (working) => {
        working.beanRevisions = working.beanRevisions.filter((row) => row.beanId !== beanId)
      })
    })
  }

  async saveRun(run: RoastRun) {
    return this.withMutation(async () => {
      await this.cache.saveRun(run)
      return this.enqueue(
        runTarget(run.id),
        (working) => {
          working.runs.set(run.id, run)
        },
        true,
        (working) => working.runs.get(run.id),
      )
    })
  }

  /**
   * Archive reconciliation's write. The completed record is built from the staged record as it
   * stood when the pass began, and a pass fetches recordings for seconds; the user can save a
   * score, notes, or a final weight on that record meanwhile. A plain `saveRun` would then write the
   * pre-edit copy against the CURRENT version - no conflict, the edit silently erased. So at commit
   * time (and again on any conflict replay) every user-editable field that changed since `basis`
   * is taken from the record as it now stands. Returns the record actually written.
   */
  async saveReconciledRun(run: RoastRun, basis: RoastRun | undefined): Promise<RoastRun> {
    let written = run
    await this.withMutation(async () => {
      const rebase = (current: RoastRun | undefined): RoastRun => {
        if (!basis || !current || stableEquals(current, basis)) return run
        const measurements = { ...(run.measurements ?? {}) }
        const currentMeasurements = current.measurements ?? {}
        const basisMeasurements = basis.measurements ?? {}
        for (const key of new Set([...Object.keys(currentMeasurements), ...Object.keys(basisMeasurements)]) as Set<
          keyof NonNullable<RoastRun['measurements']>
        >) {
          if (currentMeasurements[key] === basisMeasurements[key]) continue
          if (currentMeasurements[key] === undefined) delete measurements[key]
          else measurements[key] = currentMeasurements[key]
        }
        return {
          ...run,
          ...(current.notes !== basis.notes ? { notes: current.notes } : {}),
          ...(current.score !== basis.score ? { score: current.score } : {}),
          ...(current.name !== basis.name ? { name: current.name } : {}),
          ...(current.beanLotId !== basis.beanLotId
            ? { beanLotId: current.beanLotId, beanLotSnapshot: current.beanLotSnapshot }
            : {}),
          ...(Object.keys(measurements).length > 0 ? { measurements } : { measurements: undefined }),
        }
      }
      written = rebase(this.working?.runs.get(run.id))
      await this.cache.saveRun(written)
      return this.enqueue(runTarget(run.id), (working) => {
        written = rebase(working.runs.get(run.id))
        working.runs.set(run.id, written)
      })
    })
    return written
  }

  /**
   * The rebasing write. Notes, measurements and profile links all arrive as a PATCH rather than as a
   * finished record, so when the phone saved a tasting note at the same moment the PC saved a final
   * weight, the replay onto refetched state produces a roast carrying both.
   */
  async updateRun(id: string, patch: Partial<RoastRun>) {
    return this.withMutation(async () => {
      const current = this.working?.runs.get(id) ?? (await this.cache.runs()).find((run) => run.id === id)
      if (!current) return
      await this.cache.saveRun({ ...current, ...patch })
      return this.enqueue(runTarget(id), (working) => {
        const existing = working.runs.get(id)
        if (existing) working.runs.set(id, { ...existing, ...patch })
      })
    })
  }

  async deleteRun(id: string) {
    return this.withMutation(async () => {
      await this.cache.deleteRun(id)
      return this.enqueue(runTarget(id), (working) => {
        working.runs.delete(id)
      })
    })
  }

  async saveCalibrationRun(run: CalibrationRun) {
    return this.withMutation(async () => {
      await this.cache.saveCalibrationRun(run)
      return this.enqueue(
        'calibrations',
        (working) => {
          working.calibrationRuns = upsert(working.calibrationRuns, run)
        },
        true,
        (working) => working.calibrationRuns.find((item) => item.id === run.id),
      )
    })
  }

  async deleteCalibrationRun(id: string) {
    return this.withMutation(async () => {
      await this.cache.deleteCalibrationRun(id)
      return this.enqueue('calibrations', (working) => {
        working.calibrationRuns = working.calibrationRuns.filter((run) => run.id !== id)
      })
    })
  }

  async saveCalibrationSnapshot(snapshot: CalibrationSnapshot) {
    return this.withMutation(async () => {
      await this.cache.saveCalibrationSnapshot(snapshot)
      return this.enqueue(
        'calibrations',
        (working) => {
          working.snapshots = upsert(working.snapshots, snapshot)
        },
        true,
        (working) => working.snapshots.find((item) => item.id === snapshot.id),
      )
    })
  }

  async deleteCalibrationSnapshot(id: string) {
    return this.withMutation(async () => {
      await this.cache.deleteCalibrationSnapshot(id)
      return this.enqueue('calibrations', (working) => {
        working.snapshots = working.snapshots.filter((snapshot) => snapshot.id !== id)
      })
    })
  }

  async saveCalibration(settings: CalibrationSettings) {
    return this.withMutation(async () => {
      await this.cache.saveCalibration(settings)
      return this.enqueue(
        'calibrations',
        (working) => {
          working.settings = settings
        },
        true,
        (working) => working.settings,
      )
    })
  }

  async saveManualEvents(events: ManualEvent[]) {
    if (events.length === 0) return
    return this.withMutation(async () => {
      for (const event of events) await this.cache.saveManualEvent(event)
      return this.enqueue('meta', (working) => {
        const incoming = new Map(events.map((event) => [event.id, event]))
        working.manualEvents = [...working.manualEvents.filter((row) => !incoming.has(row.id)), ...incoming.values()]
          .sort((a, b) => a.atMs - b.atMs)
          .slice(-MANUAL_EVENT_CAP)
      })
    })
  }

  async saveManualEvent(event: ManualEvent) {
    return this.saveManualEvents([event])
  }

  async clearManualEvents() {
    return this.withMutation(async () => {
      await this.cache.clearManualEvents()
      return this.enqueue('meta', (working) => {
        working.manualEvents = []
      })
    })
  }

  /**
   * The library as DOCUMENTS - exactly the payloads a write would post right now.
   *
   * This is what a backup is made of, and it is deliberately not a re-rendering of the records the
   * screens are holding: the file has to contain what the roaster contains, so that restoring it
   * posts back the same bytes rather than whatever this build of the serializer would produce from a
   * hydrated copy. It works in browser mode too, where the working copy is built from the cache -
   * a roaster with no document store still has a library worth backing up.
   */
  async documentPayloads(): Promise<{
    collections: Record<CollectionName, string>
    runs: Array<{ id: string; payload: string }>
  }> {
    const working = this.working ?? (await this.cachedWorking())
    return {
      collections: {
        profiles: serializeProfilesDocument(working.profiles, working.profileRevisions),
        beans: serializeBeansDocument(working.beans, working.beanRevisions),
        calibrations: serializeCalibrationsDocument(working.settings, working.snapshots, working.calibrationRuns),
        meta: serializeMetaDocument(working.importedDeviceLogs, working.manualEvents, working.lastExportedAt),
      },
      runs: [...working.runs.values()].map((run) => ({ id: run.id, payload: serializeRunDocument(run) })),
    }
  }

  /** Stamp a whole-library export. Mirrored into the cache so it survives a store-less controller. */
  async markExported(isoTimestamp: string) {
    return this.withMutation(async () => {
      await this.cache.saveMeta(LAST_EXPORTED_KEY, isoTimestamp)
      this.state = { ...this.state, lastExportedAt: isoTimestamp }
      const queued = this.enqueue('meta', (working) => {
        working.lastExportedAt = isoTimestamp
      })
      this.notify()
      return queued
    })
  }

  /**
   * ==========================================================================================
   * THE CASCADE DELETE - immediate, or refused
   * ==========================================================================================
   *
   * Ordinary writes already fail closed while stale, unreachable, or busy. A cascade also needs
   * item-by-item acknowledgement because it can destroy many roast documents and recordings and has
   * no undo; partial progress must remain visible and must never be replayed later.
   *
   * So this talks to the controller directly. A document the device
   * refuses is REPORTED rather than retried, and the working copy loses only what the device
   * actually confirmed gone, so a partial failure leaves the browser telling the truth about it.
   */
  async deleteRunsNow(ids: string[]): Promise<{ deleted: string[]; failed: Array<{ id: string; message: string }> }> {
    return this.withMutation(async () => {
      const client = this.client
      const deleted: string[] = []
      const failed: Array<{ id: string; message: string }> = []
      for (const id of ids) {
        const result = client
          ? await client.deleteDocument(runTarget(id), this.versions.get(runTarget(id)) ?? 0)
          : { kind: 'ok' as const, version: 0 }
        if (result.kind !== 'ok') {
          failed.push({
            id,
            message:
              result.kind === 'busy'
                ? 'the roaster is running or recording'
                : result.kind === 'unreachable' || result.kind === 'unmounted'
                  ? 'the roaster did not answer'
                  : result.kind === 'error'
                    ? result.message
                    : result.kind,
          })
          continue
        }
        deleted.push(id)
        this.working?.runs.delete(id)
        this.versions.delete(runTarget(id))
        this.queue = this.queue.filter((pending) => pending.target !== runTarget(id))
        await this.forget(runTarget(id))
        await this.cache.deleteRun(id)
        await this.rememberRunVersion(id, undefined)
      }
      if (deleted.length > 0) this.notify()
      return { deleted, failed }
    })
  }

  async markDeviceLogsImported(ids: string[]) {
    return this.withMutation(async () => {
      await this.cache.markDeviceLogsImported(ids)
      return this.enqueue('meta', (working) => {
        working.importedDeviceLogs = [...new Set([...working.importedDeviceLogs, ...ids])].sort()
      })
    })
  }

  /** Dev-server only, and cache-first: the reseed then pushes as a whole through the same queue. */
  async resetDemoData(force = false) {
    return this.withMutation(async () => {
      await this.cache.resetDemoData(force)
      if (!this.client) return
      this.working = await this.cachedWorking()
      for (const name of COLLECTIONS) void this.enqueue(name, () => {}, false)
      for (const id of this.working.runs.keys()) void this.enqueue(runTarget(id), () => {}, false)
      await this.flush()
    })
  }

  /** Make one cache document an exact mirror, including deletions. */
  private async mirrorTarget(target: DocumentTarget) {
    const working = this.working
    if (!working) return
    if (target === 'profiles') {
      await this.pruneCache(await this.cache.profiles(), working.profiles, (id) => this.cache.deleteProfile(id))
      await this.cache.clearProfileRevisions()
      await Promise.all([
        ...working.profiles.map((value) => this.cache.saveProfile(value)),
        ...working.profileRevisions.map((value) => this.cache.saveProfileRevision(value)),
        this.cache.saveMeta(
          PROFILE_ORDER_KEY,
          working.profiles.map((profile) => profile.id),
        ),
      ])
      return
    }
    if (target === 'beans') {
      await this.pruneCache(await this.cache.beans(), working.beans, (id) => this.cache.deleteBean(id))
      await this.cache.clearBeanRevisions()
      await Promise.all([
        ...working.beans.map((value) => this.cache.saveBean(value)),
        ...working.beanRevisions.map((value) => this.cache.saveBeanRevision(value)),
        this.cache.saveMeta(
          BEAN_ORDER_KEY,
          working.beans.map((bean) => bean.id),
        ),
      ])
      return
    }
    if (target === 'calibrations') {
      await this.cache.clearCalibrationRuns()
      await this.cache.clearCalibrationSnapshots()
      if (working.settings) await this.cache.saveCalibration(working.settings)
      else await this.cache.clearCalibration()
      await Promise.all([
        // With the samples this browser already downloaded: the documents carry none.
        ...working.calibrationRuns.map((value) => this.cache.saveCalibrationRun(this.withHydratedCalibration(value))),
        ...working.snapshots.map((value) => this.cache.saveCalibrationSnapshot(value)),
      ])
      return
    }
    if (target === 'meta') {
      await this.cache.clearManualEvents()
      await Promise.all(working.manualEvents.map((value) => this.cache.saveManualEvent(value)))
      await this.cache.replaceDeviceLogsImported(working.importedDeviceLogs)
      if (working.lastExportedAt) await this.cache.saveMeta(LAST_EXPORTED_KEY, working.lastExportedAt)
      else await this.cache.deleteMeta(LAST_EXPORTED_KEY)
      return
    }
    const id = target.slice('runs/'.length)
    const run = working.runs.get(id)
    if (run) await this.cache.saveRun(this.withHydratedRun(run))
    else await this.cache.deleteRun(id)
  }

  private async mirrorAll(working: Working) {
    this.working = working
    await Promise.all(COLLECTIONS.map((name) => this.mirrorTarget(name)))
    await Promise.all([...working.runs.keys()].map((id) => this.mirrorTarget(runTarget(id)))).catch(() => undefined)
  }
}

export const crackleData = new CrackleData()
