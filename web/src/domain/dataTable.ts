/**
 * Sorting and filtering for every history table in the app - roast history, a profile's roasts, a
 * bean lot's roasts. One pure module so the three tables cannot drift into three different ideas of
 * what clicking a header does.
 *
 * The rules, all deliberate:
 *
 * - A table opens on its own default sort (newest first, everywhere it has a date).
 * - Clicking a new column sorts by that column in ITS natural default direction - descending for
 *   dates and numbers, ascending for text - rather than inheriting the previous column's direction,
 *   because "sort by name" almost never means Z to A.
 * - Clicking the active column flips it. There is no third state that clears the sort: an unsorted
 *   table is not a thing a reader ever asks for.
 * - Filters are per-column substring matches, case- and accent-insensitive, ANDed together.
 * - A missing value sorts last in BOTH directions. A blank cell is not "smallest", it is unknown,
 *   and burying it is what keeps the top of the table useful.
 */

export type SortDirection = 'asc' | 'desc'

export interface TableSort {
  columnId: string
  direction: SortDirection
}

export type TableCellValue = string | number | undefined

/**
 * How load-bearing a column is when the screen cannot hold all of them.
 *
 * A nine-column archive at 390 px has two honest options and one dishonest one. The dishonest one
 * is squeezing every column until all nine are unreadable. The honest ones are a sideways scroll -
 * fine for a matrix, poor for a list you are scanning - or dropping the columns that are not what
 * identifies a row and stating them in full where the row expands. This is the second: `primary`
 * is what the row IS, `secondary` is what you look up once you have found it.
 */
export type ColumnPriority = 'primary' | 'secondary'

export interface TableColumn<T> {
  id: string
  label: string
  /** The comparable value. Strings compare case-insensitively; numbers numerically. */
  value: (row: T) => TableCellValue
  /** What a filter matches against, when it differs from the sortable value. */
  search?: (row: T) => string
  sortable?: boolean
  filterable?: boolean
  /** Ascending for text, descending for dates and numbers, unless overridden. */
  defaultDirection?: SortDirection
  /** Defaults to primary: a column is kept at every width unless it says otherwise. */
  priority?: ColumnPriority
}

/**
 * The columns that leave the row at phone width - and none at all when the table has no expanded
 * row to state them in.
 *
 * That condition is the whole point of the helper rather than a detail of it. Hiding a column
 * behind a detail row is a layout decision; hiding one with nowhere to recover it from is data
 * loss, and it is exactly the mistake a per-table `className` would let a caller make quietly.
 */
export const compactHiddenColumns = <T>(columns: Array<TableColumn<T>>, hasDetail: boolean): Array<TableColumn<T>> =>
  hasDetail ? columns.filter((column) => column.priority === 'secondary') : []

/** Whether this column is one of those, for the class that hides it. */
export const isCompactHidden = <T>(column: TableColumn<T>, hasDetail: boolean) =>
  compactHiddenColumns([column], hasDetail).length === 1

/**
 * Opening a table AT a row, because something elsewhere linked to it.
 *
 * A link to a roast must open that roast, not just the History page: with a hundred roasts in the
 * list, the table should jump to the linked row and expand it. Navigation carries the id and the
 * banner announces it; this opens the row.
 *
 * Kept pure, and kept IDEMPOTENT in the strictest sense: when the row is already open - or when
 * there is no such row - the SAME set comes back, not an equal one. The effect that calls this
 * compares by identity to decide whether to write state, so returning a fresh equal set would
 * re-render forever, and a row the user deliberately collapsed would spring open again.
 */
export const expandFocus = (
  expanded: ReadonlySet<string>,
  focusKey: string | undefined,
  keys: readonly string[],
): ReadonlySet<string> => {
  if (focusKey === undefined || expanded.has(focusKey) || !keys.includes(focusKey)) return expanded
  return new Set([...expanded, focusKey])
}

export interface TableView {
  sort?: TableSort
  filters: Record<string, string>
}

export const emptyTableView = (sort?: TableSort): TableView => ({ sort, filters: {} })

const naturalDirection = <T>(column: TableColumn<T> | undefined): SortDirection => column?.defaultDirection ?? 'asc'

export const toggleSort = <T>(view: TableView, columns: TableColumn<T>[], columnId: string): TableView => {
  const column = columns.find((candidate) => candidate.id === columnId)
  if (!column || column.sortable === false) return view
  if (view.sort?.columnId === columnId) {
    return { ...view, sort: { columnId, direction: view.sort.direction === 'asc' ? 'desc' : 'asc' } }
  }
  return { ...view, sort: { columnId, direction: naturalDirection(column) } }
}

export const setFilter = (view: TableView, columnId: string, value: string): TableView => {
  const filters = { ...view.filters }
  if (value.trim() === '') delete filters[columnId]
  else filters[columnId] = value
  return { ...view, filters }
}

export const clearFilters = (view: TableView): TableView => ({ ...view, filters: {} })

export const activeFilterCount = (view: TableView) => Object.keys(view.filters).length

const normalize = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()

const searchText = <T>(column: TableColumn<T>, row: T): string => {
  if (column.search) return column.search(row)
  const value = column.value(row)
  return value === undefined ? '' : String(value)
}

/**
 * A non-finite number (NaN, ±Infinity from a failed derivation) is treated as MISSING. NaN makes
 * `a - b` NaN, which breaks the comparator's consistency and can stop a whole column sorting.
 */
const sortKey = (value: TableCellValue): TableCellValue =>
  typeof value === 'number' && !Number.isFinite(value) ? undefined : value

const compare = (a: TableCellValue, b: TableCellValue): number => {
  // Unknown sorts last whichever way the column is pointing, so it is never mistaken for a minimum.
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export const applyTableView = <T>(rows: T[], columns: TableColumn<T>[], view: TableView): T[] => {
  const filtered = rows.filter((row) =>
    Object.entries(view.filters).every(([columnId, query]) => {
      const column = columns.find((candidate) => candidate.id === columnId)
      if (!column) return true
      return normalize(searchText(column, row)).includes(normalize(query))
    }),
  )
  const column = view.sort ? columns.find((candidate) => candidate.id === view.sort!.columnId) : undefined
  if (!column) return filtered
  const direction = view.sort!.direction === 'desc' ? -1 : 1
  // Decorate-sort-undecorate keeps it stable: equal rows retain their incoming order, so a sorted
  // table never reshuffles rows the sort has nothing to say about.
  return filtered
    .map((row, index) => ({ row, index, key: sortKey(column.value(row)) }))
    .sort((a, b) => {
      const ordered = compare(a.key, b.key)
      // The unknown-last rule is absolute, so it must not be flipped by the direction.
      if (a.key === undefined || b.key === undefined) return ordered
      return ordered === 0 ? a.index - b.index : ordered * direction
    })
    .map((entry) => entry.row)
}
