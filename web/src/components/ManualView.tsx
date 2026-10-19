import { Gauge, Trash2 } from 'lucide-preact'
import { useMemo, useState } from 'preact/hooks'
import type { HttpControllerClient } from '../controller/client'

import { draftDiffersFromApplied, type LiveDraft, resetDraftToApplied } from '../domain/draft'
import {
  INSTRUCTION_LIMIT_MS,
  type ManualNotice,
  manualApplyBlockedReason,
  manualElapsedMs,
  manualEvent,
  manualEventRows,
  manualParamError,
  manualStopBlockedReason,
  visibleManualNotice,
} from '../domain/manualControl'
import { recordedOnFromRoaster } from '../domain/provenance'
import type { ControllerStatus, ManualEndReason, ManualEvent } from '../domain/types'
import { FanHeatEditor } from './FanHeatEditor'
import { StopIcon } from './StopIcon'

const LEASE_MINUTES = INSTRUCTION_LIMIT_MS / 60000

/**
 * Why the last manual session ended, in words. `instruction_expired` is phrased as the bound it is:
 * nothing failed and nobody was disconnected - the standing instruction simply ran out its lease.
 */
const MANUAL_END_REASON_TEXT: Record<ManualEndReason, string> = {
  stopped: 'stopped',
  fault: 'a fault on the roaster',
  telemetry_stale: 'an interruption in controller temperature updates',
  renewal_rejected: 'a refused heat lease renewal',
  instruction_expired: `Ended because no new instruction arrived for ${LEASE_MINUTES} minutes`,
  heat_lease_expired: 'Ended because requested Heat was no longer being delivered',
}

interface ManualViewProps {
  status: ControllerStatus
  nowMs: number
  modelBlockedReason?: string
  events: ManualEvent[]
  onEvent: (event: ManualEvent) => void
  onClearEvents: () => void
  onOpenRoast?: () => void
  /** App-owned singleton; this view never creates another controller connection. */
  controller?: Pick<HttpControllerClient, 'setManual' | 'stopManual'>
}

const number = (value: number | undefined, places = 1) => (value === undefined ? '--' : value.toFixed(places))
const clock = (ms: number | undefined) => {
  if (ms === undefined) return '--'
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const wallClock = (atMs: number) => new Date(atMs).toLocaleTimeString()
const controlsWording = (value: string | undefined) =>
  value?.replaceAll('Direct control', 'Controls').replaceAll('direct control', 'controls')

// Compared as numbers, never as the strings in the fields: "4" and "4.0" are the same command.
const appliedLevels = (status: ControllerStatus) =>
  status.manual?.active && status.manual.fanLevel !== undefined && status.manual.heatLevel !== undefined
    ? { fan: status.manual.fanLevel, heat: status.manual.heatLevel }
    : undefined

/** Below this the two are the same command reported at different precisions, not a difference. */
const LEVEL_EPSILON = 0.02

/** A compact reason beside the authoritative output, shown only when the roaster constrained it. */
const overrideNote = (status: ControllerStatus): string | undefined => {
  const applied = appliedLevels(status)
  if (!applied) return undefined
  const fanDiffers = status.effectiveFan !== undefined && Math.abs(status.effectiveFan - applied.fan) > LEVEL_EPSILON
  const heatDiffers =
    status.effectiveHeat !== undefined && Math.abs(status.effectiveHeat - applied.heat) > LEVEL_EPSILON
  if (!fanDiffers && !heatDiffers) return undefined
  if (fanDiffers && !heatDiffers) return 'Fan constrained by roaster'
  return 'Output constrained by roaster'
}

export function ManualView({
  status,
  nowMs,
  modelBlockedReason,
  events,
  onEvent,
  onClearEvents,
  onOpenRoast,
  controller,
}: ManualViewProps) {
  /**
   * The form owns these two strings.
   *
   * They are seeded once and afterwards change only when the operator types, uses the stepper, or
   * presses "Match applied". Nothing observed - not full-status reconciliation, not the live stream - may
   * write to them. Inputs re-rendered against polled state would snap a typed 8 back to the applied
   * 4 on the very next frame, and flick a stepper click to 4.1 and back. What the controller is actually running is reported in the
   * live panel below, next to a one-click way to pull it back into the form.
   *
   * `onInput` rather than `onChange` matters here too: in Preact `onChange` is the native change
   * event, which does not fire until the field is committed, so the rendered value and the typed
   * value drift apart in between and the next re-render overwrites the field.
   */
  const [fanRaw, setFanRaw] = useState('4')
  const [heatRaw, setHeatRaw] = useState('0')
  const [applying, setApplying] = useState(false)
  const [stopping, setStopping] = useState(false)
  /**
   * One notice, raised by a command and taken away by the clock.
   *
   * It is stamped rather than timed: the view is already re-rendered against `nowMs` every second,
   * so `visibleManualNotice` retires it without a timer to arm, cancel and tear down - and a
   * confirmation that expires cannot survive into the next command's answer.
   */
  const [notice, setNotice] = useState<ManualNotice>()
  const shown = visibleManualNotice(notice, nowMs)

  const levels = { fan: Number(fanRaw), heat: Number(heatRaw) }
  const paramError = manualParamError(levels, { allowZeroStop: true })

  const roastBlocksControls =
    status.roast?.active === true ? 'Controls are unavailable while a roast is active' : undefined
  const controllerUnavailable = controller ? undefined : 'Controls are not connected to the roaster'
  const applyBlocked =
    modelBlockedReason ??
    roastBlocksControls ??
    controllerUnavailable ??
    manualApplyBlockedReason({ status, nowMs, paramError, busy: applying })
  const stopBlocked = controllerUnavailable ?? manualStopBlockedReason({ status, busy: stopping })

  // Draft and applied are separate values that are only ever compared, never merged.
  const form: LiveDraft<{ fan: number; heat: number }> = { draft: levels, applied: appliedLevels(status) }
  const differs = draftDiffersFromApplied(form)
  const matchApplied = () => {
    const next = resetDraftToApplied(form).draft
    setFanRaw(String(next.fan))
    setHeatRaw(String(next.heat))
  }

  const manual = status.manual
  const recordedOn = status.roaster ? recordedOnFromRoaster(status.roaster, status.firmwareVersion) : undefined
  const override = overrideNote(status)
  const elapsedMs = manualElapsedMs(status, nowMs)
  const rows = useMemo(() => manualEventRows(events, nowMs, manual?.active === true), [events, manual?.active, nowMs])

  /** Exactly one notice per command the OPERATOR issued, and never one for anything else. */
  const announce = (result: { ok: boolean; message?: string }, success: string) => {
    setNotice({
      tone: result.ok ? 'ok' : 'error',
      text: result.ok ? (result.message ?? success) : (result.message ?? 'The roaster rejected that command'),
      atMs: Date.now(),
    })
    return result.ok
  }

  // No confirmation on either command. This is fluid manual operation: the capability gate, the
  // connected-and-fresh checks, and the firmware's always-on protocols are the guards, and a
  // dialog between the operator and the Stop button would be actively harmful.
  const apply = async () => {
    if (applyBlocked || !controller || !recordedOn) return
    setApplying(true)
    const result = await controller.setManual(levels)
    if (announce(result, 'Control levels applied')) {
      onEvent(
        manualEvent({
          atMs: Date.now(),
          kind: 'apply',
          fan: levels.fan,
          heat: levels.heat,
          temperatureC: status.temperatureC,
          source: 'local',
          recordedOn,
        }),
      )
    }
    setApplying(false)
  }

  const stop = async () => {
    if (stopBlocked || !controller || !recordedOn) return
    setStopping(true)
    const result = await controller.stopManual()
    if (announce(result, 'Controls stopped')) {
      onEvent(
        manualEvent({
          atMs: Date.now(),
          kind: 'stop',
          fan: 0,
          heat: 0,
          temperatureC: status.temperatureC,
          source: 'local',
          recordedOn,
        }),
      )
    }
    setStopping(false)
  }

  /*
   * There is no re-affirm loop here, and there must not be one.
   *
   * Re-POSTing the applied levels on a timer would make a tab responsible for keeping Heat alive.
   * The firmware enforces a 30-minute instruction lease instead, so
   * closing this page is an ordinary thing to do rather than something that cuts the heat - and the
   * safeguard lives on the device rather than in a timer in a tab that may be suspended anyway. See
   * `manualControl.ts`.
   */

  const clearHistory = () => {
    if (!window.confirm(`Clear all ${events.length} control history rows? The roaster is not affected.`)) return
    onClearEvents()
    setNotice({ tone: 'ok', text: 'Control history cleared', atMs: Date.now() })
  }

  return (
    <section className="view manual-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">Manual operation</span>
          <h1>Controls</h1>
        </div>
      </div>

      {/*
      The number an operator steers by must never scroll away with the knobs on a phone. The
      header strip keeps a small copy, but at arm's length from a hot roaster the working readout
      needs to be large and pinned directly above the controls.
    */}
      <div className="manual-live-bar" role="status" aria-label="Live readout while adjusting levels">
        <span className="manual-live-temp">
          <small>Bean temp</small>
          <strong>
            {!status.connected || status.stale || !status.thermocoupleValid || status.temperatureC === undefined
              ? '--'
              : `${status.temperatureC.toFixed(1)} °C`}
          </strong>
        </span>
        <span className="manual-live-level">
          <small>Fan</small>
          <strong>{!status.connected || status.stale ? '--' : (status.effectiveFan ?? 0).toFixed(1)}</strong>
        </span>
        <span className="manual-live-level">
          <small>Heat</small>
          <strong>{!status.connected || status.stale ? '--' : (status.effectiveHeat ?? 0).toFixed(1)}</strong>
        </span>
      </div>

      {onOpenRoast && (
        <div className="manual-roast-route">
          <div>
            <strong>Want to record a manual roast?</strong>
            <span>
              Set up the bean, batch, and roast name on Roast, then save the finished instruction path as a profile.
            </span>
          </div>
          <button type="button" className="secondary-button" onClick={onOpenRoast}>
            Start a recordable manual roast
          </button>
        </div>
      )}

      {/*
      Two sentences. A paragraph restating every protocol the firmware runs is exactly the text an
      operator scrolls past, and it would bury the one fact they cannot afford to miss. The rest is said where it applies: the
      any controller constraint by the compact note beside authoritative output.
    */}

      {/*
      One transient banner per command, on the same clock whichever way it went. It is keyed on the
      notice so a second command's answer replaces the first outright rather than reusing its box.
    */}
      <section className="calibration-panel manual-panel">
        <div className="calibration-panel-heading">
          <div className="setting-icon">
            <Gauge />
          </div>
          <div>
            <span className="eyebrow">Command</span>
            <h2>Set levels</h2>
          </div>
        </div>
        <p className="manual-command-guidance">
          Enter the levels you want, then apply; apply new values at any time—no need to stop first. Each accepted
          command runs for at most {LEASE_MINUTES} minutes; send any command to reset the clock, or let it end.
        </p>
        <FanHeatEditor
          id="controls-levels"
          fanRaw={fanRaw}
          heatRaw={heatRaw}
          onFanInput={setFanRaw}
          onHeatInput={setHeatRaw}
          outputFan={status.effectiveFan}
          outputHeat={status.effectiveHeat}
          outputState={manual?.active ? `At these levels for ${clock(elapsedMs)}` : 'Controls idle'}
          outputDetail={override}
          draftDiffers={differs}
          onReset={matchApplied}
          onApply={() => void apply()}
          applyLabel={manual?.active ? 'Apply' : 'Start controls at'}
          applyBlockedReason={controlsWording(applyBlocked)}
          busy={applying}
          feedback={shown ? { tone: shown.tone === 'ok' ? 'success' : 'error', text: shown.text } : undefined}
          allowZeroFanWhenHeatOff
          stopAction={
            <button
              type="button"
              className="command-button stop-command manual-stop"
              disabled={Boolean(stopBlocked)}
              title={controlsWording(stopBlocked)}
              onClick={() => void stop()}
            >
              <StopIcon size={17} />
              Stop
            </button>
          }
        />
        {stopBlocked && stopBlocked !== 'Direct control is already idle' && (
          <div className="calibration-blocked" role="status">
            Stop unavailable: {controlsWording(stopBlocked)}
          </div>
        )}
        <details className="manual-diagnostics">
          <summary>
            Roaster details{' '}
            <strong>{status.thermocoupleValid ? `${number(status.temperatureC)} °C` : 'thermocouple fault'}</strong>
          </summary>
          <div className="manual-diagnostics-grid">
            <span>
              Actuator mode<strong>{status.actuatorMode ?? '--'}</strong>
            </span>
            <span>
              Last end reason
              <strong>{manual?.endReason === undefined ? '--' : MANUAL_END_REASON_TEXT[manual.endReason]}</strong>
            </span>
            <span>
              Lifecycle<strong>{status.lifecycle}</strong>
            </span>
          </div>
        </details>
      </section>

      <section className="calibration-panel manual-history-panel">
        <div className="calibration-panel-heading">
          <div className="setting-icon">
            <Gauge />
          </div>
          <div>
            <span className="eyebrow">History</span>
            <h2>Control events</h2>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={events.length === 0}
            title="Delete every stored control history row"
            onClick={clearHistory}
          >
            <Trash2 size={17} />
            Clear history
          </button>
        </div>
        <div className="calibration-table-wrap">
          <table className="diff-table manual-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Fan</th>
                <th>Heat</th>
                <th>Thermocouple</th>
                <th>Held for</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.event.id} className={row.live ? 'manual-row live' : undefined}>
                  <td>
                    {wallClock(row.event.atMs)}
                    {row.event.source === 'firmware' && <small> derived</small>}
                  </td>
                  <td>
                    {row.event.kind}
                    {row.event.detail && <small> {row.event.detail}</small>}
                  </td>
                  <td>{row.event.kind === 'stop' ? 'off' : number(row.event.fan)}</td>
                  <td>{row.event.kind === 'stop' ? 'off' : number(row.event.heat)}</td>
                  <td>{row.event.temperatureC === undefined ? '--' : `${number(row.event.temperatureC)} °C`}</td>
                  <td className="held-for">
                    {clock(row.heldMs)}
                    {row.live && <small> and counting</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/*
        No figure here on purpose. This browser keeps 500 rows, the roaster's own document keeps far
        fewer - and fewer still when it is short of room - so a number printed here would be right
        in one mode and a false promise in the other.
      */}
        {rows.length === 0 && (
          <div className="empty-state">
            No manual events yet. A row appears the moment a command is enforced, and its Held for ticks until the next
            one replaces it; the newest few hundred are kept here, and fewer than that on the roaster itself.
          </div>
        )}
        <div className="manual-history-note">
          Rows are also derived from the status poll, so a run that ended while this tab was closed - a fault stop, a
          rejected lease renewal - appears on the next load with its end reason. That reconciliation is best effort: it
          can only record the one event that reconciles the roaster with the newest stored row, so level changes made
          elsewhere collapse into a single derived row.
        </div>
      </section>
    </section>
  )
}
