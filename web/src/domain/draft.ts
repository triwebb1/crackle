/**
 * Form drafts belong to the form.
 *
 * Crackle reconciles full status at explicit boundaries and streams live observations at 1 Hz. Any input whose value is
 * bound to that observed state is unusable: every frame overwrites what is being typed. The rule
 * this module encodes is that an observation may only ever replace `applied`; `draft` is the
 * operator's and nothing arriving from the controller may touch it. Returning the same object when
 * `applied` has not actually changed is what stops a re-render cascade on every frame.
 *
 * The draft is seeded once, and changes afterwards only from an edit or from an explicit
 * "reset to applied" - never from a poll.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Structural equality that ignores named keys at any depth and treats an absent key and an explicit
 * `undefined` as the same thing, so `{ lotId: undefined }` and `{}` compare equal. Key order never
 * matters, which is what makes it safe against `structuredClone` and IndexedDB round trips.
 */
export const stableEquals = (a: unknown, b: unknown, ignoredKeys: readonly string[] = []): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => stableEquals(item, b[index], ignoredKeys))
  }
  if (isRecord(a) && isRecord(b)) {
    const meaningfulKeys = (record: Record<string, unknown>) =>
      Object.keys(record)
        .filter((key) => !ignoredKeys.includes(key) && record[key] !== undefined)
        .sort()
    const left = meaningfulKeys(a)
    const right = meaningfulKeys(b)
    if (left.length !== right.length || left.some((key, index) => key !== right[index])) return false
    return left.every((key) => stableEquals(a[key], b[key], ignoredKeys))
  }
  return false
}

/** What the form holds versus what the controller reports. They are deliberately separate values. */
export interface LiveDraft<T> {
  draft: T
  applied?: T
}

export const startDraft = <T>(draft: T, applied?: T): LiveDraft<T> => ({ draft, applied })

export const editDraft = <T>(state: LiveDraft<T>, draft: T): LiveDraft<T> => ({ ...state, draft })

/**
 * The whole point of the module. A poll replaces `applied` and returns the identical state object
 * when nothing observable moved; `draft` is passed through untouched in every case.
 */
export const observeApplied = <T>(state: LiveDraft<T>, applied: T | undefined): LiveDraft<T> =>
  stableEquals(state.applied, applied) ? state : { draft: state.draft, applied }

/** The one affordance that may overwrite a draft, and only because the operator asked for it. */
export const resetDraftToApplied = <T>(state: LiveDraft<T>): LiveDraft<T> =>
  state.applied === undefined ? state : { ...state, draft: state.applied }

/** True when the form is showing something other than what the controller is actually running. */
export const draftDiffersFromApplied = <T>(state: LiveDraft<T>): boolean =>
  state.applied !== undefined && !stableEquals(state.draft, state.applied)

/*
 * ==============================================================================================
 * THE TEXT DRAFT - the same disease NumberField cured, in the free-text fields
 * ==============================================================================================
 *
 * The failure this prevents: text typed into the roast-history notes reverts within about a second
 * of the user stopping typing, and the same happens in free-text fields throughout the UI.
 *
 * It is one bug with a mechanical cause, and the "about a second" is the tell.
 *
 *   1. The notes textarea was bound straight to repository state - `value={run.notes}` - and
 *      committed on `onChange`, which in Preact IS the native change event and does not fire until
 *      the field is BLURRED. So while typing, the stored value is still the old text.
 *   2. Preact treats `value` as a controlled property and re-asserts it on EVERY render whenever
 *      `dom.value !== props.value`. It is deliberately excluded from the "prop did not change, skip
 *      it" fast path in `diffProps`, so an unchanged `value` prop is still written back to the DOM.
 *   3. `App` re-renders once a second: the 1 Hz fallback timer calls `setNowMs(Date.now())`, which
 *      feeds `liveStatus`, which re-renders every view. Nothing about the notes changed, and that is
 *      the point - step 2 does not care.
 *
 * So: type, stop, and within one second the next tick of the live clock re-asserts the STORED text
 * over the typed text. The identical shape sank the numeric fields before `NumberField`, and the
 * identical two textareas (roast-history notes, open-session notes) and the calibration pass notes
 * were still on `onChange`.
 *
 * The cure is the same one, expressed here as pure transitions so it can be tested without a DOM:
 * the text on screen belongs to the person typing, an observed value may only replace it when the
 * field is NOT being edited, and nothing else may touch it.
 */

/** What the field is showing, what it last agreed with the outside about, and who owns it now. */
export interface TextDraft {
  /** The text on screen. The operator's, whenever they are in the field. */
  draft: string
  /** The last text this field either handed out or accepted in. */
  committed: string
  /** True between focus and blur. While true, nothing arriving from outside may replace `draft`. */
  focused: boolean
  /**
   * True from a keystroke until the committed text is seen coming back.
   *
   * This is the guard `focused` alone cannot provide, and leaving it out reproduces the original bug
   * in a narrower window: with the write debounced, a field that is typed into and then BLURRED is
   * unfocused while the stored value is still the old one, so the next render would adopt the old
   * text as though it were an external change and revert the edit at the last moment. While a commit
   * is outstanding, any value other than the one committed is a stale echo of the state this field
   * has already superseded, and is ignored.
   */
  pending: boolean
}

export const startTextDraft = (value: string): TextDraft => ({
  draft: value,
  committed: value,
  focused: false,
  pending: false,
})

/**
 * A keystroke. The typed text becomes both the draft and the commitment, because the caller is
 * about to be handed it - so the value that comes back (immediately, or after a debounce) is
 * recognised as this field's own echo rather than as an external change.
 */
export const editTextDraft = (state: TextDraft, draft: string): TextDraft => ({
  ...state,
  draft,
  committed: draft,
  pending: true,
})

export const focusTextDraft = (state: TextDraft, focused: boolean): TextDraft =>
  state.focused === focused ? state : { ...state, focused }

/**
 * A value observed from outside - a poll, a debounced save landing, another screen editing the same
 * record. Three cases, and only one of them may move the text:
 *
 *   - it is what this field last said, so the edit has landed: the commit settles and, when there
 *     was nothing outstanding, the SAME object is returned. That identity is what stops a re-render
 *     cascade on the 1 Hz clock tick, which re-delivers an unchanged value every second;
 *   - the field is being edited or has a write outstanding, so the operator keeps what they typed and
 *     the incoming value is discarded rather than recorded. Last writer wins, and the operator at
 *     this keyboard is the last writer;
 *   - the field is idle and settled, so the new value is adopted. This is the only path that writes.
 */
export const observeTextValue = (state: TextDraft, value: string): TextDraft => {
  if (state.committed === value) return state.pending ? { ...state, pending: false } : state
  if (state.focused || state.pending) return state
  return { draft: value, committed: value, focused: state.focused, pending: false }
}

/** True when the field is showing something the caller has not been told about. */
export const textDraftIsDirty = (state: TextDraft): boolean => state.draft !== state.committed || state.pending
