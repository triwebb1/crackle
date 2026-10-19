import { readFileSync } from 'node:fs'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { demoRuns, starterProfile, starterThermalIntent } from '../data/demo'
import { CHART_VIEW_WIDTH, chartViewWidth, estimatedTextWidth, TEMPERATURE_GUTTER } from '../domain/chartAxis'
import { LiveChart } from './LiveChart'
import { ProfileEditor } from './ProfileEditor'

/**
 * ============================================================================================
 * THE PHONE, PINNED - roasting is operated from a 390 px screen standing at the machine
 * ============================================================================================
 *
 * Two kinds of assertion live here and they cover the two ways phone layout regresses.
 *
 * **The stylesheet rules**, read as text, because these defects are CSS ones and no render can see
 * them: a 700 px floor under a chart, a scroll container wrapped around a whole
 * editor, a width floor put on the wrong element of a flex row. None of those change the markup at
 * all, so a render test could never have caught any of them.
 *
 * **The narrow render**, by telling the components what viewport they are on. Every other render
 * test in this repo runs with no `window` at all and therefore gets the desktop chart width, which
 * is exactly what pins the desktop rendering - so this file, and only this file, stubs one.
 */

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
/** The rules alone. This stylesheet carries as much prose as CSS, and none of it is a declaration. */
const declarations = styles.replace(/\/\*[\s\S]*?\*\//g, '')

const PHONE_PX = 390
const PHONE_VIEW_WIDTH = chartViewWidth(PHONE_PX)

const noop = () => undefined

/*
 * The phone, declared at module scope rather than in a hook, because a component that measures the
 * viewport does so as it renders and several of the renders below happen while the suite is still
 * being collected. Removed again after the file, so the environment every other suite runs in -
 * no window, therefore the desktop width - is exactly what it was.
 */
Object.defineProperty(globalThis, 'window', {
  value: {
    innerWidth: PHONE_PX,
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
  },
  configurable: true,
  writable: true,
})
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

/**
 * Every rule in the stylesheet, flattened, each carrying the narrowest max-width media query it is
 * nested in. A hand-rolled scan rather than a parser dependency: this file has one nesting level
 * and closes its media blocks in column zero.
 */
interface Rule {
  selector: string
  body: string
  maxWidthPx: number
  at: number
}

/**
 * `at` is the rule's position in the SOURCE, media blocks included in place. A media query adds no
 * specificity, so `.profile-meta` in a `max-width: 820px` block genuinely loses to a plain
 * `.profile-meta` written below it - and any check that resolves what a selector ends up with has
 * to walk the file in the order the browser does.
 */
const rules = (): Rule[] => {
  const found: Rule[] = []
  const collect = (source: string, maxWidthPx: number, base: number) => {
    for (const match of source.matchAll(/(^|\n)\s*([^@{}][^{}]*?)\s*\{([^{}]*)\}/g)) {
      found.push({
        selector: match[2].replace(/\s+/g, ' ').trim(),
        body: match[3],
        maxWidthPx,
        at: base + (match.index ?? 0),
      })
    }
  }
  let index = 0
  for (const media of declarations.matchAll(/@media \(([^)]*)\) \{\n([\s\S]*?)\n\}/g)) {
    const start = media.index ?? 0
    collect(declarations.slice(index, start), Number.POSITIVE_INFINITY, index)
    const width = /max-width: (\d+)px/.exec(media[1])
    collect(media[2], width ? Number(width[1]) : Number.POSITIVE_INFINITY, start + media[0].indexOf(media[2]))
    index = start + media[0].length
  }
  collect(declarations.slice(index), Number.POSITIVE_INFINITY, index)
  return found.sort((a, b) => a.at - b.at)
}

const declaration = (body: string, property: string) => {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body)
  return match?.[1].trim()
}

/** Selectors are single-class here, so an exact match on one arm of a group is the whole story. */
const targets = (rule: Rule) => rule.selector.split(',').map((part) => part.trim())

/** What a selector ends up with at a given viewport, cascade order and media width both honoured. */
const effective = (selector: string, property: string, viewportPx: number) => {
  let value: string | undefined
  for (const rule of rules()) {
    if (rule.maxWidthPx < viewportPx) continue
    if (!targets(rule).includes(selector)) continue
    const declared = declaration(rule.body, property)
    if (declared !== undefined) value = declared
  }
  return value
}

describe('the stylesheet cannot put a chart outside the viewport again', () => {
  /**
   * The defect, as a rule about the stylesheet rather than about one selector. A chart is
   * drawn in user units and scales to its box, so a pixel floor under one buys nothing except an
   * overflow - and these charts set `touch-action: none` for their drags, which means the finger
   * that would scroll to the rest of the chart is taken by the chart.
   */
  it('gives no chart a fixed width floor wider than a phone', () => {
    for (const rule of rules()) {
      if (!/chart/.test(rule.selector)) continue
      const floor = declaration(rule.body, 'min-width')
      if (floor === undefined) continue
      expect(Number.parseFloat(floor), `${rule.selector} floors at ${floor}`).toBeLessThanOrEqual(420)
    }
  })

  it('contains the document and every route shell while preserving local table scrollers', () => {
    for (const selector of ['html', 'body', '#root', '.app-shell', '.app-main', '.view']) {
      expect(effective(selector, 'min-width', 320) ?? '0', selector).toBe('0')
      expect(effective(selector, 'max-width', 320), selector).toMatch(/100%|1600px/)
    }
    expect(effective('html', 'overflow-x', 320)).toBe('clip')
    expect(effective('.app-shell', 'overflow-x', 320)).toBe('clip')
    expect(effective('.app-main', 'overflow-x', 320)).toBe('clip')
    expect(effective('.calibration-table-wrap', 'overflow-x', 320)).toBe('auto')
  })

  it('keeps every view on one content origin and lets Roast inherit the shared padding', () => {
    expect(effective('.view', 'margin', 1600)).toBe('0 auto 0 0')
    expect(effective('.view', 'padding', 1600)).toBe('24px 28px 40px')
    expect(effective('.view', 'padding', 390)).toBe('16px 14px 28px')
    expect(effective('.roast-view', 'padding', 1600)).toBeUndefined()
    expect(effective('.roast-view', 'padding', 390)).toBeUndefined()
    expect(effective('.roast-view', 'padding-bottom', 1600)).toBe('42px')
    expect(effective('.roast-view', 'padding-bottom', 390)).toBe('28px')
  })

  it('keeps phone navigation attached below the header, not floating at the bottom', () => {
    expect(effective('.mobile-nav', 'position', 390)).toBe('fixed')
    expect(effective('.mobile-nav', 'top', 390)).toBe('var(--header-h)')
    expect(effective('.mobile-nav', 'bottom', 390)).toBe('auto')
    expect(effective('.mobile-nav', 'height', 390)).toBe('64px')
    expect(effective('.app-shell', 'padding', 390)).toBe('calc(var(--header-h) + 64px) 0 0')
    expect(effective('.control-dock', 'bottom', 390)).toBe('0')
    expect(effective('.global-stop', 'min-height', 390)).toBe('44px')
    expect(effective('.installed-roaster-status', 'display', 390)).toBe('none')
    expect(effective('.live-strip-item small', 'font-size', 390)).toBe('var(--t-micro)')
  })

  it('prevents phone focus zoom and keeps compact actions touchable', () => {
    const ordinaryInput = 'input:not([type="checkbox"]):not([type="radio"]):not([type="file"])'
    expect(effective(ordinaryInput, 'font-size', 390)).toBe('16px')
    expect(effective(ordinaryInput, 'min-height', 390)).toBe('44px')
    expect(effective('.compact-button', 'min-height', 390)).toBe('44px')
    expect(effective('.storage-trash', 'height', 390)).toBe('44px')
  })

  /**
   * The other phone zoom: double-tap-to-zoom. Rapid taps on the cockpit's repeat-press controls
   * (the half-level steppers above all) must be presses, not a zoom gesture - `manipulation`
   * removes exactly that while leaving pinch-zoom and scroll alone. Pinned per selector because
   * the property does not inherit: it protects only the element it is declared on.
   */
  it('keeps rapid taps on the cockpit controls from zooming the page', () => {
    for (const selector of [
      '.level-step',
      '.fan-heat-actions button',
      '.global-stop',
      '.stop-command',
      '.planned-manual-table button',
    ]) {
      expect(effective(selector, 'touch-action', 390), selector).toBe('manipulation')
      expect(effective(selector, 'touch-action', 1600), selector).toBe('manipulation')
    }
  })

  it('keeps setup actions reachable without covering retention warnings', () => {
    expect(effective('.setup-roast', 'padding-bottom', 390)).toContain('150px')
    expect(effective('.setup-roast .setup-start', 'position', 390)).toBe('fixed')
    expect(effective('.setup-roast .setup-start', 'bottom', 390)).toBe('0')
    expect(effective('.setup-roast .retention-warning', 'scroll-margin-bottom', 390)).toContain('150px')
  })

  it('keeps any number of phone warnings in flow so they cannot overlap', () => {
    expect(effective('.fault-banner', 'position', 390)).toBe('static')
    expect(effective('.storage-error-banner', 'position', 390)).toBe('static')
    expect(effective('.fault-banner', 'top', 390)).toBe('auto')
  })

  it('contains every Calibrate panel and its intentionally wide table scrollers', () => {
    expect(effective('.calibration-view', 'min-width', 390)).toBe('0')
    expect(effective('.calibration-view', 'overflow-x', 390)).toBe('clip')
    expect(effective('.calibration-panel', 'min-width', 390)).toBe('0')
    expect(effective('.calibration-table-wrap', 'max-width', 390)).toBe('100%')
    expect(effective('.calibration-table-wrap', 'contain', 390)).toContain('paint')
  })

  it('keeps the cockpit steppers thumb-sized and full width on a phone', () => {
    expect(effective('.fan-heat-fields', 'grid-template-columns', 390)).toBe('repeat(2, minmax(0, 1fr))')
    expect(effective('.fan-heat-fields', 'max-width', 390)).toBe('none')
    expect(effective('.fan-heat-actions', 'max-width', 390)).toBe('none')
    expect(effective('.level-stepper-row', 'grid-template-columns', 390)).toBe('48px minmax(0, 1fr) 48px')
    expect(effective('.level-step', 'min-height', 390)).toBe('48px')
    expect(effective('.fan-heat-apply', 'flex', 390)).toBe('1 1 100%')
    // The draft value is the command being prepared: readout size survives the 16px zoom floor.
    expect(effective('.fan-heat-editor .level-stepper-row input[type="number"]', 'font-size', 390)).toBe(
      'var(--t-readout)',
    )
    expect(effective('.manual-diagnostics-grid', 'grid-template-columns', 390)).toContain('repeat(2')
  })

  /** The header reading and the cockpit glance bar may never wrap a unit onto its own line. */
  it('keeps every live reading on one line with its unit', () => {
    expect(effective('.live-strip-item strong', 'white-space', 390)).toBe('nowrap')
    expect(effective('.manual-live-bar strong', 'white-space', 390)).toBe('nowrap')
    // And the sticky glance bar clears the fixed phone navigation instead of pinning beneath it.
    expect(effective('.manual-live-bar', 'top', 390)).toBe('calc(var(--header-h) + 64px + 8px)')
  })

  /**
   * The running timer joins Fan/Heat/Temp in the strip, so at phone width four items
   * plus heartbeat and an armed Stop must share 390 px: the connection chip yields its room while
   * anything runs, the items keep their compact floor, and the clock reads as a quiet reading
   * rather than a fourth channel.
   */
  it('gives the header timer the chip’s room on a phone instead of wrapping the strip', () => {
    expect(effective('.live-strip-chip', 'display', 390)).toBe('none')
    expect(effective('.live-strip-item', 'min-width', 390)).toBe('43px')
    expect(effective('.live-strip-item.elapsed', 'color', 390)).toBe('var(--on-dark-muted)')
  })

  it('stacks the roast session panel instead of retaining its desktop width floor', () => {
    expect(effective('.session-panel', 'grid-template-columns', 390)).toBe('1fr')
    expect(effective('.session-measurements', 'grid-column', 390)).toBe('1')
  })

  it('keeps the history-transfer scope visible instead of reducing it to upload/download icons', () => {
    expect(effective('.history-view .view-heading', 'display', 390)).toBe('grid')
    expect(effective('.history-view .heading-actions .secondary-button', 'width', 390)).toBe('auto')
    expect(effective('.history-view .heading-actions .secondary-button', 'font-size', 390)).not.toBe('0')
  })

  /**
   * The horizontal scroller must sit with the chart it scrolls. If the scroll container is the
   * whole editor, its scrollbar sits below the step table, a screen and a half away from the chart.
   */
  it('never makes a whole profile editor the horizontal scroller', () => {
    for (const rule of rules()) {
      if (!/\.(timeline|thermal)-editor\b/.test(rule.selector)) continue
      for (const property of ['overflow-x', 'overflow']) {
        expect(declaration(rule.body, property) ?? 'visible', `${rule.selector} scrolls sideways`).not.toMatch(
          /auto|scroll/,
        )
      }
    }
  })

  /**
   * Where the width floor DOES belong: on the flex item. `.profile-row` is what the phone-width
   * strip lays out; flooring the button inside it instead collapses the row onto its 22 px grip and
   * paints its 180 px button over the next row. It is a two-selector distinction that nothing else
   * can catch.
   */
  it('floors the profile strip on the row itself, and truncates a name rather than spilling it', () => {
    const phone = rules().filter((rule) => rule.maxWidthPx <= 820)
    const floored = phone.find((rule) => /\.profile-list > \.profile-row/.test(rule.selector))
    expect(floored, 'nothing gives the profile row a width in the phone strip').toBeDefined()
    expect(floored!.body).toMatch(/flex:\s*0 0 \d{3}px/)
    const truncates = rules().find((rule) => /^\.profile-open > \*$/.test(rule.selector))
    expect(truncates?.body).toContain('text-overflow: ellipsis')
    expect(truncates?.body).toContain('overflow: hidden')
  })

  /**
   * An inline SVG is not a replaced element, so `object-fit` on one has never done anything - and
   * a chart floored taller than its own aspect ratio does not grow, it centres inside empty bands.
   * Neither is a way to make a chart bigger; the width is.
   */
  /**
   * ==========================================================================================
   * THE INVARIANT
   * ==========================================================================================
   *
   * A box wider than the phone is not bounded by bounding something ELSE - the whole editor, or the
   * scroll wrapper's own `max-width` - and either way the page still measures 701 px at 390 px.
   * Every ancestor of the step table is already exactly as wide as the viewport,
   * `document.body.scrollWidth` reads a perfectly innocent 375 px, and every ancestor reports
   * `scrollWidth === clientWidth`. There is no content-sized ancestor to find.
   *
   * What actually happens is that a scroll container's overflowing descendants still
   * propagate into the ROOT's scrollable overflow. `overflow-x: auto` gives the wrap a scrollbar
   * and clips what sticks out of it; it does not stop the 760 px table being counted into the
   * page's own width. **`contain: paint` does**; `overflow-x: clip` on the wrap, the editor, `.view`,
   * `.app-shell` and `html`/`body` each leaves the page at 701 px.
   *
   * So the rule this file enforces is:
   *
   *   > A declared width floor wider than a phone is allowed ONLY inside a wrapper that both
   *   > SCROLLS (`overflow-x: auto`) and CONTAINS ITS PAINT (`contain` including `paint`), and the
   *   > markup must really put it there.
   *
   * Any new floor, on any selector, fails this until it is given a home that satisfies both halves.
   * Shedding the floor is not the escape hatch it looks like, either: left to size themselves these
   * tables measure 802-848 px, so removing the floor makes the page WIDER. The floor is what keeps
   * the columns legible; the containment is what keeps the page still.
   */
  const PHONE_PX_MAX = 560
  const TABLET_PX_MAX = 820
  const FLOOR_LIMIT_PX = 420
  /** Which scroller each floored selector is allowed to live in. Asserted against the markup below. */
  const CONTAINED_IN: Record<string, string> = {
    '.planned-manual-table table': '.planned-manual-table',
    '.profile-points-table': '.profile-points-table-wrap',
    '.response-summary table': '.calibration-table-wrap',
    '.sortable-table.pinned-columns': '.calibration-table-wrap',
    '.zones-table': '.profile-points-table-wrap',
  }

  const flooredAt = (viewportPx: number) => {
    const floored = new Map<string, number>()
    for (const rule of rules()) {
      if (rule.maxWidthPx < viewportPx) continue
      if (declaration(rule.body, 'min-width') === undefined) continue
      for (const selector of targets(rule)) {
        // The rule may be overridden further down the file - `.sortable-table.pinned-columns` is
        // floored at 940 globally and released to 0 at phone width - so resolve, never read once.
        const settled = Number.parseFloat(effective(selector, 'min-width', viewportPx) ?? '0')
        if (Number.isFinite(settled) && settled > FLOOR_LIMIT_PX) floored.set(selector, settled)
      }
    }
    return floored
  }

  it('uses labelled cards on phones and contains the wide tables on tablets', () => {
    expect([...flooredAt(PHONE_PX_MAX).keys()]).toEqual([])
    expect(effective('.profile-points-table-wrap', 'overflow-x', PHONE_PX_MAX)).toBe('visible')
    expect(effective('.profile-points-table td:nth-child(n)', 'width', PHONE_PX_MAX)).toBe('auto')
    expect(effective('.profile-points-table.zones-table td:nth-child(n)', 'width', PHONE_PX_MAX)).toBe('auto')

    const floored = flooredAt(TABLET_PX_MAX)
    expect([...floored.keys()].sort()).toEqual([
      '.planned-manual-table table',
      '.profile-points-table',
      '.response-summary table',
      '.sortable-table.pinned-columns',
      '.zones-table',
    ])

    for (const [selector, floor] of floored) {
      const wrap = CONTAINED_IN[selector]
      expect(wrap, `${selector} floors at ${floor}px with no declared scroller`).toBeDefined()
      expect(effective(wrap, 'overflow-x', TABLET_PX_MAX), `${wrap} does not scroll sideways`).toBe('auto')
      expect(
        effective(wrap, 'contain', TABLET_PX_MAX) ?? 'none',
        `${wrap} scrolls but does not contain its paint, so ${selector} is still counted into the page width`,
      ).toMatch(/paint|strict|content/)
    }
  })

  /** The CSS half is worth nothing if the markup puts the floored table somewhere else. */
  it('really nests both floored tables inside that wrapper', () => {
    expect(editor(starterProfile.id)).toContain(
      '<div class="profile-points-table-wrap"><table class="profile-points-table"',
    )
    expect(editor(starterThermalIntent.id)).toContain(
      '<div class="profile-points-table-wrap"><table class="profile-points-table zones-table"',
    )
  })

  /** The desktop half of the same chain: the workspace is a grid, and its track child must shrink. */
  it('keeps the profile canvas able to shrink inside the desktop workspace grid', () => {
    expect(effective('.profile-workspace', 'grid-template-columns', 1600)).toContain('minmax(0, 1fr)')
    expect(effective('.profile-canvas', 'min-width', 1600)).toBe('0')
  })

  it('keeps Profiles in one column through the 821px navigation handoff', () => {
    expect(effective('.profiles-view .view-heading', 'display', 821)).toBe('grid')
    expect(effective('.profile-workspace', 'display', 821)).toBe('block')
    expect(effective('.profile-list', 'display', 821)).toBe('flex')
    expect(effective('.profile-list', 'contain', 821)).toContain('paint')
    expect(effective('.profile-workspace', 'display', 1101)).toBe('grid')
  })

  /**
   * Phone alignment. The profile name is an input standing in for the h1, and the focus-zoom floor
   * - `input:not(...)`, specificity (0,3,1) - outranks `.title-input` and would set it at 16px in a
   * 44px band, opening the Profiles page with a body-sized title on a phone. The rule has to WIN,
   * not merely exist, so it is resolved through the cascade rather than read once.
   */
  it('keeps the profile title at display size on a phone despite the focus-zoom floor', () => {
    const title = '.profiles-view .view-heading input.title-input'
    expect(effective(title, 'font-size', 390)).toBe('23px')
    expect(effective(title, 'font-size', 700)).toBe('var(--t-h1)')
    expect(effective(title, 'min-height', 390)).toBe('44px')
  })

  /** Save revision sat in a different place depending on whether it was primary or secondary. */
  it('keeps heading actions worded, thumb-sized, and in one place whether or not a save is pending', () => {
    expect(effective('.heading-actions .secondary-button', 'font-size', 390)).not.toBe('0')
    expect(effective('.heading-actions .secondary-button', 'width', 390)).toBeUndefined()
    expect(effective('.heading-actions .icon-button', 'width', 390)).toBe('44px')
    expect(effective('.profiles-view .heading-actions .profile-save', 'margin-left', 390)).toBe('auto')
    expect(effective('.profiles-view .heading-actions .primary-button', 'margin-left', 390)).toBeUndefined()
    expect(effective('.heading-actions .dirty-tag', 'white-space', 390)).toBe('normal')
    expect(effective('.heading-actions', 'flex-wrap', 390)).toBe('wrap')
  })

  it('opens the phone strip on the New buttons and one whole profile card', () => {
    expect(effective('.profile-list > .profile-list-actions', 'flex', 390)).toBe('0 0 150px')
    expect(effective('.profile-list-actions', 'flex', 700)).toBe('0 0 210px')
    expect(effective('.profile-list > .profile-list-actions', 'margin-bottom', 390)).toBe('0')
    expect(effective('.profile-list-actions button', 'min-height', 390)).toBe('44px')
    expect(effective('.profile-list > .profile-row .profile-open', 'align-content', 390)).toBe('center')
    expect(effective('.timeline-editor > .editor-toolbar', 'flex-direction', 390)).toBe('row')
  })

  it('contains the sideways scrollers it had not contained, and wraps the table toolbar', () => {
    expect(effective('.storage-table', 'contain', 390)).toBe('paint')
    expect(effective('.color-scale', 'contain', 390)).toBe('paint')
    expect(effective('.data-table-toolbar', 'flex-wrap', 390)).toBe('wrap')
    expect(effective('.mobile-nav button', 'padding', 390)).toBe('2px 0')
  })

  it('keeps no rule that only ever looked like it was doing something', () => {
    expect(declarations).not.toContain('object-fit')
    const floors = rules().filter((rule) => /chart/.test(rule.selector) && declaration(rule.body, 'min-height'))
    expect(floors.length, 'no chart declares a height floor at all').toBeGreaterThan(0)
    // Every one of them is released at phone width, where the chart is narrower than its floor.
    const released = rules().find(
      (rule) =>
        rule.maxWidthPx <= 560 && /\.live-chart/.test(rule.selector) && declaration(rule.body, 'min-height') === '0',
    )
    expect(released, 'the height floors are never released at phone width').toBeDefined()
  })
})

/* ---------------------------------------------------------------- the narrow render */

const editor = (selectedId: string) =>
  renderToStaticMarkup(
    createElement(ProfileEditor, {
      profiles: [starterProfile, starterThermalIntent],
      selectedId,
      suggestions: { intents: [] },
      runs: demoRuns,
      calibration: defaultCalibration,
      revisions: [],
      snapshots: [],
      defaultMassG: 225,
      onRevisionConsumed: noop,
      onSelect: noop,
      onSave: noop,
      onExport: noop,
      onDirtyChange: noop,
      onReorder: noop,
      onOpenRun: noop,
    }),
  )

/** Every horizontal coordinate a chart actually draws at, translated groups resolved. */
const horizontalExtents = (svg: string) => {
  const values: number[] = []
  for (const group of svg.split(/<g\b/)) {
    const shift = /^[^>]*transform="translate\((-?[\d.]+)/.exec(group)
    const offset = shift ? Number(shift[1]) : 0
    for (const attribute of group.matchAll(/\s(?:x|x1|x2|cx)="(-?[\d.]+)"/g)) {
      values.push(offset + Number(attribute[1]))
    }
  }
  return values
}

const svgOf = (markup: string, className: string) => {
  const match = new RegExp(`<svg class="[^"]*${className}[^"]*"[\\s\\S]*?</svg>`).exec(markup)
  expect(match, `no ${className} rendered`).not.toBeNull()
  return match![0]
}

describe('the profile editor charts at 390px', () => {
  const journey = editor(starterThermalIntent.id)
  const timed = editor(starterProfile.id)

  it('draws itself in fewer units rather than overflowing the screen in a thousand', () => {
    expect(PHONE_VIEW_WIDTH).toBeLessThan(CHART_VIEW_WIDTH)
    expect(svgOf(journey, 'journey-chart')).toContain(`viewBox="0 0 ${PHONE_VIEW_WIDTH} 340"`)
    expect(svgOf(timed, 'timed-lanes')).toContain(`viewBox="0 0 ${PHONE_VIEW_WIDTH} 500"`)
  })

  it('keeps everything it draws inside that viewBox, on both editors', () => {
    for (const [name, svg] of Object.entries({
      journey: svgOf(journey, 'journey-chart'),
      timed: svgOf(timed, 'timed-lanes'),
    })) {
      const extents = horizontalExtents(svg)
      expect(extents.length).toBeGreaterThan(20)
      for (const at of extents) {
        expect(at, `${name} draws at ${at}`).toBeGreaterThanOrEqual(0)
        expect(at, `${name} draws at ${at}`).toBeLessThanOrEqual(PHONE_VIEW_WIDTH)
      }
    }
  })

  /**
   * The gutter is the one piece of geometry that does NOT scale: it is a fixed 90 units whatever
   * the chart's width, so a narrower chart spends proportionally more of itself on it. Both halves
   * of `chartGeometry.test.ts` still have to hold here - the labels anchor exactly where the
   * gutter says, and their boxes clear the viewBox edge - because the axis is drawn from those
   * constants and the plot is drawn from the width.
   */
  it('holds the shared gutter at the narrow width', () => {
    const svg = svgOf(journey, 'journey-chart')
    const anchors = [...svg.matchAll(/<text class="axis-label" x="([\d.]+)"[^>]*text-anchor="end"/g)].map((match) =>
      Number(match[1]),
    )
    expect(anchors.length).toBeGreaterThanOrEqual(5)
    for (const anchor of anchors) expect(anchor).toBe(TEMPERATURE_GUTTER.labelX)
    // The widest label the domain can produce still starts inside the chart.
    expect(TEMPERATURE_GUTTER.labelX - estimatedTextWidth('230', TEMPERATURE_GUTTER.labelFontSize)).toBeGreaterThan(6)
    // And the plot still has most of the width, rather than being a strip beside the axis.
    const plotRight = PHONE_VIEW_WIDTH - 84
    expect(plotRight - TEMPERATURE_GUTTER.plotLeft).toBeGreaterThan(PHONE_VIEW_WIDTH / 2)
  })

  /**
   * A node is a touch target before it is a mark. Nine units is eight real pixels on a desktop and
   * three on a phone, so the radius is multiplied by the same factor the viewBox narrowed by and
   * the thumb gets back what the scale took.
   */
  it('grows the drag handles by what the narrower chart took from them', () => {
    const journeyNodes = [...svgOf(journey, 'journey-chart').matchAll(/class="thermal-node"[^>]*r="(\d+)"/g)].map(
      (match) => Number(match[1]),
    )
    expect(journeyNodes.length).toBeGreaterThan(0)
    for (const radius of journeyNodes) expect(radius).toBeGreaterThan(9)
    const timedNodes = [...svgOf(timed, 'timed-lanes').matchAll(/class="automation-node[^"]*"[^>]*r="(\d+)"/g)].map(
      (match) => Number(match[1]),
    )
    expect(timedNodes.length).toBeGreaterThan(0)
    for (const radius of timedNodes) expect(radius).toBeGreaterThan(8)
  })

  /** A name too long for the strip is truncated by CSS, so the whole of it lives on the title. */
  it('names every profile in the strip on its own row, in full', () => {
    expect(journey).toContain(`title="${starterProfile.name}"`)
    expect(journey).toContain(`title="${starterThermalIntent.name}"`)
  })
})

describe('the live chart at 390px', () => {
  const markup = renderToStaticMarkup(
    createElement(LiveChart, {
      samples: [],
      events: [],
      elapsedSec: 0,
      targetIntent: starterThermalIntent,
      overlay: demoRuns[0],
      temperatureLabel: 'Actual',
    }),
  )

  it('narrows with the rest of them', () => {
    expect(markup).toContain(`viewBox="0 0 ${PHONE_VIEW_WIDTH} 480"`)
  })

  /**
   * The legend was placed from label widths but drawn at a font size a media query had doubled, so
   * on a phone every key overlapped the one after it. There is no second font size any more: the
   * chart narrows instead, and the placement measures against the room there is.
   */
  it('lays the legend out without a key overlapping the next or leaving the plot', () => {
    const keys = [...markup.matchAll(/<text class="key [^"]*" x="([\d.]+)" y="([\d.]+)">([^<]*)<\/text>/g)].map(
      (match) => ({ x: Number(match[1]), y: Number(match[2]), label: match[3] }),
    )
    expect(keys.length).toBeGreaterThanOrEqual(4)
    const limit = PHONE_VIEW_WIDTH - 76 - TEMPERATURE_GUTTER.plotLeft - 8
    for (const key of keys) {
      expect(key.x + estimatedTextWidth(key.label, 12), `${key.label} overhangs the plot`).toBeLessThanOrEqual(limit)
    }
    for (const row of new Set(keys.map((key) => key.y))) {
      const line = keys.filter((key) => key.y === row)
      for (const [index, key] of line.slice(1).entries()) {
        expect(key.x - line[index].x, `${line[index].label} runs into ${key.label}`).toBeGreaterThanOrEqual(
          estimatedTextWidth(line[index].label, 12),
        )
      }
    }
  })
})

describe('phone portrait layout', () => {
  it('gives the archive table phone-sized tracks instead of desktop percentages', () => {
    // Fixed layout turned the hidden columns' spans into phantom tracks when a roast was opened.
    expect(effective('.sortable-table.pinned-columns', 'table-layout', 390)).toBe('auto')
    expect(effective('.sortable-table.pinned-columns th', 'width', 390)).toBe('auto !important')
    // The expand column's rule must out-rank the release above, or it absorbs the spare width.
    expect(effective('.sortable-table.pinned-columns .row-expand-head', 'width', 390)).toBe('30px !important')
    expect(effective('.sortable-table.pinned-columns th.score-cell', 'width', 390)).toMatch(/px !important$/)
    expect(effective('.sortable-table.pinned-columns th.date-cell', 'width', 390)).toMatch(/px !important$/)
  })

  it('pairs short fields two to a row instead of one per full-width row', () => {
    expect(effective('.profile-points-table.zones-table tr', 'grid-template-columns', 390)).toBe(
      'repeat(2, minmax(0, 1fr))',
    )
    expect(effective('.bean-fields', 'grid-template-columns', 390)).toBe('repeat(2, minmax(0, 1fr))')
    expect(effective('.thermal-applied', 'grid-template-columns', 390)).toBe('repeat(2, minmax(0, 1fr))')
    expect(effective('.simulation-zones tr', 'grid-template-columns', 390)).toBe('repeat(3, minmax(0, 1fr))')
    expect(effective('.history-actions', 'grid-template-columns', 390)).toBe('1fr 1fr')
  })

  it('turns the tables that clipped their buttons into records', () => {
    expect(effective('.revision-table thead', 'display', 390)).toBe('none')
    expect(effective('.storage-table thead', 'display', 390)).toBe('none')
    expect(effective('.storage-table tr', 'display', 390)).toBe('grid')
  })

  it('offers a sort menu only where column headings have left the row', () => {
    expect(effective('.data-table-sort', 'display', 1200)).toBe('none')
    expect(effective('.data-table-sort', 'display', 390)).toBe('block')
  })
})
