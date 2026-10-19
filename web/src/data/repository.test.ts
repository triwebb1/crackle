import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { collisionsById, mergeById, parseArchive } from '../domain/archive'
import { patchMatches } from '../domain/thermalLog'
import type { BeanLot, CalibrationRun, CalibrationSnapshot, Profile, ProfileRevision } from '../domain/types'
import { demoRuns, starterProfile } from './demo'
import { REVISION_CAP } from './repository'

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

const freshRepository = async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('localStorage', memoryStorage())
  vi.resetModules()
  return (await import('./repository')).repository
}

// Writes a version 3 database by hand so the version 4 upgrade path is exercised for real.
const seedVersion3 = (apply: (database: IDBDatabase) => Promise<void>) =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('crackle-v2', 3)
    request.onupgradeneeded = () => {
      const database = request.result
      for (const store of ['profiles', 'runs', 'beans']) database.createObjectStore(store, { keyPath: 'id' })
      database.createObjectStore('meta', { keyPath: 'key' })
    }
    request.onsuccess = () => {
      const database = request.result
      apply(database).then(
        () => {
          database.close()
          resolve()
        },
        (error) => {
          database.close()
          reject(error)
        },
      )
    }
    request.onerror = () => reject(request.error)
  })

const putInto = (database: IDBDatabase, store: string, value: unknown) =>
  new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, 'readwrite')
    transaction.objectStore(store).put(value)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })

// Opens at the repository's current version, so a version bump has to be reflected here too rather
// than silently failing with a VersionError.
const seedMarker = () =>
  new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('crackle-v4:same-origin', 7)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('meta', 'readonly')
      const read = transaction.objectStore('meta').get('seeded')
      transaction.oncomplete = () => {
        database.close()
        resolve(read.result)
      }
      transaction.onerror = () => {
        database.close()
        reject(transaction.error)
      }
    }
    request.onerror = () => reject(request.error)
  })

const bean = (id: string): BeanLot => ({
  id,
  name: id,
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
describe('crackle repository', () => {
  it('serializes queued writes and keeps the queue alive after a failed write', async () => {
    const repository = await freshRepository()
    const order: string[] = []
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => repository.saveBean(bean(id)).then(() => order.push(id))))
    expect(order).toEqual(['a', 'b', 'c', 'd'])

    await expect(repository.saveBean({ name: 'no id' } as unknown as BeanLot)).rejects.toBeTruthy()
    await repository.saveBean(bean('after-failure'))
    expect((await repository.beans()).map((item) => item.id).sort()).toEqual(['a', 'after-failure', 'b', 'c', 'd'])
  })

  it('seeds demo content once and performs no write-backs on a second initialize', async () => {
    const repository = await freshRepository()
    await repository.initialize()
    const seededWrites = repository.writeCount
    const profiles = await repository.profiles()
    const runs = await repository.runs()
    expect(seededWrites).toBeGreaterThan(0)
    expect(profiles.length).toBeGreaterThan(0)

    await repository.initialize()
    expect(repository.writeCount).toBe(seededWrites)
    expect(await repository.profiles()).toEqual(profiles)
    expect(await repository.runs()).toEqual(runs)
  })

  it('keeps the seed marker in the v4 mirror and ignores an obsolete localStorage marker', async () => {
    const seeded = await freshRepository()
    await seeded.initialize()
    expect(globalThis.localStorage.getItem('crackle:seeded:v2')).toBeNull()
    expect(await seedMarker()).toEqual({ key: 'seeded', value: true })

    const legacy = await freshRepository()
    globalThis.localStorage.setItem('crackle:seeded:v2', '1')
    await legacy.saveProfile({ ...starterProfile, id: 'user-profile' })
    await legacy.initialize()
    expect((await legacy.profiles()).map((profile) => profile.id)).toEqual(['user-profile'])
    expect(await seedMarker()).toEqual({ key: 'seeded', value: true })
  })

  it('reseeds when the marker claims a seed but every store is empty', async () => {
    const repository = await freshRepository()
    globalThis.localStorage.setItem('crackle:seeded:v2', '1')
    await repository.initialize()
    expect((await repository.profiles()).length).toBeGreaterThan(0)
    expect((await repository.runs()).length).toBeGreaterThan(0)
  })

  it('never duplicates journey segment ids while reseeding', async () => {
    const repository = await freshRepository()
    await repository.initialize()
    const intent = (await repository.profiles()).find((profile) => profile.id === 'intent-gentle-espresso')
    const segments = intent?.strategy === 'thermal-intent' ? intent.segments : []
    expect(segments).toHaveLength(5)
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(segments.length)
  })

  /**
   * 0.7.0 retired batch mass and explicit bean links from the profile. Normalization DROPS both
   * rather than migrating them, so a pre-0.7.0 archive loads cleanly and simply stops carrying
   * them - and, because dropping leaves nothing to drop a second time, `initialize` rewrites each
   * record exactly once instead of every time it runs.
   */
  it('drops the retired profile metadata, keeps every other key, and stays idempotent', async () => {
    const repository = await freshRepository()
    await repository.saveProfile({
      ...starterProfile,
      id: 'legacy-metadata',
      metadata: {
        intent: 'Medium',
        massG: 225,
        beanLotIds: ['bean-1'],
        roastLevel: 'city',
      } as unknown as Profile['metadata'],
    })
    const stored = (await repository.profiles()).find((profile) => profile.id === 'legacy-metadata')!
    const metadata = stored.metadata as unknown as Record<string, unknown>
    expect(metadata.massG).toBeUndefined()
    expect(metadata.beanLotIds).toBeUndefined()
    expect(metadata.intent).toBe('Medium')
    // An unknown key is still none of normalization's business.
    expect(metadata.roastLevel).toBe('city')

    await repository.initialize()
    const settled = repository.writeCount
    await repository.initialize()
    expect(repository.writeCount).toBe(settled)
  })

  it('recovers a bean lot from a legacy profile link once, before dropping the link', async () => {
    const repository = await freshRepository()
    const legacy = {
      ...structuredClone(demoRuns[0]),
      id: 'legacy-run',
      beanLotId: undefined,
      profile: { ...structuredClone(starterProfile), metadata: { intent: '', beanLotIds: ['bean-house-huila-2026'] } },
    } as unknown as Parameters<typeof repository.saveRun>[0]
    await repository.saveRun(legacy)
    const stored = (await repository.runs()).find((run) => run.id === 'legacy-run')!
    expect(stored.beanLotId).toBe('bean-house-huila-2026')
    expect((stored.profile.metadata as unknown as Record<string, unknown>).beanLotIds).toBeUndefined()
  })

  it('stores, normalizes, reloads, and deletes calibration runs through the write queue', async () => {
    const repository = await freshRepository()
    const run: CalibrationRun = {
      id: 'calibration-fan-5',
      capturedAt: '2026-07-26T10:00:00.000Z',
      recordedOn,
      form: 'grid',
      steps: [
        { fan: 5, heat: 1 },
        { fan: 5, heat: 3 },
        { fan: 5, heat: 5 },
        { fan: 5, heat: 7 },
      ],
      maxStepSeconds: 120,
      minStepSeconds: 20,
      settleSeconds: 5,
      settleBandC: 2,
      ceilingC: 320,
      advanceMarginC: 15,
      ambientC: 24.5,
      samples: [
        { tMs: 0, thermocoupleC: 24.75, coldJunctionC: 24.5, effectiveFan: 5, effectiveHeat: 0 },
        { tMs: 1000, thermocoupleC: undefined, coldJunctionC: undefined, effectiveFan: 5, effectiveHeat: 1 },
      ],
      notes: 'Empty chamber baseline',
    }
    const order: string[] = []
    await Promise.all([
      repository.saveCalibrationRun(run).then(() => order.push('first')),
      repository
        .saveCalibrationRun({ ...run, id: 'calibration-fan-8', steps: [{ fan: 8, heat: 5 }] })
        .then(() => order.push('second')),
    ])
    expect(order).toEqual(['first', 'second'])

    const stored = await repository.calibrationRuns()
    expect(stored.map((item) => item.id).sort()).toEqual(['calibration-fan-5', 'calibration-fan-8'])
    const reloaded = stored.find((item) => item.id === run.id)!
    expect(reloaded.samples[1].thermocoupleC).toBeUndefined()
    expect(reloaded.samples[0].thermocoupleC).toBe(24.75)
    // A baseline run keeps mass and density absent rather than collapsing them to 0.
    expect(reloaded.massG).toBeUndefined()
    expect(reloaded.densityGPerMl).toBeUndefined()

    const damaged = await repository.saveCalibrationRun({
      ...run,
      id: 'calibration-damaged',
      steps: [
        { fan: 3, heat: 1 },
        { fan: '5' as unknown as number, heat: 2 },
      ],
      maxStepSeconds: Number.NaN,
      minStepSeconds: Number.NaN,
      settleSeconds: Number.NaN,
      settleBandC: Number.NaN,
      advanceMarginC: Number.NaN,
      ceilingC: Number.NaN,
      form: 'nonsense' as CalibrationRun['form'],
      samples: undefined as unknown as CalibrationRun['samples'],
      notes: undefined as unknown as string,
    })
    expect(damaged).toBeUndefined()
    const repaired = (await repository.calibrationRuns()).find((item) => item.id === 'calibration-damaged')!
    expect(repaired).toMatchObject({
      steps: [{ fan: 3, heat: 1 }],
      form: 'steps',
      maxStepSeconds: 120,
      minStepSeconds: 20,
      settleSeconds: 5,
      settleBandC: 2,
      samples: [],
      notes: '',
    })
    // A pass with no usable ceiling keeps none: firmware 2026-07-26.34 and later have no program ceiling.
    expect(repaired.ceilingC).toBeUndefined()
    expect(repaired.advanceMarginC).toBeUndefined()

    await repository.deleteCalibrationRun('calibration-fan-8')
    expect((await repository.calibrationRuns()).map((item) => item.id).sort()).toEqual([
      'calibration-damaged',
      'calibration-fan-5',
    ])
  })

  it('rejects a pre-provenance calibration pass instead of guessing its source', async () => {
    const repository = await freshRepository()
    const preProvenance = {
      id: 'legacy-calibration',
      capturedAt: '2026-07-26T09:00:00.000Z',
      fanLevel: 5,
      heatSteps: [1, 3, 5, 7],
      stepSeconds: 60,
      samples: [],
      notes: 'old dev data',
    } as unknown as CalibrationRun
    await expect(repository.saveCalibrationRun(preProvenance)).rejects.toThrow(/Missing required recording provenance/)
    expect(await repository.calibrationRuns()).toEqual([])
  })
  it('opens a clean v4 mirror instead of guessing provenance for an obsolete database', async () => {
    const repository = await freshRepository()
    await seedVersion3(async (database) => {
      await putInto(database, 'profiles', { ...starterProfile, id: 'legacy-profile' })
      await putInto(database, 'beans', bean('legacy-bean'))
      await putInto(database, 'meta', { key: 'seeded', value: true })
    })

    expect(await repository.profiles()).toEqual([])
    expect(await repository.beans()).toEqual([])
    await repository.saveCalibrationRun({
      id: 'current-pass',
      capturedAt: '2026-07-26T11:00:00.000Z',
      recordedOn,
      form: 'steps',
      steps: [{ fan: 3, heat: 2 }],
      maxStepSeconds: 120,
      minStepSeconds: 20,
      settleSeconds: 5,
      settleBandC: 2,
      ceilingC: 200,
      advanceMarginC: 15,
      samples: [],
      notes: '',
    })
    expect((await repository.calibrationRuns()).map((item) => item.id)).toEqual(['current-pass'])
  })
  it('stores, normalizes, and deletes named calibrations, rejecting unknown coefficient keys', async () => {
    const repository = await freshRepository()
    const snapshot: CalibrationSnapshot = {
      id: 'calibration-july',
      name: '  July baseline  ',
      createdAt: '2026-07-26T12:00:00.000Z',
      recordedOn,
      runIds: ['calibration-fan-5', '', 7 as unknown as string],
      ambientC: 24.5,
      patch: {
        heaterGainCPerMinAt10: 41.2,
        thermalLossPerMinPerC: 0.021,
        nominalHalfCycleUs: 8333,
      } as CalibrationSnapshot['patch'],
      curves: [
        {
          fanLevel: 9,
          points: [
            { heat: 1, steadyStateC: 62.5, tauSec: 44, extrapolated: false },
            { heat: 10, steadyStateC: 288.1, tauSec: 71, extrapolated: true, r2: 0.997 },
            { heat: Number.NaN, steadyStateC: 10, extrapolated: false },
          ],
        },
      ],
    }
    await repository.saveCalibrationSnapshot(snapshot)
    const [stored] = await repository.calibrationSnapshots()
    expect(stored.name).toBe('July baseline')
    expect(stored.runIds).toEqual(['calibration-fan-5'])
    // Only the four thermal coefficients survive: a restore must never write an unknown key
    // into the locked calibration record.
    expect(stored.patch).toEqual({ heaterGainCPerMinAt10: 41.2, thermalLossPerMinPerC: 0.021 })
    expect(stored.curves[0].points).toHaveLength(2)
    expect(stored.curves[0].points[1]).toMatchObject({ heat: 10, extrapolated: true, r2: 0.997 })

    // Restoring is a staging action, so the round trip that matters is patch in, patch out.
    expect(patchMatches(stored.patch, { heaterGainCPerMinAt10: 41.2, thermalLossPerMinPerC: 0.021 })).toBe(true)
    expect(patchMatches(stored.patch, { heaterGainCPerMinAt10: 39, thermalLossPerMinPerC: 0.018 })).toBe(false)

    await repository.saveCalibrationSnapshot({
      ...snapshot,
      id: 'calibration-blank',
      name: '   ',
      curves: undefined as unknown as CalibrationSnapshot['curves'],
    })
    expect((await repository.calibrationSnapshots()).find((item) => item.id === 'calibration-blank')).toMatchObject({
      name: 'Unnamed calibration',
      curves: [],
    })

    await repository.deleteCalibrationSnapshot('calibration-blank')
    expect((await repository.calibrationSnapshots()).map((item) => item.id)).toEqual(['calibration-july'])

    // A second initialize must not rewrite an already-normal snapshot.
    await repository.initialize()
    const settled = repository.writeCount
    await repository.initialize()
    expect(repository.writeCount).toBe(settled)
  })

  it('stores catalog edit history newest first, capped per subject, through the write queue', async () => {
    const repository = await freshRepository()
    const revision = (index: number) => ({
      id: `profile-revision-${index}`,
      profileId: 'profile-house-espresso',
      revision: index,
      savedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      summary: `Heat step 3: 5.0->${(5 + index / 10).toFixed(1)}`,
      profile: { ...starterProfile, revision: index },
    })
    const order: string[] = []
    await Promise.all(
      [1, 2, 3].map((index) => repository.saveProfileRevision(revision(index)).then(() => order.push(`r${index}`))),
    )
    expect(order).toEqual(['r1', 'r2', 'r3'])

    const stored = await repository.profileRevisions()
    expect(stored.map((item) => item.revision)).toEqual([3, 2, 1])
    expect(stored[0].summary).toBe('Heat step 3: 5.0->5.3')
    // The full record travels with the summary, so a revision stays restorable later.
    expect(stored[0].profile.id).toBe(starterProfile.id)

    const damaged = await repository.saveProfileRevision({
      id: 'broken',
      profileId: '',
      revision: Number.NaN,
      savedAt: '',
      summary: '  ',
      profile: starterProfile,
    } as ProfileRevision)
    expect(damaged).toBeUndefined()
    const repaired = (await repository.profileRevisions()).find((item) => item.id === 'broken')!
    expect(repaired).toMatchObject({ profileId: starterProfile.id, revision: 1, summary: 'Saved' })

    // A different profile's history is never trimmed to make room for this one.
    await repository.saveProfileRevision({ ...revision(1), id: 'other-1', profileId: 'other-profile' })
    for (let index = 4; index <= REVISION_CAP + 4; index += 1) await repository.saveProfileRevision(revision(index))
    const capped = await repository.profileRevisions()
    expect(capped.filter((item) => item.profileId === 'profile-house-espresso')).toHaveLength(REVISION_CAP)
    expect(capped.filter((item) => item.profileId === 'other-profile')).toHaveLength(1)
    // The newest survive, not the oldest.
    expect(capped[0].revision).toBe(REVISION_CAP + 4)

    await repository.saveBeanRevision({
      id: 'bean-revision-1',
      beanId: 'bean-a',
      savedAt: '2026-02-01T00:00:00.000Z',
      summary: 'Changed notes',
      bean: bean('bean-a'),
    })
    await repository.saveBeanRevision({
      id: 'bean-revision-2',
      beanId: 'bean-b',
      savedAt: '2026-02-02T00:00:00.000Z',
      summary: 'Created',
      bean: bean('bean-b'),
    })
    expect((await repository.beanRevisions()).map((item) => item.beanId)).toEqual(['bean-b', 'bean-a'])
    // Deleting a lot takes its history with it, and leaves every other lot's history alone.
    await repository.deleteBeanRevisions('bean-a')
    expect((await repository.beanRevisions()).map((item) => item.id)).toEqual(['bean-revision-2'])
  })

  it('binds a configured-target mirror to one observed roaster identity', async () => {
    const repository = await freshRepository()
    await expect(repository.bindObservedDevice('device-a')).resolves.toBeUndefined()
    await expect(repository.bindObservedDevice('device-a')).resolves.toBeUndefined()
    await expect(repository.observedDeviceBinding()).resolves.toBe('device-a')
    await expect(repository.bindObservedDevice('device-b')).rejects.toThrow(/bound to device-a.*reported device-b/i)
  })
  it('never reaches for the rich dev dataset on its own, and stores it correctly when asked', async () => {
    const repository = await freshRepository()
    await repository.initialize()
    // `richSeedEnabled` is false under the test runner, so initialize seeded the shipped demo only.
    expect((await repository.profiles()).map((profile) => profile.id).sort()).toEqual([
      'intent-gentle-espresso',
      'profile-house-espresso',
    ])
    expect(await repository.profileRevisions()).toEqual([])

    // Forced, as the dev server would: every store fills, and every reference in it resolves.
    await repository.resetDemoData(true)
    const [profiles, beans, runs, profileRevisions, beanRevisions, manualEvents, calibrationRuns, snapshots] =
      await Promise.all([
        repository.profiles(),
        repository.beans(),
        repository.runs(),
        repository.profileRevisions(),
        repository.beanRevisions(),
        repository.manualEvents(),
        repository.calibrationRuns(),
        repository.calibrationSnapshots(),
      ])
    expect(profiles.length).toBeGreaterThanOrEqual(4)
    expect(beans.length).toBeGreaterThanOrEqual(5)
    expect(runs.length).toBeGreaterThanOrEqual(6)
    expect(profileRevisions.length).toBeGreaterThanOrEqual(8)
    expect(beanRevisions.length).toBeGreaterThanOrEqual(3)
    expect(manualEvents.length).toBeGreaterThanOrEqual(8)
    // Two chamber passes and five loaded roast recordings: the Loaded roasts picker on Calibrate is
    // only reviewable when it holds a list rather than a single unnamed candidate.
    expect(calibrationRuns).toHaveLength(7)
    expect(calibrationRuns.filter((entry) => (entry.massG ?? 0) > 0)).toHaveLength(5)
    expect(snapshots).toHaveLength(3)

    const beanIds = new Set(beans.map((item) => item.id))
    const profileIds = new Set(profiles.map((item) => item.id))
    for (const run of runs) expect(beanIds.has(run.beanLotId ?? '')).toBe(true)
    for (const revision of profileRevisions) expect(profileIds.has(revision.profileId)).toBe(true)
    for (const revision of beanRevisions) expect(beanIds.has(revision.beanId)).toBe(true)
    // The applied thermal model comes from the LOADED characterization roast, which is the path a
    // real user walks; the two chamber passes are saved but not applied.
    const calibration = (await repository.calibration())!
    const fitted = snapshots.find((snapshot) => snapshot.name.includes('Loaded characterization'))!
    expect(patchMatches(fitted.patch, calibration as unknown as Record<string, number | undefined>)).toBe(true)
    // Nothing survives a reset except what the reset wrote.
    await repository.resetDemoData(true)
    expect((await repository.profiles()).length).toBe(profiles.length)
    expect((await repository.calibrationRuns()).length).toBe(7)
  })

  it('validates an exported archive and merges it by id', async () => {
    const repository = await freshRepository()
    await repository.initialize()
    const runs = await repository.runs()

    expect(() => parseArchive('not json')).toThrow(/valid JSON/)
    expect(() => parseArchive(JSON.stringify({ format: 'other', version: 1, runs: [] }))).toThrow(
      /Crackle history or profile export/,
    )
    expect(() => parseArchive(JSON.stringify({ format: 'crackle-history', version: 9, runs: [] }))).toThrow(
      /archive version/,
    )
    expect(() =>
      parseArchive(JSON.stringify({ format: 'crackle-history', version: 1, runs: [{ id: 'broken' }] })),
    ).toThrow(/cannot read/)

    const archive = parseArchive(
      JSON.stringify({
        format: 'crackle-history',
        version: 1,
        runs: [
          { ...runs[0], id: 'imported-run', name: 'Imported' },
          { ...runs[1], name: 'Renamed' },
        ],
      }),
    )
    expect(archive.runs).toHaveLength(2)
    expect(collisionsById(runs, archive.runs)).toHaveLength(1)

    const appended = mergeById(runs, archive.runs, false)
    expect(appended.added).toHaveLength(1)
    expect(appended.replaced).toHaveLength(0)
    expect(appended.merged.find((run) => run.id === runs[1].id)?.name).toBe(runs[1].name)

    const replacing = mergeById(runs, archive.runs, true)
    expect(replacing.replaced).toHaveLength(1)
    await Promise.all([...replacing.added, ...replacing.replaced].map((run) => repository.saveRun(run)))
    const persisted = await repository.runs()
    expect(persisted.find((run) => run.id === 'imported-run')?.name).toBe('Imported')
    expect(persisted.find((run) => run.id === runs[1].id)?.name).toBe('Renamed')
  })
})

/**
 * The ledger of controller recordings already considered.
 *
 * It is deliberately NOT derived from the stored runs. A run imported from a recording can be
 * deleted, and a derived ledger would resurrect it on the next visit to History. The ledger says
 * "this browser has dealt with recording N", which stays true after the roast is thrown away.
 */
describe('imported device-roast bookkeeping', () => {
  it('starts empty and remembers what has been imported', async () => {
    const repository = await freshRepository()
    await repository.initialize()
    expect([...(await repository.importedDeviceLogIds())]).toEqual([])

    await repository.markDeviceLogsImported(['41', '43'])
    expect([...(await repository.importedDeviceLogIds())].sort()).toEqual(['41', '43'])
  })

  it('is additive and idempotent, so a retry cannot corrupt it', async () => {
    const repository = await freshRepository()
    await repository.initialize()
    await repository.markDeviceLogsImported(['41'])
    await repository.markDeviceLogsImported(['41', '42'])
    await repository.markDeviceLogsImported([])
    expect([...(await repository.importedDeviceLogIds())].sort()).toEqual(['41', '42'])
  })

  it('survives a deleted run, which is the whole reason it is not derived from the runs', async () => {
    const repository = await freshRepository()
    await repository.initialize()
    await repository.saveRun({ ...demoRuns[0], id: 'device-roast-41' })
    await repository.markDeviceLogsImported(['41'])
    await repository.deleteRun('device-roast-41')
    expect((await repository.runs()).some((run) => run.id === 'device-roast-41')).toBe(false)
    expect([...(await repository.importedDeviceLogIds())]).toEqual(['41'])
  })
})
