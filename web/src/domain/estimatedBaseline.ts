import type { ThermalCoefficientField } from './types'

/**
 * The shipped thermal coefficients: an ESTIMATED bean-scale starting baseline for an SR800 with a
 * roughly 225 g batch.
 *
 * ============================================================================================
 * WHERE THESE NUMBERS COME FROM
 * ============================================================================================
 *
 * They are not measurements of anybody's roaster, and they are not arbitrary either. They are the
 * constants that make the app's own thermal model reproduce a canonical, publicly typical SR800
 * roast - the shape a first-time operator would recognise - so that a simulation drawn before any
 * calibration has been done is wrong by a plausible amount rather than by an unknown one.
 *
 * The model is
 *
 *     dT/dt (C per minute) = capacityScale x (4 + heating - airflow - loss x (T - ambient))
 *     capacityScale = referenceBatchMassG / batchMassG
 *     heating = (heat / 10) x heaterGainCPerMinAt10
 *     airflow = (fan / 10) x fanCoolingCPerMinAt10
 *
 * and, with heat off,
 *
 *     dT/dt = -capacityScale x max(8, (fan / 10) x coolingFanCPerMinAt10 + loss x (T - ambient))
 *
 * **The canonical roast.** 225 g of green coffee from 20 °C ambient, run the way an SR800 is
 * usually run: fan 8 and heat 8 to start, easing to fan 7 / heat 7.5 and then fan 6 / heat 7,
 * then fan 10 with heat off to cool. `CANONICAL_WAYPOINTS` records three time-and-temperature
 * anchors read off that published curve shape.
 *
 * The anchors are NOT events. Nothing detects them, nothing looks for them in a log, and no roast
 * has to hit them. They are three points on a reference curve, used once, here, to solve for four
 * constants - the same way one would fit a line through three plotted points.
 *
 * **The solve.** With fan and heat fixed, the heating equation integrates to
 *
 *     T(t) = ambient + (a / loss) x (1 - e^(-loss x t)),   a = 4 + heating - airflow
 *
 * Taking the ratio of two waypoints eliminates `a` and leaves one equation in `loss`, which gives
 * loss near 0.165 °C/min per C of rise; `a` then follows from either waypoint at about 41 °C/min at
 * fan 8 / heat 8. That fixes the COMBINATION `heaterGain - fanCooling` but not each separately, so
 * the split comes from the third observation an SR800 operator can make directly: dropping fan by two
 * levels at constant heat adds roughly 4 °C/min of rise, which puts `fanCoolingCPerMinAt10` near 20.
 * A short numeric sweep around that solution over the three waypoints picked the values below; the
 * cooling coefficient was then solved on its own from "207 °C to a safe 60 °C in three and a half
 * minutes at fan 10", which is the same integral run backwards.
 *
 * **What it achieves.** Simulating the canonical roast with these constants lands every waypoint
 * within 2.5 °C, and cools in 3.3 minutes. `estimatedBaseline.test.ts` is that check, so a future
 * edit to the model or to these numbers cannot quietly move the shipped behaviour.
 *
 * **What it is not.** It is not fitted to any real machine. Element output, chamber losses and
 * probe placement vary between roasters and with ambient conditions, so the temperatures are
 * plausible rather than true. The provenance indicator says exactly that wherever a derived
 * temperature is shown, and the whole point of the loaded-roast fitting flow is to replace these
 * with numbers measured on the user's own roaster.
 * ============================================================================================
 */
export const ESTIMATED_BASELINE_COEFFICIENTS: Record<ThermalCoefficientField, number> = {
  /** At heat 10 and the reference batch, before airflow and losses. */
  heaterGainCPerMinAt10: 66,
  /** How much rise a full fan removes while heating. */
  fanCoolingCPerMinAt10: 19,
  /** How hard a full fan pulls heat out with the element off. */
  coolingFanCPerMinAt10: 28,
  /** Rise lost per minute per degree above ambient. Sets the curve's flattening. */
  thermalLossPerMinPerC: 0.17,
}

/** The batch these constants describe. The model scales other masses against it. */
export const ESTIMATED_BASELINE_MASS_G = 225
export const ESTIMATED_BASELINE_AMBIENT_C = 20

export interface CanonicalStep {
  untilSec: number
  fan: number
  heat: number
}

/** How an SR800 is usually run, in the terms this app commands it in. */
export const CANONICAL_SR800_ROAST: CanonicalStep[] = [
  { untilSec: 240, fan: 8, heat: 8 },
  { untilSec: 420, fan: 7, heat: 7.5 },
  { untilSec: 600, fan: 6, heat: 7 },
  { untilSec: 840, fan: 10, heat: 0 },
]

export interface CanonicalWaypoint {
  atSec: number
  temperatureC: number
  label: string
}

/**
 * Three time-and-temperature anchors from the canonical curve. Deliberately named by their
 * coordinates rather than by roast milestones: these are points on a published shape, not events,
 * and nothing in the app detects or consumes anything they might coincide with.
 */
export const CANONICAL_WAYPOINTS: CanonicalWaypoint[] = [
  { atSec: 270, temperatureC: 150, label: '150 °C at 4:30' },
  { atSec: 450, temperatureC: 196, label: '196 °C at 7:30' },
  { atSec: 570, temperatureC: 207, label: '207 °C at 9:30' },
]

/** How close the shipped constants are required to hold that shape. */
export const CANONICAL_TOLERANCE_C = 10
/** And how long cooling must take, from the drop temperature to a safe handling temperature. */
export const CANONICAL_COOLING = { fromC: 205, toC: 60, maximumMinutes: 4, minimumMinutes: 2.5 }
