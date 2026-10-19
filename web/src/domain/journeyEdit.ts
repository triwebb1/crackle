import { newId } from './ids'
import type { ThermalSegment } from './types'

/**
 * Zone-boundary arithmetic for the temperature-journey editor.
 *
 * A journey is stored as consecutive zones with a duration each, but it is READ as a path through
 * time and temperature. Every editing gesture on the chart - drag a point, double-click to insert a
 * boundary, append a zone - is a statement about that path, so each one is expressed here as a pure
 * transform on the zone list and the view just calls it. Keeping it out of the component is what
 * makes the gestures testable without a DOM.
 *
 * Continuity is an invariant: zone n+1 starts where zone n ends. Every function returns a list that
 * already satisfies it, so the editor never has to repair one.
 */

/** The shortest a zone may become by dragging. Below this the path stops being readable. */
export const MINIMUM_ZONE_SEC = 5
export const DEFAULT_ZONE_SEC = 120

/**
 * The editing grid.
 *
 * A journey is a plan, not a measurement, and nobody plans a zone that ends at 187.3 °C after
 * 2:37. Snapping on the way IN - before the preview, not after the commit - is what makes the
 * chart, the table and the saved record agree exactly rather than approximately.
 */
export const JOURNEY_TEMPERATURE_SNAP_C = 5
export const JOURNEY_TIME_SNAP_SEC = 15
export const JOURNEY_LEVEL_SNAP = 0.1

export type LimitField = 'fanMin' | 'fanMax' | 'heatMin' | 'heatMax'

/**
 * Set one actuator limit, keeping the pair ordered: dragging a minimum above its maximum pushes the
 * maximum with it rather than storing an inverted range the simulator would have to guess about.
 */
export const orderedLimit = (
  segments: ThermalSegment[],
  id: string,
  field: LimitField,
  level: number,
): Partial<ThermalSegment> => {
  const segment = segments.find((candidate) => candidate.id === id)
  if (!segment) return {}
  const value = Math.max(0, Math.min(10, Math.round(level * 10) / 10))
  if (field === 'fanMin') return { fanMin: value, fanMax: Math.max(value, segment.fanMax) }
  if (field === 'fanMax') return { fanMax: value, fanMin: Math.min(value, segment.fanMin) }
  if (field === 'heatMin') return { heatMin: value, heatMax: Math.max(value, segment.heatMax) }
  return { heatMax: value, heatMin: Math.min(value, segment.heatMin) }
}

export interface JourneyPoint {
  /** 0 is the journey start; n is the end of zone n. */
  index: number
  timeSec: number
  temperatureC: number
}

const relink = (segments: ThermalSegment[]): ThermalSegment[] =>
  segments.map((segment, index) => (index === 0 ? segment : { ...segment, startC: segments[index - 1].endC }))

/** Cumulative zone-end times, with the journey start at 0 in front. */
export const boundaryTimes = (segments: ThermalSegment[]): number[] => {
  const times = [0]
  let total = 0
  for (const segment of segments) {
    total += Math.max(0, segment.durationSec)
    times.push(total)
  }
  return times
}

export const journeyPoints = (segments: ThermalSegment[]): JourneyPoint[] => {
  const times = boundaryTimes(segments)
  if (segments.length === 0) return []
  return [
    { index: 0, timeSec: 0, temperatureC: segments[0].startC },
    ...segments.map((segment, index) => ({ index: index + 1, timeSec: times[index + 1], temperatureC: segment.endC })),
  ]
}

export const journeyDurationSec = (segments: ThermalSegment[]): number =>
  segments.reduce((total, segment) => total + Math.max(0, segment.durationSec), 0)

const roundTemperature = (value: number) => Math.max(0, Math.min(300, Math.round(value * 10) / 10))
const roundTime = (value: number) => Math.max(0, Math.round(value))

/**
 * Drag point `index` to a new time and temperature.
 *
 * Temperature writes to the zone that ends there (and, through `relink`, to the start of the next).
 * Time is a boundary move: the zone before it grows by exactly what the zone after it loses, so
 * everything downstream stays where the operator put it. The last point has no zone after it, so
 * dragging it simply lengthens or shortens the journey. Point 0 has no zone before it and is
 * temperature-only.
 */
export const moveBoundary = (
  segments: ThermalSegment[],
  index: number,
  timeSec: number,
  temperatureC: number,
): ThermalSegment[] => {
  if (segments.length === 0 || index < 0 || index > segments.length) return segments
  const temperature = roundTemperature(temperatureC)
  if (index === 0)
    return relink(segments.map((segment, position) => (position === 0 ? { ...segment, startC: temperature } : segment)))

  const times = boundaryTimes(segments)
  const previousTime = times[index - 1]
  const isLast = index === segments.length
  const nextTime = isLast ? Number.POSITIVE_INFINITY : times[index + 1]
  const lowerBound = previousTime + MINIMUM_ZONE_SEC
  const upperBound = isLast ? Number.POSITIVE_INFINITY : nextTime - MINIMUM_ZONE_SEC
  const target = Math.max(lowerBound, Math.min(upperBound, roundTime(timeSec)))

  const next = segments.map((segment, position) => {
    if (position === index - 1) return { ...segment, endC: temperature, durationSec: target - previousTime }
    if (position === index) return { ...segment, durationSec: nextTime - target }
    return segment
  })
  return relink(next)
}

/**
 * Insert a boundary at a time and temperature inside the journey: the zone containing that time is
 * split in two, so the point lands between the zones that surrounded it and the total duration is
 * unchanged. A click outside the journey, or inside a zone too short to split, is ignored.
 */
export const insertBoundary = (
  segments: ThermalSegment[],
  timeSec: number,
  temperatureC: number,
  id = newId('segment'),
): ThermalSegment[] => {
  if (segments.length === 0) return segments
  const times = boundaryTimes(segments)
  const total = times[times.length - 1]
  const at = roundTime(Math.max(0, Math.min(total, timeSec)))
  // Both halves have to be worth having. A double-click a second away from an existing point would
  // otherwise mint a one-second zone nobody asked for and nobody can see.
  const target = segments.findIndex(
    (_, index) => at - times[index] >= MINIMUM_ZONE_SEC && times[index + 1] - at >= MINIMUM_ZONE_SEC,
  )
  if (target < 0) return segments
  const temperature = roundTemperature(temperatureC)
  const head = { ...segments[target], id: segments[target].id, endC: temperature, durationSec: at - times[target] }
  const tail: ThermalSegment = { ...segments[target], id, startC: temperature, durationSec: times[target + 1] - at }
  return relink([...segments.slice(0, target), head, tail, ...segments.slice(target + 1)])
}

/** The chart's "+" button: a new zone on the end, holding the temperature the journey finished at. */
export const appendZone = (segments: ThermalSegment[], id = newId('segment')): ThermalSegment[] => {
  const last = segments[segments.length - 1]
  const startC = last?.endC ?? 25
  const zone: ThermalSegment = {
    id,
    startC,
    endC: startC,
    durationSec: DEFAULT_ZONE_SEC,
    fanMin: 1,
    fanMax: 10,
    heatMin: 0,
    heatMax: 10,
  }
  return relink([...segments, zone])
}

/** Removing a zone hands its time to the zone before it, so the journey keeps its total length. */
export const removeZone = (segments: ThermalSegment[], id: string): ThermalSegment[] => {
  if (segments.length <= 1) return segments
  const index = segments.findIndex((segment) => segment.id === id)
  if (index < 0) return segments
  const removed = segments[index]
  const remaining = segments.filter((segment) => segment.id !== id)
  const absorber = index === 0 ? 0 : index - 1
  const merged = remaining.map((segment, position) =>
    position === absorber ? { ...segment, durationSec: segment.durationSec + removed.durationSec } : segment,
  )
  return relink(merged)
}

export const updateZone = (segments: ThermalSegment[], id: string, patch: Partial<ThermalSegment>): ThermalSegment[] =>
  relink(segments.map((segment) => (segment.id === id ? { ...segment, ...patch } : segment)))
