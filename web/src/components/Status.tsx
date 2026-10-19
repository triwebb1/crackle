import { AlertTriangle, Wifi, WifiOff } from 'lucide-preact'
import { formatClock } from '../domain/model'
import type { ControllerLifecycle, TelemetrySample } from '../domain/types'

export function LifecycleBadge({
  lifecycle,
  connected = true,
  stale = false,
}: {
  lifecycle: ControllerLifecycle
  connected?: boolean
  stale?: boolean
}) {
  const warning = lifecycle === 'FAULT' || lifecycle === 'MANUAL_LOCKOUT'
  const live = connected && !stale
  const label = !connected ? 'OFFLINE' : stale ? 'STALE' : lifecycle.replace('_', ' ')
  const state = live ? lifecycle.toLowerCase() : connected ? 'stale' : 'disconnected'
  return (
    <span className={`lifecycle-badge state-${state}`}>
      {!live ? <WifiOff size={14} /> : warning ? <AlertTriangle size={14} /> : <Wifi size={14} />}
      <span className="lifecycle-label">{label}</span>
    </span>
  )
}

/**
 * The large readouts. `elapsedNote`, `fanNote` and `heatNote` carry the detail a running roast adds
 * (start time, the control law's unquantized levels), so the roast panel need not repeat the tiles.
 */
export function LiveReadouts({
  sample,
  elapsedSec,
  lifecycle,
  requestedDiffers,
  targetTemperatureC,
  mode,
  elapsedNote,
  fanNote,
  heatNote,
}: {
  sample?: TelemetrySample
  elapsedSec: number
  lifecycle: ControllerLifecycle
  requestedDiffers: boolean
  targetTemperatureC?: number
  mode?: 'timed' | 'journey' | 'manual'
  elapsedNote?: string
  fanNote?: string
  heatNote?: string
}) {
  const error = sample && targetTemperatureC != null ? sample.beanTempC - targetTemperatureC : undefined
  const targetNote =
    targetTemperatureC != null
      ? `target ${targetTemperatureC.toFixed(1)} °C`
      : mode === 'timed'
        ? 'Timed profile — no live temperature target'
        : mode === 'manual'
          ? 'Manual roast — no live temperature target'
          : mode === 'journey'
            ? "Waiting for the roaster's journey target"
            : 'No live temperature target'
  const items = [
    { label: 'Bean temperature', value: sample ? `${sample.beanTempC.toFixed(1)} °C` : '--', tone: 'bt' },
    {
      label: 'Target error',
      value: error == null ? '--' : `${error >= 0 ? '+' : ''}${error.toFixed(1)} °C`,
      tone: error != null && Math.abs(error) > 5 ? 'target warning' : 'target',
      note: targetNote,
    },
    {
      label: 'Fan',
      value: sample ? sample.effectiveFan.toFixed(1) : '--',
      tone: 'fan',
      note: requestedDiffers && sample ? `req ${sample.requestedFan.toFixed(1)}` : fanNote,
    },
    {
      label: 'Heat',
      value: sample ? sample.effectiveHeat.toFixed(1) : '--',
      tone: 'heat',
      note: requestedDiffers && sample ? `req ${sample.requestedHeat.toFixed(1)}` : heatNote,
    },
  ]
  return (
    <div className="live-readouts">
      <div className="readout time">
        <span>Elapsed</span>
        <strong>{formatClock(elapsedSec)}</strong>
        <small>{elapsedNote ?? lifecycle}</small>
      </div>
      {items.map((item) => (
        <div className={`readout ${item.tone}`} key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <small>{item.note ?? ''}</small>
        </div>
      ))}
    </div>
  )
}
