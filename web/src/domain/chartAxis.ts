/**
 * Axis arithmetic shared by every chart, so two charts cannot disagree about where a tick goes or
 * how much room a label needs.
 */

/**
 * How wide a label actually is, in the chart's own user units.
 *
 * This exists because a layout test that measures only the coordinates we chose measures nothing:
 * a label is a *box*, not a point, and the box is what collides. The ratio is a deliberate
 * over-estimate for the tabular digits these axes carry - Inter's digit advance is nearer 0.55em -
 * so a gutter that clears this estimate clears the real text with room to spare.
 */
export const GLYPH_ADVANCE_RATIO = 0.62

export const estimatedTextWidth = (text: string, fontSizeUnits: number) =>
  text.length * fontSizeUnits * GLYPH_ADVANCE_RATIO

/**
 * ==============================================================================================
 * CHART WIDTH - why a narrow screen narrows the viewBox instead of scrolling sideways
 * ==============================================================================================
 *
 * Every chart in this app is drawn in user units and scaled by the browser into whatever box CSS
 * gives it, so a phone does not get a smaller chart - it gets the SAME chart shrunk. A thousand
 * units into 360 CSS pixels is a factor of 0.36, which takes a 12-unit axis label down to four and a
 * half pixels and a 9-unit drag handle down to three.
 *
 * The stylesheet's previous answer on the profile editors was a 700 px floor, and it traded
 * illegible for unreachable: the chart overflowed its editor, the editor scrolled sideways, and the
 * SVG's own `touch-action: none` - which every drag on these charts depends on - meant a finger on
 * the chart could not pan that scroller at all. Half the chart was simply not reachable on a phone.
 *
 * So the viewBox narrows instead. Fewer units across the same pixels is a larger scale factor, and
 * because every glyph, node, hit target and stroke on these charts is expressed in units, they all
 * grow together - no per-breakpoint font rules, no layout that the stylesheet and the geometry code
 * have to agree about separately. The steps match the stylesheet's own breakpoints, and above
 * 820 px nothing changes at all, which is what keeps the desktop rendering identical.
 */
export const CHART_VIEW_WIDTH = 1000

/** Viewport width to viewBox width. First match wins; anything wider is the full-width default. */
export const CHART_WIDTH_STEPS = [
  { maxViewportPx: 560, viewWidth: 560 },
  { maxViewportPx: 820, viewWidth: 760 },
] as const

export const chartViewWidth = (viewportPx?: number): number =>
  viewportPx === undefined || !Number.isFinite(viewportPx)
    ? CHART_VIEW_WIDTH
    : (CHART_WIDTH_STEPS.find((step) => viewportPx <= step.maxViewportPx)?.viewWidth ?? CHART_VIEW_WIDTH)

/**
 * How much larger one user unit is drawn at `viewWidth` than at the full-width default.
 *
 * Anything sized for a FINGER rather than for the drawing - a node radius, a grab tolerance - is
 * multiplied by this, so its size in real pixels stays roughly what it is on a desktop instead of
 * shrinking with the chart.
 */
export const chartUnitScale = (viewWidth: number) =>
  Number.isFinite(viewWidth) && viewWidth > 0 ? CHART_VIEW_WIDTH / viewWidth : 1

/**
 * Round time steps, in seconds. A roast axis is read in minutes and half-minutes; nothing below is
 * useful and nothing between is a number anybody thinks in.
 */
export const TIME_TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600] as const

/**
 * Ticks at a ROUND interval that yields a sensible count, rather than at fractions of the duration.
 *
 * Dividing a duration into fifths produces 2:39 and 5:18 - correct numbers that no one can read a
 * chart against. Choosing the interval first and letting the count fall out gives 0:00, 2:00,
 * 4:00, which is what a reader is actually looking for. The last tick is dropped when it would sit
 * on top of the axis end.
 */
export const timeAxisTicks = (durationSec: number, maximumTicks = 8): number[] => {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0]
  const step =
    TIME_TICK_STEPS.find((candidate) => durationSec / candidate <= maximumTicks - 1) ??
    TIME_TICK_STEPS[TIME_TICK_STEPS.length - 1]
  const ticks: number[] = []
  for (let tick = 0; tick <= durationSec + 1e-9; tick += step) ticks.push(tick)
  return ticks
}

/**
 * ==============================================================================================
 * AXIS REFERENCE MANAGEMENT - the point labels are the axis, the round ticks fill the voids
 * ==============================================================================================
 *
 * The requirement: no gap may go more than two minutes without an axis marker - but with a point at
 * 8 minutes and a point at 13 minutes, a 10-minute marker is unnecessary because the 13 covers it.
 *
 * Two rules, and they are in tension on purpose, so the precedence has to be stated rather than
 * discovered:
 *
 *   - **A point label is never dropped.** Where the profile actually puts a step or a zone boundary
 *     is the thing being read off the axis; a round number is only scaffolding.
 *   - **Round filler ticks are drawn on a two-minute grid**, which is the "don't go more than two
 *     minutes without a marker" half. On a long journey the grid coarsens, because twenty ticks is
 *     not a denser axis, it is an unreadable one.
 *   - **A filler within `MIN_LABEL_GAP_SEC` of a point label is redundant and is dropped.** This is
 *     the requirement's second half, and it is what makes the 8/13 example come out as stated:
 *     with points at 8:00 and 13:00 the grid offers 10:00 and 12:00, 10:00 sits two minutes from the
 *     8:00 label and 12:00 one minute from the 13:00 one, so both go and that stretch is labelled by
 *     its two real points alone. A sparse profile with points ten minutes apart keeps 4:00 and 6:00,
 *     which is the "axis is nearly empty" defect this exists to remove.
 *
 * Pure and shared by both editor charts, so the timed lanes and the temperature journey cannot end
 * up with two ideas of where a tick goes. See `chartAxis.test.ts`.
 */

/** The filler grid, and the floor on how coarse the grid may get. Two minutes, as asked. */
export const FILLER_TICK_STEP_SEC = 120

/**
 * How close a round filler may come to a real point label before it is saying nothing. Two minutes
 * - the same number as the grid - which is what makes a filler exactly one grid step from a point
 * label redundant, and is the rule the 8:00/13:00 example is an instance of.
 */
export const MIN_LABEL_GAP_SEC = 120

/** A tick on a time axis, and whether it is a real point on the profile or scaffolding. */
export interface PlannedTimeTick {
  timeSec: number
  kind: 'point' | 'filler'
}

/**
 * The axis for a chart whose x-positions are authored rather than regular.
 *
 * `pointTimes` are the profile's own times - a timed step, a zone boundary - and every one of them
 * is labelled. Round fillers are then laid over the gaps and thinned against those labels.
 *
 * `maximumTicks` coarsens the grid on a long roast: the step is the first round interval that keeps
 * the whole duration inside the budget, floored at `FILLER_TICK_STEP_SEC`.
 */
export const planTimeTicks = (
  pointTimes: readonly number[],
  durationSec: number,
  { maximumTicks = 9, minGapSec = MIN_LABEL_GAP_SEC }: { maximumTicks?: number; minGapSec?: number } = {},
): PlannedTimeTick[] => {
  const span = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const points = [
    ...new Set(pointTimes.filter((time) => Number.isFinite(time) && time >= 0 && time <= span + 1e-9)),
  ].sort((a, b) => a - b)
  const ticks: PlannedTimeTick[] = points.map((timeSec) => ({ timeSec, kind: 'point' }))
  if (span <= 0) return ticks.length > 0 ? ticks : [{ timeSec: 0, kind: 'point' }]

  const step = Math.max(
    FILLER_TICK_STEP_SEC,
    TIME_TICK_STEPS.find((candidate) => span / candidate <= maximumTicks - 1) ??
      TIME_TICK_STEPS[TIME_TICK_STEPS.length - 1],
  )
  for (let tick = 0; tick <= span + 1e-9; tick += step) {
    // A round tick that a point label already stands on, or stands beside, adds nothing.
    if (points.some((point) => Math.abs(point - tick) <= minGapSec)) continue
    ticks.push({ timeSec: tick, kind: 'filler' })
  }
  return ticks.sort((a, b) => a.timeSec - b.timeSec)
}

/**
 * A legend laid out from the width of its own labels, wrapping when the plot runs out.
 *
 * Positions have always followed the label widths here rather than hand-tuned offsets, because a
 * key that only appears sometimes - a comparison, a zone overrun - moves everything after it. What
 * this adds is the second dimension: a chart drawn 560 units wide has barely half the room the
 * legend was designed against, and seven keys in one line would run off the plot and out of the
 * viewBox. Nothing wraps at desktop width, where the widest legend the chart can produce still
 * fits in one line, so this changes only the case that was broken.
 */
export const planLegendRows = <T extends { label: string }>(
  keys: readonly T[],
  limitUnits: number,
  { fontUnits = 12, gapUnits = 20, rowUnits = 16 } = {},
): Array<T & { x: number; y: number }> => {
  let x = 0
  let row = 0
  return keys.map((key) => {
    const width = estimatedTextWidth(key.label, fontUnits) + gapUnits
    if (x > 0 && x + width > limitUnits) {
      x = 0
      row += 1
    }
    const placed = { ...key, x, y: row * rowUnits }
    x += width
    return placed
  })
}

/** Snap a dragged value onto an editing grid. Used for both axes of the journey editor. */
export const snapTo = (value: number, step: number) => {
  if (!Number.isFinite(value)) return 0
  if (!Number.isFinite(step) || step <= 0) return value
  return Math.round(value / step) * step
}

/**
 * The one gutter layout both temperature charts use: right-aligned tick labels, then the axis rule
 * and its outward ticks, then the bean-color strip, then the plot. Every boundary is generous
 * enough that a three-digit label at the axis font size clears everything to its right - see
 * `chartGeometry.test.ts`, which checks the label's box rather than its anchor point.
 */
export const TEMPERATURE_GUTTER = {
  /** Right edge of the labels. They are right-aligned, so the text grows LEFT from here. */
  labelX: 46,
  labelFontSize: 12,
  tickLength: 5,
  ruleX: 58,
  stripX: 66,
  stripWidth: 11,
  plotLeft: 90,
} as const
