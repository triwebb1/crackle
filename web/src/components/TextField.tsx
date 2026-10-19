import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { editTextDraft, focusTextDraft, observeTextValue, startTextDraft } from '../domain/draft'

/**
 * A free-text input whose text belongs to the person typing - the `NumberField` discipline, applied
 * to the other half of the forms.
 *
 * The root cause and the three-step mechanism behind notes reverting about a second after typing
 * stops are written out in `domain/draft.ts`, above `TextDraft`. The short version: Preact
 * re-asserts a controlled `value` on every render whether or not the prop changed, the app
 * re-renders once a second off the live clock, and a field bound to stored state that only commits
 * on `onChange` (the NATIVE change event - blur) therefore has the stored text written back over the
 * typed text on the next tick.
 *
 * Every rule lives in `draft.ts` as pure transitions, so the discipline is unit-tested rather than
 * asserted about markup: an external value may replace the text only when the field is idle and
 * clean, and a value equal to what this field last said returns the SAME state object and re-renders
 * nothing.
 *
 * `onCommit` fires per keystroke, exactly as `NumberField` does, so autosaving callers keep working
 * unchanged. Debouncing the WRITE is the caller's business and is safe: the field never
 * depends on the stored value coming back to keep showing what was typed.
 */

interface TextDraftControl {
  value: string
  onCommit: (value: string) => void
  /** Optional final-value boundary for expression fields that validate only after typing ends. */
  onBlurCommit?: (value: string) => void
}

const useTextDraft = ({ value, onCommit, onBlurCommit }: TextDraftControl) => {
  const [state, setState] = useState(() => startTextDraft(value))
  // `observeTextValue` returns the identical object when nothing observable moved, so a poll that
  // reports the same text costs no render at all.
  useEffect(() => {
    setState((current) => observeTextValue(current, value))
  }, [value])
  return {
    draft: state.draft,
    onInput: (event: { currentTarget: { value: string } }) => {
      const text = event.currentTarget.value
      setState((current) => editTextDraft(current, text))
      onCommit(text)
    },
    onFocus: () => setState((current) => focusTextDraft(current, true)),
    // Leaving the field re-observes whatever is stored now, so a value that arrived while the
    // operator was in it - and was correctly refused then - is picked up as soon as it is safe to.
    onBlur: (event: { currentTarget: { value: string } }) => {
      onBlurCommit?.(event.currentTarget.value)
      setState((current) =>
        onBlurCommit ? focusTextDraft(current, false) : observeTextValue(focusTextDraft(current, false), value),
      )
    },
  }
}

export interface TextFieldProps extends TextDraftControl {
  /** Rendered as the field's own `<label>` when present; omitted, the bare control is returned. */
  label?: ComponentChildren
  placeholder?: string
  ariaLabel?: string
  /** Class on the `<input>` itself. */
  className?: string
  /** Class on the wrapping `<label>`, for callers with their own field layout. */
  labelClassName?: string
  disabled?: boolean
  maxLength?: number
  inputMode?: JSX.HTMLAttributes<HTMLInputElement>['inputMode']
  /** A `<datalist>` id, for the combo fields. */
  list?: string
  /** Rendered inside the label, after the control - a datalist, an error line, a hint. */
  children?: ComponentChildren
}

export function TextField({
  label,
  value,
  onCommit,
  onBlurCommit,
  placeholder,
  ariaLabel,
  className,
  labelClassName,
  disabled,
  maxLength,
  inputMode,
  list,
  children,
}: TextFieldProps) {
  const field = useTextDraft({ value, onCommit, onBlurCommit })
  const control = (
    <input
      type="text"
      className={className}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      inputMode={inputMode}
      list={list}
      value={field.draft}
      onInput={field.onInput}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
    />
  )
  if (label === undefined)
    return (
      <>
        {control}
        {children}
      </>
    )
  return (
    <label className={labelClassName}>
      {label}
      {control}
      {children}
    </label>
  )
}

export interface TextAreaProps extends TextDraftControl {
  label: ComponentChildren
  placeholder?: string
  ariaLabel?: string
  maxLength: number
  /** Class on the wrapping `<label>`; the notes fields all carry their own. */
  className?: string
  counterClassName?: string
  /** Rendered inside the label, after the counter - field help, mostly. */
  children?: ComponentChildren
}

/**
 * The notes box. The character counter reads the DRAFT rather than the stored value, so it counts
 * what is on screen; bound to stored state it lagged every keystroke by a debounce.
 */
export function TextArea({
  label,
  value,
  onCommit,
  placeholder,
  ariaLabel,
  maxLength,
  className,
  counterClassName,
  children,
}: TextAreaProps) {
  const field = useTextDraft({ value, onCommit })
  return (
    <label className={className}>
      {label}
      <textarea
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        maxLength={maxLength}
        placeholder={placeholder}
        value={field.draft}
        onInput={field.onInput}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
      />
      <small className={counterClassName}>
        {field.draft.length} / {maxLength}
      </small>
      {children}
    </label>
  )
}
