import { Fragment } from 'preact'

export type CalibrationDashboardDirection = 'heating' | 'cooling'

export interface CalibrationDashboardCell {
  fan: number
  heat: number
  averageSec?: number
  count: number
  minSec?: number
  maxSec?: number
  stdDevSec?: number
  basis: string
  detail: string
}

export interface CalibrationDashboardPanel {
  id: string
  title: string
  direction: CalibrationDashboardDirection
  basisLabel: string
  cells: CalibrationDashboardCell[]
}

export interface CalibrationDashboardData {
  panels: CalibrationDashboardPanel[]
}

interface CalibrationDashboardProps {
  dashboard: CalibrationDashboardData
  compact?: boolean
}

const LEVELS = Array.from({ length: 11 }, (_, index) => index)
const FAN_LEVELS = [...LEVELS].reverse()
const DIRECTIONS: CalibrationDashboardDirection[] = ['heating', 'cooling']

function pointKey(fan: number, heat: number) {
  return `${fan}:${heat}`
}

export function formatCalibrationDuration(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) return 'No timing estimate'
  if (seconds < 60) return `${seconds.toFixed(1)} seconds`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds - minutes * 60
  return `${minutes} min ${remainder.toFixed(1)} sec`
}

function compactDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = seconds / 60
  return `${Number.isInteger(minutes) ? minutes.toFixed(0) : minutes.toFixed(1)} min`
}

function cellColor(direction: CalibrationDashboardDirection, averageSec: number | undefined, maxSec: number) {
  if (averageSec === undefined || !Number.isFinite(averageSec)) return 'var(--surface-2)'
  const fraction = Math.min(1, Math.max(0, averageSec / Math.max(maxSec, 1)))
  if (direction === 'heating') return `hsl(${45 - fraction * 23} 72% ${93 - fraction * 43}%)`
  return `hsl(${190 + fraction * 10} 62% ${94 - fraction * 45}%)`
}

function HeatmapCard({ panel, compact }: { panel: CalibrationDashboardPanel; compact?: boolean }) {
  const cells = new Map(panel.cells.map((cell) => [pointKey(cell.fan, cell.heat), cell]))
  const available = panel.cells.filter((cell) => cell.averageSec !== undefined)
  const range =
    available.length === 0
      ? 'No timing estimates'
      : `${compactDuration(Math.min(...available.map((cell) => cell.averageSec!)))} to ${compactDuration(Math.max(...available.map((cell) => cell.averageSec!)))}`
  const scaleMaxSec = available.length === 0 ? 0 : Math.max(...available.map((cell) => cell.averageSec!))

  return (
    <article
      class={`calibration-heatmap-card calibration-heatmap-card--${panel.direction}${compact ? ' is-compact' : ''}`}
      role="img"
      aria-label={`${panel.title}, ${panel.direction} response-time heatmap. ${range}. Fan is vertical from 10 to 0; Heat is horizontal from 0 to 10.`}
    >
      <header class="calibration-heatmap-card__header">
        <h4>{compact ? `${panel.direction === 'heating' ? 'Heat' : 'Cool'} · ${panel.title}` : panel.title}</h4>
        {!compact && <span>{panel.basisLabel}</span>}
      </header>

      <div class="calibration-heatmap-grid" aria-hidden="true">
        <span class="calibration-heatmap-axis calibration-heatmap-axis--corner">
          <span>Fan ↓</span>
          <span>Heat →</span>
        </span>
        {LEVELS.map((heat) => (
          <span class="calibration-heatmap-axis" key={`heat-${heat}`}>
            {heat}
          </span>
        ))}
        {FAN_LEVELS.map((fan) => (
          <Fragment key={`fan-${fan}`}>
            <span class="calibration-heatmap-axis" key={`fan-${fan}`}>
              {fan}
            </span>
            {LEVELS.map((heat) => {
              const key = pointKey(fan, heat)
              const cell = cells.get(key)
              const unavailable = cell?.averageSec === undefined
              return (
                <span
                  class={`calibration-heatmap-cell${unavailable ? ' is-unavailable' : ''}`}
                  style={{ backgroundColor: cellColor(panel.direction, cell?.averageSec, scaleMaxSec) }}
                  key={key}
                />
              )
            })}
          </Fragment>
        ))}
      </div>
      <PanelLegend direction={panel.direction} maxSec={scaleMaxSec} />
    </article>
  )
}

function PanelLegend({ direction, maxSec }: { direction: CalibrationDashboardDirection; maxSec: number }) {
  return (
    <div
      class={`calibration-dashboard-legend calibration-dashboard-legend--${direction}`}
      role="img"
      aria-label={`This map's ${direction} response-time scale from zero to ${formatCalibrationDuration(maxSec)}`}
    >
      <span>0 s</span>
      <i aria-hidden="true" />
      <span>{compactDuration(maxSec)}</span>
    </div>
  )
}

export function CalibrationDashboard({ dashboard, compact = false }: CalibrationDashboardProps) {
  if (compact) {
    return (
      <div
        class="calibration-dashboard calibration-dashboard--compact"
        role="region"
        aria-label="Compact calibration response dashboard"
      >
        <div class="calibration-dashboard--compact__cards">
          {dashboard.panels.map((panel) => (
            <HeatmapCard panel={panel} compact key={panel.id} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div class="calibration-dashboard" role="region" aria-label="Calibration response dashboard">
      {DIRECTIONS.map((direction) => {
        const panels = dashboard.panels.filter((panel) => panel.direction === direction)
        const rowTitle = direction === 'heating' ? 'Time to heat' : 'Time to cool'
        const rowId = `calibration-dashboard-${direction}`
        return (
          <section
            class={`calibration-dashboard-row calibration-dashboard-row--${direction}`}
            aria-labelledby={rowId}
            key={direction}
          >
            <div class="calibration-dashboard-row__header">
              <h3 id={rowId}>{rowTitle}</h3>
            </div>
            <div class="calibration-dashboard-cards">
              {panels.map((panel) => (
                <HeatmapCard panel={panel} key={panel.id} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
