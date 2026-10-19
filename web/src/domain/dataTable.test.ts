import { describe, expect, it } from 'vitest'
import {
  applyTableView,
  clearFilters,
  compactHiddenColumns,
  emptyTableView,
  expandFocus,
  isCompactHidden,
  setFilter,
  type TableColumn,
  toggleSort,
} from './dataTable'

interface Row {
  id: string
  date: string
  name: string
  grams?: number
}

const rows: Row[] = [
  { id: 'a', date: '2026-05-01', name: 'Guji filter', grams: 200 },
  { id: 'b', date: '2026-07-01', name: 'house espresso', grams: 240 },
  { id: 'c', date: '2026-06-01', name: 'Lintong dark' },
  { id: 'd', date: '2026-06-01', name: 'Ånother', grams: 180 },
]

const columns: Array<TableColumn<Row>> = [
  { id: 'date', label: 'Date', value: (row) => row.date, defaultDirection: 'desc' },
  { id: 'name', label: 'Roast', value: (row) => row.name },
  { id: 'grams', label: 'Batch g', value: (row) => row.grams, defaultDirection: 'desc' },
  { id: 'id', label: 'Id', value: (row) => row.id, sortable: false, filterable: false },
]

const ids = (view: Parameters<typeof applyTableView<Row>>[2]) =>
  applyTableView(rows, columns, view).map((row) => row.id)

describe('table sorting', () => {
  it('opens on the default sort a table was given', () => {
    expect(ids(emptyTableView({ columnId: 'date', direction: 'desc' }))).toEqual(['b', 'c', 'd', 'a'])
    expect(ids(emptyTableView())).toEqual(['a', 'b', 'c', 'd'])
  })

  it('sorts a newly clicked column in its own natural direction, not the previous one', () => {
    const view = emptyTableView({ columnId: 'date', direction: 'desc' })
    // Text defaults to A-Z even though the table was pointing Z-A a moment ago.
    expect(toggleSort(view, columns, 'name').sort).toEqual({ columnId: 'name', direction: 'asc' })
    // Numbers and dates default to biggest/newest first.
    expect(toggleSort(view, columns, 'grams').sort).toEqual({ columnId: 'grams', direction: 'desc' })
  })

  it('flips the active column, and never toggles into an unsorted third state', () => {
    let view = emptyTableView({ columnId: 'date', direction: 'desc' })
    view = toggleSort(view, columns, 'date')
    expect(view.sort).toEqual({ columnId: 'date', direction: 'asc' })
    view = toggleSort(view, columns, 'date')
    expect(view.sort).toEqual({ columnId: 'date', direction: 'desc' })
  })

  it('ignores a column that says it is not sortable, or one that does not exist', () => {
    const view = emptyTableView({ columnId: 'date', direction: 'desc' })
    expect(toggleSort(view, columns, 'id')).toBe(view)
    expect(toggleSort(view, columns, 'nope')).toBe(view)
  })

  it('is stable: equal rows keep the order they arrived in, either direction', () => {
    // c and d share a date; c came first in the source and stays first both ways.
    expect(ids(emptyTableView({ columnId: 'date', direction: 'asc' }))).toEqual(['a', 'c', 'd', 'b'])
    expect(ids(emptyTableView({ columnId: 'date', direction: 'desc' }))).toEqual(['b', 'c', 'd', 'a'])
  })

  it('sorts text case- and accent-insensitively, so a stray capital does not sort separately', () => {
    expect(ids(emptyTableView({ columnId: 'name', direction: 'asc' }))).toEqual(['d', 'a', 'b', 'c'])
  })

  /** A blank cell is unknown, not a minimum, and burying it is what keeps the top of a table useful. */
  it('sends a missing value to the bottom in BOTH directions', () => {
    expect(ids(emptyTableView({ columnId: 'grams', direction: 'desc' }))).toEqual(['b', 'a', 'd', 'c'])
    expect(ids(emptyTableView({ columnId: 'grams', direction: 'asc' }))).toEqual(['d', 'a', 'b', 'c'])
  })
})

describe('table filtering', () => {
  it('matches a substring, case- and accent-insensitively', () => {
    expect(ids(setFilter(emptyTableView(), 'name', 'HOUSE'))).toEqual(['b'])
    expect(ids(setFilter(emptyTableView(), 'name', 'another'))).toEqual(['d'])
    expect(ids(setFilter(emptyTableView(), 'date', '2026-06'))).toEqual(['c', 'd'])
  })

  it('ANDs several columns together', () => {
    const view = setFilter(setFilter(emptyTableView(), 'date', '2026-06'), 'name', 'lintong')
    expect(ids(view)).toEqual(['c'])
  })

  it('treats a blank filter as no filter, and clears them all on request', () => {
    expect(setFilter(setFilter(emptyTableView(), 'name', 'x'), 'name', '   ').filters).toEqual({})
    const both = setFilter(setFilter(emptyTableView(), 'name', 'o'), 'date', '2026')
    expect(Object.keys(both.filters)).toHaveLength(2)
    expect(clearFilters(both).filters).toEqual({})
  })

  it('filters and sorts together, filtering first', () => {
    const view = setFilter(emptyTableView({ columnId: 'grams', direction: 'desc' }), 'date', '2026-0')
    expect(ids(view)).toEqual(['b', 'a', 'd', 'c'])
  })

  it('never drops rows for a column it does not know', () => {
    expect(ids(setFilter(emptyTableView(), 'ghost', 'anything'))).toHaveLength(rows.length)
  })
})

/**
 * The phone-width column budget.
 *
 * A history that squeezes nine columns into 390 px has nine unreadable columns. The rule is that a
 * column says whether it is what the row IS or what you look up once you have found it - and that
 * dropping one is only ever allowed when the table has an expanded row to state it in.
 */
describe('column priority at phone width', () => {
  const priced: Array<TableColumn<Row>> = [
    ...columns.slice(0, 2),
    { ...columns[2], priority: 'secondary' },
    { ...columns[3], priority: 'secondary' },
  ]

  it('drops only the columns that declared themselves secondary', () => {
    expect(compactHiddenColumns(priced, true).map((column) => column.id)).toEqual(['grams', 'id'])
    expect(isCompactHidden(priced[0], true)).toBe(false)
    expect(isCompactHidden(priced[2], true)).toBe(true)
  })

  it('drops nothing at all from a table with no expanded row to recover it from', () => {
    expect(compactHiddenColumns(priced, false)).toEqual([])
    expect(isCompactHidden(priced[2], false)).toBe(false)
  })

  it('treats an undeclared column as load-bearing, so a new column is never hidden by default', () => {
    expect(compactHiddenColumns(columns, true)).toEqual([])
  })

  it('changes nothing about what the table CONTAINS - a hidden column still sorts and filters', () => {
    // Batch g is hidden at phone width; ordering by it must still order the whole table.
    expect(
      applyTableView(rows, priced, emptyTableView({ columnId: 'grams', direction: 'desc' })).map((row) => row.id),
    ).toEqual(['b', 'a', 'd', 'c'])
    expect(applyTableView(rows, priced, setFilter(emptyTableView(), 'grams', '240')).map((row) => row.id)).toEqual([
      'b',
    ])
  })
})

/**
 * Arriving at a table because something linked to a row in it.
 *
 * Following a link from the roast history must open that particular roast, not merely show the
 * History page with an "Open from catalog link" banner. Navigating and announcing are one half;
 * opening the row is the other, and this is that half.
 */
describe('opening the row a link pointed at', () => {
  const keys = rows.map((row) => row.id)

  it('expands the linked row, leaving whatever else was open alone', () => {
    expect([...expandFocus(new Set(['a']), 'c', keys)]).toEqual(['a', 'c'])
    expect([...expandFocus(new Set(), 'c', keys)]).toEqual(['c'])
  })

  /**
   * Identity, not equality. The effect that calls this writes state only when the set CHANGES, so
   * returning a fresh equal set would re-render forever - and a row the user deliberately collapsed
   * after arriving would spring straight back open.
   */
  it('returns the very same set when there is nothing to do', () => {
    const open = new Set(['c'])
    expect(expandFocus(open, 'c', keys)).toBe(open)
    expect(expandFocus(open, undefined, keys)).toBe(open)
    // A link to a roast this archive does not hold opens nothing rather than inventing a row.
    expect(expandFocus(open, 'missing', keys)).toBe(open)
  })
})

describe('sorting a column that holds non-finite numbers', () => {
  const values = [3, Number.NaN, 1, 2, Number.NaN, 0, Number.POSITIVE_INFINITY]
  const numeric = values.map((v, index) => ({ id: `n${index}`, v }))
  const columns: TableColumn<{ id: string; v: number }>[] = [{ id: 'v', label: 'v', value: (row) => row.v }]

  it('treats NaN and Infinity as missing: finite values sorted, non-finite last in both directions', () => {
    const asc = applyTableView(numeric, columns, { sort: { columnId: 'v', direction: 'asc' }, filters: {} }).map(
      (row) => row.v,
    )
    expect(asc.slice(0, 4)).toEqual([0, 1, 2, 3])
    expect(asc.slice(4).every((v) => !Number.isFinite(v))).toBe(true)
    const desc = applyTableView(numeric, columns, { sort: { columnId: 'v', direction: 'desc' }, filters: {} }).map(
      (row) => row.v,
    )
    expect(desc.slice(0, 4)).toEqual([3, 2, 1, 0])
    expect(desc.slice(4).every((v) => !Number.isFinite(v))).toBe(true)
  })
})
