import {
  CALIBRATION_GLOSSARY,
  CALIBRATION_HELP,
  CALIBRATION_TERM_LABELS,
  type CalibrationHelpKey,
} from '../domain/calibrationHelp'

/**
 * Help without furniture.
 *
 * A small `i` button beside every label would mean twenty of them, inside `<label>` elements where
 * they compete with the field's own click target. The same text is delivered two ways instead, and
 * neither of them is a control:
 *
 * - under a form field, as one quiet line of always-visible text (`FieldHelp`);
 * - in one collapsible glossary at the top of the screen, for the reported terms that are not
 *   fields at all (`HelpGlossary`).
 *
 * `calibrationHelp.ts` is still the single source, and the coverage test still asserts that nothing
 * on the screen is shown without an explanation - the glossary is what guarantees it, because a
 * `<details>` element renders its content whether it is open or not.
 */
export function FieldHelp({ term }: { term: CalibrationHelpKey }) {
  return <small className="field-help">{CALIBRATION_HELP[term]}</small>
}

/**
 * A reported term - a table header, a live readout, a fitted figure. The explanation rides on the
 * term itself for a pointer, and lives in the glossary for everything else.
 */
export function TermLabel({ term, label }: { term: CalibrationHelpKey; label: string }) {
  return (
    <span className="term-label" title={CALIBRATION_HELP[term]}>
      {label}
    </span>
  )
}

export function HelpGlossary() {
  return (
    <div className="calibration-glossary">
      {CALIBRATION_GLOSSARY.map((section) => (
        <div className="glossary-section" key={section.heading}>
          <h3>{section.heading}</h3>
          <dl>
            {section.terms.map((term) => (
              <div className="glossary-row" key={term}>
                <dt>{CALIBRATION_TERM_LABELS[term]}</dt>
                <dd>{CALIBRATION_HELP[term]}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}
