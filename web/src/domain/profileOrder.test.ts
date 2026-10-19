import { describe, expect, it } from 'vitest'
import { dropIndexAt, moveInOrder, orderProfiles } from './profileOrder'

const items = (ids: string[]) => ids.map((id) => ({ id }))
const idsOf = (list: Array<{ id: string }>) => list.map((item) => item.id)

/** A saved order is a preference. It must never be able to make a profile disappear. */
describe('applying a saved profile order', () => {
  it('puts known ids in their stored order', () => {
    expect(idsOf(orderProfiles(items(['a', 'b', 'c']), ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
  })

  it('appends anything the order has never heard of, in arrival order', () => {
    expect(idsOf(orderProfiles(items(['a', 'b', 'c', 'd']), ['c', 'a']))).toEqual(['c', 'a', 'b', 'd'])
  })

  it('skips an id that no longer resolves rather than leaving a hole', () => {
    expect(idsOf(orderProfiles(items(['a', 'b']), ['deleted', 'b', 'gone', 'a']))).toEqual(['b', 'a'])
  })

  it('is a no-op for an empty or unknown order', () => {
    expect(idsOf(orderProfiles(items(['a', 'b']), []))).toEqual(['a', 'b'])
    expect(idsOf(orderProfiles(items(['a', 'b']), ['x', 'y']))).toEqual(['a', 'b'])
    expect(orderProfiles([], ['a'])).toEqual([])
  })
})

describe('moving a row to a drop index', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves down to the gap the pointer was released over', () => {
    expect(moveInOrder(ids, 'a', 2)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveInOrder(ids, 'a', 4)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('moves up to the same gap indexes, counted the same way', () => {
    expect(moveInOrder(ids, 'd', 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveInOrder(ids, 'c', 1)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('treats a drop onto its own position as no change', () => {
    expect(moveInOrder(ids, 'b', 1)).toEqual(ids)
    expect(moveInOrder(ids, 'b', 2)).toEqual(ids)
  })

  it('clamps an out-of-range drop and ignores an unknown id', () => {
    expect(moveInOrder(ids, 'a', 99)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveInOrder(ids, 'a', -5)).toEqual(ids)
    expect(moveInOrder(ids, 'missing', 0)).toEqual(ids)
  })

  it('never loses or duplicates a row', () => {
    for (let target = 0; target <= ids.length; target += 1) {
      const moved = moveInOrder(ids, 'c', target)
      expect([...moved].sort()).toEqual([...ids].sort())
    }
  })
})

/**
 * The same nav is a column on a desktop and a horizontally scrolling strip at 820 px, so the drop
 * index cannot be read off the pointer's Y in both. In a strip every row shares a top, so Y gives
 * the same answer for the whole list and the reorder gesture would do nothing on the screen it is
 * most useful on.
 */
describe('where a dragged row lands', () => {
  const column = [0, 1, 2, 3].map((index) => ({ left: 20, top: 100 + index * 80, width: 200, height: 80 }))
  const strip = [0, 1, 2, 3].map((index) => ({ left: 20 + index * 200, top: 100, width: 200, height: 80 }))

  it('reads a column on Y', () => {
    expect(dropIndexAt(column, { x: 60, y: 110 })).toBe(0)
    expect(dropIndexAt(column, { x: 60, y: 150 })).toBe(1)
    expect(dropIndexAt(column, { x: 60, y: 330 })).toBe(3)
    expect(dropIndexAt(column, { x: 60, y: 999 })).toBe(4)
    // Sideways movement says nothing about a column.
    expect(dropIndexAt(column, { x: 900, y: 150 })).toBe(1)
  })

  it('reads a strip on X, which is the case that did not work at all', () => {
    expect(dropIndexAt(strip, { x: 60, y: 140 })).toBe(0)
    expect(dropIndexAt(strip, { x: 200, y: 140 })).toBe(1)
    expect(dropIndexAt(strip, { x: 650, y: 140 })).toBe(3)
    expect(dropIndexAt(strip, { x: 9999, y: 140 })).toBe(4)
    // Vertical movement says nothing about a strip.
    expect(dropIndexAt(strip, { x: 200, y: 900 })).toBe(1)
  })

  it('answers a list with nothing in it, and one with a single row', () => {
    expect(dropIndexAt([], { x: 0, y: 0 })).toBe(0)
    expect(dropIndexAt([column[0]], { x: 60, y: 110 })).toBe(0)
    expect(dropIndexAt([column[0]], { x: 60, y: 170 })).toBe(1)
  })

  it('produces a gap index the reorder can always use', () => {
    for (const rows of [column, strip]) {
      for (const at of [-500, 0, 140, 300, 620, 5000]) {
        const index = dropIndexAt(rows, { x: at, y: at })
        expect(index).toBeGreaterThanOrEqual(0)
        expect(index).toBeLessThanOrEqual(rows.length)
      }
    }
  })
})
