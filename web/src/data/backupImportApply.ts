import { implausibleCoefficient } from '../controller/client'
import { recordingKey } from '../domain/provenance'
import { ARCHIVE_RETENTION_RESERVE_BYTES, VOLUME_WRITE_FLOOR_BYTES } from '../domain/storage'
import type {
  BeanLot,
  BeanRevision,
  CalibrationRun,
  CalibrationSnapshot,
  Profile,
  ProfileRevision,
  RecordingOrigin,
  RecordingStorageAddress,
  RoasterIdentity,
  RoastRun,
} from '../domain/types'
import type { ParsedBackup } from './backupFile'
import type { ImportChanges } from './backupImport'
import { validateCrkRecording } from './crkValidator'
import type { DataSyncState } from './deviceStore'
import { byteLength, COLLECTION_CAP_BYTES, parseRunDocument, RUN_CAP_BYTES } from './documentSerializer'

export interface RecordingRestoreResult {
  ok: boolean
  message?: string
  recordingOrigin?: RecordingOrigin
  storageAddress?: RecordingStorageAddress
}

export interface RecordingImportClient {
  restoreDeviceLog(id: string, bytes: Uint8Array): Promise<RecordingRestoreResult>
}

export interface ImportDataWriter {
  saveProfile(value: Profile): Promise<unknown>
  saveProfileRevision(value: ProfileRevision): Promise<unknown>
  saveBean(value: BeanLot): Promise<unknown>
  saveBeanRevision(value: BeanRevision): Promise<unknown>
  saveRun(value: RoastRun): Promise<unknown>
  saveCalibrationSnapshot(value: CalibrationSnapshot): Promise<unknown>
  saveCalibrationRun(value: CalibrationRun): Promise<unknown>
  flushPending(): Promise<void>
  syncState(): Pick<DataSyncState, 'queued' | 'message'>
}

export interface ImportApplyFailure {
  what: string
  message: string
}
export interface ImportApplyOutcome {
  recordingsRestored: number
  documentsSaved: number
  addedDocumentsSaved: number
  replacedDocumentsSaved: number
  skippedRunIds: string[]
  failures: ImportApplyFailure[]
  queued: number
  syncMessage?: string
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'the operation failed')

export interface RestoreTargetCapacity {
  totalBytes?: number
  writeFloorBytes?: number
  identity?: RoasterIdentity
}

export const requireWholeBackupForRestore = (backup: ParsedBackup, target?: RestoreTargetCapacity) => {
  if (target && !target.identity) {
    throw new Error(
      'The connected roaster has not reported a stable device and model identity. Restore was stopped before anything was erased.',
    )
  }
  if (target?.identity && backup.manifest.device.modelId !== target.identity.modelId) {
    throw new Error(
      `This backup describes ${backup.manifest.device.displayName} (${backup.manifest.device.modelId}), not the connected ${target.identity.displayName} (${target.identity.modelId}). Restore was stopped before anything was erased.`,
    )
  }
  if (!backup.manifest.whole) {
    throw new Error(
      'That file is a partial export. Use Import for profiles, bean lots, roast history, or saved calibrations; Restore only accepts a complete backup.',
    )
  }
  const missing = backup.manifest.missingRecordings ?? []
  if (missing.length > 0) {
    const ids = missing.map((entry) => `${entry.origin.deviceId} #${entry.origin.logId}`).join(', ')
    throw new Error(
      `That complete backup is missing ${missing.length} recording${missing.length === 1 ? '' : 's'} (${ids}). Restore would erase the roaster while knowingly omitting ${missing.length === 1 ? 'that curve' : 'those curves'}; use Import instead.`,
    )
  }
  for (const [name, payload] of Object.entries(backup.collections)) {
    const bytes = byteLength(payload ?? '')
    if (bytes > COLLECTION_CAP_BYTES) {
      throw new Error(
        `The ${name} document is ${bytes} bytes, but the roaster accepts at most ${COLLECTION_CAP_BYTES}. Restore was stopped before anything was erased.`,
      )
    }
  }
  for (const run of backup.runs) {
    const bytes = byteLength(run.payload)
    if (bytes > RUN_CAP_BYTES) {
      throw new Error(
        `Roast record “${run.id}” is ${bytes} bytes, but the roaster accepts at most ${RUN_CAP_BYTES}. Restore was stopped before anything was erased.`,
      )
    }
  }
  for (const descriptor of backup.manifest.recordings ?? []) {
    const recording = backup.recordings.get(descriptor.key)
    if (!recording) {
      throw new Error(
        `Recording ${descriptor.origin.deviceId} #${descriptor.origin.logId} has no byte payload. Restore was stopped before anything was erased; use Import to preserve or inspect the rest of this backup.`,
      )
    }
    const validation = validateCrkRecording(recording.bytes, descriptor.storageAddress.logId)
    if (!validation.ok) {
      throw new Error(
        `Recording ${descriptor.origin.deviceId} #${descriptor.origin.logId} failed ${validation.check}: ${validation.message}. Restore was stopped before anything was erased; use Import to preserve or inspect this file.`,
      )
    }
    if (recordingKey(validation.summary.recordingOrigin) !== recordingKey(descriptor.origin)) {
      throw new Error(
        `Recording ${descriptor.origin.deviceId} #${descriptor.origin.logId} does not match the immutable origin in its archive header (${validation.summary.recordingOrigin.deviceId} #${validation.summary.recordingOrigin.logId}). Restore was stopped before anything was erased; use Import to preserve or inspect this file.`,
      )
    }
  }
  const capturedRecordingIds = new Set(backup.recordings.keys())
  for (const stored of backup.runs) {
    const run = parseRunDocument(stored.payload)
    const origin = run.deviceRoast?.recordingOrigin
    const key = origin ? recordingKey(origin) : undefined
    if (key !== undefined && !capturedRecordingIds.has(key) && run.samples.length === 0) {
      throw new Error(
        `Roast record “${run.id}” points to recording ${origin?.deviceId} #${origin?.logId}, but neither that recording nor a fallback curve is present. Restore was stopped before anything was erased.`,
      )
    }
  }
  const applied = backup.appliedCalibration
  if (applied?.present && applied.coefficients) {
    const heaterGainCPerMinAt10 = applied.coefficients.heaterGainCPerMinAt10
    const fanCoolingCPerMinAt10 = applied.coefficients.fanCoolingCPerMinAt10
    const coolingFanCPerMinAt10 = applied.coefficients.coolingFanCPerMinAt10
    const thermalLossPerMinPerC = applied.coefficients.thermalLossPerMinPerC
    if (
      heaterGainCPerMinAt10 === undefined ||
      fanCoolingCPerMinAt10 === undefined ||
      coolingFanCPerMinAt10 === undefined ||
      thermalLossPerMinPerC === undefined
    ) {
      throw new Error('The applied calibration is incomplete. Restore was stopped before anything was erased.')
    }
    const implausible = implausibleCoefficient({
      heaterGainCPerMinAt10,
      fanCoolingCPerMinAt10,
      coolingFanCPerMinAt10,
      thermalLossPerMinPerC,
    })
    if (implausible)
      throw new Error(
        `The applied calibration is not safe to restore: ${implausible}. Restore was stopped before anything was erased.`,
      )
  }

  if (target) {
    const total = target.totalBytes
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
      throw new Error(
        'The roaster did not report its LittleFS capacity, so this backup cannot be safely restored without risking a late out-of-space failure.',
      )
    }
    // Include each CDOC envelope and a small filesystem metadata allowance. Documents land first;
    // they must leave the write floor. The complete restored volume must also leave archive reserve.
    // The source's measured used bytes, when present, are a stronger bound because they include the
    // real LittleFS metadata/page overhead rather than an estimate. Source volume SIZE is irrelevant:
    // a lightly used larger device can safely restore onto a smaller device when its contents fit.
    const documentPayloadBytes =
      Object.values(backup.collections).reduce((sum, payload) => sum + byteLength(payload ?? '') + 16, 0) +
      backup.runs.reduce((sum, run) => sum + byteLength(run.payload) + 16, 0)
    const recordingBytes = [...backup.recordings.values()].reduce(
      (sum, recording) => sum + recording.bytes.byteLength,
      0,
    )
    const floor =
      typeof target.writeFloorBytes === 'number' && target.writeFloorBytes > 0
        ? target.writeFloorBytes
        : VOLUME_WRITE_FLOOR_BYTES
    const filesystemHeadroom = 4096
    const sourceUsed = backup.manifest.device?.usedBytes
    const measuredSourceRequirement =
      typeof sourceUsed === 'number' && Number.isFinite(sourceUsed) && sourceUsed >= 0
        ? sourceUsed + ARCHIVE_RETENTION_RESERVE_BYTES
        : 0
    const required =
      Math.max(
        documentPayloadBytes + floor,
        documentPayloadBytes + recordingBytes + ARCHIVE_RETENTION_RESERVE_BYTES,
        measuredSourceRequirement,
      ) + filesystemHeadroom
    if (required > total) {
      throw new Error(
        `This restore conservatively needs ${required} bytes of LittleFS capacity, but the roaster reports ${total}. Restore was stopped before anything was erased.`,
      )
    }
  }
}

export const applyBackupImport = async (
  changes: ImportChanges,
  backup: ParsedBackup,
  client: RecordingImportClient,
  data: ImportDataWriter,
  canRestoreRecordings: boolean,
): Promise<ImportApplyOutcome> => {
  if (changes.recordings.length > 0 && !canRestoreRecordings) {
    throw new Error(
      'This import needs to restore recordings. Wait until the roaster is connected and fully stopped, then import it again.',
    )
  }

  const failures: ImportApplyFailure[] = []
  const failedRecordingKeys = new Set<string>()
  const restoredAddresses = new Map<string, RecordingStorageAddress>()
  let recordingsRestored = 0
  for (const key of changes.recordings) {
    const recording = backup.recordings.get(key)
    const label = recording ? `${recording.origin.deviceId} #${recording.origin.logId}` : key
    if (!recording) {
      failedRecordingKeys.add(key)
      failures.push({ what: `recording ${label}`, message: 'the backup did not contain its bytes' })
      continue
    }
    try {
      const result = await client.restoreDeviceLog('auto', recording.bytes)
      const returnedOriginKey = result.recordingOrigin ? recordingKey(result.recordingOrigin) : key
      if (result.ok && result.storageAddress && returnedOriginKey === key) {
        recordingsRestored += 1
        restoredAddresses.set(key, result.storageAddress)
      } else {
        failedRecordingKeys.add(key)
        failures.push({
          what: `recording ${label}`,
          message:
            result.message ??
            (result.ok ? 'the roaster did not report the new storage address' : 'the roaster refused it'),
        })
      }
    } catch (error) {
      failedRecordingKeys.add(key)
      failures.push({ what: `recording ${label}`, message: errorMessage(error) })
    }
  }

  const skippedRunIds: string[] = []
  const safeRuns = changes.runs.flatMap((run): RoastRun[] => {
    const origin = run.deviceRoast?.recordingOrigin
    const key = origin ? recordingKey(origin) : undefined
    if (key !== undefined && failedRecordingKeys.has(key) && (run.samples?.length ?? 0) === 0) {
      skippedRunIds.push(run.id)
      return []
    }
    const storageAddress = key ? restoredAddresses.get(key) : undefined
    if (storageAddress && run.deviceRoast) {
      return [{ ...run, deviceRoast: { ...run.deviceRoast, storageAddress } }]
    }
    return [run]
  })
  const writes: Array<{ key: string; what: string; save: () => Promise<unknown> }> = [
    ...changes.profiles.map((value) => ({
      key: `profile:${value.id}`,
      what: `profile “${value.name}”`,
      save: () => data.saveProfile(value),
    })),
    ...changes.profileRevisions.map((value) => ({
      key: `profile-revision:${value.id}`,
      what: `profile revision “${value.id}”`,
      save: () => data.saveProfileRevision(value),
    })),
    ...changes.beans.map((value) => ({
      key: `bean:${value.id}`,
      what: `bean lot “${value.name}”`,
      save: () => data.saveBean(value),
    })),
    ...changes.beanRevisions.map((value) => ({
      key: `bean-revision:${value.id}`,
      what: `bean-lot revision “${value.id}”`,
      save: () => data.saveBeanRevision(value),
    })),
    ...safeRuns.map((value) => ({
      key: `run:${value.id}`,
      what: `roast record “${value.name}”`,
      save: () => data.saveRun(value),
    })),
    ...changes.snapshots.map((value) => ({
      key: `snapshot:${value.id}`,
      what: `saved calibration “${value.name}”`,
      save: () => data.saveCalibrationSnapshot(value),
    })),
    ...changes.calibrationPasses.map((value) => ({
      key: `calibration-pass:${value.id}`,
      what: `calibration pass “${value.id}”`,
      save: () => data.saveCalibrationRun(value),
    })),
  ]

  let documentsSaved = 0
  let addedDocumentsSaved = 0
  let replacedDocumentsSaved = 0
  const addedKeys = new Set(changes.addedDocumentKeys)
  const replacedKeys = new Set(changes.replacedDocumentKeys)
  for (const write of writes) {
    try {
      await write.save()
      documentsSaved += 1
      if (addedKeys.has(write.key)) addedDocumentsSaved += 1
      if (replacedKeys.has(write.key)) replacedDocumentsSaved += 1
    } catch (error) {
      failures.push({ what: write.what, message: errorMessage(error) })
    }
  }
  try {
    await data.flushPending()
  } catch (error) {
    failures.push({ what: 'the remaining queued changes', message: errorMessage(error) })
  }
  const sync = data.syncState()
  return {
    recordingsRestored,
    documentsSaved,
    addedDocumentsSaved,
    replacedDocumentsSaved,
    skippedRunIds,
    failures,
    queued: sync.queued,
    syncMessage: sync.message,
  }
}
