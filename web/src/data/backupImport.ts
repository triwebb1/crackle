/**
 * ============================================================================================
 * IMPORTING A BACKUP INTO A LIBRARY THAT ALREADY HAS THINGS IN IT
 * ============================================================================================
 *
 * Requirement: when an import conflicts with the roaster's library, the user chooses once - keep the
 * device copy for every conflict, or take the imported copy for every conflict.
 *
 * One question, for the whole file, and it is asked only when there is something to ask about.
 * Everything else falls out of comparing by id:
 *
 *   - **absent on the roaster** - added. Nothing to ask; choosing the file is the request.
 *   - **present and byte-identical** - skipped, silently. Re-importing the file you just exported is
 *     a completely ordinary thing to do and it must not produce twenty-three questions about
 *     records that do not differ.
 *   - **present and different** - a CONFLICT, counted, named, and resolved by the one answer.
 *
 * This is emphatically not a merge. There is no field-level reconciliation and there never will be:
 * two versions of a roast record differ in ways only the user can rank, and an app that guessed
 * would produce a third version that neither copy ever had.
 *
 * --------------------------------------------------------------------------------------------
 * WHAT "IDENTICAL" MEANS, AND WHY A ROAST IS COMPARED AS A DOCUMENT
 * --------------------------------------------------------------------------------------------
 *
 * Key order is not information, so comparison is over a canonical rendering (`stableJson`) rather
 * than over `JSON.stringify`, which would call two identical records different because one of them
 * came back from IndexedDB with its fields in a different order.
 *
 * A ROAST is compared as the DOCUMENT it is stored as, not as the record the app is holding. The
 * reason is specific: a roast document carries only a bounded fallback curve, while the browser may
 * hydrate it from `/logs/<id>.crk` and hold the full-resolution series. Comparing the hydrated record
 * directly against the stored fallback instead of reserializing both sides as documents
 * would call every device-recorded roast in the library a conflict, every time, and the one question
 * would be asked about a difference that does not exist.
 *
 * --------------------------------------------------------------------------------------------
 * REVISIONS ARE HISTORY, AND HISTORY DOES NOT CONFLICT
 * --------------------------------------------------------------------------------------------
 *
 * A profile or bean revision row is an immutable record of an edit that happened. Two rows with the
 * same id are the same edit, so a revision is added when it is absent and left alone when it is not.
 * It is never a conflict and is never part of the count the question asks about.
 *
 * The CALIBRATION SETTINGS inside an imported `calibrations` document are deliberately ignored, and
 * that is not an oversight. Settings are one object rather than a list of identified records, so
 * there is no id to reconcile them by, and quietly replacing the roaster's tuning as a side effect of
 * importing somebody's saved calibrations is exactly the kind of surprise the one question exists to
 * prevent. Replacing the settings is a RESTORE, which says so in its own confirmation.
 */

import { formatLocalDateTime } from '../domain/dateTime'
import { recordingKey } from '../domain/provenance'
import type {
  BeanLot,
  BeanRevision,
  CalibrationRun,
  CalibrationSnapshot,
  Profile,
  ProfileRevision,
  RoastRun,
} from '../domain/types'
import { BACKUP_TYPES, type BackupType, type ParsedBackup } from './backupFile'
import {
  parseBeansDocument,
  parseCalibrationsDocument,
  parseProfilesDocument,
  parseRunDocument,
  serializeRunDocument,
  unpackDocumentJson,
} from './documentSerializer'

export type ConflictChoice = 'roaster' | 'import'

/** Every identified record a backup can carry, split by type. */
export interface LibrarySnapshot {
  profiles: Profile[]
  profileRevisions: ProfileRevision[]
  beans: BeanLot[]
  beanRevisions: BeanRevision[]
  runs: RoastRun[]
  snapshots: CalibrationSnapshot[]
  calibrationPasses: CalibrationRun[]
}

export const emptyLibrary = (): LibrarySnapshot => ({
  profiles: [],
  profileRevisions: [],
  beans: [],
  beanRevisions: [],
  runs: [],
  snapshots: [],
  calibrationPasses: [],
})

/** The documents in a backup, read back into records. Throws nothing: `parseBackup` already checked. */
export const backupLibrary = (backup: ParsedBackup): LibrarySnapshot => {
  const library = emptyLibrary()
  const profiles = backup.collections.profiles
  if (profiles !== undefined) {
    const document = parseProfilesDocument(profiles)
    library.profiles = document.profiles
    library.profileRevisions = document.profileRevisions
  }
  const beans = backup.collections.beans
  if (beans !== undefined) {
    const document = parseBeansDocument(beans)
    library.beans = document.beans
    library.beanRevisions = document.beanRevisions
  }
  const calibrations = backup.collections.calibrations
  if (calibrations !== undefined) {
    const document = parseCalibrationsDocument(calibrations)
    library.snapshots = document.snapshots
    library.calibrationPasses = document.runs
  }
  library.runs = backup.runs.map((run) => parseRunDocument(run.payload))
  return library
}

/** Canonical JSON: sorted keys, undefined dropped. Key order is not a difference. */
export const stableJson = (value: unknown): string => {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
}

interface Split<T> {
  added: T[]
  conflicting: T[]
  identical: T[]
}

/**
 * The comparison, with a form function PER SIDE.
 *
 * Two sides rather than one, because the two sides are not the same kind of thing for a roast: the
 * roaster's copy is a record the app is holding, the file's copy is the document that was stored.
 * See the header for why comparing them as records would call every device-recorded roast a
 * conflict; the fix is to compare both AS DOCUMENTS, which each side reaches differently.
 */
const splitWith = <T extends { id: string }, U extends { id: string }>(
  current: T[],
  incoming: U[],
  currentForm: (value: T) => string,
  incomingForm: (value: U) => string,
): Split<U> => {
  const known = new Map(current.map((row) => [row.id, currentForm(row)]))
  const result: Split<U> = { added: [], conflicting: [], identical: [] }
  for (const row of incoming) {
    const existing = known.get(row.id)
    if (existing === undefined) result.added.push(row)
    else if (existing === incomingForm(row)) result.identical.push(row)
    else result.conflicting.push(row)
  }
  return result
}

const split = <T extends { id: string }>(current: T[], incoming: T[], form: (value: T) => string): Split<T> =>
  splitWith(current, incoming, form, form)

/** One roast out of the file, carrying BOTH the record to write and the document to compare. */
interface RunItem {
  id: string
  run: RoastRun
  payload: string
}

const document = (payload: string): string => stableJson(JSON.parse(unpackDocumentJson(payload)) as unknown)
/** The roaster's copy, rendered as the document it is stored as. */
const storedForm = (run: RoastRun): string => document(serializeRunDocument(run))

const missing = <T extends { id: string }>(current: T[], incoming: T[]): T[] => {
  const known = new Set(current.map((row) => row.id))
  return incoming.filter((row) => !known.has(row.id))
}

export interface ConflictItem {
  type: BackupType
  id: string
  /** What the user would call it, so the question can name the first few rather than count them. */
  label: string
}

export interface ImportPlan {
  types: BackupType[]
  conflicts: ConflictItem[]
  added: number
  identical: number
  /** Recordings the file carries that the roaster does not have. */
  recordings: string[]
}

export interface ImportInput {
  backup: ParsedBackup
  incoming: LibrarySnapshot
  current: LibrarySnapshot
  /** Compound recording-origin keys currently present on the target. */
  deviceRecordingKeys: string[]
}

const splits = (input: ImportInput) => {
  const types = input.backup.manifest.types
  const wanted = (type: BackupType) => types.includes(type)
  const runItems: RunItem[] = wanted('runs')
    ? input.backup.runs.map((entry) => ({
        id: parseRunDocument(entry.payload).id,
        run: parseRunDocument(entry.payload),
        payload: entry.payload,
      }))
    : []
  return {
    types,
    profiles: wanted('profiles')
      ? split(input.current.profiles, input.incoming.profiles, stableJson)
      : split<Profile>([], [], stableJson),
    beans: wanted('beans')
      ? split(input.current.beans, input.incoming.beans, stableJson)
      : split<BeanLot>([], [], stableJson),
    runs: splitWith(input.current.runs, runItems, storedForm, (item) => document(item.payload)),
    snapshots: wanted('calibrations')
      ? split(input.current.snapshots, input.incoming.snapshots, stableJson)
      : split<CalibrationSnapshot>([], [], stableJson),
    passes: wanted('calibrations')
      ? split(input.current.calibrationPasses, input.incoming.calibrationPasses, stableJson)
      : split<CalibrationRun>([], [], stableJson),
    profileRevisions: wanted('profiles')
      ? missing(input.current.profileRevisions, input.incoming.profileRevisions)
      : [],
    beanRevisions: wanted('beans') ? missing(input.current.beanRevisions, input.incoming.beanRevisions) : [],
  }
}

/**
 * Recordings the file has and the roaster does not, for the roasts this import is bringing.
 *
 * Every roast in the file is considered, not only the ones being written: a recording is not an
 * edit anybody can disagree about, it is either on the volume or it is not, and a curve the roaster
 * has lost is worth putting back whichever way the one question was answered.
 */
const restorableRecordings = (input: ImportInput): string[] => {
  if (!input.backup.manifest.types.includes('runs')) return []
  const onDevice = new Set(input.deviceRecordingKeys)
  const wanted = new Set<string>()
  for (const run of input.incoming.runs) {
    const origin = run.deviceRoast?.recordingOrigin
    if (!origin) continue
    const key = recordingKey(origin)
    const recording = input.backup.recordings.get(key)
    if (recording && !onDevice.has(key)) wanted.add(key)
  }
  return [...wanted]
}

export const planImport = (input: ImportInput): ImportPlan => {
  const parts = splits(input)
  const conflicts: ConflictItem[] = [
    ...parts.profiles.conflicting.map((row) => ({ type: 'profiles' as const, id: row.id, label: row.name })),
    ...parts.beans.conflicting.map((row) => ({ type: 'beans' as const, id: row.id, label: row.name })),
    ...parts.runs.conflicting.map((item) => ({ type: 'runs' as const, id: item.id, label: item.run.name })),
    ...parts.snapshots.conflicting.map((row) => ({ type: 'calibrations' as const, id: row.id, label: row.name })),
    ...parts.passes.conflicting.map((row) => ({
      type: 'calibrations' as const,
      id: row.id,
      label: `Calibration pass ${formatLocalDateTime(row.capturedAt)}`,
    })),
  ]
  const added =
    parts.profiles.added.length +
    parts.beans.added.length +
    parts.runs.added.length +
    parts.snapshots.added.length +
    parts.passes.added.length +
    parts.profileRevisions.length +
    parts.beanRevisions.length
  const identical =
    parts.profiles.identical.length +
    parts.beans.identical.length +
    parts.runs.identical.length +
    parts.snapshots.identical.length +
    parts.passes.identical.length
  return {
    types: BACKUP_TYPES.filter((type) => parts.types.includes(type)),
    conflicts,
    added,
    identical,
    recordings: restorableRecordings(input),
  }
}

/** Exactly the records that have to be written, and nothing that does not. */
export interface ImportChanges {
  profiles: Profile[]
  profileRevisions: ProfileRevision[]
  beans: BeanLot[]
  beanRevisions: BeanRevision[]
  runs: RoastRun[]
  snapshots: CalibrationSnapshot[]
  calibrationPasses: CalibrationRun[]
  recordings: string[]
  /** Stable category/id keys let the apply layer report only writes that actually succeeded. */
  addedDocumentKeys: string[]
  replacedDocumentKeys: string[]
  /** Named so the outcome can be reported honestly rather than as "imported". */
  addedCount: number
  replacedCount: number
  keptCount: number
}

export const importChanges = (input: ImportInput, choice: ConflictChoice): ImportChanges => {
  const parts = splits(input)
  const take = <T extends { id: string }>(part: Split<T>): T[] =>
    choice === 'import' ? [...part.added, ...part.conflicting] : [...part.added]
  const conflicting =
    parts.profiles.conflicting.length +
    parts.beans.conflicting.length +
    parts.runs.conflicting.length +
    parts.snapshots.conflicting.length +
    parts.passes.conflicting.length
  const addedCount =
    parts.profiles.added.length +
    parts.beans.added.length +
    parts.runs.added.length +
    parts.snapshots.added.length +
    parts.passes.added.length +
    parts.profileRevisions.length +
    parts.beanRevisions.length
  const keys = <T extends { id: string }>(kind: string, rows: T[]) => rows.map((row) => `${kind}:${row.id}`)
  const addedDocumentKeys = [
    ...keys('profile', parts.profiles.added),
    ...keys('profile-revision', parts.profileRevisions),
    ...keys('bean', parts.beans.added),
    ...keys('bean-revision', parts.beanRevisions),
    ...keys('run', parts.runs.added),
    ...keys('snapshot', parts.snapshots.added),
    ...keys('calibration-pass', parts.passes.added),
  ]
  const replacedDocumentKeys =
    choice === 'import'
      ? [
          ...keys('profile', parts.profiles.conflicting),
          ...keys('bean', parts.beans.conflicting),
          ...keys('run', parts.runs.conflicting),
          ...keys('snapshot', parts.snapshots.conflicting),
          ...keys('calibration-pass', parts.passes.conflicting),
        ]
      : []
  return {
    profiles: take(parts.profiles),
    // Revision rows ride with their subject's type, and are added rather than reconciled.
    profileRevisions: parts.profileRevisions,
    beans: take(parts.beans),
    beanRevisions: parts.beanRevisions,
    runs: take(parts.runs).map((item) => item.run),
    snapshots: take(parts.snapshots),
    calibrationPasses: take(parts.passes),
    recordings: restorableRecordings(input),
    addedDocumentKeys,
    replacedDocumentKeys,
    addedCount,
    replacedCount: choice === 'import' ? conflicting : 0,
    keptCount: choice === 'import' ? 0 : conflicting,
  }
}
