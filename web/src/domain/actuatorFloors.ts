/**
 * The command layer's public level normalization, mirrored from firmware. Zero remains off; every
 * nonzero Fan request is normalized to at least public level 0.1.
 *
 * Design rule: **if Heat is on, Fan must be 1.0 or higher — on every command path, always**, because
 * a heat-carrying bed must circulate. That rule lives here, in the same public-normalization layer
 * the 0.1 floor lives in, and in the firmware's command-layer mirror of it. The actuator CORE is
 * deliberately not involved: its own
 * 0.1-with-heat qualification remains the deeper backstop, exactly as captured from the stock
 * SR800. A fan-only request (heat 0) is unaffected — 0 stays off, 0.1 through 10 stays valid.
 */
export const ACTUATOR_FLOORS = {
  minimumFan: 0.1,
  /** The heat-on command floor. The actuator core's deeper 0.1 qualification is unchanged. */
  heatOnMinimumFan: 1.0,
  maximumFan: 10,
} as const

// Heat needs real airflow: Fan 1.0 or higher whenever Heat is above zero.
export const minimumFanForHeat = (heat: number): number =>
  Number.isFinite(heat) && heat > 0 ? ACTUATOR_FLOORS.heatOnMinimumFan : 0

// The firmware's level normalization: zero stays off, anything else is clamped into the drive range.
export const normalizeFanLevel = (fan: number): number => {
  if (!Number.isFinite(fan) || fan <= 0) return 0
  return Math.max(ACTUATOR_FLOORS.minimumFan, Math.min(ACTUATOR_FLOORS.maximumFan, fan))
}

// What the actuator will actually drive for a requested pair, normalization and clamps included.
export const effectiveLevels = ({ fan, heat }: { fan: number; heat: number }) => {
  const boundedHeat = Number.isFinite(heat) ? Math.max(0, Math.min(10, heat)) : 0
  return { fan: Math.max(normalizeFanLevel(fan), minimumFanForHeat(boundedHeat)), heat: boundedHeat }
}

// Whether a requested pair will be lifted off the level that was asked for.
export const isFloored = ({ fan, heat }: { fan: number; heat: number }) => effectiveLevels({ fan, heat }).fan !== fan
