/**
 * The order profiles appear in the editor's left nav.
 *
 * This is a workspace preference, not roast data: it says nothing about what a profile is or how it
 * runs, it only records how the user likes the list arranged. So it lives in `localStorage` beside
 * the calibration record rather than in IndexedDB with the library, and it is stored as bare ids -
 * an id that no longer resolves is simply skipped, and a profile the order has never heard of is
 * appended rather than hidden.
 *
 * Both of those rules matter: a saved order must never be able to make a profile disappear.
 */
export const PROFILE_ORDER_KEY = 'crackle:profile-order:v1'

export const readProfileOrder = (): string[] => {
  try {
    const stored = globalThis.localStorage?.getItem(PROFILE_ORDER_KEY)
    if (!stored) return []
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export const writeProfileOrder = (ids: string[]) => {
  try {
    globalThis.localStorage?.setItem(PROFILE_ORDER_KEY, JSON.stringify(ids))
  } catch {
    /* a preference is never worth failing a save for */
  }
}

/** Known ids in their stored order, then everything the order has not heard of, in arrival order. */
export const orderProfiles = <T extends { id: string }>(items: T[], order: string[]): T[] => {
  const byId = new Map(items.map((item) => [item.id, item]))
  const known = order.flatMap((id) => {
    const item = byId.get(id)
    if (!item) return []
    byId.delete(id)
    return [item]
  })
  return [...known, ...items.filter((item) => byId.has(item.id))]
}

/** The part of a row's box a drop is decided from. A DOMRect satisfies it; so does a test. */
export interface RowBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where a drop lands, decided from the axis the list is actually laid out on.
 *
 * The nav is a column on a desktop and a horizontally scrolling strip on a phone - the stylesheet
 * turns it into one at 820 px - and the drop index was computed from the pointer's Y against each
 * row's midline in both. In the strip every row shares a top and a height, so Y answered the same
 * thing for the whole list and dragging a profile sideways past three others moved nothing: the
 * reorder gesture simply did not work on the screen it was built to be usable on.
 *
 * So the axis is read off the geometry rather than assumed. Rows whose lefts vary more than their
 * tops are a row, and a row is compared on X. Nothing here knows about a breakpoint, which is what
 * keeps it correct if the strip ever wraps or the nav is laid out some third way.
 */
export const dropIndexAt = (rows: readonly RowBox[], point: { x: number; y: number }): number => {
  if (rows.length === 0) return 0
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values)
  const horizontal = spread(rows.map((row) => row.left)) > spread(rows.map((row) => row.top))
  let index = 0
  for (const [position, row] of rows.entries()) {
    const middle = horizontal ? row.left + row.width / 2 : row.top + row.height / 2
    if ((horizontal ? point.x : point.y) > middle) index = position + 1
  }
  return index
}

/**
 * Move `id` so it lands at `toIndex` of the list as the reader sees it. `toIndex` is a gap index -
 * 0 is before the first row, `length` is after the last - which is what a drop target actually is.
 */
export const moveInOrder = (ids: string[], id: string, toIndex: number): string[] => {
  const from = ids.indexOf(id)
  if (from < 0) return ids
  const without = ids.filter((candidate) => candidate !== id)
  const target = Math.max(0, Math.min(without.length, toIndex > from ? toIndex - 1 : toIndex))
  return [...without.slice(0, target), id, ...without.slice(target)]
}
