import { ChevronRight, Download, Trash2, TriangleAlert, Upload } from 'lucide-preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { BACKUP_TYPE_LABELS, BACKUP_TYPES, type BackupType, type ParsedBackup, parseBackup } from '../data/backupFile'
import { requireWholeBackupForRestore } from '../data/backupImportApply'
import type { DataSyncState } from '../data/deviceStore'
import { formatLocalDateTime } from '../domain/dateTime'
import type { DeviceLogEntry, DeviceLogMode } from '../domain/deviceLogs'
import { formatBytes, recordingBytes, recordingPage, storageReport } from '../domain/storage'
import type {
  BeanLot,
  CalibrationRun,
  CalibrationSnapshot,
  ControllerStatus,
  Profile,
  RoasterIdentity,
  RoastRun,
} from '../domain/types'

/**
 * ============================================================================================
 * THE STORAGE PANEL - what is on the roaster, and what to do about it
 * ============================================================================================
 *
 * It answers four questions - how much storage there is, how much is used, how much is free, and
 * what is consuming it - with one summary bar, then a breakdown that stays folded until it is
 * wanted. Every number is the DEVICE's -
 * the arithmetic lives in `domain/storage.ts` and is tested there; this file only renders it.
 *
 * Two things this panel refuses to do, both deliberate:
 *
 *   - **It does not present the leftover bytes as free space.** The 64 KB write floor and the
 *     archive's 96 KB retention reserve are marked ON the bar, because "free" that can only be used
 *     by refusing a write or destroying an old recording is not free.
 *   - **It does not lead with the browser.** The browser is a cache; its size is one quiet line at
 *     the bottom, which is exactly how much it matters now that the controller is the database.
 *
 * --------------------------------------------------------------------------------------------
 * THREE KINDS OF THING, NAMED SO THEY CANNOT BE CONFUSED
 * --------------------------------------------------------------------------------------------
 *
 * Calibrations, recordings and roast records are easy to mistake for one another, but they are three
 * genuinely different objects, and three bare nouns would leave the reader to work out which is which.
 * Each group therefore heads its own list with a one-line definition, and the three definitions are
 * the vocabulary the whole app uses - Calibrate included:
 *
 *   - **Recordings** - the 1 Hz temperature logs the roaster captured while it ran.
 *   - **Roast records** - the roast's entry in your history: notes, weights, and what it links to.
 *   - **Saved calibrations** - fitted coefficient sets, produced by a calibration pass.
 *
 * There is no "Documents" group. That is the storage layer's word for the second group and it tells
 * a user nothing; the group is the library's records, so it says so.
 */

const dateOf = (iso?: string) => (iso ? formatLocalDateTime(iso) : undefined)

const percent = (value: number, total: number) => (total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0)

/** What made a recording, in user language rather than in the archive header's enum. */
const RECORDING_KIND: Record<DeviceLogMode, string> = {
  roast: 'Roast',
  manual: 'Manual session',
  calibration: 'Calibration pass',
  proof: 'Heater proof',
  none: 'Unclassified',
  unknown: 'Unclassified',
}

const recordingName = (entry: DeviceLogEntry) =>
  entry.name?.trim() ||
  `${RECORDING_KIND[entry.mode]} - ${entry.startedAt ? formatLocalDateTime(entry.startedAt) : `recording #${entry.id}`}`

const caret = (
  <span className="storage-caret" aria-hidden="true">
    <ChevronRight size={15} />
  </span>
)

export interface StoragePanelProps {
  status: ControllerStatus
  dataSync: DataSyncState
  deviceLogs: DeviceLogEntry[]
  /** False until the roaster's recording list has been read once; the panel says so instead of "none". */
  deviceLogsListed?: boolean
  importedLogIds: string[]
  runs: RoastRun[]
  profiles: Profile[]
  beans: BeanLot[]
  calibrationPasses: CalibrationRun[]
  snapshots: CalibrationSnapshot[]
  /** Assembles the whole-library backup and downloads it. Owned by the app: only the client fetches. */
  onExportEverything: () => Promise<string>
  /**
   * Recordings whose roast is already in this library, so the copy on the roaster is spare.
   *
   * The bulk offer lives here rather than in History because it is a decision about SPACE, and this
   * is the panel that shows how much there is. History keeps the per-recording control, on the row
   * that names the recording.
   */
  prunableLogIds?: string[]
  onPruneDeviceLogs?: (logIds: string[]) => void
  onDeleteRun?: (id: string) => void | Promise<unknown>
  onDeleteProfile?: (id: string) => void | Promise<unknown>
  onDeleteBean?: (id: string) => void | Promise<unknown>
  onDeleteCalibrationSnapshot?: (id: string) => void | Promise<unknown>
  /** One kind of thing on its own, in the same zip format a whole backup uses. */
  onExportType?: (type: BackupType) => Promise<string>
  /** Reads either kind of file and merges it, asking about conflicts exactly once. */
  onImportBackup?: (file: File) => Promise<string>
  /**
   * Replaces everything on the roaster with what is in the file. `onProgress` is handed back a line
   * per step, because a restore is twenty-odd sequential uploads and a spinner says nothing about
   * which one is in flight.
   */
  onRestoreBackup?: (file: File, onProgress: (line: string) => void) => Promise<string>
  /** Formats an unmounted device volume through the same exclusive boundary as restore. */
  onFormatStorage?: () => Promise<string>
  /** Why a restore cannot run right now - a roast in progress, mostly. Present means "not now". */
  restoreBlockedReason?: string
}

export const backupSummary = (backup: ParsedBackup): string => {
  const counts = backup.manifest.counts
  return [
    `${counts.profiles} profile${counts.profiles === 1 ? '' : 's'}`,
    `${counts.beans} bean lot${counts.beans === 1 ? '' : 's'}`,
    `${counts.runs} roast record${counts.runs === 1 ? '' : 's'}`,
    `${counts.recordings} thermal recording${counts.recordings === 1 ? '' : 's'}`,
    `${counts.calibrationSnapshots} saved calibration${counts.calibrationSnapshots === 1 ? '' : 's'}`,
  ].join(', ')
}

export const thermalRecordingResolution = (entry: Pick<DeviceLogEntry, 'intervalMs'>): string =>
  (entry.intervalMs ?? 1000) >= 10_000 ? 'Compact · every 10 s' : 'Detailed · every 1 s'

export const replacementUnitRestoreWarning = (backup: ParsedBackup, target?: RoasterIdentity): string => {
  const origin = backup.manifest.device
  if (!target || origin.modelId !== target.modelId || origin.deviceId === target.deviceId) return ''
  return `Replacement unit: this backup came from ${origin.displayName} (${origin.deviceId}), not this ${target.displayName} (${target.deviceId}). It includes device-specific calibration; review or recalibrate after restoring.`
}

export function StoragePanel({
  status,
  dataSync,
  deviceLogs,
  deviceLogsListed = true,
  importedLogIds,
  runs,
  profiles,
  beans,
  calibrationPasses,
  snapshots,
  onExportEverything,
  prunableLogIds = [],
  onPruneDeviceLogs,
  onDeleteRun,
  onDeleteProfile,
  onDeleteBean,
  onDeleteCalibrationSnapshot,
  onExportType,
  onImportBackup,
  onRestoreBackup,
  onFormatStorage,
  restoreBlockedReason,
}: StoragePanelProps) {
  const [exportBusy, setExportBusy] = useState(false)
  const [exportMessage, setExportMessage] = useState('')
  const [formatBusy, setFormatBusy] = useState(false)
  const [formatMessage, setFormatMessage] = useState('')
  const restoreInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const restoreLauncher = useRef<HTMLButtonElement>(null)
  const importLauncher = useRef<HTMLButtonElement>(null)
  const restoreDialog = useRef<HTMLElement>(null)
  const importDialog = useRef<HTMLElement>(null)
  const [restoreFile, setRestoreFile] = useState<File>()
  const [restorePreview, setRestorePreview] = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [restoreLine, setRestoreLine] = useState('')
  const [restoreMessage, setRestoreMessage] = useState('')
  const [selectedType, setSelectedType] = useState<BackupType>(BACKUP_TYPES[0])
  const [importFile, setImportFile] = useState<File>()
  const [importPreview, setImportPreview] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferMessage, setTransferMessage] = useState('')
  const [recordingPageIndex, setRecordingPageIndex] = useState(0)
  const [runPageIndex, setRunPageIndex] = useState(0)
  const [collectionPageIndex, setCollectionPageIndex] = useState(0)

  /** Run one file operation and say what happened, whichever way it went. Never a thrown blank. */
  const announce = (busy: (value: boolean) => void, say: (value: string) => void) => (work: Promise<string>) => {
    busy(true)
    say('')
    void work
      .then((message) => say(message))
      .catch((error: unknown) => say(error instanceof Error ? error.message : 'That could not be done'))
      .finally(() => busy(false))
  }
  const runTransfer = announce(setTransferBusy, setTransferMessage)
  const formatStorage = () => {
    if (!onFormatStorage || restoreBlockedReason || formatBusy) return
    const needsFormat = status.logArchive?.needsFormat === true
    const confirmation = needsFormat
      ? 'Format storage on this roaster?\n\nThis permanently erases all profiles, beans, roasts, recordings, and calibrations on the roaster. It cannot be undone.'
      : 'Restart storage setup on this roaster?\n\nCrackle cannot prove what an interrupted maintenance operation already wrote. A fresh format safely starts over, permanently erasing all profiles, beans, roasts, recordings, and calibrations on the roaster.'
    if (!window.confirm(confirmation)) return
    setFormatBusy(true)
    setFormatMessage('')
    void onFormatStorage()
      .then(setFormatMessage)
      .catch((error: unknown) =>
        setFormatMessage(error instanceof Error ? error.message : 'Storage could not be formatted'),
      )
      .finally(() => setFormatBusy(false))
  }

  const report = useMemo(
    () =>
      storageReport({
        dataStore: status.dataStore,
        archive: status.logArchive,
        logs: deviceLogs,
        importedLogIds: new Set(importedLogIds),
        runs,
        profiles,
        beans,
        runBytes: dataSync.runBytes,
        calibrationPasses,
        snapshots,
      }),
    [
      beans,
      calibrationPasses,
      dataSync.runBytes,
      deviceLogs,
      importedLogIds,
      profiles,
      runs,
      snapshots,
      status.dataStore,
      status.logArchive,
    ],
  )

  const recordingResults = useMemo(
    () => recordingPage(deviceLogs, '', recordingPageIndex),
    [deviceLogs, recordingPageIndex],
  )
  const prunable = useMemo(() => new Set(prunableLogIds), [prunableLogIds])
  const pageSize = 10
  const orderedRuns = useMemo(() => [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [runs])
  const runPageCount = Math.max(1, Math.ceil(orderedRuns.length / pageSize))
  const visibleRunPage = Math.min(runPageIndex, runPageCount - 1)
  const visibleRuns = orderedRuns.slice(visibleRunPage * pageSize, (visibleRunPage + 1) * pageSize)
  const collectionItems = useMemo(
    () =>
      [
        ...profiles.map((item) => ({ kind: 'profile' as const, id: item.id, name: item.name, date: item.updatedAt })),
        ...beans.map((item) => ({
          kind: 'bean' as const,
          id: item.id,
          name: item.name,
          date: item.updatedAt ?? item.createdAt,
        })),
        ...snapshots.map((item) => ({
          kind: 'calibration' as const,
          id: item.id,
          name: item.name,
          date: item.createdAt,
        })),
      ].sort((a, b) => b.date.localeCompare(a.date)),
    [beans, profiles, snapshots],
  )
  const collectionPageCount = Math.max(1, Math.ceil(collectionItems.length / pageSize))
  const visibleCollectionPage = Math.min(collectionPageIndex, collectionPageCount - 1)
  const visibleCollections = collectionItems.slice(
    visibleCollectionPage * pageSize,
    (visibleCollectionPage + 1) * pageSize,
  )

  const volume = report.volume

  const inspectRestore = async (file: File | undefined) => {
    setRestoreFile(undefined)
    setRestorePreview('')
    setRestoreMessage('')
    if (!file) return
    try {
      const backup = parseBackup(new Uint8Array(await file.arrayBuffer()))
      requireWholeBackupForRestore(backup, {
        totalBytes: volume.totalBytes,
        writeFloorBytes: volume.writeFloorBytes,
        identity: status.roaster,
      })
      setRestoreFile(file)
      const replacementWarning = replacementUnitRestoreWarning(backup, status.roaster)
      setRestorePreview([backupSummary(backup), replacementWarning].filter(Boolean).join(' · '))
    } catch (error) {
      setRestoreMessage(error instanceof Error ? error.message : 'That backup could not be validated')
    }
  }

  const cancelRestore = () => {
    if (restoreBusy) return
    setRestoreFile(undefined)
    setRestorePreview('')
    window.requestAnimationFrame(() => restoreLauncher.current?.focus())
  }

  const confirmRestore = () => {
    const file = restoreFile
    if (!file || !onRestoreBackup) return
    setRestoreBusy(true)
    setRestoreMessage('')
    setRestoreLine('revalidating the backup')
    void onRestoreBackup(file, setRestoreLine)
      .then((message) => {
        setRestoreMessage(message)
        setRestoreFile(undefined)
        setRestorePreview('')
        window.requestAnimationFrame(() => restoreLauncher.current?.focus())
      })
      .catch((error: unknown) =>
        setRestoreMessage(
          error instanceof Error
            ? error.message
            : 'The restore could not be started, and nothing on the roaster was changed',
        ),
      )
      .finally(() => {
        setRestoreBusy(false)
        setRestoreLine('')
      })
  }

  const inspectImport = async (file: File | undefined) => {
    setImportFile(undefined)
    setImportPreview('')
    setTransferMessage('')
    if (!file) return
    try {
      const backup = parseBackup(new Uint8Array(await file.arrayBuffer()))
      if (backup.manifest.whole || backup.manifest.types.length !== 1 || backup.manifest.types[0] !== selectedType) {
        throw new Error(`Choose a ${BACKUP_TYPE_LABELS[selectedType]} export. Complete backups belong in Restore.`)
      }
      setImportFile(file)
      setImportPreview(backupSummary(backup))
    } catch (error) {
      setTransferMessage(error instanceof Error ? error.message : 'That export could not be validated')
    }
  }

  const cancelImport = () => {
    if (transferBusy) return
    setImportFile(undefined)
    setImportPreview('')
    window.requestAnimationFrame(() => importLauncher.current?.focus())
  }

  const confirmImport = () => {
    const file = importFile
    if (!file || !onImportBackup) return
    setImportFile(undefined)
    setImportPreview('')
    window.requestAnimationFrame(() => importLauncher.current?.focus())
    runTransfer(onImportBackup(file))
  }

  const dialogFocusable = (activeDialog: HTMLElement | null) =>
    Array.from(
      activeDialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    )
  // Which dialog is open. The first control is focused when a dialog OPENS, never again on a busy
  // change - refocusing on every restore/transfer busy flip yanked focus back while it was in use.
  const openDialog = restoreFile ? 'restore' : importFile ? 'import' : ''
  useEffect(() => {
    if (!openDialog) return
    const activeDialog = openDialog === 'restore' ? restoreDialog.current : importDialog.current
    const focusFrame = window.requestAnimationFrame(() => dialogFocusable(activeDialog)[0]?.focus())
    return () => window.cancelAnimationFrame(focusFrame)
  }, [openDialog])

  useEffect(() => {
    if (!restoreFile && !importFile) return
    const activeDialog = restoreFile ? restoreDialog.current : importDialog.current
    const focusable = () => dialogFocusable(activeDialog)
    const containDialogFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (restoreFile && !restoreBusy) cancelRestore()
        else if (importFile && !transferBusy) cancelImport()
        return
      }
      if (event.key !== 'Tab') return
      const controls = focusable()
      if (controls.length === 0) {
        event.preventDefault()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || !activeDialog?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !activeDialog?.contains(document.activeElement))
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', containDialogFocus)
    return () => window.removeEventListener('keydown', containDialogFocus)
  }, [importFile, restoreBusy, restoreFile, transferBusy])

  if (!report.present) {
    return (
      <section className="storage-volume" aria-label="Storage on the roaster">
        <div className="storage-note" role="status">
          <strong>Storage on the roaster</strong> — the roaster did not report its storage details, so storage
          management is unavailable.
        </div>
      </section>
    )
  }
  const recoveryIncomplete = status.restoreMaintenance?.incomplete === true
  if (report.recordings.needsFormat || recoveryIncomplete) {
    const needsFormat = report.recordings.needsFormat
    return (
      <section className="storage-volume" aria-label="Storage on the roaster">
        <div className="storage-volume-head">
          <div>
            <span className="eyebrow">On the roaster</span>
            <strong>{needsFormat ? 'Storage needs setup' : 'Storage maintenance was interrupted'}</strong>
          </div>
          <span className="storage-free">{needsFormat ? 'Not mounted' : 'Maintenance locked'}</span>
        </div>
        <div className="storage-lost" role="alert">
          <TriangleAlert size={18} />
          <div>
            <strong>{needsFormat ? "The roaster's storage did not mount" : 'Restart with empty storage'}</strong>
            <span>
              {needsFormat
                ? 'Format storage before recording. This initializes an empty library and permanently erases any profiles, beans, roasts, recordings, and calibrations still on the volume.'
                : 'Crackle cannot prove whether the interrupted operation was a format or a partial backup restore. Format a fresh empty library before recording or editing.'}
            </span>
            {restoreBlockedReason && <small>{restoreBlockedReason}</small>}
            {onFormatStorage && (
              <button
                type="button"
                className="secondary-button"
                disabled={formatBusy || restoreBlockedReason !== undefined}
                onClick={formatStorage}
              >
                {formatBusy ? 'Formatting...' : needsFormat ? 'Format storage' : 'Restart storage setup'}
              </button>
            )}
            {formatMessage && <span role="status">{formatMessage}</span>}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="storage-volume" aria-label="Storage on the roaster">
      <div className="storage-volume-head">
        <div>
          <span className="eyebrow">On the roaster</span>
          <strong>
            {formatBytes(volume.usedBytes)} used of {formatBytes(volume.totalBytes)}
          </strong>
        </div>
        <span className="storage-free">{formatBytes(volume.usableFreeBytes)} usable</span>
      </div>

      <div
        className="storage-bar"
        role="img"
        aria-label={`${formatBytes(volume.recordingBytes)} thermal recordings, ${formatBytes(volume.dataBytes)} roast and catalog records, ${formatBytes(volume.otherBytes)} other, ${formatBytes(volume.usableFreeBytes)} usable free, ${formatBytes(volume.writeFloorBytes)} kept back`}
      >
        <span className="bar-recordings" style={{ width: `${percent(volume.recordingBytes, volume.totalBytes)}%` }} />
        <span className="bar-documents" style={{ width: `${percent(volume.dataBytes, volume.totalBytes)}%` }} />
        <span className="bar-other" style={{ width: `${percent(volume.otherBytes, volume.totalBytes)}%` }} />
        <span className="bar-free" style={{ width: `${percent(volume.usableFreeBytes, volume.totalBytes)}%` }} />
        <span
          className="bar-reserve"
          style={{ width: `${percent(volume.retentionReserveBytes, volume.totalBytes)}%` }}
        />
        <span className="bar-floor" style={{ width: `${percent(volume.nextRecordingBytes, volume.totalBytes)}%` }} />
      </div>
      <ul className="storage-legend">
        <li>
          <span className="key bar-recordings" />
          Thermal recordings {formatBytes(volume.recordingBytes)}
        </li>
        <li>
          <span className="key bar-documents" />
          Roast and catalog records {formatBytes(volume.dataBytes)}
        </li>
        {volume.otherBytes > 0 && (
          <li>
            <span className="key bar-other" />
            Other {formatBytes(volume.otherBytes)}
          </li>
        )}
        <li>
          <span className="key bar-free" />
          Usable free {formatBytes(volume.usableFreeBytes)}
        </li>
        <li>
          <span className="key bar-reserve" />
          Retention reserve {formatBytes(volume.retentionReserveBytes)}
        </li>
        <li>
          <span className="key bar-floor" />
          Room for the next recording {formatBytes(volume.nextRecordingBytes)}
        </li>
      </ul>
      <p className="storage-note">
        The roaster keeps {formatBytes(volume.writeFloorBytes)} available for safe writes and the next thermal
        recording. This reserved space is not counted as usable.
      </p>
      <div className="storage-capacity" role="status">
        {report.capacity.moreRoasts === undefined ? (
          'Nothing has been recorded yet, so there is no measured size to estimate from.'
        ) : (
          <>
            Room for roughly <strong>{report.capacity.moreRoasts} more recorded roasts</strong> at the current average
            of {formatBytes(Math.round(report.capacity.perRoastBytes))} each.
          </>
        )}
      </div>

      {report.recordings.lostLogs > 0 && (
        <div className="storage-lost" role="alert">
          <TriangleAlert size={18} />
          <div>
            <strong>
              {report.recordings.lostLogs} recording{report.recordings.lostLogs === 1 ? '' : 's'} could not be saved
            </strong>
            <span>The roasts ran, but their thermal recordings did not reach storage.</span>
          </div>
        </div>
      )}

      <details className="storage-group">
        <summary>
          {caret}
          <span>Thermal recordings</span>
          <strong>
            {deviceLogsListed ? `${report.recordings.count} / ${formatBytes(report.recordings.bytes)}` : 'Reading…'}
          </strong>
        </summary>
        {/*
        All-or-nothing: until the roaster's recording list has been read
        once, this section is an explicit loading state rather than an empty archive that later
        mutates into a populated one.
      */}
        {!deviceLogsListed ? (
          <div className="empty-state" role="status">
            Reading the roaster&apos;s recordings… The list appears when it is complete.
          </div>
        ) : (
          <>
            <div className="storage-detail-note">
              These are temperature logs stored by the roaster. Detailed recordings sample every second; Compact
              recordings sample every 10 seconds. Deleting either frees device space; an imported roast record keeps its
              compact review curve.
            </div>
            <dl className="storage-detail">
              <div>
                <dt>Largest</dt>
                <dd>
                  {report.recordings.largest
                    ? `#${report.recordings.largest.id} at ${formatBytes(report.recordings.largest.bytes)}${dateOf(report.recordings.largest.startedAt) ? `, ${dateOf(report.recordings.largest.startedAt)}` : ''}`
                    : '--'}
                </dd>
              </div>
              <div>
                <dt>Oldest</dt>
                <dd>
                  {report.recordings.oldest
                    ? `#${report.recordings.oldest.id}${dateOf(report.recordings.oldest.startedAt) ? `, ${dateOf(report.recordings.oldest.startedAt)}` : ' (date not recorded)'}`
                    : '--'}
                </dd>
              </div>
            </dl>
            {recordingResults.totalMatches > 0 ? (
              <table className="diff-table storage-table">
                <caption>
                  {recordingResults.totalMatches} thermal recording{recordingResults.totalMatches === 1 ? '' : 's'}
                </caption>
                <thead>
                  <tr>
                    <th>Recording</th>
                    <th>Date</th>
                    <th className="numeric">Size</th>
                    <th>Kind</th>
                    <th>Resolution</th>
                    <th>Remove from roaster</th>
                  </tr>
                </thead>
                <tbody>
                  {recordingResults.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        #{entry.id} {recordingName(entry)}
                      </td>
                      <td>{dateOf(entry.startedAt) ?? 'Not recorded'}</td>
                      <td className="numeric">{formatBytes(recordingBytes(entry))}</td>
                      <td>{RECORDING_KIND[entry.mode]}</td>
                      <td>{thermalRecordingResolution(entry)}</td>
                      <td>
                        {onPruneDeviceLogs && prunable.has(entry.id) ? (
                          <button
                            type="button"
                            className="secondary-button storage-recording-delete"
                            aria-label={`Delete thermal recording ${entry.name ? entry.name : `#${entry.id}`}`}
                            title={
                              entry.mode === 'calibration' || entry.mode === 'proof'
                                ? 'Deletes the thermal recording from the roaster; the preserved calibration evidence row remains.'
                                : 'Deletes the thermal recording from the roaster; the roast record and compact curve remain.'
                            }
                            onClick={() => onPruneDeviceLogs([entry.id])}
                          >
                            <Trash2 size={16} />
                            Delete
                          </button>
                        ) : onPruneDeviceLogs ? (
                          entry.mode === 'roast' || entry.mode === 'manual' ? (
                            <span
                              className="storage-delete-blocked"
                              title="Crackle must first preserve this recording as a roast record with a compact review curve. Open History to retry that save, then return here to delete the thermal recording."
                            >
                              <strong>Not ready to delete</strong>
                              <small>Open History to preserve its compact curve first.</small>
                            </span>
                          ) : (
                            <span
                              className="storage-delete-blocked"
                              title="Open Calibrate and add this recording as evidence first. Once its useful data is preserved there, return here to delete the thermal recording."
                            >
                              <strong>Not ready to delete</strong>
                              <small>Preserve it in Calibrate first.</small>
                            </span>
                          )
                        ) : (
                          <span
                            className="storage-delete-blocked"
                            title="This version of the roaster does not provide a recording-delete action."
                          >
                            <strong>Unavailable</strong>
                            <small>This firmware cannot delete recordings.</small>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty-state">No thermal recordings.</div>
            )}
            {recordingResults.totalMatches > 0 && (
              <div className="storage-transfer">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={recordingResults.pageIndex === 0}
                  onClick={() => setRecordingPageIndex(recordingResults.pageIndex - 1)}
                >
                  Previous
                </button>
                <span>
                  Page {recordingResults.pageIndex + 1} of {recordingResults.pageCount}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={recordingResults.pageIndex + 1 >= recordingResults.pageCount}
                  onClick={() => setRecordingPageIndex(recordingResults.pageIndex + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </details>

      <details className="storage-group">
        <summary>
          {caret}
          <span>Roast records</span>
          <strong>
            {report.roasts.count} / {formatBytes(report.roasts.bytes)}
          </strong>
        </summary>
        <div className="storage-detail-note">
          A roast record is the history entry: bean lot, profile snapshot, notes, measurements, and compact review
          curve. Its thermal recording is managed separately above.
        </div>
        {visibleRuns.length > 0 ? (
          <table className="diff-table storage-table storage-item-table">
            <caption>
              {orderedRuns.length} roast record{orderedRuns.length === 1 ? '' : 's'}, newest first
            </caption>
            <thead>
              <tr>
                <th>Roast</th>
                <th>Date</th>
                <th className="numeric">Size</th>
                <th>
                  <span className="visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRuns.map((run) => (
                <tr key={run.id}>
                  <td>{run.name}</td>
                  <td>{dateOf(run.startedAt) ?? 'Not recorded'}</td>
                  <td className="numeric">{formatBytes(dataSync.runBytes[run.id])}</td>
                  <td>
                    {onDeleteRun && (
                      <button
                        type="button"
                        className="icon-button danger-icon storage-trash"
                        aria-label={`Delete roast record ${run.name}`}
                        title="Delete this roast record. Its thermal recording, if present, remains on the roaster."
                        onClick={() =>
                          window.confirm(
                            `Delete roast record ${run.name}? Its thermal recording, if present, remains on the roaster.`,
                          ) && void onDeleteRun(run.id)
                        }
                      >
                        <Trash2 size={17} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No roast records.</div>
        )}
        {orderedRuns.length > pageSize && (
          <div className="storage-pagination">
            <button
              type="button"
              className="secondary-button"
              disabled={visibleRunPage === 0}
              onClick={() => setRunPageIndex(visibleRunPage - 1)}
            >
              Previous
            </button>
            <span>
              Page {visibleRunPage + 1} of {runPageCount}
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={visibleRunPage + 1 >= runPageCount}
              onClick={() => setRunPageIndex(visibleRunPage + 1)}
            >
              Next
            </button>
          </div>
        )}
      </details>

      <details className="storage-group">
        <summary>
          {caret}
          <span>Profiles, beans, and saved calibrations</span>
          <strong>{formatBytes(report.collections.reduce((total, entry) => total + entry.bytes, 0))}</strong>
        </summary>
        <div className="storage-detail-note">
          Deleting a catalog item does not rewrite historical roast snapshots. Deleting a saved calibration does not
          change the calibration currently applied on the roaster.
        </div>
        {visibleCollections.length > 0 ? (
          <table className="diff-table storage-table storage-item-table">
            <caption>
              {collectionItems.length} saved catalog item{collectionItems.length === 1 ? '' : 's'}
            </caption>
            <thead>
              <tr>
                <th>Item</th>
                <th>Type</th>
                <th>Date</th>
                <th>
                  <span className="visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleCollections.map((item) => {
                const remove =
                  item.kind === 'profile'
                    ? onDeleteProfile
                    : item.kind === 'bean'
                      ? onDeleteBean
                      : onDeleteCalibrationSnapshot
                const noun =
                  item.kind === 'profile' ? 'profile' : item.kind === 'bean' ? 'bean lot' : 'saved calibration'
                const consequence =
                  item.kind === 'calibration'
                    ? 'The calibration currently applied on the roaster will not change.'
                    : 'Historical roasts keep their recorded snapshot.'
                return (
                  <tr key={`${item.kind}-${item.id}`}>
                    <td>{item.name}</td>
                    <td>{noun}</td>
                    <td>{dateOf(item.date) ?? 'Not recorded'}</td>
                    <td>
                      {remove && (
                        <button
                          type="button"
                          className="icon-button danger-icon storage-trash"
                          aria-label={`Delete ${noun} ${item.name}`}
                          title={`Delete this ${noun}. ${consequence}`}
                          onClick={() =>
                            window.confirm(`Delete ${noun} ${item.name}? ${consequence}`) && void remove(item.id)
                          }
                        >
                          <Trash2 size={17} />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No profiles, bean lots, or saved calibrations.</div>
        )}
        {collectionItems.length > pageSize && (
          <div className="storage-pagination">
            <button
              type="button"
              className="secondary-button"
              disabled={visibleCollectionPage === 0}
              onClick={() => setCollectionPageIndex(visibleCollectionPage - 1)}
            >
              Previous
            </button>
            <span>
              Page {visibleCollectionPage + 1} of {collectionPageCount}
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={visibleCollectionPage + 1 >= collectionPageCount}
              onClick={() => setCollectionPageIndex(visibleCollectionPage + 1)}
            >
              Next
            </button>
          </div>
        )}
      </details>

      <div className="storage-export">
        <div>
          <strong>Back up your data</strong>
          <span>
            One zip file containing every profile, bean lot, roast record, thermal recording, and calibration stored by
            the roaster.
          </span>
          <small>
            Last backed up: {dataSync.lastExportedAt ? new Date(dataSync.lastExportedAt).toLocaleString() : 'never'}.
          </small>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={exportBusy}
          onClick={() => {
            setExportBusy(true)
            setExportMessage('')
            void onExportEverything()
              .then(setExportMessage)
              .catch((error: unknown) =>
                setExportMessage(error instanceof Error ? error.message : 'The backup could not be assembled'),
              )
              .finally(() => setExportBusy(false))
          }}
        >
          <Download size={17} />
          {exportBusy ? 'Assembling...' : 'Back up now'}
        </button>
      </div>
      {exportMessage && (
        <div className="storage-note" role="status">
          {exportMessage}
        </div>
      )}

      {onRestoreBackup && (
        <div className="storage-export">
          <div>
            <strong>Restore a backup</strong>
            <span>
              This completely replaces every profile, bean lot, roast record, thermal recording, saved calibration, and
              the applied calibration on the roaster.
            </span>
            <small>
              {restoreBlockedReason ??
                'Choose a complete backup. Crackle validates it and shows its contents before anything can be written.'}
            </small>
            <input
              ref={restoreInput}
              type="file"
              accept=".zip,application/zip"
              hidden
              aria-label="Backup file to restore"
              disabled={restoreBusy || restoreBlockedReason !== undefined}
              onChange={(event) => {
                void inspectRestore(event.currentTarget.files?.[0])
                event.currentTarget.value = ''
              }}
            />
          </div>
          <button
            type="button"
            ref={restoreLauncher}
            className="secondary-button"
            disabled={restoreBusy || restoreBlockedReason !== undefined}
            onClick={() => restoreInput.current?.click()}
          >
            <Upload size={17} />
            {restoreBusy ? 'Restoring...' : 'Restore from backup'}
          </button>
        </div>
      )}
      {restoreFile && restorePreview && (
        <div className="modal-backdrop" role="presentation">
          <section
            ref={restoreDialog}
            className="diff-dialog storage-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-confirm-title"
          >
            <div className="diff-dialog-heading">
              <div>
                <span className="eyebrow">Validated backup</span>
                <h2 id="restore-confirm-title">Replace all data on the roaster?</h2>
              </div>
            </div>
            <div className="storage-confirm-body">
              <div className="storage-confirm-file">
                <strong>{restoreFile.name}</strong>
                <span>{restorePreview}</span>
              </div>
              <p>
                This erases the current profiles, beans, roast records, thermal recordings, and calibrations, then
                replaces them with this backup.
              </p>
            </div>
            <div className="diff-actions">
              <button type="button" className="secondary-button" disabled={restoreBusy} onClick={cancelRestore}>
                Cancel
              </button>
              <button
                type="button"
                className="command-button stop-command"
                disabled={restoreBusy || restoreBlockedReason !== undefined}
                onClick={confirmRestore}
              >
                {restoreBusy ? 'Restoring...' : 'Replace data and restore'}
              </button>
            </div>
          </section>
        </div>
      )}
      {restoreBusy && restoreLine && (
        <div className="storage-note" role="status">
          Restoring: {restoreLine}.
        </div>
      )}
      {restoreMessage && (
        <div className="storage-note" role="status">
          {restoreMessage}
        </div>
      )}

      {(onExportType || onImportBackup) && (
        <div className="storage-export">
          <div>
            <strong>Import or export by data type</strong>
            <span>Choose one data type, then export it or validate an export before adding it to the roaster.</span>
            <div className="storage-transfer storage-transfer-row">
              <select
                aria-label="Data type"
                value={selectedType}
                disabled={transferBusy}
                onInput={(event) => {
                  setSelectedType(event.currentTarget.value as BackupType)
                  setImportFile(undefined)
                  setImportPreview('')
                  setTransferMessage('')
                }}
              >
                {BACKUP_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {BACKUP_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              {onImportBackup && (
                <>
                  <input
                    ref={importInput}
                    type="file"
                    accept=".zip,application/zip"
                    hidden
                    aria-label="Data export to import"
                    disabled={transferBusy}
                    onChange={(event) => {
                      void inspectImport(event.currentTarget.files?.[0])
                      event.currentTarget.value = ''
                    }}
                  />
                  <button
                    type="button"
                    ref={importLauncher}
                    className="secondary-button"
                    disabled={transferBusy}
                    onClick={() => importInput.current?.click()}
                  >
                    <Upload size={16} />
                    Import
                  </button>
                </>
              )}
              {onExportType && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={transferBusy}
                  onClick={() => runTransfer(onExportType(selectedType))}
                >
                  <Download size={16} />
                  Export
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {importFile && importPreview && (
        <div className="modal-backdrop" role="presentation">
          <section
            ref={importDialog}
            className="diff-dialog storage-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-confirm-title"
          >
            <div className="diff-dialog-heading">
              <div>
                <span className="eyebrow">Validated export</span>
                <h2 id="import-confirm-title">Add this data to the roaster?</h2>
              </div>
            </div>
            <div className="storage-confirm-body">
              <div className="storage-confirm-file">
                <strong>{importFile.name}</strong>
                <span>{importPreview}</span>
              </div>
              <p>
                Existing records with matching identities will be updated. Other records on the roaster remain
                unchanged.
              </p>
            </div>
            <div className="diff-actions">
              <button type="button" className="secondary-button" disabled={transferBusy} onClick={cancelImport}>
                Cancel
              </button>
              <button type="button" className="primary-button" disabled={transferBusy} onClick={confirmImport}>
                {transferBusy ? 'Importing...' : 'Confirm import'}
              </button>
            </div>
          </section>
        </div>
      )}
      {transferMessage && (
        <div className="storage-note" role="status">
          {transferMessage}
        </div>
      )}
    </section>
  )
}
