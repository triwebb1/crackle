/**
 * ============================================================================================
 * RESTORE: THE ROASTER BECOMES WHAT THE FILE SAYS
 * ============================================================================================
 *
 * A restore completely replaces everything on the device; that is the intended behavior. There is
 * no merge here, no conflict question and no per-record decision - that is `backupImport.ts`, which
 * is a different feature for a different requirement. A restore formats the
 * volume and writes the file over it.
 *
 * --------------------------------------------------------------------------------------------
 * THE ORDER, AND WHY IT IS THIS ORDER
 * --------------------------------------------------------------------------------------------
 *
 *   0. **Read the whole file first.** `parseBackup` runs before this function is ever called: the
 *      zip is unpacked, every CRC checked, the manifest read, and every document parsed. A file that
 *      will not read has then cost the user nothing. The same discovery made one step later would
 *      have cost them the volume, and "the backup turned out to be unreadable AFTER I erased the
 *      roaster" is the one outcome this feature may not have.
 *   1. **Require idle**, and refuse otherwise. Checked by the caller against status, and by the
 *      firmware again on every write it receives.
 *   2. **`POST /api/logs/format`** - one call, both trees. Recordings and `/data` share the volume,
 *      so this is what "completely override" actually is.
 *   3. **Non-meta collections at `base=0`**, which after a format is the only base that can be right: `base=0`
 *      means "I am creating this; it must not exist", and nothing exists.
 *   4. **Recordings, one at a time.** Each raw archive body is streamed to a temp path, validated in a
 *      bounded window, then atomically renamed. Sequential writes keep progress and failure reports
 *      attached to one recording and avoid interleaving two flash transactions.
 *   5. **Run documents**, after their recordings, so a roast record never points at a recording that
 *      is not there yet.
 *   6. **Meta last**, after removing a newly restored recording from the imported-log ledger when
 *      its run document failed. Pre-existing tombstones for other recordings remain untouched.
 *   7. **The applied calibration**, through the endpoint that already exists for it.
 *
 * --------------------------------------------------------------------------------------------
 * A FAILURE PART-WAY THROUGH IS REPORTED, NOT HIDDEN AND NOT FATAL
 * --------------------------------------------------------------------------------------------
 *
 * The firmware's half of this is deliberately stateless - "a restore is N independent, individually
 * confirmed writes, and a failure at N-1 leaves the N-2 that succeeded exactly as they landed" - so
 * the browser's half is built the same way. Only the FORMAT is fatal: if the volume was not erased,
 * everything after it would be writing at the wrong base against documents that still exist, so that
 * one throws.
 *
 * Everything else continues and is counted. A recording refusal is not retried blindly: the
 * raw archive endpoint's structural, capacity and volume-reserve refusals are deterministic, and the
 * client does not expose a typed transport-only failure that could be retried safely. It is named at
 * the end and the other twenty-two carry on. Twenty-two recordings restored plus one named failure
 * is a far better outcome than a restore that stopped at the ninth and said "error".
 *
 * But a restore with a missing DOCUMENT is not a finished restore. Every failure carries its kind,
 * and when any document write failed after the format boundary (`restoreLeftDocumentsMissing`) the
 * caller must NOT commit restore maintenance: committing would publish a partial library as the
 * roaster's authoritative one. Maintenance stays incomplete, the failed items are named, and the
 * user restores again. A refused recording (deterministic: size, capacity, structure) and the
 * applied calibration are reported but do not block the commit.
 */

import type { DeviceCoefficients } from '../domain/deviceLogs'
import { recordingKey } from '../domain/provenance'
import type { ParsedBackup } from './backupFile'
import type { RecordingRestoreResult } from './backupImportApply'
import type { DocumentWrite } from './deviceStore'
import {
  type CollectionName,
  type DocumentTarget,
  parseMetaDocument,
  parseRunDocument,
  serializeMetaDocument,
  serializeRunDocument,
} from './documentSerializer'

export interface RestoreCommandResult {
  ok: boolean
  message?: string
}

/** What a restore needs from the controller. Implemented by `HttpControllerClient`, faked in tests. */
export interface RestoreClient {
  /** `POST /api/logs/format?confirm=FORMAT_LOGS` - recordings and `/data`, one volume. */
  formatDeviceStorage(): Promise<RestoreCommandResult>
  writeDocument(target: DocumentTarget, payload: string, base: number): Promise<DocumentWrite>
  /** `POST /api/logs/restore?id=..&confirm=RESTORE_LOG`, raw archive body. */
  restoreDeviceLog(id: string, bytes: Uint8Array): Promise<RecordingRestoreResult>
  applyCalibration(
    coefficients: {
      heaterGainCPerMinAt10: number
      fanCoolingCPerMinAt10: number
      coolingFanCPerMinAt10: number
      thermalLossPerMinPerC: number
    },
    fitId: string,
  ): Promise<RestoreCommandResult>
  clearDeviceCalibration(): Promise<RestoreCommandResult>
}

export interface RestoreFailure {
  /** `document`: a library document write failed - the restored library is incomplete. */
  kind: 'document' | 'recording' | 'calibration'
  what: string
  message: string
}

export interface RestoreOutcome {
  collections: number
  runs: number
  recordings: number
  calibration: 'applied' | 'cleared' | 'skipped' | 'failed'
  failures: RestoreFailure[]
  /** One sentence, honest about both halves. */
  message: string
}

const writeFailure = (result: DocumentWrite): string => {
  if (result.kind === 'busy') return result.message ?? 'the roaster is running or recording'
  if (result.kind === 'unreachable') return 'the roaster did not answer'
  if (result.kind === 'unmounted') return "the roaster's storage is not mounted"
  if (result.kind === 'too-large') return result.message ?? 'it is too large for the roaster to store'
  if (result.kind === 'no-space') return result.message ?? 'the roaster is out of room'
  if (result.kind === 'conflict') return 'something else wrote to the roaster during the restore'
  if (result.kind === 'error') return result.message
  return 'the roaster refused it'
}

/** The four coefficients, or nothing when the file does not carry a complete plausible set. */
const coefficientSet = (coefficients: DeviceCoefficients | undefined) => {
  const heaterGainCPerMinAt10 = coefficients?.heaterGainCPerMinAt10
  const fanCoolingCPerMinAt10 = coefficients?.fanCoolingCPerMinAt10
  const coolingFanCPerMinAt10 = coefficients?.coolingFanCPerMinAt10
  const thermalLossPerMinPerC = coefficients?.thermalLossPerMinPerC
  if (
    heaterGainCPerMinAt10 === undefined ||
    fanCoolingCPerMinAt10 === undefined ||
    coolingFanCPerMinAt10 === undefined ||
    thermalLossPerMinPerC === undefined
  )
    return undefined
  return { heaterGainCPerMinAt10, fanCoolingCPerMinAt10, coolingFanCPerMinAt10, thermalLossPerMinPerC }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

export const restoreBackup = async (
  backup: ParsedBackup,
  client: RestoreClient,
  onProgress: (line: string) => void = () => {},
  onFormatted: () => void = () => {},
): Promise<RestoreOutcome> => {
  const failures: RestoreFailure[] = []

  onProgress('erasing the roaster')
  const formatted = await client.formatDeviceStorage()
  // The one fatal step. Nothing after this is meaningful against a volume that was not erased.
  if (!formatted.ok)
    throw new Error(formatted.message ?? 'The roaster would not erase its storage, so nothing was changed')
  onFormatted()

  const collections = (Object.entries(backup.collections) as Array<[CollectionName, string]>).filter(
    ([name]) => name !== 'meta',
  )
  let collectionsWritten = 0
  for (const [name, payload] of collections) {
    onProgress(`restoring the ${name} document`)
    const result = await client.writeDocument(name, payload, 0)
    if (result.kind === 'ok') collectionsWritten += 1
    else failures.push({ kind: 'document', what: `the ${name} document`, message: writeFailure(result) })
  }

  const recordings = [...backup.recordings.values()]
  const restoredRecordingKeys = new Set<string>()
  const restoredAddresses = new Map<string, NonNullable<RecordingRestoreResult['storageAddress']>>()
  let recordingsWritten = 0
  for (const [index, recording] of recordings.entries()) {
    const label = `${recording.origin.deviceId} #${recording.origin.logId}`
    onProgress(`restoring recording ${index + 1} of ${recordings.length}`)
    const result = await client.restoreDeviceLog('auto', recording.bytes)
    const returnedOriginKey = result.recordingOrigin ? recordingKey(result.recordingOrigin) : recording.key
    if (result.ok && result.storageAddress && returnedOriginKey === recording.key) {
      recordingsWritten += 1
      restoredRecordingKeys.add(recording.key)
      restoredAddresses.set(recording.key, result.storageAddress)
    } else
      failures.push({
        kind: 'recording',
        what: `recording ${label}`,
        message:
          result.message ??
          (result.ok ? 'the roaster did not report the new storage address' : 'the roaster refused it'),
      })
  }

  const failedRestoredRunLogIds = new Set<string>()
  let runsWritten = 0
  for (const [index, run] of backup.runs.entries()) {
    onProgress(`restoring roast record ${index + 1} of ${backup.runs.length}`)
    const parsed = parseRunDocument(run.payload)
    const origin = parsed.deviceRoast?.recordingOrigin
    const key = origin ? recordingKey(origin) : undefined
    // A run remains recoverable when its full-resolution recording had already been pruned before
    // the backup was made: current run documents carry a compact fallback curve. Only withhold the
    // run when this backup actually contained the recording and that restore attempt failed.
    if (
      key !== undefined &&
      backup.recordings.has(key) &&
      !restoredRecordingKeys.has(key) &&
      parsed.samples.length === 0
    ) {
      failures.push({
        kind: 'recording',
        what: `the roast record "${run.id}"`,
        message: `its recording ${origin?.deviceId} #${origin?.logId} was not restored`,
      })
      continue
    }
    const storageAddress = key ? restoredAddresses.get(key) : undefined
    const rewritten =
      storageAddress && parsed.deviceRoast
        ? { ...parsed, deviceRoast: { ...parsed.deviceRoast, storageAddress } }
        : parsed
    const payload = storageAddress ? serializeRunDocument(rewritten) : run.payload
    const result = await client.writeDocument(`runs/${run.id}`, payload, 0)
    if (result.kind === 'ok') runsWritten += 1
    else {
      if (key !== undefined && restoredRecordingKeys.has(key)) failedRestoredRunLogIds.add(key)
      failures.push({ kind: 'document', what: `the roast record "${run.id}"`, message: writeFailure(result) })
    }
  }
  const metaPayload = backup.collections.meta
  if (metaPayload !== undefined) {
    onProgress('restoring the meta document')
    const meta = parseMetaDocument(metaPayload)
    const payload =
      failedRestoredRunLogIds.size === 0
        ? metaPayload
        : serializeMetaDocument(
            meta.importedDeviceLogs.filter((id) => !failedRestoredRunLogIds.has(id)),
            meta.manualEvents,
            meta.lastExportedAt,
          )
    const result = await client.writeDocument('meta', payload, 0)
    if (result.kind === 'ok') collectionsWritten += 1
    else failures.push({ kind: 'document', what: 'the meta document', message: writeFailure(result) })
  }

  let calibration: RestoreOutcome['calibration'] = 'skipped'
  const applied = backup.appliedCalibration
  if (applied !== undefined) {
    onProgress('restoring the applied calibration')
    const set = applied.present ? coefficientSet(applied.coefficients) : undefined
    const result = set
      ? await client.applyCalibration(set, applied.coefficients?.fitId ?? 'restored')
      : await client.clearDeviceCalibration()
    if (!result.ok) {
      calibration = 'failed'
      failures.push({
        kind: 'calibration',
        what: 'the applied calibration',
        message: result.message ?? 'the roaster refused it',
      })
    } else {
      calibration = set ? 'applied' : 'cleared'
    }
  }

  const restored = `Restored ${plural(collectionsWritten, 'document')}, ${plural(runsWritten, 'roast record')} and ${plural(recordingsWritten, 'recording')} onto the roaster`
  const calibrationLine =
    calibration === 'applied'
      ? ", and applied the backup's calibration"
      : calibration === 'cleared'
        ? ', and cleared the applied calibration as the backup had none'
        : ''
  const trouble =
    failures.length === 0
      ? '.'
      : `. ${plural(failures.length, 'item')} could not be written: ${failures.map((failure) => `${failure.what} (${failure.message})`).join('; ')}.`
  return {
    collections: collectionsWritten,
    runs: runsWritten,
    recordings: recordingsWritten,
    calibration,
    failures,
    message: `${restored}${calibrationLine}${trouble}`,
  }
}

/** Any library document that failed to write after the erase: the restore must not be committed. */
export const restoreLeftDocumentsMissing = (outcome: Pick<RestoreOutcome, 'failures'>): RestoreFailure[] =>
  outcome.failures.filter((failure) => failure.kind === 'document')

/** The user-facing refusal to commit a restore that left documents missing. */
export const incompleteRestoreMessage = (outcome: Pick<RestoreOutcome, 'failures'>): string => {
  const missing = restoreLeftDocumentsMissing(outcome)
  return (
    `The restore was not completed, so the roaster's library was not committed: ${plural(missing.length, 'document')} could not be written - ` +
    `${missing.map((failure) => `${failure.what} (${failure.message})`).join('; ')}. Restore the backup again once the roaster is idle.`
  )
}
