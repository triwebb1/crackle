import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { demoRuns, starterBean, starterProfile } from '../data/demo'
import { DEMO_SOURCE_DEVICE_ID } from '../data/demoIdentity'
import { BeansView } from './BeansView'
import { HistoryView } from './HistoryView'
import { LiveChart } from './LiveChart'

const noop = () => undefined
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

/**
 * The presentation contracts of the design system, pinned so they cannot
 * silently regress the way SVG attribute casing once did.
 *
 * None of these assert a pixel value. They assert the RULES the stylesheet is built
 * on - one channel palette, one pill geometry, a declared measurement face, visible
 * focus - because those are the things that decay first when a later change adds a
 * one-off colour or a tenth variant of a badge.
 */

describe('measured columns are declared as measured', () => {
  const history = renderToStaticMarkup(
    createElement(HistoryView, {
      runs: demoRuns,
      onOverlay: noop,
      onDelete: noop,
      onSaveDetails: async () => undefined,
      onImport: async () => '',
      onUseAsProfile: noop,
      activeRoasterId: DEMO_SOURCE_DEVICE_ID,
    }),
  )
  const beans = renderToStaticMarkup(
    createElement(BeansView, {
      beans: [starterBean],
      runs: demoRuns,
      revisions: [],
      onSelect: noop,
      onSave: noop,
      onDelete: noop,
      onDirtyChange: noop,
      onOpenRun: noop,
    }),
  )

  /**
   * A column of readings is right-aligned and set in the measurement face. That is a
   * property of the COLUMN, so the class has to reach the header as well as the cells
   * - a right-aligned column under a left-aligned heading is worse than neither.
   *
   * Matched inside the class list rather than as the whole of it: a column now also
   * declares whether it survives phone width, and that arrives as a second class on
   * the same header and cells.
   */
  it('carries the numeric class on the header as well as the cells', () => {
    for (const markup of [history, beans]) {
      expect(markup).toMatch(/<th class="[^"]*\bnumeric\b/)
      expect(markup).toMatch(/<td class="[^"]*\bnumeric\b/)
    }
  })

  it('marks the sorted column on the header it is sorted by', () => {
    // History defaults to Date descending, so exactly one header is marked sorted.
    expect([...history.matchAll(/<th class="sorted[^"]*"/g)]).toHaveLength(1)
    expect(history).toContain('aria-sort="descending"')
  })

  it('right-aligns every column that holds a number and no column that holds a word', () => {
    for (const label of ['Duration', 'Peak temp', 'Batch g']) expect(history).toContain(label)
    // The name and result columns are words and must not be dragged to the right edge.
    expect(history).not.toMatch(/<th class="numeric"[^>]*>(?:(?!<\/th>).)*?Result/s)
    expect(history).not.toMatch(/<th class="numeric"[^>]*>(?:(?!<\/th>).)*?Bean lot/s)
  })
})

/**
 * EXPANDING A ROW MUST NOT RESIZE THE TABLE. Expanding a roast must leave the header and every
 * column width unchanged; otherwise the finish temp column changes width and the header wraps onto
 * an extra line.
 *
 * The detail row is one cell spanning every column, and under the automatic table layout a spanning
 * cell's minimum width is distributed BACK over the columns it spans - so opening a row would feed a
 * notes box and four measurement fields into the column algorithm and rewrap the narrowest heading.
 *
 * The invariant, pinned here: column widths on this table are a function of the
 * column declarations and of nothing else. That is what `table-layout: fixed` means, and it is why
 * every column must declare a width - one that does not would be sized by content again.
 */
describe('the archive table cannot be resized by what is inside it', () => {
  const markup = renderToStaticMarkup(
    createElement(HistoryView, {
      runs: demoRuns,
      onOverlay: noop,
      onDelete: noop,
      onSaveDetails: async () => undefined,
      onImport: async () => '',
      onUseAsProfile: noop,
      activeRoasterId: DEMO_SOURCE_DEVICE_ID,
    }),
  )

  it('pins every column, so nothing in the body can decide a width', () => {
    expect(markup).toContain('pinned-columns')
    // Ten columns (including Score), ten declared widths, on the header row where fixed
    // layout reads them.
    expect([...markup.matchAll(/<th[^>]*style="width:/g)]).toHaveLength(10)
    expect(styles).toContain('.sortable-table.pinned-columns { table-layout: fixed;')
  })

  it('lets a heading be clipped rather than let it grow a second line', () => {
    expect(styles).toMatch(/\.pinned-columns th > span, \.pinned-columns \.column-sort \{[^}]*white-space: nowrap/)
    expect(styles).toMatch(/\.pinned-columns th > span, \.pinned-columns \.column-sort \{[^}]*text-overflow: ellipsis/)
    // The detail cell is the one that must NOT be clipped: it is a stack, and it wraps.
    expect(styles).toContain('.pinned-columns .table-detail-row td { overflow: visible;')
  })

  /**
   * Setup labels are left-justified with the border of the drop-down box, and the same holds for the
   * weight, volume and name fields.
   *
   * So the left edge of a setup field is the CONTAINER's, at x = 0. The label starts there, the
   * control's border starts there, the hint starts there. The control's text is inset by its own
   * padding, which is chrome and not a column to align a label against.
   *
   * A `--control-inset` variable that pushes the label and hint right to meet the control's text is
   * the opposite reading. It is asserted absent rather than zeroed: an override set to 0 is a rule someone has to
   * re-derive the point of, and it would let the inset creep back one variable at a time.
   */
  it('sets every roast setup label, control and hint on the container left edge', () => {
    expect(styles).not.toContain('--control-inset')
    expect(styles).not.toMatch(/\.setup-field[^{]*\{[^}]*padding-left/)
    expect(styles).not.toMatch(/\.setup-hint \{[^}]*padding-left/)
    // The hint stays in normal flow on the same edge, so its full guidance can wrap.
    expect(styles).toMatch(/\.setup-hint \{[^}]*position: static/)
    expect(styles).toMatch(/\.setup-hint \{[^}]*white-space: normal/)
    expect(styles).toMatch(/\.setup-hint \{[^}]*text-overflow: clip/)
    expect(styles).not.toMatch(/\.setup-hint \{[^}]*text-overflow: ellipsis/)
    // The control still keeps its own padding: the fix is not to jam its text against its border.
    expect(styles).toMatch(/select, input \{[^}]*padding: 0 10px/)
    expect(styles).toMatch(/select, input \{[^}]*border: 1px solid/)
  })

  /**
   * All six fields are the same stack, so the edge holds for the whole row rather than for the two
   * dropdowns. Nothing in the row may carry its own left offset.
   */
  it('gives the whole setup row one ruler, not one per field type', () => {
    const row = renderToStaticMarkup(
      createElement(HistoryView, {
        runs: demoRuns,
        onOverlay: noop,
        onDelete: noop,
        onSaveDetails: async () => undefined,
        onImport: async () => '',
        onUseAsProfile: noop,
        activeRoasterId: DEMO_SOURCE_DEVICE_ID,
      }),
    )
    // The archive does not own the setup row; this only guards against a stray inline offset
    // arriving on the shared label class, which would move it everywhere at once.
    expect(row).not.toMatch(/class="form-field-label"[^>]*style="[^"]*padding-left/)
    expect(styles).toMatch(/\.form-field-label \{(?:(?!\}).)*\}/s)
    expect(styles).not.toMatch(/\.form-field-label \{[^}]*padding-left/)
  })
})

describe('empty screens invite an action rather than reporting an absence', () => {
  const emptyHistory = renderToStaticMarkup(
    createElement(HistoryView, {
      runs: [],
      onOverlay: noop,
      onDelete: noop,
      onSaveDetails: async () => undefined,
      onImport: async () => '',
      onUseAsProfile: noop,
      activeRoasterId: DEMO_SOURCE_DEVICE_ID,
    }),
  )

  it('says what to do next, not only that there is nothing here', () => {
    expect(emptyHistory).toContain('empty-state')
    expect(emptyHistory).toContain('Start one on the Roast page')
    // The bare form this replaced.
    expect(emptyHistory).not.toContain('>No roasts stored yet.<')
  })
})

describe('the stylesheet keeps the rules the design is built on', () => {
  it('does not present offline cache provenance as a failed write', () => {
    expect(styles).toMatch(/\.storage-error-banner\[role="status"\] \{[^}]*background: var\(--wash-info\)/)
    expect(styles).toMatch(/\.live-strip\.offline \{[^}]*opacity: 1/)
    expect(styles).toMatch(/\.sync-state-banner\.terminal \{[^}]*background: var\(--wash-warn\)/)
  })

  /**
   * One colour per channel, defined once. The bug this prevents already happened: the
   * fan readout bar was --cyan while the fan trace was #46bfd0, so the same channel
   * had two colours on one screen.
   */
  it('defines each channel exactly once and drives both chart and readout from it', () => {
    for (const channel of ['--ch-bean', '--ch-ror', '--ch-fan', '--ch-heat', '--ch-goal']) {
      expect(styles.match(new RegExp(`${channel}:`, 'g')), `${channel} is not defined once`).toHaveLength(1)
    }
    expect(styles).toContain('.fan-trace { stroke: var(--ch-fan)')
    expect(styles).toContain('.readout.fan::before { background: var(--ch-fan); }')
    expect(styles).toContain('.heat-trace { stroke: var(--ch-heat)')
    expect(styles).toContain('.readout.heat::before { background: var(--ch-heat); }')
  })

  /**
   * Two families, three roles, no webfont. This app is served from the controller's
   * flash on an offline LAN, so a stylesheet that reaches for a hosted face renders
   * as whatever the fallback happens to be on the phone in the roaster's hand.
   */
  it('names no font it cannot serve', () => {
    expect(styles).toContain('--font-ui:')
    expect(styles).toContain('--font-num:')
    expect(styles).not.toContain('@font-face')
    expect(styles).not.toContain('@import')
    expect(styles).not.toContain('fonts.googleapis')
    // Inter is not installed on an offline client; naming it only hid what rendered.
    expect(styles).not.toMatch(/font-family:[^;]*\bInter\b/)
  })

  it('spends exactly three weights, so a step in weight means a step in rank', () => {
    expect(styles).not.toMatch(/font-weight: (?:750|850|500|900)\b/)
    for (const token of ['--w-quiet', '--w-strong', '--w-heavy']) expect(styles).toContain(`${token}:`)
  })

  /** The old ring was 25%-alpha cyan on white: about 1.15:1, which is not a focus state. */
  it('draws a focus ring that can be seen, and never suppresses one outright', () => {
    expect(styles).toContain('outline: 2px solid var(--focus)')
    expect(styles).not.toMatch(/:focus(?:-visible)? \{[^}]*outline: none/)
    // Where an inner control drops its own ring, its container has to carry one.
    expect(styles).toContain('.multi-value-box:focus-within')
  })

  /** Motion is limited to status communication and yields to reduced motion. */
  it('limits animation to status communication and yields to reduced motion', () => {
    expect(styles).toContain('@keyframes readout-charge')
    expect(styles).toContain('@keyframes current-reading-pulse')
    expect(styles).toContain('@keyframes device-heartbeat-report')
    expect(styles).toContain('prefers-reduced-motion: reduce')
    expect(styles.match(/@keyframes /g)).toHaveLength(4) // readout charge, live reading, heartbeat, and spin
  })
})

/**
 * The gutter test measures label boxes against GLYPH_ADVANCE_RATIO = 0.62. Moving the
 * axis labels to a monospace face changes their advance, so this states the direction
 * of that change: every system mono is NARROWER than the estimate, which is why the
 * measured gutter still clears. A face wider than the estimate would silently push
 * labels through the axis rule and into the colour strip.
 */
describe('the chart keeps its measurement face inside the gutter estimate', () => {
  it('sets the chart in the measurement face without touching the label anchors', () => {
    const markup = renderToStaticMarkup(
      createElement(LiveChart, {
        samples: [],
        events: [],
        elapsedSec: 0,
        profile: starterProfile,
      }),
    )
    expect(styles).toMatch(/\.live-chart[^{]*\{[^}]*font-family: var\(--font-num\)/)
    expect(markup).toContain('text-anchor="end"')
    expect(markup).not.toContain('textAnchor')
    // The axis TITLE is a word, so it stays in the body face rather than the mono one.
    expect(styles).toMatch(/\.live-chart \.axis-title[^{]*\{[^}]*font-family: var\(--font-ui\)/)
  })
})
