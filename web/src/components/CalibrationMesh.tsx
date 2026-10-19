import { type FanTau, responseSummary } from '../domain/meshMetrics'
import type { BaselineMap, PassDelta } from '../domain/thermalLog'
import { meshKey } from '../domain/thermalLog'

// Sequential magnitude ramp: one hue, light to dark. Never a rainbow. The top of the ramp is held
// well short of opaque so the reading itself keeps its contrast - the cell is a background, and a
// background that swallows its own number has stopped being a scale and become decoration.
const tint = (fraction: number) => `rgba(196, 94, 35, ${(0.05 + 0.37 * Math.max(0, Math.min(1, fraction))).toFixed(3)})`

/**
 * THE settled surface. One fact, one artifact, one number per cell.
 *
 * A grid like this fails in three ways: a header the reader cannot perceive, cells holding two
 * unexplained values, and a chart above it repeating the same surface. All three are avoided by
 * subtraction rather than by explanation.
 *
 *   - **One value per cell.** Settled temperature, in C, and nothing else. Settling time is a
 *     different question, and it lives in the moves readout below - where "how long" is the whole
 *     subject rather than a footnote in six-point type.
 *   - **A header that reads as one.** A single header row: the corner names both axes and their
 *     directions, the columns are heat levels, the stub is fan levels, and the unit is stated once
 *     in the legend instead of once per cell.
 *   - **No twin.** No line chart draws the same surface above this table. Pass details use the
 *     recorded temperature/Fan/Heat timeline instead.
 */
export function BaselineMapGrid({ map }: { map: BaselineMap }) {
  const values = Object.values(map.cells)
  if (values.length === 0)
    return <div className="empty-state">No mapped points yet. Run a baseline air map and fetch its thermal log.</div>
  const low = Math.min(...values.map((cell) => cell.steadyStateC))
  const high = Math.max(...values.map((cell) => cell.steadyStateC))
  const span = high - low || 1

  return (
    <div className="baseline-map">
      <div className="calibration-table-wrap">
        <table className="baseline-map-table">
          <caption className="sr-only">Settled air temperature in °C for each fan and heat level</caption>
          <thead>
            <tr>
              <th scope="col" className="map-corner">
                <strong>Fan &#8595;</strong>
                <small>Heat &#8594;</small>
              </th>
              {map.heats.map((heat) => (
                <th scope="col" key={heat}>
                  {heat}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {map.fans.map((fan) => (
              <tr key={fan}>
                <th scope="row">{fan}</th>
                {map.heats.map((heat) => {
                  const cell = map.cells[meshKey(fan, heat)]
                  if (!cell)
                    return (
                      <td key={heat} className="baseline-cell empty">
                        --
                      </td>
                    )
                  return (
                    <td
                      key={heat}
                      className={cell.extrapolated ? 'baseline-cell extrapolated' : 'baseline-cell'}
                      style={{ background: tint((cell.steadyStateC - low) / span) }}
                      title={`Fan ${fan}, heat ${heat}: settles at ${cell.steadyStateC.toFixed(1)} °C${cell.extrapolated ? ' (fitted from a step cut short)' : ''}`}
                    >
                      {cell.steadyStateC.toFixed(0)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="baseline-map-legend">
        <span>
          Settled temperature: {low.toFixed(0)} to {high.toFixed(0)} °C across {values.length} point
          {values.length === 1 ? '' : 's'} from {map.runCount} pass{map.runCount === 1 ? '' : 'es'}.
        </span>
        <span className="baseline-legend-key">
          <i className="swatch measured" />
          held its plateau
          <i className="swatch estimated" />
          fitted from a step cut short ({map.extrapolatedCount})
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- how long a move takes: the moves */

const clockish = (seconds: number) =>
  seconds >= 60
    ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
    : `${seconds.toFixed(0)} s`

/**
 * Typical response speed, one bounded row per measured fan level.
 *
 * Enumerating every possible move turned a twelve-point grid into 132 latent combinations and hid
 * them behind a selector. Response speed is primarily a function of airflow, so this summary shows
 * the measured median and spread at each fan. A grid has at most six fan levels.
 */
export function ResponseTimeSummary({ byFan }: { byFan: FanTau[] }) {
  const rows = responseSummary(byFan)
  if (rows.length === 0)
    return (
      <div className="empty-state">
        No response times measured yet. Record an empty-chamber baseline to measure how quickly each airflow responds.
      </div>
    )
  return (
    <div className="response-summary">
      <div className="calibration-table-wrap">
        <table aria-label="Temperature response by fan">
          <thead>
            <tr>
              <th>Airflow</th>
              <th>63% of the move</th>
              <th>About 95% complete</th>
              <th>Measured spread</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className={row.quality} key={row.fan}>
                <td data-label="Airflow">
                  <strong>Fan {row.fan.toFixed(1)}</strong>
                </td>
                <td data-label="63% of move">{clockish(row.medianSec)}</td>
                <td data-label="95% complete">{clockish(row.medianSec * 3)}</td>
                <td data-label="Measured spread">
                  {row.lowSec === row.highSec
                    ? clockish(row.lowSec)
                    : `${clockish(row.lowSec)}–${clockish(row.highSec)}`}
                </td>
                <td data-label="Evidence">
                  {row.observations} response{row.observations === 1 ? '' : 's'} ({row.rising} heating, {row.falling}{' '}
                  cooling)
                  <small>
                    {row.quality === 'strong'
                      ? 'Consistent evidence'
                      : row.quality === 'mixed'
                        ? 'Wide variation—inspect pass detail'
                        : 'One measurement only'}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="move-legend">
        The 63% column is the measured time constant (tau). A first-order temperature move is roughly 95% complete after
        three time constants; the exact time still depends on the size of the temperature change.
      </p>
    </div>
  )
}

export function PassDeltaTable({ delta }: { delta: PassDelta }) {
  if (delta.points.length === 0)
    return (
      <div className="empty-state">These two passes share no fan and heat point, so there is nothing to compare.</div>
    )
  const drift = (value: number) =>
    value > 0 ? `+${value.toFixed(1)} hotter` : value < 0 ? `${value.toFixed(1)} cooler` : 'unchanged'
  return (
    <>
      <div className="calibration-fit-summary">
        <span>
          Mean absolute drift<strong>{delta.meanAbsDeltaC?.toFixed(2)} °C</strong>
          <small>
            Across {delta.points.length} shared point{delta.points.length === 1 ? '' : 's'}
          </small>
        </span>
        <span>
          Mean signed drift<strong>{delta.meanDeltaC === undefined ? '--' : drift(delta.meanDeltaC)}</strong>
          <small>Positive means this pass runs hotter than the comparison</small>
        </span>
        <span>
          Largest move<strong>{delta.worst ? `${drift(delta.worst.deltaC)}` : '--'}</strong>
          <small>
            {delta.worst ? `Fan ${delta.worst.fan} heat ${delta.worst.heat}` : 'No shared points'}
            {delta.meanAbsDeltaTauSec === undefined ? '' : `, mean |dtau| ${delta.meanAbsDeltaTauSec.toFixed(1)} s`}
          </small>
        </span>
      </div>
      <div className="calibration-table-wrap">
        <table className="diff-table calibration-table">
          <thead>
            <tr>
              <th>Fan : Heat</th>
              <th>This pass</th>
              <th>Comparison</th>
              <th>Drift</th>
              <th>Tau drift</th>
            </tr>
          </thead>
          <tbody>
            {delta.points.map((point) => (
              <tr key={meshKey(point.fan, point.heat)} className={point.extrapolated ? 'recovery-step' : undefined}>
                <td>
                  {point.fan.toFixed(1)} : {point.heat.toFixed(1)}
                  {point.extrapolated && <small> est</small>}
                </td>
                <td>{point.currentC.toFixed(1)} °C</td>
                <td>{point.previousC.toFixed(1)} °C</td>
                <td className={point.deltaC > 0.05 ? 'drift-hot' : point.deltaC < -0.05 ? 'drift-cool' : undefined}>
                  {drift(point.deltaC)}
                </td>
                <td>
                  {point.deltaTauSec === undefined
                    ? '--'
                    : `${point.deltaTauSec > 0 ? '+' : ''}${point.deltaTauSec.toFixed(0)} s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(delta.onlyCurrent > 0 || delta.onlyPrevious > 0) && (
        <div className="calibration-blocked" role="status">
          {delta.onlyCurrent} point{delta.onlyCurrent === 1 ? '' : 's'} only in this pass, {delta.onlyPrevious} only in
          the comparison; those are excluded from the drift figures.
        </div>
      )}
    </>
  )
}
