/**
 * The device-backed data layer, against a faked controller.
 *
 * The fake is a whole `DeviceStoreClient` rather than a stubbed `fetch`, and that is the point: the
 * behaviours worth pinning here - device wins on boot, a conflict is REBASED rather than lost, a
 * busy roaster queues rather than fails, an unreachable controller still renders - are decisions the
 * data layer makes about outcomes, not about HTTP. The HTTP mapping itself is `client.ts`, and the
 * firmware's own answers are pinned against the mock in `dev/dataStore.test.ts`.
 */
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { recordingKey } from '../domain/provenance'
import { parseThermalCsv } from '../domain/thermalLog'
import type {
  BeanLot,
  BeanRevision,
  CalibrationRun,
  CalibrationSnapshot,
  ControllerStatus,
  ManualEvent,
  Profile,
  ProfileRevision,
  RoastRun,
} from '../domain/types'
import type {
  CrackleData,
  DeviceStoreClient,
  DocumentRead,
  DocumentWrite,
  ManifestRead,
  RestoreMaintenanceResult,
  RunIndexRead,
} from './deviceStore'
import { byteLength, type DocumentTarget } from './documentSerializer'

const memoryStorage = () => {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

/**
 * A controller that holds documents.
 *
 * `busy` is the idle gate, `offline` is an unreachable roaster, and `rival` is the other browser:
 * it commits its own edit the instant the next write for that document arrives, which is exactly
 * the race the version check exists to catch.
 */
class FakeController implements DeviceStoreClient {
  documents = new Map<string, { version: number; payload: string }>()
  busy = false
  offline = false
  reads: string[] = []
  writes: Array<{ target: string; base: number }> = []
  rival?: { target: DocumentTarget; payload: string }

  seed(target: DocumentTarget, payload: string, version = 1) {
    this.documents.set(target, { version, payload })
  }

  async readDocument(target: DocumentTarget): Promise<DocumentRead> {
    if (this.offline) return { kind: 'unreachable' }
    this.reads.push(target)
    const stored = this.documents.get(target)
    return stored ? { kind: 'ok', payload: stored.payload, version: stored.version } : { kind: 'missing' }
  }

  async writeDocument(target: DocumentTarget, payload: string, base: number): Promise<DocumentWrite> {
    if (this.offline) return { kind: 'unreachable' }
    if (this.busy) return { kind: 'busy' }
    this.writes.push({ target, base })
    if (this.rival?.target === target) {
      const rival = this.rival
      this.rival = undefined
      const version = (this.documents.get(target)?.version ?? 0) + 1
      this.documents.set(target, { version, payload: rival.payload })
      return { kind: 'conflict', version }
    }
    const current = this.documents.get(target)?.version ?? 0
    if (base !== current) return { kind: 'conflict', version: current }
    this.documents.set(target, { version: current + 1, payload })
    return { kind: 'ok', version: current + 1 }
  }

  async listRunDocuments(): Promise<RunIndexRead> {
    if (this.offline) return { kind: 'unreachable' }
    const runs = [...this.documents.entries()].flatMap(([key, stored]) =>
      key.startsWith('runs/')
        ? [{ id: key.slice('runs/'.length), bytes: byteLength(stored.payload), version: stored.version }]
        : [],
    )
    return {
      kind: 'ok',
      runs,
      total: runs.length,
      truncated: false,
    }
  }

  async deleteDocument(target: DocumentTarget, base: number): Promise<DocumentWrite> {
    if (this.offline) return { kind: 'unreachable' }
    if (this.busy) return { kind: 'busy' }
    const current = this.documents.get(target)?.version ?? 0
    if (base !== current) return { kind: 'conflict', version: current }
    this.documents.delete(target)
    return { kind: 'ok', version: 0 }
  }
}

class RevisionController extends FakeController {
  stateRev = 1n
  bootId = 'boot-1'
  pageSize = 100
  manifestReads = 0

  bump() {
    this.stateRev = this.stateRev === 18446744073709551615n ? 1n : this.stateRev + 1n
  }

  override async writeDocument(target: DocumentTarget, payload: string, base: number): Promise<DocumentWrite> {
    const result = await super.writeDocument(target, payload, base)
    if (result.kind !== 'ok') return result
    this.bump()
    return { ...result, stateRev: String(this.stateRev) }
  }

  override async deleteDocument(target: DocumentTarget, base: number): Promise<DocumentWrite> {
    const result = await super.deleteDocument(target, base)
    if (result.kind !== 'ok') return result
    this.bump()
    return { ...result, stateRev: String(this.stateRev) }
  }

  async readManifestPage(cursor?: string): Promise<ManifestRead> {
    this.manifestReads += 1
    if (this.offline) return { kind: 'unreachable' }
    const collections = Object.fromEntries(
      ['profiles', 'beans', 'calibrations', 'meta'].map((name) => {
        const stored = this.documents.get(name)
        return [name, stored ? { bytes: byteLength(stored.payload), version: stored.version } : null]
      }),
    )
    const allRuns = [...this.documents.entries()].flatMap(([key, stored]) =>
      key.startsWith('runs/')
        ? [{ id: key.slice('runs/'.length), bytes: byteLength(stored.payload), version: stored.version }]
        : [],
    )
    const offset = cursor ? Number(cursor) : 0
    const runs = allRuns.slice(offset, offset + this.pageSize)
    const next = offset + runs.length
    return {
      kind: 'ok',
      page: {
        stateRev: String(this.stateRev),
        bootId: this.bootId,
        collections,
        runs,
        logs: [],
        nextCursor: next < allRuns.length ? String(next) : undefined,
      },
    }
  }
}

class RecoveryController extends RevisionController {
  maintenanceBegins = 0
  maintenanceCommits = 0
  maintenanceAborts = 0

  async beginRestoreMaintenance() {
    this.maintenanceBegins += 1
    return { ok: true, token: 'recovery-token' }
  }

  async commitRestoreMaintenance(): Promise<RestoreMaintenanceResult> {
    this.maintenanceCommits += 1
    return { ok: true }
  }

  async abortRestoreMaintenance() {
    this.maintenanceAborts += 1
    return { ok: true }
  }
}

const baseStatus: ControllerStatus = {
  lifecycle: 'STANDBY',
  connected: true,
  stale: false,
  receivedAtMs: 0,
  firmwareVersion: 'mock',
  bootId: '1',
  manualLockout: false,
  thermocoupleValid: true,
  capabilities: {
    apiVersion: 'diagnostic-v1',
    autonomousTimedPrograms: false,
    thermalExecution: false,
    diagnosticTests: true,
  },
}

const withStore = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  ...baseStatus,
  dataStore: {
    mounted: true,
    usedBytes: 4231,
    totalBytes: 917504,
    freeBytes: 612352,
    collections: {},
    runs: { count: 0, bytes: 0 },
  },
  ...overrides,
})

const fresh = async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('localStorage', memoryStorage())
  vi.resetModules()
  const store = await import('./deviceStore')
  const { repository } = await import('./repository')
  const serializer = await import('./documentSerializer')
  return { data: new store.CrackleData(repository) as CrackleData, repository, serializer }
}

/**
 * A RELOAD: the same browser and the same IndexedDB, a brand new data layer with nothing in memory.
 * Everything the old instance was holding that was not written down is gone, which is exactly the
 * condition the outbox exists for.
 */
const reloaded = async (repository: Awaited<ReturnType<typeof fresh>>['repository']) => {
  const store = await import('./deviceStore')
  return new store.CrackleData(repository) as CrackleData
}

const profile = (id: string, name: string): Profile => ({
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
})

const bean = (id: string, name: string): BeanLot => ({
  id,
  name,
  origins: [],
  cultivars: [],
  notes: '',
  createdAt: '',
  updatedAt: '',
})
const recordedOn = {
  deviceId: 'test-device',
  modelId: 'freshroast-sr800',
  displayNameAtCapture: 'Test SR800',
  simulated: true,
  simulatesModelId: 'freshroast-sr800',
  firmwareVersion: 'test',
  identitySource: 'roaster' as const,
}
const origin = (logId: string) => ({ deviceId: recordedOn.deviceId, logId })
const deviceRoast = (logId: string) => ({
  recordingOrigin: origin(logId),
  storageAddress: origin(logId),
  name: 'House espresso',
  dateUnknown: false,
  profileLinked: true,
})

const roast = (id: string, patch: Partial<RoastRun> = {}): RoastRun => ({
  id,
  name: id,
  startedAt: '2026-07-01T10:00:00.000Z',
  profile: {
    id: 'p1',
    name: 'House espresso',
    revision: 1,
    strategy: 'timed',
    createdAt: '',
    updatedAt: '',
    metadata: { intent: '' },
    notes: '',
    points: [],
    coolFan: 9,
    coolDurationSec: 60,
  },
  notes: '',
  controllerVersion: 'mock',
  outcome: 'complete',
  samples: [],
  events: [],
  ...patch,
  recordedOn: patch.recordedOn ?? recordedOn,
})

const DEVICE_STORE_SOURCE = readFileSync(new URL('./deviceStore.ts', import.meta.url), 'utf8')

describe('run mirror commit ordering', () => {
  it('persists the authoritative run before its version ledger', () => {
    const start = DEVICE_STORE_SOURCE.indexOf('private async commitRevisioned')
    const end = DEVICE_STORE_SOURCE.indexOf('private async', start + 1)
    const commit = DEVICE_STORE_SOURCE.slice(start, end)
    const accepted = commit.indexOf('result.kind === "ok"')
    expect(commit.indexOf('await this.mirrorTarget(target)', accepted)).toBeLessThan(
      commit.indexOf('await this.rememberRunVersion', accepted),
    )
    expect(commit).toContain('runBytes[runId] = byteLength(payload)')
    expect(commit).not.toContain('runBytes[runId] = payload.length')
  })
})
describe('boot reconciliation', () => {
  it('takes the roaster as the truth for anything it has a copy of', async () => {
    const { data, repository, serializer } = await fresh()
    // What this browser last saw. This one is about to be overruled, because the roaster has it too.
    await repository.saveBean({
      id: 'bean-1',
      name: 'Stale name',
      origins: [],
      cultivars: [],
      notes: '',
      createdAt: '',
      updatedAt: '',
    })

    const controller = new FakeController()
    controller.seed(
      'beans',
      serializer.serializeBeansDocument(
        [
          {
            id: 'bean-1',
            name: 'Renamed on the phone',
            origins: [],
            cultivars: [],
            notes: '',
            createdAt: '',
            updatedAt: '',
          },
        ],
        [],
      ),
    )
    controller.seed('runs/run-1', serializer.serializeRunDocument(roast('run-1', { name: 'From the roaster' })))
    await data.attach(controller)

    expect((await data.beans()).map((bean) => bean.name)).toEqual(['Renamed on the phone'])
    expect((await data.runs()).map((run) => run.id)).toEqual(['run-1'])
    expect(data.syncState()).toMatchObject({ mode: 'device', attached: true, offline: false, queued: 0 })
  })

  it('reconciles away a roast that was synced and then deleted on another browser', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('runs/run-1', serializer.serializeRunDocument(roast('run-1')))
    controller.seed('runs/run-2', serializer.serializeRunDocument(roast('run-2')))
    await data.attach(controller)
    expect((await data.runs()).map((run) => run.id).sort()).toEqual(['run-1', 'run-2'])

    // The other phone deletes one. Deletes have to stick, or a shared library is not shared.
    controller.documents.delete('runs/run-2')
    await data.refresh()
    expect((await data.runs()).map((run) => run.id)).toEqual(['run-1'])
    expect((await repository.runs()).map((run) => run.id)).toEqual(['run-1'])
  })

  it('skips refetching a run whose cached copy is already at the indexed version', async () => {
    const { data, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('runs/run-1', serializer.serializeRunDocument(roast('run-1')))
    await data.attach(controller)
    expect(controller.reads).toContain('runs/run-1')

    // Second boot, same versions: the index answers, and not one run document is fetched again.
    const second = await import('./deviceStore')
    const { repository } = await import('./repository')
    const again = new second.CrackleData(repository) as CrackleData
    controller.reads = []
    await again.attach(controller)
    expect(controller.reads.filter((target) => target.startsWith('runs/'))).toEqual([])
    expect((await again.runs()).map((run) => run.id)).toEqual(['run-1'])
  })

  it('retains unlisted cached runs when the controller index is truncated', async () => {
    const { data, repository, serializer } = await fresh()
    await repository.saveRun(roast('not-on-this-page'))
    const controller = new FakeController()
    const visible = serializer.serializeRunDocument(roast('visible'))
    controller.seed('runs/visible', visible)
    controller.listRunDocuments = async () => ({
      kind: 'ok',
      runs: [{ id: 'visible', bytes: visible.length, version: 1 }],
      total: 2,
      truncated: true,
    })

    await data.attach(controller)

    expect((await data.runs()).map((run) => run.id).sort()).toEqual(['not-on-this-page', 'visible'])
  })

  it('stays on IndexedDB, and never calls the controller, when status reports no store', async () => {
    const { data, repository } = await fresh()
    await repository.saveBean({
      id: 'bean-1',
      name: 'Browser only',
      origins: [],
      cultivars: [],
      notes: '',
      createdAt: '',
      updatedAt: '',
    })
    data.observeStatus(baseStatus)
    expect(data.syncState().mode).toBe('browser')
    expect(data.syncState().attached).toBe(false)
    await data.saveBean({
      id: 'bean-2',
      name: 'Still browser only',
      origins: [],
      cultivars: [],
      notes: '',
      createdAt: '',
      updatedAt: '',
    })
    expect((await data.beans()).map((bean) => bean.id).sort()).toEqual(['bean-1', 'bean-2'])
    expect(data.syncState().queued).toBe(0)
  })
})

describe('version-checked writes', () => {
  it('rebases a conflicting edit onto the controller copy instead of losing either change', async () => {
    const { data, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('runs/run-1', serializer.serializeRunDocument(roast('run-1', { notes: 'original' })))
    await data.attach(controller)

    // The phone saves a tasting note the instant this browser saves a final weight.
    controller.rival = {
      target: 'runs/run-1',
      payload: serializer.serializeRunDocument(roast('run-1', { notes: 'tasted on the phone' })),
    }
    await data.updateRun('run-1', { measurements: { finalMassG: 190 } })

    const stored = serializer.parseRunDocument(controller.documents.get('runs/run-1')!.payload)
    // Both survive: the phone's note is on the document, and this browser's weight was replayed.
    expect(stored.notes).toBe('tasted on the phone')
    expect(stored.measurements).toEqual({ finalMassG: 190, ambientC: undefined })
    // Exactly one retry, against the version the conflict reported.
    expect(controller.writes.map((write) => write.base)).toEqual([1, 2])
    expect(data.syncState().message).toBeUndefined()
    expect((await data.runs())[0].notes).toBe('tasted on the phone')
  })

  it('surfaces a conflict that survives its one retry, rather than looping', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('profiles', serializer.serializeProfilesDocument([], []))
    await data.attach(controller)
    // A controller that answers conflict to everything: the version it reports is never the truth.
    controller.writeDocument = async () => ({ kind: 'conflict', version: 99 })

    await expect(
      data.saveProfile({
        id: 'p2',
        name: 'New',
        revision: 1,
        strategy: 'timed',
        createdAt: '',
        updatedAt: '',
        metadata: { intent: '' },
        notes: '',
        points: [],
        coolFan: 9,
        coolDurationSec: 60,
      }),
    ).rejects.toThrow(/kept its copy/)
    expect(data.syncState().message).toMatch(/Another browser changed this/)
    expect(data.syncState().queued).toBe(0)
    expect(await data.profiles()).toEqual([])
    expect(await repository.profiles()).toEqual([])
  })
})
describe('manual history batching', () => {
  it('persists a completed Controls sequence with one meta-document write', async () => {
    const { data } = await fresh()
    const controller = new FakeController()
    await data.attach(controller)
    const events: ManualEvent[] = [
      { id: 'fan-only', atMs: 1, kind: 'apply', fan: 4, heat: 0, source: 'local', recordedOn },
      { id: 'heat-on', atMs: 2, kind: 'apply', fan: 4, heat: 1, source: 'local', recordedOn },
      { id: 'stopped', atMs: 3, kind: 'stop', fan: 0, heat: 0, source: 'local', recordedOn },
    ]

    await data.saveManualEvents(events)

    expect(controller.writes.filter((write) => write.target === 'meta')).toHaveLength(1)
    expect((await data.manualEvents()).map((event) => event.id)).toEqual(['fan-only', 'heat-on', 'stopped'])
  })
})

describe('controller-backed profile order', () => {
  it('writes drag order into the profiles document and mirrors it for a later boot', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed(
      'profiles',
      serializer.serializeProfilesDocument([profile('a', 'A'), profile('b', 'B'), profile('c', 'C')], []),
    )
    await data.attach(controller)

    await data.reorderProfiles(['c', 'a', 'b'])

    expect((await data.profiles()).map((row) => row.id)).toEqual(['c', 'a', 'b'])
    expect(
      serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload).profiles.map((row) => row.id),
    ).toEqual(['c', 'a', 'b'])

    const next = await reloaded(repository)
    expect((await next.profiles()).map((row) => row.id)).toEqual(['c', 'a', 'b'])
    await next.attach(controller)
    expect((await next.profiles()).map((row) => row.id)).toEqual(['c', 'a', 'b'])
  })

  it('puts a newly created profile first without moving an edited profile', async () => {
    const { data, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('a', 'A'), profile('b', 'B')], []))
    await data.attach(controller)

    await data.saveProfile(profile('c', 'C'))
    expect((await data.profiles()).map((row) => row.id)).toEqual(['c', 'a', 'b'])

    await data.saveProfile(profile('a', 'A edited'))
    expect((await data.profiles()).map((row) => row.id)).toEqual(['c', 'a', 'b'])
  })
  it('stores a profile and its revision with one controller document write', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    const original = profile('a', 'A')
    const revised = { ...original, name: 'A refined', revision: 2 }
    const revision: ProfileRevision = {
      id: 'profile-revision-a-2',
      profileId: revised.id,
      revision: revised.revision,
      savedAt: '2026-08-06T12:00:00.000Z',
      summary: 'name "A" -> "A refined"',
      profile: revised,
    }
    controller.seed('profiles', serializer.serializeProfilesDocument([original], []))
    await data.attach(controller)

    await data.saveProfileWithRevision(revised, revision)

    expect(controller.writes.filter((write) => write.target === 'profiles')).toHaveLength(1)
    const stored = serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload)
    expect(stored.profiles[0]).toMatchObject({ id: 'a', name: 'A refined', revision: 2 })
    expect(stored.profileRevisions).toEqual([revision])
    expect(await repository.profileRevisions()).toEqual([revision])
  })
})

describe('controller-backed bean order', () => {
  it('puts new lots first and persists drag order in the beans document', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('beans', serializer.serializeBeansDocument([bean('a', 'A'), bean('b', 'B')], []))
    await data.attach(controller)

    await data.saveBean(bean('c', 'C'))
    expect((await data.beans()).map((row) => row.id)).toEqual(['c', 'a', 'b'])
    await data.reorderBeans(['b', 'c', 'a'])
    expect(
      serializer.parseBeansDocument(controller.documents.get('beans')!.payload).beans.map((row) => row.id),
    ).toEqual(['b', 'c', 'a'])

    const next = await reloaded(repository)
    expect((await next.beans()).map((row) => row.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('rejected writes roll back to controller truth', () => {
  it('reverts a collection edit in memory and cache after a capacity refusal', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('beans', serializer.serializeBeansDocument([bean('b1', 'Controller lot')], []))
    await data.attach(controller)
    controller.writeDocument = async () => ({ kind: 'no-space' })

    await expect(data.saveBean({ ...bean('b1', 'Rejected rename') })).rejects.toThrow(/out of room/)

    expect(data.syncState()).toMatchObject({ queued: 0 })
    expect(data.syncState().message).toMatch(/out of room/)
    expect((await data.beans())[0].name).toBe('Controller lot')
    expect((await repository.beans())[0].name).toBe('Controller lot')
  })

  it('reverts a run edit in memory and cache after a size refusal', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('runs/r1', serializer.serializeRunDocument(roast('r1', { notes: 'controller' })))
    await data.attach(controller)
    controller.writeDocument = async () => ({ kind: 'too-large' })

    await expect(data.updateRun('r1', { notes: 'rejected' })).rejects.toThrow(/too large/)

    expect(data.syncState()).toMatchObject({ queued: 0 })
    expect(data.syncState().message).toMatch(/too large/)
    expect((await data.runs())[0].notes).toBe('controller')
    expect((await repository.runs())[0].notes).toBe('controller')
  })
})

describe('the write queue', () => {
  it('queues while the roaster actuates and flushes when a later status reports idle', async () => {
    const { data, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed(
      'beans',
      serializer.serializeBeansDocument(
        [{ id: 'bean-1', name: 'House Huila', origins: [], cultivars: [], notes: '', createdAt: '', updatedAt: '' }],
        [],
      ),
    )
    await data.attach(controller)

    controller.busy = true
    await data.saveBean({
      id: 'bean-1',
      name: 'House Huila',
      origins: [],
      cultivars: [],
      notes: 'Tasted like plums',
      createdAt: '',
      updatedAt: '',
    })
    expect(data.syncState()).toMatchObject({ queued: 1, waitingForIdle: true })
    // The edit is already visible: it is the user's, and only its DURABILITY is waiting.
    expect((await data.beans())[0].notes).toBe('Tasted like plums')
    // A poll that still shows the roaster running changes nothing.
    data.observeStatus(withStore({ lifecycle: 'RUNNING' }))
    await data.flushPending()
    expect(data.syncState().queued).toBe(1)

    controller.busy = false
    data.observeStatus(withStore({ lifecycle: 'STANDBY' }))
    await data.flushPending()
    expect(data.syncState()).toMatchObject({ queued: 0, waitingForIdle: false })
    expect(serializer.parseBeansDocument(controller.documents.get('beans')!.payload).beans[0].notes).toBe(
      'Tasted like plums',
    )
  })

  it('coalesces repeated edits to one document into a single write', async () => {
    const { data, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('beans', serializer.serializeBeansDocument([], []))
    await data.attach(controller)
    controller.busy = true
    for (const notes of ['one', 'two', 'three']) {
      await data.saveBean({
        id: 'bean-1',
        name: 'House Huila',
        origins: [],
        cultivars: [],
        notes,
        createdAt: '',
        updatedAt: '',
      })
    }
    expect(data.syncState().queued).toBe(3)

    controller.busy = false
    await data.flushPending()
    // Three edits, one POST: the working copy already carried all of them.
    expect(controller.writes.filter((write) => write.target === 'beans')).toHaveLength(1)
    expect(serializer.parseBeansDocument(controller.documents.get('beans')!.payload).beans[0].notes).toBe('three')
  })

  it('keeps the library readable while the controller is unreachable, and queues the writes', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed(
      'profiles',
      serializer.serializeProfilesDocument(
        [
          {
            id: 'p1',
            name: 'House espresso',
            revision: 1,
            strategy: 'timed',
            createdAt: '',
            updatedAt: '',
            metadata: { intent: '' },
            notes: '',
            points: [],
            coolFan: 9,
            coolDurationSec: 60,
          },
        ],
        [],
      ),
    )
    await data.attach(controller)

    controller.offline = true
    await data.saveProfile({
      id: 'p1',
      name: 'Renamed offline',
      revision: 2,
      strategy: 'timed',
      createdAt: '',
      updatedAt: '',
      metadata: { intent: '' },
      notes: '',
      points: [],
      coolFan: 9,
      coolDurationSec: 60,
    })
    expect(data.syncState()).toMatchObject({ offline: true, queued: 1 })
    expect((await data.profiles())[0].name).toBe('Renamed offline')
    // The cache is written first, so a reload during the outage still shows the user's work.
    expect((await repository.profiles())[0].name).toBe('Renamed offline')

    controller.offline = false
    await data.flushPending()
    expect(data.syncState()).toMatchObject({ offline: false, queued: 0 })
    expect(serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload).profiles[0].name).toBe(
      'Renamed offline',
    )
  })

  it('deletes a roast from the controller as well as from the cache', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('runs/run-1', serializer.serializeRunDocument(roast('run-1')))
    await data.attach(controller)
    await data.deleteRun('run-1')
    expect(controller.documents.has('runs/run-1')).toBe(false)
    expect(await data.runs()).toEqual([])
    expect(await repository.runs()).toEqual([])
  })

  it('does not rebase a stale delete over a run another browser just changed', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('runs/run-1', serializer.serializeRunDocument(roast('run-1', { notes: 'original' })))
    await data.attach(controller)
    controller.deleteDocument = async (target) => {
      controller.seed(target, serializer.serializeRunDocument(roast('run-1', { notes: 'updated elsewhere' })), 2)
      return { kind: 'conflict', version: 2 }
    }

    await expect(data.deleteRun('run-1')).rejects.toThrow(/not deleted/)

    expect((await data.runs())[0].notes).toBe('updated elsewhere')
    expect((await repository.runs())[0].notes).toBe('updated elsewhere')
    expect(data.syncState().queued).toBe(0)
  })
})

describe('partial controller documents are authoritative', () => {
  it('treats missing collections as empty and exactly prunes subordinate cache rows', async () => {
    const { data, repository, serializer } = await fresh()
    const staleProfile = profile('p-stale', 'Cached profile')
    const staleBean = bean('b-stale', 'Cached bean')
    await repository.saveProfile(staleProfile)
    await repository.saveProfileRevision({
      id: 'pr-stale',
      profileId: staleProfile.id,
      revision: 1,
      savedAt: '2026-01-01T00:00:00.000Z',
      summary: 'stale',
      profile: staleProfile,
    } as ProfileRevision)
    await repository.saveBean(staleBean)
    await repository.saveBeanRevision({
      id: 'br-stale',
      beanId: staleBean.id,
      savedAt: '2026-01-01T00:00:00.000Z',
      summary: 'stale',
      bean: staleBean,
    } as BeanRevision)
    await repository.saveRun(roast('r-stale'))
    await repository.saveCalibrationRun({
      id: 'cr-stale',
      capturedAt: '2026-01-01T00:00:00.000Z',
      recordedOn,
      form: 'steps',
      steps: [],
      maxStepSeconds: 120,
      minStepSeconds: 20,
      settleSeconds: 5,
      settleBandC: 2,
      samples: [],
      notes: '',
    } satisfies CalibrationRun)
    await repository.saveCalibrationSnapshot({
      id: 'cs-stale',
      name: 'Stale fit',
      createdAt: '2026-01-01T00:00:00.000Z',
      recordedOn,
      runIds: [],
      patch: {},
      curves: [],
    } as CalibrationSnapshot)
    await repository.saveManualEvent({
      id: 'me-stale',
      atMs: 1,
      kind: 'apply',
      fan: 5,
      heat: 4,
      source: 'local',
      recordedOn,
    } as ManualEvent)
    const { defaultCalibration } = await import('./calibration')
    await repository.saveCalibration(defaultCalibration)
    await repository.markDeviceLogsImported([recordingKey(origin('41'))])
    await repository.saveMeta('lastExportedAt', '2026-01-01T00:00:00.000Z')

    const controller = new FakeController()
    controller.seed('profiles', serializer.serializeProfilesDocument([], []))
    await data.attach(controller)

    expect(await data.profiles()).toEqual([])
    expect(await data.beans()).toEqual([])
    expect(await data.runs()).toEqual([])
    expect(await data.calibrationRuns()).toEqual([])
    expect(await data.calibrationSnapshots()).toEqual([])
    expect(await data.manualEvents()).toEqual([])
    expect(await data.calibration()).toBeUndefined()
    expect(await data.importedDeviceLogIds()).toEqual(new Set())
    expect(await repository.profileRevisions()).toEqual([])
    expect(await repository.beanRevisions()).toEqual([])
    expect(await repository.meta('lastExportedAt')).toBeUndefined()
  })

  it('blocks edits to a controller document whose payload cannot be parsed', async () => {
    const { data, repository } = await fresh()
    await repository.saveProfile(profile('p-stale', 'Cached profile'))
    const controller = new FakeController()
    controller.seed('profiles', '{not-json')

    await data.attach(controller)

    expect(await data.profiles()).toEqual([])
    expect(data.syncState().message).toMatch(/invalid/)
    const changed = vi.fn()
    data.subscribe(changed)
    await expect(data.saveProfile(profile('p-new', 'Must not overwrite'))).rejects.toThrow(/invalid/)
    expect(changed).toHaveBeenCalled()
    expect(controller.writes).toEqual([])
    expect(await data.profiles()).toEqual([])
    expect(await repository.profiles()).toEqual([])
  })
})

describe('adopting a browser library onto an empty controller', () => {
  it('offers once, with counts, and pushes every collection and run when accepted', async () => {
    const { data, repository, serializer } = await fresh()
    await repository.initialize()
    await repository.saveRun(roast('run-local'))
    const controller = new FakeController()
    await data.attach(controller)

    const offer = data.syncState().adoption
    expect(offer).toBeDefined()
    expect(offer!.profiles).toBeGreaterThan(0)
    expect(offer!.runs).toBeGreaterThan(0)
    // Migration data is a candidate, not the active controller-backed library.
    expect(await data.profiles()).toEqual([])
    expect(await data.runs()).toEqual([])
    expect(await data.calibration()).toBeUndefined()
    // Nothing has been pushed yet: which copy is the real one is the user's decision.
    expect(controller.documents.size).toBe(0)

    await data.adoptLocalData()
    expect(data.syncState().adoption).toBeUndefined()
    expect(serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload).profiles.length).toBe(
      offer!.profiles,
    )
    expect(controller.documents.has('runs/run-local')).toBe(true)
    // Runs push as individual documents; collections push whole.
    expect([...controller.documents.keys()].filter((key) => key.startsWith('runs/'))).toHaveLength(offer!.runs)

    // The offer is answered for good, so a later attach does not ask again.
    const second = await import('./deviceStore')
    const again = new second.CrackleData(repository) as CrackleData
    await again.attach(new FakeController())
    expect(again.syncState().adoption).toBeUndefined()
  })

  it('keeps immutable adoption payloads while a revision signal arrives before the queue drains', async () => {
    const { data, repository, serializer } = await fresh()
    await repository.initialize()
    await repository.saveRun(roast('run-local-race'))
    const controller = new RevisionController()
    await data.attach(controller)
    controller.busy = true
    await data.adoptLocalData()
    expect(data.syncState().queued).toBeGreaterThan(0)

    controller.seed(
      'runs/run-local-race',
      serializer.serializeRunDocument(roast('run-local-race', { notes: 'rival copy' })),
    )
    controller.bump()
    data.observeRevision({ connected: true, stateRev: String(controller.stateRev), active: false })
    controller.busy = false
    await data.flushPending()

    expect(controller.documents.has('runs/run-local-race')).toBe(true)
    expect((await data.runs()).find((run) => run.id === 'run-local-race')?.notes).not.toBe('rival copy')
    expect(controller.writes.some((write) => write.target === 'runs/run-local-race')).toBe(true)
    expect(data.syncState().queued).toBe(0)
  })

  it('clears a stale empty-device offer by reconciling an acknowledged ordinary save', async () => {
    const { data, repository } = await fresh()
    await repository.initialize()
    await repository.saveRun(roast('local-candidate'))
    const controller = new RevisionController()
    await data.attach(controller)
    expect(data.syncState().adoption).toBeDefined()
    controller.manifestReads = 0

    await data.saveBean(bean('device-bean', 'Saved on device'))

    expect(controller.manifestReads).toBeGreaterThan(0)
    expect(data.syncState().adoption).toBeUndefined()
    expect((await data.beans()).map((row) => row.id)).toEqual(['device-bean'])
    expect(await data.runs()).toEqual([])
  })

  it('never offers when the controller already holds something', async () => {
    const { data, repository, serializer } = await fresh()
    await repository.initialize()
    const controller = new FakeController()
    controller.seed('meta', serializer.serializeMetaDocument([], []))
    await data.attach(controller)
    expect(data.syncState().adoption).toBeUndefined()
  })

  it('can be declined, and stays declined', async () => {
    const { data, repository } = await fresh()
    await repository.initialize()
    await data.attach(new FakeController())
    expect(data.syncState().adoption).toBeDefined()
    await data.dismissAdoption()
    expect(data.syncState().adoption).toBeUndefined()
  })
})

/**
 * ============================================================================================
 * STRICT DEVICE TRUTH: THE ROASTER'S COPY IS THE LIBRARY
 * ============================================================================================
 *
 * The browser may never hold more profiles or bean lots than the device, and has no state of its own
 * that differs from the device: the two are always aligned.
 *
 * There is deliberately no three-way prompt - push, discard, or dismiss. The one scenario it would
 * guard, a roaster carrying nothing but smoke-test debris out-voting months of local roasts, does not
 * arise (a real roaster is flashed with its store intact, and the mock seeds itself), and its cost
 * would be a browser holding roasts the roaster does not, permanently flagged.
 *
 * So the device wins, unconditionally and silently. The one exception is a roaster whose store is
 * COMPLETELY empty, which is adoption's case and is tested above.
 */
describe('boot against a roaster that has its own library', () => {
  /** A roaster with something on it, and a browser holding more than that. */
  const established = async () => {
    const context = await fresh()
    const controller = new FakeController()
    controller.seed('meta', context.serializer.serializeMetaDocument([], []))
    controller.seed('profiles', context.serializer.serializeProfilesDocument([], []))
    controller.seed('beans', context.serializer.serializeBeansDocument([], []))
    controller.seed('runs/on-the-roaster', context.serializer.serializeRunDocument(roast('on-the-roaster')))
    return { ...context, controller }
  }

  const localLibrary = async (repository: Awaited<ReturnType<typeof fresh>>['repository']) => {
    await repository.saveRun(roast('run-mine-1'))
    await repository.saveRun(roast('run-mine-2'))
    await repository.saveProfile({
      id: 'p-mine',
      name: 'My house roast',
      revision: 3,
      strategy: 'timed',
      createdAt: '',
      updatedAt: '',
      metadata: { intent: '' },
      notes: '',
      points: [],
      coolFan: 9,
      coolDurationSec: 60,
    })
    await repository.saveBean({
      id: 'b-mine',
      name: 'My Huila',
      origins: [],
      cultivars: [],
      notes: '',
      createdAt: '',
      updatedAt: '',
    })
  }

  it('drops cache content the roaster does not have, and asks nothing', async () => {
    const { data, repository, controller } = await established()
    await localLibrary(repository)
    await data.attach(controller)

    expect((await data.runs()).map((run) => run.id)).toEqual(['on-the-roaster'])
    expect((await data.profiles()).map((profile) => profile.id)).not.toContain('p-mine')
    expect((await data.beans()).map((bean) => bean.id)).not.toContain('b-mine')
    // Silently: there is no prompt, no offer, and no standing flag to answer.
    expect(data.syncState().adoption).toBeUndefined()
    // And nothing was pushed either. Dropping stale cache is not a reason to write to the roaster.
    expect(controller.writes).toEqual([])
  })

  /**
   * The cache goes too, or it is not alignment. A row left in IndexedDB comes back through
   * `cachedWorking` on the next boot - and on an OFFLINE boot there is no device document to
   * overwrite it with, so the browser would be showing content the roaster does not have again.
   */
  it('prunes the cache as well as the working copy, so nothing resurrects', async () => {
    const { data, repository, controller } = await established()
    await localLibrary(repository)
    await data.attach(controller)

    expect((await repository.runs()).map((run) => run.id)).toEqual(['on-the-roaster'])
    expect((await repository.profiles()).map((profile) => profile.id)).not.toContain('p-mine')
    expect((await repository.beans()).map((bean) => bean.id)).not.toContain('b-mine')
  })

  /** The roaster's own copy of a shared document still wins on content, which is the same rule. */
  it('takes the roasters own version of anything they both have', async () => {
    const { data, repository, serializer } = await fresh()
    await repository.saveRun(roast('run-1', { notes: 'stale local note' }))
    const controller = new FakeController()
    controller.seed('runs/run-1', serializer.serializeRunDocument(roast('run-1', { notes: 'from the roaster' })))
    await data.attach(controller)
    expect((await data.runs())[0].notes).toBe('from the roaster')
  })

  /** An unreachable roaster knows nothing, so it may not be the reason to delete anything. */
  it('deletes nothing while the roaster is unreachable', async () => {
    const { data, repository } = await fresh()
    await repository.saveRun(roast('run-mine-1'))
    const controller = new FakeController()
    controller.offline = true
    await data.attach(controller)
    expect((await data.runs()).map((run) => run.id)).toEqual(['run-mine-1'])
    expect((await repository.runs()).map((run) => run.id)).toEqual(['run-mine-1'])
  })

  /** Nor may an empty one: that is adoption's case, and adoption is an offer rather than a sweep. */
  it('deletes nothing when the roaster holds no library at all', async () => {
    const { data, repository } = await fresh()
    await repository.saveRun(roast('run-mine-1'))
    await data.attach(new FakeController())
    expect(await data.runs()).toEqual([])
    expect(data.syncState().adoption).toBeDefined()
  })
})

describe('rehydrating a roast the roaster recorded', () => {
  it('rebuilds the curve from the recordings archive on a browser that never imported it', async () => {
    const { data, serializer } = await fresh()
    const controller = new FakeController()
    const recorded = roast('device-roast-41', {
      deviceRoast: deviceRoast('41'),
    })
    controller.seed('runs/device-roast-41', serializer.serializeRunDocument(recorded))
    // A recording link is sufficient even when this synthetic document has no fallback samples.
    const stored = JSON.parse(serializer.unpackDocumentJson(controller.documents.get('runs/device-roast-41')!.payload))
    expect(stored.recordingId).toBe(recordingKey(origin('41')))
    expect(stored.samples).toBeUndefined()

    const csv =
      't_ms,thermocouple_c,cold_junction_c,fan,heat\n0,25.4,22.1,5.0,4.0\n1000,26.6,22.2,5.0,4.0\n2000,28.1,22.2,5.0,0.0\n'
    await data.attach(controller, async () => ({ kind: 'ok', samples: parseThermalCsv(csv) }))
    await data.refresh()
    const [run] = await data.runs()
    expect(run.samples).toHaveLength(3)
    expect(run.samples[0].beanTempC).toBeCloseTo(25.4)
    // Hydration is a cache fill, not an edit: nothing was written back to the controller.
    expect(controller.writes).toEqual([])
  })

  it('refuses hydration when a reused storage address belongs to different recording evidence', async () => {
    const { data, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed(
      'runs/device-roast-41',
      serializer.serializeRunDocument(
        roast('device-roast-41', {
          deviceRoast: deviceRoast('41'),
        }),
      ),
    )
    const warning = 'The archive address belongs to different evidence.'
    await data.attach(controller, async () => ({ kind: 'mismatch', message: warning }))
    await data.refresh()
    expect((await data.runs())[0].samples).toEqual([])
    expect(data.syncState().notices).toContain(warning)
  })

  it('rehydrates a compacted calibration pass from its controller archive', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    const recorded: CalibrationRun = {
      id: 'calibration-41',
      capturedAt: '2026-07-31T12:00:00.000Z',
      recordedOn,
      sourceLogId: '41',
      sourceMode: 'calibration',
      form: 'grid',
      steps: [{ fan: 1, heat: 1 }],
      maxStepSeconds: 300,
      minStepSeconds: 20,
      settleSeconds: 20,
      settleBandC: 0.2,
      samples: [],
      notes: '',
    }
    controller.seed('calibrations', serializer.serializeCalibrationsDocument(undefined, [], [recorded]))
    const csv = 't_ms,thermocouple_c,cold_junction_c,fan,heat\n0,49.0,22.1,1.0,1.0\n1000,52.5,22.2,1.0,1.0\n'
    const hydrate = vi.fn(async (request: { recordingOrigin: { logId: string } }) => {
      expect(request.recordingOrigin.logId).toBe('41')
      return { kind: 'ok' as const, samples: parseThermalCsv(csv) }
    })
    await data.attach(controller, hydrate)
    await data.refresh()
    const [run] = await data.calibrationRuns()
    expect(run.samples).toHaveLength(2)
    expect(run.samples[1].thermocoupleC).toBeCloseTo(52.5)
    expect(controller.writes).toEqual([])
    expect((await repository.calibrationRuns())[0].samples).toHaveLength(2)
    await data.refresh()
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect((await data.calibrationRuns())[0].samples).toHaveLength(2)
  })

  it('a page load reuses samples this browser already downloaded instead of fetching them again', async () => {
    // Without the persisted hydration cache every page load would re-download every calibration
    // recording (and re-read the recordings list per recording), because the library mirror is
    // rewritten from the compacted roaster documents, which carry no samples.
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    const pass: CalibrationRun = {
      id: 'calibration-41',
      capturedAt: '2026-07-31T12:00:00.000Z',
      recordedOn,
      sourceLogId: '41',
      sourceMode: 'calibration',
      form: 'grid',
      steps: [{ fan: 1, heat: 1 }],
      maxStepSeconds: 300,
      minStepSeconds: 20,
      settleSeconds: 20,
      settleBandC: 0.2,
      samples: [],
      notes: '',
    }
    controller.seed('calibrations', serializer.serializeCalibrationsDocument(undefined, [], [pass]))
    controller.seed(
      'runs/device-roast-42',
      serializer.serializeRunDocument(roast('device-roast-42', { deviceRoast: deviceRoast('42') })),
    )
    const csv = 't_ms,thermocouple_c,cold_junction_c,fan,heat\n0,49.0,22.1,1.0,1.0\n1000,52.5,22.2,1.0,1.0\n'
    const hydrate = vi.fn(async () => ({ kind: 'ok' as const, samples: parseThermalCsv(csv) }))
    await data.attach(controller, hydrate)
    await data.refresh()
    expect(hydrate).toHaveBeenCalledTimes(2)

    const page = await reloaded(repository)
    const again = vi.fn(async () => ({ kind: 'ok' as const, samples: parseThermalCsv(csv) }))
    await page.attach(controller, again)
    await page.refresh()
    expect(again).not.toHaveBeenCalled()
    expect((await page.calibrationRuns())[0].samples).toHaveLength(2)
    expect((await page.runs())[0].samples).toHaveLength(2)
    expect(controller.writes).toEqual([])

    // A recording the library no longer refers to leaves the cache with it.
    controller.seed('calibrations', serializer.serializeCalibrationsDocument(undefined, [], []))
    await page.refresh()
    await page.refresh()
    expect(await repository.meta(`hydratedRecording:${recordingKey(origin('41'))}`)).toBeUndefined()
    expect(await repository.meta(`hydratedRecording:${recordingKey(origin('42'))}`)).toBeDefined()
  })
})

/**
 * ============================================================================================
 * THE CASCADE, AND THE ONE THING IT MAY NOT DO
 * ============================================================================================
 *
 * Every other write here queues when the controller is unreachable or busy, because an edit that
 * lands late is still the edit the user wanted. A cascade is not like that: it destroys a dozen
 * roasts and their recordings with no undo behind it, and a queued one would fire at some
 * unannounced later moment on a library another browser may since have changed. So `deleteRunsNow`
 * bypasses the queue entirely and REPORTS what the device refused rather than retrying it.
 */
describe('deleting roasts as a cascade', () => {
  it('deletes straight through, and leaves nothing queued behind it', async () => {
    const { data } = await fresh()
    const client = new FakeController()
    client.seed(
      'runs/run-a',
      JSON.stringify({ v: 1, run: roast('run-a'), summary: { durationSec: 0, sampleCount: 0 } }),
    )
    client.seed(
      'runs/run-b',
      JSON.stringify({ v: 1, run: roast('run-b'), summary: { durationSec: 0, sampleCount: 0 } }),
    )
    await data.attach(client)

    const outcome = await data.deleteRunsNow(['run-a', 'run-b'])
    expect(outcome.deleted).toEqual(['run-a', 'run-b'])
    expect(outcome.failed).toEqual([])
    expect(client.documents.has('runs/run-a')).toBe(false)
    expect(await data.runs()).toEqual([])
    // Nothing waiting: a cascade either happened or it did not.
    expect(data.syncState().queued).toBe(0)
  })

  it('reports a refusal instead of queuing it, and keeps the roast it could not remove', async () => {
    const { data } = await fresh()
    const client = new FakeController()
    client.seed(
      'runs/run-a',
      JSON.stringify({ v: 1, run: roast('run-a'), summary: { durationSec: 0, sampleCount: 0 } }),
    )
    await data.attach(client)
    client.busy = true

    const outcome = await data.deleteRunsNow(['run-a'])
    expect(outcome.deleted).toEqual([])
    expect(outcome.failed[0].message).toContain('running or recording')
    expect(client.documents.has('runs/run-a')).toBe(true)
    expect(data.syncState().queued).toBe(0)
  })

  /** Grouping bytes by profile needs the DEVICE's own per-document sizes, not the browser's guess. */
  it('carries the run index byte sizes into the sync state', async () => {
    const { data } = await fresh()
    const client = new FakeController()
    const payload = JSON.stringify({ v: 1, run: roast('run-a'), summary: { durationSec: 0, sampleCount: 0 } })
    client.seed('runs/run-a', payload)
    await data.attach(client)
    expect(data.syncState().runBytes['run-a']).toBe(payload.length)
  })
})

/**
 * ============================================================================================
 * THE OUTBOX: A QUEUED EDIT HAS TO SURVIVE THE PAGE THAT MADE IT
 * ============================================================================================
 *
 * Device-wins and a memory-only queue were fine together right up to the reload, and then they were
 * a data loss with no message attached. The edit was in IndexedDB, so the screen kept showing it;
 * the INTENT to send it was not, so the next boot found a cache holding something the roaster's
 * document did not name, applied the strict rule, and quietly overwrote the edit or deleted the new
 * lot. Every case below is one shape of that, and none of them may end in silence.
 *
 * The rule the tests pin: a target with a pending outbox entry is exempt from device-wins until its
 * flush resolves, and the flush - not the boot - decides which copy was right.
 */
describe('a queued edit across a reload', () => {
  it('does not contact the roaster or resolve a save until its durable intent is on disk', async () => {
    const { data, repository } = await fresh()
    const controller = new FakeController()
    await data.attach(controller)
    controller.busy = true

    let entered!: () => void
    let release!: () => void
    const outboxEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const outboxGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalSaveMeta = repository.saveMeta.bind(repository)
    const metaSpy = vi.spyOn(repository, 'saveMeta').mockImplementation(async (key, value) => {
      if (key === OUTBOX) {
        entered()
        await outboxGate
      }
      return originalSaveMeta(key, value)
    })
    const writeSpy = vi.spyOn(controller, 'writeDocument')
    let settled = false

    const saving = data.saveBean(bean('b-new', 'Durable lot')).then(() => {
      settled = true
    })
    await outboxEntered
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(writeSpy).not.toHaveBeenCalled()

    release()
    await saving
    expect(writeSpy).toHaveBeenCalledOnce()
    expect(await repository.meta<Record<string, unknown>>(OUTBOX)).toHaveProperty('beans')
    metaSpy.mockRestore()
  })

  it('does not resolve a successful save until the spent outbox entry is cleared on disk', async () => {
    const { data, repository } = await fresh()
    const controller = new FakeController()
    await data.attach(controller)

    let entered!: () => void
    let release!: () => void
    const clearEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const clearGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalSaveMeta = repository.saveMeta.bind(repository)
    const metaSpy = vi.spyOn(repository, 'saveMeta').mockImplementation(async (key, value) => {
      const emptyOutbox = key === OUTBOX && Object.keys(value as Record<string, unknown>).length === 0
      if (emptyOutbox) {
        entered()
        await clearGate
      }
      return originalSaveMeta(key, value)
    })
    let settled = false

    const saving = data.saveBean(bean('b-new', 'Committed lot')).then(() => {
      settled = true
    })
    await clearEntered
    expect(settled).toBe(false)
    expect(controller.documents.has('beans')).toBe(true)

    release()
    await saving
    expect(await repository.meta<Record<string, unknown>>(OUTBOX)).toEqual({})
    metaSpy.mockRestore()
  })
  const OUTBOX = 'deviceOutbox'

  it('keeps an edited profile through reconciliation, and flushes it when the roaster idles', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('p1', 'House espresso')], []))
    await data.attach(controller)

    // The roaster is mid-roast, which is a completely ordinary time to rename a recipe.
    controller.busy = true
    await data.saveProfile(profile('p1', 'Renamed while busy'))
    expect(data.syncState()).toMatchObject({ queued: 1, waitingForIdle: true })

    // ...and the tab is closed with the write still owed. The document itself is on the shelf.
    expect(Object.keys((await repository.meta<Record<string, unknown>>(OUTBOX)) ?? {})).toEqual(['profiles'])

    const after = await reloaded(repository)
    await after.attach(controller)
    // Device-wins would have put 'House espresso' back here, in both copies, saying nothing.
    expect((await after.profiles())[0].name).toBe('Renamed while busy')
    expect((await repository.profiles())[0].name).toBe('Renamed while busy')
    expect(after.syncState().queued).toBe(1)

    controller.busy = false
    await after.flushPending()
    expect(serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload).profiles[0].name).toBe(
      'Renamed while busy',
    )
    expect(after.syncState()).toMatchObject({ queued: 0, notices: [] })
    // Settled means gone: a spent entry offered again on the next boot is its own kind of wrong.
    expect(await repository.meta<Record<string, unknown>>(OUTBOX)).toEqual({})
  })

  it('keeps a bean lot created while the roaster was unreachable, rather than pruning it away', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('beans', serializer.serializeBeansDocument([bean('b-old', 'House Huila')], []))
    await data.attach(controller)

    controller.offline = true
    await data.saveBean(bean('b-new', 'Yirgacheffe, new lot'))
    expect(data.syncState()).toMatchObject({ queued: 1, offline: true })

    // The roaster is back on the reload, and its document has never heard of the new lot. Under the
    // strict rule that is a name for the prune list; under the outbox it is a write still owed.
    controller.offline = false
    const after = await reloaded(repository)
    await after.attach(controller)
    expect((await after.beans()).map((row) => row.id).sort()).toEqual(['b-new', 'b-old'])
    expect((await repository.beans()).map((row) => row.id).sort()).toEqual(['b-new', 'b-old'])
    // The boot offers it without being asked - there is nothing left standing in the way.
    expect(
      serializer
        .parseBeansDocument(controller.documents.get('beans')!.payload)
        .beans.map((row) => row.id)
        .sort(),
    ).toEqual(['b-new', 'b-old'])
    expect(after.syncState().queued).toBe(0)
  })

  /**
   * The quietest of them. A run edit made while busy leaves the cache at the SAME version the index
   * reports, so reconciliation is satisfied - it keeps the cached copy and fetches nothing. The
   * edit survives on screen and is no longer queued anywhere: the two libraries disagree forever,
   * and every single thing the app can see says they agree.
   */
  it('re-queues a run edit whose cached version still matches the roaster, instead of diverging', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('runs/run-1', serializer.serializeRunDocument(roast('run-1', { notes: '' })))
    await data.attach(controller)

    controller.busy = true
    await data.updateRun('run-1', { notes: 'tasted like plums' })
    expect(data.syncState().queued).toBe(1)

    const after = await reloaded(repository)
    await after.attach(controller)
    expect((await after.runs())[0].notes).toBe('tasted like plums')
    // The point of the test: it is QUEUED again, not merely still visible.
    expect(after.syncState().queued).toBe(1)
    // And the roaster's copy is untouched so far, which is why the queue still matters.
    expect(serializer.parseRunDocument(controller.documents.get('runs/run-1')!.payload).notes).toBe('')

    controller.busy = false
    await after.flushPending()
    expect(serializer.parseRunDocument(controller.documents.get('runs/run-1')!.payload).notes).toBe('tasted like plums')
    expect(after.syncState().queued).toBe(0)
  })

  /**
   * The one case where the edit cannot be saved, and the only thing that matters is how it is said.
   *
   * The mutation went with the page, so there is nothing to replay onto the roaster's newer copy;
   * posting the stale document instead would overwrite whatever the other browser did. So the
   * roaster keeps its version - and the user is told, by name, once.
   */
  it('keeps the roasters version when it moved on while this browser was away, and says so', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('p1', 'House espresso')], []))
    await data.attach(controller)

    controller.busy = true
    await data.saveProfile(profile('p1', 'Renamed here'))
    expect(data.syncState().queued).toBe(1)

    // Meanwhile, on the phone. The roaster is at version 2 and this browser's base of 1 is history.
    controller.busy = false
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('p1', 'Renamed on the phone')], []), 2)

    const after = await reloaded(repository)
    await after.attach(controller)

    expect((await after.profiles())[0].name).toBe('Renamed on the phone')
    expect(serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload).profiles[0].name).toBe(
      'Renamed on the phone',
    )
    const notices = after.syncState().notices ?? []
    expect(notices).toHaveLength(1)
    expect(notices[0]).toBe(
      "An edit to your profiles made while the roaster was busy could not be applied because the roaster's copy changed. The roaster's version is shown - please re-make your edit.",
    )
    // Never a loop and never a maze: the entry is spent, the queue is empty, and it is one sentence.
    expect(after.syncState().queued).toBe(0)
    expect(await repository.meta<Record<string, unknown>>(OUTBOX)).toEqual({})

    after.dismissNotice(notices[0])
    expect(after.syncState().notices).toEqual([])
  })

  it('names the roast rather than the document when a run edit is the one that was overtaken', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('runs/run-1', serializer.serializeRunDocument(roast('run-1', { name: 'Sunday Huila' })))
    await data.attach(controller)

    controller.busy = true
    await data.updateRun('run-1', { notes: 'mine' })
    controller.busy = false
    controller.seed(
      'runs/run-1',
      serializer.serializeRunDocument(roast('run-1', { name: 'Sunday Huila', notes: 'theirs' })),
      2,
    )

    const after = await reloaded(repository)
    await after.attach(controller)
    expect((await after.runs())[0].notes).toBe('theirs')
    expect(after.syncState().notices?.[0]).toContain('An edit to the roast "Sunday Huila"')
  })

  /** Busy is not a verdict. It stays owed, across as many reloads as the roast takes. */
  it('keeps queueing through repeated reloads while the roaster is still busy', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('beans', serializer.serializeBeansDocument([bean('b-1', 'House Huila')], []))
    await data.attach(controller)

    controller.busy = true
    await data.saveBean({ ...bean('b-1', 'House Huila'), notes: 'plums' })

    let latest = data
    for (let reload = 0; reload < 2; reload += 1) {
      latest = await reloaded(repository)
      await latest.attach(controller)
      expect(latest.syncState()).toMatchObject({ queued: 1, waitingForIdle: true })
      expect((await latest.beans())[0].notes).toBe('plums')
      expect(latest.syncState().notices ?? []).toEqual([])
    }

    controller.busy = false
    await latest.flushPending()
    expect(serializer.parseBeansDocument(controller.documents.get('beans')!.payload).beans[0].notes).toBe('plums')
    expect(await repository.meta<Record<string, unknown>>(OUTBOX)).toEqual({})
  })

  /**
   * The outbox is a write ledger, never a gate on reading. A library that will not open because a
   * note is waiting to be posted would be far worse than the lost edit the outbox prevents.
   */
  it('never blocks a read, whatever is queued and whatever is on the shelf', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('beans', serializer.serializeBeansDocument([bean('b-1', 'House Huila')], []))
    await data.attach(controller)
    controller.offline = true
    await data.saveBean(bean('b-2', 'Second lot'))

    // A shelf is not a schema, and a browser that met a newer version of this app may find anything
    // at all under the key. Nothing there may cost the user their library.
    await repository.saveMeta(OUTBOX, { beans: 'not an entry', 'runs/x': { base: 'soon' }, meta: null })
    const after = await reloaded(repository)
    await after.attach(controller)
    expect((await after.beans()).map((row) => row.id).sort()).toEqual(['b-1', 'b-2'])
    expect(await after.runs()).toEqual([])
    expect(await after.profiles()).toEqual([])
    expect(after.syncState().queued).toBe(0)
  })
})

describe('destructive restore isolation', () => {
  it('recovers needs-format storage through the maintenance boundary without requiring catalog currency', async () => {
    const { data } = await fresh()
    const controller = new RecoveryController()
    await data.bindObservedDevice('device-a')
    await data.attach(controller)
    data.observeRevision({ maintenance: 'incomplete' })
    expect(data.mutationBlockedReason()).toMatch(/previous restore did not finish/i)

    await expect(data.beginDeviceRestore()).rejects.toThrow(/previous restore did not finish/i)
    await expect(data.beginDeviceStorageRecovery('device-a')).resolves.toEqual({ formatRequired: true })
    expect(controller.maintenanceBegins).toBe(1)
    expect(data.mutationBlockedReason()).toMatch(/restore is still in progress/i)

    data.deviceFormatConfirmed()
    await expect(data.beginDeviceStorageRecovery('device-a')).resolves.toEqual({ formatRequired: false })
    await data.resetAfterDeviceFormat()
    await data.reconcileDeviceRestore()
    expect(controller.maintenanceCommits).toBe(1)
    expect(data.finishDeviceRestore()).toBe(true)
  })

  it('requires a fresh format after reload because generic incomplete maintenance may be a partial restore', async () => {
    const { data } = await fresh()
    const controller = new RecoveryController()
    await data.bindObservedDevice('device-a')
    await data.attach(controller)
    data.observeRevision({ maintenance: 'incomplete' })

    await expect(data.beginDeviceStorageRecovery('device-a')).resolves.toEqual({ formatRequired: true })
    expect(controller.maintenanceBegins).toBe(1)
    data.deviceFormatConfirmed()
    await data.resetAfterDeviceFormat()
    await data.reconcileDeviceRestore()
    expect(controller.maintenanceCommits).toBe(1)
    expect(data.finishDeviceRestore()).toBe(true)
  })

  it('reclaims a fresh lease after commit rejects while preserving same-page format proof', async () => {
    const { data } = await fresh()
    const controller = new RecoveryController()
    await data.bindObservedDevice('device-a')
    await data.attach(controller)
    const commit = vi.spyOn(controller, 'commitRestoreMaintenance')
    commit.mockResolvedValueOnce({ ok: false, message: 'lease expired' }).mockImplementation(async () => {
      controller.maintenanceCommits += 1
      return { ok: true }
    })

    await expect(data.beginDeviceStorageRecovery('device-a')).resolves.toEqual({ formatRequired: true })
    data.deviceFormatConfirmed()
    await data.resetAfterDeviceFormat()
    await expect(data.reconcileDeviceRestore()).rejects.toThrow(/lease expired/i)
    expect(data.releaseDeviceStorageRecoveryForRetry()).toBe(true)
    await expect(data.beginDeviceStorageRecovery('device-a')).resolves.toEqual({ formatRequired: false })
    expect(controller.maintenanceBegins).toBe(2)
    await data.reconcileDeviceRestore()
    expect(controller.maintenanceCommits).toBe(1)
    expect(data.finishDeviceRestore()).toBe(true)
  })

  it('releases its browser lock when maintenance cannot be claimed before format', async () => {
    const { data } = await fresh()
    const controller = new RecoveryController()
    await data.bindObservedDevice('device-a')
    await data.attach(controller)
    vi.spyOn(controller, 'beginRestoreMaintenance').mockRejectedValueOnce(new Error('transport broke'))

    await expect(data.beginDeviceStorageRecovery('device-a')).rejects.toThrow(/transport broke/i)
    await expect(data.beginDeviceStorageRecovery('device-a')).resolves.toEqual({ formatRequired: true })
    expect(controller.maintenanceBegins).toBe(1)
    await data.abortDeviceRestore()
    expect(controller.maintenanceAborts).toBe(1)
  })

  it('reclaims a fresh lease before format without carrying forward format proof', async () => {
    const { data } = await fresh()
    const controller = new RecoveryController()
    await data.bindObservedDevice('device-a')
    await data.attach(controller)

    await expect(data.beginDeviceStorageRecovery('device-a')).resolves.toEqual({ formatRequired: true })
    expect(data.releaseDeviceStorageRecoveryForRetry()).toBe(true)
    await expect(data.beginDeviceStorageRecovery('device-a')).resolves.toEqual({ formatRequired: true })
    expect(controller.maintenanceBegins).toBe(2)
    await data.abortDeviceRestore()
    expect(controller.maintenanceAborts).toBe(1)
  })

  it('refuses storage recovery when the live identity does not match the bound browser cache', async () => {
    const { data } = await fresh()
    const controller = new RecoveryController()
    await data.bindObservedDevice('device-a')
    await data.attach(controller)

    await expect(data.beginDeviceStorageRecovery('device-b')).rejects.toThrow(/identity does not match/i)
    expect(controller.maintenanceBegins).toBe(0)
  })

  it('refuses storage recovery without current revisioned status or the maintenance API', async () => {
    const missingRevision = await fresh()
    const recoveryController = new RecoveryController()
    vi.spyOn(recoveryController, 'readManifestPage').mockResolvedValue({ kind: 'error', message: 'unmounted' })
    await missingRevision.data.bindObservedDevice('device-a')
    await missingRevision.data.attach(recoveryController)
    await expect(missingRevision.data.beginDeviceStorageRecovery('device-a')).rejects.toThrow(
      /current storage revision/i,
    )
    expect(recoveryController.maintenanceBegins).toBe(0)

    const missingMaintenance = await fresh()
    const ordinaryController = new RevisionController()
    await missingMaintenance.data.bindObservedDevice('device-a')
    await missingMaintenance.data.attach(ordinaryController)
    await expect(missingMaintenance.data.beginDeviceStorageRecovery('device-a')).rejects.toThrow(
      /does not support safe storage recovery/i,
    )
  })

  it('refuses storage recovery after the controller is observed offline', async () => {
    const { data } = await fresh()
    const controller = new RecoveryController()
    await data.bindObservedDevice('device-a')
    await data.attach(controller)
    data.observeRevision({ connected: false })

    await expect(data.beginDeviceStorageRecovery('device-a')).rejects.toThrow(/not connected/i)
    expect(controller.maintenanceBegins).toBe(0)
  })

  it('replaces every former library cache value from an empty baseline after format', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    const oldProfile = profile('p-old', 'Old profile')
    const oldBean = bean('b-old', 'Old bean')
    await repository.saveProfile(oldProfile)
    await repository.saveProfileRevision({
      id: 'pr-old',
      profileId: oldProfile.id,
      revision: 1,
      savedAt: '2026-01-01T00:00:00.000Z',
      summary: 'old',
      profile: oldProfile,
    } as ProfileRevision)
    await repository.saveBean(oldBean)
    await repository.saveBeanRevision({
      id: 'br-old',
      beanId: oldBean.id,
      savedAt: '2026-01-01T00:00:00.000Z',
      summary: 'old',
      bean: oldBean,
    } as BeanRevision)
    await repository.saveRun(roast('r-old'))
    await repository.saveCalibrationRun({
      id: 'cr-old',
      capturedAt: '2026-01-01T00:00:00.000Z',
      recordedOn,
      form: 'steps',
      steps: [],
      maxStepSeconds: 120,
      minStepSeconds: 20,
      settleSeconds: 5,
      settleBandC: 2,
      samples: [],
      notes: '',
    } satisfies CalibrationRun)
    await repository.saveCalibrationSnapshot({
      id: 'cs-old',
      name: 'Old fit',
      createdAt: '2026-01-01T00:00:00.000Z',
      recordedOn,
      runIds: [],
      patch: {},
      curves: [],
    } as CalibrationSnapshot)
    await repository.saveManualEvent({
      id: 'me-old',
      atMs: 1,
      kind: 'apply',
      fan: 5,
      heat: 4,
      source: 'local',
      recordedOn,
    } as ManualEvent)
    const { defaultCalibration } = await import('./calibration')
    await repository.saveCalibration({ ...defaultCalibration, heaterGainCPerMinAt10: 321 })
    await repository.markDeviceLogsImported([recordingKey(origin('99'))])
    await repository.saveMeta('lastExportedAt', '2026-01-01T00:00:00.000Z')
    await repository.saveMeta('deviceAdoptionDismissed', true)
    await repository.saveMeta('seeded', true)
    await data.attach(controller)

    await data.beginDeviceRestore()
    data.deviceFormatConfirmed()
    await repository.saveMeta('deviceOutbox', { profiles: { payload: 'old', base: 0 } })
    await repository.saveMeta('deviceRunVersions', { 'r-old': 9 })
    controller.documents.clear()
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('p-new', 'From backup')], []), 1)
    controller.seed('calibrations', serializer.serializeCalibrationsDocument(undefined, [], []), 1)
    controller.seed('meta', serializer.serializeMetaDocument([], []), 1)
    await data.resetAfterDeviceFormat()
    expect(await repository.meta('deviceOutbox')).toBeUndefined()
    expect(await repository.meta('deviceRunVersions')).toBeUndefined()
    await data.reconcileDeviceRestore()

    expect((await data.profiles()).map((row) => row.id)).toEqual(['p-new'])
    expect(await data.beans()).toEqual([])
    expect(await data.runs()).toEqual([])
    expect(await data.calibrationRuns()).toEqual([])
    expect(await data.calibrationSnapshots()).toEqual([])
    expect(await data.manualEvents()).toEqual([])
    expect(await data.calibration()).toBeUndefined()
    expect(await data.importedDeviceLogIds()).toEqual(new Set())
    expect(await repository.profileRevisions()).toEqual([])
    expect(await repository.beanRevisions()).toEqual([])
    expect(await repository.meta('lastExportedAt')).toBeUndefined()
    expect(await repository.meta('deviceAdoptionDismissed')).toBe(true)
    expect(await repository.meta('seeded')).toBe(true)
    data.finishDeviceRestore()
  })

  it('quiesces an admitted refresh before restore and blocks ordinary refresh until reconciliation', async () => {
    const { data, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('before', 'Before')], []), 1)
    await data.attach(controller)

    let started!: () => void
    let release!: () => void
    const readsStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const readsGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalRead = controller.readDocument.bind(controller)
    let heldReads = 0
    let activeReads = 0
    let maxActiveReads = 0
    const readSpy = vi.spyOn(controller, 'readDocument').mockImplementation(async (target) => {
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      const answer = await originalRead(target)
      heldReads += 1
      if (heldReads === 1) started()
      await readsGate
      activeReads -= 1
      return answer
    })

    const admitted = data.refresh()
    await readsStarted
    let began = false
    const beginning = data.beginDeviceRestore().then(() => {
      began = true
    })
    await Promise.resolve()
    expect(began).toBe(false)

    release()
    await admitted
    await beginning
    expect(readSpy).toHaveBeenCalledTimes(4)
    expect(maxActiveReads).toBe(1)
    await expect(data.refresh()).rejects.toThrow(/restore owns the roaster library/)

    data.deviceFormatConfirmed()
    controller.documents.clear()
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('final', 'Final')], []), 1)
    await data.resetAfterDeviceFormat()
    readSpy.mockRestore()
    await data.reconcileDeviceRestore()
    expect((await data.profiles()).map((row) => row.id)).toEqual(['final'])
    data.finishDeviceRestore()
  })

  it('keeps the library locked when post-format durable invalidation fails', async () => {
    const { data, repository } = await fresh()
    await data.attach(new FakeController())
    await data.beginDeviceRestore()
    data.deviceFormatConfirmed()
    const clear = vi.spyOn(repository, 'clearDeviceLibraryMirror').mockRejectedValueOnce(new Error('IndexedDB failed'))

    await expect(data.resetAfterDeviceFormat()).rejects.toThrow('IndexedDB failed')
    expect(data.finishDeviceRestore()).toBe(false)
    await expect(data.refresh()).rejects.toThrow(/restore owns/)
    await expect(data.saveBean(bean('blocked', 'Blocked'))).rejects.toThrow(/restore is still in progress/)
    clear.mockRestore()
  })
  it('refuses to begin while a cache write is between IndexedDB and enqueue', async () => {
    const { data, repository } = await fresh()
    const controller = new FakeController()
    await data.attach(controller)

    let entered!: () => void
    let release!: () => void
    const cacheEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const cacheGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalSave = repository.saveBean.bind(repository)
    const saveSpy = vi.spyOn(repository, 'saveBean').mockImplementation(async (value) => {
      entered()
      await cacheGate
      await originalSave(value)
    })

    const saving = data.saveBean(bean('b-1', 'In flight'))
    await cacheEntered
    await expect(data.beginDeviceRestore()).rejects.toThrow('unsaved changes')
    release()
    await saving
    saveSpy.mockRestore()
    expect(controller.documents.has('beans')).toBe(true)
  })

  it('refuses cache mutations throughout restore and accepts them again after unlock', async () => {
    const { data, repository } = await fresh()
    const controller = new FakeController()
    await data.attach(controller)

    await data.beginDeviceRestore()
    await expect(data.saveBean(bean('blocked', 'Too soon'))).rejects.toThrow('restore is still in progress')
    expect(await repository.beans()).toEqual([])
    data.finishDeviceRestore()

    await data.saveBean(bean('after', 'After restore'))
    expect((await repository.beans()).map((row) => row.id)).toEqual(['after'])
  })

  it('clears equal-numbered run versions after format and reads the restored document before unlock', async () => {
    const { data, repository, serializer } = await fresh()
    const controller = new FakeController()
    controller.seed('runs/r-1', serializer.serializeRunDocument(roast('r-1', { name: 'Before restore' })), 1)
    await data.attach(controller)

    await data.beginDeviceRestore()
    data.deviceFormatConfirmed()
    controller.documents.clear()
    controller.seed('runs/r-1', serializer.serializeRunDocument(roast('r-1', { name: 'From backup' })), 1)
    await data.resetAfterDeviceFormat()
    await data.reconcileDeviceRestore()
    expect((await data.runs()).find((run) => run.id === 'r-1')?.name).toBe('From backup')
    expect(await repository.meta<Record<string, number>>('deviceRunVersions')).toEqual({ 'r-1': 1 })
    data.finishDeviceRestore()
  })

  it('preserves a queued durable edit when restore is refused before format', async () => {
    const { data, repository } = await fresh()
    const controller = new FakeController()
    await data.attach(controller)
    controller.busy = true
    await data.saveBean(bean('b-1', 'Waiting lot'))

    await expect(data.beginDeviceRestore()).rejects.toThrow('unsaved changes')
    expect(data.syncState().queued).toBe(1)
    expect(await repository.meta<Record<string, unknown>>('deviceOutbox')).toHaveProperty('beans')
  })
})

describe('the whole-library export stamp', () => {
  it('records when the library was last exported, on the controller and in the cache', async () => {
    const { data, serializer } = await fresh()
    const client = new FakeController()
    await data.attach(client)
    expect(data.syncState().lastExportedAt).toBeUndefined()

    await data.markExported('2026-07-28T10:00:00.000Z')
    expect(data.syncState().lastExportedAt).toBe('2026-07-28T10:00:00.000Z')
    // It travels in `meta`, so a phone learns that the laptop made a backup.
    const stored = client.documents.get('meta')
    expect(serializer.parseMetaDocument(stored?.payload ?? '{}').lastExportedAt).toBe('2026-07-28T10:00:00.000Z')
  })
})

describe('revisioned controller convergence', () => {
  it('commits only a stable complete manifest and records exact currency', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    controller.pageSize = 1
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('p-1', 'Device profile')], []), 4)
    controller.seed('runs/r-1', serializer.serializeRunDocument(roast('r-1')), 2)
    controller.seed('runs/r-2', serializer.serializeRunDocument(roast('r-2')), 3)

    await data.attach(controller)

    expect((await data.profiles()).map((row) => row.id)).toEqual(['p-1'])
    expect((await data.runs()).map((row) => row.id).sort()).toEqual(['r-1', 'r-2'])
    expect(data.syncState()).toMatchObject({
      health: 'current',
      deviceStateRev: '1',
      mirrorStateRev: '1',
      deviceBootId: 'boot-1',
      offline: false,
    })
  })

  it('coalesces a revision signal into automatic changed-only reconciliation', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    controller.seed('beans', serializer.serializeBeansDocument([bean('b-1', 'Before')], []), 1)
    await data.attach(controller)
    controller.reads = []

    controller.seed('beans', serializer.serializeBeansDocument([bean('b-1', 'After')], []), 2)
    controller.bump()
    data.observeRevision({ connected: true, bootId: controller.bootId, stateRev: String(controller.stateRev) })

    await vi.waitFor(() => expect(data.syncState().health).toBe('current'))
    expect((await data.beans()).map((row) => row.name)).toEqual(['After'])
    expect(controller.reads).toEqual(['beans'])
    expect(data.syncState().mirrorStateRev).toBe('2')
  })

  it('defers revision reconciliation during recording and runs it once on the idle edge', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    controller.seed('beans', serializer.serializeBeansDocument([bean('b-1', 'Before')], []), 1)
    await data.attach(controller)
    controller.reads = []

    controller.seed('beans', serializer.serializeBeansDocument([bean('b-1', 'After')], []), 2)
    controller.bump()
    data.observeRevision({
      connected: true,
      bootId: controller.bootId,
      stateRev: String(controller.stateRev),
      active: true,
    })
    // The first idle frame still owes its coalesced full-status acceptance, so catalog work remains deferred.
    data.observeRevision({
      connected: true,
      bootId: controller.bootId,
      stateRev: String(controller.stateRev),
      active: true,
    })
    await Promise.resolve()
    expect(controller.reads).toEqual([])
    expect(data.syncState()).toMatchObject({ health: 'syncing', deviceStateRev: '2', mirrorStateRev: '1' })

    data.observeRevision({
      connected: true,
      bootId: controller.bootId,
      stateRev: String(controller.stateRev),
      active: false,
    })
    await vi.waitFor(() => expect(data.syncState().health).toBe('current'))
    expect(controller.reads).toEqual(['beans'])
    expect((await data.beans()).map((row) => row.name)).toEqual(['After'])
  })
  it('waits a save behind a healthy revision catch-up instead of flashing a retry error', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    controller.seed('beans', serializer.serializeBeansDocument([bean('b-1', 'Before')], []), 1)
    await data.attach(controller)

    controller.seed('beans', serializer.serializeBeansDocument([bean('b-1', 'Changed elsewhere')], []), 2)
    controller.bump()
    data.observeRevision({ connected: true, bootId: controller.bootId, stateRev: String(controller.stateRev) })
    expect(data.syncState().health).toBe('syncing')
    expect(data.mutationBlockedReason()).toMatch(/finish syncing/i)
    expect(data.visibleMutationBlockedReason()).toBeUndefined()

    await expect(data.saveBean(bean('b-2', 'My new lot'))).resolves.toBeUndefined()
    expect(
      serializer.parseBeansDocument(controller.documents.get('beans')?.payload ?? '{}').beans.map((row) => row.id),
    ).toEqual(['b-2', 'b-1'])
  })

  it('does not touch the cache or device when catalog currency is not current', async () => {
    const { data, repository } = await fresh()
    const controller = new RevisionController()
    await data.attach(controller)
    data.observeRevision({ connected: false })

    await expect(data.saveBean(bean('blocked', 'Blocked'))).rejects.toThrow(/not connected|sync/i)
    expect(await repository.beans()).toEqual([])
    expect(controller.documents.has('beans')).toBe(false)
  })

  it('promotes an exact acknowledged save without post-ack manifest or document reads', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    await data.attach(controller)
    controller.manifestReads = 0
    controller.reads = []

    await data.saveBean(bean('b-2', 'Committed'))

    expect(
      serializer.parseBeansDocument(controller.documents.get('beans')?.payload ?? '{}').beans.map((row) => row.id),
    ).toEqual(['b-2'])
    expect(data.syncState()).toMatchObject({ health: 'current', deviceStateRev: '2', mirrorStateRev: '2' })
    expect(controller.manifestReads).toBe(0)
    expect(controller.reads).toEqual([])
  })

  it('fully reconciles when the acknowledged revision reveals an external revision edge', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('p-1', 'Before')], []), 1)
    await data.attach(controller)
    controller.manifestReads = 0
    controller.reads = []

    // A different document changed without a live revision signal reaching this browser. The bean
    // write still passes its own version check, but its acknowledgement jumps by two revisions.
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('p-1', 'Changed elsewhere')], []), 2)
    controller.bump()
    await data.saveBean(bean('b-2', 'Committed'))

    expect(controller.manifestReads).toBeGreaterThan(0)
    expect(controller.reads).toContain('profiles')
    expect((await data.profiles()).map((row) => row.name)).toEqual(['Changed elsewhere'])
    expect(data.syncState()).toMatchObject({ health: 'current', deviceStateRev: '3', mirrorStateRev: '3' })
  })

  it('records UTF-8 run bytes without post-ack reads on an exact successor', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    await data.attach(controller)
    controller.manifestReads = 0
    controller.reads = []
    const unicodeRun = roast('unicode-run', { notes: 'Café ☕ — 東京' })

    await data.saveRun(unicodeRun)

    const payload = controller.documents.get('runs/unicode-run')?.payload ?? ''
    expect(data.syncState().runBytes['unicode-run']).toBe(serializer.byteLength(payload))
    expect(controller.manifestReads).toBe(0)
    expect(controller.reads).toEqual([])
  })

  it('removes run byte accounting without post-ack reads on an exact-successor delete', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    controller.seed('runs/unicode-run', serializer.serializeRunDocument(roast('unicode-run', { notes: 'Café ☕' })), 1)
    await data.attach(controller)
    controller.manifestReads = 0
    controller.reads = []

    await data.deleteRun('unicode-run')

    expect(data.syncState().runBytes).not.toHaveProperty('unicode-run')
    expect(controller.manifestReads).toBe(0)
    expect(controller.reads).toEqual([])
  })

  it('promotes the firmware revision wrap from uint64 max to one', async () => {
    const { data } = await fresh()
    const controller = new RevisionController()
    controller.stateRev = 18446744073709551615n
    await data.attach(controller)
    controller.manifestReads = 0
    controller.reads = []

    await data.saveBean(bean('wrapped', 'Wrapped'))

    expect(data.syncState()).toMatchObject({ health: 'current', deviceStateRev: '1', mirrorStateRev: '1' })
    expect(controller.manifestReads).toBe(0)
    expect(controller.reads).toEqual([])
  })

  it.each(['malformed', '18446744073709551616'])(
    'fully reconciles an invalid acknowledged controller revision %s',
    async (invalidRevision) => {
      const { data } = await fresh()
      const controller = new RevisionController()
      await data.attach(controller)
      controller.manifestReads = 0
      const write = controller.writeDocument.bind(controller)
      controller.writeDocument = async (target, payload, base) => {
        const result = await write(target, payload, base)
        if (result.kind !== 'ok') return result
        return { ...result, stateRev: invalidRevision }
      }

      await data.saveBean(bean('b-2', 'Committed'))

      expect(controller.manifestReads).toBeGreaterThan(0)
      expect(data.syncState()).toMatchObject({ health: 'current', deviceStateRev: '2', mirrorStateRev: '2' })
    },
  )

  it('fully reconciles when a successful write omits its controller revision', async () => {
    const { data } = await fresh()
    const controller = new RevisionController()
    await data.attach(controller)
    controller.manifestReads = 0
    const write = controller.writeDocument.bind(controller)
    controller.writeDocument = async (target, payload, base) => {
      const result = await write(target, payload, base)
      if (result.kind !== 'ok') return result
      return { kind: 'ok', version: result.version }
    }

    await data.saveBean(bean('b-2', 'Committed'))

    expect(controller.manifestReads).toBeGreaterThan(0)
    expect(data.syncState()).toMatchObject({ health: 'current', deviceStateRev: '2', mirrorStateRev: '2' })
  })
})

/*
 * On a version conflict the revisioned path replays the mutation onto the
 * refetched library. For a whole-record save that replay would write this browser's full copy over
 * another browser's edit to the SAME record and report success; archive reconciliation, built from a
 * snapshot taken before a multi-second pass, could likewise erase an edit made during the pass.
 */
class RivalRevisionController extends RevisionController {
  override async writeDocument(target: DocumentTarget, payload: string, base: number): Promise<DocumentWrite> {
    const hadRival = this.rival?.target === target
    const result = await super.writeDocument(target, payload, base)
    // The rival's write is itself a device change, so the manifest must advance for the refetch.
    if (hadRival) this.bump()
    return result
  }
}

describe('whole-record saves never replay over the same record changed elsewhere', () => {
  it('refuses a profile save when another browser changed that profile', async () => {
    const { data, serializer } = await fresh()
    const controller = new RivalRevisionController()
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('p1', 'Original')], []))
    await data.attach(controller)
    controller.rival = {
      target: 'profiles',
      payload: serializer.serializeProfilesDocument([profile('p1', 'Renamed on the phone')], []),
    }

    await expect(data.saveProfile({ ...profile('p1', 'Original'), notes: 'edited here' })).rejects.toThrow(
      /Another browser changed this/,
    )
    const stored = serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload)
    expect(stored.profiles.find((item) => item.id === 'p1')?.name).toBe('Renamed on the phone')
  })

  it('still merges a save when the other browser changed a different profile', async () => {
    const { data, serializer } = await fresh()
    const controller = new RivalRevisionController()
    controller.seed('profiles', serializer.serializeProfilesDocument([profile('p1', 'One'), profile('p2', 'Two')], []))
    await data.attach(controller)
    controller.rival = {
      target: 'profiles',
      payload: serializer.serializeProfilesDocument(
        [profile('p1', 'One'), profile('p2', 'Two, renamed elsewhere')],
        [],
      ),
    }

    await data.saveProfile({ ...profile('p1', 'One'), notes: 'edited here' })
    const stored = serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload).profiles
    expect(stored.find((item) => item.id === 'p1')?.notes).toBe('edited here')
    expect(stored.find((item) => item.id === 'p2')?.name).toBe('Two, renamed elsewhere')
  })
})

describe('archive reconciliation rebases onto edits made during the pass', () => {
  it('keeps a score, notes, and final weight saved after the pass took its snapshot', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    const staged = roast('run-1', {
      notes: '',
      outcome: 'running',
      measurements: { startingMassG: 230, startingVolumeMl: 350 },
    })
    controller.seed('runs/run-1', serializer.serializeRunDocument(staged))
    await data.attach(controller)
    const basis = (await data.runs()).find((run) => run.id === 'run-1')!

    // The user edits while the pass is fetching recordings.
    await data.updateRun('run-1', {
      score: 8,
      notes: 'sweet, heavy body',
      measurements: { startingMassG: 230, startingVolumeMl: 350, finalMassG: 196 },
    })

    // The pass then writes the record it built from `basis`: completed, header mass 225 g wins.
    const completed: RoastRun = {
      ...basis,
      outcome: 'complete',
      notes: '',
      measurements: { startingMassG: 225, startingVolumeMl: 350 },
      samples: [],
    }
    const written = await data.saveReconciledRun(completed, basis)

    expect(written.outcome).toBe('complete')
    expect(written.score).toBe(8)
    expect(written.notes).toBe('sweet, heavy body')
    expect(written.measurements).toMatchObject({ startingMassG: 225, startingVolumeMl: 350, finalMassG: 196 })
    const stored = serializer.parseRunDocument(controller.documents.get('runs/run-1')!.payload)
    expect(stored.score).toBe(8)
    expect(stored.measurements?.finalMassG).toBe(196)
  })

  it('writes the reconstruction unchanged when nothing moved since the snapshot', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    controller.seed('runs/run-2', serializer.serializeRunDocument(roast('run-2', { outcome: 'running' })))
    await data.attach(controller)
    const basis = (await data.runs()).find((run) => run.id === 'run-2')!
    const completed: RoastRun = { ...basis, outcome: 'complete', notes: 'reconstructed' }
    expect(await data.saveReconciledRun(completed, basis)).toEqual(completed)
  })
})

describe('hydrated samples survive a library reload during hydration', () => {
  it('keeps calibration evidence samples when the working copy is replaced mid-download', async () => {
    // The manifest is re-read on revision signals while recordings download. Hydration that wrote
    // into the working copy captured when it began would write into an orphan after the reload, so
    // every calibration pass would show "samples loading" forever and no calibration could be built.
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    const recorded: CalibrationRun = {
      id: 'calibration-11',
      capturedAt: '2026-07-30T18:32:29.758Z',
      recordedOn,
      sourceLogId: '11',
      sourceMode: 'calibration',
      form: 'grid',
      steps: [{ fan: 1, heat: 1 }],
      maxStepSeconds: 300,
      minStepSeconds: 20,
      settleSeconds: 20,
      settleBandC: 0.2,
      samples: [],
      notes: '',
    }
    controller.seed('calibrations', serializer.serializeCalibrationsDocument(undefined, [], [recorded]))
    controller.seed('beans', serializer.serializeBeansDocument([bean('b1', 'Before')], []))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const csv = 't_ms,thermocouple_c,cold_junction_c,fan,heat\n0,49.0,22.1,1.0,1.0\n1000,52.5,22.2,1.0,1.0\n'
    const hydrate = vi.fn(async () => {
      await gate
      return { kind: 'ok' as const, samples: parseThermalCsv(csv) }
    })
    const attached = data.attach(controller, hydrate)

    // While the recording is still downloading, another change on the roaster reloads the library.
    for (let i = 0; i < 50 && hydrate.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    controller.seed('beans', serializer.serializeBeansDocument([bean('b1', 'After')], []), 2)
    controller.bump()
    data.observeRevision({ connected: true, stateRev: String(controller.stateRev), active: false })
    for (let i = 0; i < 100 && (await data.beans())[0]?.name !== 'After'; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect((await data.beans())[0]?.name).toBe('After')

    release()
    await attached
    for (let i = 0; i < 100 && (await data.calibrationRuns())[0].samples.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    const [run] = await data.calibrationRuns()
    expect(run.samples).toHaveLength(2)
    expect(controller.writes.filter((write) => write.target === 'calibrations')).toEqual([])
  })
})

describe('default profiles on a new roaster', () => {
  const defaults = async () => {
    const { defaultProfiles, defaultProfileRevisions } = await import('../domain/defaultProfiles')
    const profiles = defaultProfiles('2026-10-19T12:00:00.000Z')
    return { profiles, revisions: defaultProfileRevisions(profiles, '2026-10-19T12:00:00.000Z') }
  }

  it('installs both, journey first, into a library that never held a profiles document', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    await data.attach(controller)
    expect(data.profilesDocumentAbsent()).toBe(true)

    const { profiles, revisions } = await defaults()
    expect(await data.installDefaultProfiles(profiles, revisions)).toBe(true)
    const stored = serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload)
    expect(stored.profiles.map((row) => row.name)).toEqual(['Espresso Express', 'Espresso Express (timed)'])
    expect((await data.profiles()).map((row) => row.name)).toEqual(['Espresso Express', 'Espresso Express (timed)'])

    expect(data.profilesDocumentAbsent()).toBe(false)
    controller.writes = []
    expect(await data.installDefaultProfiles(profiles, revisions)).toBe(false)
    expect(controller.writes).toEqual([])
  })

  it('never reinstalls into a library whose profiles were all deleted', async () => {
    const { data, serializer } = await fresh()
    const controller = new RevisionController()
    controller.seed('profiles', serializer.serializeProfilesDocument([], []), 3)
    await data.attach(controller)

    const { profiles, revisions } = await defaults()
    expect(data.profilesDocumentAbsent()).toBe(false)
    expect(await data.installDefaultProfiles(profiles, revisions)).toBe(false)
    expect(controller.writes).toEqual([])
  })

  it('leaves one copy when another browser installs them first', async () => {
    const { data, serializer } = await fresh()
    const controller = new RivalRevisionController()
    await data.attach(controller)
    const { profiles, revisions } = await defaults()
    controller.rival = { target: 'profiles', payload: serializer.serializeProfilesDocument(profiles, revisions) }

    await expect(data.installDefaultProfiles(profiles, revisions)).rejects.toThrow(/Another browser changed this/)
    const stored = serializer.parseProfilesDocument(controller.documents.get('profiles')!.payload)
    expect(stored.profiles.map((row) => row.id)).toEqual(profiles.map((row) => row.id))
    expect(data.profilesDocumentAbsent()).toBe(false)
  })
})
