import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { starterProfile, starterThermalIntent } from '../data/demo'
import { estimatedTextWidth, TEMPERATURE_GUTTER, timeAxisTicks } from '../domain/chartAxis'
import { deviceJourneyChartState } from '../domain/liveJourney'
import { axisTicksFrom, roastGradientStops } from '../domain/roastGradient'
import type { ThermalSegment } from '../domain/types'
import { chartHoverPoint, LiveChart, zoneOverrunWindow } from './LiveChart'
import { CHART_DOMAIN_C, temperatureScale } from './RoastColorScale'

const render = (props: Partial<Parameters<typeof LiveChart>[0]> = {}) =>
  renderToStaticMarkup(createElement(LiveChart, { samples: [], events: [], elapsedSec: 0, ...props }))

describe('zone overrun chart placement', () => {
  const laterDelayedZone = {
    index: 1,
    zoneId: 'z2',
    role: 'controlled' as const,
    startC: 150,
    endC: 175,
    nominalDurationSec: 120,
    plannedStartSec: 210,
    plannedEndSec: 330,
    entrySec: 300,
    attainedSec: 515,
    actualDurationSec: 215,
    overrunSec: 95,
    attained: true,
    current: false,
  }

  it('measures a delayed zone from its actual entry and authored duration', () => {
    expect(zoneOverrunWindow(laterDelayedZone, 515)).toEqual({
      expectedEndSec: 420,
      toSec: 515,
      delaySec: 95,
    })
  })

  it('omits per-zone overruns below the notice threshold', () => {
    expect(zoneOverrunWindow({ ...laterDelayedZone, attainedSec: 434 }, 434)).toBeUndefined()
  })

  it('omits a zone the roast has not entered', () => {
    expect(
      zoneOverrunWindow(
        {
          ...laterDelayedZone,
          entrySec: undefined,
          attainedSec: undefined,
          actualDurationSec: undefined,
          overrunSec: undefined,
          attained: false,
        },
        500,
      ),
    ).toBeUndefined()
  })
  it('extends a running zone from actual entry to the current roast clock', () => {
    expect(
      zoneOverrunWindow(
        {
          ...laterDelayedZone,
          attained: false,
          attainedSec: undefined,
          actualDurationSec: undefined,
          overrunSec: undefined,
        },
        500,
      ),
    ).toEqual({
      expectedEndSec: 420,
      toSec: 500,
      delaySec: 80,
    })
  })

  it('is independent of edited plan timestamps and handles consecutive descending zones', () => {
    const descending = [
      {
        ...laterDelayedZone,
        zoneId: 'z3',
        startC: 180,
        endC: 160,
        plannedStartSec: 10,
        plannedEndSec: 20,
      },
      {
        ...laterDelayedZone,
        index: 2,
        zoneId: 'z4',
        startC: 160,
        endC: 140,
        nominalDurationSec: 60,
        plannedStartSec: 999,
        plannedEndSec: 1999,
        entrySec: 515,
        attainedSec: 610,
        actualDurationSec: 95,
        overrunSec: 35,
      },
    ]
    expect(descending.map((zone) => zoneOverrunWindow(zone, 610))).toEqual([
      { expectedEndSec: 420, toSec: 515, delaySec: 95 },
      { expectedEndSec: 575, toSec: 610, delaySec: 35 },
    ])
  })

  it('draws only the overrun interval, with one cap at each end', () => {
    const markup = render({ journeyZones: [laterDelayedZone], targetIntent: starterThermalIntent, elapsedSec: 515 })
    expect(markup.match(/zone-overrun-bar/g)).toHaveLength(1)
    expect(markup.match(/zone-overrun-cap/g)).toHaveLength(2)
  })

  /*
   * A recorded five-zone journey's plan and attainments (see `liveJourney.test.ts`), through the
   * chart itself: the bars are drawn from the ROASTER's clock carried on each zone row, not from the
   * browser trace's last sample - which after the roast is the end of the cooling tail.
   */
  const fiveZoneSegments: ThermalSegment[] = [
    { id: 'z1', startC: 28.8, endC: 150, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z2', startC: 150, endC: 180, durationSec: 60, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z3', startC: 180, endC: 215, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z4', startC: 215, endC: 233, durationSec: 60, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z5', startC: 233, endC: 60, durationSec: 15, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
  ]
  const fiveZoneIntent = { ...starterThermalIntent, id: 'j39', segments: fiveZoneSegments }
  const fiveZoneRoast = (
    elapsedSec: number,
    zoneAttainedSec: Array<number | null>,
    ended?: 'stopped' | 'completed',
  ) => {
    const zoneIndex = Math.min(4, zoneAttainedSec.filter((at) => at !== null).length)
    return {
      active: ended === undefined,
      mode: 'journey' as const,
      planRev: 1,
      sessionId: '39',
      elapsedSec,
      zoneIndex,
      zoneEntrySec: zoneIndex === 0 ? 0 : (zoneAttainedSec[zoneIndex - 1] as number),
      zoneAttainedSec,
      saturated: false,
      holdover: false,
      ...(ended ? { endReason: ended } : {}),
    }
  }

  it('recorded journey at 6:40 - zone 3 overrunning: the bar runs from its nominal end to now, and counting', () => {
    const chart = deviceJourneyChartState(fiveZoneSegments, fiveZoneRoast(400, [170, 262, null, null, null]))
    expect(zoneOverrunWindow(chart.zones[2], 400)).toEqual({ expectedEndSec: 382, toSec: 400, delaySec: 18 })
    const markup = render({
      journeyZones: chart.zones,
      zoneTargetSegment: chart.targetPath,
      targetIntent: fiveZoneIntent,
      elapsedSec: 400,
      active: true,
    })
    expect(markup).toContain('Zone 1 +0:50')
    expect(markup).toContain('Zone 2 +0:32')
    expect(markup).toContain('Zone 3 +0:18 and counting')
    expect(markup.match(/zone-overrun-bar/g)).toHaveLength(3)
    expect(markup.match(/zone-overrun running/g)).toHaveLength(1)
  })

  it('recorded journey at 7:00 - zone 3 attained at 6:51: its bar terminates there and stops counting', () => {
    const chart = deviceJourneyChartState(fiveZoneSegments, fiveZoneRoast(420, [170, 262, 411, null, null]))
    expect(zoneOverrunWindow(chart.zones[2], 420)).toEqual({ expectedEndSec: 382, toSec: 411, delaySec: 29 })
    expect(zoneOverrunWindow(chart.zones[3], 420)).toBeUndefined()
    const markup = render({
      journeyZones: chart.zones,
      zoneTargetSegment: chart.targetPath,
      targetIntent: fiveZoneIntent,
      elapsedSec: 420,
      active: true,
    })
    expect(markup).toContain('Zone 3 +0:29')
    expect(markup).not.toContain('and counting')
    expect(markup.match(/zone-overrun-bar/g)).toHaveLength(3)
  })

  it('measures a zone the roast was stopped in to the roaster final clock, never to the trace tail', () => {
    // Stopped at 6:40 in zone 3. The trace later carries the whole cooling tail (to 18:48 here).
    const chart = deviceJourneyChartState(fiveZoneSegments, fiveZoneRoast(400, [170, 262, null, null, null], 'stopped'))
    expect(zoneOverrunWindow(chart.zones[2], 1128)).toEqual({ expectedEndSec: 382, toSec: 400, delaySec: 18 })
    const markup = render({
      journeyZones: chart.zones,
      zoneTargetSegment: chart.targetPath,
      targetIntent: fiveZoneIntent,
      elapsedSec: 1128,
      active: false,
    })
    expect(markup).toContain('Zone 3 +0:18')
    expect(markup).not.toContain('and counting')
    expect(markup.match(/zone-overrun running/g)).toBeNull()
  })

  it('recorded journey completed at 15:49 - the cooling zone overrun is a finished measurement to its attainment', () => {
    const chart = deviceJourneyChartState(fiveZoneSegments, fiveZoneRoast(949, [170, 262, 411, 471, 949], 'completed'))
    expect(zoneOverrunWindow(chart.zones[4], 1128)).toEqual({ expectedEndSec: 486, toSec: 949, delaySec: 463 })
    const markup = render({
      journeyZones: chart.zones,
      zoneTargetSegment: chart.targetPath,
      targetIntent: fiveZoneIntent,
      elapsedSec: 1128,
      active: false,
    })
    expect(markup).toContain('Zone 5 +7:43')
    expect(markup).not.toContain('and counting')
  })
})
describe('the chart temperature domain', () => {
  const y = temperatureScale(32, 262)

  it('maps the domain ends to the plot ends', () => {
    expect(y(CHART_DOMAIN_C.maximumC)).toBe(32)
    expect(y(CHART_DOMAIN_C.minimumC)).toBe(262)
    // The 50-250 domain: 150 °C is exactly halfway up the plot.
    expect(y(150)).toBeCloseTo(147, 5)
  })

  /** Roasts can pass a 231 °C probe reading; the chart must have real headroom above it. */
  it('draws past 231 °C instead of pinning the trace to the ceiling', () => {
    expect(CHART_DOMAIN_C.maximumC).toBe(250)
    expect(y(231)).toBeGreaterThan(32)
    expect(y(231)).toBeLessThan(y(220))
  })

  /**
   * Zone and step fields still ACCEPT anything; the editor must not reject an entry because the chart
   * cannot draw it. The chart clamps what it DRAWS, which is a different question.
   */
  it('clamps rather than rejecting values outside the window', () => {
    expect(y(0)).toBe(262)
    expect(y(49.9)).toBe(262)
    expect(y(400)).toBe(32)
    expect(y(Number.NaN)).toBe(262)
  })

  it('never returns a coordinate outside the plot, for any input', () => {
    for (const value of [-500, 0, 50, 150, 230, 231, 10_000]) {
      expect(y(value)).toBeGreaterThanOrEqual(32)
      expect(y(value)).toBeLessThanOrEqual(262)
    }
  })

  /**
   * The strip is painted from the domain floor up to the 230 °C reference top and no further: the
   * reference describes no bean color above 230, so the 20° of headroom stays deliberately unpainted
   * rather than extrapolating a darker brown that is not in the data.
   */
  it('paints the roast color band up to the reference top and leaves the headroom honest', () => {
    const painted = roastGradientStops(CHART_DOMAIN_C.minimumC, CHART_DOMAIN_C.maximumC).filter(
      (stop) => stop.opacity > 0,
    )
    expect(painted[0].position).toBe(0)
    expect(painted[painted.length - 1].temperatureC).toBe(230)
    expect(painted[painted.length - 1].position).toBeCloseTo(0.9, 5)
  })
})

/**
 * The regression this file exists for.
 *
 * Checking only the coordinates we CHOSE - "the strip starts after the rule" - can pass while the
 * browser draws the strip on top of the labels. Two things make such a check measure something
 * that never happens:
 *
 * 1. A label is a BOX, not a point. Its anchor can clear everything while its text does not.
 * 2. Preact writes SVG attributes verbatim through `setAttribute`, so `textAnchor` reaches the DOM
 *    as an attribute SVG does not recognise, and the label falls back to `text-anchor: start` -
 *    growing RIGHT from its anchor, through the axis rule and into the strip. Only
 *    `preact-render-to-string` converts the camelCase form, so an SSR assertion sees right-aligned
 *    labels the browser never has. Every SVG presentation attribute is written dashed, and this
 *    asserts that in the markup as well as measuring the box.
 */
describe('the left gutter, measured as boxes rather than as anchors', () => {
  const { labelX, labelFontSize, tickLength, ruleX, stripX, stripWidth, plotLeft } = TEMPERATURE_GUTTER
  // The widest label either chart can produce: three digits at the axis font size.
  const widest = estimatedTextWidth('230', labelFontSize)

  it('clears the widest label of the viewBox edge', () => {
    expect(labelX - widest).toBeGreaterThan(6)
  })

  it('keeps the whole label box left of the ticks, the rule, and the strip', () => {
    expect(labelX).toBeLessThan(ruleX - tickLength)
    expect(labelX).toBeLessThan(stripX - 1)
  })

  it('keeps every lane clear of the next with room to spare', () => {
    expect(ruleX - tickLength - labelX).toBeGreaterThanOrEqual(6)
    expect(stripX - 1 - ruleX).toBeGreaterThanOrEqual(6)
    expect(plotLeft - (stripX + stripWidth + 1)).toBeGreaterThanOrEqual(6)
  })

  it('keeps the strip narrow enough to read as a scale rather than a slab', () => {
    expect(stripWidth).toBeGreaterThanOrEqual(8)
    expect(stripWidth).toBeLessThanOrEqual(12)
  })

  for (const [name, markup] of Object.entries({
    'timed profile': render({ profile: starterProfile }),
    'temperature journey': render({ targetIntent: starterThermalIntent }),
  })) {
    it(`writes SVG presentation attributes in a form the DOM accepts, on the ${name} chart`, () => {
      expect(markup).not.toContain('textAnchor')
      expect(markup).not.toContain('strokeDasharray')
      expect(markup).not.toContain('stopColor')
      expect(markup).toContain('text-anchor="end"')
    })

    it(`anchors every tick label exactly where the gutter says, on the ${name} chart`, () => {
      const anchors = [...markup.matchAll(/<text class="axis-label" x="([\d.]+)"[^>]*text-anchor="end"/g)].map(
        (match) => Number(match[1]),
      )
      expect(anchors.length).toBeGreaterThanOrEqual(5)
      for (const anchor of anchors) expect(anchor).toBe(labelX)
    })

    it(`draws the strip and the plot clear of the label boxes, on the ${name} chart`, () => {
      const band = /<rect class="roast-color-band" x="([\d.]+)" [^>]*width="([\d.]+)"/.exec(markup)!
      expect(Number(band[1]) - 1).toBeGreaterThan(labelX)
      const title = /<text class="axis-title" x="([\d.]+)"/.exec(markup)!
      expect(Number(title[1])).toBeGreaterThanOrEqual(Number(band[1]) + Number(band[2]) + 1)
    })
  }
})

/**
 * Ticks on round intervals, not on fractions of the duration. Fifths of 13:15 give 2:39 and 5:18 -
 * correct numbers nobody can read a chart against.
 */
describe('time axis ticks', () => {
  it('chooses a round interval and lands on it', () => {
    expect(timeAxisTicks(600)).toEqual([0, 120, 240, 360, 480, 600])
    expect(timeAxisTicks(300)).toEqual([0, 60, 120, 180, 240, 300])
    expect(timeAxisTicks(60)).toEqual([0, 10, 20, 30, 40, 50, 60])
  })

  it('never produces a tick at a time nobody thinks in', () => {
    for (const duration of [45, 90, 200, 417, 795, 1234, 3600, 7200]) {
      const ticks = timeAxisTicks(duration)
      expect(ticks.length).toBeGreaterThanOrEqual(2)
      expect(ticks.length).toBeLessThanOrEqual(8)
      for (const tick of ticks) expect(Number.isInteger(tick / 5)).toBe(true)
    }
  })

  it('starts at zero, stays inside the duration, and survives a degenerate one', () => {
    const ticks = timeAxisTicks(417)
    expect(ticks[0]).toBe(0)
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(417)
    expect(timeAxisTicks(0)).toEqual([0])
    expect(timeAxisTicks(Number.NaN)).toEqual([0])
  })

  it('draws no gridline at time zero, because the plot edge already draws one', () => {
    const markup = render({ profile: starterProfile })
    const verticals = [...markup.matchAll(/class="grid-line vertical" x1="([\d.]+)"/g)].map((match) => Number(match[1]))
    expect(verticals.length).toBeGreaterThan(0)
    for (const at of verticals) expect(at).toBeGreaterThan(TEMPERATURE_GUTTER.plotLeft)
  })

  it('captions the time axis under its middle, where no tick can collide with it', () => {
    const markup = render({ profile: starterProfile })
    expect(markup).toContain('class="axis-label axis-caption"')
    const caption = /<text class="axis-label axis-caption" x="([\d.]+)"/.exec(markup)!
    expect(Number(caption[1])).toBeGreaterThan(TEMPERATURE_GUTTER.plotLeft + 100)
  })
})

describe('chart hover crosshair coordinates', () => {
  const rect = { left: 100, top: 50, width: 1000, height: 480 }

  it('reads elapsed time and temperature from the plot', () => {
    const point = chartHoverPoint(555, 276, rect, 1000, 600)!
    expect(point.timeSec).toBeGreaterThan(250)
    expect(point.timeSec).toBeLessThan(350)
    // Halfway down the plot is halfway down the 50-250 domain.
    expect(point.temperatureC).toBeCloseTo(150, 0)
  })

  it('hides outside the plot and rejects degenerate geometry', () => {
    expect(chartHoverPoint(100, 50, rect, 1000, 600)).toBeUndefined()
    expect(chartHoverPoint(555, 276, { ...rect, width: 0 }, 1000, 600)).toBeUndefined()
    expect(chartHoverPoint(555, 276, rect, 1000, 0)).toBeUndefined()
  })
})

describe('the temperature ticks themselves', () => {
  it('ticks both ends of a domain that does not start on a round number', () => {
    expect(axisTicksFrom(50, 230, 30)).toEqual([50, 80, 110, 140, 170, 200, 230])
    expect(axisTicksFrom(50, 230, 0)).toEqual([])
    expect(axisTicksFrom(230, 50, 30)).toEqual([])
  })

  it('gives the live 50-250 domain 50° majors that land on both ends', () => {
    expect(axisTicksFrom(CHART_DOMAIN_C.minimumC, CHART_DOMAIN_C.maximumC, 50)).toEqual([50, 100, 150, 200, 250])
  })
})
