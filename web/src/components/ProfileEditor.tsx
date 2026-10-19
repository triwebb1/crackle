import { CopyPlus, Download, Gauge, GripVertical, History, Plus, Save, Thermometer, Timer, Trash2 } from 'lucide-preact'
import type { JSX } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { chartUnitScale, estimatedTextWidth, planTimeTicks, snapTo, TEMPERATURE_GUTTER } from '../domain/chartAxis'
import { formatTableDateTime } from '../domain/dateTime'
import type { DeviceCoefficients, DeviceLogEntry } from '../domain/deviceLogs'
import { newId } from '../domain/ids'
import {
  appendZone,
  boundaryTimes,
  insertBoundary,
  JOURNEY_LEVEL_SNAP,
  JOURNEY_TEMPERATURE_SNAP_C,
  JOURNEY_TIME_SNAP_SEC,
  journeyDurationSec,
  journeyPoints,
  type LimitField,
  MINIMUM_ZONE_SEC,
  moveBoundary,
  orderedLimit,
  removeZone,
  updateZone,
} from '../domain/journeyEdit'
import { formatClock, normalizeThermalContinuity, parseClock, timedDuration } from '../domain/model'
import { dropIndexAt, moveInOrder } from '../domain/profileOrder'
import { runsForProfile } from '../domain/recommendations'
import { LEAVE_WITHOUT_SAVING, profileIsDirty, restoreRevision } from '../domain/revisionDiff'
import { axisTicksFrom } from '../domain/roastGradient'
import { runScore } from '../domain/roastScore'
import type { CascadePlan } from '../domain/storage'
import { insertTimedPoint, moveTimedPointTime, removeTimedPoint, timedCoolingSpans } from '../domain/timedProfileEdit'
import type {
  CalibrationSettings,
  CalibrationSnapshot,
  Profile,
  ProfileRevision,
  RoastRun,
  ThermalIntent,
  ThermalSegment,
  TimedPoint,
  TimedProfile,
} from '../domain/types'
import { CatalogRoastDetail } from './CatalogRoastDetail'
import { focusGrip, keyboardReorder, orderChanged, scrollStripToSelected } from './catalogStrip'
import { DataTable } from './DataTable'
import { DeleteImpactPanel } from './DeleteImpactPanel'
import { NumberField } from './NumberField'
import { ProfileSimulationPanel } from './ProfileSimulationPanel'
import {
  ActuatorAxis,
  CHART_DOMAIN_C,
  RoastColorStrip,
  RoastGradientDefs,
  TemperatureAxis,
  TimeAxis,
  temperatureScale,
} from './RoastColorScale'
import { TextArea, TextField } from './TextField'
import { useChartWidth } from './useChartWidth'

/*
 * ============================================================================================
 * POINTER GESTURES ON THESE CHARTS - text selection and the context menu
 * ============================================================================================
 *
 * Dragging a limit line must neither select the chart's text (the browser's blue highlight) nor
 * raise the context menu when the line is released. Both are handled where a drag begins: the
 * `pointerdown` cancels its default and checks which button was pressed.
 *
 *   - **The blue highlight** is the browser's own text-selection drag, which starts on an
 *     uncancelled pointerdown/mousedown and then sweeps every `<text>` in the SVG as the pointer
 *     moves. `preventDefault()` on the press that begins a drag prevents it; `user-select: none`
 *     while a drag is live is the belt to that braces.
 *   - **The menu on release** is a press the chart should never have accepted. `pickLimit` matches on
 *     position alone, so a SECONDARY press - a right button, a pen barrel button, a touch long-press -
 *     would begin a drag exactly like a primary one. On Windows the context menu for those is raised
 *     on the button's RELEASE, which is precisely when the line is let go. And cancelling
 *     pointerdown does not help: the Pointer Events spec is explicit that a cancelled pointerdown
 *     suppresses the compatibility mouse events but still fires `click` and `contextmenu`. So the
 *     cause is fixed - only a primary press may begin a drag - and the symptom is guarded anyway,
 *     because a long-press menu can still be synthesised from a touch the chart did accept.
 *
 * Both charts use the same three helpers below. Nothing here suppresses selection or menus anywhere
 * else on the page: the guard is scoped to the SVG and to the moments a drag is actually live.
 */

/** How long after a drag ends a context menu is still assumed to belong to that drag. */
export const CONTEXT_MENU_GUARD_MS = 450

/** Only a primary press may begin a drag. See above: a secondary release raises the menu. */
const beginsDrag = (event: JSX.TargetedPointerEvent<Element>) =>
  event.isPrimary && !(event.pointerType === 'mouse' && event.button !== 0)

/*
 * ============================================================================================
 * THE COOLING WATERMARK - one word, in the layer under everything
 * ============================================================================================
 *
 * A cooling zone carries a subtle "cooling" label. It must not overlap anything else on the chart,
 * and it belongs in the background, layered below everything else.
 *
 * Two things follow from that, and both are enforced here rather than left to CSS:
 *
 *   - It is drawn WITH the band, before the gridlines, the axes, the limits, the path and the
 *     points, so every mark on the chart paints over it. `pointer-events: none` and `aria-hidden`
 *     keep it out of the gesture layer and out of the accessibility tree as well - the zone table
 *     already says "cooling" in words a screen reader can use.
 *   - It is WITHHELD when the band cannot hold it. "Must not overlap anything else" is a
 *     constraint on the word, not a preference, and a phone narrows the viewBox rather than the
 *     glyphs - so the same 90-second cooling zone that is 194 units wide at desktop is 91 at phone
 *     width while the word stays the size it is. Where it no longer fits, there is no word.
 *
 * Nothing here is multiplied by `chartUnitScale`: that exists for things sized for a FINGER, and a
 * watermark is sized for an eye. Text on these charts is in user units already, so narrowing the
 * viewBox enlarges it against the plot on its own, which is exactly the behaviour wanted.
 */
export const COOLING_BAND_LABEL = 'COOLING'
/** Kept in step with `.cooling-band-label` in the stylesheet; the fit test needs both numbers. */
const COOLING_LABEL_FONT_UNITS = 12
const COOLING_LABEL_TRACKING_EM = 0.16
/** Clear air demanded either side of the word before it is worth drawing at all. */
const COOLING_LABEL_MARGIN_UNITS = 8

/** How wide the watermark actually draws, letter-spacing included. */
export const coolingLabelWidth = () =>
  estimatedTextWidth(COOLING_BAND_LABEL, COOLING_LABEL_FONT_UNITS) +
  COOLING_BAND_LABEL.length * COOLING_LABEL_TRACKING_EM * COOLING_LABEL_FONT_UNITS

/** Whether a band of this width in viewBox units has room for the word and its margins. */
export const coolingLabelFits = (bandUnits: number) => bandUnits >= coolingLabelWidth() + COOLING_LABEL_MARGIN_UNITS * 2

function CoolingBandLabel({ left, right, y }: { left: number; right: number; y: number }) {
  if (!coolingLabelFits(right - left)) return null
  return (
    <text className="cooling-band-label" x={(left + right) / 2} y={y} text-anchor="middle" aria-hidden="true">
      {COOLING_BAND_LABEL}
    </text>
  )
}

/*
 * ============================================================================================
 * LIMIT LINES AS CARETS - the permitted range, said by the marks themselves
 * ============================================================================================
 *
 * Limits draw as carets and inverted carets, like arrows pointing into the zone, with no shading.
 *
 * Two bare dashed lines read as two unrelated targets, and a translucent range rect between them
 * is clutter. A caret says "anywhere between these two is allowed" without any fill: a minimum is a
 * row of `^` pointing UP into what it permits, a maximum a row of `v` pointing DOWN into it, so a
 * Fan 4-9 band is two rows of arrows facing each other across the range they enclose. With no fill,
 * paint order does not matter on this chart.
 *
 * Each caret is CENTRED on the line rather than sitting to one side of it, so the mark's mean
 * position is still exactly the level being edited - which is the level `pickLimit` hit-tests, the
 * level the invisible `limit-hit` strip sits at, and the level the callout reports.
 *
 * Fan and Heat are drawn a half-pitch out of phase, so a zone whose Fan max and Heat max sit on the
 * same level shows two interleaved rows of arrows instead of one row hiding the other - which is
 * strictly better than dashes, where one dash simply covers the dash beneath it.
 */
export const LIMIT_CARET_PITCH = 24
export const LIMIT_CARET_HALF_WIDTH = 5.5
export const LIMIT_CARET_HEIGHT = 7

/**
 * The `d` of one limit line's worth of carets, laid along `left`..`right` at height `y`.
 *
 * `direction` is which way they point, which is into the allowed range: `up` for a minimum, `down`
 * for a maximum. A zone too narrow to hold a full caret still gets one, squeezed and centred, because
 * a limit that draws nothing at all is a limit the operator cannot see or aim at.
 */
export const caretRun = (
  left: number,
  right: number,
  y: number,
  direction: 'up' | 'down',
  { pitch = LIMIT_CARET_PITCH, halfWidth = LIMIT_CARET_HALF_WIDTH, height = LIMIT_CARET_HEIGHT, phase = 0 } = {},
): string => {
  const span = Math.max(0, right - left)
  const arm = Math.min(halfWidth, span / 2)
  const apexY = direction === 'up' ? y - height / 2 : y + height / 2
  const tailY = direction === 'up' ? y + height / 2 : y - height / 2
  const caret = (centre: number) =>
    `M ${(centre - arm).toFixed(1)} ${tailY.toFixed(1)} L ${centre.toFixed(1)} ${apexY.toFixed(1)} L ${(centre + arm).toFixed(1)} ${tailY.toFixed(1)}`
  const carets: string[] = []
  for (let centre = left + arm + phase; centre <= right - arm + 1e-6; centre += pitch) carets.push(caret(centre))
  return carets.length > 0 ? carets.join(' ') : caret(left + span / 2)
}

export interface ProfileSuggestions {
  intents: string[]
}

interface ProfileEditorProps {
  profiles: Profile[]
  selectedId: string
  suggestions: ProfileSuggestions
  runs: RoastRun[]
  calibration: CalibrationSettings
  revisions: ProfileRevision[]
  /** Only used to say where the simulation's thermal coefficients came from. */
  snapshots: CalibrationSnapshot[]
  /** What the CONTROLLER has applied. The preview is drawn with it whenever it exists. */
  deviceCoefficients?: DeviceCoefficients
  revisionDraft?: Profile
  /** The default batch mass a simulation opens with: whatever was last actually roasted. */
  defaultMassG: number
  /** Everything the delete-impact panel needs. Absent on a controller with no document store. */
  runBytes?: Record<string, number>
  deviceLogs?: DeviceLogEntry[]
  deleteBlockedReason?: string
  mutationBlockedReason?: string
  previewBlockedReason?: string
  onDeleteProfile?: (id: string) => void
  onCascadeDelete?: (plan: CascadePlan) => Promise<string>
  onRevisionConsumed: () => void
  onSelect: (id: string) => void
  onSave: (profile: Profile) => Promise<boolean> | boolean | void
  onExport: () => void
  onDirtyChange: (dirty: boolean) => void
  onReorder: (ids: string[]) => void
  onOpenRun: (run: RoastRun) => void
}

type DragState = { id: string; channel: 'fan' | 'heat' } | null

/**
 * Profile durations are displayed as m:ss. A bare number is therefore minutes, including decimal
 * minutes (`3.5` -> `3:30`); an explicit colon keeps the ordinary m:ss clock syntax.
 */
export const parseProfileDuration = (value: string): number | undefined => {
  const trimmed = value.trim()
  if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    const minutes = Number(trimmed)
    return Number.isFinite(minutes) ? Math.round(minutes * 60) : undefined
  }
  return parseClock(trimmed)
}

function ClockInput({ value, onChange, label }: { value: number; onChange: (value: number) => void; label: string }) {
  // The draft is seeded from the value once and afterwards belongs to the field: it is only
  // replaced when the underlying value actually changes, never on a re-render.
  const [draft, setDraft] = useState(formatClock(value))
  useEffect(() => setDraft(formatClock(value)), [value])
  const commit = () => {
    const parsed = parseProfileDuration(draft)
    if (parsed == null) setDraft(formatClock(value))
    else {
      // Normalize even when the semantic value did not change (for example replacing `3:30` with
      // `3.5`). In that case there is no reason to dirty the profile or rebuild its chart.
      setDraft(formatClock(parsed))
      if (parsed !== value) onChange(parsed)
    }
  }
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      value={draft}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function SuggestionMenu({
  options,
  query,
  onPick,
}: {
  options: string[]
  query: string
  onPick: (value: string) => void
}) {
  const filtered = options.filter((option) => option.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
  if (filtered.length === 0) return null
  return (
    <div className="suggestion-menu">
      {filtered.map((option) => (
        <button
          type="button"
          key={option}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(option)}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function SuggestionField({
  label,
  value,
  suggestions,
  onChange,
}: {
  label: string
  value: string
  suggestions: string[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const options = suggestions.filter((item) => item !== value)
  return (
    <label className="suggestion-field">
      <span>{label}</span>
      <div
        className="suggestion-anchor"
        onFocusIn={() => setOpen(true)}
        onFocusOut={() => window.setTimeout(() => setOpen(false), 80)}
      >
        <TextField
          value={value}
          ariaLabel={label}
          onCommit={(next) => {
            onChange(next)
            setOpen(true)
          }}
        />
        {open && (
          <SuggestionMenu
            options={options}
            query=""
            onPick={(item) => {
              onChange(item)
              setOpen(false)
            }}
          />
        )}
      </div>
    </label>
  )
}

function TimedLaneEditor({ profile, onChange }: { profile: TimedProfile; onChange: (profile: TimedProfile) => void }) {
  const [selectedId, setSelectedId] = useState<string | undefined>(profile.points[0]?.id)
  const [drag, setDrag] = useState<DragState>(null)
  const menuGuardUntil = useRef(0)
  const duration = Math.max(timedDuration(profile), 60)
  const chartHeight = 500
  const levelSpacing = 14
  // The plot keeps its gutters and gives the rest to the lanes, at whatever width this viewport
  // draws the chart in. See `chartViewWidth`: on a phone that is fewer units, not a scrollbar.
  const viewWidth = useChartWidth()
  const touchScale = chartUnitScale(viewWidth)
  const plotLeft = 70
  const plotRight = viewWidth - 50
  const x = (time: number) => plotLeft + (time / duration) * (plotRight - plotLeft)
  const laneBase = (channel: 'fan' | 'heat') => (channel === 'fan' ? 195 : 415)
  const y = (value: number, channel: 'fan' | 'heat') => laneBase(channel) - value * levelSpacing
  const sorted = [...profile.points].sort((a, b) => a.timeSec - b.timeSec)
  const levels = Array.from({ length: 11 }, (_, level) => level)
  const coolingSpans = timedCoolingSpans(profile)

  const updatePoint = (id: string, patch: Partial<TimedPoint>) =>
    onChange({
      ...profile,
      updatedAt: new Date().toISOString(),
      points: profile.points.map((point) => (point.id === id ? { ...point, ...patch } : point)),
    })
  const updateDuration = (index: number, nextDuration: number) => {
    const safeDuration = Math.max(1, nextDuration)
    if (index === sorted.length - 1) {
      onChange({ ...profile, coolDurationSec: safeDuration, updatedAt: new Date().toISOString() })
      return
    }
    const currentDuration = sorted[index + 1].timeSec - sorted[index].timeSec
    const delta = safeDuration - currentDuration
    const affected = new Set(sorted.slice(index + 1).map((point) => point.id))
    onChange({
      ...profile,
      updatedAt: new Date().toISOString(),
      points: profile.points.map((point) =>
        affected.has(point.id) ? { ...point, timeSec: point.timeSec + delta } : point,
      ),
    })
  }
  const removePoint = (id: string) => {
    const next = removeTimedPoint(profile, id)
    if (next === profile) return
    onChange({ ...next, updatedAt: new Date().toISOString() })
    if (selectedId === id) setSelectedId(profile.points.find((point) => point.id !== id)?.id)
  }
  const stepPath = (channel: 'fan' | 'heat') =>
    sorted
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'} ${x(point.timeSec)} ${y(point[channel], channel)}${index < sorted.length - 1 ? ` H ${x(sorted[index + 1].timeSec)}` : ` H ${x(duration)}`}`,
      )
      .join(' ')

  const handleMove = (event: JSX.TargetedPointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const rect = event.currentTarget.getBoundingClientRect()
    const pointX = ((event.clientX - rect.left) / rect.width) * viewWidth
    const pointY = ((event.clientY - rect.top) / rect.height) * chartHeight
    const requestedTimeSec = ((pointX - plotLeft) / (plotRight - plotLeft)) * duration
    const value = Math.max(0, Math.min(10, Math.round(((laneBase(drag.channel) - pointY) / levelSpacing) * 2) / 2))
    const moved = moveTimedPointTime(profile, drag.id, requestedTimeSec)
    onChange({
      ...moved,
      updatedAt: new Date().toISOString(),
      points: moved.points.map((point) => (point.id === drag.id ? { ...point, [drag.channel]: value } : point)),
    })
  }

  const addPoint = () => {
    const last = sorted.at(-1)!
    const point = {
      id: newId('point'),
      timeSec: last.timeSec + profile.coolDurationSec,
      fan: last.fan,
      heat: last.heat,
    }
    onChange({
      ...profile,
      points: [...profile.points, point],
      coolDurationSec: 60,
      updatedAt: new Date().toISOString(),
    })
    setSelectedId(point.id)
  }

  /**
   * What is under the finger, for the drag guides. The time axis already labels every step, but the
   * LEVEL being dragged to would be readable only by eye against a gridline - so both axes get the
   * same dashed guide and the same axis chip the journey editor draws.
   */
  const dragged = drag ? sorted.find((point) => point.id === drag.id) : undefined
  const draggedLevel = dragged && drag ? dragged[drag.channel] : undefined
  // The same axis plan the journey chart draws: every step labelled where it falls, round fillers
  // only where those leave the axis empty.
  const timeTicks = planTimeTicks(
    sorted.map((point) => point.timeSec),
    duration,
  )
  const endDrag = () => {
    if (drag) menuGuardUntil.current = Date.now() + CONTEXT_MENU_GUARD_MS
    setDrag(null)
  }
  const insertFromChart = (event: JSX.TargetedMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const pointX = ((event.clientX - rect.left) / rect.width) * viewWidth
    if (pointX < plotLeft || pointX > plotRight) return
    const requestedTimeSec = ((pointX - plotLeft) / (plotRight - plotLeft)) * duration
    const id = newId('point')
    const next = insertTimedPoint(profile, requestedTimeSec, id)
    if (next === profile) return
    onChange({ ...next, updatedAt: new Date().toISOString() })
    setSelectedId(id)
  }

  return (
    <div className="timeline-editor">
      <svg
        className={drag ? 'profile-chart timed-lanes dragging' : 'profile-chart timed-lanes'}
        viewBox={`0 0 ${viewWidth} ${chartHeight}`}
        onPointerMove={handleMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(event) => {
          if (Date.now() <= menuGuardUntil.current) event.preventDefault()
        }}
        onDblClick={insertFromChart}
      >
        <rect className="chart-bg" width={viewWidth} height={chartHeight} />
        {/* Band and watermark together, under everything: see COOLING_BAND_LABEL. The word sits below
          the Heat lane's zero line, which is where a cooling step's trace already is, so nothing it
          could collide with is drawn there. */}
        {coolingSpans.map((span) => (
          <g key={`${span.startSec}-${span.endSec}`} className="cooling-zone" aria-hidden="true">
            <rect
              className="cooling-chart-band"
              x={x(span.startSec)}
              y="20"
              width={x(span.endSec) - x(span.startSec)}
              height={chartHeight - 50}
            />
            <CoolingBandLabel left={x(span.startSec)} right={x(span.endSec)} y={laneBase('heat') + 35} />
          </g>
        ))}
        {levels.map((level) => (
          <g key={level}>
            <line className="grid-line" x1={plotLeft} x2={plotRight} y1={y(level, 'fan')} y2={y(level, 'fan')} />
            <line className="grid-line" x1={plotLeft} x2={plotRight} y1={y(level, 'heat')} y2={y(level, 'heat')} />
            <text className="level-label" x="58" y={y(level, 'fan') + 3} text-anchor="end">
              {level}
            </text>
            <text className="level-label" x="58" y={y(level, 'heat') + 3} text-anchor="end">
              {level}
            </text>
          </g>
        ))}
        <text className="lane-title fan-key" x="18" y="30">
          FAN
        </text>
        <text className="lane-title heat-key" x="18" y="250">
          HEAT
        </text>
        <path className="automation-path fan-trace" d={stepPath('fan')} />
        <path className="automation-path heat-trace" d={stepPath('heat')} />
        {timeTicks.map((tick) => (
          <text
            key={`tick-${tick.kind}-${tick.timeSec}`}
            className={tick.kind === 'point' ? 'time-label point-time-label' : 'time-label'}
            x={x(tick.timeSec)}
            y={chartHeight - 15}
            text-anchor="middle"
          >
            {formatClock(tick.timeSec)}
          </text>
        ))}
        {dragged &&
          drag &&
          draggedLevel !== undefined &&
          (() => {
            const pointX = x(dragged.timeSec)
            const pointY = y(draggedLevel, drag.channel)
            return (
              <g className="drag-guides" aria-hidden="true">
                <line className="drag-guide" x1={plotLeft} x2={pointX} y1={pointY} y2={pointY} />
                <line className="drag-guide" x1={pointX} x2={pointX} y1={pointY} y2={chartHeight - 30} />
                <rect className="drag-axis-chip" x="24" y={pointY - 9} width="38" height="18" rx="3" />
                <text className="drag-axis-value" x="58" y={pointY + 4} text-anchor="end">
                  {draggedLevel.toFixed(1)}
                </text>
                <rect className="drag-axis-chip" x={pointX - 27} y={chartHeight - 29} width="54" height="18" rx="3" />
                <text className="drag-axis-value" x={pointX} y={chartHeight - 15} text-anchor="middle">
                  {formatClock(dragged.timeSec)}
                </text>
              </g>
            )
          })()}
        {sorted.flatMap((point) =>
          (['fan', 'heat'] as const).map((channel) => (
            <circle
              key={`${point.id}-${channel}`}
              className={`automation-node ${channel} ${selectedId === point.id ? 'selected' : ''}`}
              cx={x(point.timeSec)}
              cy={y(point[channel], channel)}
              r={Math.round(8 * touchScale)}
              onPointerDown={(event) => {
                if (!beginsDrag(event)) return
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                menuGuardUntil.current = Number.POSITIVE_INFINITY
                setSelectedId(point.id)
                setDrag({ id: point.id, channel })
              }}
              onDblClick={(event) => {
                event.stopPropagation()
                removePoint(point.id)
              }}
            >
              <title>{`Step at ${formatClock(point.timeSec)}; double-click to delete`}</title>
            </circle>
          )),
        )}
      </svg>
      <div className="journey-chart-hint">
        Drag a Fan or Heat point to change its time and level. Double-click empty chart space to insert a step with the
        levels held there, or double-click a point to delete it. The table buttons remain available for touch and
        keyboard use.
      </div>
      <div className="editor-toolbar">
        <strong>Program steps</strong>
        <button type="button" className="secondary-button" onClick={addPoint}>
          <Plus size={17} />
          Add step
        </button>
      </div>
      <div className="profile-points-table-wrap">
        <table className="profile-points-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>At</th>
              <th>Duration (m:ss)</th>
              <th>Fan</th>
              <th>Heat</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((point, index) => {
              const stepDuration =
                index < sorted.length - 1 ? sorted[index + 1].timeSec - point.timeSec : profile.coolDurationSec
              return (
                <tr
                  key={point.id}
                  className={`${selectedId === point.id ? 'selected ' : ''}${point.heat === 0 ? 'cooling-row' : ''}`}
                  onClick={() => setSelectedId(point.id)}
                >
                  <td data-label="Step">{index + 1}</td>
                  <td data-label="At" className="absolute-time">
                    {formatClock(point.timeSec)}
                  </td>
                  <td data-label="Duration (m:ss)">
                    <ClockInput
                      label={`Step ${index + 1} duration`}
                      value={stepDuration}
                      onChange={(value) => updateDuration(index, value)}
                    />
                  </td>
                  <td data-label="Fan">
                    <NumberField
                      ariaLabel={`Step ${index + 1} fan`}
                      min={0}
                      max={10}
                      step={0.5}
                      value={point.fan}
                      onCommit={(value) =>
                        value !== undefined && updatePoint(point.id, { fan: Math.round(value * 2) / 2 })
                      }
                    />
                  </td>
                  <td data-label="Heat">
                    <NumberField
                      ariaLabel={`Step ${index + 1} heat`}
                      min={0}
                      max={10}
                      step={0.5}
                      value={point.heat}
                      onCommit={(value) =>
                        value !== undefined && updatePoint(point.id, { heat: Math.round(value * 2) / 2 })
                      }
                    />
                  </td>
                  <td data-label="Actions">
                    <button
                      type="button"
                      className="icon-button danger-icon"
                      aria-label={`Delete step ${index + 1}`}
                      disabled={profile.points.length <= 2}
                      onClick={(event) => {
                        event.stopPropagation()
                        removePoint(point.id)
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Limit fields in one order, so the hit list and the rendered pair cannot disagree. */
const LIMIT_FIELDS: LimitField[] = ['fanMin', 'fanMax', 'heatMin', 'heatMax']

/**
 * How near the pointer has to be to a limit line, in viewBox y units, for that line to be grabbed.
 * A level is 23 units tall on this chart, so this is just under half a level either side - wide
 * enough for a finger, narrow enough that two lines a level apart never contend.
 *
 * It is a distance in USER UNITS, which means it shrinks with the chart: at phone width eleven
 * units is about four real pixels, and nobody has ever hit a four-pixel target with a thumb. So it
 * is multiplied by `chartUnitScale`, and the tolerance a finger gets stays roughly the desktop one.
 * The narrowest step multiplies it by 1.79 - 19.6 units, still inside one level, so "two lines a
 * level apart never contend" holds at every width rather than only at the widest.
 */
const LIMIT_GRAB_UNITS = 11

/**
 * The editable journey path.
 *
 * A journey is stored as zones with durations but read as a path, so every gesture here is a
 * statement about the path and `journeyEdit.ts` turns it back into zones:
 *
 * - drag a point in both axes; time is a boundary move, so the zone before it grows by what the
 *   zone after it loses and nothing downstream shifts;
 * - double-click empty plot to insert a boundary; double-click a POINT to delete it;
 * - "+" appends a zone on the end.
 *
 * A drag renders from a local preview and only commits to the draft on release, so a pointer that
 * never lands - dragged off the chart, cancelled by the browser - changes nothing. Hand-rolled
 * pointer events, mouse and touch both, no dependency.
 *
 * **Limit lines are hit-tested, not painted-over.** A per-line `onPointerDown` makes grabbing a
 * line a question of paint order: with the default `pointer-events: visiblePainted`, any filled mark
 * drawn later swallows everything under it, so with the stock Fan 4-9 and Heat 3-9 bands overlapping
 * almost completely one channel's lines could become ungrabbable. A dashed stroke is also only
 * hittable ON the dashes, so grabbing would work only sometimes. Instead a single handler on the SVG
 * picks the NEAREST line to the pointer within `LIMIT_GRAB_UNITS`, so nothing can cover anything,
 * the whole length of a line is live, and two lines at the same level are told apart by which side
 * the pointer is on rather than by which was drawn last.
 *
 * A limit draws as a row of carets pointing into what it allows (see `caretRun`), and the same rule
 * holds: what a limit line LOOKS like is a question for the paint layer, and what can be grabbed is
 * decided by `pickLimit` against the level alone, so restyling a limit cannot regress the gesture.
 */
function JourneyChart({
  segments,
  onCommit,
  onPreview,
}: {
  segments: ThermalSegment[]
  onCommit: (segments: ThermalSegment[]) => void
  onPreview: (segments?: ThermalSegment[]) => void
}) {
  const [drag, setDrag] = useState<{ index: number; timeSec: number; temperatureC: number } | null>(null)
  const [limitDrag, setLimitDrag] = useState<{ id: string; field: LimitField; level: number } | null>(null)
  // Until when a `contextmenu` on this chart is assumed to be the tail of a drag. Infinite while one
  // is live, and a short window after, because the platform raises the menu on the RELEASE.
  const menuGuardUntil = useRef(0)
  // Hover and keyboard focus are tracked so the value callout can answer all three gestures.
  const [hoverLimit, setHoverLimit] = useState<{ id: string; field: LimitField } | null>(null)
  const [focusLimit, setFocusLimit] = useState<{ id: string; field: LimitField } | null>(null)
  const height = 340
  const plotBottom = 282
  // A two-line header band sits above the plot: the axis titles, then the legend. Nothing in it can
  // collide with the topmost limit carets, which sit on the plot's top edge at level 10.
  const plotTop = 52
  // The one shared gutter: labels right-aligned ending at 46, rule and outward ticks 53-58, the
  // bean-color strip 66-77, plot from 90. See TEMPERATURE_GUTTER and chartGeometry.test.ts.
  const { plotLeft, labelX } = TEMPERATURE_GUTTER
  // Both gutters are fixed; the plot is what the width actually buys. The right one is 84 units,
  // which is the actuator axis and its title.
  const viewWidth = useChartWidth()
  const touchScale = chartUnitScale(viewWidth)
  const plotRight = viewWidth - 84
  const grabUnits = LIMIT_GRAB_UNITS * touchScale
  // A node is a touch target before it is a mark, so it grows as the chart narrows; the label above
  // it keeps its 7-unit clearance rather than being swallowed by the bigger circle.
  const nodeRadius = Math.round(9 * touchScale)
  const preview = drag ? moveBoundary(segments, drag.index, drag.timeSec, drag.temperatureC) : segments
  const points = journeyPoints(preview)
  const duration = Math.max(journeyDurationSec(preview), MINIMUM_ZONE_SEC)
  const x = (time: number) => plotLeft + (time / duration) * (plotRight - plotLeft)
  // The domain is 50-250 °C. Zone fields still accept anything; the CHART clamps what it draws.
  const y = temperatureScale(plotTop, plotBottom)
  const actuatorY = (level: number) => plotBottom - (Math.max(0, Math.min(10, level)) / 10) * (plotBottom - plotTop)
  const scale = {
    gradientId: 'journey-roast-color',
    y,
    domainMinC: CHART_DOMAIN_C.minimumC,
    domainMaxC: CHART_DOMAIN_C.maximumC,
  }
  const path = points
    .map(
      (point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.timeSec).toFixed(1)} ${y(point.temperatureC).toFixed(1)}`,
    )
    .join(' ')

  const times = boundaryTimes(preview)
  let bandStart = 0
  const coolingBands = preview
    .map((segment) => {
      const start = bandStart
      bandStart += segment.durationSec
      // The watermark sits just above the highest caret row in the band's lower half, so it never
      // lands on a limit marker; with no low rows it keeps to the plot floor.
      const lowRows = [segment.fanMin, segment.fanMax, segment.heatMin, segment.heatMax].filter((level) => level <= 5)
      const labelLevel = lowRows.length > 0 ? Math.max(...lowRows) : undefined
      return segment.endC < segment.startC ? { id: segment.id, start, end: bandStart, labelLevel } : undefined
    })
    .filter((band): band is { id: string; start: number; end: number; labelLevel: number | undefined } => Boolean(band))

  // 50° majors, exactly as the live chart draws them - the two axes must not disagree.
  const temperatureTicks = axisTicksFrom(CHART_DOMAIN_C.minimumC, CHART_DOMAIN_C.maximumC, 50)
  /*
   * The journey chart labels its time axis the same way the timed chart labels its points: both
   * charts go through `planTimeTicks`, so
   * every zone boundary is labelled at the time it actually falls on and round fillers only cover
   * what those leave empty - which is the sparse-axis rule in the same helper.
   */
  const timeTicks = planTimeTicks(times, duration)

  const positionOf = (event: JSX.TargetedPointerEvent<SVGSVGElement> | JSX.TargetedMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const pointX = ((event.clientX - rect.left) / rect.width) * viewWidth
    const pointY = ((event.clientY - rect.top) / rect.height) * height
    return {
      pointX,
      pointY,
      // Snapped on the way in, so the preview, the commit and the table all agree exactly.
      timeSec: snapTo(((pointX - plotLeft) / (plotRight - plotLeft)) * duration, JOURNEY_TIME_SNAP_SEC),
      temperatureC: snapTo(
        CHART_DOMAIN_C.minimumC +
          ((plotBottom - pointY) / (plotBottom - plotTop)) * (CHART_DOMAIN_C.maximumC - CHART_DOMAIN_C.minimumC),
        JOURNEY_TEMPERATURE_SNAP_C,
      ),
      level: snapTo(((plotBottom - pointY) / (plotBottom - plotTop)) * 10, JOURNEY_LEVEL_SNAP),
    }
  }

  /** The level a limit line is currently sitting at, preview included. */
  const limitLevel = (segment: ThermalSegment, field: LimitField) =>
    limitDrag && limitDrag.id === segment.id && limitDrag.field === field ? limitDrag.level : segment[field]

  /** Every limit line on the chart as a hit candidate, with the span it occupies. */
  const limitTargets = preview.flatMap((segment, index) =>
    LIMIT_FIELDS.map((field) => ({
      id: segment.id,
      field,
      index,
      channel: field.startsWith('fan') ? ('fan' as const) : ('heat' as const),
      bound: field.endsWith('Max') ? ('max' as const) : ('min' as const),
      level: limitLevel(segment, field),
      left: x(times[index]),
      right: x(times[index + 1]),
    })),
  )
  type LimitTarget = (typeof limitTargets)[number]

  /**
   * The nearest limit line to a pointer, or nothing. Ties - a zone whose minimum and maximum sit on
   * the same level - are broken by which side of the line the pointer is on, so a collapsed band
   * can still be opened in either direction. Paint order is never consulted.
   */
  const pickLimit = (pointX: number, pointY: number): LimitTarget | undefined => {
    let best: LimitTarget | undefined
    let bestScore = Number.POSITIVE_INFINITY
    for (const target of limitTargets) {
      if (pointX < target.left - 2 || pointX > target.right + 2) continue
      const lineY = actuatorY(target.level)
      const distance = Math.abs(lineY - pointY)
      if (distance > grabUnits) continue
      const wrongSide = target.bound === 'max' ? pointY > lineY : pointY < lineY
      const score = distance + (wrongSide ? 0.5 : 0)
      if (score < bestScore) {
        bestScore = score
        best = target
      }
    }
    return best
  }

  const sameLimit = (a: { id: string; field: LimitField } | null, b: { id: string; field: LimitField } | null) =>
    a?.id === b?.id && a?.field === b?.field

  const handleMove = (event: JSX.TargetedPointerEvent<SVGSVGElement>) => {
    const position = positionOf(event)
    if (limitDrag) {
      const nextDrag = { ...limitDrag, level: Math.max(0, Math.min(10, position.level)) }
      setLimitDrag(nextDrag)
      onPreview(updateZone(segments, nextDrag.id, orderedLimit(segments, nextDrag.id, nextDrag.field, nextDrag.level)))
      return
    }
    if (drag) {
      const nextDrag = { index: drag.index, timeSec: position.timeSec, temperatureC: position.temperatureC }
      setDrag(nextDrag)
      onPreview(moveBoundary(segments, nextDrag.index, nextDrag.timeSec, nextDrag.temperatureC))
      return
    }
    const target = pickLimit(position.pointX, position.pointY)
    const next = target ? { id: target.id, field: target.field } : null
    if (!sameLimit(next, hoverLimit)) setHoverLimit(next)
  }

  // The one place a limit drag begins. Zone points stop propagation on their own pointerdown, so a
  // point always wins over a line it happens to be sitting on.
  const handleDown = (event: JSX.TargetedPointerEvent<SVGSVGElement>) => {
    if (drag || limitDrag || !beginsDrag(event)) return
    const position = positionOf(event)
    const target = pickLimit(position.pointX, position.pointY)
    if (!target) return
    // Without this the browser starts its own selection drag and every label in the chart
    // highlights blue as the line moves. Double-click to insert a boundary is unaffected: this
    // path is only reached when a line was actually grabbed, and `click` is never cancelled here.
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    menuGuardUntil.current = Number.POSITIVE_INFINITY
    setLimitDrag({ id: target.id, field: target.field, level: target.level })
  }

  const release = () => {
    if (limitDrag || drag) menuGuardUntil.current = Date.now() + CONTEXT_MENU_GUARD_MS
    if (limitDrag) {
      onCommit(
        updateZone(segments, limitDrag.id, orderedLimit(segments, limitDrag.id, limitDrag.field, limitDrag.level)),
      )
      setLimitDrag(null)
    }
    if (drag) {
      onCommit(moveBoundary(segments, drag.index, drag.timeSec, drag.temperatureC))
      setDrag(null)
    }
    onPreview(undefined)
  }

  const nudgeLimit = (target: LimitTarget, step: number) =>
    onCommit(
      updateZone(
        segments,
        target.id,
        orderedLimit(segments, target.id, target.field, snapTo(target.level + step, JOURNEY_LEVEL_SNAP)),
      ),
    )

  /**
   * Delete the point a double-click landed on.
   *
   * A point is a zone BOUNDARY, so removing it merges the two zones it sat between: the survivor
   * takes the pair's whole duration and, once `relink` runs, starts where the removed zone started.
   * Total journey length is unchanged, which is the same contract dragging a boundary keeps. The
   * last point has no zone after it, so it just gives its time back to the zone before it. Point 0
   * is the journey's start temperature rather than a boundary and is never deletable, and the last
   * remaining zone is protected exactly as the table's delete button protects it.
   */
  const deletePoint = (index: number) => {
    if (index <= 0 || segments.length <= 1) return
    const zoneBefore = segments[index - 1]
    const zoneAfter = segments[index] as ThermalSegment | undefined
    if (!zoneAfter) {
      onCommit(removeZone(segments, zoneBefore.id))
      return
    }
    let next = updateZone(segments, zoneBefore.id, { endC: zoneBefore.startC })
    next = updateZone(next, zoneAfter.id, { durationSec: zoneAfter.durationSec + zoneBefore.durationSec })
    next = updateZone(next, zoneBefore.id, { durationSec: 0 })
    onCommit(removeZone(next, zoneBefore.id))
  }

  // Drag wins over hover wins over focus: whichever is live is the one whose value is shown.
  const activeLimit = limitDrag ?? hoverLimit ?? focusLimit
  const activeTarget = activeLimit ? limitTargets.find((target) => sameLimit(target, activeLimit)) : undefined
  const draggedPoint = drag ? points.find((point) => point.index === drag.index) : undefined

  const dragging = Boolean(drag || limitDrag)
  const chartClass = ['profile-chart', 'journey-chart', activeTarget ? 'over-limit' : '', dragging ? 'dragging' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className="journey-chart-shell">
      <svg
        className={chartClass}
        viewBox={`0 0 ${viewWidth} ${height}`}
        aria-label="Temperature journey target path with per-zone Fan and Heat limits, editable"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={release}
        onPointerCancel={() => {
          menuGuardUntil.current = Date.now() + CONTEXT_MENU_GUARD_MS
          setDrag(null)
          setLimitDrag(null)
          onPreview(undefined)
        }}
        onPointerLeave={() => {
          setHoverLimit(null)
          release()
        }}
        onContextMenu={(event) => {
          if (Date.now() <= menuGuardUntil.current) event.preventDefault()
        }}
        onDblClick={(event) => {
          const position = positionOf(event)
          onCommit(insertBoundary(segments, position.timeSec, position.temperatureC))
        }}
      >
        <rect className="chart-bg" width={viewWidth} height={height} />
        <RoastGradientDefs {...scale} />
        {/* Band and watermark together, in the lowest layer of the plot: see COOLING_BAND_LABEL. Ten
          units off the plot floor is under every temperature a cooling zone passes through and above
          the time axis, so the one word has the quietest corner of the band to itself. */}
        {coolingBands.map((band) => (
          <g key={band.id} className="cooling-zone" aria-hidden="true">
            <rect
              className="cooling-chart-band"
              x={x(band.start)}
              y={plotTop - 8}
              width={x(band.end) - x(band.start)}
              height={plotBottom - plotTop + 16}
            />
            <CoolingBandLabel
              left={x(band.start)}
              right={x(band.end)}
              y={band.labelLevel === undefined ? plotBottom - 10 : actuatorY(band.labelLevel) - LIMIT_CARET_HEIGHT - 6}
            />
          </g>
        ))}
        {temperatureTicks.map((tick) => (
          <line key={`t-${tick}`} className="grid-line" x1={plotLeft} x2={plotRight} y1={y(tick)} y2={y(tick)} />
        ))}
        <TimeAxis
          x={x}
          durationSec={duration}
          plotLeft={plotLeft}
          plotRight={plotRight}
          plotTop={plotTop}
          plotBottom={plotBottom}
          labelY={plotBottom + 22}
          ticks={timeTicks}
        />
        <TemperatureAxis {...scale} ticks={temperatureTicks} />
        <RoastColorStrip {...scale} />
        <ActuatorAxis
          y={actuatorY}
          x={plotRight + 10}
          title="Fan / Heat limits 0-10"
          titleEndX={plotRight}
          titleY={20}
        />
        <text className="axis-title" x={plotLeft} y="20">
          Target temperature (°C)
        </text>

        {/*
        Per-zone actuator limits, on the right-hand 0-10 axis: two rows of carets per channel, the
        minimum pointing up and the maximum pointing down, so the pair reads as arrows enclosing the
        range they permit, with no translucent range rect - see `caretRun` for the whole argument, and for why Fan and Heat are drawn out of phase.
      */}
        {preview.map((segment, index) => {
          const left = x(times[index])
          const right = x(times[index + 1])
          return (
            <g key={`limits-${segment.id}`} className="zone-limits">
              {(['fan', 'heat'] as const).map((channel, channelIndex) => {
                const minField = channel === 'fan' ? ('fanMin' as const) : ('heatMin' as const)
                const maxField = channel === 'fan' ? ('fanMax' as const) : ('heatMax' as const)
                return (
                  <g key={channel} className={`limit-band ${channel}`}>
                    {([minField, maxField] as LimitField[]).map((field) => (
                      <path
                        key={field}
                        className={
                          sameLimit({ id: segment.id, field }, activeLimit) ? 'limit-carets active' : 'limit-carets'
                        }
                        d={caretRun(
                          left,
                          right,
                          actuatorY(limitLevel(segment, field)),
                          field.endsWith('Max') ? 'down' : 'up',
                          { phase: (channelIndex * LIMIT_CARET_PITCH) / 2 },
                        )}
                      >
                        <title>{`Zone ${index + 1} ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${limitLevel(segment, field).toFixed(1)} - drag to change`}</title>
                      </path>
                    ))}
                  </g>
                )
              })}
            </g>
          )
        })}

        {/* What the line being dragged, hovered or focused is currently worth, on the line itself. */}
        {activeTarget &&
          (() => {
            const lineY = actuatorY(activeTarget.level)
            const above = lineY - plotTop > 26
            const boxY = above ? lineY - 21 : lineY + 5
            const boxX = Math.max(plotLeft + 2, Math.min(activeTarget.left + 6, plotRight - 100))
            return (
              <g className={`limit-callout ${activeTarget.channel}`} aria-hidden="true">
                <rect x={boxX} y={boxY} width="96" height="16" rx="3" />
                <text
                  x={boxX + 6}
                  y={boxY + 12}
                >{`${activeTarget.channel === 'fan' ? 'Fan' : 'Heat'} ${activeTarget.bound} ${activeTarget.level.toFixed(1)}`}</text>
              </g>
            )
          })()}

        {draggedPoint && (
          <g className="drag-guides" aria-hidden="true">
            <line
              className="drag-guide"
              x1={x(draggedPoint.timeSec)}
              x2={x(draggedPoint.timeSec)}
              y1={y(draggedPoint.temperatureC)}
              y2={plotBottom}
            />
            <line
              className="drag-guide"
              x1={plotLeft}
              x2={x(draggedPoint.timeSec)}
              y1={y(draggedPoint.temperatureC)}
              y2={y(draggedPoint.temperatureC)}
            />
            <rect
              className="drag-axis-chip"
              x={x(draggedPoint.timeSec) - 27}
              y={plotBottom + 9}
              width="54"
              height="18"
              rx="3"
            />
            <text className="drag-axis-value" x={x(draggedPoint.timeSec)} y={plotBottom + 22} text-anchor="middle">
              {formatClock(draggedPoint.timeSec)}
            </text>
            <rect
              className="drag-axis-chip"
              x={labelX - 44}
              y={y(draggedPoint.temperatureC) - 9}
              width="46"
              height="18"
              rx="3"
            />
            <text className="drag-axis-value" x={labelX - 3} y={y(draggedPoint.temperatureC) + 4} text-anchor="end">
              {draggedPoint.temperatureC}
            </text>
          </g>
        )}

        <path className="thermal-target" d={path} />
        {points.map((point) => (
          <g key={`p-${point.index}`}>
            <circle
              className={drag?.index === point.index ? 'thermal-node dragging' : 'thermal-node'}
              cx={x(point.timeSec)}
              cy={y(point.temperatureC)}
              r={nodeRadius}
              onPointerDown={(event) => {
                if (!beginsDrag(event)) return
                event.stopPropagation()
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                menuGuardUntil.current = Number.POSITIVE_INFINITY
                setDrag({ index: point.index, timeSec: point.timeSec, temperatureC: point.temperatureC })
              }}
              onDblClick={(event) => {
                event.stopPropagation()
                deletePoint(point.index)
              }}
            >
              <title>
                {point.index === 0
                  ? `Journey start ${point.temperatureC} °C`
                  : `Zone ${point.index} ends at ${point.temperatureC} °C, ${formatClock(point.timeSec)} - double-click to delete`}
              </title>
            </circle>
            {(() => {
              // Above the node, unless that would put it in the top caret row, in which case below it.
              // The first label aligns inward past the color strip. A label beside a falling line keeps
              // off it: under and left of the node when the next zone falls, above and right of the node
              // (into the margin, clear of the incoming line) when the roast ends on a fall.
              const nodeX = x(point.timeSec)
              const nodeY = y(point.temperatureC)
              const previous = points[point.index - 1]
              const next = points[point.index + 1]
              const above = nodeY - nodeRadius - 7
              const below = above - 11 < plotTop + LIMIT_CARET_HEIGHT
              const placement: { x: number; y: number; anchor: 'start' | 'middle' | 'end' } =
                point.index === 0
                  ? { x: nodeX - nodeRadius, y: above, anchor: 'start' }
                  : !next && previous && previous.temperatureC > point.temperatureC
                    ? { x: nodeX - 4, y: above, anchor: 'start' }
                    : !next
                      ? { x: nodeX + nodeRadius, y: above, anchor: 'end' }
                      : below
                        ? {
                            x: next.temperatureC < point.temperatureC ? nodeX - 2 : nodeX,
                            y: nodeY + nodeRadius + 16,
                            anchor: next.temperatureC < point.temperatureC ? 'end' : 'middle',
                          }
                        : { x: nodeX, y: above, anchor: 'middle' }
              return (
                <text className="thermal-label" x={placement.x} y={placement.y} text-anchor={placement.anchor}>
                  {point.temperatureC} °C
                </text>
              )
            })()}
          </g>
        ))}

        {/*
        Keyboard reach for the same four lines per zone. Invisible, `pointer-events: none` so it
        cannot re-introduce the swallowing this whole rewrite removed, and focusable so a limit can
        be nudged in JOURNEY_LEVEL_SNAP steps without a pointer at all.
      */}
        <g className="limit-focus-layer">
          {limitTargets.map((target) => (
            <line
              key={`hit-${target.id}-${target.field}`}
              className="limit-hit"
              tabindex={0}
              role="slider"
              aria-label={`Zone ${target.index + 1} ${target.channel} ${target.bound === 'max' ? 'maximum' : 'minimum'}`}
              aria-valuemin={0}
              aria-valuemax={10}
              aria-valuenow={target.level}
              x1={target.left}
              x2={target.right}
              y1={actuatorY(target.level)}
              y2={actuatorY(target.level)}
              onFocus={() => setFocusLimit({ id: target.id, field: target.field })}
              onBlur={() => setFocusLimit(null)}
              onKeyDown={(event) => {
                const step =
                  event.key === 'ArrowUp' ? JOURNEY_LEVEL_SNAP : event.key === 'ArrowDown' ? -JOURNEY_LEVEL_SNAP : 0
                if (step === 0) return
                event.preventDefault()
                nudgeLimit(target, step)
              }}
            />
          ))}
        </g>
        <g className="trace-key" transform={`translate(${plotLeft} 40)`}>
          <text className="key target-key" x="0">
            Target °C
          </text>
          <text className="key fan-key" x="86">
            Fan limits
          </text>
          <text className="key heat-key" x="176">
            Heat limits
          </text>
        </g>
      </svg>
      <button
        type="button"
        className="chart-add-zone"
        title="Append a zone at the end of the journey"
        aria-label="Add a zone at the end"
        onClick={() => onCommit(appendZone(segments))}
      >
        <Plus size={19} />
      </button>
      <div className="journey-chart-hint">
        Drag a point in both axes; it snaps to {JOURNEY_TEMPERATURE_SNAP_C} °C and {JOURNEY_TIME_SNAP_SEC} s, and guides
        read it off both axes while you hold it. Drag a Fan or Heat limit - the rows of carets, which point into the
        range that limit allows - to change that zone's range, in steps of {JOURNEY_LEVEL_SNAP}; it shows its value on
        hover, focus and drag, and arrow keys nudge a focused one. Double-click empty chart to insert a zone boundary,
        or double-click a point to delete it. Everything commits on release.
      </div>
    </div>
  )
}

/**
 * The journey editor.
 *
 * **There is no executability banner here, deliberately.** Defining a temperature journey needs no
 * hardware at all, and a warning about the controller on a page that never touches one is noise
 * attached to the wrong event. The equivalent warning lives on the Roast page, where it is conditioned on a journey
 * actually being selected and the probe actually being unusable - see `thermocoupleUnavailableReason`.
 */
function ThermalEditor({ intent, onChange }: { intent: ThermalIntent; onChange: (profile: ThermalIntent) => void }) {
  const [previewSegments, setPreviewSegments] = useState<ThermalSegment[]>()
  const visibleSegments = previewSegments ?? intent.segments
  const commit = (segments: ThermalSegment[]) => onChange({ ...intent, updatedAt: new Date().toISOString(), segments })
  const patch = (id: string, values: Partial<ThermalSegment>) => commit(updateZone(intent.segments, id, values))
  const total = journeyDurationSec(visibleSegments)

  return (
    <div className="thermal-editor">
      <JourneyChart segments={intent.segments} onCommit={commit} onPreview={setPreviewSegments} />
      <div className="editor-toolbar">
        <strong>Journey zones</strong>
        <button type="button" className="secondary-button" onClick={() => commit(appendZone(intent.segments))}>
          <Plus size={17} />
          Add zone
        </button>
      </div>
      <div className="profile-points-table-wrap">
        <table className="profile-points-table zones-table">
          <thead>
            <tr>
              <th>Zone</th>
              <th>Start °C</th>
              <th>End °C</th>
              <th>Duration</th>
              <th>Fan min</th>
              <th>Fan max</th>
              <th>Heat min</th>
              <th>Heat max</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleSegments.map((segment, index) => (
              <tr key={segment.id} className={segment.endC < segment.startC ? 'cooling-row' : undefined}>
                <td data-label="Zone">
                  {index + 1}
                  {segment.endC < segment.startC && <small> cooling</small>}
                </td>
                <td data-label="Start °C">
                  <NumberField
                    ariaLabel={`Zone ${index + 1} start C`}
                    step={1}
                    disabled={index > 0}
                    value={segment.startC}
                    onCommit={(value) => value !== undefined && patch(segment.id, { startC: value })}
                  />
                </td>
                <td data-label="End °C">
                  <NumberField
                    ariaLabel={`Zone ${index + 1} end C`}
                    step={1}
                    value={segment.endC}
                    onCommit={(value) => value !== undefined && patch(segment.id, { endC: value })}
                  />
                </td>
                <td data-label="Duration">
                  <ClockInput
                    label={`Zone ${index + 1} duration`}
                    value={segment.durationSec}
                    onChange={(durationSec) =>
                      patch(segment.id, { durationSec: Math.max(MINIMUM_ZONE_SEC, durationSec) })
                    }
                  />
                </td>
                <td data-label="Fan min">
                  <NumberField
                    ariaLabel={`Zone ${index + 1} fan minimum`}
                    min={0}
                    max={10}
                    step={0.1}
                    value={segment.fanMin}
                    onCommit={(value) =>
                      value !== undefined &&
                      patch(segment.id, orderedLimit(intent.segments, segment.id, 'fanMin', value))
                    }
                  />
                </td>
                <td data-label="Fan max">
                  <NumberField
                    ariaLabel={`Zone ${index + 1} fan maximum`}
                    min={0}
                    max={10}
                    step={0.1}
                    value={segment.fanMax}
                    onCommit={(value) =>
                      value !== undefined &&
                      patch(segment.id, orderedLimit(intent.segments, segment.id, 'fanMax', value))
                    }
                  />
                </td>
                <td data-label="Heat min">
                  <NumberField
                    ariaLabel={`Zone ${index + 1} heat minimum`}
                    min={0}
                    max={10}
                    step={0.1}
                    value={segment.heatMin}
                    onCommit={(value) =>
                      value !== undefined &&
                      patch(segment.id, orderedLimit(intent.segments, segment.id, 'heatMin', value))
                    }
                  />
                </td>
                <td data-label="Heat max">
                  <NumberField
                    ariaLabel={`Zone ${index + 1} heat maximum`}
                    min={0}
                    max={10}
                    step={0.1}
                    value={segment.heatMax}
                    onCommit={(value) =>
                      value !== undefined &&
                      patch(segment.id, orderedLimit(intent.segments, segment.id, 'heatMax', value))
                    }
                  />
                </td>
                <td data-label="Actions">
                  <button
                    type="button"
                    className="icon-button danger-icon"
                    aria-label={`Delete zone ${index + 1}`}
                    disabled={intent.segments.length <= 1}
                    title="Remove this zone; its time goes to the zone before it"
                    onClick={() => commit(removeZone(intent.segments, segment.id))}
                  >
                    <Trash2 size={17} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cooling-floor-note">
        Journey protects circulation automatically: Fan 10 through 130 °C. Above that, Fan follows the solver freely
        within each zone's own Fan range — Heat always keeps Fan at 1.0 or higher — and it returns to Fan 10 for
        cooling.
      </div>
      <div className="thermal-total">Journey duration {formatClock(total)}</div>
    </div>
  )
}

const newTimedProfile = (): TimedProfile => {
  const now = new Date().toISOString()
  return {
    id: newId('profile'),
    name: 'New timed profile',
    revision: 1,
    strategy: 'timed',
    createdAt: now,
    updatedAt: now,
    metadata: { intent: '' },
    notes: '',
    points: [
      { id: newId('point'), timeSec: 0, fan: 8, heat: 5 },
      { id: newId('point'), timeSec: 240, fan: 7.5, heat: 6.5 },
      { id: newId('point'), timeSec: 480, fan: 7, heat: 7 },
      { id: newId('point'), timeSec: 600, fan: 9, heat: 0 },
    ],
    coolFan: 9,
    coolDurationSec: 90,
  }
}

const newJourneyProfile = (): ThermalIntent => {
  const now = new Date().toISOString()
  const zone = (startC: number, endC: number, durationSec: number): ThermalSegment => ({
    id: newId('segment'),
    startC,
    endC,
    durationSec,
    fanMin: 1,
    fanMax: 10,
    heatMin: 0,
    heatMax: 10,
  })
  return {
    id: newId('intent'),
    name: 'New temperature journey',
    revision: 1,
    strategy: 'thermal-intent',
    createdAt: now,
    updatedAt: now,
    metadata: { intent: '' },
    notes: '',
    calibrationStatus: 'unavailable',
    segments: [zone(25, 150, 210), zone(150, 180, 135), zone(180, 205, 150), zone(205, 40, 180)],
  }
}

export function ProfileEditor({
  profiles,
  selectedId,
  suggestions,
  runs,
  calibration,
  revisions,
  snapshots,
  deviceCoefficients,
  revisionDraft,
  defaultMassG,
  runBytes = {},
  deviceLogs = [],
  deleteBlockedReason,
  mutationBlockedReason,
  previewBlockedReason,
  onDeleteProfile,
  onCascadeDelete,
  onRevisionConsumed,
  onSelect,
  onSave,
  onExport,
  onDirtyChange,
  onReorder,
  onOpenRun,
}: ProfileEditorProps) {
  // A temperature journey is the primary profile type, so an empty library opens on one.
  const [emptyLibraryDraft] = useState<Profile>(() => newJourneyProfile())
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedId) ?? profiles[0] ?? emptyLibraryDraft,
    [emptyLibraryDraft, profiles, selectedId],
  )
  const [draft, setDraft] = useState<Profile>(() => structuredClone(selectedProfile))
  const [fromRun, setFromRun] = useState(false)
  const [saving, setSaving] = useState(false)
  // The empty-library starter is passive until edited; New/Duplicate make an explicit local draft.
  const [explicitNewDraft, setExplicitNewDraft] = useState(false)
  /** Which saved revision the draft was loaded from, if it was. See `restoreRevision`. */
  const [restoredFrom, setRestoredFrom] = useState<number>()
  /**
   * The draft is reloaded when a DIFFERENT profile is opened, or when this one is actually saved -
   * never because the parent re-rendered. Keying on the identity of the record rather than on the
   * object reference is what keeps a live poll from wiping an edit in progress.
   */
  const loadedKey = `${selectedProfile.id}:${selectedProfile.revision}:${selectedProfile.updatedAt}`
  const loadedRef = useRef(loadedKey)
  useEffect(() => {
    if (loadedRef.current === loadedKey) return
    loadedRef.current = loadedKey
    setDraft(structuredClone(selectedProfile))
    setFromRun(false)
    setExplicitNewDraft(false)
    setRestoredFrom(undefined)
  }, [loadedKey, selectedProfile])

  useEffect(() => {
    if (!revisionDraft) return
    setDraft(structuredClone(revisionDraft))
    setFromRun(true)
    setExplicitNewDraft(false)
    setRestoredFrom(undefined)
    onRevisionConsumed()
  }, [onRevisionConsumed, revisionDraft])

  const isUnsavedNewProfile = !profiles.some((profile) => profile.id === draft.id)
  // Merely opening an empty catalog is not an edit. The starter becomes dirty only after its value
  // changes; an explicit New/Duplicate draft is intentionally dirty from the button press onward.
  const dirty = explicitNewDraft || profileIsDirty(draft, selectedProfile) || fromRun
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const history = useMemo(
    () =>
      revisions
        .filter((revision) => revision.profileId === draft.id)
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    [draft.id, revisions],
  )

  const persist = async (profile: Profile) => {
    setSaving(true)
    try {
      return await onSave(profile)
    } finally {
      setSaving(false)
    }
  }
  const save = async () => {
    const result = await persist({
      ...(draft.strategy === 'thermal-intent' ? normalizeThermalContinuity(draft) : draft),
      revision: isUnsavedNewProfile ? 1 : draft.revision + 1,
      updatedAt: new Date().toISOString(),
    })
    if (result !== false) {
      setFromRun(false)
      setExplicitNewDraft(false)
      setRestoredFrom(undefined)
    }
  }
  const create = (profile: Profile) => {
    if (dirty && !window.confirm(LEAVE_WITHOUT_SAVING)) return
    setFromRun(false)
    setExplicitNewDraft(true)
    setRestoredFrom(undefined)
    setDraft(profile)
  }
  const duplicate = () => {
    const now = new Date().toISOString()
    create({
      ...structuredClone(draft),
      id: newId('profile'),
      name: `${draft.name} copy`,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
  }
  const open = (id: string) => {
    if (id === draft.id) return
    if (dirty && !window.confirm(LEAVE_WITHOUT_SAVING)) return
    setFromRun(false)
    setExplicitNewDraft(false)
    onSelect(id)
  }

  /**
   * "Load into editor" loads it. The guard, the identity rules and the reason history is never
   * rewritten all live in `restoreRevision`; this only carries the answer into the editor - where
   * it is an unsaved edit like any other, because `dirty` below compares the draft to the stored
   * profile by value and does not care where the draft came from.
   */
  const revert = (entry: ProfileRevision) => {
    // Bound rather than passed by reference: an unbound `window.confirm` is an illegal invocation.
    const next = restoreRevision(entry, selectedProfile, dirty, (message) => window.confirm(message))
    if (!next) return
    setDraft(next)
    setFromRun(false)
    setRestoredFrom(entry.revision)
  }

  const profileRoasts = useMemo(() => runsForProfile(runs, draft.id), [draft.id, runs])

  /**
   * Drag-to-reorder the nav, on pointer events so a finger works as well as a mouse.
   *
   * The drop index is computed from the live geometry of the rows rather than from pointerenter,
   * because during a pointer capture - which is what makes a touch drag track properly - enter and
   * leave events do not fire on the elements being dragged over. Which AXIS that geometry is read
   * on is `dropIndexAt`'s decision, not this component's: the same nav is a column on a desktop and
   * a horizontal strip on a phone.
   */
  const listRef = useRef<HTMLElement>(null)
  useEffect(() => scrollStripToSelected(listRef.current, 'data-profile-id', draft.id), [draft.id])
  const [drag, setDrag] = useState<{ id: string; overIndex: number } | null>(null)
  const dropIndexFor = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-profile-id]')
    if (!rows) return 0
    return dropIndexAt(
      [...rows].map((row) => row.getBoundingClientRect()),
      { x: event.clientX, y: event.clientY },
    )
  }
  const endDrag = () => {
    if (drag && !mutationBlockedReason) {
      const before = profiles.map((profile) => profile.id)
      const after = moveInOrder(before, drag.id, drag.overIndex)
      // A drop where the drag started is not a reorder; it must not write to the roaster.
      if (orderChanged(before, after)) onReorder(after)
    }
    setDrag(null)
  }
  const refocusGripId = useRef<string>()
  useEffect(() => {
    if (!refocusGripId.current) return
    focusGrip(listRef.current, 'data-profile-id', refocusGripId.current, '.profile-grip')
    refocusGripId.current = undefined
  }, [profiles])
  const reorderFromKeyboard = (event: KeyboardEvent, id: string) => {
    const next = keyboardReorder(
      profiles.map((profile) => profile.id),
      id,
      event.key,
    )
    if (event.key.startsWith('Arrow')) event.preventDefault()
    if (!next || mutationBlockedReason) return
    refocusGripId.current = id
    onReorder(next)
  }

  return (
    <section className="view profiles-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">Profile workshop</span>
          <h1 className="sr-only">Profiles</h1>
          <TextField
            className="title-input"
            ariaLabel="Profile name"
            value={draft.name}
            onCommit={(name) => setDraft({ ...draft, name })}
          />
        </div>
        <div className="heading-actions">
          {dirty && mutationBlockedReason && (
            <span className="dirty-tag" role="status">
              {mutationBlockedReason} Your working edits remain in this browser.
            </span>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Export profiles"
            title="Export profiles"
            onClick={onExport}
          >
            <Download size={19} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Duplicate profile"
            title="Duplicate into a local draft"
            disabled={saving}
            onClick={duplicate}
          >
            <CopyPlus size={19} />
          </button>
          <button
            type="button"
            className={
              dirty && !mutationBlockedReason ? 'primary-button profile-save' : 'secondary-button profile-save'
            }
            title={mutationBlockedReason}
            disabled={!dirty || saving || Boolean(mutationBlockedReason)}
            onClick={() => void save()}
          >
            <Save size={18} />
            {saving ? 'Saving…' : isUnsavedNewProfile ? 'Save profile' : 'Save revision'}
          </button>
        </div>
      </div>
      <div className="profile-workspace">
        <aside
          className="profile-list"
          ref={listRef}
          onPointerMove={(event) => {
            if (drag) setDrag({ ...drag, overIndex: dropIndexFor(event) })
          }}
          onPointerUp={endDrag}
          onPointerCancel={() => setDrag(null)}
        >
          <div className="profile-list-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              title="Create a new temperature-journey draft"
              onClick={() => create(newJourneyProfile())}
            >
              <Thermometer size={17} />
              New journey
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              title="Create a new timed-control draft"
              onClick={() => create(newTimedProfile())}
            >
              <Timer size={17} />
              New timed
            </button>
          </div>
          {profiles.map((profile, index) => (
            <div
              key={profile.id}
              data-profile-id={profile.id}
              className={`profile-row${profile.id === draft.id ? ' selected' : ''}${drag?.id === profile.id ? ' dragging' : ''}${drag && drag.overIndex === index ? ' drop-before' : ''}`}
            >
              <span
                className="profile-grip"
                role="button"
                tabIndex={0}
                aria-label={`Reorder ${profile.name}`}
                title={mutationBlockedReason ?? 'Drag or use the arrow keys to reorder'}
                onKeyDown={(event) => reorderFromKeyboard(event, profile.id)}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  setDrag({ id: profile.id, overIndex: index })
                }}
              >
                <GripVertical size={15} />
              </span>
              {/* The name truncates rather than wrapping in the phone-width strip, so the title
              carries what the ellipsis takes - see `.profile-open` in the stylesheet. */}
              <button type="button" className="profile-open" title={profile.name} onClick={() => open(profile.id)}>
                <span>{profile.strategy === 'timed' ? 'Timed control' : 'Temperature journey'}</span>
                <strong>{profile.name}</strong>
                <small>Revision {profile.revision}</small>
              </button>
            </div>
          ))}
          {drag && drag.overIndex >= profiles.length && <div className="profile-row drop-before drop-end" />}
        </aside>
        <div className="profile-canvas">
          {profiles.length === 0 && !dirty && (
            <div className="calibration-banner">
              <Timer size={18} />
              <div>
                <strong>No profiles saved</strong>
                <span>
                  This is an untouched starter draft. Edit it or choose a profile type, then Save profile when you want
                  it stored on the roaster.
                </span>
              </div>
            </div>
          )}
          <div className="strategy-tabs">
            <button
              type="button"
              className={draft.strategy === 'timed' ? 'active' : ''}
              disabled={draft.strategy !== 'timed'}
            >
              Timed control
            </button>
            <button
              type="button"
              className={draft.strategy === 'thermal-intent' ? 'active' : ''}
              disabled={draft.strategy !== 'thermal-intent'}
            >
              Temperature journey
            </button>
          </div>
          {fromRun && (
            <div className="calibration-banner">
              <Gauge size={18} />
              <div>
                <strong>Draft from roast history</strong>
                <span>
                  This draft is the requested Fan and Heat path of a recorded roast. Save a revision to keep it.
                </span>
              </div>
            </div>
          )}
          {/* Loading a revision changes the current working profile, which is an unsaved change.
            So the banner says it in those words, and the Unsaved changes tag in the heading agrees
            with it: `profileIsDirty` compares the draft to the stored profile by VALUE, so a loaded
            revision is dirty exactly when it differs - and legitimately clean when it does not. */}
          {restoredFrom !== undefined && (
            <div className="calibration-banner">
              <History size={18} />
              <div>
                <strong>Loaded revision {restoredFrom} into the editor</strong>
                <span>
                  This is an unsaved change to the working copy on this page - nothing on the roaster has moved. Save
                  revision keeps it, recorded as a new revision on top; the history itself is never rewritten.
                </span>
              </div>
            </div>
          )}
          {draft.strategy === 'timed' ? (
            <TimedLaneEditor profile={draft} onChange={setDraft} />
          ) : (
            <ThermalEditor intent={draft} onChange={setDraft} />
          )}
          {/*
          The authored fields come BEFORE the simulation, on both editors.
          -------------------------------------------------------------
          Intent and profile notes sit above the simulation snapshot, and opening the snapshot must
          not push them down. Pressing Simulate is a question about the profile, and it must not move
          the controls used to author one. The panel is mounted in a slot that keeps
          its position in the document whether it is open or shut, so the order below is the order
          on screen in both states - and the slot is what pins it in the render test.
        */}
          <div className="profile-meta">
            <SuggestionField
              label="Intent"
              value={draft.metadata.intent}
              suggestions={suggestions.intents}
              onChange={(intent) => setDraft({ ...draft, metadata: { ...draft.metadata, intent } })}
            />
            <TextArea
              className="notes-field profile-notes"
              label="Profile notes"
              maxLength={4000}
              value={draft.notes}
              placeholder="Recipe intent, assumptions, and observations"
              onCommit={(notes) => setDraft({ ...draft, notes })}
            />
          </div>
          <div className="simulation-slot">
            {draft.strategy === 'thermal-intent' &&
              (previewBlockedReason ? (
                <div className="setup-blocked" role="status">
                  {previewBlockedReason}
                </div>
              ) : (
                <ProfileSimulationPanel
                  profile={draft}
                  profiles={profiles}
                  calibration={calibration}
                  defaultMassG={defaultMassG}
                  snapshots={snapshots}
                  deviceCoefficients={deviceCoefficients}
                />
              ))}
          </div>
          {/* The row expands; the roast's NAME goes to History focused on it. Same two gestures, same
            shared detail, as the Beans page - see the note there. */}
          <section className="catalog-sheet profile-roasts">
            <div className="editor-toolbar">
              <strong>Roast history</strong>
              <span className="revision-count">Which beans this profile has actually been used on</span>
            </div>
            <DataTable
              rows={profileRoasts}
              rowKey={(run) => run.id}
              emptyMessage="No roasts recorded from this profile yet. Roasts are what the Roast page recommends from, so the first one is what starts that."
              caption="Roasts run from this profile"
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
                  id: 'bean',
                  label: 'Bean lot',
                  priority: 'secondary',
                  value: (run) => run.beanLotSnapshot?.name ?? 'Unspecified',
                },
                {
                  id: 'revision',
                  label: 'Revision used',
                  className: 'numeric',
                  priority: 'secondary',
                  defaultDirection: 'desc',
                  value: (run) => run.profile.revision,
                },
                { id: 'outcome', label: 'Result', priority: 'secondary', value: (run) => run.outcome },
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
              ]}
            />
          </section>
          {/*
          Revision history, which is also how a profile is put back.
          ---------------------------------------------------------
          THE ROW IS NOT THE TRIGGER. Reading a history is the common reason to be in this table and
          loading one is the rare one, so the common gesture - a click on a row to look at it, a drag
          to copy a summary, a stray click on the way past - must never fire the destructive one.
          Loading is an explicit per-row button and nothing else: blank row space does nothing at
          all.

          THE BUTTON IS LABELLED FOR WHAT IT DOES TO WHAT IS IN FRONT OF YOU. "Restore" and "Revert"
          both imply something was put back on the roaster, and nothing has been: this replaces the
          WORKING COPY on this page, which is then an ordinary unsaved edit until Save revision is
          pressed. Hence "Load into editor", and hence the banner it raises saying the same thing.

          Keyboard reach comes from a real `<button type="button">`, with a visible label instead of a bare
          revision number. What a load actually DOES, why the
          draft it leaves behind reads as dirty, and why it can never rewrite what is in this table,
          is all `restoreRevision`.
        */}
          <section className="catalog-sheet revision-history">
            <div className="editor-toolbar">
              <strong>Revision history</strong>
              <span className="revision-count">
                {history.length} saved revision{history.length === 1 ? '' : 's'}
              </span>
            </div>
            {history.length === 0 ? (
              <div className="empty-state">
                No revisions recorded yet. Every Save revision that changes something is logged here with what it was
                and what it became.
              </div>
            ) : (
              <>
                <div className="calibration-table-wrap">
                  <table className="diff-table revision-table">
                    <thead>
                      <tr>
                        <th>Saved</th>
                        <th>Revision</th>
                        <th>What changed</th>
                        <th className="revision-load-head">
                          <span className="sr-only">Load</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((entry) => (
                        <tr key={entry.id}>
                          <td>{new Date(entry.savedAt).toLocaleString()}</td>
                          <td>{entry.revision}</td>
                          <td className="revision-summary">{entry.summary}</td>
                          <td className="revision-load">
                            <button
                              type="button"
                              className="compact-button"
                              aria-label={`Load revision ${entry.revision} into the editor`}
                              title={`Load revision ${entry.revision} into the editor`}
                              onClick={() => revert(entry)}
                            >
                              Load into editor
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="revision-history-hint">
                  Load into editor replaces the working copy on this page with what that revision saved - an unsaved
                  change like any other, until you press Save revision. Unsaved work is confirmed first, and loading
                  never rewrites the history: saving records a new revision on top of it.
                </div>
              </>
            )}
          </section>
          {/*
          What deleting this profile would actually cost, before it is offered. Both options are
          stated as what they are - see `DeleteImpactPanel`; the roasts survive either way unless the
          cascade is explicitly chosen and typed for.

          Withheld for the LAST profile, because the Roast page is built around there being one to
          select and an empty library would leave the app with nothing to open. That is a structural
          limit rather than a policy, so it is expressed as the control not being there.
        */}
          {onDeleteProfile && onCascadeDelete && !isUnsavedNewProfile && profiles.length > 1 && (
            <DeleteImpactPanel
              subject="profile"
              id={selectedProfile.id}
              name={selectedProfile.name}
              runs={runs}
              runBytes={runBytes}
              deviceLogs={deviceLogs}
              blockedReason={deleteBlockedReason}
              onDeleteEntity={() => onDeleteProfile(selectedProfile.id)}
              onCascade={onCascadeDelete}
            />
          )}
        </div>
      </div>
    </section>
  )
}
