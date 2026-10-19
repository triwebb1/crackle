/**
 * ============================================================================================
 * WHAT IS INSIDE A CRACKLE BACKUP
 * ============================================================================================
 *
 * Requirements: a backup captures every document and configuration on the roaster as one zip, and
 * a restore applies that zip, completely replacing what the device holds. Histories, profiles, bean
 * lots and calibrations are also exportable individually and can be imported into an existing
 * library.
 *
 * Two requirements, two features, one file format. A full backup is every type; a single-type export is
 * the same format with a subset of the same entries, so the import path never has to ask which kind
 * of file it was handed - it reads the manifest's `types` and acts on those.
 *
 * --------------------------------------------------------------------------------------------
 * THE LAYOUT
 * --------------------------------------------------------------------------------------------
 *
 *     manifest.json                    what this file is, when it was made, and what is in it
 *     collections/profiles.json        the stored collection documents, VERBATIM
 *     collections/beans.json
 *     collections/calibrations.json
 *     collections/meta.json
 *     runs/<id>.json                   one per roast record, VERBATIM
 *     recordings/<id>.crk              the archive file, RAW BYTES, exactly as the device holds it
 *     config/applied-calibration.json  the coefficient set the roaster is running on
 *
 * **The documents are the payloads as stored, byte for byte, not a re-rendering of them.** They came
 * off `GET /api/data/<name>` or out of the serializer that would have written them, and they go back
 * to `POST /api/data/<name>?base=0` unchanged. A backup that re-encoded its contents would be a
 * backup of what this build of the app happens to think the schema is; this one is a backup of what
 * the roaster actually held. The firmware never parses a document either - the same principle, one
 * layer up.
 *
 * **A recording is raw.** `GET /logs/<id>.crk` interprets nothing on the way out, and this file
 * keeps that: the bytes in `recordings/41.crk` are the bytes on the volume, header, CRC and all. A
 * recording that has gone bad in flash is still the user's data, and a byte-exact copy is the only form
 * in which it can be looked at or repaired off-device.
 *
 * --------------------------------------------------------------------------------------------
 * A RECORDING THAT WOULD NOT COME BACK IS NAMED, NEVER DROPPED
 * --------------------------------------------------------------------------------------------
 *
 * `missingRecordings` lists every recording the roaster refused to hand over, with the reason. A
 * backup that silently contained twenty-two of twenty-three recordings would be a backup the user
 * trusted and should not have. The count in the manifest is what the file HOLDS, and the missing
 * list is what it does not.
 */

import type { DeviceCoefficients } from '../domain/deviceLogs'
import {
  recordingFileStem,
  recordingKey,
  recordingOriginFromFileStem,
  requireRecordingOrigin,
  requireStorageAddress,
} from '../domain/provenance'
import type { RecordingOrigin, RecordingStorageAddress } from '../domain/types'
import {
  COLLECTIONS,
  type CollectionName,
  parseBeansDocument,
  parseCalibrationsDocument,
  parseMetaDocument,
  parseProfilesDocument,
  parseRunDocument,
} from './documentSerializer'
import { readZip, textBytes, writeZip, type ZipEntry } from './zipFile'

export const BACKUP_FORMAT = 'crackle-backup'
export const BACKUP_VERSION = 4

/** The four kinds of thing a user can export on their own. */
export type BackupType = 'profiles' | 'beans' | 'runs' | 'calibrations'
export const BACKUP_TYPES: readonly BackupType[] = ['profiles', 'beans', 'runs', 'calibrations']

/** What each type is called in user-facing text. */
export const BACKUP_TYPE_LABELS: Record<BackupType, string> = {
  profiles: 'Profiles',
  beans: 'Bean lots',
  runs: 'Roast history',
  calibrations: 'Saved calibrations',
}

/** Which collection document carries each type. `runs` has no collection; it has one file per roast. */
const TYPE_COLLECTION: Record<BackupType, CollectionName | undefined> = {
  profiles: 'profiles',
  beans: 'beans',
  runs: undefined,
  calibrations: 'calibrations',
}

export const MANIFEST_PATH = 'manifest.json'
export const COLLECTION_PREFIX = 'collections/'
export const RUN_PREFIX = 'runs/'
export const RECORDING_PREFIX = 'recordings/'
export const APPLIED_CALIBRATION_PATH = 'config/applied-calibration.json'

export interface BackupCounts {
  profiles: number
  beans: number
  runs: number
  recordings: number
  calibrationPasses: number
  calibrationSnapshots: number
}

export interface BackupRecordingDescriptor {
  key: string
  origin: RecordingOrigin
  storageAddress: RecordingStorageAddress
  file: string
}

export interface BackupMissingRecording extends Omit<BackupRecordingDescriptor, 'file'> {
  reason: string
}

export interface BackupRecording extends Omit<BackupRecordingDescriptor, 'file'> {
  bytes: Uint8Array
}
export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  /** ISO, and the only date anywhere in the file. Zip entries carry a fixed stamp on purpose. */
  createdAt: string
  /** Whole-library, or one or more types on their own. Both read back through the same path. */
  whole: boolean
  types: BackupType[]
  app: { name: string; version: string }
  device: {
    deviceId: string
    modelId: string
    displayName: string
    firmwareVersion?: string
    bootId?: string
    /** The volume, from the roaster's own figures at the moment the backup was taken. */
    usedBytes?: number
    totalBytes?: number
  }
  counts: BackupCounts
  collections: CollectionName[]
  runs: string[]
  recordings: BackupRecordingDescriptor[]
  missingRecordings: BackupMissingRecording[]
}

export interface BackupSource {
  createdAt: string
  appVersion: string
  deviceId: string
  modelId: string
  deviceDisplayName: string
  firmwareVersion?: string
  bootId?: string
  deviceUsedBytes?: number
  deviceTotalBytes?: number
  types: BackupType[]
  /** Raw stored payloads, keyed by collection. Only the ones the chosen types need are read. */
  collections: Partial<Record<CollectionName, string>>
  /** Raw stored run documents. */
  runs: Array<{ id: string; payload: string }>
  /** Raw `.crk` bytes, in the order they were fetched. */
  recordings: BackupRecording[]
  missingRecordings: BackupMissingRecording[]
  appliedCalibration?: DeviceCoefficients
}

export interface AppliedCalibrationFile {
  present: boolean
  coefficients?: DeviceCoefficients
}

const countIn = (payload: string | undefined, count: (parsed: string) => number): number => {
  if (payload === undefined) return 0
  try {
    return count(payload)
  } catch {
    return 0
  }
}

/**
 * The manifest's counts are computed from the payloads that are actually going INTO the file, not
 * handed in by the caller. A count and its contents that are assembled separately eventually
 * disagree, and the manifest is the half a user reads.
 */
const countsOf = (source: BackupSource): BackupCounts => ({
  profiles: countIn(source.collections.profiles, (payload) => parseProfilesDocument(payload).profiles.length),
  beans: countIn(source.collections.beans, (payload) => parseBeansDocument(payload).beans.length),
  runs: source.runs.length,
  recordings: source.recordings.length,
  calibrationPasses: countIn(
    source.collections.calibrations,
    (payload) => parseCalibrationsDocument(payload).runs.length,
  ),
  calibrationSnapshots: countIn(
    source.collections.calibrations,
    (payload) => parseCalibrationsDocument(payload).snapshots.length,
  ),
})

/** Which collections a set of types needs. `meta` rides along only with a whole-library backup. */
export const collectionsForTypes = (types: BackupType[], whole: boolean): CollectionName[] => {
  const needed = new Set<CollectionName>()
  for (const type of types) {
    const collection = TYPE_COLLECTION[type]
    if (collection) needed.add(collection)
  }
  if (whole) needed.add('meta')
  return COLLECTIONS.filter((name) => needed.has(name))
}

export const buildBackup = (source: BackupSource): { bytes: Uint8Array<ArrayBuffer>; manifest: BackupManifest } => {
  const types = BACKUP_TYPES.filter((type) => source.types.includes(type))
  const whole = types.length === BACKUP_TYPES.length
  const collections = collectionsForTypes([...types], whole).filter((name) => source.collections[name] !== undefined)
  /*
   * The chosen types decide what goes in, here rather than only at the call site. A file whose
   * manifest says `["profiles"]` and whose payload also carries every roast would be a file that
   * lies about itself, and the import path reads the manifest to decide what to touch.
   *
   * Recordings ride with `runs` and with nothing else: a recording is a roast's curve, so a roast
   * history that arrived without them would restore a library of roasts with no data in them.
   */
  const runs = types.includes('runs') ? source.runs : []
  const recordings = types.includes('runs')
    ? source.recordings.map((recording): BackupRecording => {
        const origin = requireRecordingOrigin(recording.origin)
        const storageAddress = requireStorageAddress(recording.storageAddress)
        const key = recordingKey(origin)
        if (recording.key !== key) throw new Error('A recording does not match its recording-origin key')
        return { key, origin, storageAddress, bytes: recording.bytes }
      })
    : []
  const missingRecordings = types.includes('runs')
    ? source.missingRecordings.map((recording): BackupMissingRecording => {
        const origin = requireRecordingOrigin(recording.origin)
        const storageAddress = requireStorageAddress(recording.storageAddress)
        const key = recordingKey(origin)
        if (recording.key !== key) throw new Error('A missing recording does not match its recording-origin key')
        return { key, origin, storageAddress, reason: recording.reason }
      })
    : []
  const recordingKeys = recordings.map((recording) => recording.key)
  if (new Set(recordingKeys).size !== recordingKeys.length)
    throw new Error('A backup cannot contain the same recording origin twice')
  if (missingRecordings.some((entry) => recordingKeys.includes(entry.key))) {
    throw new Error('A backup cannot name a recording as both present and missing')
  }
  const includedCollections: Partial<Record<CollectionName, string>> = {}
  for (const name of collections) {
    const payload = source.collections[name]
    if (payload !== undefined) includedCollections[name] = payload
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: source.createdAt,
    whole,
    types: [...types],
    app: { name: 'Crackle', version: source.appVersion },
    device: {
      deviceId: source.deviceId,
      modelId: source.modelId,
      displayName: source.deviceDisplayName,
      firmwareVersion: source.firmwareVersion,
      bootId: source.bootId,
      usedBytes: source.deviceUsedBytes,
      totalBytes: source.deviceTotalBytes,
    },
    counts: countsOf({ ...source, types: [...types], collections: includedCollections, runs, recordings }),
    collections,
    runs: runs.map((run) => run.id),
    recordings: recordings.map((recording) => ({
      key: recordingKey(recording.origin),
      origin: recording.origin,
      storageAddress: recording.storageAddress,
      file: `${RECORDING_PREFIX}${recordingFileStem(recording.origin)}.crk`,
    })),
    missingRecordings,
  }

  const entries: ZipEntry[] = [{ name: MANIFEST_PATH, data: textBytes(JSON.stringify(manifest, null, 2)) }]
  for (const name of collections)
    entries.push({ name: `${COLLECTION_PREFIX}${name}.json`, data: textBytes(source.collections[name] ?? '') })
  for (const run of runs) entries.push({ name: `${RUN_PREFIX}${run.id}.json`, data: textBytes(run.payload) })
  for (const recording of recordings)
    entries.push({ name: `${RECORDING_PREFIX}${recordingFileStem(recording.origin)}.crk`, data: recording.bytes })
  if (whole) {
    const applied: AppliedCalibrationFile = source.appliedCalibration
      ? { present: true, coefficients: source.appliedCalibration }
      : { present: false }
    entries.push({ name: APPLIED_CALIBRATION_PATH, data: textBytes(JSON.stringify(applied, null, 2)) })
  }
  return { bytes: writeZip(entries), manifest }
}

export interface ParsedBackup {
  manifest: BackupManifest
  /** Raw payloads, exactly as they will be posted back. */
  collections: Partial<Record<CollectionName, string>>
  runs: Array<{ id: string; payload: string }>
  recordings: Map<string, BackupRecording>
  appliedCalibration?: AppliedCalibrationFile
}

const NOT_A_BACKUP = 'That file is not a Crackle backup'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const listedStrings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`That backup's ${label} list could not be read`)
  }
  const entries = value as string[]
  if (new Set(entries).size !== entries.length) throw new Error(`That backup names a duplicate ${label} entry`)
  return entries
}

const countValue = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`That backup's ${label} count could not be read`)
  }
  return value
}

const sameMembers = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry) => right.includes(entry))

/** Exactly the run-id alphabet and length accepted by the firmware document store. */
const validRunId = (id: string): boolean =>
  id.length >= 1 && id.length <= 24 && /^[A-Za-z0-9._-]+$/.test(id) && !/^\.+$/.test(id)

const checkedAppliedCalibration = (data: Uint8Array): AppliedCalibrationFile => {
  let body: Record<string, unknown> | undefined
  try {
    body = record(JSON.parse(new TextDecoder().decode(data)) as unknown)
  } catch {
    body = undefined
  }
  if (!body || typeof body.present !== 'boolean') {
    throw new Error('The applied calibration inside that backup could not be read')
  }
  if (!body.present) {
    if (body.coefficients !== undefined)
      throw new Error('The applied calibration inside that backup contradicts itself')
    return { present: false, coefficients: undefined }
  }

  const values = record(body.coefficients)
  const coefficientNames = [
    'heaterGainCPerMinAt10',
    'fanCoolingCPerMinAt10',
    'coolingFanCPerMinAt10',
    'thermalLossPerMinPerC',
  ] as const
  if (
    !values ||
    coefficientNames.some((name) => {
      const value = finite(values[name])
      return value === undefined || value < 0 || value > 1000
    })
  ) {
    throw new Error('The applied calibration inside that backup is incomplete or out of range')
  }
  if (values.fitId !== undefined && typeof values.fitId !== 'string') {
    throw new Error('The applied calibration inside that backup has an invalid fit id')
  }
  if (values.updatedAt !== undefined && typeof values.updatedAt !== 'string') {
    throw new Error('The applied calibration inside that backup has an invalid update time')
  }
  return {
    present: true,
    coefficients: {
      heaterGainCPerMinAt10: values.heaterGainCPerMinAt10 as number,
      fanCoolingCPerMinAt10: values.fanCoolingCPerMinAt10 as number,
      coolingFanCPerMinAt10: values.coolingFanCPerMinAt10 as number,
      thermalLossPerMinPerC: values.thermalLossPerMinPerC as number,
      fitId: values.fitId as string | undefined,
      updatedAt: values.updatedAt as string | undefined,
    },
  }
}

/**
 * Read the manifest, and refuse anything that is not one.
 *
 * This runs BEFORE the device is touched by a restore, and it is what a refusal is made of: a file
 * that will not parse here has cost the user nothing, while the same discovery made after
 * `/api/logs/format` would have cost them everything.
 */
export const parseBackup = (bytes: Uint8Array): ParsedBackup => {
  const entries = readZip(bytes)
  const entryNames = entries.map((entry) => entry.name)
  if (new Set(entryNames).size !== entryNames.length) throw new Error('That backup contains a duplicate file')
  const manifestEntry = entries.find((entry) => entry.name === MANIFEST_PATH)
  if (!manifestEntry) throw new Error(`${NOT_A_BACKUP} - it has no manifest`)

  let body: Record<string, unknown> | undefined
  try {
    body = record(JSON.parse(new TextDecoder().decode(manifestEntry.data)))
  } catch {
    body = undefined
  }
  if (!body) throw new Error(`${NOT_A_BACKUP} - its manifest could not be read`)
  if (body.format !== BACKUP_FORMAT) throw new Error(NOT_A_BACKUP)
  if (body.version !== BACKUP_VERSION)
    throw new Error(`That backup uses unsupported Crackle backup format ${String(body.version)}`)

  const namedTypes = listedStrings(body.types, 'type')
  if (namedTypes.length === 0) throw new Error('That backup names nothing it can restore')
  if (namedTypes.some((type) => !BACKUP_TYPES.includes(type as BackupType))) {
    throw new Error('That backup names a type this version of Crackle cannot restore')
  }
  const types = BACKUP_TYPES.filter((type) => namedTypes.includes(type))
  if (typeof body.whole !== 'boolean' || body.whole !== (types.length === BACKUP_TYPES.length)) {
    throw new Error('That backup disagrees about whether it contains the whole library')
  }
  const whole = body.whole

  const namedCollections = listedStrings(body.collections, 'collection')
  if (namedCollections.some((name) => !COLLECTIONS.includes(name as CollectionName))) {
    throw new Error('That backup names an unknown collection')
  }
  const expectedCollections = collectionsForTypes([...types], whole)
  if (!sameMembers(namedCollections, expectedCollections)) {
    throw new Error('That backup does not name exactly the collections its types require')
  }
  const namedRuns = listedStrings(body.runs, 'roast record')
  if (namedRuns.some((id) => !validRunId(id))) throw new Error('That backup contains an invalid roast record id')
  if (!Array.isArray(body.recordings)) throw new Error(`That backup's recording list could not be read`)
  const namedRecordings: BackupRecordingDescriptor[] = body.recordings.map((entry) => {
    const row = record(entry)
    if (!row || typeof row.key !== 'string' || typeof row.file !== 'string') {
      throw new Error(`That backup's recording list could not be read`)
    }
    const origin = requireRecordingOrigin(row.origin)
    const storageAddress = requireStorageAddress(row.storageAddress)
    const key = recordingKey(origin)
    const file = `${RECORDING_PREFIX}${recordingFileStem(origin)}.crk`
    if (row.key !== key || row.file !== file) {
      throw new Error(`That backup's recording provenance does not match its key or file`)
    }
    const decoded = recordingOriginFromFileStem(row.file.slice(RECORDING_PREFIX.length, -'.crk'.length))
    if (!decoded || recordingKey(decoded) !== key) throw new Error(`That backup's recording file name is invalid`)
    return { key, origin, storageAddress, file }
  })
  if (new Set(namedRecordings.map((entry) => entry.key)).size !== namedRecordings.length) {
    throw new Error('That backup names a duplicate recording origin')
  }

  if (!Array.isArray(body.missingRecordings)) throw new Error(`That backup's missing recording list could not be read`)
  const missing: BackupMissingRecording[] = body.missingRecordings.map((entry) => {
    const row = record(entry)
    if (!row || typeof row.key !== 'string' || typeof row.reason !== 'string' || row.reason.trim().length === 0) {
      throw new Error(`That backup's missing recording list could not be read`)
    }
    const origin = requireRecordingOrigin(row.origin)
    const storageAddress = requireStorageAddress(row.storageAddress)
    const key = recordingKey(origin)
    if (row.key !== key) throw new Error(`That backup's missing recording provenance does not match its key`)
    return { key, origin, storageAddress, reason: row.reason }
  })
  if (new Set(missing.map((entry) => entry.key)).size !== missing.length) {
    throw new Error('That backup names a duplicate missing recording origin')
  }
  if (missing.some((entry) => namedRecordings.some((recording) => recording.key === entry.key))) {
    throw new Error('That backup names a recording as both present and missing')
  }
  if (!types.includes('runs') && (namedRuns.length > 0 || namedRecordings.length > 0 || missing.length > 0)) {
    throw new Error('That backup contains roast history without naming the roast-history type')
  }
  const device = record(body.device) ?? {}
  const deviceId = typeof device.deviceId === 'string' ? device.deviceId.trim() : ''
  const modelId = typeof device.modelId === 'string' ? device.modelId.trim() : ''
  if (!deviceId) throw new Error('That backup does not identify its source device')
  if (!modelId) throw new Error('That backup does not identify its source model')
  const app = record(body.app) ?? {}
  const counts = record(body.counts)
  if (!counts) throw new Error(`That backup's counts could not be read`)

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : '',
    whole,
    types: [...types],
    app: {
      name: typeof app.name === 'string' ? app.name : 'Crackle',
      version: typeof app.version === 'string' ? app.version : 'unknown',
    },
    device: {
      deviceId,
      modelId,
      displayName:
        typeof device.displayName === 'string' && device.displayName.trim() ? device.displayName : 'Unknown roaster',
      firmwareVersion: typeof device.firmwareVersion === 'string' ? device.firmwareVersion : undefined,
      bootId: typeof device.bootId === 'string' ? device.bootId : undefined,
      usedBytes: finite(device.usedBytes),
      totalBytes: finite(device.totalBytes),
    },
    counts: {
      profiles: countValue(counts.profiles, 'profile'),
      beans: countValue(counts.beans, 'bean'),
      runs: countValue(counts.runs, 'roast record'),
      recordings: countValue(counts.recordings, 'recording'),
      calibrationPasses: countValue(counts.calibrationPasses, 'calibration pass'),
      calibrationSnapshots: countValue(counts.calibrationSnapshots, 'calibration snapshot'),
    },
    collections: COLLECTIONS.filter((name) => namedCollections.includes(name)),
    runs: namedRuns,
    recordings: namedRecordings,
    missingRecordings: missing,
  }

  const expectedEntryNames = new Set<string>([
    MANIFEST_PATH,
    ...manifest.collections.map((name) => `${COLLECTION_PREFIX}${name}.json`),
    ...manifest.runs.map((id) => `${RUN_PREFIX}${id}.json`),
    ...manifest.recordings.map((recording) => recording.file),
    ...(whole ? [APPLIED_CALIBRATION_PATH] : []),
  ])
  const absent = [...expectedEntryNames].find((name) => !entryNames.includes(name))
  if (absent) throw new Error(`That backup is missing "${absent}"`)
  const extra = entryNames.find((name) => !expectedEntryNames.has(name))
  if (extra) throw new Error(`That backup contains an unexpected file "${extra}"`)

  const decoder = new TextDecoder()
  const collections: Partial<Record<CollectionName, string>> = {}
  const runs: Array<{ id: string; payload: string }> = []
  const recordings = new Map<string, BackupRecording>()
  let appliedCalibration: AppliedCalibrationFile | undefined

  for (const entry of entries) {
    if (entry.name.startsWith(COLLECTION_PREFIX) && entry.name.endsWith('.json')) {
      const name = entry.name.slice(COLLECTION_PREFIX.length, -'.json'.length) as CollectionName
      if (COLLECTIONS.includes(name)) collections[name] = decoder.decode(entry.data)
    } else if (entry.name.startsWith(RUN_PREFIX) && entry.name.endsWith('.json')) {
      runs.push({ id: entry.name.slice(RUN_PREFIX.length, -'.json'.length), payload: decoder.decode(entry.data) })
    } else if (entry.name.startsWith(RECORDING_PREFIX) && entry.name.endsWith('.crk')) {
      const descriptor = manifest.recordings.find((recording) => recording.file === entry.name)
      if (!descriptor) throw new Error(`That backup contains an unexpected recording file "${entry.name}"`)
      recordings.set(descriptor.key, {
        key: descriptor.key,
        origin: descriptor.origin,
        storageAddress: descriptor.storageAddress,
        bytes: entry.data,
      })
    } else if (entry.name === APPLIED_CALIBRATION_PATH) {
      appliedCalibration = checkedAppliedCalibration(entry.data)
    }
  }

  /*
   * Every document is parsed once, here, so that "the file is readable" is a fact established before
   * the device is formatted rather than a hope held while it is being written to. A run document
   * that will not parse is not a run this restore can put back.
   */
  let profileCount = 0
  let beanCount = 0
  let calibrationPassCount = 0
  let calibrationSnapshotCount = 0
  for (const [name, payload] of Object.entries(collections) as Array<[CollectionName, string]>) {
    try {
      if (name === 'profiles') profileCount = parseProfilesDocument(payload).profiles.length
      else if (name === 'beans') beanCount = parseBeansDocument(payload).beans.length
      else if (name === 'calibrations') {
        const parsed = parseCalibrationsDocument(payload)
        calibrationPassCount = parsed.runs.length
        calibrationSnapshotCount = parsed.snapshots.length
      } else parseMetaDocument(payload)
    } catch {
      throw new Error(`The ${name} document inside that backup could not be read`)
    }
  }
  for (const run of runs) {
    try {
      const parsed = parseRunDocument(run.payload)
      if (typeof parsed.id !== 'string' || parsed.id !== run.id) throw new Error('id mismatch')
    } catch {
      throw new Error(`The roast record "${run.id}" inside that backup could not be read or has a different id`)
    }
  }

  const actualCounts: BackupCounts = {
    profiles: profileCount,
    beans: beanCount,
    runs: runs.length,
    recordings: recordings.size,
    calibrationPasses: calibrationPassCount,
    calibrationSnapshots: calibrationSnapshotCount,
  }
  for (const key of Object.keys(actualCounts) as Array<keyof BackupCounts>) {
    if (manifest.counts[key] !== actualCounts[key]) {
      throw new Error(`That backup's ${key} count does not match its contents`)
    }
  }

  return { manifest, collections, runs, recordings, appliedCalibration }
}

/** `crackle-backup-2026-07-28.zip`, or `crackle-profiles-2026-07-28.zip` for a single type. */
export const backupFileName = (types: BackupType[], createdAt: string): string => {
  const date = createdAt.slice(0, 10)
  if (types.length === BACKUP_TYPES.length) return `crackle-backup-${date}.zip`
  const slug =
    types.length === 1
      ? { profiles: 'profiles', beans: 'beans', runs: 'roast-history', calibrations: 'calibrations' }[types[0]]
      : 'export'
  return `crackle-${slug}-${date}.zip`
}
