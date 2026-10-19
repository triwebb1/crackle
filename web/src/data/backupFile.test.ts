import { describe, expect, it } from 'vitest'
import { recordingFileStem, recordingKey } from '../domain/provenance'
import type { BeanLot, Profile, RoastRun } from '../domain/types'
import {
  BACKUP_TYPES,
  type BackupManifest,
  type BackupSource,
  backupFileName,
  buildBackup,
  collectionsForTypes,
  parseBackup,
} from './backupFile'
import {
  serializeBeansDocument,
  serializeCalibrationsDocument,
  serializeMetaDocument,
  serializeProfilesDocument,
  serializeRunDocument,
} from './documentSerializer'
import { readZip, textBytes, writeZip } from './zipFile'

/**
 * ============================================================================================
 * WHAT A BACKUP CONTAINS, AND WHAT IT REFUSES TO BE
 * ============================================================================================
 *
 * Two claims are pinned here above all others, because both were things the JSON export this
 * replaces could not do:
 *
 *   1. **A recording is in the file as BYTES.** Not as CSV, not re-encoded, not round-tripped
 *      through a string. The old export carried decoded CSV text, which is a rendering of a
 *      recording rather than the recording - and a rendering cannot be restored.
 *   2. **A document is in the file as the payload the roaster stores.** The same string goes back to
 *      `POST /api/data/<name>?base=0`, so a restore posts what was backed up rather than whatever
 *      this build of the serializer would produce from a hydrated copy.
 *
 * And one refusal: `parseBackup` is what stands between an unreadable file and an erased roaster, so
 * everything it must refuse is refused here rather than discovered at step two of a restore.
 */

const profile = (id: string, name: string): Profile =>
  ({
    id,
    name,
    revision: 1,
    strategy: 'timed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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
const recordedOn = {
  deviceId: 'test-device',
  modelId: 'freshroast-sr800',
  displayNameAtCapture: 'Test SR800',
  simulated: true,
  simulatesModelId: 'freshroast-sr800',
  firmwareVersion: '2026-07-26.40-mock',
  identitySource: 'roaster' as const,
}
const origin = (logId: string) => ({ deviceId: recordedOn.deviceId, logId })
const backupRecording = (logId: string, bytes = recordingBytes(3)) => ({
  key: recordingKey(origin(logId)),
  origin: origin(logId),
  storageAddress: origin(logId),
  bytes,
})
const missingRecording = (logId: string, reason: string) => ({
  key: recordingKey(origin(logId)),
  origin: origin(logId),
  storageAddress: origin(logId),
  reason,
})

const run = (id: string, logId?: string): RoastRun =>
  ({
    id,
    name: `Roast ${id}`,
    startedAt: '2026-03-03T09:00:00.000Z',
    profile: profile('profile-1', 'House espresso'),
    notes: '',
    controllerVersion: 'mock',
    outcome: 'complete',
    recordedOn,
    samples: [],
    events: [],
    ...(logId === undefined
      ? {}
      : {
          deviceRoast: {
            recordingOrigin: origin(logId),
            storageAddress: origin(logId),
            name: `Roast ${id}`,
            dateUnknown: false,
            profileLinked: true,
          },
        }),
  }) as RoastRun

/** Arbitrary binary, with the NUL in byte five that makes a raw POST body arrive as five bytes. */
const recordingBytes = (seed: number) =>
  Uint8Array.from({ length: 64 }, (_value, index) => (index === 4 ? 0 : (index * seed + 7) % 256))

const source = (overrides: Partial<BackupSource> = {}): BackupSource => ({
  createdAt: '2026-07-28T10:00:00.000Z',
  deviceId: 'test-device',
  modelId: 'freshroast-sr800',
  deviceDisplayName: 'Test SR800',
  appVersion: '0.10.0',
  firmwareVersion: '2026-07-26.40-mock',
  bootId: '7',
  deviceUsedBytes: 198 * 1024,
  deviceTotalBytes: 896 * 1024,
  types: [...BACKUP_TYPES],
  collections: {
    profiles: serializeProfilesDocument([profile('profile-1', 'House espresso')], []),
    beans: serializeBeansDocument([bean('bean-1', 'House Huila')], []),
    calibrations: serializeCalibrationsDocument(undefined, [], []),
    meta: serializeMetaDocument([recordingKey(origin('1'))], []),
  },
  runs: [{ id: 'run-a', payload: serializeRunDocument(run('run-a', '1')) }],
  recordings: [backupRecording('1')],
  missingRecordings: [],
  appliedCalibration: {
    heaterGainCPerMinAt10: 66,
    fanCoolingCPerMinAt10: 19,
    coolingFanCPerMinAt10: 28,
    thermalLossPerMinPerC: 0.17,
    fitId: 'fit-2026-07-27',
  },
  ...overrides,
})

const names = (bytes: Uint8Array) => readZip(bytes).map((entry) => entry.name)

const rewriteManifest = (bytes: Uint8Array, update: (manifest: BackupManifest) => BackupManifest): Uint8Array =>
  writeZip(
    readZip(bytes).map((entry) =>
      entry.name === 'manifest.json'
        ? {
            name: entry.name,
            data: textBytes(JSON.stringify(update(JSON.parse(new TextDecoder().decode(entry.data)) as BackupManifest))),
          }
        : entry,
    ),
  )

const replaceEntry = (bytes: Uint8Array, name: string, data: Uint8Array): Uint8Array =>
  writeZip(readZip(bytes).map((entry) => (entry.name === name ? { name, data } : entry)))

describe('building a backup', () => {
  it('lays the file out as manifest, collections, run documents, recordings and the calibration', () => {
    expect(names(buildBackup(source()).bytes)).toEqual([
      'manifest.json',
      'collections/profiles.json',
      'collections/beans.json',
      'collections/calibrations.json',
      'collections/meta.json',
      'runs/run-a.json',
      `recordings/${recordingFileStem(origin('1'))}.crk`,
      'config/applied-calibration.json',
    ])
  })

  it('carries the recording as raw bytes, NUL and all', () => {
    const parsed = parseBackup(buildBackup(source()).bytes)
    expect([...(parsed.recordings.get(recordingKey(origin('1')))?.bytes ?? [])]).toEqual([...recordingBytes(3)])
    expect(parsed.recordings.get(recordingKey(origin('1')))?.bytes?.[4]).toBe(0)
  })

  it('carries each document as the payload the roaster stores, character for character', () => {
    const payload = source().collections.profiles ?? ''
    expect(parseBackup(buildBackup(source()).bytes).collections.profiles).toBe(payload)
  })

  /**
   * The manifest is the half a user reads, so its counts are computed from the payloads actually
   * going into the file rather than handed in beside them. Two numbers assembled separately
   * eventually disagree, and this is the one that gets believed.
   */
  it('counts what is in the file rather than what it was told', () => {
    const { manifest } = buildBackup(source())
    expect(manifest.counts).toEqual({
      profiles: 1,
      beans: 1,
      runs: 1,
      recordings: 1,
      calibrationPasses: 0,
      calibrationSnapshots: 0,
    })
    expect(manifest.whole).toBe(true)
    expect(manifest.device.firmwareVersion).toBe('2026-07-26.40-mock')
    expect(manifest.app.version).toBe('0.10.0')
  })

  /** A recording the roaster would not hand over is NAMED. A backup short by one must say so. */
  it('names a recording it could not read instead of being quietly short', () => {
    const { manifest } = buildBackup(
      source({
        recordings: [],
        missingRecordings: [missingRecording('4', 'That recording is no longer on the roaster')],
      }),
    )
    expect(manifest.counts.recordings).toBe(0)
    expect(manifest.missingRecordings).toEqual([missingRecording('4', 'That recording is no longer on the roaster')])
  })

  it('writes only what a single-kind export names, and no applied calibration', () => {
    expect(names(buildBackup(source({ types: ['profiles'] })).bytes)).toEqual([
      'manifest.json',
      'collections/profiles.json',
    ])
    // `meta` is bookkeeping about the whole library, so it rides with a WHOLE backup and nothing else.
    expect(collectionsForTypes(['profiles'], false)).toEqual(['profiles'])
    expect(collectionsForTypes([...BACKUP_TYPES], true)).toEqual(['profiles', 'beans', 'calibrations', 'meta'])
  })

  it('keeps roast history and its recordings together in a single-kind export', () => {
    expect(names(buildBackup(source({ types: ['runs'] })).bytes)).toEqual([
      'manifest.json',
      'runs/run-a.json',
      `recordings/${recordingFileStem(origin('1'))}.crk`,
    ])
  })

  it('names the file for what is in it, and dates it from the manifest rather than the clock', () => {
    expect(backupFileName([...BACKUP_TYPES], '2026-07-28T10:00:00.000Z')).toBe('crackle-backup-2026-07-28.zip')
    expect(backupFileName(['runs'], '2026-07-28T10:00:00.000Z')).toBe('crackle-roast-history-2026-07-28.zip')
    expect(backupFileName(['profiles'], '2026-07-28T10:00:00.000Z')).toBe('crackle-profiles-2026-07-28.zip')
  })
})

describe('reading a backup', () => {
  it('reads back everything it wrote', () => {
    const parsed = parseBackup(buildBackup(source()).bytes)
    expect(parsed.manifest.types).toEqual([...BACKUP_TYPES])
    expect(parsed.runs).toEqual([{ id: 'run-a', payload: serializeRunDocument(run('run-a', '1')) }])
    expect(parsed.appliedCalibration?.present).toBe(true)
    expect(parsed.appliedCalibration?.coefficients?.fitId).toBe('fit-2026-07-27')
  })

  /** A roaster holding no applied set is a real answer, and a restore has to be able to state it. */
  it('records an absent calibration as absent rather than as missing', () => {
    const parsed = parseBackup(buildBackup(source({ appliedCalibration: undefined })).bytes)
    expect(parsed.appliedCalibration).toEqual({ present: false, coefficients: undefined })
  })

  it('keeps every intended partial-export shape valid for Import', () => {
    for (const types of [['profiles'], ['beans'], ['runs'], ['calibrations'], ['profiles', 'beans']] as const) {
      const selected = new Set<string>(types)
      const parsed = parseBackup(buildBackup(source({ types: [...types] })).bytes)
      expect(parsed.manifest.types).toEqual(types)
      expect(parsed.manifest.whole).toBe(false)
      expect(parsed.appliedCalibration).toBeUndefined()
      expect(parsed.manifest.counts.beans).toBe(selected.has('beans') ? 1 : 0)
      expect(parsed.manifest.counts.profiles).toBe(selected.has('profiles') ? 1 : 0)
      expect(parsed.manifest.counts.runs).toBe(selected.has('runs') ? 1 : 0)
      expect(parsed.manifest.counts.recordings).toBe(selected.has('runs') ? 1 : 0)
    }
  })

  /*
   * ------------------------------------------------------------------------------------------
   * THE REFUSALS. Every one of these happens BEFORE `/api/logs/format`, which is the whole point:
   * a file that will not read has cost the user nothing, and the same discovery one step later
   * would have cost them the volume.
   * ------------------------------------------------------------------------------------------
   */
  it('refuses a zip that is not a backup', () => {
    expect(() => parseBackup(writeZip([{ name: 'notes.txt', data: textBytes('hello') }]))).toThrow(/no manifest/)
    expect(() =>
      parseBackup(writeZip([{ name: 'manifest.json', data: textBytes('{"format":"something-else"}') }])),
    ).toThrow(/not a Crackle backup/)
    expect(() => parseBackup(writeZip([{ name: 'manifest.json', data: textBytes('not json') }]))).toThrow(
      /could not be read/,
    )
  })

  it('refuses a backup with an unsupported format version, by name', () => {
    const manifest = JSON.stringify({ format: 'crackle-backup', version: 99, types: ['profiles'] })
    expect(() => parseBackup(writeZip([{ name: 'manifest.json', data: textBytes(manifest) }]))).toThrow(
      /unsupported Crackle backup format/,
    )
  })

  it('refuses a backup that names nothing it can put back', () => {
    const manifest = JSON.stringify({ format: 'crackle-backup', version: 4, types: [] })
    expect(() => parseBackup(writeZip([{ name: 'manifest.json', data: textBytes(manifest) }]))).toThrow(/names nothing/)
  })

  /**
   * Every document is parsed here, not at the moment it would be written. "The file is readable" has
   * to be a fact established before the erase, not a hope held while the volume is being rebuilt.
   */
  it('refuses a backup whose documents will not parse, naming which one', () => {
    const broken = buildBackup(source()).bytes
    const entries = readZip(broken).map((entry) =>
      entry.name === 'collections/beans.json' ? { name: entry.name, data: textBytes('[]') } : entry,
    )
    expect(() => parseBackup(writeZip(entries))).toThrow(/beans document/)

    const brokenRun = readZip(buildBackup(source()).bytes).map((entry) =>
      entry.name === 'runs/run-a.json' ? { name: entry.name, data: textBytes('{"nope":true}') } : entry,
    )
    expect(() => parseBackup(writeZip(brokenRun))).toThrow(/run-a/)
  })

  it('requires the manifest and zip to name exactly the same files', () => {
    const complete = buildBackup(source()).bytes
    const missingBean = writeZip(readZip(complete).filter((entry) => entry.name !== 'collections/beans.json'))
    expect(() => parseBackup(missingBean)).toThrow(/missing.*collections\/beans\.json/)

    const extra = writeZip([...readZip(complete), { name: 'notes.txt', data: textBytes('surprise') }])
    expect(() => parseBackup(extra)).toThrow(/unexpected file.*notes\.txt/)

    const missingFromManifest = rewriteManifest(complete, (manifest) => ({
      ...manifest,
      collections: manifest.collections.filter((name) => name !== 'meta'),
    }))
    expect(() => parseBackup(missingFromManifest)).toThrow(/exactly the collections/)
  })

  it('refuses duplicate archive paths and duplicate manifest ids', () => {
    // writeZip itself forbids duplicates. Change only the second central-directory name to make a
    // foreign ZIP with two logical `left.txt` entries; readZip deliberately reads central names.
    const duplicate = writeZip([
      { name: 'manifest.json', data: textBytes('{}') },
      { name: 'left.txt', data: textBytes('one') },
      { name: 'rite.txt', data: textBytes('two') },
    ])
    const oldName = textBytes('rite.txt')
    const newName = textBytes('left.txt')
    for (let at = duplicate.length - oldName.length; at >= 0; at -= 1) {
      if (oldName.every((byte, offset) => duplicate[at + offset] === byte)) {
        duplicate.set(newName, at)
        break
      }
    }
    expect(() => parseBackup(duplicate)).toThrow(/duplicate file/)

    const duplicateRun = rewriteManifest(buildBackup(source()).bytes, (manifest) => ({
      ...manifest,
      runs: [...manifest.runs, manifest.runs[0]],
    }))
    expect(() => parseBackup(duplicateRun)).toThrow(/duplicate roast record/)
  })

  it('checks manifest counts and the identity inside each run document', () => {
    const complete = buildBackup(source()).bytes
    const wrongCount = rewriteManifest(complete, (manifest) => ({
      ...manifest,
      counts: { ...manifest.counts, runs: manifest.counts.runs + 1 },
    }))
    expect(() => parseBackup(wrongCount)).toThrow(/runs count does not match/)

    const wrongRun = replaceEntry(complete, 'runs/run-a.json', textBytes(serializeRunDocument(run('run-b', '1'))))
    expect(() => parseBackup(wrongRun)).toThrow(/run-a.*different id/)
  })

  it('refuses malformed recording provenance and contradictory missing recordings', () => {
    const complete = buildBackup(source()).bytes
    const invalidRun = rewriteManifest(complete, (manifest) => ({ ...manifest, runs: ['../run-a'] }))
    expect(() => parseBackup(invalidRun)).toThrow(/invalid roast record id/)

    const mismatchedKey = rewriteManifest(complete, (manifest) => ({
      ...manifest,
      recordings: [{ ...manifest.recordings[0], key: 'wrong-origin-key' }],
    }))
    expect(() => parseBackup(mismatchedKey)).toThrow(/provenance does not match/)
    const unsafeFile = rewriteManifest(complete, (manifest) => ({
      ...manifest,
      recordings: [{ ...manifest.recordings[0], file: 'recordings/../escape.crk' }],
    }))
    expect(() => parseBackup(unsafeFile)).toThrow(/provenance does not match/)

    const descriptor = buildBackup(source()).manifest.recordings[0]
    const both = rewriteManifest(complete, (manifest) => ({
      ...manifest,
      missingRecordings: [
        {
          key: descriptor.key,
          origin: descriptor.origin,
          storageAddress: descriptor.storageAddress,
          reason: 'read failed',
        },
      ],
    }))
    expect(() => parseBackup(both)).toThrow(/both present and missing/)

    const duplicateMissing = rewriteManifest(buildBackup(source({ recordings: [] })).bytes, (manifest) => ({
      ...manifest,
      missingRecordings: [missingRecording('2', 'read failed'), missingRecording('2', 'still failed')],
    }))
    expect(() => parseBackup(duplicateMissing)).toThrow(/duplicate missing recording/)
  })
  it('requires a coherent applied-calibration file only for whole backups', () => {
    const complete = buildBackup(source()).bytes
    const missing = writeZip(readZip(complete).filter((entry) => entry.name !== 'config/applied-calibration.json'))
    expect(() => parseBackup(missing)).toThrow(/missing.*applied-calibration/)

    const incomplete = replaceEntry(
      complete,
      'config/applied-calibration.json',
      textBytes(
        JSON.stringify({
          present: true,
          coefficients: { heaterGainCPerMinAt10: 66 },
        }),
      ),
    )
    expect(() => parseBackup(incomplete)).toThrow(/applied calibration.*incomplete/)

    const outOfRange = replaceEntry(
      complete,
      'config/applied-calibration.json',
      textBytes(
        JSON.stringify({
          present: true,
          coefficients: {
            heaterGainCPerMinAt10: 1001,
            fanCoolingCPerMinAt10: 19,
            coolingFanCPerMinAt10: 28,
            thermalLossPerMinPerC: 0.17,
          },
        }),
      ),
    )
    expect(() => parseBackup(outOfRange)).toThrow(/applied calibration.*out of range/)

    const partial = buildBackup(source({ types: ['profiles'] })).bytes
    const partialWithCalibration = writeZip([
      ...readZip(partial),
      { name: 'config/applied-calibration.json', data: textBytes('{"present":false}') },
    ])
    expect(() => parseBackup(partialWithCalibration)).toThrow(/unexpected file.*applied-calibration/)
  })
})
