/**
 * The phone strip scrolls sideways, and the selected record can start off-screen to the right of
 * the New buttons - so the first view of Profiles on a phone showed no highlighted row at all.
 * Whenever the selection changes, the strip is scrolled to it. Only the strip: the desktop sidebar
 * never scrolls sideways, and `scrollWidth` says which one this is, so there is no media query in
 * JavaScript and no second idea of where the breakpoint is.
 */
export const scrollStripToSelected = (list: HTMLElement | null, attribute: string, id: string) => {
  if (!list || list.scrollWidth <= list.clientWidth) return
  for (const row of list.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (row.getAttribute(attribute) !== id) continue
    row.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    return
  }
}

/** True when two id orders differ, so a drop that lands where it started writes nothing. */
export const orderChanged = (before: readonly string[], after: readonly string[]) =>
  before.length !== after.length || before.some((id, index) => id !== after[index])

/**
 * The keyboard half of drag-to-reorder. A grip is a focusable button, so it must do something from
 * the keyboard: ArrowUp/ArrowLeft move the item one place earlier and ArrowDown/ArrowRight one place
 * later (Left/Right because the same list is a horizontal strip on a phone). Returns the new order,
 * or undefined when the key is not a move or the item is already at that end.
 */
export const keyboardReorder = (ids: readonly string[], id: string, key: string): string[] | undefined => {
  const step = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : key === 'ArrowDown' || key === 'ArrowRight' ? 1 : 0
  if (step === 0) return undefined
  const from = ids.indexOf(id)
  const to = from + step
  if (from < 0 || to < 0 || to >= ids.length) return undefined
  const next = [...ids]
  next[from] = next[to]
  next[to] = id
  return next
}

/** Keeps focus on the grip that was just moved once the reordered list has re-rendered. */
export const focusGrip = (list: HTMLElement | null, attribute: string, id: string, gripSelector: string) => {
  if (!list) return
  for (const row of list.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (row.getAttribute(attribute) !== id) continue
    row.querySelector<HTMLElement>(gripSelector)?.focus()
    return
  }
}
