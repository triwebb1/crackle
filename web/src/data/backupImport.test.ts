import { describe, expect, it } from 'vitest'
import { recordingKey } from '../domain/provenance'
import type {
  BeanLot,
  BeanRevision,
  CalibrationSnapshot,
  Profile,
  ProfileRevision,
  RoastRun,
  TelemetrySample,
} from '../domain/types'
import {
  BACKUP_TYPES,
  type BackupSource,
  type BackupType,
  buildBackup,
  collectionsForTypes,
  parseBackup,
} from './backupFile'
import {
  backupLibrary,
  emptyLibrary,
  type ImportInput,
  importChanges,
  type LibrarySnapshot,
  planImport,
  stableJson,
} from './backupImport'
import {
  serializeBeansDocument,
  serializeCalibrationsDocument,
  serializeMetaDocument,
  serializeProfilesDocument,
  serializeRunDocument,
} from './documentSerializer'

/**
 * ============================================================================================
 * ONE QUESTION, ASKED ONCE, ABOUT THE THINGS THAT ACTUALLY DIFFER
 * ============================================================================================
 *
 * Requirement: on conflicts, the user chooses once - keep the device copy for all of them, or take
 * the imported copy for all of them.
 *
 * The question is only worth asking about records that differ, so the whole of this file is about
 * what counts as a difference. Three cases and no fourth: absent is added, identical is skipped
 * silently, different is a conflict. Everything else here exists to stop the middle case from
 * collapsing into the last one - re-importing the file you just exported must produce no question
 * at all, and the two ways that can go wrong (key order, and a roast hydrated from its recording)
 * each have their own case.
 */

const profile = (id: string, name: string, notes = ''): Profile =>
  ({
    id,
    name,
    revision: 1,
    strategy: 'timed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metadata: { intent: '' },
    notes,
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
  name: 'recorded roast',
  dateUnknown: false,
  profileLinked: true,
})

const snapshot = (id: string, name: string): CalibrationSnapshot =>
  ({
    id,
    name,
    createdAt: '2026-02-02T00:00:00.000Z',
    recordedOn,
    runIds: [],
    patch: {},
    curves: [],
  }) as CalibrationSnapshot

const revision = (id: string, profileId: string): ProfileRevision => ({
  id,
  profileId,
  revision: 1,
  savedAt: '2026-01-02T00:00:00.000Z',
  summary: 'Created',
  profile: profile(profileId, 'x'),
})

const beanRevision = (id: string, beanId: string): BeanRevision => ({
  id,
  beanId,
  savedAt: '2026-01-02T00:00:00.000Z',
  summary: 'Created',
  bean: bean(beanId, 'x'),
})

const sample = (elapsedSec: number): TelemetrySample => ({
  elapsedSec,
  beanTempC: 100 + elapsedSec,
  rorCPerMin: 8,
  requestedFan: 7,
  effectiveFan: 7,
  requestedHeat: 6,
  effectiveHeat: 6,
  phase: 'DRYING',
})

const run = (id: string, name: string, extra: Partial<RoastRun> = {}): RoastRun =>
  ({
    id,
    name,
    startedAt: '2026-03-03T09:00:00.000Z',
    profile: profile('profile-1', 'House espresso'),
    notes: '',
    controllerVersion: 'mock',
    outcome: 'complete',
    recordedOn,
    samples: [],
    events: [],
    ...extra,
  }) as RoastRun

const file = (
  library: LibrarySnapshot,
  types: BackupType[],
  recordings: Array<{ id: string; bytes: Uint8Array }> = [],
) => {
  const allCollections = {
    profiles: serializeProfilesDocument(library.profiles, library.profileRevisions),
    beans: serializeBeansDocument(library.beans, library.beanRevisions),
    calibrations: serializeCalibrationsDocument(undefined, library.snapshots, library.calibrationPasses),
    meta: serializeMetaDocument([], [], undefined),
  }
  const whole = types.length === BACKUP_TYPES.length
  const collections = Object.fromEntries(
    collectionsForTypes(types, whole).map((name) => [name, allCollections[name]]),
  ) as BackupSource['collections']
  const source: BackupSource = {
    createdAt: '2026-07-28T10:00:00.000Z',
    deviceId: 'test-device',
    modelId: 'freshroast-sr800',
    deviceDisplayName: 'Test SR800',
    appVersion: '0.10.0',
    types,
    collections,
    runs: types.includes('runs')
      ? library.runs.map((entry) => ({ id: entry.id, payload: serializeRunDocument(entry) }))
      : [],
    recordings: types.includes('runs')
      ? recordings.map((recording) => ({
          key: recordingKey(origin(recording.id)),
          origin: origin(recording.id),
          storageAddress: origin(recording.id),
          bytes: recording.bytes,
        }))
      : [],
    missingRecordings: [],
  }
  return parseBackup(buildBackup(source).bytes)
}

const input = (
  incomingLibrary: LibrarySnapshot,
  current: LibrarySnapshot,
  types: BackupType[] = ['profiles', 'beans', 'runs', 'calibrations'],
  recordings: Array<{ id: string; bytes: Uint8Array }> = [],
  deviceRecordingIds: string[] = [],
): ImportInput => {
  const backup = file(incomingLibrary, types, recordings)
  return {
    backup,
    incoming: backupLibrary(backup),
    current,
    deviceRecordingKeys: deviceRecordingIds.map((id) => recordingKey(origin(id))),
  }
}

const library = (overrides: Partial<LibrarySnapshot> = {}): LibrarySnapshot => ({ ...emptyLibrary(), ...overrides })

describe('canonical comparison', () => {
  /** Key order is not information, and two records that differ only in it are the same record. */
  it('reads two records with the same fields in a different order as identical', () => {
    expect(stableJson({ a: 1, b: [2, { d: 4, c: 3 }] })).toBe(stableJson({ b: [2, { c: 3, d: 4 }], a: 1 }))
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }))
    // An absent field and a field set to undefined are the same fact about a record.
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }))
  })
})

describe('the three cases', () => {
  it('adds what the roaster does not have', () => {
    const plan = planImport(input(library({ profiles: [profile('p1', 'Yirgacheffe')] }), library()))
    expect(plan.added).toBe(1)
    expect(plan.conflicts).toEqual([])
  })

  /** Re-importing the file you just exported asks nothing and changes nothing. */
  it('skips an identical record silently, with no question and no write', () => {
    const both = library({ profiles: [profile('p1', 'Yirgacheffe')], beans: [bean('b1', 'Huila')] })
    const plan = planImport(input(both, both))
    expect(plan.conflicts).toEqual([])
    expect(plan.added).toBe(0)
    expect(plan.identical).toBe(2)
    const changes = importChanges(input(both, both), 'import')
    expect(changes.profiles).toEqual([])
    expect(changes.beans).toEqual([])
  })

  it('calls the same id with different content a conflict, and names it', () => {
    const plan = planImport(
      input(
        library({ profiles: [profile('p1', 'Yirgacheffe', 'imported note')] }),
        library({ profiles: [profile('p1', 'Yirgacheffe', 'roaster note')] }),
      ),
    )
    expect(plan.conflicts).toEqual([{ type: 'profiles', id: 'p1', label: 'Yirgacheffe' }])
    expect(plan.added).toBe(0)
  })

  it('reports conflicts across every kind, so one question can cover all of them', () => {
    const plan = planImport(
      input(
        library({
          profiles: [profile('p1', 'A', 'x')],
          beans: [bean('b1', 'B')],
          runs: [run('r1', 'R', { notes: 'x' })],
          snapshots: [snapshot('s1', 'S')],
        }),
        library({
          profiles: [profile('p1', 'A', 'y')],
          beans: [{ ...bean('b1', 'B'), notes: 'y' }],
          runs: [run('r1', 'R', { notes: 'y' })],
          snapshots: [{ ...snapshot('s1', 'S'), fitRmsC: 2 }],
        }),
      ),
    )
    expect(plan.conflicts.map((conflict) => conflict.type)).toEqual(['profiles', 'beans', 'runs', 'calibrations'])
  })
})

/**
 * The subtle one, and the reason a roast is compared as its DOCUMENT: a roast the roaster recorded
 * carries a bounded fallback series in its document, while the copy in
 * this browser has been hydrated from that recording and is holding a thousand samples. Comparing
 * the hydrated record against the stored document would call every device-recorded roast in the
 * library a conflict, every time.
 */
describe('a hydrated roast is not a different roast', () => {
  it('is identical to its own stored document even while holding the curve in memory', () => {
    // The roaster holds this roast's compact fallback and the full recording in the archive. Both
    // browsers may hydrate the full curve back into memory.
    const hydrated = run('r1', 'Yirgacheffe #4', {
      deviceRoast: deviceRoast('41'),
      samples: Array.from({ length: 900 }, (_value, index) => sample(index)),
    })
    const plan = planImport(input(library({ runs: [hydrated] }), library({ runs: [hydrated] })))
    // The record read back out of the file may have fewer samples than the hydrated in-memory copy.
    // They are the same roast, and a comparison that said otherwise would ask the one
    // question about every device-recorded roast in the library, every time.
    expect(planImport(input(library({ runs: [hydrated] }), library({ runs: [hydrated] }))).identical).toBe(1)
    const fallback = backupLibrary(file(library({ runs: [hydrated] }), ['runs'])).runs[0].samples
    expect(fallback.length).toBeGreaterThan(0)
    expect(fallback.at(-1)?.elapsedSec).toBe(899)
    expect(plan.conflicts).toEqual([])
  })
})

describe('answering the one question', () => {
  const contested = () =>
    input(
      library({ profiles: [profile('p1', 'Shared', 'from the file'), profile('p2', 'New', '')] }),
      library({ profiles: [profile('p1', 'Shared', 'from the roaster')] }),
    )

  it('keep the import: the conflicting records are replaced, and the new one still lands', () => {
    const changes = importChanges(contested(), 'import')
    expect(changes.profiles.map((entry) => entry.id).sort()).toEqual(['p1', 'p2'])
    expect(changes.profiles.find((entry) => entry.id === 'p1')?.notes).toBe('from the file')
    expect(changes.replacedCount).toBe(1)
    expect(changes.keptCount).toBe(0)
    expect(changes.addedCount).toBe(1)
  })

  it('keep the roaster: the conflicting records are left alone, and the new one still lands', () => {
    const changes = importChanges(contested(), 'roaster')
    expect(changes.profiles.map((entry) => entry.id)).toEqual(['p2'])
    expect(changes.replacedCount).toBe(0)
    expect(changes.keptCount).toBe(1)
    expect(changes.addedCount).toBe(1)
  })
})

describe('what an import will not touch', () => {
  it('acts only on the kinds the file names', () => {
    const incoming = library({ profiles: [profile('p1', 'A')], beans: [bean('b1', 'B')] })
    const changes = importChanges(input(incoming, library(), ['profiles']), 'import')
    expect(changes.profiles).toHaveLength(1)
    expect(changes.beans).toEqual([])
  })

  /** A revision row is an immutable record of an edit that happened. It is added, never reconciled. */
  it('adds missing revision rows, counts them, and never calls them conflicts', () => {
    const incoming = library({
      profiles: [profile('p1', 'A')],
      profileRevisions: [revision('rev-1', 'p1'), revision('rev-2', 'p1')],
      beans: [bean('b1', 'B')],
      beanRevisions: [beanRevision('bean-rev-1', 'b1')],
    })
    const current = library({
      profiles: [profile('p1', 'A')],
      profileRevisions: [revision('rev-1', 'p1')],
      beans: [bean('b1', 'B')],
    })
    const plan = planImport(input(incoming, current))
    expect(plan.conflicts).toEqual([])
    expect(plan.added).toBe(2)
    const changes = importChanges(input(incoming, current), 'roaster')
    expect(changes.profileRevisions.map((row) => row.id)).toEqual(['rev-2'])
    expect(changes.beanRevisions.map((row) => row.id)).toEqual(['bean-rev-1'])
    expect(changes.addedCount).toBe(2)
  })
})

/**
 * Runs bring their recordings when the file contains them and the device lacks them.
 *
 * A recording is not an edit anybody can disagree about - it is either on the volume or it is not -
 * so it is put back whichever way the one question was answered, and never re-uploaded over a copy
 * the roaster already has.
 */
describe('recordings that come with their roasts', () => {
  const recorded = run('r1', 'Yirgacheffe #4', { deviceRoast: deviceRoast('41') })
  const withRecording = (deviceRecordingIds: string[]) =>
    input(
      library({ runs: [recorded] }),
      library({ runs: [recorded] }),
      ['runs'],
      [{ id: '41', bytes: Uint8Array.from([1, 2, 3, 0, 5]) }],
      deviceRecordingIds,
    )

  it('offers a recording the roaster no longer holds', () => {
    expect(planImport(withRecording([])).recordings).toEqual([recordingKey(origin('41'))])
    expect(importChanges(withRecording([]), 'roaster').recordings).toEqual([recordingKey(origin('41'))])
  })

  it('leaves a recording the roaster already holds alone', () => {
    expect(planImport(withRecording(['41'])).recordings).toEqual([])
  })

  it('offers nothing when the file is not a roast-history file', () => {
    const profilesOnly = input(library({ profiles: [profile('p1', 'A')] }), library(), ['profiles'])
    expect(planImport(profilesOnly).recordings).toEqual([])
  })
})
