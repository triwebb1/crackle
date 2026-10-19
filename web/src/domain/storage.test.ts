import { describe, expect, it } from 'vitest'
import { testDeviceRoastOrigin, testLogProvenance, testRecordedOn } from '../testFixtures/provenance'
import type { DeviceLogEntry } from './deviceLogs'
import { importableDeviceRoasts } from './deviceRoastImport'
import { recordingKey } from './provenance'
import {
  ARCHIVE_RETENTION_RESERVE_BYTES,
  cascadeBlockedReason,
  cascadePlan,
  formatBytes,
  MAX_INCOMING_RECORDING_BYTES,
  recordingPage,
  retentionWarning,
  storageReport,
  VOLUME_WRITE_FLOOR_BYTES,
  withRecordingBytes,
} from './storage'
import type { BeanLot, ControllerStatus, Profile, RoastRun } from './types'

/**
 * ============================================================================================
 * THE STORAGE ARITHMETIC
 * ============================================================================================
 *
 * Every number the Storage panel, the impact panels and the pre-roast warning show comes from here,
 * so this is where they are pinned. The inputs are faked whole - a status block, an archive block, a
 * recordings listing, a run index and a library - because that is exactly what the app is handed and
 * a test that built them from the app's own helpers would be testing the helpers twice.
 *
 * The three claims that matter most, and each has its own case below:
 *
 *   1. **Free space is honest.** The controller's write floor comes OUT of free before anything is
 *      called usable, ONCE - it already contains the archive's 96 KB retention reserve, so taking
 *      that out again (as against a hardcoded 64 KB floor the firmware does not enforce) overstates
 *      what is withheld.
 *      And the figure the floor comes out of is counted ONCE too: `log_archive.used_bytes` is
 *      volume-wide, so the fixtures below are written volume-wide - 20 KB of documents and 300 KB of
 *      recordings make an archive figure of 320 KB, not 620 KB.
 *   2. **A cascade names exactly what dies.** No run belonging to something else, and no recording
 *      the controller no longer holds.
 *   3. **The retention warning splits imported from not.** "An old recording goes" is not a decision
 *      anybody can make; "#3, 3 March, not imported" is.
 */

const key = (logId: string) => recordingKey(testLogProvenance(logId).recordingOrigin)

const MB = 896 * 1024

const log = (id: string, bytes: number, startedAt?: string): DeviceLogEntry => ({
  id,
  mode: 'roast',
  bytes,
  startedAt,
  ...testLogProvenance(id),
})

const dataStore = (
  overrides: Partial<NonNullable<ControllerStatus['dataStore']>> = {},
): ControllerStatus['dataStore'] => ({
  mounted: true,
  usedBytes: 20 * 1024,
  totalBytes: MB,
  freeBytes: MB - 20 * 1024 - 300 * 1024,
  collections: {
    profiles: { bytes: 4096, version: 7 },
    beans: { bytes: 1024, version: 3 },
    calibrations: { bytes: 12 * 1024, version: 2 },
    meta: { bytes: 512, version: 9 },
  },
  runs: { count: 4, bytes: 8192 },
  ...overrides,
})

/**
 * `usedBytes` here is what the firmware puts there: `LittleFS.usedBytes()`, the WHOLE volume. The
 * default is the 20 KB document store plus the 300 KB of recordings in `LOGS`, which is what a
 * device holding both would actually report - and is emphatically not the recordings' own share.
 */
const archive = (overrides: Partial<NonNullable<ControllerStatus['logArchive']>> = {}) => ({
  mounted: true,
  count: 3,
  usedBytes: 320 * 1024,
  totalBytes: MB,
  clockSynced: true,
  ...overrides,
})

const run = (
  id: string,
  profileId: string,
  beanLotId: string | undefined,
  startedAt: string,
  logId?: string,
): RoastRun =>
  ({
    id,
    name: `Roast ${id}`,
    startedAt,
    profile: {
      id: profileId,
      name: `Profile ${profileId}`,
      revision: 1,
      strategy: 'timed',
      createdAt: startedAt,
      updatedAt: startedAt,
      metadata: { intent: '' },
      notes: '',
      points: [],
      coolFan: 9,
      coolDurationSec: 60,
    } as Profile,
    beanLotId,
    notes: '',
    outcome: 'complete',
    samples: [],
    events: [],
    controllerVersion: 'mock',
    recordedOn: testRecordedOn,
    ...(logId === undefined ? {} : { deviceRoast: testDeviceRoastOrigin(logId) }),
  }) as RoastRun

const profile = (id: string, name: string): Profile =>
  ({
    id,
    name,
    revision: 1,
    strategy: 'timed',
    createdAt: '',
    updatedAt: '',
    metadata: { intent: '' },
    notes: '',
    points: [],
    coolFan: 9,
    coolDurationSec: 60,
  }) as Profile

const bean = (id: string, name: string): BeanLot => ({
  id,
  name,
  origins: [],
  cultivars: [],
  notes: '',
  createdAt: '',
  updatedAt: '',
})

const LOGS = [
  log('1', 100 * 1024, '2026-03-03T09:00:00.000Z'),
  log('2', 90 * 1024, '2026-04-01T09:00:00.000Z'),
  log('3', 110 * 1024, '2026-05-02T09:00:00.000Z'),
]

const RUNS = [
  run('run-a', 'profile-1', 'bean-1', '2026-03-03T09:00:00.000Z', '1'),
  run('run-b', 'profile-1', 'bean-1', '2026-04-01T09:00:00.000Z', '2'),
  run('run-c', 'profile-2', 'bean-2', '2026-05-02T09:00:00.000Z', '3'),
  run('run-d', 'profile-2', undefined, '2026-05-09T09:00:00.000Z'),
]

const RUN_BYTES = { 'run-a': 2048, 'run-b': 2048, 'run-c': 3072, 'run-d': 1024 }

const report = (overrides: Partial<Parameters<typeof storageReport>[0]> = {}) =>
  storageReport({
    dataStore: dataStore(),
    archive: archive(),
    logs: LOGS,
    importedLogIds: new Set([key('1'), key('2')]),
    runs: RUNS,
    profiles: [profile('profile-1', 'House espresso'), profile('profile-2', 'Filter journey')],
    beans: [bean('bean-1', 'House Huila'), bean('bean-2', 'Kenya AB')],
    runBytes: RUN_BYTES,
    calibrationPasses: [{ samples: new Array(400) }, { samples: new Array(600) }],
    snapshots: [{}, {}],
    ...overrides,
  })

describe('what the volume actually holds', () => {
  it('reports the volume as used, free and honestly usable', () => {
    const result = report()
    expect(result.present).toBe(true)
    expect(result.volume.totalBytes).toBe(MB)
    expect(result.volume.dataBytes).toBe(20 * 1024)
    // Recordings are the sum of the per-log `bytes` from /api/logs, never the archive block.
    expect(result.volume.recordingBytes).toBe(300 * 1024)
    // The volume figure is the archive block's, taken whole - NOT documents plus recordings.
    expect(result.volume.usedBytes).toBe(320 * 1024)
    expect(result.volume.otherBytes).toBe(0)
    // Free is the device's own figure; usable is free minus the one floor, taken out once.
    expect(result.volume.freeBytes).toBe(MB - 320 * 1024)
    expect(result.volume.usableFreeBytes).toBe(MB - 320 * 1024 - VOLUME_WRITE_FLOOR_BYTES)
  })

  /**
   * ONE FLOOR, AND IT ALREADY CONTAINS THE RESERVE.
   *
   * The firmware derives its 507 line as `kLogArchiveReserveBytes + kMaxIncomingLogBytes` so that an
   * accepted document write can never be the reason a stored recording is pruned. This app carried a
   * 64 KB floor from before that derivation AND subtracted the 96 KB reserve beside it, which is the
   * reserve charged twice against a floor that was already three times too small - 160 KiB withheld
   * where the device withholds 219,548 bytes. The direction of the error is the bad one: it promises
   * capacity that is not there, so a roast is started against space the controller will refuse.
   */
  it('withholds the whole write floor exactly once, reserve included', () => {
    const result = report()
    expect(VOLUME_WRITE_FLOOR_BYTES).toBe(219548)
    expect(VOLUME_WRITE_FLOOR_BYTES).toBe(ARCHIVE_RETENTION_RESERVE_BYTES + MAX_INCOMING_RECORDING_BYTES)
    expect(MAX_INCOMING_RECORDING_BYTES).toBe(220 + 1024 + 4800 * 25)

    // The two halves are reported for the bar, and they are halves of the floor rather than extras.
    expect(result.volume.writeFloorBytes).toBe(VOLUME_WRITE_FLOOR_BYTES)
    expect(result.volume.retentionReserveBytes + result.volume.nextRecordingBytes).toBe(result.volume.writeFloorBytes)
    expect(result.volume.retentionReserveBytes).toBe(ARCHIVE_RETENTION_RESERVE_BYTES)

    // Usable is total minus used minus floor, with nothing subtracted a second time.
    expect(result.volume.usableFreeBytes).toBe(
      result.volume.totalBytes - result.volume.usedBytes - result.volume.writeFloorBytes,
    )
    // The old arithmetic, computed off the same fixture: a 64 KB floor with the reserve charged
    // again beside it withheld 160 KiB where the controller withholds 219,548 bytes, so it claimed 55,708
    // bytes of capacity that the controller would have refused - half a recording on this roaster.
    const old = result.volume.freeBytes - 64 * 1024 - ARCHIVE_RETENTION_RESERVE_BYTES
    expect(old - result.volume.usableFreeBytes).toBe(
      VOLUME_WRITE_FLOOR_BYTES - 64 * 1024 - ARCHIVE_RETENTION_RESERVE_BYTES,
    )
    expect(old - result.volume.usableFreeBytes).toBe(55708)
  })

  /**
   * The device's own figure wins over the constant, which is the entire reason it is emitted: a
   * build that moves its reserve or its sample ceiling moves the line, and a client that hardcoded
   * one would quietly disagree with the controller that is doing the refusing.
   */
  it('prefers the floor the controller reports over the derived fallback', () => {
    const reported = report({ dataStore: dataStore({ writeFloorBytes: 300 * 1024 }) })
    expect(reported.volume.writeFloorBytes).toBe(300 * 1024)
    expect(reported.volume.usableFreeBytes).toBe(MB - 320 * 1024 - 300 * 1024)
    // Retention is still 96 KB of that floor, so the remainder is what a new recording may have.
    expect(reported.volume.nextRecordingBytes).toBe(300 * 1024 - ARCHIVE_RETENTION_RESERVE_BYTES)

    // A firmware too old to send the field falls back to the DERIVATION, never to the old 64 KB.
    const legacy = report()
    expect(dataStore()?.writeFloorBytes).toBeUndefined()
    expect(legacy.volume.writeFloorBytes).toBe(VOLUME_WRITE_FLOOR_BYTES)
    expect(legacy.volume.writeFloorBytes).not.toBe(64 * 1024)

    // A floor smaller than the reserve cannot make the two halves negative; it is all reserve.
    const tiny = report({ dataStore: dataStore({ writeFloorBytes: 8 * 1024 }) })
    expect(tiny.volume.retentionReserveBytes).toBe(8 * 1024)
    expect(tiny.volume.nextRecordingBytes).toBe(0)
  })

  /**
   * The regression itself, stated as arithmetic.
   *
   * `log_archive.used_bytes` is `LittleFS.usedBytes()` and `data_store.used_bytes` is the `/data`
   * subtree INSIDE it. Adding them charged the library twice: on this fixture that is 20 KB of
   * phantom usage, which is 20 KB of free space a roast is told it does not have.
   */
  it('counts the document store once, inside the volume figure rather than on top of it', () => {
    const result = report()
    expect(result.volume.usedBytes).toBe(archive().usedBytes)
    expect(result.volume.usedBytes).not.toBe(archive().usedBytes + 20 * 1024)
    // The parts add back up to the whole, which is what lets the panel's bar segments sum.
    expect(result.volume.dataBytes + result.volume.recordingBytes + result.volume.otherBytes).toBe(
      result.volume.usedBytes,
    )
    expect(result.volume.usedBytes + result.volume.freeBytes).toBe(MB)
  })

  /** LittleFS accounts in blocks and holds an unsaved log, so the volume may exceed its two tenants. */
  it('names whatever the volume holds beyond documents and recordings rather than losing it', () => {
    const result = report({
      archive: archive({ usedBytes: 340 * 1024 }),
      dataStore: dataStore({ freeBytes: MB - 340 * 1024 }),
    })
    expect(result.volume.otherBytes).toBe(20 * 1024)
    expect(result.volume.dataBytes + result.volume.recordingBytes + result.volume.otherBytes).toBe(
      result.volume.usedBytes,
    )
  })

  /** A device that sends no archive block at all still has a volume, said the other way round. */
  it('reads volume usage from the store when the archive block is absent', () => {
    const result = report({ archive: undefined, dataStore: dataStore({ freeBytes: MB - 320 * 1024 }) })
    expect(result.volume.usedBytes).toBe(320 * 1024)
    // And with neither figure, the two known tenants are a floor rather than a reading.
    const bare = report({ archive: undefined, dataStore: dataStore({ freeBytes: undefined, totalBytes: undefined }) })
    expect(bare.volume.usedBytes).toBe(320 * 1024)
  })

  it('never reports negative usable space on a volume already inside its floor', () => {
    const result = report({
      archive: archive({ usedBytes: MB - 1024 }),
      dataStore: dataStore({ freeBytes: 1024 }),
    })
    expect(result.volume.usableFreeBytes).toBe(0)
  })

  /** The capacity translation is measured, never a constant: it is this roaster's own averages. */
  it('estimates room for more roasts from the sizes actually on the volume', () => {
    const result = report()
    expect(Math.round(result.capacity.averageRecordingBytes)).toBe(Math.round(((100 + 90 + 110) * 1024) / 3))
    expect(result.capacity.averageRunDocumentBytes).toBe((2048 + 2048 + 3072 + 1024) / 4)
    expect(result.capacity.moreRoasts).toBe(Math.floor(result.volume.usableFreeBytes / result.capacity.perRoastBytes))
  })

  it('offers no estimate at all when nothing has ever been recorded', () => {
    const result = report({ logs: [], runBytes: {}, archive: archive({ count: 0, usedBytes: 0 }) })
    expect(result.capacity.moreRoasts).toBeUndefined()
  })

  it('reads as absent, not as empty, on a roaster that keeps no library', () => {
    const result = report({ dataStore: undefined })
    expect(result.present).toBe(false)
  })
})

describe('what is consuming the space', () => {
  it('names the largest and oldest recordings and counts the prunable ones', () => {
    const result = report()
    expect(result.recordings.largest?.id).toBe('3')
    // Ids are monotonic across boots, so the smallest id is the oldest with no clock involved.
    expect(result.recordings.oldest?.id).toBe('1')
    expect(result.recordings.importedCount).toBe(2)
    expect(result.recordings.importedBytes).toBe(190 * 1024)
  })

  it('surfaces lost recordings plainly rather than folding them into a total', () => {
    expect(report({ archive: archive({ lostLogs: 2 }) }).recordings.lostLogs).toBe(2)
    expect(report().recordings.lostLogs).toBe(0)
  })

  it('groups roast records by profile and by bean lot, with sizes and date ranges', () => {
    const byProfile = report().roasts.byProfile
    const house = byProfile.find((entry) => entry.id === 'profile-1')
    expect(house).toMatchObject({ name: 'House espresso', runs: 2, bytes: 4096 })
    expect(house?.oldest).toBe('2026-03-03T09:00:00.000Z')
    expect(house?.newest).toBe('2026-04-01T09:00:00.000Z')
    // A run with no bean lot is in no bean group at all, rather than in an "unknown" one.
    expect(report().roasts.byBean.reduce((total, entry) => total + entry.runs, 0)).toBe(3)
  })

  /** The group a user most needs to see is the one whose profile has already been deleted. */
  it('still groups roasts whose profile is no longer in the library, using their own snapshot', () => {
    const result = report({ profiles: [profile('profile-1', 'House espresso')] })
    expect(result.roasts.byProfile.find((entry) => entry.id === 'profile-2')?.name).toBe('Profile profile-2')
  })

  it('reports the calibrations document with the pass samples embedded in it', () => {
    const result = report()
    expect(result.calibration.bytes).toBe(12 * 1024)
    expect(result.calibration.passes).toBe(2)
    expect(result.calibration.samples).toBe(1000)
  })
})

describe('the cascade plan', () => {
  const plan = (subject: 'profile' | 'bean', id: string, name: string, deviceLogIds = new Set(['1', '2', '3'])) =>
    withRecordingBytes(cascadePlan({ subject, id, name, runs: RUNS, runBytes: RUN_BYTES, deviceLogIds }), LOGS)

  it('names exactly the run documents and recordings a profile would take with it', () => {
    const result = plan('profile', 'profile-1', 'House espresso')
    expect(result.runIds).toEqual(['run-b', 'run-a'])
    expect(result.recordingIds).toEqual(['2', '1'])
    expect(result.recordingLedgerKeys).toEqual([key('2'), key('1')])
    expect(result.runBytes).toBe(4096)
    expect(result.recordingBytes).toBe(190 * 1024)
    expect(result.totalBytes).toBe(4096 + 190 * 1024)
    expect(result.oldest).toBe('2026-03-03T09:00:00.000Z')
    expect(result.newest).toBe('2026-04-01T09:00:00.000Z')
  })

  it('joins on the bean lot when that is what is being deleted', () => {
    expect(plan('bean', 'bean-2', 'Kenya AB').runIds).toEqual(['run-c'])
  })

  /** A recording the device pruned months ago is not "deleted" again: that delete would 404. */
  it('leaves out recordings the controller no longer holds', () => {
    const result = plan('profile', 'profile-1', 'House espresso', new Set(['2']))
    expect(result.recordingIds).toEqual(['2'])
    expect(result.recordingBytes).toBe(90 * 1024)
  })

  it('prevents a failed device delete from resurrecting a deleted roast', () => {
    const result = plan('profile', 'profile-1', 'House espresso', new Set(['1']))
    expect(result.recordingIds).toEqual(['1'])
    expect(result.recordingLedgerKeys).toEqual([key('1')])
    // The run document is gone but the recording delete failed, so the next reconciliation still
    // sees the bytes. Its immutable origin was committed before deletion and keeps it suppressed.
    expect(importableDeviceRoasts([LOGS[0]], result.recordingLedgerKeys)).toEqual([])
  })

  it('is empty, and weighs nothing, for something nothing was ever roasted from', () => {
    const result = plan('profile', 'profile-9', 'Never used')
    expect(result.runIds).toEqual([])
    expect(result.totalBytes).toBe(0)
    expect(result.oldest).toBeUndefined()
  })

  /** A cascade is never queued, so every reason it cannot run now is a refusal with a sentence. */
  it('refuses while the controller is unreachable, busy, or absent', () => {
    const base = { mode: 'device' as const, offline: false, connected: true, lifecycle: 'READY' as const }
    expect(cascadeBlockedReason(base)).toBeUndefined()
    expect(cascadeBlockedReason({ ...base, offline: true })).toContain('never queued')
    expect(cascadeBlockedReason({ ...base, connected: false })).toContain('not answering')
    expect(cascadeBlockedReason({ ...base, lifecycle: 'RUNNING' })).toContain('idle')
    expect(cascadeBlockedReason({ ...base, mode: 'browser' })).toContain('keeps no library of its own')
  })
})

describe('the pre-roast retention warning', () => {
  const warn = (overrides: Partial<Parameters<typeof retentionWarning>[0]> = {}) =>
    retentionWarning({
      archive: archive({ usedBytes: MB - ARCHIVE_RETENTION_RESERVE_BYTES - 20 * 1024 }),
      dataStore: dataStore({ usedBytes: 0 }),
      logs: LOGS,
      importedLogIds: new Set([key('1')]),
      averageRecordingBytes: 100 * 1024,
      record: true,
      ...overrides,
    })

  it('says nothing while the archive has room for this roast', () => {
    const result = warn({ archive: archive({ usedBytes: 10 * 1024 }) })
    expect(result.willPrune).toBe(false)
    expect(result.pruned).toEqual([])
  })

  it('names the oldest recordings that would go, and whether each was imported', () => {
    const result = warn()
    expect(result.willPrune).toBe(true)
    expect(result.pruned.map((entry) => entry.id)).toEqual(['1'])
    expect(result.pruned[0]).toMatchObject({ imported: true, bytes: 100 * 1024, startedAt: '2026-03-03T09:00:00.000Z' })
  })

  /** The distinction that matters: a copy that exists here, or one that does not. */
  it('marks a recording this library never imported as one that would be lost permanently', () => {
    const result = warn({ importedLogIds: new Set<string>(), averageRecordingBytes: 190 * 1024 })
    expect(result.pruned.map((entry) => [entry.id, entry.imported])).toEqual([['1', false]])
  })

  /**
   * The document store shares the volume, so a growing library DOES bring the sweep forward - and it
   * does so through the volume figure it is already part of, not through a second subtraction.
   *
   * The premature-warning bug lived here: `/data` was charged once inside `log_archive.used_bytes`
   * and again as `data_store.used_bytes`, so a library of 120 KB moved the predicted prune forward
   * by 120 KB of space that was never spent, and offered to destroy a recording to recover it.
   */
  it('counts the document store once, through the volume figure it is already inside', () => {
    const roomy = warn({ archive: archive({ usedBytes: MB - ARCHIVE_RETENTION_RESERVE_BYTES - 150 * 1024 }) })
    const crowded = warn({ archive: archive({ usedBytes: MB - ARCHIVE_RETENTION_RESERVE_BYTES - 30 * 1024 }) })
    expect(roomy.headroomBytes).toBe(150 * 1024)
    expect(roomy.willPrune).toBe(false)
    expect(crowded.willPrune).toBe(true)

    // The library growing by 120 KB with the volume figure unchanged is not a fact about the volume.
    const withLibrary = warn({
      archive: archive({ usedBytes: MB - ARCHIVE_RETENTION_RESERVE_BYTES - 150 * 1024 }),
      dataStore: dataStore({ usedBytes: 120 * 1024 }),
    })
    expect(withLibrary.headroomBytes).toBe(roomy.headroomBytes)
    expect(withLibrary.willPrune).toBe(false)
  })

  it('estimates record=0 as a compact archive and still warns when it would prune', () => {
    const result = warn({ record: false })
    expect(result.estimatedBytes).toBe(25 * 1024)
    expect(result.willPrune).toBe(true)
    expect(result.pruned.map((entry) => entry.id)).toEqual(['1'])
    expect(result).not.toHaveProperty('recordingDisabled')
  })

  it('uses detailed roast files rather than mixing compact and non-roast logs into the detailed estimate', () => {
    const detailed = { ...LOGS[0], id: '7', bytes: 80 * 1024, intervalMs: 1000 }
    const compact = { ...LOGS[0], id: '8', bytes: 8 * 1024, intervalMs: 10_000 }
    const calibration = { ...LOGS[0], id: '9', mode: 'calibration' as const, bytes: 240 * 1024, intervalMs: 1000 }
    const result = warn({ record: true, logs: [detailed, compact, calibration], averageRecordingBytes: 109 * 1024 })
    expect(result.estimatedBytes).toBe(80 * 1024)
  })

  it('prefers measured 10-second roast files over the conservative derived estimate', () => {
    const compact = { ...LOGS[0], id: '9', bytes: 7 * 1024, intervalMs: 10_000 }
    const result = warn({ record: false, logs: [...LOGS, compact] })
    expect(result.estimatedBytes).toBe(7 * 1024)
  })

  /** The firmware never prunes the last recording standing, so neither does the prediction. */
  it('never predicts pruning the only recording there is', () => {
    const result = warn({ logs: [LOGS[0]], averageRecordingBytes: 500 * 1024 })
    expect(result.pruned).toEqual([])
  })

  /**
   * THE WARNING MEASURES AGAINST THE RESERVE, NOT AGAINST THE WRITE FLOOR - and that is not an
   * oversight left over from the floor correction, it is the firmware's two rules being two rules.
   *
   * The archive sweeps when `used + incoming + reserve > total`. The document store refuses at
   * `total - used < floor`, and the floor is the reserve PLUS room for one worst-case recording,
   * precisely so an accepted document write can never trigger that sweep. Predicting the sweep
   * against the floor would double-count the incoming recording - once inside the floor, once as
   * `estimatedBytes` - and bring the warning forward by a whole recording, offering to destroy a
   * roast for space that is not missing. That is the same shape of bug the volume figure had.
   */
  it('predicts the sweep against the archive reserve, not against the document write floor', () => {
    // Exactly 150 KB of headroom by the reserve rule, and a 100 KB recording fits inside it.
    const result = warn({ archive: archive({ usedBytes: MB - ARCHIVE_RETENTION_RESERVE_BYTES - 150 * 1024 }) })
    expect(result.headroomBytes).toBe(150 * 1024)
    expect(result.willPrune).toBe(false)
    // Against the write floor the same volume would have shown 150 KB - (213 - 96) KB of headroom
    // and predicted a prune, which the firmware would not have performed.
    expect(150 * 1024 - (VOLUME_WRITE_FLOOR_BYTES - ARCHIVE_RETENTION_RESERVE_BYTES)).toBeLessThan(
      result.estimatedBytes,
    )
  })
})

describe('decimal storage formatting', () => {
  it('uses decimal KB even below one kilobyte', () => {
    expect(formatBytes(undefined)).toBe('--')
    expect(formatBytes(400)).toBe('0.4 KB')
    expect(formatBytes(512)).toBe('0.5 KB')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(896 * 1024)).toBe('918 KB')
    expect(formatBytes(1536 * 1024)).toBe('1573 KB')
  })
})

describe('thermal recording pages', () => {
  const logs = Array.from(
    { length: 55 },
    (_, index): DeviceLogEntry => ({
      id: String(index + 1),
      name: index === 17 ? 'First crack check' : `Roast ${index + 1}`,
      mode: index % 2 === 0 ? 'roast' : 'manual',
      bytes: 400,
      ...testLogProvenance(String(index + 1)),
    }),
  )

  it('bounds each page and sorts newest first', () => {
    const page = recordingPage(logs, '', 0, 10)
    expect(page.entries).toHaveLength(10)
    expect(page.entries.map((entry) => entry.id)).toEqual(['55', '54', '53', '52', '51', '50', '49', '48', '47', '46'])
    expect(page.pageCount).toBe(6)
  })

  it('searches useful recording fields and clamps stale page numbers', () => {
    const page = recordingPage(logs, 'first crack', 99, 10)
    expect(page.entries.map((entry) => entry.id)).toEqual(['18'])
    expect(page.pageIndex).toBe(0)
    expect(page.totalMatches).toBe(1)
  })
})
