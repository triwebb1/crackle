import { timedDuration, valuesAt } from './model'
import type { TimedProfile } from './types'

export const TIMED_POINT_TIME_SNAP_SEC = 5

export interface TimedCoolingSpan {
  startSec: number
  endSec: number
}

/** Contiguous intervals in which the authored timed plan holds Heat at zero. */
export const timedCoolingSpans = (profile: TimedProfile): TimedCoolingSpan[] => {
  const sorted = [...profile.points].sort((left, right) => left.timeSec - right.timeSec)
  const duration = timedDuration(profile)
  const spans: TimedCoolingSpan[] = []
  for (const [index, point] of sorted.entries()) {
    const endSec = index < sorted.length - 1 ? sorted[index + 1].timeSec : duration
    if (point.heat !== 0 || endSec <= point.timeSec) continue
    const previous = spans.at(-1)
    if (previous && previous.endSec === point.timeSec) previous.endSec = endSec
    else spans.push({ startSec: point.timeSec, endSec })
  }
  return spans
}

/**
 * Split the held instruction at a snapped chart position without changing total duration.
 * A duplicate snapped timestamp is a no-op because it would create a zero-second step.
 */
export const insertTimedPoint = (profile: TimedProfile, requestedTimeSec: number, id: string): TimedProfile => {
  const duration = timedDuration(profile)
  const maxSnappedTime = Math.floor(Math.max(0, duration - 1) / TIMED_POINT_TIME_SNAP_SEC) * TIMED_POINT_TIME_SNAP_SEC
  const timeSec = Math.max(
    0,
    Math.min(maxSnappedTime, Math.round(requestedTimeSec / TIMED_POINT_TIME_SNAP_SEC) * TIMED_POINT_TIME_SNAP_SEC),
  )
  if (profile.points.some((point) => point.timeSec === timeSec)) return profile

  const held = valuesAt(profile, timeSec)
  const lastTimeSec = Math.max(0, ...profile.points.map((point) => point.timeSec))
  return {
    ...profile,
    points: [...profile.points, { id, timeSec, fan: held.fan, heat: held.heat }].sort(
      (left, right) => left.timeSec - right.timeSec,
    ),
    coolDurationSec: timeSec > lastTimeSec ? duration - timeSec : profile.coolDurationSec,
  }
}

/** Move one point without ever colliding with an adjacent snapped instruction. */
export const moveTimedPointTime = (profile: TimedProfile, id: string, requestedTimeSec: number): TimedProfile => {
  const sorted = [...profile.points].sort((left, right) => left.timeSec - right.timeSec)
  const index = sorted.findIndex((point) => point.id === id)
  if (index < 0) return profile
  const duration = timedDuration(profile)
  const globalMax = Math.floor(Math.max(0, duration - 1) / TIMED_POINT_TIME_SNAP_SEC) * TIMED_POINT_TIME_SNAP_SEC
  const lower = index > 0 ? sorted[index - 1].timeSec + TIMED_POINT_TIME_SNAP_SEC : 0
  const upper = index < sorted.length - 1 ? sorted[index + 1].timeSec - TIMED_POINT_TIME_SNAP_SEC : globalMax
  if (lower > upper) return profile
  const snapped = Math.round(requestedTimeSec / TIMED_POINT_TIME_SNAP_SEC) * TIMED_POINT_TIME_SNAP_SEC
  const timeSec = Math.max(lower, Math.min(upper, snapped))
  if (timeSec === sorted[index].timeSec) return profile
  return { ...profile, points: profile.points.map((point) => (point.id === id ? { ...point, timeSec } : point)) }
}
/** The chart and the explicit table button share the same minimum-two-points deletion rule. */
export const removeTimedPoint = (profile: TimedProfile, id: string): TimedProfile => {
  if (profile.points.length <= 2 || !profile.points.some((point) => point.id === id)) return profile
  return { ...profile, points: profile.points.filter((point) => point.id !== id) }
}
