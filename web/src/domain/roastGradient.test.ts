import { describe, expect, it } from 'vitest'
import {
  ROAST_COLOR_MAX_C,
  ROAST_COLOR_MIN_C,
  roastColorAt,
  roastGradientStops,
  temperatureAxisTicks,
} from './roastGradient'
import { roastColorStops } from './roastReference'

const painted = (stops: ReturnType<typeof roastGradientStops>) => stops.filter((stop) => stop.opacity > 0)

describe('the roast color reference is the only source', () => {
  it('takes its band straight from the reference stops', () => {
    expect(ROAST_COLOR_MIN_C).toBe(roastColorStops[0].temperatureC)
    expect(ROAST_COLOR_MAX_C).toBe(roastColorStops[roastColorStops.length - 1].temperatureC)
  })

  it('returns the reference color exactly at a reference temperature', () => {
    for (const stop of roastColorStops) expect(roastColorAt(stop.temperatureC)).toBe(stop.color)
  })

  it('never invents a color the reference does not cover', () => {
    expect(roastColorAt(ROAST_COLOR_MIN_C - 0.5)).toBeUndefined()
    expect(roastColorAt(ROAST_COLOR_MAX_C + 0.5)).toBeUndefined()
    expect(roastColorAt(400)).toBeUndefined()
    expect(roastColorAt(Number.NaN)).toBeUndefined()
  })

  it('interpolates between two reference stops and stays between them', () => {
    const midpoint = roastColorAt(210)!
    expect(midpoint).toMatch(/^#[0-9a-f]{6}$/)
    // 210 °C sits between Medium brown (205) and Dark brown (220), so every channel must too.
    const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)
    for (let index = 0; index < 3; index += 1) {
      expect(channel(midpoint, index)).toBeLessThanOrEqual(channel('#593223', index))
      expect(channel(midpoint, index)).toBeGreaterThanOrEqual(channel('#38231c', index))
    }
  })
})

describe('gradient stops for a chart axis', () => {
  it('runs cold to hot with positions that never go backwards', () => {
    const stops = roastGradientStops(0, 250)
    expect(stops.length).toBeGreaterThan(roastColorStops.length)
    for (const [index, stop] of stops.entries()) {
      if (index === 0) continue
      expect(stop.position).toBeGreaterThanOrEqual(stops[index - 1].position)
    }
    const temperatures = painted(stops).map((stop) => stop.temperatureC)
    expect(temperatures).toEqual([...temperatures].sort((a, b) => a - b))
    expect(stops.every((stop) => stop.position >= 0 && stop.position <= 1)).toBe(true)
  })

  it('positions each stop by its own temperature on the caller domain', () => {
    const stops = roastGradientStops(0, 250)
    const yellow = stops.find((stop) => stop.temperatureC === 150 && stop.opacity === 1)!
    expect(yellow.position).toBeCloseTo(150 / 250, 10)
    expect(yellow.color).toBe('#c6a85a')
  })

  /** The rule that matters: bean color at 260 °C is not a darker brown, it is undescribed. */
  it('paints nothing outside the band the reference covers', () => {
    const stops = roastGradientStops(0, 250)
    for (const stop of painted(stops)) {
      expect(stop.temperatureC).toBeGreaterThanOrEqual(ROAST_COLOR_MIN_C)
      expect(stop.temperatureC).toBeLessThanOrEqual(ROAST_COLOR_MAX_C)
    }
    // Guard stops exist at both ends, and the cut is a step rather than a fade: the transparent
    // stop shares its position with the first painted one.
    expect(stops[0]).toMatchObject({ position: 0, opacity: 0 })
    expect(stops[stops.length - 1]).toMatchObject({ position: 1, opacity: 0 })
    expect(stops[1].position).toBe(stops[2].position)
    expect(stops[1].opacity).toBe(0)
    expect(stops[2].opacity).toBe(1)
    expect(stops[2].temperatureC).toBe(ROAST_COLOR_MIN_C)
  })

  it('clamps to the domain instead of running off the end of it', () => {
    const stops = roastGradientStops(100, 200)
    const visible = painted(stops)
    expect(visible[0].temperatureC).toBe(100)
    expect(visible[visible.length - 1].temperatureC).toBe(200)
    expect(visible[0].position).toBe(0)
    expect(visible[visible.length - 1].position).toBe(1)
    // Nothing outside the domain survives, and no guard stop is needed at either end.
    expect(stops).toEqual(visible)
    expect(visible.every((stop) => stop.temperatureC >= 100 && stop.temperatureC <= 200)).toBe(true)
    // The clamped edge color is the color the gradient would have painted there anyway.
    expect(visible[0].color).toBe(roastColorAt(100))
    expect(visible[visible.length - 1].color).toBe(roastColorAt(200))
  })

  it('guards only the end that actually needs guarding', () => {
    // Domain starts inside the band, ends past it: a guard at the top only.
    const hot = roastGradientStops(150, 300)
    expect(hot[0].opacity).toBe(1)
    expect(hot[0].temperatureC).toBe(150)
    expect(hot[hot.length - 1].opacity).toBe(0)
    expect(painted(hot).at(-1)!.temperatureC).toBe(ROAST_COLOR_MAX_C)
  })

  it('returns nothing at all when the axis never reaches the band', () => {
    expect(roastGradientStops(250, 400)).toEqual([])
    expect(roastGradientStops(-100, 0)).toEqual([])
    expect(roastGradientStops(100, 100)).toEqual([])
    expect(roastGradientStops(200, 100)).toEqual([])
    expect(roastGradientStops(Number.NaN, 250)).toEqual([])
  })

  it('uses reference colors verbatim for every reference temperature inside the domain', () => {
    const stops = roastGradientStops(0, 250)
    for (const reference of roastColorStops) {
      const match = stops.find((stop) => stop.temperatureC === reference.temperatureC && stop.opacity === 1)
      expect(match?.color, `no gradient stop for ${reference.name}`).toBe(reference.color)
    }
  })
})

describe('temperature axis ticks', () => {
  it('covers the domain at the requested step, both ends included when they land on it', () => {
    expect(temperatureAxisTicks(0, 250, 50)).toEqual([0, 50, 100, 150, 200, 250])
    expect(temperatureAxisTicks(0, 400, 100)).toEqual([0, 100, 200, 300, 400])
  })

  it('starts on the step rather than on a ragged domain minimum', () => {
    expect(temperatureAxisTicks(20, 250, 50)).toEqual([50, 100, 150, 200, 250])
    expect(temperatureAxisTicks(20, 240, 50)).toEqual([50, 100, 150, 200])
  })

  it('never labels an axis for a range it does not draw', () => {
    expect(temperatureAxisTicks(0, 250, 0)).toEqual([])
    expect(temperatureAxisTicks(0, 250, -50)).toEqual([])
    expect(temperatureAxisTicks(250, 0, 50)).toEqual([])
    expect(temperatureAxisTicks(0, Number.NaN, 50)).toEqual([])
  })
})
