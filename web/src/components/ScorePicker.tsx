import { SCORE_VALUES } from '../domain/roastScore'

/**
 * One tap picks a score; tapping the chosen score again clears it. A row of ten buttons rather
 * than a number box, because on a phone a number box means a keyboard, and "how much did I like
 * it" should not need one. Each button is a toggle with `aria-pressed`, so the choice is announced.
 */
export function ScorePicker({
  value,
  onChange,
  disabled,
  label = 'Score',
}: {
  value?: number
  onChange: (score: number | undefined) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <fieldset className="score-picker" disabled={disabled}>
      <legend>
        {label}
        <small>
          {value === undefined ? 'How much you liked this bean and roast' : `${value} of 10 · tap again to clear`}
        </small>
      </legend>
      <div className="score-picker-scale" role="group" aria-label={`${label}, 1 to 10`}>
        {SCORE_VALUES.map((score) => (
          <button
            type="button"
            key={score}
            className={value !== undefined && score <= value ? 'score-step filled' : 'score-step'}
            aria-pressed={value === score}
            aria-label={`Score ${score} of 10`}
            onClick={() => onChange(value === score ? undefined : score)}
          >
            {score}
          </button>
        ))}
      </div>
    </fieldset>
  )
}
