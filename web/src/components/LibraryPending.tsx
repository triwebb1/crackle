/**
 * A catalog screen's whole body while the roaster library is not yet open in this browser.
 *
 * All-or-nothing rendering: an unopened library is not an empty one. Without this, Profiles would
 * offer an untouched starter draft as "No profiles saved", and Beans and History would claim nothing
 * is stored, for a library this browser simply has not read yet.
 */
export function LibraryPending({ eyebrow, title, reason }: { eyebrow: string; title: string; reason: string }) {
  return (
    <section className="view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="empty-state" role="status">
        <strong>Loading the roaster library…</strong> {reason}
      </div>
    </section>
  )
}
