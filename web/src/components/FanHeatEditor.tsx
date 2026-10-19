import { Minus, Plus, RotateCcw } from 'lucide-preact'
import type { ComponentChildren } from 'preact'

export interface FanHeatFeedback {
  tone: 'success' | 'error'
  text: string
}

/**
 * One notch of a cockpit stepper: half a level, snapped onto the half-level grid, clamped to the
 * channel's range. Snapping matters more than adding - a draft of 4.3 steps to 4.0 or 5.0? No:
 * 4.3 + 0.5 = 4.8, which rounds to 5.0, and 4.3 - 0.5 = 3.8, which rounds to 4.0 - so an off-grid
 * value joins the grid on its first press instead of walking the odd decimal forever. A field the
 * operator has emptied steps from the channel minimum rather than from NaN.
 */
export const steppedLevel = (raw: string, direction: 1 | -1, minimum: number): string => {
  const current = Number(raw)
  const base = raw.trim() !== '' && Number.isFinite(current) ? current : minimum
  const next = Math.round((base + direction * 0.5) * 2) / 2
  return String(Math.min(10, Math.max(minimum, next)))
}

export interface FanHeatEditorProps {
  id: string
  fanRaw: string
  heatRaw: string
  onFanInput: (value: string) => void
  onHeatInput: (value: string) => void
  appliedFan?: number
  appliedHeat?: number
  outputFan?: number
  outputHeat?: number
  outputState?: string
  outputDetail?: string
  draftDiffers: boolean
  onReset: () => void
  onApply: () => void
  /** The verb. The button itself states the whole command it will send - "Apply Fan 4.0 · Heat 7.0". */
  applyLabel: string
  applyBlockedReason?: string
  busy?: boolean
  feedback?: FanHeatFeedback
  preview?: string
  secondaryAction?: ComponentChildren
  stopAction?: ComponentChildren
  /** Direct Controls accepts 0/0 as Stop; a recordable manual roast requires its Stop action. */
  allowZeroFanWhenHeatOff?: boolean
}

const level = (value: number | undefined) => (value === undefined ? '--' : value.toFixed(1))
const LEVEL_EPSILON = 0.02

/**
 * One interaction for both kinds of manual operation, rebuilt for a thumb at arm's length from a
 * hot roaster: free-typed fields are clumsy mid-roast.
 *
 * The operator's loop is glance -> one notch -> Apply, so each channel is a stepper: two 48 px
 * half-level buttons with the draft value large between them. The value is still an input - direct
 * numeric entry remains for the big jump - but the common case never opens a keyboard. Apply is one
 * full-width button that reads back the exact command it will send, so the confirmation and the
 * command are the same glance; while the draft differs from the roaster the editor says so loudly.
 *
 * The fields are the browser's uncommitted draft. "Current output" is always the roaster's report,
 * and the smaller applied line appears only when that accepted command differs from output.
 */
export function FanHeatEditor({
  id,
  fanRaw,
  heatRaw,
  onFanInput,
  onHeatInput,
  appliedFan,
  appliedHeat,
  outputFan,
  outputHeat,
  outputState,
  outputDetail,
  draftDiffers,
  onReset,
  onApply,
  applyLabel,
  applyBlockedReason,
  busy = false,
  feedback,
  preview,
  secondaryAction,
  stopAction,
  allowZeroFanWhenHeatOff = false,
}: FanHeatEditorProps) {
  const blocked = Boolean(applyBlockedReason) || busy
  const helpId = `${id}-fan-help`
  const feedbackId = `${id}-feedback`
  const fanMinimum = allowZeroFanWhenHeatOff ? 0 : 0.1
  const appliedDiffersFromOutput =
    (appliedFan !== undefined && (outputFan === undefined || Math.abs(appliedFan - outputFan) > LEVEL_EPSILON)) ||
    (appliedHeat !== undefined && (outputHeat === undefined || Math.abs(appliedHeat - outputHeat) > LEVEL_EPSILON))
  // The button says the whole command. A draft that does not parse falls back to the bare verb;
  // the same problem is already blocking Apply with its reason.
  const fanDraft = Number(fanRaw)
  const heatDraft = Number(heatRaw)
  const commandReadable =
    fanRaw.trim() !== '' && heatRaw.trim() !== '' && Number.isFinite(fanDraft) && Number.isFinite(heatDraft)
  const applyCommand = commandReadable
    ? `${applyLabel} Fan ${fanDraft.toFixed(1)} · Heat ${heatDraft.toFixed(1)}`
    : applyLabel

  const stepper = (
    channel: 'fan' | 'heat',
    raw: string,
    onInput: (value: string) => void,
    minimum: number,
    help: ComponentChildren,
    describedBy?: string,
  ) => {
    const label = channel === 'fan' ? 'Fan' : 'Heat'
    return (
      <div className={`level-stepper ${channel}`}>
        <span className="form-field-label">{label}</span>
        <div className="level-stepper-row">
          <button
            type="button"
            className="level-step"
            aria-label={`${label} down 0.5`}
            disabled={busy}
            onClick={() => onInput(steppedLevel(raw, -1, minimum))}
          >
            <Minus size={20} />
          </button>
          <input
            aria-label={label}
            aria-describedby={describedBy}
            inputMode="decimal"
            type="number"
            min={minimum}
            max={10}
            step={0.1}
            value={raw}
            onInput={(event) => onInput(event.currentTarget.value)}
            // Direct entry is the big jump, so the tap that opens the keyboard selects the whole
            // value: the first digit replaces it instead of appending ("41" from a 4). Selection is
            // presentation only - the draft itself changes exactly when the operator types.
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="level-step"
            aria-label={`${label} up 0.5`}
            disabled={busy}
            onClick={() => onInput(steppedLevel(raw, 1, minimum))}
          >
            <Plus size={20} />
          </button>
        </div>
        {help}
      </div>
    )
  }

  return (
    <div className={draftDiffers ? 'fan-heat-editor draft-differs' : 'fan-heat-editor'}>
      <div className="fan-heat-fields">
        {stepper(
          'fan',
          fanRaw,
          onFanInput,
          fanMinimum,
          <small id={helpId}>
            {allowZeroFanWhenHeatOff ? '0 with Heat 0; otherwise 0.1–10.' : '0.1–10. Use Stop to end the roast.'}
          </small>,
          `${helpId}${feedback ? ` ${feedbackId}` : ''}`,
        )}
        {stepper('heat', heatRaw, onHeatInput, 0, <small>0–10</small>)}
      </div>
      <div className="fan-heat-actions">
        <button
          type="button"
          className="primary-button fan-heat-apply"
          disabled={blocked}
          title={applyBlockedReason}
          onClick={onApply}
        >
          {busy ? 'Applying…' : applyCommand}
        </button>
        {secondaryAction}
        {draftDiffers && (
          <button type="button" className="secondary-button fan-heat-reset" onClick={onReset}>
            <RotateCcw size={16} />
            Reset
          </button>
        )}
        {stopAction}
        {draftDiffers && <span className="fan-heat-draft-state dirty">Not applied</span>}
      </div>

      <div className="fan-heat-current" role="status" aria-live="off">
        <div>
          <span>Current output</span>
          <strong>
            Fan {level(outputFan)} · Heat {level(outputHeat)}
          </strong>
        </div>
        {outputState && <span className="fan-heat-state">{outputState}</span>}
        {outputDetail && <small>{outputDetail}</small>}
        {appliedDiffersFromOutput && (
          <small>
            Applied command: Fan {level(appliedFan)} · Heat {level(appliedHeat)}
          </small>
        )}
      </div>

      {preview && (
        <div className="fan-heat-preview" role="status">
          {preview}
        </div>
      )}
      {applyBlockedReason && (
        <div className="fan-heat-blocked" role="status">
          Apply unavailable: {applyBlockedReason}
        </div>
      )}
      {feedback && (
        <div
          id={feedbackId}
          className={`fan-heat-feedback ${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          aria-live={feedback.tone === 'error' ? 'assertive' : 'polite'}
        >
          {feedback.text}
        </div>
      )}
    </div>
  )
}
