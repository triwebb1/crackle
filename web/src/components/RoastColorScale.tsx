import { type PlannedTimeTick, TEMPERATURE_GUTTER, timeAxisTicks } from '../domain/chartAxis'
import { formatClock } from '../domain/model'
import { roastGradientStops } from '../domain/roastGradient'

/**
 * The roast-color temperature scale: one gradient, rendered once, welded to a chart's y-axis.
 *
 * The `<linearGradient>` lives in **user space**, its endpoints taken from the caller's own y-scale.
 * That is what makes the color at a given height mean the temperature the axis says it does, at any
 * width, at any zoom, and after any resize - the alignment is a property of the coordinate system
 * rather than of a hand-tuned percentage.
 *
 * **There is no in-plot ambient tint.** Compositing the ramp over the near-black chart surface at
 * low alpha does not produce a faint version of these colors, it produces *different* ones: the
 * browns go essentially invisible and the hues that survive read wrong. A color scale that
 * misreports the color is worse than no color scale, so the strip - full opacity, hairline border,
 * its own gutter - is the only rendering.
 */

export interface RoastScaleGeometry {
  /** A stable id; two charts on one page must not share one. */
  gradientId: string
  /** The caller's own scale, so the gradient lands exactly where the axis values do. */
  y: (temperatureC: number) => number
  domainMinC: number
  domainMaxC: number
}

/** The gradient definition. Rendered once per chart, referenced by the strip. */
export function RoastGradientDefs({ gradientId, y, domainMinC, domainMaxC }: RoastScaleGeometry) {
  const stops = roastGradientStops(domainMinC, domainMaxC)
  if (stops.length === 0) return null
  return (
    <defs>
      <linearGradient
        id={gradientId}
        gradientUnits="userSpaceOnUse"
        x1="0"
        y1={y(domainMinC)}
        x2="0"
        y2={y(domainMaxC)}
      >
        {stops.map((stop, index) => (
          <stop
            key={`${stop.position}-${stop.opacity}-${index}`}
            offset={stop.position}
            stop-color={stop.color}
            stop-opacity={stop.opacity}
          />
        ))}
      </linearGradient>
    </defs>
  )
}

export interface RoastColorStripProps extends RoastScaleGeometry {
  /** Left edge of the band. It owns this lane; nothing else may be drawn in it. */
  x?: number
  width?: number
}

/**
 * A narrow full-opacity band of expected bean color running the height of the temperature axis.
 *
 * Eleven units wide - about 10 px at the width these charts render - with a one-unit hairline in
 * the page background rather than a thick light mat. A mat does a real job (browns cannot be judged
 * against near-black without a neutral local reference) but at the cost of a slab of white beside
 * every chart. A hairline gives the eye the same
 * reference at a fraction of the area. The band follows the bean-color reference from green up to
 * its 230 °C top; the headroom above it is deliberately unpainted, because the reference says
 * nothing there.
 */
export function RoastColorStrip({
  gradientId,
  y,
  domainMinC,
  domainMaxC,
  x = TEMPERATURE_GUTTER.stripX,
  width = TEMPERATURE_GUTTER.stripWidth,
}: RoastColorStripProps) {
  if (roastGradientStops(domainMinC, domainMaxC).length === 0) return null
  const top = y(domainMaxC)
  const height = y(domainMinC) - top
  return (
    <g className="roast-color-strip" aria-hidden="true">
      <rect className="roast-color-band" x={x} y={top} width={width} height={height} fill={`url(#${gradientId})`} />
      <title>Expected bean color by temperature, from the roast reference</title>
    </g>
  )
}

export interface TemperatureAxisProps extends RoastScaleGeometry {
  ticks: number[]
  unit?: string
}

/**
 * A real y-axis: a domain rule, outward tick marks at every labelled value, and the values
 * right-aligned so they END before the rule rather than starting at it.
 *
 * The geometry is `TEMPERATURE_GUTTER`, shared verbatim with every chart that has one of these, so
 * the two charts cannot drift apart - which is what happened when they each carried their own
 * constants. Nothing but the labels may be drawn left of the rule, and nothing but the strip
 * between the rule and the plot.
 */
export function TemperatureAxis({ ticks, y, domainMinC, domainMaxC, unit = 'C' }: TemperatureAxisProps) {
  const { labelX, ruleX, tickLength } = TEMPERATURE_GUTTER
  return (
    <g className="temperature-axis">
      <line className="axis-rule" x1={ruleX} x2={ruleX} y1={y(domainMaxC)} y2={y(domainMinC)} />
      {ticks.map((tick) => (
        <g key={`tick-${tick}`}>
          <line className="axis-tick" x1={ruleX - tickLength} x2={ruleX} y1={y(tick)} y2={y(tick)} />
          <text className="axis-label" x={labelX} y={y(tick) + 4} text-anchor="end">
            {tick}
          </text>
        </g>
      ))}
      <text className="axis-label axis-unit" x={labelX} y={y(domainMaxC) - 13} text-anchor="end">
        {unit}
      </text>
    </g>
  )
}

/**
 * The shared x-axis: ticks on ROUND time intervals rather than on fractions of the duration, a
 * caption centred under them, and no gridline at time zero because the plot edge already draws one.
 *
 * `ticks` lets an editor chart hand in a planned set instead - see `planTimeTicks` - so the times
 * the PROFILE actually puts a step or a zone boundary at are labelled, and round fillers only cover
 * what those leave empty. A point label is set brighter and heavier than a filler, because one is a
 * fact about the profile and the other is scaffolding. Omitted, the axis is the plain round one
 * every live and simulated chart has always drawn.
 */
export function TimeAxis({
  x,
  durationSec,
  plotLeft,
  plotRight,
  plotTop,
  plotBottom,
  labelY,
  caption = 'Elapsed (m:ss)',
  ticks,
}: {
  x: (timeSec: number) => number
  durationSec: number
  plotLeft: number
  plotRight: number
  plotTop: number
  plotBottom: number
  labelY: number
  caption?: string
  ticks?: PlannedTimeTick[]
}) {
  const planned: PlannedTimeTick[] = ticks ?? timeAxisTicks(durationSec).map((timeSec) => ({ timeSec, kind: 'filler' }))
  return (
    <g className="time-axis">
      {planned.map((tick) => (
        <g key={`time-${tick.kind}-${tick.timeSec}`}>
          {tick.timeSec > 0 && (
            <line
              className={tick.kind === 'point' ? 'grid-line vertical point-time' : 'grid-line vertical'}
              x1={x(tick.timeSec)}
              x2={x(tick.timeSec)}
              y1={plotTop}
              y2={plotBottom}
            />
          )}
          <text
            className={
              tick.kind === 'point' ? 'axis-label time-axis-label point-time-label' : 'axis-label time-axis-label'
            }
            x={x(tick.timeSec)}
            y={labelY}
            text-anchor="middle"
          >
            {formatClock(tick.timeSec)}
          </text>
        </g>
      ))}
      {/* Centred under the ticks, so it can never land on top of the last one. */}
      <text className="axis-label axis-caption" x={(plotLeft + plotRight) / 2} y={labelY + 17} text-anchor="middle">
        {caption}
      </text>
    </g>
  )
}

/**
 * The right-hand 0-10 actuator axis, for a chart that also carries Fan and Heat levels. The title
 * ends at `titleEndX` (default: just right of the tick labels); a chart with a control in its top-right
 * corner ends it at the plot edge instead, so the two never overlap.
 */
export function ActuatorAxis({
  y,
  x,
  title = 'Fan / Heat 0-10',
  titleEndX = x + 30,
  titleY = 24,
}: {
  y: (level: number) => number
  x: number
  title?: string
  titleEndX?: number
  titleY?: number
}) {
  return (
    <g className="actuator-axis-group">
      {[0, 2, 4, 6, 8, 10].map((tick) => (
        <text className="axis-label actuator-axis" key={`act-${tick}`} x={x} y={y(tick) + 4}>
          {tick}
        </text>
      ))}
      <text className="axis-title actuator-title" x={titleEndX} y={titleY} text-anchor="end">
        {title}
      </text>
    </g>
  )
}

/**
 * The temperature window both charts draw.
 *
 * 50 °C sits below anything a roast meaningfully passes through and below every cooling endpoint the
 * app accepts, so no plot height is spent on temperatures that carry no roasting information - which
 * matters most on a phone. 250 °C gives the trace headroom above the 230 °C top of the reference
 * color band:
 * roasts can pass a 231 °C probe reading, and a ceiling AT the reference top would pin that trace
 * flat against the plot edge. The color strip still ends honestly at 230 -
 * `roastGradient.ts` paints nothing the reference does not describe - so the uncolored headroom
 * itself reads as what it is: temperatures beyond the documented bean-color data.
 * Zone and step fields still ACCEPT values outside the window - the chart clamps what it DRAWS, it
 * does not constrain what may be entered - which is why the scale clamps rather than rejecting.
 */
export const CHART_DOMAIN_C = { minimumC: 50, maximumC: 250 } as const

/** A clamping y-scale over `CHART_DOMAIN_C`, shared so the two charts cannot disagree. */
export const temperatureScale = (topY: number, bottomY: number) => (temperatureC: number) => {
  const { minimumC, maximumC } = CHART_DOMAIN_C
  const value = Number.isFinite(temperatureC) ? temperatureC : minimumC
  const clamped = Math.max(minimumC, Math.min(maximumC, value))
  return bottomY - ((clamped - minimumC) / (maximumC - minimumC)) * (bottomY - topY)
}
