import { Check, Copy, Download, GitCompareArrows, RotateCcw, Save, Trash2, Upload } from 'lucide-preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { downloadFile } from '../data/download'
import { type ParsedArchive, parseArchive } from '../domain/archive'
import { formatTableDateTime } from '../domain/dateTime'
import { stableEquals } from '../domain/draft'
import { correctedLegacyRunName, formatClock, runDurationSec } from '../domain/model'
import { formatMetric, roastMetrics } from '../domain/roastMetrics'
import { runScore } from '../domain/roastScore'
import type { BatchMeasurements, RoastRun } from '../domain/types'
import { DataTable } from './DataTable'
import { LiveChart } from './LiveChart'
import { NumberField } from './NumberField'
import {
  RoasterSourceBadge,
  type RoasterSourceFilter,
  RoasterSourceFilterControl,
  sourceMatches,
} from './RoasterSource'
import { ScorePicker } from './ScorePicker'
import { TextArea } from './TextField'

const SAVED_NOTICE_MS = 2500

/**
 * The hottest the bean ever got, not the last thing the log happened to record.
 *
 * The last sample (`samples.at(-1)?.beanTempC`) is the temperature the beans had cooled BACK DOWN
 * to by the time the recording stopped. Every roast keeps sampling through any authored fan-only
 * tail and through the passive decay after it, so that number is routinely a hundred degrees below
 * what the roast actually reached - it describes the end of the recording, not the end of the
 * roast. The column is therefore the MAXIMUM.
 *
 * The maximum is also the only definition that survives a mid-roast dip. A roast pulled back and
 * then driven up again has two peaks, and "the last sample" reports whichever the tail happened to
 * land on; the max reports the roast. Timed and journey share the definition exactly, because the
 * peak is a property of the temperature record and not of the strategy that produced it.
 *
 * Non-finite samples are skipped rather than propagated: a dropped thermocouple reading is an
 * absence, and one NaN would poison both the displayed number and the column's sort order.
 *
 * Exported because it is the column's `value` accessor - the thing sorting reads - so pinning the
 * definition pins the sort, which no static render of a collapsed table could reach.
 */
export const peakTemperature = (run: RoastRun): number | undefined => {
  let peak: number | undefined
  for (const sample of run.samples) {
    const value = sample.beanTempC
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (peak === undefined || value > peak) peak = value
  }
  return peak
}

interface HistoryViewProps {
  runs: RoastRun[]
  overlayId?: string
  onOverlay: (id?: string) => void
  onDelete: (id: string) => void
  onSaveDetails: (
    id: string,
    measurements: BatchMeasurements,
    notes: string,
    score: number | undefined,
  ) => Promise<void>
  /** Whether any roast here holds edits that exist only in this tab. Drives the leave guard. */
  onDirtyChange?: (dirty: boolean) => void

  onImport: (archive: ParsedArchive) => Promise<string>
  onUseAsProfile: (run: RoastRun) => void
  onRoastAgain?: (run: RoastRun) => void
  focusRunId?: string
  activeRoasterId?: string
  activeRoasterName?: string
  /**
   * Why this run's expanded record may not render yet, when it may not. A record staged at Start
   * completes from the device recording; until run document, recording linkage, and reconciliation
   * have all settled, the expanded detail is an explicit loading state carrying this reason - never
   * a partial record that mutates in place.
   */
  detailPendingReason?: (run: RoastRun) => string | undefined
}

/**
 * The archive as a table.
 *
 * A full-height card per roast, carrying four measurement inputs, a notes textarea and four
 * buttons, makes nine roasts a page of scrolling. The row is one line - the things you scan for -
 * and everything you only need occasionally lives in the expanded detail.
 *
 * There is no **Overrides** column: no part of the product produces an override event, so it would
 * read 0 on every row forever. There is no per-row CSV export either. The remaining JSON transfer is deliberately named "history":
 * Settings owns the full-device zip backup and restore path, and calling this one "Export all"
 * made two materially different workflows look interchangeable.
 */
export function HistoryView({
  runs,
  overlayId,
  onOverlay,
  onDelete,
  onSaveDetails,
  onDirtyChange,
  onImport,
  onUseAsProfile,
  onRoastAgain,
  focusRunId,
  activeRoasterId,
  activeRoasterName,
  detailPendingReason,
}: HistoryViewProps) {
  const linkedRun = focusRunId ? runs.find((run) => run.id === focusRunId) : undefined
  const linkedRunNeedsAllSources = Boolean(linkedRun && linkedRun.recordedOn.deviceId !== activeRoasterId)
  const [sourceFilter, setSourceFilter] = useState<RoasterSourceFilter>(linkedRunNeedsAllSources ? 'all' : 'active')
  useEffect(() => {
    if (linkedRunNeedsAllSources) setSourceFilter('all')
  }, [focusRunId, linkedRunNeedsAllSources])
  const visibleRuns = useMemo(
    () => runs.filter((run) => sourceMatches(run.recordedOn, sourceFilter, activeRoasterId)),
    [activeRoasterId, runs, sourceFilter],
  )
  const [importMessage, setImportMessage] = useState('')
  const [importError, setImportError] = useState('')
  const [importInFlight, setImportInFlight] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const exportAll = () =>
    downloadFile(
      `crackle-history-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ format: 'crackle-history', version: 1, exportedAt: new Date().toISOString(), runs }, null, 2),
      'application/json',
    )

  const importArchive = async (file: File | undefined) => {
    if (!file) return
    setImportInFlight(true)
    setImportError('')
    setImportMessage('Adding history to the roaster...')
    try {
      const archive = parseArchive(await file.text())
      const message = await onImport(archive)
      setImportMessage(message || 'No new roast records were added')
    } catch (error) {
      setImportMessage('')
      setImportError(error instanceof Error ? error.message : 'That file could not be added')
    } finally {
      setImportInFlight(false)
    }
  }

  /**
   * Measurements and notes are one visible draft and one explicit, batched write. Typing and blur
   * never contact the roaster. A failed Save keeps the complete draft in place and waits for the
   * user to press Save changes again; there is no background retry or unmount flush.
   */
  type PendingDetails = {
    measurements: BatchMeasurements
    notes: string
    score: number | undefined
    revision: number
    saving: boolean
  }
  type DetailSavePhase = 'unsaved' | 'saving' | 'failed'
  const [savedRuns, setSavedRuns] = useState<Record<string, boolean>>({})
  const [savePhases, setSavePhases] = useState<Record<string, DetailSavePhase | undefined>>({})
  const [saveErrors, setSaveErrors] = useState<Record<string, string | undefined>>({})
  const pending = useRef<Record<string, PendingDetails>>({})
  const savedTimers = useRef<Record<string, number>>({})
  const saveDetailsRef = useRef(onSaveDetails)
  useEffect(() => {
    saveDetailsRef.current = onSaveDetails
  }, [onSaveDetails])

  const markSaved = (runId: string) => {
    window.clearTimeout(savedTimers.current[runId])
    setSavePhases((current) => ({ ...current, [runId]: undefined }))
    setSaveErrors((current) => ({ ...current, [runId]: undefined }))
    setSavedRuns((current) => ({ ...current, [runId]: true }))
    savedTimers.current[runId] = window.setTimeout(() => {
      setSavedRuns((current) => ({ ...current, [runId]: false }))
      delete savedTimers.current[runId]
    }, SAVED_NOTICE_MS)
  }

  async function savePending(runId: string) {
    // Commit the field being typed in first; its blur writes the draft synchronously (a ref).
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const draft = pending.current[runId]
    if (!draft || draft.saving) return
    draft.saving = true
    setSavePhases((current) => ({ ...current, [runId]: 'saving' }))
    setSaveErrors((current) => ({ ...current, [runId]: undefined }))
    const revision = draft.revision
    try {
      await saveDetailsRef.current(runId, { ...draft.measurements }, draft.notes, draft.score)
      const latest = pending.current[runId]
      if (!latest) return
      latest.saving = false
      if (latest.revision === revision) {
        delete pending.current[runId]
        markSaved(runId)
      } else {
        setSavePhases((current) => ({ ...current, [runId]: 'unsaved' }))
      }
    } catch (error) {
      const latest = pending.current[runId]
      if (!latest) return
      latest.saving = false
      setSavePhases((current) => ({ ...current, [runId]: latest.revision === revision ? 'failed' : 'unsaved' }))
      setSaveErrors((current) => ({
        ...current,
        [runId]: error instanceof Error ? error.message : 'The roaster did not acknowledge these changes.',
      }))
    }
  }

  const queueDetails = (run: RoastRun, measurements: BatchMeasurements, notes: string, score: number | undefined) => {
    const current = pending.current[run.id]
    // An edit that puts every field back to what the roaster already holds is not unsaved work.
    if (
      !current?.saving &&
      notes === run.notes &&
      score === runScore(run) &&
      stableEquals(measurements, run.measurements ?? {})
    ) {
      delete pending.current[run.id]
      setSavePhases((phases) => ({ ...phases, [run.id]: undefined }))
      setSaveErrors((errors) => ({ ...errors, [run.id]: undefined }))
      return
    }
    window.clearTimeout(savedTimers.current[run.id])
    delete savedTimers.current[run.id]
    setSavedRuns((saved) => ({ ...saved, [run.id]: false }))
    setSavePhases((phases) => ({ ...phases, [run.id]: 'unsaved' }))
    setSaveErrors((errors) => ({ ...errors, [run.id]: undefined }))
    pending.current[run.id] = {
      measurements,
      notes,
      score,
      revision: (current?.revision ?? 0) + 1,
      saving: current?.saving ?? false,
    }
  }

  const updateMeasurement = (run: RoastRun, field: keyof BatchMeasurements, value: number | undefined) => {
    const draft = pending.current[run.id]
    const measurements = { ...(draft?.measurements ?? run.measurements) }
    if (value === undefined) delete measurements[field]
    else measurements[field] = value
    queueDetails(run, measurements, draft?.notes ?? run.notes, draft ? draft.score : runScore(run))
  }

  const updateNotes = (run: RoastRun, notes: string) => {
    const draft = pending.current[run.id]
    queueDetails(run, { ...(draft?.measurements ?? run.measurements) }, notes, draft ? draft.score : runScore(run))
  }

  const updateScore = (run: RoastRun, score: number | undefined) => {
    const draft = pending.current[run.id]
    queueDetails(run, { ...(draft?.measurements ?? run.measurements) }, draft?.notes ?? run.notes, score)
  }
  const draftScore = (run: RoastRun) => {
    const draft = pending.current[run.id]
    return draft ? draft.score : runScore(run)
  }

  /*
   * A number typed into a measurement box is not committed until blur or Enter. On a phone the
   * user types "196" and taps Save without leaving the box, so a field holding uncommitted text
   * enables Save for its run (Save blurs first, which commits it) and counts as unsaved work for
   * the leave guard. Keyed `${runId}:${field}`.
   */
  const [typingFields, setTypingFields] = useState<Record<string, boolean>>({})
  const trackTyping = (runId: string, field: keyof BatchMeasurements) => (uncommitted: boolean) => {
    const key = `${runId}:${field}`
    setTypingFields((current) => (Boolean(current[key]) === uncommitted ? current : { ...current, [key]: uncommitted }))
  }
  const runTyping = (runId: string) =>
    Object.entries(typingFields).some(([key, typing]) => typing && key.startsWith(`${runId}:`))
  const runHasChanges = (runId: string) => Boolean(pending.current[runId]) || runTyping(runId)

  /*
   * Drafts follow the archive. A run deleted while it held an unsaved draft must not leave the
   * leave guard stuck on, so its draft, phase and error go with it. A run whose stored content
   * changed underneath an idle draft (another tab saved, a re-import replaced it) keeps the draft,
   * which is now compared against the new stored values - and dropped if it says the same thing.
   */
  useEffect(() => {
    const present = new Map(runs.map((run) => [run.id, run]))
    const drop: string[] = []
    for (const [runId, draft] of Object.entries(pending.current)) {
      const run = present.get(runId)
      if (!run) {
        drop.push(runId)
        continue
      }
      if (
        !draft.saving &&
        draft.notes === run.notes &&
        draft.score === runScore(run) &&
        stableEquals(draft.measurements, run.measurements ?? {})
      )
        drop.push(runId)
    }
    for (const runId of drop) delete pending.current[runId]
    const keep = <T,>(record: Record<string, T | undefined>) => {
      const stale = Object.keys(record).filter(
        (runId) => record[runId] !== undefined && (drop.includes(runId) || !present.has(runId)),
      )
      if (stale.length === 0) return record
      const next = { ...record }
      for (const runId of stale) delete next[runId]
      return next
    }
    setSavePhases((current) => keep(current))
    setSaveErrors((current) => keep(current))
    setTypingFields((current) => {
      const gone = Object.keys(current).filter((key) => !present.has(key.slice(0, key.lastIndexOf(':'))))
      if (gone.length === 0) return current
      const next = { ...current }
      for (const key of gone) delete next[key]
      return next
    })
  }, [runs])

  const dirty =
    Object.values(savePhases).some((phase) => phase !== undefined) || Object.values(typingFields).some(Boolean)
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  useEffect(
    () => () => {
      for (const timer of Object.values(savedTimers.current)) window.clearTimeout(timer)
    },
    [],
  )

  const savedRecently = (runId: string) => savedRuns[runId] === true
  const saveStatus = (runId: string) => {
    if (savedRecently(runId))
      return (
        <span className="save-state saved" role="status">
          <Check size={15} />
          Saved on the roaster
        </span>
      )
    const phase = savePhases[runId]
    // A refused save is reported whenever its error stands, including when a newer edit made while
    // it was in flight has moved the phase back to unsaved.
    if (saveErrors[runId])
      return (
        <span className="save-state failed" role="alert">
          Not saved — {saveErrors[runId]}
        </span>
      )
    if (phase === 'saving')
      return (
        <span className="save-state" role="status">
          Saving…
        </span>
      )
    if (phase === 'unsaved' || runTyping(runId))
      return (
        <span className="save-state unsaved" role="status">
          Unsaved changes
        </span>
      )
    // Clean: the disabled Saved button already says so, so the status region stays empty.
    return <span className="save-state" role="status" />
  }
  return (
    <section className="view history-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">Archive</span>
          <h1>Roast history</h1>
        </div>
        <div className="heading-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={importInFlight}
            title="Import roast history from a JSON file. Full-device restore is in Settings."
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={18} />
            {importInFlight ? 'Adding history...' : 'Import history'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="Import roast history JSON"
            onChange={(event) => {
              void importArchive(event.currentTarget.files?.[0])
              event.currentTarget.value = ''
            }}
          />
          <button
            type="button"
            className="secondary-button"
            title="Export roast history as JSON. Full-device backup is in Settings."
            onClick={exportAll}
          >
            <Download size={18} />
            Export history
          </button>
        </div>
      </div>
      {(importMessage || importError) && (
        <div
          className={importError ? 'storage-error-banner' : 'import-message'}
          role={importError ? 'alert' : 'status'}
        >
          <span>{importError || importMessage}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss import message"
            onClick={() => {
              setImportMessage('')
              setImportError('')
            }}
          >
            x
          </button>
        </div>
      )}
      {focusRunId && visibleRuns.some((run) => run.id === focusRunId) && (
        <div className="import-message" role="status">
          <span>
            Opened from a catalog link: {correctedLegacyRunName(visibleRuns.find((run) => run.id === focusRunId)!)},
            expanded below.
          </span>
        </div>
      )}

      <DataTable
        className="history-table"
        rows={visibleRuns}
        rowKey={(run) => run.id}
        caption="Every stored roast"
        toolbar={
          <RoasterSourceFilterControl
            value={sourceFilter}
            onChange={setSourceFilter}
            activeName={activeRoasterName ?? 'Active roaster'}
            label="Roast history source"
          />
        }
        emptyMessage={
          runs.length > 0
            ? 'No roast records match this source.'
            : 'No roasts stored yet. Start one on the Roast page and it is archived here the moment it finishes - or import a roast history file.'
        }
        defaultSort={{ columnId: 'started', direction: 'desc' }}
        /*
         * Eight columns. On a phone, when it ran and what it was called are enough to find a row;
         * everything else, including how it ended, is stated in the expanded detail. Keeping Result
         * as a 9% sliver rendered "complete" as "com", which was neither a useful status nor honest
         * responsive design. Sorting and filtering are untouched: a hidden column is hidden, not
         * removed, and the archive can still be ordered by a batch weight not currently on screen.
         */
        focusKey={focusRunId}
        /*
         * Every column declares a width, which is what puts the table into `table-layout: fixed`.
         * Expanding a roast must not change the temperature column's width and push the header onto
         * a second line; the mechanism is in `DataTable`, and the cure is that these eight numbers
         * are the only thing that decides how wide anything is. They are
         * percentages so the table still uses whatever width it is given, and they sum to 100.
         */
        columns={[
          {
            id: 'started',
            label: 'Date',
            className: 'date-cell',
            width: '14%',
            defaultDirection: 'desc',
            value: (run) => run.startedAt,
            render: (run) => formatTableDateTime(run.startedAt),
          },
          /* No "not on the roaster" flag any more: the browser cannot hold a roast the roaster does
           not, so a column for the case would be a column that never fires. See `deviceStore`. */
          {
            id: 'name',
            label: 'Roast',
            className: 'name-cell',
            width: '24%',
            value: correctedLegacyRunName,
            render: (run) => (
              <span className="record-name-with-source">
                <span>{correctedLegacyRunName(run)}</span>
                <RoasterSourceBadge recordedOn={run.recordedOn} activeDeviceId={activeRoasterId} />
              </span>
            ),
          },
          {
            id: 'bean',
            label: 'Bean lot',
            width: '11%',
            priority: 'secondary',
            value: (run) => run.beanLotSnapshot?.name ?? 'Unspecified',
          },
          {
            id: 'profile',
            label: 'Profile',
            width: '10%',
            priority: 'secondary',
            value: (run) => run.profile.name,
            render: (run) => (
              <>
                {run.profile.name}
                <small> rev {run.profile.revision}</small>
              </>
            ),
          },
          {
            id: 'duration',
            label: 'Duration',
            width: '7%',
            className: 'numeric',
            priority: 'secondary',
            defaultDirection: 'desc',
            value: runDurationSec,
            render: (run) => formatClock(runDurationSec(run)),
          },
          {
            id: 'peak',
            label: 'Peak temp',
            width: '8%',
            className: 'numeric',
            priority: 'secondary',
            defaultDirection: 'desc',
            value: peakTemperature,
            render: (run) => {
              const value = peakTemperature(run)
              return value === undefined ? '--' : `${value.toFixed(1)} °C`
            },
          },
          {
            id: 'mass',
            label: 'Batch g',
            width: '6%',
            className: 'numeric',
            priority: 'secondary',
            defaultDirection: 'desc',
            value: (run) => run.measurements?.startingMassG,
          },
          { id: 'outcome', label: 'Result', width: '7%', priority: 'secondary', value: (run) => run.outcome },
          {
            id: 'score',
            label: 'Score',
            width: '7%',
            className: 'numeric score-cell',
            defaultDirection: 'desc',
            value: runScore,
            render: (run) => {
              const score = runScore(run)
              return score === undefined ? <span className="score-empty">--</span> : <strong>{score}</strong>
            },
          },
          {
            id: 'delete',
            label: 'Actions',
            width: '6%',
            className: 'row-action',
            sortable: false,
            filterable: false,
            value: () => undefined,
            render: (run) => (
              <button
                type="button"
                className="icon-button danger-icon"
                title="Delete"
                aria-label={`Delete roast ${correctedLegacyRunName(run)}`}
                onClick={() =>
                  window.confirm(
                    'Delete this roast record? Its detailed thermal recording, if present, remains on the roaster.',
                  ) && onDelete(run.id)
                }
              >
                <Trash2 size={18} />
              </button>
            ),
          },
        ]}
        detail={(run) => {
          /*
           * All-or-nothing: an expanded record renders only once the run document, its recording
           * linkage, and reconciliation have settled. Until then this is an explicit loading state
           * with the reason - the record on screen never silently mutates from partial to complete.
           */
          const pendingReason = detailPendingReason?.(run)
          if (pendingReason) {
            return (
              <div className="history-detail">
                <div className="empty-state" role="status">
                  <strong>Loading this roast…</strong> {pendingReason}
                </div>
              </div>
            )
          }
          return (
            <div className="history-detail">
              <div className="record-source-detail">
                <RoasterSourceBadge recordedOn={run.recordedOn} activeDeviceId={activeRoasterId} />
                <span>
                  Recorded on {run.recordedOn.displayNameAtCapture} · device {run.recordedOn.deviceId}
                </span>
              </div>
              <div className="history-measurements">
                <NumberField
                  label="Start g"
                  value={(pending.current[run.id]?.measurements ?? run.measurements)?.startingMassG}
                  placeholder="—"
                  onUncommittedChange={trackTyping(run.id, 'startingMassG')}
                  onCommit={(value) => updateMeasurement(run, 'startingMassG', value)}
                />
                <NumberField
                  label="Start ml"
                  value={(pending.current[run.id]?.measurements ?? run.measurements)?.startingVolumeMl}
                  placeholder="—"
                  onUncommittedChange={trackTyping(run.id, 'startingVolumeMl')}
                  onCommit={(value) => updateMeasurement(run, 'startingVolumeMl', value)}
                />
                <NumberField
                  label="Final g"
                  value={(pending.current[run.id]?.measurements ?? run.measurements)?.finalMassG}
                  placeholder="—"
                  onUncommittedChange={trackTyping(run.id, 'finalMassG')}
                  onCommit={(value) => updateMeasurement(run, 'finalMassG', value)}
                />
                <NumberField
                  label="Final ml"
                  value={(pending.current[run.id]?.measurements ?? run.measurements)?.finalVolumeMl}
                  placeholder="—"
                  onUncommittedChange={trackTyping(run.id, 'finalVolumeMl')}
                  onCommit={(value) => updateMeasurement(run, 'finalVolumeMl', value)}
                />
              </div>
              <ScorePicker value={draftScore(run)} onChange={(score) => updateScore(run, score)} />
              {/* Derived the moment the measurements exist; every one is undefined-safe, because a
            missing final volume has no expansion ratio and 0 would be a lie that later averages
            into a fitted coefficient. */}
              <div className="roast-covariates">
                {(() => {
                  const metrics = roastMetrics(pending.current[run.id]?.measurements ?? run.measurements)
                  return (
                    <>
                      <span>
                        Green density<strong>{formatMetric(metrics.greenDensityGPerMl, 3, ' g/ml')}</strong>
                      </span>
                      <span>
                        Roasted density<strong>{formatMetric(metrics.roastedDensityGPerMl, 3, ' g/ml')}</strong>
                      </span>
                      <span>
                        Expansion
                        <strong>
                          {metrics.expansionRatio === undefined ? '--' : `${metrics.expansionRatio.toFixed(2)}x`}
                        </strong>
                      </span>
                      <span>
                        Mass loss<strong>{formatMetric(metrics.massLossPercent, 1, ' %')}</strong>
                      </span>
                      <span>
                        Density loss<strong>{formatMetric(metrics.densityLossPercent, 1, ' %')}</strong>
                      </span>
                    </>
                  )
                })()}
              </div>
              {/* Not `onChange` bound straight to `run.notes`: the native change event does not fire
            until blur, so the 1 Hz live-clock re-render would write the stored text back over
            whatever was being typed, about a second after each keystroke.
            `TextArea` owns the text; blur updates the visible draft, and only Save changes writes
            the merged notes and measurements. Root cause in full: `domain/draft.ts`. */}
              {run.samples.length > 0 && (
                <section
                  className="history-detail-chart"
                  aria-label={`Recorded curve for ${correctedLegacyRunName(run)}`}
                >
                  <div className="history-detail-heading">
                    <span className="eyebrow">Recorded roast</span>
                    <h3>Temperature over time</h3>
                  </div>
                  <LiveChart
                    samples={run.samples}
                    profile={run.profile.strategy === 'timed' ? run.profile : undefined}
                    targetIntent={run.profile.strategy === 'thermal-intent' ? run.profile : undefined}
                    events={run.events}
                    elapsedSec={run.samples.at(-1)?.elapsedSec ?? runDurationSec(run)}
                    planOnly
                    ariaLabel="Stored roast graph"
                  />
                </section>
              )}
              <TextArea
                className="notes-field history-notes"
                label="Roast notes"
                maxLength={4000}
                value={pending.current[run.id]?.notes ?? run.notes}
                placeholder="Observations about this run"
                onCommit={(notes) => updateNotes(run, notes)}
              />
              <div className="history-actions">
                <button
                  type="button"
                  className={runHasChanges(run.id) ? 'compact-button primary' : 'compact-button'}
                  disabled={!runHasChanges(run.id) || pending.current[run.id]?.saving === true}
                  title={
                    runHasChanges(run.id)
                      ? undefined
                      : 'Everything shown here is saved on the roaster. Change a field, the score, or the notes to save an update.'
                  }
                  onClick={() => {
                    void savePending(run.id)
                  }}
                >
                  <Save size={15} />
                  {pending.current[run.id]?.saving
                    ? 'Saving…'
                    : savePhases[run.id] === 'failed'
                      ? 'Try save again'
                      : runHasChanges(run.id)
                        ? 'Save changes'
                        : 'Saved'}
                </button>
                {saveStatus(run.id)}
                <button
                  type="button"
                  className={overlayId === run.id ? 'compact-button active' : 'compact-button'}
                  title="Overlay this roast on the Roast page chart"
                  onClick={() => onOverlay(overlayId === run.id ? undefined : run.id)}
                >
                  <GitCompareArrows size={15} />
                  {overlayId === run.id ? 'Comparing' : 'Compare on chart'}
                </button>
                <button
                  type="button"
                  className="compact-button"
                  disabled={run.profile.strategy !== 'timed' || run.samples.length === 0}
                  title="Create a new profile revision from the requested actuator history"
                  onClick={() => onUseAsProfile(run)}
                >
                  <Copy size={15} />
                  Use as profile
                </button>
                {onRoastAgain && (
                  <button type="button" className="compact-button primary" onClick={() => onRoastAgain(run)}>
                    <RotateCcw size={15} />
                    Roast again
                  </button>
                )}
              </div>
            </div>
          )
        }}
      />
    </section>
  )
}
