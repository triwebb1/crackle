/**
 * ============================================================================================
 * WHAT IS ON THE CONTROLLER, WHAT IT COSTS, AND WHAT GOES IF YOU DELETE SOMETHING
 * ============================================================================================
 *
 * The requirement: show how much storage there is, how much is used, how much is free, and what is
 * consuming the space; explain when and why deleting something is worth doing and what its impact
 * will be, with the ability to do it; and inform the user when a decision about what to delete is
 * actually needed.
 *
 * The controller is the database, so every number in here comes from the DEVICE - `data_store` and
 * `log_archive` in the status document, and the per-recording entries from `GET /api/logs`. Nothing
 * is inferred from a constant that could drift: the average recording size is measured from the
 * recordings that are actually on the volume, and the average run-document size from the run index
 * the store itself reports. That is the difference between "roughly 40 more roasts" being a fact
 * about this roaster and being a number someone typed into a spreadsheet in 2026.
 *
 * --------------------------------------------------------------------------------------------
 * FREE SPACE IS NOT WHAT IS LEFT OVER
 * --------------------------------------------------------------------------------------------
 *
 * The 896 KB LittleFS volume is shared by two tenants with two different rules, and a bar that
 * showed only used-versus-total would be lying twice.
 *
 * There is ONE number that says where the line is, and the device sends it: `data_store.
 * write_floor_bytes`. The firmware refuses any document write that would leave the volume with less
 * than that free (`507`), and it DERIVES it rather than choosing it twice -
 *
 *     write floor = the archive's working reserve + the largest recording a persist can produce
 *
 * - so that a document write can never be the reason a stored recording is deleted. The reserve is
 * INSIDE the floor. Subtracting both is charging the reserve twice; against a hardcoded 64 KB floor
 * (which the firmware does not enforce) that reads 64 + 96 = 160 KiB withheld where the real answer
 * is 219,548 bytes, and promises room for two or three roasts that are not there.
 *
 * So `usableFreeBytes` is `total - used - floor`: what a NEW roast can actually have without either
 * refusing a write or destroying an old recording, and it is the number the capacity estimate is
 * built on. The floor is still SHOWN split into its two halves, because the two halves mean
 * different things to a user - one is somebody's old roast, the other is room for the next one.
 *
 * And the number it is subtracted FROM comes from one place only. `log_archive.used_bytes` is the
 * whole volume despite its name - see `volumeUsedBytes`, which is the only thing in this file
 * allowed to decide what "used" means, precisely so that the two tenants can never be added to the
 * total that already contains them both.
 *
 * --------------------------------------------------------------------------------------------
 * DELETING A PROFILE OR A BEAN LOT
 * --------------------------------------------------------------------------------------------
 *
 * It is tempting to assume that deleting a profile requires deleting every historical roast that
 * used it. It requires no such thing, and saying so plainly is worth more than a cascade: **every run
 * document embeds its own snapshot** of the profile and the bean lot it was roasted with, so a roast
 * whose profile is gone still opens, still charts, still compares. It simply lists as unlinked.
 *
 * That makes deletion two genuinely different decisions rather than one with a scary confirmation,
 * and `cascadePlan` exists to state the second one exactly: which run documents die, which
 * recordings die with them, how many bytes come back, and over what dates. A plan is built and
 * SHOWN before anything is deleted, because "N roasts" is not something anyone can consent to
 * without knowing which ones.
 */
import type { DeviceArchiveStorage, DeviceLogEntry } from './deviceLogs'
import { recordingKey } from './provenance'
import type { BeanLot, ControllerStatus, Profile, RoastRun } from './types'

// ------------------------------------------------------------------------------- the volume rules

/**
 * The archive prunes its oldest recording as it approaches this. Reserved, not free.
 * `sr800::volume::kLogArchiveReserveBytes`.
 */
export const ARCHIVE_RETENTION_RESERVE_BYTES = 96 * 1024

/**
 * The largest file a single persist can produce, derived exactly as the firmware derives it in
 * `sr800_volume_budget.h` (`kMaxIncomingLogBytes`):
 *
 *     kLogArchiveHeaderBytes 220 + kMaxPlanEnvelopeBytes 1024 +
 *     kMaxRecordingSamples 4800 x kMaxEncodedSampleBytes 25 = 121,244
 *
 * It is the format's declared ceiling, not a measured size - five channels at the five-byte ceiling
 * of an unsigned LEB128 u32, times the RAM log's capacity. A real recording costs about a fifth of
 * it; the reserve exists for the case nobody predicted.
 */
export const MAX_INCOMING_RECORDING_BYTES = 220 + 1024 + 4800 * 25

/**
 * Any document write that would leave the volume with less than this free is refused with `507`.
 *
 * This is the FALLBACK, for a controller too old to send `data_store.write_floor_bytes`. It is
 * derived here the way `sr800::volume::kDocumentWriteFloorBytes` is derived there - the archive's
 * reserve PLUS the worst-case incoming recording, 98,304 + 121,244 = 219,548 - so that the two
 * cannot drift apart and let a metadata write land in the archive's reserve, forcing the very
 * retention sweep the documentation promises it never can. Never 64 KB: that constant
 * predates the derivation, and using it overstates a 896 KB volume by roughly 150 KB.
 */
export const VOLUME_WRITE_FLOOR_BYTES = ARCHIVE_RETENTION_RESERVE_BYTES + MAX_INCOMING_RECORDING_BYTES

/**
 * The floor this controller actually enforces, preferring what it says over what we derived.
 *
 * The firmware emits it precisely so a client does not hardcode it ("the line is not a round number
 * a client should hardcode"), so a reported value always wins - including one that disagrees with
 * the constant, because on that device the reported one is the truth. A non-positive or absent
 * figure falls back to the derivation above.
 */
export const resolveWriteFloorBytes = (
  store: ControllerStatus['dataStore'],
  archive: DeviceArchiveStorage | undefined,
): number => {
  const reported = store?.writeFloorBytes ?? archive?.writeFloorBytes
  return reported !== undefined && Number.isFinite(reported) && reported > 0 ? reported : VOLUME_WRITE_FLOOR_BYTES
}

/** Decimal storage units, including sub-kilobyte values such as 0.4 KB. */
export const formatBytes = (value: number | undefined): string => {
  if (value === undefined || !Number.isFinite(value)) return '--'
  const kilobytes = value / 1_000
  return `${Math.abs(kilobytes) < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/** What a recording occupies on the volume. `bytes` is the file; `payload_bytes` is inside it. */
export const recordingBytes = (entry: DeviceLogEntry) => entry.bytes ?? entry.payloadBytes ?? 0

export interface RecordingPage {
  entries: DeviceLogEntry[]
  pageIndex: number
  pageCount: number
  totalMatches: number
}

/** A bounded, searchable slice of device thermal recordings, newest first. */
export const recordingPage = (
  logs: DeviceLogEntry[],
  query: string,
  requestedPage: number,
  pageSize = 10,
): RecordingPage => {
  const normalized = query.trim().toLocaleLowerCase()
  const matches = [...logs]
    .filter(
      (entry) =>
        normalized.length === 0 ||
        [entry.id, entry.name, entry.mode, entry.startedAt].some((value) =>
          value?.toLocaleLowerCase().includes(normalized),
        ),
    )
    .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0) || b.id.localeCompare(a.id))
  const safePageSize = Math.max(1, Math.floor(pageSize))
  const pageCount = Math.max(1, Math.ceil(matches.length / safePageSize))
  const pageIndex = Math.max(0, Math.min(Math.floor(requestedPage), pageCount - 1))
  return {
    entries: matches.slice(pageIndex * safePageSize, (pageIndex + 1) * safePageSize),
    pageIndex,
    pageCount,
    totalMatches: matches.length,
  }
}

/**
 * VOLUME USAGE HAS EXACTLY ONE SOURCE, AND IT IS `log_archive.used_bytes`.
 *
 * The name lies about the scope. The firmware fills that field with `LittleFS.usedBytes()` - the
 * WHOLE volume, `/data` and `/logs` and every stray on it together - even though it is emitted
 * inside the archive's own block. `data_store.used_bytes` is the `/data` subtree alone, and
 * `data_store.free_bytes` is `LittleFS.totalBytes() - LittleFS.usedBytes()`, which is that same
 * volume-wide figure said the other way round.
 *
 * So the two must never be ADDED. Doing so counts `/data` twice, overstates the volume by the size
 * of the library, and fires the pre-roast pruning warning while there is still room - a warning that
 * offers to destroy a recording for space that was never missing. A mock that reported the
 * recordings-only reading would make that arithmetic look right, so the mock reports the whole volume.
 *
 * The fallbacks are for a device that is not sending the archive block at all: `total - free` from
 * the store says the same thing, and only when neither exists is the volume reconstructed from its
 * two known tenants - which is the one place the sum is legitimate, because it is a floor rather
 * than a reading.
 */
export const volumeUsedBytes = (
  archive: DeviceArchiveStorage | undefined,
  store: ControllerStatus['dataStore'],
  logs: DeviceLogEntry[],
): number => {
  if (archive?.usedBytes !== undefined) return Math.max(0, archive.usedBytes)
  if (store?.totalBytes !== undefined && store.freeBytes !== undefined) {
    return Math.max(0, store.totalBytes - store.freeBytes)
  }
  return (store?.usedBytes ?? 0) + sum(logs.map(recordingBytes))
}

// ------------------------------------------------------------------------------------ the report

export interface StorageGrouping {
  id: string
  name: string
  runs: number
  bytes: number
  /** ISO, oldest and newest of the group. Absent when nothing in it carries a date. */
  oldest?: string
  newest?: string
}

export interface StorageReport {
  /** False when the controller has no document store at all, in which case every figure is absent. */
  present: boolean
  mounted: boolean
  volume: {
    totalBytes: number
    usedBytes: number
    dataBytes: number
    recordingBytes: number
    /** Whatever the volume holds that is neither `/data` nor `/logs`. Never negative. */
    otherBytes: number
    freeBytes: number
    /** The 507 line, as this controller reports it. Contains both figures below - never their sum. */
    writeFloorBytes: number
    /** The half of the floor that is the archive's working reserve: somebody's oldest roast. */
    retentionReserveBytes: number
    /** The other half: the worst-case recording the next roast may need to land. */
    nextRecordingBytes: number
    /** Free space a new roast can actually use without a refusal or a prune. Never negative. */
    usableFreeBytes: number
  }
  recordings: {
    count: number
    bytes: number
    largest?: DeviceLogEntry
    oldest?: DeviceLogEntry
    /** Recordings the library has already taken in, so deleting them costs nothing. */
    importedCount: number
    importedBytes: number
    lostLogs: number
    needsFormat: boolean
  }
  roasts: {
    count: number
    bytes: number
    byProfile: StorageGrouping[]
    byBean: StorageGrouping[]
  }
  collections: Array<{ name: string; bytes: number; version?: number }>
  calibration: {
    bytes: number
    passes: number
    /** Samples embedded in the stored passes, which is what makes that document the big one. */
    samples: number
    snapshots: number
  }
  capacity: {
    averageRecordingBytes: number
    averageRunDocumentBytes: number
    perRoastBytes: number
    /** Room for roughly this many more recorded roasts, at this roaster's own average size. */
    moreRoasts?: number
  }
}

export interface StorageReportInput {
  dataStore: ControllerStatus['dataStore']
  archive?: DeviceArchiveStorage
  logs: DeviceLogEntry[]
  importedLogIds: Set<string>
  runs: RoastRun[]
  profiles: Profile[]
  beans: BeanLot[]
  /** Payload length per run document, from the run index the store serves. */
  runBytes: Record<string, number>
  calibrationPasses: Array<{ samples: unknown[] }>
  snapshots: unknown[]
}

const COLLECTION_ORDER = ['profiles', 'beans', 'calibrations', 'meta'] as const

const dateRange = (values: Array<string | undefined>) => {
  const dates = values.filter((value): value is string => typeof value === 'string' && value.length > 0).sort()
  return { oldest: dates[0], newest: dates[dates.length - 1] }
}

/**
 * Group the run documents by the profile and by the bean lot they were roasted with.
 *
 * The grouping key is the run's OWN embedded snapshot, not a lookup into the current library: that
 * is what makes a group appear for a profile that has already been deleted, which is precisely the
 * group a user needs to see. A name is taken from the live library when it is still there, and
 * from the snapshot when it is not.
 */
const group = (
  runs: RoastRun[],
  runBytes: Record<string, number>,
  keyOf: (run: RoastRun) => string | undefined,
  nameOf: (run: RoastRun) => string,
  known: Map<string, string>,
): StorageGrouping[] => {
  const groups = new Map<string, { name: string; runs: RoastRun[] }>()
  for (const run of runs) {
    const key = keyOf(run)
    if (key === undefined) continue
    const existing = groups.get(key)
    if (existing) existing.runs.push(run)
    else groups.set(key, { name: known.get(key) ?? nameOf(run), runs: [run] })
  }
  return [...groups.entries()]
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      runs: entry.runs.length,
      bytes: sum(entry.runs.map((run) => runBytes[run.id] ?? 0)),
      ...dateRange(entry.runs.map((run) => run.startedAt)),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
}

/**
 * Everything the Storage panel shows, computed once from the device's own numbers.
 *
 * Every figure is defensive about absence rather than defaulting to zero where zero would be a lie:
 * a controller mid-upgrade, a volume that did not mount, and a firmware without the store are three
 * different things, and only the first two have numbers at all.
 */
export const storageReport = (input: StorageReportInput): StorageReport => {
  const store = input.dataStore
  const archive = input.archive
  /*
   * Three figures, three sources, no addition between them:
   *   - the VOLUME's usage is `volumeUsedBytes` (see there - it is `LittleFS.usedBytes()`);
   *   - RECORDINGS are the sum of the per-log `bytes` from `/api/logs`;
   *   - DOCUMENTS are `data_store.used_bytes`, the `/data` subtree.
   * The first is the whole, the other two are tenants inside it, and whatever the whole holds that
   * is neither of them is `otherBytes` rather than a discrepancy nobody sees.
   */
  const recordingsBytes = sum(input.logs.map(recordingBytes))
  const dataBytes = store?.usedBytes ?? 0
  const totalBytes = store?.totalBytes ?? archive?.totalBytes ?? 0
  const usedBytes = volumeUsedBytes(archive, store, input.logs)
  const freeBytes = store?.freeBytes ?? Math.max(0, totalBytes - usedBytes)
  /*
   * ONE floor, subtracted ONCE, and it is the device's own if the device sent one. The retention
   * reserve is a part of it, so it is split for display below rather than taken out again: the
   * volume withholds 219,548 bytes in total, not that floor plus another 96 KiB.
   */
  const writeFloorBytes = resolveWriteFloorBytes(store, archive)
  const retentionReserveBytes = Math.min(ARCHIVE_RETENTION_RESERVE_BYTES, writeFloorBytes)
  const usableFreeBytes = Math.max(0, totalBytes - usedBytes - writeFloorBytes)

  const imported = input.logs.filter((entry) => input.importedLogIds.has(recordingKey(entry.recordingOrigin)))
  const byBytes = [...input.logs].sort((a, b) => recordingBytes(b) - recordingBytes(a))
  // Ids are monotonic across boots, so the smallest id IS the oldest and it needs no clock at all.
  const byAge = [...input.logs].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0) || a.id.localeCompare(b.id))

  const profileNames = new Map(input.profiles.map((profile) => [profile.id, profile.name]))
  const beanNames = new Map(input.beans.map((bean) => [bean.id, bean.name]))

  const collections = COLLECTION_ORDER.flatMap((name) => {
    const entry = store?.collections?.[name]
    return entry === undefined ? [] : [{ name, bytes: entry.bytes ?? 0, version: entry.version }]
  })

  /*
   * The capacity translation, from measurement rather than from constants. A
   * roast costs one recording plus one run document, and both averages come off this volume: a
   * roaster that only ever runs eight-minute test batches gets a bigger answer than one that does
   * not, because on that roaster it is true.
   */
  const averageRecordingBytes = input.logs.length > 0 ? recordingsBytes / input.logs.length : 0
  const runDocBytes = Object.values(input.runBytes)
  const averageRunDocumentBytes = runDocBytes.length > 0 ? sum(runDocBytes) / runDocBytes.length : 0
  const perRoastBytes = averageRecordingBytes + averageRunDocumentBytes

  return {
    present: store !== undefined,
    mounted: store?.mounted === true,
    volume: {
      totalBytes,
      usedBytes,
      dataBytes,
      recordingBytes: recordingsBytes,
      otherBytes: Math.max(0, usedBytes - dataBytes - recordingsBytes),
      freeBytes,
      writeFloorBytes,
      retentionReserveBytes,
      nextRecordingBytes: writeFloorBytes - retentionReserveBytes,
      usableFreeBytes,
    },
    recordings: {
      count: archive?.count ?? input.logs.length,
      bytes: recordingsBytes,
      largest: byBytes[0],
      oldest: byAge[0],
      importedCount: imported.length,
      importedBytes: sum(imported.map(recordingBytes)),
      lostLogs: archive?.lostLogs ?? 0,
      needsFormat: archive?.needsFormat === true,
    },
    roasts: {
      count: store?.runs?.count ?? input.runs.length,
      bytes: store?.runs?.bytes ?? sum(Object.values(input.runBytes)),
      byProfile: group(
        input.runs,
        input.runBytes,
        (run) => run.profile?.id,
        (run) => run.profile?.name ?? 'Deleted profile',
        profileNames,
      ),
      byBean: group(
        input.runs,
        input.runBytes,
        (run) => run.beanLotId,
        (run) => run.beanLotSnapshot?.name ?? 'Deleted bean lot',
        beanNames,
      ),
    },
    collections,
    calibration: {
      bytes: store?.collections?.calibrations?.bytes ?? 0,
      passes: input.calibrationPasses.length,
      samples: sum(input.calibrationPasses.map((pass) => pass.samples.length)),
      snapshots: input.snapshots.length,
    },
    capacity: {
      averageRecordingBytes,
      averageRunDocumentBytes,
      perRoastBytes,
      moreRoasts: perRoastBytes > 0 ? Math.floor(usableFreeBytes / perRoastBytes) : undefined,
    },
  }
}

// ------------------------------------------------------------------------------- the cascade plan

export type CascadeSubject = 'profile' | 'bean'

export interface CascadePlan {
  subject: CascadeSubject
  id: string
  name: string
  /** Run documents that would be deleted, newest first. */
  runIds: string[]
  runNames: string[]
  runBytes: number
  /** Recordings that would be deleted - only ids the controller is actually still holding. */
  recordingIds: string[]
  /** Immutable recording-origin keys committed before deletion so a failed device delete cannot resurrect a run. */
  recordingLedgerKeys: string[]
  recordingBytes: number
  totalBytes: number
  oldest?: string
  newest?: string
}

export interface CascadePlanInput {
  subject: CascadeSubject
  id: string
  name: string
  runs: RoastRun[]
  runBytes: Record<string, number>
  /** Recording ids the device currently holds. A recording already pruned is not "deleted" again. */
  deviceLogIds: Set<string>
}

/**
 * Exactly what dies, named before anything is asked.
 *
 * A recording is included only when the controller still HAS it: an imported roast whose recording
 * was pruned months ago must not appear in a list of things about to be destroyed, and a delete
 * issued for it would answer 404 and read as a failure.
 */
export const cascadePlan = ({ subject, id, name, runs, runBytes, deviceLogIds }: CascadePlanInput): CascadePlan => {
  const linked = runs
    .filter((run) => (subject === 'profile' ? run.profile?.id : run.beanLotId) === id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const recordingIds = linked.flatMap((run) => {
    const logId = run.deviceRoast?.storageAddress.logId
    return logId !== undefined && deviceLogIds.has(logId) ? [logId] : []
  })
  const recordingLedgerKeys = linked.flatMap((run) => {
    const source = run.deviceRoast
    return source !== undefined && deviceLogIds.has(source.storageAddress.logId)
      ? [recordingKey(source.recordingOrigin)]
      : []
  })
  const runTotal = sum(linked.map((run) => runBytes[run.id] ?? 0))
  return {
    subject,
    id,
    name,
    runIds: linked.map((run) => run.id),
    runNames: linked.map((run) => run.name),
    runBytes: runTotal,
    recordingIds,
    recordingLedgerKeys,
    // A recording's own size is known only from the archive listing; the caller supplies it through
    // `withRecordingBytes` when it has the listing, so the plan itself stays a pure join.
    recordingBytes: 0,
    totalBytes: runTotal,
    ...dateRange(linked.map((run) => run.startedAt)),
  }
}

/** Fill in what the recordings actually weigh, once the archive listing is in hand. */
export const withRecordingBytes = (plan: CascadePlan, logs: DeviceLogEntry[]): CascadePlan => {
  const sizes = new Map(logs.map((entry) => [entry.id, recordingBytes(entry)]))
  const recorded = sum(plan.recordingIds.map((logId) => sizes.get(logId) ?? 0))
  return { ...plan, recordingBytes: recorded, totalBytes: plan.runBytes + recorded }
}

/**
 * Whether a cascade may be attempted at all.
 *
 * Deleting is a flash write and the firmware defers those while the actuator runs, so an offline or
 * busy controller means "not now" rather than "no" - but a cascade is emphatically NOT queued the
 * way an edit is. A queued cascade would delete a dozen roasts at some unannounced later moment,
 * possibly after the user had changed their mind, and there is no undo behind it.
 */
export const cascadeBlockedReason = (input: {
  mode: 'browser' | 'device'
  offline: boolean
  connected: boolean
  lifecycle: ControllerStatus['lifecycle']
}): string | undefined => {
  if (input.mode !== 'device') return 'This roaster keeps no library of its own, so there is nothing on it to delete.'
  if (!input.connected || input.offline)
    return 'The roaster is not answering. Deleting roasts from it needs it reachable, and this is never queued - try again when it is back.'
  if (input.lifecycle === 'RUNNING') {
    return 'The roaster is running, and it defers writes to its own storage until actuation finishes, so this has to wait until it is idle.'
  }
  return undefined
}

// -------------------------------------------------------------------------- the retention warning

export interface RetentionPrune {
  id: string
  startedAt?: string
  bytes: number
  imported: boolean
}

export interface RetentionWarning {
  /** True when finishing this roast would push the archive past its reserve and prune something. */
  willPrune: boolean
  /** Recordings that would go, oldest first. */
  pruned: RetentionPrune[]
  /** How big this roast's recording is expected to be, from this roaster's own average. */
  estimatedBytes: number
  headroomBytes: number
}

export interface RetentionWarningInput {
  archive?: DeviceArchiveStorage
  dataStore: ControllerStatus['dataStore']
  logs: DeviceLogEntry[]
  importedLogIds: Set<string>
  /** Measured from the volume. Falls back to the largest recording present when there are none. */
  averageRecordingBytes: number
  /** True selects 1 s detail; false still stores the authoritative 10 s compact archive. */
  record: boolean
}

/**
 * What starting this roast would cost the archive, BEFORE it is started.
 *
 * Requirement: if starting a roast will cause an older recording to be deleted, the user is told
 * before starting it. So this reproduces the firmware's own retention rule - oldest out
 * first, as the archive approaches its working reserve - against the device's real free space and
 * this roaster's own average recording size, and names the recordings that would go.
 *
 * It is informational. It never blocks: a roast the user wants is worth more than a recording they
 * already imported, and only they can weigh that. What it must never do is let the trade happen
 * silently, which is why an unimported recording says so in as many words.
 *
 * The headroom is measured against VOLUME-WIDE usage, once - the firmware's retention target is
 * volume-wide free space, so a growing document store does bring the sweep forward, but it does so
 * because `/data` is already inside `LittleFS.usedBytes()`, not because it is added to it. Adding
 * `data_store.used_bytes` on top charged the library twice and predicted a prune that the firmware
 * would not perform, which is the worst possible direction for this particular warning to be wrong
 * in: it offers to trade away a recording for space that was never missing.
 */
export const retentionWarning = (input: RetentionWarningInput): RetentionWarning => {
  const archive = input.archive
  const logs = input.logs
  const measuredDetailed = logs.filter(
    (entry) => entry.mode === 'roast' && (entry.intervalMs ?? 1000) < 10_000 && recordingBytes(entry) > 0,
  )
  const detailedEstimate = Math.round(
    measuredDetailed.length > 0
      ? measuredDetailed.reduce((sum, entry) => sum + recordingBytes(entry), 0) / measuredDetailed.length
      : input.averageRecordingBytes > 0
        ? input.averageRecordingBytes
        : Math.max(0, ...logs.map(recordingBytes)),
  )
  const measuredCompact = logs.filter(
    (entry) => entry.mode === 'roast' && (entry.intervalMs ?? 0) >= 10_000 && recordingBytes(entry) > 0,
  )
  // Compact files still carry the same v3 header and up-to-1 KB plan envelope.
  // With no measured compact occurrence, one quarter of a detailed file plus a
  // 4 KB floor intentionally overestimates the expected 10x sample reduction.
  const compactEstimate =
    measuredCompact.length > 0
      ? Math.ceil(measuredCompact.reduce((sum, entry) => sum + recordingBytes(entry), 0) / measuredCompact.length)
      : Math.max(4096, Math.ceil(detailedEstimate / 4))
  const estimatedBytes = input.record ? detailedEstimate : compactEstimate
  const totalBytes = archive?.totalBytes ?? input.dataStore?.totalBytes ?? 0
  const volumeUsed = volumeUsedBytes(archive, input.dataStore, logs)
  /*
   * The RESERVE, not the write floor, and deliberately so. This reproduces the archive's own sweep
   * condition - `used + incoming + kLogArchiveReserveBytes > total` - which is a different rule from
   * the document store's 507 line even though the floor is built out of it. Using the floor here
   * would predict a prune roughly one recording early: the floor already contains room for the
   * incoming recording that this calculation is adding on top.
   */
  const headroomBytes = Math.max(0, totalBytes - ARCHIVE_RETENTION_RESERVE_BYTES - volumeUsed)

  if (totalBytes === 0) {
    return { willPrune: false, pruned: [], estimatedBytes, headroomBytes }
  }

  // Oldest first out, exactly as the firmware sweeps, and never the last one standing.
  const oldestFirst = [...logs].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0) || a.id.localeCompare(b.id))
  const pruned: RetentionPrune[] = []
  let needed = estimatedBytes - headroomBytes
  for (const entry of oldestFirst) {
    if (needed <= 0 || logs.length - pruned.length <= 1) break
    pruned.push({
      id: entry.id,
      startedAt: entry.startedAt,
      bytes: recordingBytes(entry),
      imported: input.importedLogIds.has(recordingKey(entry.recordingOrigin)),
    })
    needed -= recordingBytes(entry)
  }
  return { willPrune: pruned.length > 0, pruned, estimatedBytes, headroomBytes }
}

/*
 * ---------------------------------------------------------------------------- export everything
 *
 * Whole-library export lives in `data/backupFile.ts`, not here as one JSON object with the
 * recordings pasted in as CSV TEXT, and the reason is the half such a bundle cannot do. A CSV is a
 * rendering of a recording, not the recording - it is decoded, re-rounded and stripped of its
 * header - so a backup made of them could never be restored. The zip
 * carries `/logs/<id>.crk` byte for byte instead, and the documents as the payloads the roaster
 * actually holds, which is what makes the file something a device can be rebuilt FROM rather than
 * something a human can read afterwards.
 */
