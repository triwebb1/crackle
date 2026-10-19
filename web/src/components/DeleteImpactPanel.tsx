import { Trash2, TriangleAlert } from 'lucide-preact'
import { useMemo, useState } from 'preact/hooks'
import type { DeviceLogEntry } from '../domain/deviceLogs'
import { type CascadePlan, cascadePlan, formatBytes, withRecordingBytes } from '../domain/storage'
import type { RoastRun } from '../domain/types'
import { TextField } from './TextField'

/**
 * ============================================================================================
 * WHAT DELETING THIS WOULD ACTUALLY DO
 * ============================================================================================
 *
 * A natural assumption is that deleting a profile or a bean lot requires deleting every historical
 * roast that used it. It does not, and the most useful thing this panel does is say so out loud. **Every
 * stored roast embeds its own snapshot of the profile and the bean lot it ran with**, so a roast
 * whose profile has been deleted still opens, still charts and still compares - it simply lists as
 * unlinked. Both options are therefore offered as what they are, side by side, rather than one being
 * presented as the consequence of the other:
 *
 *   a. **Delete the recipe only.** Nothing historical is lost. This is almost always the right one.
 *   b. **Delete it and its roasts**, with their recordings. This is the one that destroys data, so it
 *      states the exact count, the exact bytes reclaimed and the exact date range first, then asks
 *      for the name to be typed, and says in as many words that there is no undo.
 *
 * The plan behind (b) is built by `domain/storage.ts` and tested there: which run documents die,
 * which recording ids die with them, and nothing else. A recording the controller no longer holds is
 * never listed, because a delete issued for it would answer 404 and read as a failure.
 */

export interface DeleteImpactPanelProps {
  subject: 'profile' | 'bean'
  id: string
  name: string
  runs: RoastRun[]
  runBytes: Record<string, number>
  deviceLogs: DeviceLogEntry[]
  /** Why a cascade cannot run right now, if it cannot. Deletes are never queued. */
  blockedReason?: string
  /** Delete the recipe or lot alone. Historical roasts keep their own snapshots. */
  onDeleteEntity: () => void
  /** Delete it and everything linked. Resolves with a sentence describing what happened. */
  onCascade: (plan: CascadePlan) => Promise<string>
}

const dateOf = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : undefined)

/** One date, or both ends of the range. Never "undefined to undefined". */
const spanOf = (plan: CascadePlan) => {
  const from = dateOf(plan.oldest)
  const to = dateOf(plan.newest)
  return from === undefined ? 'no dates' : from === to ? from : `${from} to ${to}`
}

export function DeleteImpactPanel({
  subject,
  id,
  name,
  runs,
  runBytes,
  deviceLogs,
  blockedReason,
  onDeleteEntity,
  onCascade,
}: DeleteImpactPanelProps) {
  const [mode, setMode] = useState<'closed' | 'choose' | 'cascade'>('closed')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState('')

  const plan = useMemo(
    () =>
      withRecordingBytes(
        cascadePlan({
          subject,
          id,
          name,
          runs,
          runBytes,
          deviceLogIds: new Set(deviceLogs.map((entry) => entry.id)),
        }),
        deviceLogs,
      ),
    [deviceLogs, id, name, runBytes, runs, subject],
  )

  const noun = subject === 'profile' ? 'profile' : 'bean lot'
  const linked = plan.runIds.length
  const confirmed = typed.trim() === name.trim() && name.trim().length > 0

  const close = () => {
    setMode('closed')
    setTyped('')
    setOutcome('')
  }

  /*
   * THE HEADLINE IS A SENTENCE ABOUT THIS RECIPE, NOT A ROW OF COUNTERS.
   *
   * A headline like "0 linked roasts, 0 B on the roaster" is a database report read out loud.
   * "Linked" is the schema's word for a relationship the user never made and cannot see, and a pair of zeroes is a fact about storage stated as though it were an impact.
   *
   * So the empty case is written as the empty case, in plain words, and the populated case reads as
   * one sentence continued across the two lines it is set on: what has used it, then what that
   * costs. Nothing quietly does double duty - the first line counts roasts, the second weighs them.
   */
  const used =
    linked === 0
      ? `No roasts have used this ${noun} yet`
      : `${linked} roast${linked === 1 ? '' : 's'} used this ${noun}`
  const cost =
    linked === 0
      ? `Nothing is stored on the roaster for it, so deleting it reclaims nothing and costs nothing.`
      : `${formatBytes(plan.totalBytes)} on the roaster${plan.recordingIds.length > 0 ? ` (${formatBytes(plan.runBytes)} of roast records, ${formatBytes(plan.recordingBytes)} of recordings)` : ''}, ${spanOf(plan)}.`

  return (
    <section className="catalog-sheet delete-impact" aria-label={`Impact of deleting this ${noun}`}>
      <div className="delete-impact-head">
        <div>
          <strong>{used}</strong>
          <span>{cost}</span>
        </div>
        {mode === 'closed' && (
          <button type="button" className="secondary-button danger-button" onClick={() => setMode('choose')}>
            <Trash2 size={17} />
            Delete this {noun}
          </button>
        )}
      </div>

      {outcome && (
        <div className="storage-note" role="status">
          {outcome}
        </div>
      )}

      {mode !== 'closed' && (
        <div className="delete-impact-options">
          {blockedReason && (
            <div className="setup-blocked" role="status">
              {blockedReason}
            </div>
          )}

          <div className="delete-option">
            <strong>Delete the {noun} only</strong>
            <span>
              {linked === 0
                ? `No roast has used this ${noun}, so nothing else changes. Nothing is reclaimed on the roaster beyond the ${noun} itself.`
                : `The ${linked} roast${linked === 1 ? '' : 's'} above keep working: each one stores its own copy of the ${noun} it was roasted with, so its chart, its notes and its comparisons are unaffected. ${linked === 1 ? 'It' : 'They'} will list as no longer having a ${noun} in the catalog. Nothing is reclaimed on the roaster beyond the ${noun} itself.`}
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                onDeleteEntity()
                close()
              }}
            >
              Delete the {noun}, keep the roasts
            </button>
          </div>

          <div className="delete-option danger">
            <strong>
              Delete the {noun} and its {linked} roast{linked === 1 ? '' : 's'}
            </strong>
            <span>
              Reclaims {formatBytes(plan.totalBytes)}: {linked} roast record{linked === 1 ? '' : 's'} and{' '}
              {plan.recordingIds.length} recording{plan.recordingIds.length === 1 ? '' : 's'} still held by the roaster,
              covering {spanOf(plan)}.
            </span>
            {mode === 'choose' ? (
              <button
                type="button"
                className="secondary-button danger-button"
                disabled={linked === 0}
                onClick={() => setMode('cascade')}
              >
                Delete the {noun} and its roasts...
              </button>
            ) : (
              <>
                <div className="delete-warning" role="alert">
                  <TriangleAlert size={17} />
                  <span>
                    This cannot be undone. The roasts and their recordings are removed from the roaster, and the only
                    copy of them after that is whatever backup you have already exported.
                  </span>
                </div>
                <details className="delete-list">
                  <summary>Which roasts ({linked})</summary>
                  <ul>
                    {plan.runNames.map((runName, index) => (
                      <li key={plan.runIds[index]}>{runName}</li>
                    ))}
                  </ul>
                </details>
                <label className="delete-confirm">
                  <span className="form-field-label">
                    Type <strong>{name}</strong> to confirm
                  </span>
                  <TextField value={typed} ariaLabel={`Type ${name} to confirm deletion`} onCommit={setTyped} />
                </label>
                <div className="delete-actions">
                  <button type="button" className="secondary-button" onClick={close}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary-button danger-button"
                    disabled={!confirmed || busy || Boolean(blockedReason)}
                    onClick={() => {
                      setBusy(true)
                      void onCascade(plan)
                        .then((message) => {
                          setOutcome(message)
                          setMode('closed')
                          setTyped('')
                        })
                        .catch((error: unknown) =>
                          setOutcome(error instanceof Error ? error.message : 'The roaster refused the delete'),
                        )
                        .finally(() => setBusy(false))
                    }}
                  >
                    <Trash2 size={17} />
                    {busy ? 'Deleting...' : `Delete ${linked} roast${linked === 1 ? '' : 's'} and the ${noun}`}
                  </button>
                </div>
              </>
            )}
          </div>

          {mode === 'choose' && (
            <button type="button" className="link-button" onClick={close}>
              Cancel
            </button>
          )}
        </div>
      )}
    </section>
  )
}
