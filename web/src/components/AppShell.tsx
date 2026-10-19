import {
  BookOpenText,
  ChartNoAxesCombined,
  FlaskConical,
  Gauge,
  History,
  Library,
  Settings,
  Wheat,
} from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { manualElapsedMs } from '../domain/manualControl'
import { liveReadoutHint } from '../domain/navigation'
import type { AppView, ControllerLifecycle, ControllerStatus } from '../domain/types'
import { useArmedConfirm } from './armedConfirm'
import { CrackleMark } from './CrackleMark'
import { type RoasterTargetPresentation, TargetKindBadge } from './RoasterSource'
import { LifecycleBadge } from './Status'
import { StopIcon } from './StopIcon'

const nav = [
  { id: 'roast' as const, label: 'Roast', icon: ChartNoAxesCombined },
  { id: 'history' as const, label: 'History', icon: History },
  { id: 'beans' as const, label: 'Beans', icon: Wheat },
  { id: 'profiles' as const, label: 'Profiles', icon: Library },
  { id: 'manual' as const, label: 'Controls', icon: Gauge },
  { id: 'calibrate' as const, label: 'Calibrate', icon: FlaskConical },
  { id: 'reference' as const, label: 'Reference', icon: BookOpenText },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
]

const level = (value: number | undefined) => (value === undefined ? '--' : value.toFixed(1))

/** mm:ss for the header clock. Minutes keep growing rather than rolling into hours. */
export const elapsedClock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export const HEARTBEAT_DELAYED_AFTER_MS = 3000
export const HEARTBEAT_LOST_AFTER_MS = 5000
export type DeviceHeartbeatState = 'healthy' | 'delayed' | 'lost'

export const deviceHeartbeatState = (status: ControllerStatus, nowMs: number): DeviceHeartbeatState => {
  if (!status.connected || status.receivedAtMs <= 0) return 'lost'
  const ageMs = Math.max(0, nowMs - status.receivedAtMs)
  if (ageMs > HEARTBEAT_LOST_AFTER_MS) return 'lost'
  if (ageMs > HEARTBEAT_DELAYED_AFTER_MS) return 'delayed'
  return 'healthy'
}

const reportAge = (ageMs: number) => {
  const seconds = Math.max(0, Math.floor(ageMs / 1000))
  if (seconds === 0) return 'just now'
  return `${seconds} second${seconds === 1 ? '' : 's'} ago`
}

/** A presentation-only lamp for accepted device reports. It never participates in controller safety. */
export function DeviceHeartbeat({ status, nowMs }: { status: ControllerStatus; nowMs: number }) {
  const state = deviceHeartbeatState(status, nowMs)
  const detail = !status.connected
    ? 'The roaster is not connected.'
    : `Last device report ${reportAge(nowMs - status.receivedAtMs)}.`
  const label = `Device heartbeat ${state}.`
  const title = `${label} ${detail}`
  return (
    <span className={`device-heartbeat ${state}`} title={title} aria-label={label} role="img">
      <span key={status.connected ? status.receivedAtMs : 0} className="device-heartbeat-light" aria-hidden="true" />
    </span>
  )
}

/**
 * The always-on readout. Fan, heat, and probe temperature are the three numbers that matter no
 * matter which screen is open, and they are fed by the 1 Hz WebSocket stream with `/api/live` fallback rather than full-status
 * status document, so they visibly move while a calibration pass or a manual hold is running.
 */
export function LiveStrip({
  status,
  nowMs,
  target,
  onOpen,
  stopAction,
}: {
  status: ControllerStatus
  nowMs: number
  target: AppView
  onOpen: () => void
  stopAction?: ComponentChildren
}) {
  const offline = !status.connected || status.stale
  const latchedFault = !offline && status.fault
  const connectionLabel = !status.connected
    ? 'not connected'
    : status.stale
      ? 'status stale'
      : (status.actuatorMode ?? status.lifecycle.toLowerCase())
  /*
   * A running roast timer visible from every screen. It is the DEVICE
   * clock, read straight from the 1 Hz frames - `status.roast.elapsedSec` advances on every live
   * frame - never a browser-side interval that would drift from what the roaster is executing.
   * An idle Controls session shows the same time-at-current-levels clock ManualView reports.
   */
  const roastElapsedSec = !offline && status.roast?.active === true ? status.roast.elapsedSec : undefined
  const controlsMs = !offline && roastElapsedSec === undefined ? manualElapsedMs(status, nowMs) : undefined
  const elapsedSec = roastElapsedSec ?? (controlsMs === undefined ? undefined : controlsMs / 1000)
  return (
    <div className={offline ? 'live-strip offline' : 'live-strip'} role="status" aria-label="Live roaster readout">
      <DeviceHeartbeat status={status} nowMs={nowMs} />
      {/* The numbers are the control: whatever is driving them is the screen you want next. */}
      <button
        className="live-strip-open"
        type="button"
        title={liveReadoutHint(target)}
        aria-label={liveReadoutHint(target)}
        onClick={onOpen}
      >
        <span className="live-strip-item">
          <small>Fan</small>
          <strong>{offline ? '--' : level(status.effectiveFan)}</strong>
        </span>
        <span className="live-strip-item">
          <small>Heat</small>
          <strong>{offline ? '--' : level(status.effectiveHeat)}</strong>
        </span>
        {/* The unit is its own quieter span so it can never wrap to a second line at phone width;
          the strong is nowrap in the stylesheet, so value and unit move as one reading. */}
        <span className="live-strip-item probe">
          <small>Temp</small>
          <strong>
            {offline || !status.thermocoupleValid || status.temperatureC === undefined ? (
              '--'
            ) : (
              <>
                {status.temperatureC.toFixed(1)}
                <span className="live-strip-unit">°C</span>
              </>
            )}
          </strong>
        </span>
        {elapsedSec !== undefined && (
          <span className="live-strip-item elapsed">
            <small>Time</small>
            <strong>{elapsedClock(elapsedSec)}</strong>
          </span>
        )}
      </button>
      {stopAction}
      <span className={latchedFault ? 'live-strip-chip fault' : 'live-strip-chip'}>
        {latchedFault ? `FAULT ${latchedFault}` : connectionLabel}
      </span>
    </div>
  )
}

export function GlobalStopButton({
  busy,
  onStop,
  confirmRoastStop,
}: {
  busy: boolean
  onStop: () => void
  /**
   * True while a roast is active: interrupting a roast requires an explicit confirmation,
   * because a single accidental phone tap would otherwise abort it.
   * Non-roast stops (fan test, direct controls) remain single-tap.
   */
  confirmRoastStop?: boolean
}) {
  const confirm = useArmedConfirm()
  const explanation = confirmRoastStop
    ? 'Stop the active roast. A first tap asks for confirmation; a second tap within a few seconds stops Fan, Heat, and the roast.'
    : 'Stop Fan, Heat, and the active roaster request.'
  const activate = () => {
    if (!confirmRoastStop) {
      onStop()
      return
    }
    if (confirm.fire()) onStop()
  }
  return (
    <button
      type="button"
      className={confirm.armed ? 'global-stop armed' : 'global-stop'}
      disabled={busy}
      title={explanation}
      aria-label={explanation}
      onClick={activate}
    >
      <StopIcon size={15} />
      {busy ? 'Stopping…' : confirm.armed ? 'Tap again to stop' : 'Stop'}
    </button>
  )
}

interface AppShellProps {
  view: AppView
  onView: (view: AppView) => void
  lifecycle: ControllerLifecycle
  status: ControllerStatus
  nowMs: number
  readoutTarget: AppView
  activeRoaster?: RoasterTargetPresentation
  roasterTargets?: RoasterTargetPresentation[]
  onActiveRoasterChange?: (id: string) => void
  activeRoasterChangeBlockedReason?: string
  /** App-owned controller command; available regardless of the current route or workflow. */
  onStopAll?: () => Promise<{ ok: boolean; message?: string }>
  children: ComponentChildren
}

export function AppShell({
  view,
  onView,
  lifecycle,
  status,
  nowMs,
  readoutTarget,
  activeRoaster,
  onStopAll,
  children,
}: AppShellProps) {
  const [stoppingAll, setStoppingAll] = useState(false)
  const [stopFeedback, setStopFeedback] = useState('')
  const outputsActive = (status.effectiveFan ?? 0) > 0 || (status.effectiveHeat ?? 0) > 0
  const workflowActive =
    status.roast?.active === true || status.calibration?.active === true || status.manual?.active === true
  const stopRelevant = outputsActive || workflowActive || status.lifecycle === 'RUNNING'
  const globalStopVisible = status.connected && stopRelevant && onStopAll !== undefined
  useEffect(() => {
    if (!stopRelevant) setStopFeedback('')
  }, [stopRelevant])
  const stopAll = async () => {
    if (!onStopAll || stoppingAll) return
    // The post-stop cooling tail runs only when this Stop ended an
    // active roast; a fan-test or Controls stop still turns everything off immediately.
    const roastWasActive = status.roast?.active === true
    setStoppingAll(true)
    const result = await onStopAll()
    setStoppingAll(false)
    setStopFeedback(
      result.ok
        ? roastWasActive
          ? 'Stop acknowledged. Heat is off; the fan is cooling for 10 seconds.'
          : 'Stop acknowledged. Fan and Heat are off.'
        : (result.message ?? 'The roaster did not acknowledge Stop.'),
    )
  }
  const controlsUnavailable = status.roast?.active === true
  const navigation = () =>
    nav.map((item) => {
      const Icon = item.icon
      const active = view === item.id
      const disabled = item.id === 'manual' && controlsUnavailable
      return (
        <button
          type="button"
          key={item.id}
          className={active ? 'active' : ''}
          aria-current={active ? 'page' : undefined}
          disabled={disabled}
          title={disabled ? 'Controls are unavailable while a roast is active.' : undefined}
          onClick={() => onView(item.id)}
        >
          <Icon size={21} />
          <span>{item.label}</span>
        </button>
      )
    })
  const currentName = activeRoaster?.name ?? status.roaster?.displayName ?? 'Roaster'
  const connection = !status.connected ? 'Not connected' : status.stale ? 'Status stale' : 'Connected'

  return (
    <div className="app-shell">
      <header className={globalStopVisible ? 'app-header stop-visible' : 'app-header'}>
        <button type="button" className="wordmark" aria-label="Go to Roast" onClick={() => onView('roast')}>
          <span className="wordmark-icon">
            <CrackleMark size={22} />
          </span>
          <strong>Crackle</strong>
        </button>
        <LiveStrip
          status={status}
          nowMs={nowMs}
          target={readoutTarget}
          onOpen={() => onView(readoutTarget)}
          stopAction={
            globalStopVisible ? (
              <GlobalStopButton
                busy={stoppingAll}
                confirmRoastStop={status.roast?.active === true}
                onStop={() => void stopAll()}
              />
            ) : undefined
          }
        />
        {stopFeedback && (
          <span className="global-stop-feedback" role="status">
            {stopFeedback}
          </span>
        )}
        <div className="header-state">
          <div className="installed-roaster-status" role="group" aria-label="Installed roaster">
            <span className="installed-roaster-name">{currentName}</span>
            {(activeRoaster?.simulated ?? status.roaster?.simulated) === true && <TargetKindBadge simulated />}
            <small>{connection}</small>
          </div>
          <LifecycleBadge lifecycle={lifecycle} connected={status.connected} stale={status.stale} />
        </div>
      </header>
      <aside className="side-nav" aria-label="Primary navigation">
        {navigation()}
      </aside>
      <main className="app-main">{children}</main>
      <nav className="mobile-nav" aria-label="Primary navigation">
        {navigation()}
      </nav>
    </div>
  )
}
