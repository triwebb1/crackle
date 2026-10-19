import { ArrowDown, ArrowUp, ChevronsUpDown, Filter, X } from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  applyTableView,
  clearFilters,
  compactHiddenColumns,
  emptyTableView,
  expandFocus,
  isCompactHidden,
  setFilter,
  type TableColumn,
  type TableSort,
  type TableView,
  toggleSort,
} from '../domain/dataTable'

/**
 * One sortable, filterable table for every history on the site: the roast archive, a profile's
 * roasts, a bean lot's roasts. The behavior lives in `dataTable.ts` as pure functions; this is the
 * chrome around it, so three tables cannot end up with three ideas of what a header click does.
 *
 * The filter row is opt-in per table and hidden until asked for - a filter box under every heading
 * is noise on a table with nine rows in it - but the state it drives is always there, so a table
 * that grows into needing filters does not need rebuilding.
 */

export interface DataTableProps<T> {
  /**
   * `width` pins the column. It is a LAYOUT declaration, not a hint: a table where any column
   * declares one switches to `table-layout: fixed`, so no cell's contents can influence any
   * column's width ever again. See the note on `pinned` below for the defect that forced it.
   */
  columns: Array<TableColumn<T> & { render?: (row: T) => ComponentChildren; className?: string; width?: string }>
  rows: T[]
  rowKey: (row: T) => string
  defaultSort?: TableSort
  /** Rendered under the row when it is expanded. Omit entirely for a table with no detail. */
  detail?: (row: T) => ComponentChildren
  /** Extra classes on the `<table>`. */
  className?: string
  emptyMessage: string
  caption?: string
  /** Optional table-scoped control rendered beside Filter. */
  toolbar?: ComponentChildren
  /**
   * A row to open and scroll to on arrival, because something elsewhere linked to it. Expanding is
   * the point: landing on a hundred-row archive with the target merely PRESENT does not help anyone
   * find it.
   */
  focusKey?: string
}

const cellText = <T,>(column: TableColumn<T>, row: T) => {
  const value = column.value(row)
  return value === undefined ? '--' : String(value)
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  defaultSort,
  detail,
  className,
  emptyMessage,
  caption,
  toolbar,
  focusKey,
}: DataTableProps<T>) {
  const [view, setView] = useState<TableView>(() => emptyTableView(defaultSort))
  const [filtersOpen, setFiltersOpen] = useState(false)
  /**
   * Expansion is per row, not a single cursor. A radio-button table can only ever answer "tell me
   * about this one"; comparing two roasts - which is the reason the detail exists - meant opening
   * one, reading it, opening the other and losing the first. A Set costs nothing and the rows stop
   * fighting each other.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggleRow = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  /**
   * Clicking anywhere in a row expands or collapses it; the plus/minus icon is not the only target.
   *
   * So the whole row is the target. Two things keep that from breaking the row's own contents:
   *
   *   - **Genuinely interactive descendants opt out**, found by what they ARE rather than by each
   *     one remembering to stop propagation. A row's cells are rendered by the caller, so a rule the
   *     caller has to know about is a rule that will be forgotten the next time a column gains a
   *     link. `closest` covers a button's inner icon and label too, which a target check would not.
   *   - **A drag that selected text is not a click.** Selecting a roast name to copy it ends with a
   *     mouseup inside the row, and collapsing the row under the selection would be maddening.
   *
   * Keyboard reach stays where it was: the expand button keeps its label and its `aria-expanded`,
   * and is the control assistive technology and the Tab key are offered. Making every row focusable
   * would put a hundred stops in the tab order to duplicate a control that is already there.
   */
  const toggleFromRow = (key: string, event: { target: EventTarget | null }) => {
    const target = event.target
    if (
      target instanceof Element &&
      target.closest('button, a, input, select, textarea, label, summary, [role="button"], [contenteditable="true"]')
    )
      return
    if (typeof window !== 'undefined' && (window.getSelection()?.toString() ?? '') !== '') return
    toggleRow(key)
  }
  /**
   * Arriving at a linked row: open it, then put it in front of the eye.
   *
   * The expansion is pure and tested (`expandFocus`); only the scroll is a DOM effect, and it is
   * guarded because a server render has no elements at all. Both run once per focus key rather than
   * on every render, so a row the user collapses afterwards stays collapsed.
   */
  const rowElements = useRef(new Map<string, HTMLTableRowElement>())
  useEffect(() => {
    setExpanded((current) => expandFocus(current, focusKey, rows.map(rowKey)))
    const element = focusKey === undefined ? undefined : rowElements.current.get(focusKey)
    element?.scrollIntoView?.({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the focus key is the whole trigger
  }, [focusKey])

  const visible = useMemo(() => applyTableView(rows, columns, view), [columns, rows, view])
  const filterable = columns.filter((column) => column.filterable !== false)
  const filterCount = Object.keys(view.filters).length
  /**
   * The columns the phone rule takes out of the row. They are still rendered - into the expanded
   * detail, above whatever the caller put there - because the CSS is what hides them, and one
   * rendering that CSS decides where to show is a great deal safer than two renderings that a
   * media query in JavaScript decides between. See `compactHiddenColumns`.
   */
  const hiddenIds = new Set(compactHiddenColumns(columns, Boolean(detail)).map((column) => column.id))
  const compactHidden = columns.filter((column) => hiddenIds.has(column.id))
  const pinned = columns.some((column) => column.width !== undefined)
  const columnClass = (column: (typeof columns)[number], extra?: string) =>
    [extra, column.className, isCompactHidden(column, Boolean(detail)) ? 'compact-hidden' : '']
      .filter(Boolean)
      .join(' ') || undefined

  const sortIcon = (columnId: string) => {
    if (view.sort?.columnId !== columnId) return <ChevronsUpDown size={13} className="sort-idle" />
    return view.sort.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />
  }

  return (
    <div className="data-table">
      <div className="data-table-toolbar">
        <span className="data-table-count">
          {visible.length === rows.length
            ? `${rows.length} row${rows.length === 1 ? '' : 's'}`
            : `${visible.length} of ${rows.length} rows`}
        </span>
        {filterable.length > 0 && (
          <button
            type="button"
            className={filterCount > 0 ? 'secondary-button active' : 'secondary-button'}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <Filter size={16} />
            {filterCount > 0 ? `Filters (${filterCount})` : 'Filter'}
          </button>
        )}
        {/*
        At phone width the secondary columns leave the row and take their headings with them, so a
        header click can no longer sort by batch weight or score. This menu offers every sortable
        column whatever is on screen; CSS shows it only where headings are missing.
      */}
        {hiddenIds.size > 0 && (
          <label className="data-table-sort">
            <span className="sr-only">Sort by</span>
            <select
              aria-label="Sort by"
              value={view.sort ? `${view.sort.columnId}:${view.sort.direction}` : ''}
              onInput={(event) => {
                const [columnId, direction] = event.currentTarget.value.split(':')
                if (columnId && (direction === 'asc' || direction === 'desc'))
                  setView({ ...view, sort: { columnId, direction } })
              }}
            >
              {!view.sort && <option value="">Sort by…</option>}
              {columns
                .filter((column) => column.sortable !== false)
                .flatMap((column) => {
                  const numeric = column.className?.includes('numeric') || column.id === 'started'
                  const high = column.id === 'started' ? 'newest first' : numeric ? 'highest first' : 'Z to A'
                  const low = column.id === 'started' ? 'oldest first' : numeric ? 'lowest first' : 'A to Z'
                  const first = column.defaultDirection === 'desc' || numeric ? 'desc' : 'asc'
                  const options = [
                    { direction: 'desc', text: `${column.label}, ${high}` },
                    { direction: 'asc', text: `${column.label}, ${low}` },
                  ]
                  if (first === 'asc') options.reverse()
                  return options.map((option) => (
                    <option key={`${column.id}:${option.direction}`} value={`${column.id}:${option.direction}`}>
                      {option.text}
                    </option>
                  ))
                })}
            </select>
          </label>
        )}
        {toolbar}
        {filterCount > 0 && (
          <button
            type="button"
            className="icon-button"
            aria-label="Clear all filters"
            title="Clear all filters"
            onClick={() => setView(clearFilters(view))}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {/*
      EXPANDING A ROW MUST NOT RESIZE THE COLUMNS. Without this, expanding a roast changes the
      finish temp column's width and the header wraps onto an extra line.

      The detail row is a single cell spanning every column, and under the automatic table layout a
      spanning cell's minimum content width is DISTRIBUTED BACK over the columns it spans. So opening
      a row fed the width of a notes box, four measurement fields and a button strip into the column
      algorithm, every column was re-apportioned, and the narrowest heading rewrapped. The row's own
      contents were never the cause and no amount of nowrap on them could have fixed it.

      A table whose columns declare widths therefore switches to `table-layout: fixed`, where column
      widths come from the first row and NOTHING in the body can influence them - including a
      spanning detail cell. The header is then a constant, whatever is open.
    */}
      <div className="calibration-table-wrap">
        <table
          className={['diff-table', 'sortable-table', pinned ? 'pinned-columns' : '', className]
            .filter(Boolean)
            .join(' ')}
        >
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {detail && (
                <th className="row-expand-head">
                  <span className="sr-only">Expand</span>
                </th>
              )}
              {columns.map((column) => {
                const sortable = column.sortable !== false
                const active = view.sort?.columnId === column.id
                // The header carries the column's own class as well as the cells, so a
                // measured column is right-aligned from its heading down - and a column that
                // leaves the row at phone width takes its heading with it.
                return (
                  <th
                    key={column.id}
                    className={columnClass(column, active ? 'sorted' : undefined)}
                    style={column.width ? { width: column.width } : undefined}
                    aria-sort={active ? (view.sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="column-sort"
                        onClick={() => setView(toggleSort(view, columns, column.id))}
                      >
                        {column.label}
                        {sortIcon(column.id)}
                      </button>
                    ) : (
                      <span>{column.label}</span>
                    )}
                  </th>
                )
              })}
            </tr>
            {filtersOpen && (
              <tr className="filter-row">
                {detail && <td />}
                {columns.map((column) => (
                  <td key={column.id} className={columnClass(column)}>
                    {column.filterable !== false && (
                      <input
                        type="search"
                        aria-label={`Filter by ${column.label}`}
                        placeholder="Filter"
                        value={view.filters[column.id] ?? ''}
                        onInput={(event) => setView(setFilter(view, column.id, event.currentTarget.value))}
                      />
                    )}
                  </td>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length + (detail ? 1 : 0)}>
                  <div className="empty-state">{rows.length === 0 ? emptyMessage : 'No rows match these filters.'}</div>
                </td>
              </tr>
            )}
            {visible.flatMap((row) => {
              const key = rowKey(row)
              const open = expanded.has(key)
              return [
                <tr
                  key={key}
                  ref={(element) => {
                    if (element) rowElements.current.set(key, element)
                    else rowElements.current.delete(key)
                  }}
                  className={`${detail ? 'table-row expandable' : 'table-row'}${open ? ' open' : ''}`}
                  onClick={detail ? (event) => toggleFromRow(key, event) : undefined}
                >
                  {detail && (
                    <td className="row-expand">
                      <button
                        type="button"
                        className="icon-button ghost"
                        aria-expanded={open}
                        aria-label={open ? 'Collapse row' : 'Expand row'}
                        onClick={() => toggleRow(key)}
                      >
                        {open ? '-' : '+'}
                      </button>
                    </td>
                  )}
                  {columns.map((column) => (
                    <td key={column.id} className={columnClass(column)}>
                      {column.render ? column.render(row) : cellText(column, row)}
                    </td>
                  ))}
                </tr>,
                open && detail ? (
                  <tr key={`${key}-detail`} className="table-detail-row">
                    <td colSpan={columns.length + 1}>
                      {compactHidden.length > 0 && (
                        <dl className="compact-fields">
                          {compactHidden.map((column) => (
                            <div key={column.id}>
                              <dt>{column.label}</dt>
                              <dd>{column.render ? column.render(row) : cellText(column, row)}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {detail(row)}
                    </td>
                  </tr>
                ) : null,
              ].filter(Boolean)
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
