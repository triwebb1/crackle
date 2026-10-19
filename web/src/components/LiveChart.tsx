import type { ComponentChildren } from 'preact'
import { useMemo, useState } from 'preact/hooks'
import { planLegendRows, TEMPERATURE_GUTTER } from '../domain/chartAxis'
import { type LiveJourneyZone, OVERRUN_NOTICE_SEC } from '../domain/liveJourney'
import { formatClock, targetPoints, thermalZoneCompletions, timedDuration } from '../domain/model'
import { axisTicksFrom } from '../domain/roastGradient'
import type { RoastEvent, RoastRun, TelemetrySample, ThermalIntent, TimedProfile } from '../domain/types'
import {
  ActuatorAxis,
  CHART_DOMAIN_C,
  RoastColorStrip,
  RoastGradientDefs,
  TemperatureAxis,
  TimeAxis,
  temperatureScale,
} from './RoastColorScale'
import { useChartWidth } from './useChartWidth'

interface LiveChartProps {
  samples: TelemetrySample[]
  /** A timed profile draws its PLANNED fan and heat lanes. It never draws a temperature target. */
  profile?: TimedProfile
  /** A temperature journey draws its target line. It never draws planned actuator lanes. */
  targetIntent?: ThermalIntent
  overlay?: RoastRun
  events: RoastEvent[]
  elapsedSec: number
  /** Whether the latest measured point should pulse as the live current reading. */
  active?: boolean
  /** Charting options belong to the chart, not to the roast. Rendered in the chart's own toolbar. */
  toolbar?: ComponentChildren
  /** A simulated chart predicts; a live one records. The legend must not claim the wrong one. */
  temperatureLabel?: string
  /**
   * The zones as the roast has actually experienced them, from `liveJourneyControl`. Supplying them
   * switches the chart into the overrun rendering described below: the nominal curve is drawn where
   * the profile drew it and the STRETCH is drawn as its own explicit measurement.
   */
  journeyZones?: LiveJourneyZone[]
  /** The stretched in-zone target the controller is chasing right now. */
  zoneTargetSegment?: Array<{ timeSec: number; temperatureC: number }>
  /**
   * What to call that line in the legend. A live roast is chasing one zone's ramp at this instant;
   * a finished simulation draws the whole path it held, and "now" would be a lie about it.
   */
  zoneTargetLabel?: string
  /**
   * The chart has no adjusted schedule to show (a stored roast keeps no live zone tuple), so the
   * journey plan is drawn once, keyed "Plan", instead of an adjusted line identical to the original.
   */
  planOnly?: boolean
  ariaLabel?: string
}

const HEIGHT = 480
// The left gutter carries three things in three lanes that never overlap: right-aligned tick labels
// ending at 40, the axis rule and its outward ticks at 41-46, and the bean-color strip at 54-65.
const plot = { left: TEMPERATURE_GUTTER.plotLeft, right: 76, top: 42, bottom: 410 }

export interface ChartHoverPoint {
  timeSec: number
  temperatureC: number
  x: number
  y: number
}

/** Convert one pointer position into clamped chart coordinates; outside the plot has no readout. */
export const chartHoverPoint = (
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  viewWidth: number,
  durationSec: number,
  plotTop: number = plot.top,
): ChartHoverPoint | undefined => {
  if (rect.width <= 0 || rect.height <= 0 || durationSec <= 0) return undefined
  const pointX = ((clientX - rect.left) / rect.width) * viewWidth
  const pointY = ((clientY - rect.top) / rect.height) * HEIGHT
  const right = viewWidth - plot.right
  if (pointX < plot.left || pointX > right || pointY < plotTop || pointY > plot.bottom) return undefined
  const timeSec = ((pointX - plot.left) / (right - plot.left)) * durationSec
  const temperatureC =
    CHART_DOMAIN_C.maximumC -
    ((pointY - plotTop) / (plot.bottom - plotTop)) * (CHART_DOMAIN_C.maximumC - CHART_DOMAIN_C.minimumC)
  return { timeSec, temperatureC, x: pointX, y: pointY }
}

const pathFor = (points: Array<{ x: number; y: number }>) =>
  points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')

/** A signed clock. An overrun and an early arrival are different findings and must not read alike. */
const signedClock = (seconds: number) => `${seconds < 0 ? '-' : '+'}${formatClock(Math.abs(seconds))}`
export interface ZoneOverrunWindow {
  expectedEndSec: number
  toSec: number
  delaySec: number
}

/**
 * Compare a zone's actual elapsed duration with its authored duration.
 *
 * The bar ends at attainment; failing that, at the extent the zone's own author reported - a
 * device-read zone carries its entry AND its measured duration on the ROASTER's clock - and only a
 * zone that reports no extent at all falls back to the chart's elapsed clock. The distinction
 * matters after the roast: the chart's elapsed follows the trace's last sample, which, once the
 * stored recording has been read back, is the end of the cooling tail - and a zone the roast was
 * stopped in must not be drawn as overrunning across that tail.
 */
export const zoneOverrunWindow = (zone: LiveJourneyZone, elapsedSec: number): ZoneOverrunWindow | undefined => {
  if (zone.entrySec === undefined) return undefined
  const expectedEndSec = zone.entrySec + Math.max(0, zone.nominalDurationSec)
  const reportedEndSec =
    zone.attainedSec ?? (zone.actualDurationSec !== undefined ? zone.entrySec + zone.actualDurationSec : undefined)
  const toSec = Math.max(zone.entrySec, reportedEndSec ?? elapsedSec)
  const delaySec = toSec - expectedEndSec
  return delaySec >= OVERRUN_NOTICE_SEC ? { expectedEndSec, toSec, delaySec } : undefined
}

const KEY_FONT_UNITS = 12
const KEY_GAP_UNITS = 20
/** Leading for a legend that has had to wrap. One line of keys plus a hair. */
const KEY_ROW_UNITS = 16
/** Baseline of the first legend row, under the axis titles at 24. */
const LEGEND_BASELINE = 44

export function LiveChart({
  samples,
  profile,
  targetIntent,
  overlay,
  events,
  elapsedSec,
  active = false,
  toolbar,
  temperatureLabel = 'Actual',
  journeyZones,
  zoneTargetSegment,
  zoneTargetLabel = 'Adjusted plan',
  planOnly = false,
  ariaLabel = 'Live roast graph',
}: LiveChartProps) {
  /**
   * How many user units wide this chart is drawn in. On anything desktop-sized it is the 1000 it
   * has always been; on a phone it is fewer, which is what keeps the labels and traces at a size
   * worth reading instead of scaling the whole instrument down by two thirds. See `chartAxis.ts`.
   */
  const WIDTH = useChartWidth()
  const [hover, setHover] = useState<ChartHoverPoint>()
  const xMax = WIDTH - plot.right
  /**
   * One rule decides what this chart draws, and it is the selected profile's strategy.
   *
   * A timed profile charts its planned Fan and Heat lanes plus whatever temperature was actually
   * measured. A temperature journey charts its target line. A separately-resolved goal journey
   * could leave a previous journey's target line on the plot after a timed profile is selected,
   * with nothing on screen explaining where it came from. Deriving both from the same `profile`
   * prop is what makes a stale trace impossible rather than unlikely.
   */
  const journey = profile ? undefined : targetIntent
  /*
   * The goal line is the NOMINAL plan, always, on every chart that draws one.
   *
   * It is never re-anchored to measured zone completions, so the live chart and the simulation draw
   * the plan the same way. When a zone overruns, the target curve stays and the extra time is shown
   * separately: a goal that slides under the roast hides exactly the fact being reported. What the controller is currently chasing is a different line and is drawn
   * as one - see `zoneTargetSegment`.
   */
  const idealTarget = useMemo(() => (journey ? targetPoints(journey) : []), [journey])
  const adjustedTarget = zoneTargetSegment ?? idealTarget
  // Legacy marker source, used only when the caller has not run the control law for us.
  const completions = useMemo(
    () => (journey && journeyZones === undefined ? thermalZoneCompletions(journey, samples) : []),
    [journey, journeyZones, samples],
  )
  const plannedPoints = useMemo(
    () => (profile ? [...profile.points].sort((a, b) => a.timeSec - b.timeSec) : []),
    [profile],
  )

  const zones = journey ? (journeyZones ?? []) : []
  const lastZoneSec = zones.reduce((latest, zone) => Math.max(latest, zone.attainedSec ?? zone.entrySec ?? 0), 0)
  const duration = Math.max(
    profile ? timedDuration(profile) : 0,
    idealTarget.at(-1)?.timeSec ?? 0,
    overlay?.samples.at(-1)?.elapsedSec ?? 0,
    zoneTargetSegment?.at(-1)?.timeSec ?? 0,
    lastZoneSec,
    elapsedSec,
    60,
  )
  const hasOverruns = zones.some((zone) => zoneOverrunWindow(zone, elapsedSec) !== undefined)
  /**
   * The legend, built from what is actually on the plot.
   *
   * A timed profile has no planned TEMPERATURE curve, only planned Fan and Heat lanes, so a fixed
   * "dashed = planned" legend would describe a line that is not there. The key is derived from the
   * same conditions the traces are, so a legend entry for a line that is not drawn is
   * unrepresentable. Positions follow from the label
   * widths rather than from hand-tuned offsets, for the same reason.
   */
  const keys = [
    { className: 'bt-key', label: temperatureLabel },
    ...(journey && planOnly ? [{ className: 'target-key', label: 'Plan' }] : []),
    ...(journey && !planOnly
      ? [
          { className: 'target-key', label: zoneTargetLabel },
          { className: 'ideal-target-key', label: 'Original plan' },
        ]
      : []),
    ...(hasOverruns ? [{ className: 'overrun-key', label: 'Zone overrun' }] : []),
    ...(overlay ? [{ className: 'overlay-key', label: 'Comparison' }] : []),
    { className: 'fan-key', label: 'Fan' },
    { className: 'heat-key', label: 'Heat' },
    // A timed profile's only dashed plan is its actuator lanes, so that is what the key names.
    ...(profile ? [{ className: 'planned-key', label: 'dashed = planned Fan / Heat' }] : []),
  ]
  /*
   * ...and it wraps. One line from a fixed origin only works at one width: a journey mid-overrun
   * with a comparison loaded carries seven keys, and seven keys are wider than the plot on a phone. `planLegendRows` measures them
   * against the room there actually is - and on a desktop nothing wraps, because the widest legend
   * the chart can produce still fits one line there.
   */
  const placedKeys = planLegendRows(keys, xMax - plot.left - 8, {
    fontUnits: KEY_FONT_UNITS,
    gapUnits: KEY_GAP_UNITS,
    rowUnits: KEY_ROW_UNITS,
  })

  // The legend has its own band between the axis titles and the plot, so no trace runs under it
  // (Fan at 10 and the 250 °C line both sit on the plot's top edge). Each wrapped row on a narrow
  // chart lowers the plot top by one row.
  const legendRows = (placedKeys.at(-1)?.y ?? 0) / KEY_ROW_UNITS + 1
  const plotTop = LEGEND_BASELINE + (legendRows - 1) * KEY_ROW_UNITS + 12

  const x = (time: number) => plot.left + (time / duration) * (xMax - plot.left)
  const tempY = useMemo(() => temperatureScale(plotTop, plot.bottom), [plotTop])
  const actuatorY = (value: number) => plot.bottom - (Math.max(0, Math.min(10, value)) / 10) * (plot.bottom - plotTop)
  const scale = {
    gradientId: 'live-roast-color',
    y: tempY,
    domainMinC: CHART_DOMAIN_C.minimumC,
    domainMaxC: CHART_DOMAIN_C.maximumC,
  }

  // A planned lane is a step function: the level holds until the next point moves it.
  const plannedPath = (channel: 'fan' | 'heat') =>
    plannedPoints.length === 0
      ? ''
      : plannedPoints
          .map(
            (point, index) =>
              `${index === 0 ? 'M' : 'L'} ${x(point.timeSec).toFixed(1)} ${actuatorY(point[channel]).toFixed(1)} H ${x(index < plannedPoints.length - 1 ? plannedPoints[index + 1].timeSec : duration).toFixed(1)}`,
          )
          .join(' ')

  // Every trace is rebuilt together, so none can survive a change to what the chart is showing.
  const traces = useMemo(
    () => ({
      temperature: pathFor(samples.map((sample) => ({ x: x(sample.elapsedSec), y: tempY(sample.beanTempC) }))),
      idealTarget: pathFor(idealTarget.map((point) => ({ x: x(point.timeSec), y: tempY(point.temperatureC) }))),
      fan: pathFor(samples.map((sample) => ({ x: x(sample.elapsedSec), y: actuatorY(sample.effectiveFan) }))),
      heat: pathFor(samples.map((sample) => ({ x: x(sample.elapsedSec), y: actuatorY(sample.effectiveHeat) }))),
      overlay: overlay
        ? pathFor(overlay.samples.map((sample) => ({ x: x(sample.elapsedSec), y: tempY(sample.beanTempC) })))
        : '',
      plannedFan: plannedPath('fan'),
      plannedHeat: plannedPath('heat'),
      adjustedTarget: pathFor(adjustedTarget.map((point) => ({ x: x(point.timeSec), y: tempY(point.temperatureC) }))),
      // WIDTH is a dependency because every one of these paths is built through `x`, which scales
      // with it. Leaving it out is how a chart ends up drawing the previous viewport's traces.
    }),
    [WIDTH, adjustedTarget, duration, idealTarget, overlay, plannedPoints, samples, tempY],
  )

  // 50° majors: the 50-250 domain lands a tick on both of its own ends, and five labels is what a
  // phone-width axis can carry without crowding the color strip.
  const temperatureTicks = axisTicksFrom(CHART_DOMAIN_C.minimumC, CHART_DOMAIN_C.maximumC, 50)
  const last = samples.at(-1)

  /*
   * ==========================================================================================
   * ZONE OVERRUN - the plan stays put and the extra time is drawn as a measurement
   * ==========================================================================================
   *
   * When a zone takes longer to complete, the target curve stays and the extra time must be obvious
   * at a glance - for example when zone 2 takes 3 minutes longer than the profile expected.
   *
   * Four marks, in three colours from the channel palette, and each one says exactly one thing:
   *
   *   - the **nominal goal curve** (Goal green, dashed) stays where the profile drew it, and its
   *     zone endpoints keep their nodes. That is the PLANNED boundary marker;
   *   - the **actual attainment marker** (Bean yellow) sits where the measured trace crossed that
   *     endpoint, which is on the actual trace by construction;
   *   - from actual zone entry to actual attainment, at the zone's own end temperature, an
   *     **overrun bar** (Heat orange). A middle tick marks where the authored duration expired, so
   *     the segment after that tick is the extra time;
   *   - and the bar is **labelled in words** - "Zone 2 +3:05" - because a reader should not have to
   *     measure it.
   *
   * A zone that runs on time draws none of this: below `OVERRUN_NOTICE_SEC` there is no bar, no cap
   * and no label, and the chart is exactly what it was. A zone still running long carries the same
   * bar out to the current time with an open cap and "and counting", because an overrun in progress
   * is the one a roaster can still do something about.
   */
  const overruns = zones.flatMap((zone) => {
    const window = zoneOverrunWindow(zone, elapsedSec)
    if (!window) return []
    // "And counting" is a claim about NOW: only the zone the active roast is in can still grow. A
    // zone the roast was stopped in is unattained too, but its overrun is a finished measurement.
    const running = zone.current && active && !zone.attained
    return [
      {
        key: zone.zoneId,
        y: tempY(zone.endC),
        expectedX: x(window.expectedEndSec),
        toX: x(window.toSec),
        running,
        label: `Zone ${zone.index + 1} ${signedClock(Math.round(window.delaySec))}${running ? ' and counting' : ''}`,
      },
    ]
  })
  return (
    <div className="chart-shell" role="figure" aria-label={ariaLabel}>
      {toolbar && <div className="chart-toolbar">{toolbar}</div>}
      <svg
        className="live-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Bean temperature with Fan and Heat over time"
        onPointerMove={(event) =>
          setHover(
            chartHoverPoint(
              event.clientX,
              event.clientY,
              event.currentTarget.getBoundingClientRect(),
              WIDTH,
              duration,
              plotTop,
            ),
          )
        }
        onPointerLeave={() => setHover(undefined)}
      >
        <rect className="chart-bg" width={WIDTH} height={HEIGHT} />
        <RoastGradientDefs {...scale} />
        <text className="axis-title" x={plot.left} y="24">
          {temperatureLabel === 'Actual' ? 'Bean temperature (°C)' : 'Predicted bean temperature (°C)'}
        </text>
        {temperatureTicks.map((tick) => (
          <line key={`temp-${tick}`} className="grid-line" x1={plot.left} x2={xMax} y1={tempY(tick)} y2={tempY(tick)} />
        ))}
        <TemperatureAxis {...scale} ticks={temperatureTicks} />
        <RoastColorStrip {...scale} />
        <ActuatorAxis y={actuatorY} x={xMax + 9} />
        <TimeAxis
          x={x}
          durationSec={duration}
          plotLeft={plot.left}
          plotRight={xMax}
          plotTop={plotTop}
          plotBottom={plot.bottom}
          labelY={438}
        />
        {overlay && <path className="trace overlay-trace" d={traces.overlay} />}
        {/* Planned lanes for a timed profile: what the program will ask for, before anything runs. */}
        {profile && (
          <>
            <path className="trace planned-trace fan-trace" d={traces.plannedFan} />
            <path className="trace planned-trace heat-trace" d={traces.plannedHeat} />
          </>
        )}
        {journey && !planOnly && <path className="trace ideal-target-trace" d={traces.idealTarget} />}
        {journey && <path className="trace target-trace" d={traces.adjustedTarget} />}
        {journey &&
          idealTarget.slice(1).map((point, index) => (
            <circle
              key={`goal-${index}`}
              className="ideal-target-node"
              cx={x(point.timeSec)}
              cy={tempY(point.temperatureC)}
              r="4"
            >
              <title>{`Zone ${index + 1} original boundary: ${point.temperatureC} °C at ${formatClock(point.timeSec)}`}</title>
            </circle>
          ))}
        {overruns.map((overrun) => (
          <g key={`overrun-${overrun.key}`} className={overrun.running ? 'zone-overrun running' : 'zone-overrun'}>
            <line className="zone-overrun-bar" x1={overrun.expectedX} x2={overrun.toX} y1={overrun.y} y2={overrun.y} />
            <line
              className="zone-overrun-cap"
              x1={overrun.expectedX}
              x2={overrun.expectedX}
              y1={overrun.y - 8}
              y2={overrun.y + 8}
            />
            <line
              className="zone-overrun-cap"
              x1={overrun.toX}
              x2={overrun.toX}
              y1={overrun.y - 8}
              y2={overrun.y + 8}
            />
            <text
              className="zone-overrun-label"
              x={(overrun.expectedX + overrun.toX) / 2}
              y={overrun.y - 13}
              text-anchor="middle"
            >
              {overrun.label}
            </text>
          </g>
        ))}
        <path className="trace bt-trace" d={traces.temperature} />
        {completions.map((completion) => (
          <circle
            key={`actual-${completion.zoneId}`}
            className="actual-zone-node"
            cx={x(completion.elapsedSec)}
            cy={tempY(completion.temperatureC)}
            r="6"
          >
            <title>{`Zone ${completion.zoneIndex + 1} completed at ${Math.round(completion.elapsedSec)} seconds`}</title>
          </circle>
        ))}
        {zones
          .filter((zone) => zone.attainedSec !== undefined)
          .map((zone) => (
            <circle
              key={`attained-${zone.zoneId}`}
              className="actual-zone-node"
              cx={x(zone.attainedSec as number)}
              cy={tempY(zone.endC)}
              r="6"
            >
              <title>{`Zone ${zone.index + 1} reached ${zone.endC} °C at ${formatClock(zone.attainedSec as number)}, planned ${formatClock(zone.plannedEndSec)} (${signedClock(Math.round(zone.overrunSec ?? 0))})`}</title>
            </circle>
          ))}
        <path className="trace fan-trace live-actuator-trace" d={traces.fan} />
        <path className="trace heat-trace live-actuator-trace" d={traces.heat} />
        {events
          .filter((event) => ['DROP', 'ABORT'].includes(event.type))
          .map((event) => (
            <g key={event.id}>
              <line
                className="event-line"
                x1={x(event.elapsedSec)}
                x2={x(event.elapsedSec)}
                y1={plotTop}
                y2={plot.bottom}
              />
              <text className="event-label" x={x(event.elapsedSec) + 6} y={plotTop + 14}>
                {event.label}
              </text>
            </g>
          ))}
        {elapsedSec > 0 && (
          <line className="time-cursor" x1={x(elapsedSec)} x2={x(elapsedSec)} y1={plotTop} y2={plot.bottom} />
        )}
        {hover && (
          <g className="chart-crosshair" aria-hidden="true">
            <line className="chart-crosshair-line" x1={hover.x} x2={hover.x} y1={plotTop} y2={plot.bottom} />
            <line className="chart-crosshair-line" x1={plot.left} x2={xMax} y1={hover.y} y2={hover.y} />
            <rect
              className="chart-crosshair-chip"
              x={Math.max(plot.left, Math.min(xMax - 58, hover.x - 29))}
              y={plot.bottom + 6}
              width="58"
              height="20"
              rx="3"
            />
            <text
              className="chart-crosshair-value"
              x={Math.max(plot.left + 29, Math.min(xMax - 29, hover.x))}
              y={plot.bottom + 21}
              text-anchor="middle"
            >
              {formatClock(Math.round(hover.timeSec))}
            </text>
            <rect
              className="chart-crosshair-chip"
              x={plot.left - 56}
              y={Math.max(plotTop, Math.min(plot.bottom - 20, hover.y - 10))}
              width="52"
              height="20"
              rx="3"
            />
            <text
              className="chart-crosshair-value"
              x={plot.left - 8}
              y={Math.max(plotTop + 15, Math.min(plot.bottom - 5, hover.y + 5))}
              text-anchor="end"
            >
              {hover.temperatureC.toFixed(1)} °C
            </text>
          </g>
        )}
        <g className="trace-key" transform={`translate(${plot.left} ${LEGEND_BASELINE})`}>
          {placedKeys.map((key) => (
            <text key={key.label} className={`key ${key.className}`} x={key.x} y={key.y}>
              {key.label}
            </text>
          ))}
        </g>
        {last && (
          <circle
            className={active ? 'last-dot bt-dot live' : 'last-dot bt-dot'}
            cx={x(last.elapsedSec)}
            cy={tempY(last.beanTempC)}
            r="4"
          />
        )}
      </svg>
    </div>
  )
}
