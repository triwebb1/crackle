import { describe, expect, it } from 'vitest'
import {
  draftDiffersFromApplied,
  editDraft,
  editTextDraft,
  focusTextDraft,
  observeApplied,
  observeTextValue,
  resetDraftToApplied,
  stableEquals,
  startDraft,
  startTextDraft,
  textDraftIsDirty,
} from './draft'

describe('structural equality', () => {
  it('ignores key order, absent-versus-undefined, and the keys it is told to ignore', () => {
    expect(stableEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(stableEquals({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(stableEquals({ a: 1 }, { a: 2 })).toBe(false)
    expect(stableEquals({ a: 1, updatedAt: 'x' }, { a: 1, updatedAt: 'y' }, ['updatedAt'])).toBe(true)
    expect(stableEquals({ a: 1, updatedAt: 'x' }, { a: 2, updatedAt: 'x' }, ['updatedAt'])).toBe(false)
  })

  it('compares arrays by position and nests through both', () => {
    expect(stableEquals([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(stableEquals([1, 2], [2, 1])).toBe(false)
    expect(stableEquals({ points: [{ fan: 4, at: 'a' }] }, { points: [{ fan: 4, at: 'b' }] }, ['at'])).toBe(true)
    expect(stableEquals({ points: [{ fan: 4 }] }, { points: [{ fan: 4 }, { fan: 5 }] })).toBe(false)
  })

  it('never claims two different primitive kinds are equal', () => {
    expect(stableEquals(1, '1')).toBe(false)
    expect(stableEquals(null, undefined)).toBe(false)
    expect(stableEquals([], {})).toBe(false)
  })
})

/**
 * The live-poll field failure, reproduced.
 *
 * The operator sets fan 4 and applies it, then types 8. If the input's value were the applied level
 * rather than the operator's draft, the next live frame would snap the field back to 4. A stepper
 * click would show 4.1 for an instant and revert for the same reason. The invariant that makes it impossible is here: an observation writes `applied` and
 * nothing else, whatever the draft happens to be at the time.
 */
describe('a form draft against a live poll', () => {
  it('keeps the draft through every observation, including ones that change the applied value', () => {
    let state = startDraft({ fan: 4, heat: 0 }, { fan: 4, heat: 0 })
    state = editDraft(state, { fan: 8, heat: 0 })

    // Streamed frames at 1 Hz, then a status poll that reports different levels.
    state = observeApplied(state, { fan: 4, heat: 0 })
    state = observeApplied(state, { fan: 4.1, heat: 0 })
    state = observeApplied(state, { fan: 4.1, heat: 0 })

    expect(state.draft).toEqual({ fan: 8, heat: 0 })
    expect(state.applied).toEqual({ fan: 4.1, heat: 0 })
    expect(draftDiffersFromApplied(state)).toBe(true)
  })

  it('returns the identical state object when nothing observable moved', () => {
    const state = startDraft({ fan: 8, heat: 2 }, { fan: 4, heat: 0 })
    expect(observeApplied(state, { fan: 4, heat: 0 })).toBe(state)
    expect(observeApplied(state, { fan: 5, heat: 0 })).not.toBe(state)
  })

  it('reports no difference while the draft still matches what is running', () => {
    const state = startDraft({ fan: 4, heat: 0 }, { fan: 4, heat: 0 })
    expect(draftDiffersFromApplied(state)).toBe(false)
    // With nothing applied there is nothing to differ from: an idle controller is not a conflict.
    expect(draftDiffersFromApplied(startDraft({ fan: 8, heat: 3 }))).toBe(false)
  })

  it('overwrites the draft only when the operator explicitly asks to match applied', () => {
    const edited = editDraft(startDraft({ fan: 4, heat: 0 }, { fan: 4, heat: 0 }), { fan: 8, heat: 0 })
    expect(resetDraftToApplied(edited).draft).toEqual({ fan: 4, heat: 0 })
    // Nothing applied, nothing to reset to: the draft survives rather than being blanked.
    const orphan = startDraft({ fan: 8, heat: 0 })
    expect(resetDraftToApplied(orphan)).toBe(orphan)
  })
})

/**
 * Notes that revert while being typed, pinned as behaviour rather than as markup.
 *
 * The failure: type into the roast-history notes, stop, and about a second
 * later the typed text is replaced by the stored text. The mechanism is written out above
 * `TextDraft` in `draft.ts` - a controlled `value` that Preact re-asserts on every render, a field
 * that only committed on blur, and a 1 Hz live clock that re-renders everything. These are the
 * rules that make that sequence impossible, and every one of them is a real step of it.
 */
describe('a text field belongs to the person typing', () => {
  it('keeps the typed text when the stored value re-arrives unchanged, and re-renders nothing', () => {
    // The 1 Hz tick that re-delivers the stored value: the record has not changed, the field has.
    const typed = editTextDraft(startTextDraft('old notes'), 'old notes and a new observation')
    const ticked = observeTextValue(typed, 'old notes')
    expect(ticked.draft).toBe('old notes and a new observation')
    // The debounced save lands. It is this field's own echo: the commit settles, the text does not
    // move, and from here an identical value re-arriving returns the SAME object - which is what
    // stops the re-render cascade on the 1 Hz clock.
    const echoed = observeTextValue(ticked, 'old notes and a new observation')
    expect(echoed.draft).toBe('old notes and a new observation')
    expect(echoed.pending).toBe(false)
    expect(observeTextValue(echoed, 'old notes and a new observation')).toBe(echoed)
  })

  it('does not clobber a dirty draft when a genuinely different value arrives mid-edit', () => {
    const editing = focusTextDraft(startTextDraft('stored'), true)
    const typing = editTextDraft(editing, 'half a sen')
    // Something else wrote to the same record while the operator is in the field.
    const intruded = observeTextValue(typing, 'written from somewhere else')
    expect(intruded.draft).toBe('half a sen')
    // And it cannot creep in on the way out either: the write is still outstanding.
    const blurred = observeTextValue(focusTextDraft(intruded, false), 'written from somewhere else')
    expect(blurred.draft).toBe('half a sen')
  })

  it('adopts an external value when the field is idle, which is the only path that may write', () => {
    const idle = startTextDraft('stored')
    const adopted = observeTextValue(idle, 'loaded from another roast')
    expect(adopted.draft).toBe('loaded from another roast')
    expect(textDraftIsDirty(adopted)).toBe(false)
  })

  it('reports dirt only while the draft says something it has not handed out', () => {
    const clean = startTextDraft('a')
    expect(textDraftIsDirty(clean)).toBe(false)
    // A keystroke is dirty until the caller's write is observed coming back.
    const typed = editTextDraft(clean, 'ab')
    expect(textDraftIsDirty(typed)).toBe(true)
    expect(textDraftIsDirty(observeTextValue(typed, 'ab'))).toBe(false)
  })

  it('leaves focus tracking free of its own re-renders', () => {
    const focused = focusTextDraft(startTextDraft('a'), true)
    expect(focusTextDraft(focused, true)).toBe(focused)
    expect(focusTextDraft(focused, false).focused).toBe(false)
  })
})
