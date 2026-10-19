import { describe, expect, it } from 'vitest'
import {
  appendZone,
  boundaryTimes,
  insertBoundary,
  journeyDurationSec,
  journeyPoints,
  moveBoundary,
  removeZone,
  updateZone,
} from './journeyEdit'
import type { ThermalSegment } from './types'

const zone = (id: string, startC: number, endC: number, durationSec: number): ThermalSegment => ({
  id,
  startC,
  endC,
  durationSec,
  fanMin: 4,
  fanMax: 9,
  heatMin: 3,
  heatMax: 9,
})

// 0 -> 150 °C over 3:30, 150 -> 175 °C over 2:00, 175 -> 205 °C over 2:30. Total 8:00.
const journey = (): ThermalSegment[] => [zone('a', 25, 150, 210), zone('b', 150, 175, 120), zone('c', 175, 205, 150)]

const continuous = (segments: ThermalSegment[]) =>
  segments.every((segment, index) => index === 0 || segment.startC === segments[index - 1].endC)

describe('journey geometry', () => {
  it('turns zones into a path and back', () => {
    expect(boundaryTimes(journey())).toEqual([0, 210, 330, 480])
    expect(journeyDurationSec(journey())).toBe(480)
    expect(journeyPoints(journey())).toEqual([
      { index: 0, timeSec: 0, temperatureC: 25 },
      { index: 1, timeSec: 210, temperatureC: 150 },
      { index: 2, timeSec: 330, temperatureC: 175 },
      { index: 3, timeSec: 480, temperatureC: 205 },
    ])
    expect(journeyPoints([])).toEqual([])
  })
})

describe('dragging a boundary', () => {
  it('moves temperature and time together, and keeps the total length', () => {
    const moved = moveBoundary(journey(), 1, 240, 158)
    expect(boundaryTimes(moved)).toEqual([0, 240, 330, 480])
    expect(moved[0].endC).toBe(158)
    expect(moved[1].startC).toBe(158)
    expect(journeyDurationSec(moved)).toBe(480)
    expect(continuous(moved)).toBe(true)
  })

  it('never lets a drag collapse a neighbouring zone past its minimum', () => {
    const squashed = moveBoundary(journey(), 1, 1000, 150)
    expect(boundaryTimes(squashed)).toEqual([0, 325, 330, 480])
    const backwards = moveBoundary(journey(), 1, -500, 150)
    expect(boundaryTimes(backwards)).toEqual([0, 5, 330, 480])
    expect(journeyDurationSec(squashed)).toBe(480)
  })

  it('lengthens the journey when the last point is dragged, because nothing follows it', () => {
    const stretched = moveBoundary(journey(), 3, 600, 210)
    expect(boundaryTimes(stretched)).toEqual([0, 210, 330, 600])
    expect(stretched[2].endC).toBe(210)
  })

  it('moves the journey start in temperature only', () => {
    const start = moveBoundary(journey(), 0, 400, 30)
    expect(start[0].startC).toBe(30)
    expect(boundaryTimes(start)).toEqual([0, 210, 330, 480])
  })

  it('clamps temperature into the readable range and ignores an impossible index', () => {
    expect(moveBoundary(journey(), 1, 210, -40)[0].endC).toBe(0)
    expect(moveBoundary(journey(), 1, 210, 9000)[0].endC).toBe(300)
    expect(moveBoundary(journey(), 9, 210, 150)).toEqual(journey())
    expect(moveBoundary([], 0, 10, 100)).toEqual([])
  })
})

describe('inserting a boundary by double-clicking the chart', () => {
  it('splits the zone that contains the click, between the zones that surrounded it', () => {
    const split = insertBoundary(journey(), 270, 162, 'new')
    expect(split).toHaveLength(4)
    expect(boundaryTimes(split)).toEqual([0, 210, 270, 330, 480])
    expect(split[1]).toMatchObject({ id: 'b', startC: 150, endC: 162, durationSec: 60 })
    expect(split[2]).toMatchObject({ id: 'new', startC: 162, endC: 175, durationSec: 60 })
    expect(journeyDurationSec(split)).toBe(480)
    expect(continuous(split)).toBe(true)
  })

  it('inherits the limits of the zone it split, which is the only honest default', () => {
    const split = insertBoundary([{ ...zone('a', 25, 150, 210), fanMin: 6, heatMax: 7 }], 100, 90, 'new')
    expect(split[1]).toMatchObject({ fanMin: 6, heatMax: 7 })
  })

  it('ignores a click on an existing boundary, beside one, or outside the journey', () => {
    expect(insertBoundary(journey(), 210, 150, 'new')).toHaveLength(3)
    // A click a second off a point would mint a one-second zone nobody can see or edit.
    expect(insertBoundary(journey(), 211, 150, 'new')).toHaveLength(3)
    expect(insertBoundary(journey(), 208, 150, 'new')).toHaveLength(3)
    expect(insertBoundary(journey(), 215, 150, 'new')).toHaveLength(4)
    expect(insertBoundary(journey(), 0, 25, 'new')).toHaveLength(3)
    expect(insertBoundary(journey(), 480, 205, 'new')).toHaveLength(3)
    expect(insertBoundary(journey(), 900, 205, 'new')).toHaveLength(3)
    expect(insertBoundary([], 10, 100, 'new')).toEqual([])
  })
})

describe('adding and removing zones', () => {
  it('appends a zone that holds the temperature the journey finished at', () => {
    const grown = appendZone(journey(), 'new')
    expect(grown).toHaveLength(4)
    expect(grown[3]).toMatchObject({
      id: 'new',
      startC: 205,
      endC: 205,
      fanMin: 1,
      fanMax: 10,
      heatMin: 0,
      heatMax: 10,
    })
    expect(continuous(grown)).toBe(true)
    // An empty journey still gets a first zone rather than throwing.
    expect(appendZone([], 'first')).toHaveLength(1)
  })

  it('hands a removed zone its time to the zone before it, so the journey keeps its length', () => {
    const trimmed = removeZone(journey(), 'b')
    expect(trimmed.map((segment) => segment.id)).toEqual(['a', 'c'])
    expect(boundaryTimes(trimmed)).toEqual([0, 330, 480])
    expect(journeyDurationSec(trimmed)).toBe(480)
    expect(continuous(trimmed)).toBe(true)
  })

  it('gives the leading zone time to whichever zone becomes first', () => {
    const trimmed = removeZone(journey(), 'a')
    expect(trimmed.map((segment) => segment.id)).toEqual(['b', 'c'])
    expect(journeyDurationSec(trimmed)).toBe(480)
  })

  it('refuses to remove the last zone, or one that is not there', () => {
    expect(removeZone([zone('only', 25, 200, 300)], 'only')).toHaveLength(1)
    expect(removeZone(journey(), 'missing')).toEqual(journey())
  })

  it('repairs continuity after a table edit rather than storing a gap', () => {
    const edited = updateZone(journey(), 'a', { endC: 160 })
    expect(edited[1].startC).toBe(160)
    expect(continuous(edited)).toBe(true)
  })
})
