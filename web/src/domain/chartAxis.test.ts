import { describe, expect, it } from 'vitest'
import {
  CHART_VIEW_WIDTH,
  CHART_WIDTH_STEPS,
  chartUnitScale,
  chartViewWidth,
  estimatedTextWidth,
  planLegendRows,
  planTimeTicks,
  snapTo,
  TEMPERATURE_GUTTER,
} from './chartAxis'
import { JOURNEY_LEVEL_SNAP, JOURNEY_TEMPERATURE_SNAP_C, JOURNEY_TIME_SNAP_SEC, orderedLimit } from './journeyEdit'
import type { ThermalSegment } from './types'

describe('label extents', () => {
  it('scales with the character count and the font size', () => {
    expect(estimatedTextWidth('230', 12)).toBeCloseTo(22.32, 2)
    expect(estimatedTextWidth('50', 12)).toBeLessThan(estimatedTextWidth('230', 12))
    expect(estimatedTextWidth('230', 16)).toBeGreaterThan(estimatedTextWidth('230', 12))
    expect(estimatedTextWidth('', 12)).toBe(0)
  })

  it('over-estimates the tabular digits these axes carry, so a gutter that clears it really clears', () => {
    // Inter's digit advance is nearer 0.55em; the estimate is deliberately wider.
    expect(estimatedTextWidth('230', 12)).toBeGreaterThan(3 * 12 * 0.55)
  })
})

describe('the editing grid', () => {
  it('snaps to the nearest multiple, in both directions', () => {
    expect(snapTo(187.3, JOURNEY_TEMPERATURE_SNAP_C)).toBe(185)
    expect(snapTo(188, JOURNEY_TEMPERATURE_SNAP_C)).toBe(190)
    expect(snapTo(157, JOURNEY_TIME_SNAP_SEC)).toBe(150)
    expect(snapTo(158, JOURNEY_TIME_SNAP_SEC)).toBe(165)
    expect(snapTo(6.44, JOURNEY_LEVEL_SNAP)).toBeCloseTo(6.4, 10)
  })

  it('leaves a value alone when there is no grid to snap to', () => {
    expect(snapTo(187.3, 0)).toBe(187.3)
    expect(snapTo(187.3, -5)).toBe(187.3)
    expect(snapTo(Number.NaN, 5)).toBe(0)
  })

  it('is idempotent, so a drag and its commit land on the same value', () => {
    for (const value of [0, 51.2, 137.9, 229.4]) {
      const once = snapTo(value, JOURNEY_TEMPERATURE_SNAP_C)
      expect(snapTo(once, JOURNEY_TEMPERATURE_SNAP_C)).toBe(once)
    }
  })
})

const zone = (over: Partial<ThermalSegment> = {}): ThermalSegment[] => [
  {
    id: 'z',
    startC: 150,
    endC: 200,
    durationSec: 120,
    fanMin: 4,
    fanMax: 9,
    heatMin: 3,
    heatMax: 8,
    ...over,
  },
]

/**
 * Dragging a limit line has to keep the pair ordered. An inverted range is not a state the zone
 * table can display or the simulator can read, so the opposite edge moves with it.
 */
describe('dragging an actuator limit', () => {
  it('sets the edge that was dragged', () => {
    expect(orderedLimit(zone(), 'z', 'fanMin', 5)).toEqual({ fanMin: 5, fanMax: 9 })
    expect(orderedLimit(zone(), 'z', 'heatMax', 6)).toEqual({ heatMax: 6, heatMin: 3 })
  })

  it('pushes the other edge rather than storing an inverted range', () => {
    expect(orderedLimit(zone(), 'z', 'fanMin', 9.5)).toEqual({ fanMin: 9.5, fanMax: 9.5 })
    expect(orderedLimit(zone(), 'z', 'fanMax', 2)).toEqual({ fanMax: 2, fanMin: 2 })
    expect(orderedLimit(zone(), 'z', 'heatMin', 10)).toEqual({ heatMin: 10, heatMax: 10 })
    expect(orderedLimit(zone(), 'z', 'heatMax', 1)).toEqual({ heatMax: 1, heatMin: 1 })
  })

  it('clamps into the actuator range and onto the 0.1 grid', () => {
    expect(orderedLimit(zone(), 'z', 'fanMax', 44)).toEqual({ fanMax: 10, fanMin: 4 })
    expect(orderedLimit(zone(), 'z', 'fanMin', -3)).toEqual({ fanMin: 0, fanMax: 9 })
    expect(orderedLimit(zone(), 'z', 'heatMin', 5.55)).toMatchObject({ heatMin: 5.6 })
  })

  it('says nothing about a zone it cannot find', () => {
    expect(orderedLimit(zone(), 'missing', 'fanMin', 5)).toEqual({})
  })
})

/**
 * Axis reference management, against its two-part requirement: no gap goes more than two minutes
 * without an axis marker - but with a point at 8 minutes and a point at 13 minutes, a 10-minute
 * marker is unnecessary because the 13 covers it.
 */
describe("planning a time axis around the profile's own points", () => {
  const times = (ticks: ReturnType<typeof planTimeTicks>) => ticks.map((tick) => tick.timeSec)
  const kinds = (ticks: ReturnType<typeof planTimeTicks>, kind: 'point' | 'filler') =>
    ticks.filter((tick) => tick.kind === kind).map((tick) => tick.timeSec)

  it('labels every authored point, and marks it as a point', () => {
    const ticks = planTimeTicks([0, 135, 285, 430, 570], 660)
    expect(kinds(ticks, 'point')).toEqual([0, 135, 285, 430, 570])
  })

  it('fills a sparse axis rather than leaving it nearly empty', () => {
    // Two points, ten minutes apart: the defect this exists to remove.
    const ticks = planTimeTicks([0, 600], 600)
    expect(kinds(ticks, 'filler')).toEqual([240, 360])
    expect(times(ticks)).toEqual([0, 240, 360, 600])
    // Nothing is left unlabelled for longer than the widest gap the point labels themselves impose.
    expect(
      Math.max(
        ...times(ticks)
          .slice(1)
          .map((time, index) => time - times(ticks)[index]),
      ),
    ).toBeLessThanOrEqual(240)
  })

  it('drops the 10-minute filler when a point at 8 and a point at 13 already cover it', () => {
    // The requirement's example, exactly. 10:00 is two minutes from the 8:00 label and 12:00 is one
    // minute from the 13:00 one, so neither is telling a reader anything the points do not.
    const ticks = planTimeTicks([480, 780], 780)
    expect(kinds(ticks, 'filler')).not.toContain(600)
    expect(kinds(ticks, 'filler')).not.toContain(720)
    // The empty stretch BEFORE 8:00 still gets its scaffolding - the rule is local to each gap,
    // and "we have the 13" says nothing about the first eight minutes.
    expect(times(ticks)).toEqual([0, 120, 240, 480, 780])
  })

  it('never drops a point label to make room, however crowded two of them are', () => {
    const ticks = planTimeTicks([300, 310], 620)
    expect(kinds(ticks, 'point')).toEqual([300, 310])
    // The filler that would have collided with them is the one that goes.
    expect(kinds(ticks, 'filler')).not.toContain(240)
    expect(kinds(ticks, 'filler')).not.toContain(360)
  })

  it('coarsens the grid on a long roast instead of drawing twenty ticks', () => {
    const short = planTimeTicks([], 600)
    const long = planTimeTicks([], 3600)
    const step = (ticks: ReturnType<typeof planTimeTicks>) => times(ticks)[1] - times(ticks)[0]
    expect(step(short)).toBe(120)
    expect(step(long)).toBeGreaterThan(120)
    expect(long.length).toBeLessThanOrEqual(9)
  })

  it('survives a degenerate profile without inventing an axis', () => {
    expect(planTimeTicks([], 0)).toEqual([{ timeSec: 0, kind: 'point' }])
    expect(planTimeTicks([0], 0)).toEqual([{ timeSec: 0, kind: 'point' }])
    // Times outside the plotted span are not labels on it.
    expect(times(planTimeTicks([0, 900], 600))).not.toContain(900)
  })

  it('returns one sorted list, so a caller cannot draw them out of order', () => {
    const ticks = planTimeTicks([500, 100], 900)
    expect(times(ticks)).toEqual([...times(ticks)].sort((a, b) => a - b))
  })
})

/**
 * The chart width, and the two properties every chart in the app depends on it having.
 *
 * The defect this replaced was a 700 px minimum width on the profile editors' charts: on a 390 px
 * phone that put half the chart outside the viewport, behind a scrollbar the chart's own
 * `touch-action: none` made unreachable with a finger. Narrowing the viewBox is the opposite trade
 * - the whole chart is on screen and each unit is drawn LARGER - and it only works if the numbers
 * below hold.
 */
describe('the chart width for a viewport', () => {
  it('leaves anything desktop-sized exactly as it was', () => {
    expect(chartViewWidth(1440)).toBe(CHART_VIEW_WIDTH)
    expect(chartViewWidth(821)).toBe(CHART_VIEW_WIDTH)
    // No viewport at all - the server render, and every test in this repo - is the desktop width,
    // which is what keeps the rendered markup identical to what it was before charts responded.
    expect(chartViewWidth()).toBe(CHART_VIEW_WIDTH)
    expect(chartViewWidth(Number.NaN)).toBe(CHART_VIEW_WIDTH)
  })

  it('narrows in steps, never below the narrowest, and never widens as the screen shrinks', () => {
    const narrowest = Math.min(...CHART_WIDTH_STEPS.map((step) => step.viewWidth))
    let previous = chartViewWidth(1440)
    for (const viewport of [1024, 900, 820, 700, 600, 560, 430, 390, 320, 240]) {
      const width = chartViewWidth(viewport)
      expect(width, `${viewport}px widened the chart`).toBeLessThanOrEqual(previous)
      expect(width).toBeGreaterThanOrEqual(narrowest)
      previous = width
    }
    expect(chartViewWidth(390)).toBe(560)
    expect(chartViewWidth(560)).toBe(560)
    expect(chartViewWidth(700)).toBe(760)
  })

  /**
   * A chart is scaled into its box, so a unit is drawn at (box width / viewBox width) pixels. The
   * step has to buy back enough of that to be worth making: without it, at 390 px a 1000-unit chart
   * draws a 12-unit label at four and a half pixels.
   */
  it('buys back enough scale at phone width for a label to be legible', () => {
    const chartPx = 390 - 28 // .view padding at this breakpoint, both sides
    expect(chartPx / chartViewWidth(390)).toBeGreaterThan(0.6)
    expect(chartPx / CHART_VIEW_WIDTH).toBeLessThan(0.4) // what it was
  })

  it('reports the unit scale that touch targets are sized by', () => {
    expect(chartUnitScale(CHART_VIEW_WIDTH)).toBe(1)
    expect(chartUnitScale(560)).toBeCloseTo(1.786, 3)
    // A degenerate width must never collapse a hit target to nothing.
    expect(chartUnitScale(0)).toBe(1)
    expect(chartUnitScale(Number.NaN)).toBe(1)
  })

  /**
   * The gutter is a fixed 90 units whatever the width, so a narrow chart spends proportionally
   * more of itself on it. This states the floor: even at the narrowest step and the narrowest
   * supported viewport, the plot is the majority of the chart rather than a strip beside an axis.
   */
  it('leaves a real plot beside the fixed gutters at every width', () => {
    for (const { viewWidth } of CHART_WIDTH_STEPS) {
      const plotRight = viewWidth - 84 // the journey chart's actuator axis
      expect(plotRight - TEMPERATURE_GUTTER.plotLeft).toBeGreaterThan(viewWidth / 2)
    }
  })
})

describe('a legend laid out from its own labels', () => {
  const keys = [{ label: 'Actual' }, { label: 'Planned goal' }, { label: 'Fan' }, { label: 'Heat' }]

  it('places each key after the one before it, with a gap', () => {
    const placed = planLegendRows(keys, 900)
    expect(placed[0].x).toBe(0)
    for (const [index, key] of placed.slice(1).entries()) {
      const previous = placed[index]
      expect(key.x - previous.x).toBeGreaterThanOrEqual(estimatedTextWidth(previous.label, 12))
    }
    expect(placed.every((key) => key.y === 0)).toBe(true)
  })

  it('wraps rather than running off the plot, and never overlaps within a row', () => {
    const placed = planLegendRows(keys, 140)
    expect(placed.some((key) => key.y > 0)).toBe(true)
    for (const key of placed) {
      expect(key.x + estimatedTextWidth(key.label, 12), `${key.label} overhangs`).toBeLessThanOrEqual(140)
    }
    for (const row of new Set(placed.map((key) => key.y))) {
      const line = placed.filter((key) => key.y === row)
      for (const [index, key] of line.slice(1).entries()) {
        expect(key.x - line[index].x).toBeGreaterThanOrEqual(estimatedTextWidth(line[index].label, 12))
      }
    }
  })

  /** A key wider than the whole plot still has to be drawn somewhere, and drawn once. */
  it('keeps a label too long for any row rather than dropping it', () => {
    const placed = planLegendRows([{ label: 'Actual' }, { label: 'dashed = planned Fan / Heat' }], 60)
    expect(placed).toHaveLength(2)
    expect(placed[1].x).toBe(0)
    expect(placed[1].y).toBeGreaterThan(0)
  })
})
