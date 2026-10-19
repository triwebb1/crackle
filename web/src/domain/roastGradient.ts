import { roastColorStops } from './roastReference'

/**
 * Temperature -> expected bean color, for the chart axes.
 *
 * `roastReference.ts` is the SINGLE source. The Reference screen already publishes the bean-color
 * progression as named stops with temperatures, and this module does nothing but reshape those same
 * stops into gradient positions, so the strip beside a chart axis and the table on the Reference
 * page can never drift apart. No color is defined here.
 *
 * Two rules make the result honest:
 *
 * - **The reference band is the whole domain of the color data.** Outside it - colder than the
 *   first stop, hotter than the last - the ramp paints NOTHING. Bean color at 260 °C is not a
 *   darker brown, it is a temperature the reference does not describe, and extrapolating it would
 *   be inventing data. The cut-offs are hard: a zero-opacity stop at the same position as the first
 *   visible one, so there is no fade that could be mistaken for a real color.
 * - **Colors between two reference stops are interpolated in sRGB**, which is exactly what an SVG
 *   gradient does between the same two stops. A clamped edge color is therefore the identical color
 *   the gradient would have painted at that position anyway - the clamp only moves where the ramp
 *   starts, never what it says.
 *
 * This is a semantic ramp, not a magnitude ramp: the colors ARE the quantity, so multi-hue is
 * correct here and lightness monotonicity is not a requirement (green is darker than yellow because
 * green coffee is darker than yellowing coffee). It is never used to encode anything else.
 */

export const ROAST_COLOR_MIN_C = roastColorStops[0].temperatureC
export const ROAST_COLOR_MAX_C = roastColorStops[roastColorStops.length - 1].temperatureC

export interface RoastGradientStop {
  temperatureC: number
  color: string
  /** 0 at the domain minimum, 1 at the domain maximum, matching the caller's own axis scale. */
  position: number
  /** 1 for a painted stop; 0 for the guard stops that cut the ramp off outside the reference band. */
  opacity: number
}

const channels = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16))
const toHex = (values: number[]) =>
  `#${values.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`
const mix = (from: string, to: string, fraction: number) => {
  const [a, b] = [channels(from), channels(to)]
  return toHex(a.map((value, index) => value + (b[index] - value) * fraction))
}

/** The expected bean color at a temperature, or `undefined` where the reference says nothing. */
export const roastColorAt = (temperatureC: number): string | undefined => {
  if (!Number.isFinite(temperatureC) || temperatureC < ROAST_COLOR_MIN_C || temperatureC > ROAST_COLOR_MAX_C)
    return undefined
  const exact = roastColorStops.find((stop) => stop.temperatureC === temperatureC)
  if (exact) return exact.color
  const upperIndex = roastColorStops.findIndex((stop) => stop.temperatureC > temperatureC)
  const lower = roastColorStops[upperIndex - 1]
  const upper = roastColorStops[upperIndex]
  return mix(lower.color, upper.color, (temperatureC - lower.temperatureC) / (upper.temperatureC - lower.temperatureC))
}

/**
 * The gradient for an axis running `domainMinC` to `domainMaxC`, as stops positioned 0..1 along
 * that domain. Returns an empty list when the axis does not reach the reference band at all, which
 * the caller renders as no strip rather than as an empty one.
 */
export const roastGradientStops = (domainMinC: number, domainMaxC: number): RoastGradientStop[] => {
  const span = domainMaxC - domainMinC
  if (!Number.isFinite(span) || span <= 0) return []
  const lowC = Math.max(domainMinC, ROAST_COLOR_MIN_C)
  const highC = Math.min(domainMaxC, ROAST_COLOR_MAX_C)
  if (highC <= lowC) return []

  const position = (temperatureC: number) => (temperatureC - domainMinC) / span
  const painted = (temperatureC: number, color: string): RoastGradientStop => ({
    temperatureC,
    color,
    position: position(temperatureC),
    opacity: 1,
  })

  const stops: RoastGradientStop[] = [
    painted(lowC, roastColorAt(lowC)!),
    ...roastColorStops
      .filter((stop) => stop.temperatureC > lowC && stop.temperatureC < highC)
      .map((stop) => painted(stop.temperatureC, stop.color)),
    painted(highC, roastColorAt(highC)!),
  ]

  // Hard cut-offs. A zero-opacity stop at offset 0 and a second at the band edge leave the region
  // flat-transparent, and the duplicate offset makes the transition a step rather than a fade.
  if (lowC > domainMinC) {
    const edge = stops[0]
    stops.unshift({ ...edge, position: 0, opacity: 0 }, { ...edge, opacity: 0 })
  }
  if (highC < domainMaxC) {
    const edge = stops[stops.length - 1]
    stops.push({ ...edge, opacity: 0 }, { ...edge, position: 1, opacity: 0 })
  }
  return stops
}

/**
 * Ticks anchored at the domain MINIMUM and stepped up from there, so a domain that does not start
 * on a round number - 50 to 230 - still gets a tick on both of its own ends. Generated rather than
 * written out so an axis cannot end up labelled for a range it does not actually draw.
 */
export const axisTicksFrom = (domainMinC: number, domainMaxC: number, stepC: number): number[] => {
  if (
    !Number.isFinite(domainMinC) ||
    !Number.isFinite(domainMaxC) ||
    !Number.isFinite(stepC) ||
    stepC <= 0 ||
    domainMaxC <= domainMinC
  )
    return []
  const ticks: number[] = []
  for (let tick = domainMinC; tick <= domainMaxC + 1e-9; tick += stepC) ticks.push(Math.round(tick * 1e6) / 1e6)
  return ticks
}

/** Ticks on round multiples of `stepC` inside the domain, for a domain that starts on one. */
export const temperatureAxisTicks = (domainMinC: number, domainMaxC: number, stepC: number): number[] => {
  if (
    !Number.isFinite(domainMinC) ||
    !Number.isFinite(domainMaxC) ||
    !Number.isFinite(stepC) ||
    stepC <= 0 ||
    domainMaxC <= domainMinC
  )
    return []
  const first = Math.ceil(domainMinC / stepC) * stepC
  const ticks: number[] = []
  for (let tick = first; tick <= domainMaxC + 1e-9; tick += stepC) ticks.push(Math.round(tick * 1e6) / 1e6)
  return ticks
}
