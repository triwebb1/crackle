import { formatClock, runDurationSec } from '../domain/model'
import { formatMetric, roastMetrics } from '../domain/roastMetrics'
import type { RoastRun } from '../domain/types'

/**
 * ============================================================================================
 * WHAT A ROAST ROW OPENS INTO, ON BOTH CATALOG PAGES
 * ============================================================================================
 *
 * The two gestures a roast row offers are different things: clicking a row expands its inline
 * detail; clicking the roast name goes to History focused on that roast.
 *
 * A table without a `detail` leaves the row inert. This is that detail, shared by Beans and
 * Profiles, because a roast is a roast whichever catalog you reached it from and two renderings
 * would drift the moment one gained a field.
 *
 * It deliberately does NOT duplicate History. Editing measurements, notes, comparison and delete
 * live there and are reached by the roast's own name, which is the link in the row above. What is
 * here is what answers "is this the roast I was thinking of" without leaving the lot or the recipe
 * you were reading: how it ran, what it yielded, and what was written down about it.
 */
export function CatalogRoastDetail({ run }: { run: RoastRun; onOpen: (run: RoastRun) => void }) {
  const metrics = roastMetrics(run.measurements)
  const notes = run.notes?.trim()
  return (
    <div className="catalog-roast-detail">
      <div className="roast-covariates">
        <span>
          Duration<strong>{formatClock(runDurationSec(run))}</strong>
        </span>
        <span>
          Result<strong>{run.outcome}</strong>
        </span>
        <span>
          Green density<strong>{formatMetric(metrics.greenDensityGPerMl, 3, ' g/ml')}</strong>
        </span>
        <span>
          Roasted density<strong>{formatMetric(metrics.roastedDensityGPerMl, 3, ' g/ml')}</strong>
        </span>
        <span>
          Expansion
          <strong>{metrics.expansionRatio === undefined ? '--' : `${metrics.expansionRatio.toFixed(2)}x`}</strong>
        </span>
        <span>
          Mass loss<strong>{formatMetric(metrics.massLossPercent, 1, ' %')}</strong>
        </span>
      </div>
      {/* An empty screen is an invitation, so the absence says where the notes are written. */}
      <p className="catalog-roast-notes">
        {notes || 'No notes were written for this roast. Open it in History to add some.'}
      </p>
    </div>
  )
}
