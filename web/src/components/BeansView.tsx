import { GripVertical, Plus, Save, Trash2 } from 'lucide-preact'
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks'
import { type BeanListOrder, orderBeanLots, readBeanListOrder, writeBeanListOrder } from '../domain/beanListOrder'
import { beanComboOptions, listCompletions } from '../domain/comboValues'
import { formatTableDateTime } from '../domain/dateTime'
import type { DeviceLogEntry } from '../domain/deviceLogs'
import { newId } from '../domain/ids'
import { evaluateNumericExpression, formatCalculatedNumber } from '../domain/numericExpression'
import { dropIndexAt, moveInOrder } from '../domain/profileOrder'
import { runsForBean } from '../domain/recommendations'
import { beanIsDirty, LEAVE_WITHOUT_SAVING } from '../domain/revisionDiff'
import { roastMetrics } from '../domain/roastMetrics'
import { beanScoreSummary, runScore } from '../domain/roastScore'
import type { CascadePlan } from '../domain/storage'
import type { BeanLot, BeanRevision, RoastRun } from '../domain/types'
import { CatalogRoastDetail } from './CatalogRoastDetail'
import { focusGrip, keyboardReorder, orderChanged, scrollStripToSelected } from './catalogStrip'
import { DataTable } from './DataTable'
import { DeleteImpactPanel } from './DeleteImpactPanel'
import { NumberField } from './NumberField'
import { TextArea, TextField } from './TextField'

const splitValues = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const newBean = (): BeanLot => {
  const now = new Date().toISOString()
  return {
    id: newId('bean'),
    name: 'New bean lot',
    origins: [],
    cultivars: [],
    notes: '',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * A field that suggests what the catalog already contains without ever constraining what may be
 * typed. A native `<datalist>` IS this control and costs no dependency: the input stays a plain
 * text input, the browser handles the popup and the keyboard, and an unlisted value is simply
 * accepted.
 */
function ComboField({
  label,
  value,
  options,
  placeholder,
  onInput,
}: {
  label: string
  value: string
  options: string[]
  placeholder?: string
  onInput: (value: string) => void
}) {
  const listId = useId()
  return (
    <TextField label={label} value={value} placeholder={placeholder} list={listId} onCommit={onInput}>
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </TextField>
  )
}

export function BeansView({
  beans,
  runs,
  revisions,
  selectedId,
  runBytes = {},
  deviceLogs = [],
  deleteBlockedReason,
  mutationBlockedReason,
  onSelect,
  onSave,
  onDelete,
  onCascadeDelete,
  onDirtyChange,
  onOpenRun,
  onReorder,
}: {
  beans: BeanLot[]
  runs: RoastRun[]
  revisions: BeanRevision[]
  selectedId?: string
  /** Everything the delete-impact panel needs. Absent on a controller with no document store. */
  runBytes?: Record<string, number>
  deviceLogs?: DeviceLogEntry[]
  deleteBlockedReason?: string
  mutationBlockedReason?: string
  onSelect: (id: string) => void
  onSave: (bean: BeanLot) => Promise<boolean> | boolean | void
  onDelete: (id: string) => void
  onCascadeDelete?: (plan: CascadePlan) => Promise<string>
  onDirtyChange: (dirty: boolean) => void
  onOpenRun: (run: RoastRun) => void
  onReorder?: (ids: string[]) => void
}) {
  const selected = useMemo(() => beans.find((bean) => bean.id === selectedId) ?? beans[0], [beans, selectedId])
  const [draft, setDraft] = useState<BeanLot>(() => structuredClone(selected ?? newBean()))
  const unsavedBaselineRef = useRef(structuredClone(draft))
  const [densityInput, setDensityInput] = useState(selected?.greenDensityGPerMl?.toString() ?? '')
  const [densityError, setDensityError] = useState('')
  const [saving, setSaving] = useState(false)
  /**
   * Same rule as the profile editor: the draft is reloaded when a different lot is opened or when
   * this one is saved, and never because the parent re-rendered under a live poll.
   */
  const loadedKey = `${selected?.id ?? 'none'}:${selected?.updatedAt ?? ''}`
  const loadedRef = useRef(loadedKey)
  useEffect(() => {
    if (!selected || loadedRef.current === loadedKey) return
    loadedRef.current = loadedKey
    setDraft(structuredClone(selected))
    unsavedBaselineRef.current = structuredClone(selected)
    setDensityInput(selected.greenDensityGPerMl?.toString() ?? '')
    setDensityError('')
  }, [loadedKey, selected])

  const savedDraft = beans.find((bean) => bean.id === draft.id)
  const dirty = beanIsDirty(draft, savedDraft ?? unsavedBaselineRef.current)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const history = useMemo(
    () =>
      revisions.filter((revision) => revision.beanId === draft.id).sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    [draft.id, revisions],
  )
  // Suggestions come from the whole catalog, so a value typed on one lot is offered on every other.
  const options = useMemo(() => beanComboOptions(beans), [beans])
  const beanRoasts = useMemo(() => runsForBean(runs, draft.id), [draft.id, runs])
  /*
   * The lot list can be ordered by the composite score the lots' roasts earned. Custom order - the
   * drag order stored on the roaster - stays the default and the only order dragging edits; the
   * other orders are views, remembered per browser because they are a reading preference.
   */
  const [listOrder, setListOrder] = useState<BeanListOrder>(readBeanListOrder)
  const scores = useMemo(() => new Map(beans.map((bean) => [bean.id, beanScoreSummary(runs, bean.id)])), [beans, runs])
  const listedBeans = useMemo(() => orderBeanLots(beans, runs, listOrder, scores), [beans, listOrder, runs, scores])
  const dragEnabled = listOrder === 'custom'
  const draftSummary = scores.get(draft.id)
  const update = <K extends keyof BeanLot>(key: K, value: BeanLot[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const readDensity = (value: string) => {
    if (!value.trim()) return { valid: true as const, value: undefined }
    const result = evaluateNumericExpression(value)
    return result !== undefined && result > 0 ? { valid: true as const, value: result } : { valid: false as const }
  }
  const densityChanged = (value: string) => {
    setDensityInput(value)
    const parsed = readDensity(value)
    if (!value.trim()) {
      update('greenDensityGPerMl', undefined)
      setDensityError('')
      return
    }
    if (parsed.valid) update('greenDensityGPerMl', parsed.value)
    setDensityError('')
  }
  const finishDensity = (value: string) => {
    const parsed = readDensity(value)
    if (!parsed.valid) {
      setDensityError('Enter a positive number or calculation, such as 225/350.')
      return false
    }
    update('greenDensityGPerMl', parsed.value)
    setDensityInput(parsed.value === undefined ? '' : formatCalculatedNumber(parsed.value))
    setDensityError('')
    return true
  }
  const save = async () => {
    const parsed = readDensity(densityInput)
    if (!parsed.valid) {
      finishDensity(densityInput)
      return
    }
    setSaving(true)
    try {
      await onSave({
        ...draft,
        greenDensityGPerMl: parsed.value,
        name: draft.name.trim() || 'Unnamed bean lot',
        updatedAt: new Date().toISOString(),
      })
    } finally {
      setSaving(false)
    }
  }
  const create = () => {
    if (dirty && !window.confirm(LEAVE_WITHOUT_SAVING)) return
    const bean = newBean()
    unsavedBaselineRef.current = structuredClone(bean)
    setDraft(bean)
    setDensityInput('')
    setDensityError('')
  }
  const open = (id: string) => {
    if (id === draft.id) return
    if (dirty && !window.confirm(LEAVE_WITHOUT_SAVING)) return
    const bean = beans.find((candidate) => candidate.id === id)
    if (!bean) return
    loadedRef.current = `${bean.id}:${bean.updatedAt}`
    unsavedBaselineRef.current = structuredClone(bean)
    setDraft(structuredClone(bean))
    setDensityInput(bean.greenDensityGPerMl?.toString() ?? '')
    setDensityError('')
    onSelect(id)
  }

  const listRef = useRef<HTMLElement>(null)
  useEffect(() => scrollStripToSelected(listRef.current, 'data-bean-id', draft.id), [draft.id])
  const [drag, setDrag] = useState<{ id: string; overIndex: number } | null>(null)
  const dropIndexFor = (x: number, y: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-bean-id]')
    return rows
      ? dropIndexAt(
          [...rows].map((row) => row.getBoundingClientRect()),
          { x, y },
        )
      : 0
  }
  const endDrag = () => {
    if (drag && !mutationBlockedReason) {
      const before = beans.map((bean) => bean.id)
      const after = moveInOrder(before, drag.id, drag.overIndex)
      // A drop where the drag started is not a reorder; it must not write to the roaster.
      if (orderChanged(before, after)) onReorder?.(after)
    }
    setDrag(null)
  }
  const refocusGripId = useRef<string>()
  useEffect(() => {
    if (!refocusGripId.current) return
    focusGrip(listRef.current, 'data-bean-id', refocusGripId.current, '.bean-grip')
    refocusGripId.current = undefined
  }, [beans])
  const reorderFromKeyboard = (event: KeyboardEvent, id: string) => {
    const next = keyboardReorder(
      beans.map((bean) => bean.id),
      id,
      event.key,
    )
    if (event.key.startsWith('Arrow')) event.preventDefault()
    if (!next || !dragEnabled || mutationBlockedReason || !onReorder) return
    refocusGripId.current = id
    onReorder(next)
  }

  return (
    <section className="view beans-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">Green coffee catalog</span>
          <h1>Bean lots</h1>
        </div>
        <div className="heading-actions">
          {dirty && (
            <span className="dirty-tag" role="status">
              Unsaved working edits
            </span>
          )}
          <button type="button" className="secondary-button" onClick={create}>
            <Plus size={18} />
            New lot
          </button>
          <button
            type="button"
            className="primary-button"
            aria-describedby={mutationBlockedReason && dirty ? 'bean-save-blocker' : undefined}
            title={mutationBlockedReason ?? (!dirty ? 'Make a change before saving' : undefined)}
            disabled={!dirty || saving || Boolean(mutationBlockedReason)}
            onClick={() => void save()}
          >
            <Save size={18} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div className="bean-workspace">
        <div className="bean-list-column">
          <label className="bean-list-order">
            Order lots by
            <select
              value={listOrder}
              onInput={(event) => {
                const next = event.currentTarget.value as BeanListOrder
                setListOrder(next)
                writeBeanListOrder(next)
              }}
            >
              <option value="custom">Custom order (drag)</option>
              <option value="score">Score, highest first</option>
              <option value="recent">Most recently roasted</option>
              <option value="name">Name</option>
            </select>
          </label>
          <aside
            className="bean-list"
            ref={listRef}
            onPointerMove={(event) => {
              if (drag) setDrag({ ...drag, overIndex: dropIndexFor(event.clientX, event.clientY) })
            }}
            onPointerUp={endDrag}
            onPointerCancel={() => setDrag(null)}
          >
            {listedBeans.map((bean, index) => {
              const summary = scores.get(bean.id)
              return (
                <div
                  key={bean.id}
                  data-bean-id={bean.id}
                  className={`bean-row${bean.id === draft.id ? ' selected' : ''}${drag?.id === bean.id ? ' dragging' : ''}${drag && drag.overIndex === index ? ' drop-before' : ''}${dragEnabled ? '' : ' no-drag'}`}
                >
                  {dragEnabled && (
                    <span
                      className="bean-grip"
                      role="button"
                      tabIndex={0}
                      aria-label={`Reorder ${bean.name}`}
                      title={mutationBlockedReason ?? 'Drag or use the arrow keys to reorder'}
                      onKeyDown={(event) => reorderFromKeyboard(event, bean.id)}
                      onPointerDown={(event) => {
                        if (mutationBlockedReason) return
                        event.currentTarget.setPointerCapture(event.pointerId)
                        setDrag({ id: bean.id, overIndex: index })
                      }}
                    >
                      <GripVertical size={15} />
                    </span>
                  )}
                  <button type="button" title={bean.name} onClick={() => open(bean.id)}>
                    <strong>{bean.name}</strong>
                    <span>
                      {[bean.origins.join(', '), bean.lotId].filter(Boolean).join(' / ') || 'Details not entered'}
                    </span>
                  </button>
                  {summary?.average !== undefined && (
                    <span
                      className="bean-score"
                      role="img"
                      title={`Average of ${summary.scoredRoasts} scored roast${summary.scoredRoasts === 1 ? '' : 's'}; best ${summary.best}`}
                      aria-label={`Score ${summary.average} of 10 from ${summary.scoredRoasts} roast${summary.scoredRoasts === 1 ? '' : 's'}`}
                    >
                      {summary.average.toFixed(1)}
                    </span>
                  )}
                </div>
              )
            })}
            {drag && drag.overIndex >= beans.length && <div className="bean-row drop-before drop-end" />}
          </aside>
        </div>
        <div className="bean-editor">
          {mutationBlockedReason && dirty && (
            <div id="bean-save-blocker" className="bean-save-blocker" role="alert">
              <strong>This bean cannot be saved yet.</strong>
              <span>{mutationBlockedReason}</span>
              <small>
                Your entries remain as working edits in this browser. Save becomes available automatically when the
                roaster is ready.
              </small>
            </div>
          )}
          {/* One sheet per record, exactly as the Profiles page does it - see the container note in
            `styles.css`. The lot's own fields are one sheet; its roasts, its revisions and what
            deleting it would cost are three more, each on the page tint beside it. */}
          <div className="catalog-sheet bean-details">
            {/* The heading DISPLAYS the name; it is edited in the form below with every other field.
              On a phone a borderless title input reads as part of the lot list rather than as the
              create/edit form, so a new lot's name looks unaskable. One idiom for all fields - label above, control, one quiet help line. */}
            <div className="bean-editor-heading">
              <div>
                <span className="eyebrow">Bean lot</span>
                <h2 className="bean-title">{draft.name.trim() || 'Unnamed bean lot'}</h2>
              </div>
              <div className="bean-usage">
                <span>
                  Roasts<strong>{beanRoasts.length}</strong>
                </span>
                <span>
                  Profiles used<strong>{new Set(beanRoasts.map((run) => run.profile.id)).size}</strong>
                </span>
                <span title="The average score of this lot's scored roasts. Scores are given on each roast, on the Roast page or in History.">
                  Score<strong>{draftSummary?.average === undefined ? '--' : draftSummary.average.toFixed(1)}</strong>
                  {draftSummary?.average !== undefined && <small>{draftSummary.scoredRoasts} scored</small>}
                </span>
              </div>
            </div>
            <div className="bean-fields">
              <TextField
                labelClassName="bean-name-field"
                label="Name"
                ariaLabel="Bean lot name"
                value={draft.name}
                placeholder="Unnamed bean lot"
                onCommit={(name) => update('name', name)}
              >
                <small className="field-hint">
                  Names this lot everywhere: the list here, Roast setup, and History.
                </small>
              </TextField>
              <ComboField
                label="Origins"
                value={draft.origins.join(', ')}
                placeholder="Country, region, farm"
                options={listCompletions(draft.origins.join(', '), options.origins)}
                onInput={(value) => update('origins', splitValues(value))}
              />
              <TextField
                label="Lot ID"
                value={draft.lotId ?? ''}
                placeholder="Optional"
                onCommit={(lotId) => update('lotId', lotId || undefined)}
              />
              <ComboField
                label="Species"
                value={draft.species ?? ''}
                placeholder="Usually Arabica or Canephora"
                options={options.species}
                onInput={(value) => update('species', value || undefined)}
              />
              <ComboField
                label="Cultivars"
                value={draft.cultivars.join(', ')}
                placeholder="Optional, comma separated"
                options={listCompletions(draft.cultivars.join(', '), options.cultivars)}
                onInput={(value) => update('cultivars', splitValues(value))}
              />
              <ComboField
                label="Process"
                value={draft.process ?? ''}
                placeholder="Washed, natural, honey..."
                options={options.process}
                onInput={(value) => update('process', value || undefined)}
              />
              {/* This one keeps its own onBlur, because it is an expression field: "225/350" is only a
                density once the operator has finished writing it. The draft discipline is the same. */}
              <label>
                Green bulk density (g/ml)
                <TextField
                  inputMode="text"
                  ariaLabel="Green bulk density (g/ml)"
                  value={densityInput}
                  placeholder="225/350 or 0.643"
                  onCommit={densityChanged}
                  onBlurCommit={finishDensity}
                />
                {densityError && <small className="field-error">{densityError}</small>}
              </label>
              <NumberField
                label="Moisture (%)"
                min={0}
                max={30}
                step={0.1}
                value={draft.moisturePercent}
                placeholder="Usually unknown"
                hint="Optional"
                onCommit={(value) => update('moisturePercent', value)}
              />
              <TextArea
                className="notes-field"
                label="Bean notes"
                maxLength={4000}
                value={draft.notes}
                placeholder="Bag details, storage, observations, or calibration context"
                onCommit={(notes) => update('notes', notes)}
              />
            </div>
          </div>
          {/*
          TWO GESTURES ON ONE ROW, AND THEY ARE DIFFERENT THINGS.
          -----------------------------------------------------------------------------------
          Clicking a row expands its inline detail; clicking the roast name goes to History focused
          on that roast. Both are honoured here and on the Profiles page, from
          one shared detail renderer. The name is a real `<button type="button">`, which is what makes
          `DataTable`'s interactive-descendant rule let the click through without also toggling
          the row - that opt-out is by ELEMENT KIND rather than by each column remembering to stop
          propagation, so it cannot be forgotten the next time a column gains a link.
        */}
          <section className="catalog-sheet bean-roasts">
            <div className="editor-toolbar">
              <strong>Roast history</strong>
              <span className="revision-count">Every roast this lot has been through</span>
            </div>
            <DataTable
              rows={beanRoasts}
              rowKey={(run) => run.id}
              emptyMessage="Nothing roasted from this lot yet. Choose it on the Roast page and every run appears here with its weight loss and density."
              caption="Roasts run with this bean lot"
              defaultSort={{ columnId: 'started', direction: 'desc' }}
              detail={(run) => <CatalogRoastDetail run={run} onOpen={onOpenRun} />}
              columns={[
                {
                  id: 'started',
                  label: 'Date',
                  className: 'date-cell',
                  defaultDirection: 'desc',
                  value: (run) => run.startedAt,
                  render: (run) => formatTableDateTime(run.startedAt),
                },
                {
                  id: 'name',
                  label: 'Roast',
                  value: (run) => run.name,
                  render: (run) => (
                    <button
                      type="button"
                      className="link-button"
                      title={`Open ${run.name} in History`}
                      onClick={() => onOpenRun(run)}
                    >
                      {run.name}
                    </button>
                  ),
                },
                {
                  id: 'score',
                  label: 'Score',
                  className: 'numeric score-cell',
                  defaultDirection: 'desc',
                  value: runScore,
                  render: (run) => {
                    const score = runScore(run)
                    return score === undefined ? <span className="score-empty">--</span> : <strong>{score}</strong>
                  },
                },
                { id: 'profile', label: 'Profile', priority: 'secondary', value: (run) => run.profile.name },
                {
                  id: 'revision',
                  label: 'Revision used',
                  className: 'numeric',
                  priority: 'secondary',
                  defaultDirection: 'desc',
                  value: (run) => run.profile.revision,
                },
                {
                  id: 'mass',
                  label: 'Batch g',
                  className: 'numeric',
                  priority: 'secondary',
                  defaultDirection: 'desc',
                  value: (run) => run.measurements?.startingMassG,
                },
                {
                  id: 'expansion',
                  label: 'Expansion',
                  className: 'numeric',
                  priority: 'secondary',
                  defaultDirection: 'desc',
                  value: (run) => roastMetrics(run.measurements).expansionRatio,
                  render: (run) => {
                    const value = roastMetrics(run.measurements).expansionRatio
                    return value === undefined ? '--' : `${value.toFixed(2)}x`
                  },
                },
                {
                  id: 'loss',
                  label: 'Mass loss',
                  className: 'numeric',
                  priority: 'secondary',
                  defaultDirection: 'desc',
                  value: (run) => roastMetrics(run.measurements).massLossPercent,
                  render: (run) => {
                    const value = roastMetrics(run.measurements).massLossPercent
                    return value === undefined ? '--' : `${value.toFixed(1)} %`
                  },
                },
                {
                  id: 'density',
                  label: 'Green g/ml',
                  className: 'numeric',
                  priority: 'secondary',
                  defaultDirection: 'desc',
                  value: (run) => roastMetrics(run.measurements).greenDensityGPerMl,
                  render: (run) => {
                    const value = roastMetrics(run.measurements).greenDensityGPerMl
                    return value === undefined ? '--' : value.toFixed(3)
                  },
                },
              ]}
            />
          </section>
          {/* "Revision history", as it is called on Profiles. One name for one thing, on both
            catalogs - the user should not have to learn that a bean's saves are called something
            else from a profile's. */}
          <section className="catalog-sheet revision-history">
            <div className="editor-toolbar">
              <strong>Revision history</strong>
              <span className="revision-count">
                {history.length} saved revision{history.length === 1 ? '' : 's'}
              </span>
            </div>
            {history.length === 0 ? (
              <div className="empty-state">
                No revisions recorded yet. Every Save that changes a field is logged here with what it was and what it
                became.
              </div>
            ) : (
              <div className="calibration-table-wrap">
                <table className="diff-table revision-table">
                  <thead>
                    <tr>
                      <th>Saved</th>
                      <th>What changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((entry) => (
                      <tr key={entry.id}>
                        <td>{new Date(entry.savedAt).toLocaleString()}</td>
                        <td className="revision-summary">{entry.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {/*
          What deleting this lot would actually cost, stated before it is offered. Both options are
          real ones: a roast keeps its own bean snapshot, so the recipe and the history are separable.
        */}
          {savedDraft && onCascadeDelete ? (
            <DeleteImpactPanel
              subject="bean"
              id={savedDraft.id}
              name={savedDraft.name}
              runs={runs}
              runBytes={runBytes}
              deviceLogs={deviceLogs}
              blockedReason={deleteBlockedReason}
              onDeleteEntity={() => onDelete(savedDraft.id)}
              onCascade={onCascadeDelete}
            />
          ) : (
            savedDraft && (
              <button
                type="button"
                className="bean-delete"
                onClick={() =>
                  window.confirm(
                    `Delete ${savedDraft.name}? Historical roasts will keep their recorded bean details.`,
                  ) && onDelete(savedDraft.id)
                }
              >
                <Trash2 size={17} />
                Delete bean lot
              </button>
            )
          )}
        </div>
      </div>
    </section>
  )
}
