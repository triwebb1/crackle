import { BookOpen, Clock3, ExternalLink, Palette, Thermometer } from 'lucide-preact'
import {
  celsiusToFahrenheit,
  formatApproximateTemperature,
  formatReferenceRange,
  roastColorStops,
  roastReferenceBands,
  roastStyleReferences,
} from '../domain/roastReference'

const sources = [
  {
    label: 'Thermal contaminants in coffee induced by roasting: a review',
    href: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10138461/',
  },
  {
    label: 'Effects of postharvest processing on aroma formation in roasted coffee',
    href: 'https://academic.oup.com/ijfst/article/58/3/1007/7807986',
  },
  { label: 'Coffee Flavor: A Review', href: 'https://www.mdpi.com/2306-5710/6/3/44' },
  {
    label: "Sweet Maria's roasted coffee color card",
    href: 'https://library.sweetmarias.com/sweet-marias-roasted-coffee-color-card/',
  },
  {
    label: "Sweet Maria's Quest roast-degree handbook",
    href: 'https://library.sweetmarias.com/wp-content/uploads/2021/05/QuestHandbookwith-links.pdf',
  },
]

const bandLabel = (kind: string) =>
  kind === 'milestone'
    ? 'Roaster milestone'
    : kind === 'risk'
      ? 'Limit region'
      : kind === 'physical'
        ? 'Physical change'
        : 'Chemistry band'

export function ReferenceView() {
  return (
    <section className="view reference-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">Roast manual</span>
          <h1>Temperature and flavor reference</h1>
        </div>
      </div>
      <div className="reference-caution">
        <Thermometer size={21} />
        <div>
          <strong>Use these as working bands, not setpoints to roast to</strong>
          <span>
            Bean-temperature readings depend on probe placement, airflow, batch size, calibration, and thermal lag.
            Calibrate milestones against this SR800 and its installed probe before treating any listed temperature as
            exact.
          </span>
        </div>
      </div>

      <section className="reference-section">
        <div className="reference-section-heading">
          <BookOpen size={19} />
          <div>
            <span className="eyebrow">Working table</span>
            <h2>What changes as beans get hotter</h2>
          </div>
        </div>
        <div className="reference-table-wrap">
          <table className="reference-table">
            <thead>
              <tr>
                <th>Temperature band</th>
                <th>Event or reaction</th>
                <th>Visible and aromatic cue</th>
                <th>Effect of more time</th>
                <th>Likely cup direction</th>
              </tr>
            </thead>
            <tbody>
              {roastReferenceBands.map((band) => {
                const range = formatReferenceRange(band.minimumC, band.maximumC)
                return (
                  <tr key={band.id} className={`reference-${band.kind}`}>
                    <td>
                      <strong>{range.fahrenheit}</strong>
                      <span>{range.celsius}</span>
                      <small>{bandLabel(band.kind)}</small>
                    </td>
                    <td>
                      <strong>{band.title}</strong>
                      <p>{band.process}</p>
                    </td>
                    <td>{band.visual}</td>
                    <td>{band.timeEffect}</td>
                    <td>{band.cupDirection}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="reference-section color-reference">
        <div className="reference-section-heading">
          <Palette size={19} />
          <div>
            <span className="eyebrow">Visual cross-check</span>
            <h2>Approximate bean color progression</h2>
          </div>
        </div>
        <div className="color-scale">
          {roastColorStops.map((stop) => (
            <div className="color-stop" key={stop.name}>
              <div className="bean-swatch" style={{ backgroundColor: stop.color }} aria-hidden="true">
                <span />
              </div>
              <strong>{stop.name}</strong>
              <span>
                {Math.round(celsiusToFahrenheit(stop.temperatureC))} °F / {stop.temperatureC} °C
              </span>
              <small>{stop.cue}</small>
            </div>
          ))}
        </div>
        <p className="color-note">
          Color is often more transferable than an uncalibrated probe number, but lighting, bean process, surface oil,
          and camera white balance can all shift perception. Compare cooled beans under the same neutral light.
        </p>
      </section>
      <section className="reference-section roast-name-reference">
        <div className="reference-section-heading">
          <Palette size={19} />
          <div>
            <span className="eyebrow">Common shorthand</span>
            <h2>Traditional roast names</h2>
          </div>
        </div>
        <p className="roast-style-intro">
          <strong>These names and temperatures are approximate, not standards.</strong> The temperatures are traditional
          internal-bean endpoints, not targets for Crackle's probe. Use cooled color and crack timing to build a
          reference from this roaster's own recorded batches.
        </p>
        <div className="roast-style-scale">
          {roastStyleReferences.map((style) => {
            const range = formatApproximateTemperature(style.minimumC, style.maximumC)
            return (
              <article className="roast-style-card" key={style.id}>
                <span className="roast-style-swatch" style={{ backgroundColor: style.color }} aria-hidden="true" />
                <div>
                  <span className="eyebrow">{style.family}</span>
                  <h3>{style.names}</h3>
                  <strong>
                    ≈ {range.fahrenheit} / {range.celsius}
                  </strong>
                  <p>
                    <b>{style.colorName}.</b> {style.landmark}
                  </p>
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section className="reference-section time-reference">
        <div className="reference-section-heading">
          <Clock3 size={19} />
          <div>
            <span className="eyebrow">Time at temperature</span>
            <h2>Temperature is not a dose by itself</h2>
          </div>
        </div>
        <div className="time-principles">
          <div>
            <strong>Reaction speed is nonlinear</strong>
            <p>
              A few seconds at a high temperature can produce more change than much longer at a lower one. Time and
              temperature cannot be exchanged one-for-one.
            </p>
          </div>
          <div>
            <strong>Moisture changes the pathway</strong>
            <p>
              Early water loss affects heat transfer and browning. Reaching the same endpoint by a different drying path
              can produce a different cup.
            </p>
          </div>
          <div>
            <strong>Momentum matters</strong>
            <p>
              The rate entering first crack affects how the bean continues reacting. A target temperature cannot reveal
              whether the roast raced, stalled, or recovered.
            </p>
          </div>
          <div>
            <strong>Use repeated evidence</strong>
            <p>
              Record target crossings, color, weight loss, and taste. The useful reference will eventually be this
              machine's own history for the same bean lot.
            </p>
          </div>
        </div>
      </section>

      <section className="reference-sources">
        <h2>Sources and visual references</h2>
        <p>
          The bands synthesize published roasting reviews and practical color references. They intentionally avoid
          copying a third-party chart as the app's source of truth.
        </p>
        <div>
          {sources.map((source) => (
            <a href={source.href} target="_blank" rel="noreferrer" key={source.href}>
              {source.label}
              <ExternalLink size={14} />
            </a>
          ))}
        </div>
      </section>
    </section>
  )
}
