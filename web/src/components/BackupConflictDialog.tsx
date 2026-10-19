export type BackupConflictDecision = 'import' | 'roaster' | 'cancel'

interface Props {
  count: number
  names: string[]
  onDecision: (decision: BackupConflictDecision) => void
}

/** One explicit, abortable decision for every conflict in one backup import. */
export function BackupConflictDialog({ count, names, onDecision }: Props) {
  return (
    <div className="modal-backdrop">
      <section
        className="diff-dialog storage-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-conflict-title"
      >
        <div className="diff-dialog-heading">
          <h2 id="backup-conflict-title">Choose which copies to keep</h2>
        </div>
        <div className="storage-confirm-body">
          <p>
            {count} record{count === 1 ? '' : 's'} in this backup also exist on the roaster with different content.
          </p>
          {names.length > 0 && (
            <div className="storage-confirm-file">
              <strong>
                {names.join(', ')}
                {count > names.length ? ', and more' : ''}
              </strong>
              <span>Your choice applies to every conflict in this import.</span>
            </div>
          )}
        </div>
        <div className="diff-actions">
          <button type="button" className="secondary-button" onClick={() => onDecision('cancel')}>
            Cancel import
          </button>
          <button type="button" className="secondary-button" onClick={() => onDecision('roaster')}>
            Keep roaster copies
          </button>
          <button type="button" className="primary-button" onClick={() => onDecision('import')}>
            Use backup copies
          </button>
        </div>
      </section>
    </div>
  )
}
