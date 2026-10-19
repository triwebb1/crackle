export interface BackupExportCompletion {
  shouldMarkExported: boolean
  notice: string
}

/**
 * Select recordings that exist on the roaster now.
 *
 * A run may retain a recording id after archive retention prunes the full-resolution file; its run
 * document carries the compact fallback and that absence is not a failed backup. A whole backup
 * therefore follows the fresh archive inventory exactly. A partial run export intersects with that
 * inventory when available, and falls back to probing its references only when no inventory exists.
 */
export const recordingIdsForBackup = (
  whole: boolean,
  archiveAvailable: boolean,
  archiveIds: readonly string[],
  runRecordingIds: readonly string[],
): string[] => {
  if (whole && !archiveAvailable) {
    throw new Error(
      'The roaster recording list could not be read, so a complete backup was not created. Reconnect to the roaster and try again.',
    )
  }
  if (whole) return [...new Set(archiveIds)]
  if (!archiveAvailable) return [...new Set(runRecordingIds)]
  const available = new Set(archiveIds)
  return [...new Set(runRecordingIds.filter((id) => available.has(id)))]
}

/**
 * A whole-backup timestamp is evidence that every recording was captured, not
 * merely that a zip download started. Keep that state transition and the
 * user-facing result wording driven by the same decision.
 */
export const backupExportCompletion = (whole: boolean, missingRecordingCount: number): BackupExportCompletion => {
  if (missingRecordingCount === 0) return { shouldMarkExported: whole, notice: '' }
  const recordings = `${missingRecordingCount} recording${missingRecordingCount === 1 ? '' : 's'}`
  return {
    shouldMarkExported: false,
    notice: ` Incomplete backup: ${recordings} could not be read and ${missingRecordingCount === 1 ? 'is' : 'are'} named in the manifest. This file was not marked as a successful whole backup.`,
  }
}
