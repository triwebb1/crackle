import { useEffect, useRef, useState } from 'preact/hooks'

/**
 * A numeric input whose text belongs to the person typing.
 *
 * A numeric field whose rendered value is derived from committed state loses what is being typed
 * whenever a re-render lands between keystrokes. Two things cause it and both are handled here.
 *
 * 1. **`onChange` in Preact is the NATIVE change event**, which does not fire until the field is
 *    committed. Between the first keystroke and blur, the DOM and the vdom disagree, and the next
 *    render of the parent - a poll, a debounce, a sibling's state - writes the old value back.
 *    `onInput` is the event that fires as you type.
 * 2. **Parsing on every keystroke destroys intermediate states.** "" is not 0, "1." is not 1, and
 *    "-" is not a number at all; a field that round-trips through `Number()` on each keystroke
 *    cannot be typed into. The draft is kept as text and only parsed when it is committed.
 *
 * The draft is re-seeded only when the committed value actually changes to something the draft
 * does not already say, so an external change still lands but the operator's typing is never
 * overwritten by a value equal to what they already typed.
 */
export interface NumberFieldProps {
  label?: string
  value: number | undefined
  onCommit: (value: number | undefined) => void
  min?: number
  max?: number
  step?: number
  placeholder?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
  /** Rendered under the control, inside the label. */
  hint?: string
  /**
   * Reports whether the text in the box says something other than the committed value - a number
   * typed but not yet committed by blur or Enter. A form whose Save is enabled only by committed
   * edits uses this so typing "196" and tapping Save on a phone works, and so the leave guard
   * covers a value that exists only in the box. Called with false again on unmount.
   */
  onUncommittedChange?: (uncommitted: boolean) => void
}

const asText = (value: number | undefined) => (value === undefined || Number.isNaN(value) ? '' : String(value))
/** "196.0" and "196" are the same committed value; an unparseable token is compared as typed. */
const canonicalText = (text: string) => {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? String(parsed) : trimmed
}

export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step,
  placeholder,
  disabled,
  className,
  ariaLabel,
  hint,
  onUncommittedChange,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(() => asText(value))
  const committed = useRef(asText(value))
  // Mirrors `committed` as state so a commit that leaves the draft text unchanged still re-renders
  // and the uncommitted report below stays true to the box.
  const [committedText, setCommittedText] = useState(() => asText(value))
  const setCommitted = (text: string) => {
    committed.current = text
    setCommittedText(text)
  }
  useEffect(() => {
    const incoming = asText(value)
    if (incoming === committed.current) return
    setCommitted(incoming)
    setDraft(incoming)
  }, [value])

  const uncommitted = canonicalText(draft) !== committedText
  const reportUncommitted = useRef(onUncommittedChange)
  reportUncommitted.current = onUncommittedChange
  const reported = useRef(false)
  useEffect(() => {
    if (reported.current === uncommitted) return
    reported.current = uncommitted
    reportUncommitted.current?.(uncommitted)
  }, [uncommitted])
  useEffect(
    () => () => {
      if (reported.current) reportUncommitted.current?.(false)
    },
    [],
  )

  const commitDraft = () => {
    const text = draft.trim()
    if (text === '') {
      if (committed.current === '') {
        setDraft('')
        return
      }
      setCommitted('')
      setDraft('')
      onCommit(undefined)
      return
    }
    const parsed = Number(text)
    if (Number.isFinite(parsed)) {
      const canonical = String(parsed)
      if (canonical === committed.current) {
        setDraft(canonical)
        return
      }
      setCommitted(canonical)
      setDraft(canonical)
      onCommit(parsed)
      return
    }
    // An invalid intermediate token is useful while typing, but cannot become authoritative.
    setDraft(asText(value))
  }

  const control = (
    <input
      type="number"
      className={className}
      aria-label={ariaLabel ?? label}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      value={draft}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commitDraft()
      }}
    />
  )

  if (!label) return control
  return (
    <label className="number-field">
      {label}
      {control}
      {hint && <small>{hint}</small>}
    </label>
  )
}
