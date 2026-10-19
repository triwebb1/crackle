import { describe, expect, it } from 'vitest'
import { timedDuration } from './model'
import { insertTimedPoint, moveTimedPointTime, removeTimedPoint, timedCoolingSpans } from './timedProfileEdit'
import type { TimedProfile } from './types'

const profile = (points: TimedProfile['points'], coolDurationSec = 60): TimedProfile => ({
  id: 'timed',
  name: 'Timed',
  revision: 1,
  strategy: 'timed',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  metadata: { intent: '' },
  notes: '',
  coolFan: 10,
  coolDurationSec,
  points,
})

describe('timed cooling spans', () => {
  it('ends cooling when positive Heat resumes', () => {
    const subject = profile([
      { id: 'a', timeSec: 0, fan: 5, heat: 6 },
      { id: 'b', timeSec: 60, fan: 8, heat: 0 },
      { id: 'c', timeSec: 120, fan: 5, heat: 7 },
    ])
    expect(timedCoolingSpans(subject)).toEqual([{ startSec: 60, endSec: 120 }])
  })

  it('draws separate later cooling and merges adjacent zero-Heat steps', () => {
    const subject = profile(
      [
        { id: 'a', timeSec: 0, fan: 5, heat: 6 },
        { id: 'b', timeSec: 60, fan: 8, heat: 0 },
        { id: 'c', timeSec: 90, fan: 10, heat: 0 },
        { id: 'd', timeSec: 120, fan: 5, heat: 7 },
        { id: 'e', timeSec: 180, fan: 10, heat: 0 },
      ],
      45,
    )
    expect(timedCoolingSpans(subject)).toEqual([
      { startSec: 60, endSec: 120 },
      { startSec: 180, endSec: 225 },
    ])
  })
})

describe('inserting a timed point from the chart', () => {
  const subject = profile(
    [
      { id: 'a', timeSec: 0, fan: 4, heat: 3 },
      { id: 'b', timeSec: 60, fan: 7, heat: 6 },
    ],
    60,
  )

  it('snaps in the middle and inherits the instruction held there', () => {
    const inserted = insertTimedPoint(subject, 33, 'new')
    expect(inserted.points.find((point) => point.id === 'new')).toEqual({ id: 'new', timeSec: 35, fan: 4, heat: 3 })
    expect(inserted.points.map((point) => point.timeSec)).toEqual([0, 35, 60])
    expect(timedDuration(inserted)).toBe(timedDuration(subject))
  })

  it('preserves total duration when splitting the trailing dwell', () => {
    const inserted = insertTimedPoint(subject, 92, 'new')
    expect(inserted.points.find((point) => point.id === 'new')).toEqual({ id: 'new', timeSec: 90, fan: 7, heat: 6 })
    expect(inserted.coolDurationSec).toBe(30)
    expect(timedDuration(inserted)).toBe(120)
  })

  it('refuses a duplicate snapped timestamp', () => {
    expect(insertTimedPoint(subject, 61, 'new')).toBe(subject)
  })
})

describe('moving a timed point on the chart', () => {
  const subject = profile([
    { id: 'a', timeSec: 0, fan: 4, heat: 3 },
    { id: 'b', timeSec: 60, fan: 7, heat: 6 },
    { id: 'c', timeSec: 120, fan: 9, heat: 0 },
  ])

  it('clamps between adjacent snapped instructions instead of creating a duplicate', () => {
    expect(moveTimedPointTime(subject, 'b', 120).points.map((point) => point.timeSec)).toEqual([0, 115, 120])
    expect(moveTimedPointTime(subject, 'b', 0).points.map((point) => point.timeSec)).toEqual([0, 5, 120])
  })

  it('snaps ordinary moves and ignores missing points', () => {
    expect(moveTimedPointTime(subject, 'b', 83).points.find((point) => point.id === 'b')?.timeSec).toBe(85)
    expect(moveTimedPointTime(subject, 'missing', 30)).toBe(subject)
  })
})
describe('removing a timed point from the chart', () => {
  it('removes one shared Fan/Heat point but never goes below two', () => {
    const three = profile([
      { id: 'a', timeSec: 0, fan: 4, heat: 3 },
      { id: 'b', timeSec: 60, fan: 7, heat: 6 },
      { id: 'c', timeSec: 120, fan: 9, heat: 0 },
    ])
    const two = removeTimedPoint(three, 'b')
    expect(two.points.map((point) => point.id)).toEqual(['a', 'c'])
    expect(removeTimedPoint(two, 'a')).toBe(two)
    expect(removeTimedPoint(three, 'missing')).toBe(three)
  })
})
