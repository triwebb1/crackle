import { effectiveLevels, minimumFanForHeat } from './actuatorFloors'
import { targetPoints } from './model'
import type { CalibrationSettings, ControlCorrection, ThermalIntent, ThermalSegment } from './types'

/**
 * Deriving the Fan and Heat a temperature journey needs, by inverting the thermal model.
 *
 * ============================================================================================
 * THE DERIVATION - read this before changing anything here
 * ============================================================================================
 *
 * This is the algorithm the firmware executes (ported to `sr800_journey_control.cpp` and checked
 * against generated vectors), and an error in it costs green coffee, so it is written to be checked
 * by hand rather than to be clever. There is no search and no optimizer: every step is a closed-form solve of the same equation the simulator's plant uses.
 *
 * `thermalStep` models the heating plant as
 *
 *     dT/dt (C per minute) = massFactor x (4 + heating - airflow - loss x (T - ambient))
 *     heating = (heat / 10) x heaterGainCPerMinAt10
 *     airflow = (fan / 10) x fanCoolingCPerMinAt10
 *     massFactor = referenceBatchMassG / batchMassG
 *
 * and the cooling plant, with heat off, as
 *
 *     dT/dt = -massFactor x max(8, airflowCooling + loss x (T - ambient))
 *     airflowCooling = (fan / 10) x coolingFanCPerMinAt10
 *
 * Three consequences are used below.
 *
 * **Steady state.** Setting dT/dt = 0 gives the temperature a given pair holds at:
 *
 *     Tss = ambient + (4 + heating - airflow) / loss
 *
 * **Required heat.** Rearranged for a wanted rate of rise `r` at the current temperature T:
 *
 *     heat(fan, r) = 10 x (r/massFactor - 4 + (fan/10) x fanCooling + loss x (T - ambient))
 *                    / heaterGain                                                      ... (1)
 *
 * (1) is one equation in two unknowns, so the FEED-FORWARD BASELINE uses the greatest airflow whose
 * required Heat still fits the authored Heat band. Airflow improves circulation and evenness; it is
 * traded away only when retaining it would make the requested RoR unreachable. Solving (1) for the
 * fan at a given heat gives:
 *
 *     fan(heat, r) = 10 x ((heat/10) x heaterGain - r/massFactor + 4 - loss x (T - ambient))
 *                    / fanCooling                                                      ... (2)
 *
 * and the baseline is `fan(heatMax, r)` clamped into the zone's Fan band, with (1) re-solved at
 * that fan and clamped into the Heat band.
 *
 * **Delivered rate.** The model read forwards, for the pair the baseline actually commands:
 *
 *     delivered(fan, heat) = massFactor x (4 + (heat/10) x heaterGain
 *                                          - (fan/10) x fanCooling - loss x (T - ambient))   ... (3)
 *
 * `delivered` equals `r` whenever the baseline pair fits the band. When the band clamps it, the
 * plan's slope is fiction in the model's own terms and `delivered` is the rate the roaster is
 * really being asked to run at. It is the base every correction is measured from (see below).
 *
 * Dense green coffee gets full airflow — Fan 10 — through 130 C, and that protective floor may
 * override an authored lower fan ceiling. Above 130 C the only floors are the zone's own authored
 * `fanMin` and the universal command rule that Heat on means Fan 1.0 or higher (folded in through
 * `effectiveLevels`). Fan follows the solver's output IMMEDIATELY at every tick — increases,
 * reductions and cooling alike. There is deliberately no mass-scaled floor and no gradual-reduction
 * rate limit: with such a floor, walking Fan down from 10 to a 4.7 floor took 1.7 minutes with
 * Heat pinned at 10, which is excessive protection, not control.
 *
 * **Cooling zones** always use Fan 10 and Heat 0. Cooling is not sacrificed to follow a slower
 * authored line; it is the final bean-cooling and chaff-clearing pass.
 *
 * **The trajectory** comes from the goal, not from where the roast happens to be: the required rate
 * `r` is the constant authored slope of the NOMINAL zone path - the same `targetPoints` the
 * profile editor's chart draws. Deriving it from the plan is what makes the deviation
 * mean something; deriving it from the measured temperature instead would make a roast
 * that has fallen behind quietly re-plan around its own failure and report no error at all.
 *
 * ============================================================================================
 * THE LAYERED ARCHITECTURE - feed-forward is a starting point, not an answer
 * ============================================================================================
 *
 * The inversion above is FEED-FORWARD. It is only ever as right as the calibration coefficients it
 * is handed, and the design assumes those are wrong all the time: a coefficient
 * set fitted from last week's roast, at a different mass, on a different bean, at a different room
 * temperature, is a starting guess. So the control is built in three layers, and each one is
 * allowed to be wrong in a way the next one absorbs:
 *
 *   1. **Feed-forward** (this file's inversion) turns the plan's slope into Fan and Heat using the
 *      current calibration. Assumed wrong; recorded anyway, because what it asked for is the
 *      baseline every later number is measured against.
 *   2. **In-roast feedback** (`journeyControlStep`) holds the NOMINAL target while the roast is
 *      happening, whatever the model got wrong. It is the layer that saves the batch.
 *   3. **Post-roast refit** consumes the correction the feedback had to apply. A correction that
 *      averaged +3 °C/min for ten minutes is not noise, it is a measured model bias, and it is the
 *      honest input to the next calibration - see `controlResidual.ts`.
 *
 * **Why the feedback acts in RATE space, through the inversion, rather than trimming heat directly.**
 * The simpler alternative - a small direct trim on the commanded heat (`HEAT_TRIM_PER_C`), with a
 * separate trim on the cooling fan - is rejected. Three things are wrong with it:
 *
 *   - It is proportional only, so any steady model error - exactly the error a wrong heater gain
 *     produces - left a permanent offset the roast never closed. Feed-forward that is 20% short is
 *     a constant rate deficit, and only an integrator removes a constant.
 *   - Heat is not the only actuator. A trim on heat alone cannot use the fan, so on a shallow zone
 *     (where the inversion is holding heat at its floor and shedding the surplus through airflow)
 *     the correction has almost nowhere to go. Cooling zones need their own second constant.
 *   - Trimming heat AFTER the solve fights the actuator floor logic, which has just re-solved the
 *     heat against the airflow the roaster will really deliver.
 *
 * Correcting the wanted RATE instead fixes all three at once. The correction is
 *
 *     correction = Kp x e + Kr x eR + I,      e  = nominalTarget(t) - measured(t)          (C)
 *                                             eR = nominalRate - predictedRoR(t)       (°C/min)
 *
 * and it is fed into the inversion as if the plan had simply asked for a steeper (or shallower)
 * climb. The actuator floor is still folded back in afterwards. No separate per-axis feedback law
 * was added, because the inversion already owns every limit.
 *
 * ============================================================================================
 * CORRECTIONS SPEND HEAT BEFORE FAN - measured on a 225 g Journey roast
 * ============================================================================================
 *
 * The maximum-airflow preference is scorch-motivated and it stays - for the BASELINE. It must not
 * decide where a correction goes. If the correction is simply added to the plan's slope and the
 * whole solve re-run, a negative correction asks (2) for the greatest fan at heatMax and finds MORE
 * fan, never less heat. A measured 225 g roast, zone 3 (180 -> 215 C at 17.5 °C/min, Fan 1-10,
 * Heat 0-10), shows the cost: with RoR at 21-24 °C/min that solve took Fan from 1.0 to 10 in six
 * seconds (5:31-5:37) while Heat eased only 10 -> 9.0. The fitted `fanCooling` of 2.94 °C/min says
 * a Fan 1 -> 10 move is worth 2.6 °C/min; the roaster's real airflow authority in heating mode was
 * an order of magnitude larger, and the probe reports it ~8-10 s late. Measured RoR kept climbing
 * to 29 for seven more seconds, then collapsed 29 -> -2 over twenty; Fan came back to 1 only at
 * 5:55 with RoR already at 5. The batch stalled at 208 C for ~80 s and zone 3 finished at 6:52
 * against 6:22 nominal. The beans cool very quickly, but the cooling takes time to show up on the
 * probe, so the batch was over-cooled.
 *
 * So a correction moves the actuators FROM THE BASELINE PAIR, Heat first:
 *
 *     solveRate     = delivered(baselineFan, baselineHeat) + correction                  ... (4)
 *     heatAtBase    = heat(baselineFan, solveRate)                                  from (1)
 *     if heatAtBase > heatMax:  fan = clamp(fan(heatMax, solveRate), fanMin, baselineFan)
 *     if heatAtBase < heatMin:  fan = clamp(fan(heatMin, solveRate), baselineFan, fanMax)
 *     otherwise:                fan = baselineFan
 *     heat          = clamp(heat(fan, solveRate), heatMin, heatMax)                       ... (5)
 *
 * Read it as: at the fan feed-forward chose, move Heat; only once Heat has hit a band edge does
 * Fan move, and only by the amount Heat could not deliver - down (more heating) for a positive
 * correction, up (more airflow) for a negative one. For a positive correction this is exactly
 * what a whole re-solve gives, because "Heat at heatMax, then the greatest fan that fits" and
 * "raise Heat first, then lower Fan" are the same answer. For a negative correction it is the fix.
 *
 * The base is `delivered`, not the plan's slope, for a reason the same roast shows. Feed-forward was
 * itself pinned there - at Fan 1 the model wanted Heat 10.85 for 17.5 °C/min and could only command
 * 10 - so a correction measured from the plan's slope would have spent its first ~4 °C/min bringing
 * a fictional 10.85 down to a real 10 while the roaster ran 5 °C/min hot. Measured from the pair
 * actually commanded, every °C/min of correction moves an actuator. (`baselineRateCPerMin` reports
 * `delivered`; it equals `requiredRateCPerMin` unless the band clamped feed-forward.)
 *
 * Saturation is still judged against the rate the plan and the feedback ASKED for
 * (`commandedRateCPerMin`), at the fan finally chosen: `saturatedHigh` when (1) at that fan and
 * that rate exceeds heatMax, `saturatedLow` when it falls below heatMin. That keeps feed-forward's
 * own flags truthful about an unreachable plan and keeps `blocked` direction-matched.
 *
 * ============================================================================================
 * RATE FEEDBACK WITH LEAD - acting on where RoR is going, not where it was
 * ============================================================================================
 *
 * The position loop alone is too slow to see that reversal: the position error was only
 * -1.5 to -2 C while RoR was already 5 °C/min hot, and by the time the position error had grown,
 * the airflow that had been commanded ten seconds earlier was arriving all at once. The plant
 * shows an actuator change on the probe after ~8-10 s and completes it in ~20 s (that roast: full fan
 * at 5:36, RoR peak at 5:43, RoR trough at 6:03). So the feedback also acts on RATE error, and on
 * a rate that has been pushed one lag ahead:
 *
 *     measuredRoR  = 60 x (T(t) - T(t - W)) / W                       W = RATE_WINDOW_SEC     ... (6)
 *     trend        = (measuredRoR(t) - measuredRoR(t - W)) / W                  (°C/min per s)
 *     predictedRoR = measuredRoR + clamp(L x trend, ±MAX_RATE_LEAD)   L = RATE_LEAD_SEC      ... (7)
 *     eR           = nominalRate - predictedRoR
 *
 * With W = L = 10 s at the 1 Hz control cadence (7) is simply `2 x RoR(last 10 s) - RoR(the 10 s
 * before)`: a straight-line extrapolation of the ten-second RoR ten seconds ahead. L = 10 s is the
 * measured onset lag; the trend window equals it so the extrapolation covers exactly one lag and
 * no more. The lead is clamped at ±10 °C/min so a noisy or quantized probe (0.1 C steps over a
 * 10 s window are worth 0.6 °C/min of RoR, 1.2 of second difference) cannot dominate. The samples
 * come from the same timestamps the integral uses: a gap longer than `STALE_SAMPLE_GAP_SEC`, or a
 * clock that went backwards, empties the history because the trend across it was not observed; a
 * missing reading appends nothing and applies no rate term (it is a holdover). Until W of history
 * exists there is no rate term; until 2W exists there is no lead. `nominalRate` is the zone's
 * authored slope (0 for a hold zone) even while the target is holding at the zone's endpoint, so
 * the rate term never fights the position term's pull toward arrival.
 *
 * The intended effect: the loop relaxes the moment the trend turns, while
 * the RoR level is still high, and it does not pile on while the trend is already heading the
 * right way. Kr = Kp x Td / 60 with a derivative time Td = 10 s, i.e. 0.5 °C/min of correction per
 * °C/min of predicted rate error; Td matches the onset lag and adds ~27 degrees of phase lead at
 * the position loop's 0.05 rad/s crossover without doubling the high-frequency gain.
 *
 * ============================================================================================
 * ASYMMETRIC AUTHORITY - cooling is cheap on this roaster and slow to show
 * ============================================================================================
 *
 * The heating-direction bound stays at +15 °C/min (a little over two heat levels). The cooling
 * direction is bounded at -12 °C/min: every harm observed to date is on the cooling side, the
 * fitted `coolingFan` (19.67 at Fan 10) plus the heating-mode airflow effect that roast exposed dwarf
 * the heater's per-level authority, and the lag means a large cooling correction is still arriving
 * after the need for it has passed. The integral keeps its ±8 clamp in both directions.
 *
 * Why -12 and not -6. The bound was measured, not chosen: replaying the 225 g roast's
 * plan against a plant 8 s dead-time and 10 s lag hotter than its fit (heater gain 58-75 against
 * the fitted 49.2, heating-mode airflow 12-25 against 2.94), the Heat-first allocation above kept
 * Fan at 1.0 and moved Heat first at EVERY bound tried - the fan excursion is removed by the
 * allocation and the lead, not by the bound. What the bound does decide is whether a pessimistic
 * model can still be held: that roast's own fit is pessimistic by 9-11 °C/min at Heat 10 (it predicts
 * 13.3 °C/min where the roaster ran 22+). At -6 the acceptance climb with a 20%-pessimistic heater
 * gain ran away to 49 °C ahead of plan (95% of steps saturated); at -10 it settled 2.5-3.5 °C
 * ahead; at -12 it holds within 1.5 °C with the integral doing the work, and the +13 °C/min-hot
 * replay stayed inside 5 °C. -12 °C/min is about 2.4 heat levels at that fit's 49.2 heater gain,
 * so with Heat spent first no cooling correction reaches the fan in a zone whose baseline Heat
 * sits more than that above `heatMin`. A bias beyond the bound is left as a visible, reported
 * deviation ahead of plan - the refit's signal - rather than chased with airflow the model cannot
 * price.
 *
 * **The target is still the nominal plan.** `e` is measured against `targetPoints`, never against a
 * re-anchored path. The feedback moves the ACTUATORS to reach the plan; it never moves the plan to
 * meet the roast. A roast that has fallen behind must not quietly re-plan around its own failure.
 *
 * **The correction is bounded, and its bound is the feasibility signal.** The total correction is
 * clamped, the integral is clamped harder, and the integral stops accumulating whenever the
 * inversion has run out of authority in the direction that would help - and throughout a cooling
 * zone, whose Fan 10 / Heat 0 command the correction never reaches. A journey that only tracks
 * because the correction is welded to its clamp is still reported as saturated.
 *
 * ============================================================================================
 * ZONE ATTAINMENT - arrival is guaranteed, time is best-effort
 * ============================================================================================
 *
 * The core correcting principle of a temperature journey: the roast stays in a zone until that
 * zone's target temperature is reached. It tries to get there in the authored time, but arrival is
 * guaranteed.
 *
 * So **zone advancement is temperature-gated and never time-gated.** Reading the zone off
 * `plan.zoneAt(elapsedSec)` - a clock - would let a roast still two hundred degrees short of zone
 * 1's endpoint move into zone 2 anyway, inherit zone 2's Fan and Heat band, and chase a target it
 * had never earned: the predicted line sits far below the goal while the zone markers march on
 * regardless. That is impossible by construction:
 *
 *   - A zone completes when the MEASURED temperature ATTAINS its end temperature. Direction-aware: a
 *     rising zone completes at `T >= endC`, a cooling zone at `T <= endC`. Never earlier, and never
 *     because a clock ran out.
 *   - The one exception is a zone with no temperature to attain at all - a hold, `endC == startC`
 *     within `ZONE_HOLD_EPSILON_C`. Attainment is instantaneous there and therefore says nothing, so
 *     a hold zone is the single case governed by its nominal duration. `zoneCompleted` is the whole
 *     rule and there is no other place a zone may advance.
 *
 * **In-zone targeting still never re-plans.** Within a zone the target is the zone's own NOMINAL
 * ramp, anchored at the time the roast actually ENTERED the zone and at the zone's nominal start
 * temperature:
 *
 *     target(t) = zoneStartC + nominalRate x (t - zoneEntrySec),   capped at zoneEndC     ... (8)
 *
 * The anchor is honest rather than convenient: the previous zone completed by ATTAINMENT, so the
 * measured temperature at `zoneEntrySec` is already ~ `zoneStartC` and (8) has no step in it. Past
 * the nominal duration the cap takes over and the target HOLDS at `zoneEndC` while the feedback
 * keeps pulling toward arrival - which is exactly the behaviour that makes arrival guaranteed. The
 * trajectory is never re-anchored to the measured temperature mid-zone. The plan's time axis
 * stretches (or compresses) only at zone boundaries, by the fact of arrival.
 *
 * **Error is per zone, not per roast.** The first zone is a charge ramp against a cold mass and most
 * profiles ask it to climb faster than any roaster can; its overrun is expected and is the reading,
 * not a fault. The trailing cooling zone is governed by heat leaving the bean mass rather than by
 * anything the controller commands. Only the middle zones are genuinely controllable, so ONLY the
 * middle zones feed the model-bias estimate the refit consumes - see `controlResidual.ts`, which
 * splits the run by zone and labels each one's role.
 * ============================================================================================
 */

/**
 * The PI gains, in the units the correction is actually applied in: °C/min of wanted rate, per C of
 * tracking error. They are derived from the plant rather than tuned by feel.
 *
 * **Plant.** `heaterGainCPerMinAt10` is about 66 °C/min at heat 10, so one heat level is worth about
 * 6.6 °C/min. The measured rate reaches the commanded one through the sensor lag, a first-order pole
 * at about 5 s (`sensorLagSec`), and temperature is the integral of rate. In Laplace terms, with
 * rate in °C/min and temperature in C, the loop from correction u to temperature is
 *
 *     T(s) / u(s) = 1 / (60 s (1 + 5 s))
 *
 * The 60 is the minutes-to-seconds conversion, and it is the reason a gain of "1" would be far
 * gentler than it looks: Kp = 1 puts gain crossover at 1/60 rad/s, a closed-loop time constant of a
 * full minute, and a correspondingly slow integral.
 *
 * **Kp = 3.0.** Crossover moves to about 0.05 rad/s - a closed-loop time constant near 20 s - where
 * the 5 s sensor pole still only costs about 14 degrees of phase. Physically: a 5 °C deficit asks for
 * 15 °C/min above plan, which is a little over two heat levels. That is a correction a roaster would
 * recognise as reasonable, and it is what the acceptance tests needed. Kp = 1 with a 90 s integral
 * time was tried first and is perfectly stable, but on the synthetic wrong-model runs it left a
 * -20% heater-gain error peaking at 2.6 °C off plan and still averaging 0.8 °C in the final two
 * minutes, because the integral cannot build quickly behind a 60 s proportional response. At 3.0/45
 * the same case peaks at 0.5 °C and averages 0.36 °C. See `journeyControl.pi.test.ts`.
 *
 * **Integral time 45 s.** Placing the PI zero at 1/45 rad/s, just below crossover, keeps about 50
 * degrees of phase margin while removing a steady 8 °C/min feed-forward deficit - which is what a
 * 20% heater-gain error is worth at a typical mid-roast heat level - within roughly a minute.
 *
 * A direct heat trim is worth an effective Kp of about 1.06 in these units (0.16 heat per C times
 * 6.6 °C/min per heat level) with no integral at all, and it holds those same wrong-model runs 7.3
 * to 8.3 °C off plan indefinitely. That is the failure the PI design exists to fix.
 */
export const TRACKING_KP_RATE_PER_C = 3.0
export const TRACKING_INTEGRAL_TIME_SEC = 45

/**
 * Rate feedback (the derivative term, on the measurement). `TRACKING_DERIVATIVE_TIME_SEC` is the
 * classical Td: it equals the ~10 s onset lag measured on a real roast between an actuator change and its
 * first appearance on the probe. The rate gain is Kp x Td expressed per minute, so that a predicted
 * RoR 1 °C/min above the zone's slope asks for 0.5 °C/min less. (6)/(7) define the predicted rate.
 */
export const TRACKING_DERIVATIVE_TIME_SEC = 10
export const TRACKING_RATE_GAIN = (TRACKING_KP_RATE_PER_C * TRACKING_DERIVATIVE_TIME_SEC) / 60
/** The trailing window RoR is read over, and the horizon the trend is extrapolated across. */
export const RATE_WINDOW_SEC = 10
export const RATE_LEAD_SEC = 10
/** The lead contribution is bounded so a noisy second difference cannot own the correction. */
export const MAX_RATE_LEAD_C_PER_MIN = 10
/**
 * How much sample history the rate estimate keeps: the level needs W, the trend 2W, and the
 * remainder is slack for irregular sampling. At the 1 Hz cadence 30 s is 31 samples, inside the
 * fixed capacity the firmware port allocates; a faster cadence would shorten the trend's reach and
 * break nothing.
 */
export const RATE_HISTORY_SEC = 30
export const RATE_HISTORY_CAPACITY = 32

/**
 * Authority bounds, asymmetric by design (see the header). Heating: 15 °C/min is a little over two
 * heat levels of the 66 °C/min the heater commands in total, enough to absorb a badly-fitted
 * coefficient set and not enough to disguise an infeasible zone. Cooling: 12 °C/min, the largest
 * bound the lagged roast replays showed no need to exceed and the smallest that still holds a
 * 20%-pessimistic heater model (-6 ran away by 49 °C, -10 settled 2.5-3.5 °C ahead). The integral
 * is clamped harder, at 8 in both directions, because a persistent 8 °C/min bias is already a loud
 * statement about the calibration.
 */
export const MAX_CORRECTION_C_PER_MIN = 15
export const MAX_INTEGRAL_C_PER_MIN = 8
export const MAX_COOLING_CORRECTION_C_PER_MIN = 12
export const MAX_COOLING_INTEGRAL_C_PER_MIN = 8

/**
 * Integration guards. `dt` comes from the sample timestamps, because samples are not evenly spaced
 * and a controller that assumes they are integrates a fiction. A gap longer than
 * `MAX_INTEGRATION_STEP_SEC` is integrated as if it were that long, so one stalled poll cannot slam
 * the integral; a gap longer than `STALE_SAMPLE_GAP_SEC` is not integrated at all, because the
 * control was blind across it and did not observe the error it would be claiming to accumulate.
 */
export const MAX_INTEGRATION_STEP_SEC = 5
export const STALE_SAMPLE_GAP_SEC = 15

/** Maximum positive-to-positive journey Heat movement at each second of control. */
export const MAX_HEAT_SLEW_PER_SEC = 0.25
/** A delayed control tick never cashes in a multi-second allowance as one visible jump. */
export const MAX_HEAT_SLEW_STEP_SEC = 1

/**
 * The integral does not start with the roast. Charge is a step change the model does not describe -
 * cold beans hitting a hot chamber - and integrating the resulting transient teaches the controller
 * nothing except how wrong the first few seconds are.
 */
export const INTEGRAL_HOLDOFF_SEC = 20

/** Dense green coffee gets full airflow through 130 C, whatever the batch mass. */
export const FULL_AIRFLOW_UNTIL_C = 130

/**
 * The protective airflow floor for heating zones. Fan 10 through 130 C; above that there is no
 * Journey-specific floor at all — the zone's own `fanMin` and the universal command rule that Heat
 * on means Fan 1.0 or higher (via `effectiveLevels`) are the only constraints. A mass-scaled floor
 * (Fan 2 at 170 g rising to Fan 5 at 250 g) proved to be excessive protection in practice and is
 * deliberately absent.
 */
export const journeyCirculationFloor = (beanTempC: number) => (beanTempC <= FULL_AIRFLOW_UNTIL_C ? 10 : 0)

/** The plant's fixed bias term, from `thermalStep`. Named so the inversion cannot drift from it. */
export const PLANT_BIAS_C_PER_MIN = 4

/** The slowest cooling `thermalStep` will model, whatever the fan is asked for. */
export const MINIMUM_MODELLED_COOLING_C_PER_MIN = 8

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(Math.min(minimum, maximum), Math.min(Math.max(minimum, maximum), value))

/** The asymmetric authority clamp on the total correction, and the matching one on the integral. */
export const clampCorrection = (rateCPerMin: number) =>
  clamp(rateCPerMin, -MAX_COOLING_CORRECTION_C_PER_MIN, MAX_CORRECTION_C_PER_MIN)
export const clampIntegral = (rateCPerMin: number) =>
  clamp(rateCPerMin, -MAX_COOLING_INTEGRAL_C_PER_MIN, MAX_INTEGRAL_C_PER_MIN)
/** Whether a correction is welded to its bound in the direction it points. */
export const correctionAtBound = (rateCPerMin: number) =>
  rateCPerMin >= MAX_CORRECTION_C_PER_MIN || rateCPerMin <= -MAX_COOLING_CORRECTION_C_PER_MIN

export interface JourneyPlan {
  /** Cumulative end time of each zone, with 0 in front. */
  boundaries: number[]
  totalSec: number
  /** The zones themselves, so a zone can be addressed by INDEX rather than only by the clock. */
  segments: ThermalSegment[]
  temperatureAt: (elapsedSec: number) => number
  zoneAt: (elapsedSec: number) => { zone: ThermalSegment; index: number }
}

/**
 * The plan, read off the nominal zone path. One source with the editor chart: `targetPoints` is
 * the same function `journeyPoints` drives, so what the chart shows and what the control follows
 * cannot diverge.
 */
export const journeyPlan = (intent: ThermalIntent): JourneyPlan => {
  const points = targetPoints(intent)
  const boundaries = points.map((point) => point.timeSec)
  const totalSec = boundaries[boundaries.length - 1] ?? 0

  const temperatureAt = (elapsedSec: number) => {
    if (points.length === 0) return 24.5
    if (elapsedSec <= points[0].timeSec) return points[0].temperatureC
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]
      const current = points[index]
      if (elapsedSec <= current.timeSec) {
        const span = Math.max(1, current.timeSec - previous.timeSec)
        return (
          previous.temperatureC +
          (current.temperatureC - previous.temperatureC) * ((elapsedSec - previous.timeSec) / span)
        )
      }
    }
    return points[points.length - 1].temperatureC
  }

  const zoneAt = (elapsedSec: number) => {
    for (const [index, zone] of intent.segments.entries()) {
      if (elapsedSec < boundaries[index + 1]) return { zone, index }
    }
    const index = Math.max(0, intent.segments.length - 1)
    return { zone: intent.segments[index], index }
  }

  return { boundaries, totalSec, segments: intent.segments, temperatureAt, zoneAt }
}

/**
 * A zone with no temperature to attain. `endC == startC` is attained the instant the zone begins, so
 * attainment says nothing about it and its nominal duration is the only thing that defines it. The
 * epsilon is half a degree because the editor snaps zone temperatures to 5 °C: anything inside it was
 * authored as a hold, not as a climb.
 */
export const ZONE_HOLD_EPSILON_C = 0.5

/**
 * Direction-aware attainment: the measured temperature has reached the zone's endpoint. A rising
 * zone arrives from below, a cooling zone from above. This is the ONLY thing that completes a zone.
 */
export const zoneAttained = (zone: ThermalSegment, temperatureC: number): boolean => {
  if (!Number.isFinite(temperatureC)) return false
  return zone.endC >= zone.startC ? temperatureC >= zone.endC : temperatureC <= zone.endC
}

/**
 * Whether the roast may leave this zone. Attainment, except for a hold zone (see
 * `ZONE_HOLD_EPSILON_C`), which is the one case a clock is allowed to decide.
 */
export const zoneCompleted = (zone: ThermalSegment, temperatureC: number, zoneElapsedSec: number): boolean =>
  Math.abs(zone.endC - zone.startC) <= ZONE_HOLD_EPSILON_C
    ? zoneElapsedSec >= Math.max(1, zone.durationSec)
    : zoneAttained(zone, temperatureC)

/** Where the roast is in the journey: which zone, and when it actually entered that zone. */
export interface ZoneAnchor {
  zoneIndex: number
  zoneEntrySec: number
}

/**
 * (8): the zone's own nominal ramp, measured from the moment the roast entered the zone, capped at
 * the zone's endpoint. Past the nominal duration this HOLDS at `endC` - the target stops moving and
 * the feedback keeps pulling until arrival, which is what makes arrival guaranteed.
 */
export const zoneTargetC = (
  zone: Pick<ThermalSegment, 'startC' | 'endC' | 'durationSec'>,
  zoneElapsedSec: number,
): number => {
  const span = zone.endC - zone.startC
  const raw = zone.startC + (span / Math.max(1, zone.durationSec)) * Math.max(0, zoneElapsedSec)
  return span >= 0 ? Math.min(zone.endC, raw) : Math.max(zone.endC, raw)
}

/**
 * Advance the anchor by attainment, and by nothing else. The loop rather than a single test is for
 * an overshoot that genuinely clears several zone endpoints at once - those end temperatures really
 * were attained - and it terminates because entering a zone resets its elapsed time to zero, so a
 * hold zone can never be cleared in the same step it was entered. The final zone never advances:
 * there is nowhere to advance to, and the simulation reads its completion separately.
 */
export const advanceZoneAnchor = (
  plan: JourneyPlan,
  anchor: ZoneAnchor,
  elapsedSec: number,
  beanTempC: number,
): ZoneAnchor => {
  let { zoneIndex, zoneEntrySec } = anchor
  if (!Number.isFinite(beanTempC)) return { zoneIndex, zoneEntrySec }
  while (
    zoneIndex < plan.segments.length - 1 &&
    zoneCompleted(plan.segments[zoneIndex], beanTempC, elapsedSec - zoneEntrySec)
  ) {
    zoneIndex += 1
    zoneEntrySec = elapsedSec
  }
  return { zoneIndex, zoneEntrySec }
}

/** The zone an anchor names, clamped into the plan so a stale index cannot read off the end. */
export const anchoredZone = (plan: JourneyPlan, zoneIndex: number): ThermalSegment | undefined =>
  plan.segments[Math.min(Math.max(0, zoneIndex), plan.segments.length - 1)]

/** The target the anchored trajectory wants at `elapsedSec`. */
export const anchoredTargetC = (plan: JourneyPlan, anchor: ZoneAnchor, elapsedSec: number): number => {
  const zone = anchoredZone(plan, anchor.zoneIndex)
  return zone === undefined ? plan.temperatureAt(elapsedSec) : zoneTargetC(zone, elapsedSec - anchor.zoneEntrySec)
}

export interface JourneyCommand {
  fan: number
  /** Heat actually handed to the actuator after the journey-only slew bound. */
  heat: number
  /** The closed-form answer before slew limiting; retained for honest diagnostics. */
  unconstrainedHeat: number
  heatSlewLimited: boolean
  cooling: boolean
  zoneIndex: number
  /** When the roast entered this zone. The plan's own boundary when no anchor was supplied. */
  zoneEntrySec: number
  /** True when the nominal ramp is exhausted and the target is HOLDING at the zone's endpoint. */
  holdingAtZoneEnd: boolean
  /** What the plan wants right now, and the rate the NOMINAL plan wants to get there at. */
  goalC: number
  requiredRateCPerMin: number
  /**
   * The rate the feed-forward baseline pair delivers in the model, (3). Equal to
   * `requiredRateCPerMin` unless the zone's band clamped feed-forward; it is the base every
   * correction moves the actuators from.
   */
  baselineRateCPerMin: number
  /** The rate actually asked for: the plan's slope plus whatever correction was handed in. */
  commandedRateCPerMin: number
  /**
   * True when the zone's own limits stopped the derivation reaching the rate it asked for. This is
   * the feasibility signal: a journey that saturates cannot be roasted as written.
   */
  saturated: boolean
  /**
   * Which way the derivation has run out of room, which is what the integrator needs to know before
   * it accumulates anything. `saturatedHigh` means no more rate of rise is available (heat pinned at
   * the zone maximum, or a cooling zone already cooling faster than asked); `saturatedLow` means no
   * less is available (heat at its floor with fan already wide open, or cooling fan at its maximum).
   */
  saturatedHigh: boolean
  saturatedLow: boolean
}

export interface JourneyControlInput {
  plan: JourneyPlan
  elapsedSec: number
  beanTempC: number
  ambientC: number
  batchMassG: number
  calibration: CalibrationSettings
  /**
   * Rate-space correction added to the plan's slope before the inversion runs, in °C/min. Zero - the
   * default - is pure feed-forward, which is what the telemetry records as the model's own answer.
   * `journeyControlStep` is what normally supplies it.
   */
  rateCorrectionCPerMin?: number
  /**
   * Where the roast IS, by attainment. Supplied, the zone and the target come from the anchored
   * trajectory (8) - which is what a roast follows. Omitted, the zone and the target come from the
   * plan's own clock, which is what the profile editor wants when it asks "what does this journey
   * look like on paper". `journeyControlStep` always supplies one.
   */
  zoneAnchor?: ZoneAnchor
}

/**
 * One control step: the closed-form inversion described at the top of this file. Feed-forward only
 * unless a rate correction is handed in; it has no memory and no feedback of its own.
 */
export const journeyCommand = ({
  plan,
  elapsedSec,
  beanTempC,
  ambientC,
  batchMassG,
  calibration,
  rateCorrectionCPerMin,
  zoneAnchor,
}: JourneyControlInput): JourneyCommand => {
  const clocked = plan.zoneAt(elapsedSec)
  const index = zoneAnchor
    ? Math.min(Math.max(0, zoneAnchor.zoneIndex), Math.max(0, plan.segments.length - 1))
    : clocked.index
  const zone = zoneAnchor ? (plan.segments[index] ?? clocked.zone) : clocked.zone
  const zoneEntrySec = zoneAnchor ? zoneAnchor.zoneEntrySec : (plan.boundaries[index] ?? 0)
  // The anchored trajectory is the zone's own nominal ramp from where the roast really entered it;
  // without an anchor this is the plan read straight off its clock, exactly as before.
  const goalC = zoneAnchor ? zoneTargetC(zone, elapsedSec - zoneEntrySec) : plan.temperatureAt(elapsedSec)
  const spanC = zone.endC - zone.startC
  const holdingZone = Math.abs(spanC) <= ZONE_HOLD_EPSILON_C
  // The endpoint remains capped for position error and attainment, but feed-forward keeps the
  // authored slope throughout an overrun so the heater does not collapse at nominal zone end.
  const holdingAtZoneEnd = zoneAnchor !== undefined && elapsedSec - zoneEntrySec >= Math.max(1, zone.durationSec)
  const requiredRateCPerMin = holdingZone ? 0 : (spanC / Math.max(1, zone.durationSec)) * 60
  // The slope the plan and the feedback ask for together: the plan's, plus the correction.
  const correction = Number.isFinite(rateCorrectionCPerMin) ? (rateCorrectionCPerMin as number) : 0
  const commandedRateCPerMin = requiredRateCPerMin + correction
  const overAmbientC = Math.max(0, beanTempC - ambientC)
  const passiveLoss = overAmbientC * calibration.thermalLossPerMinPerC
  const capacityScale = calibration.referenceBatchMassG / Math.max(1, batchMassG)
  const cooling = spanC < -ZONE_HOLD_EPSILON_C

  if (cooling) {
    // Cooling is also the deliberate final chaff-clearing pass, so it always uses full airflow.
    const wantedRate = Math.max(0, -commandedRateCPerMin)
    const fan = 10
    const achievable =
      capacityScale *
      Math.max(MINIMUM_MODELLED_COOLING_C_PER_MIN, (fan / 10) * calibration.coolingFanCPerMinAt10 + passiveLoss)
    return {
      fan,
      heat: 0,
      unconstrainedHeat: 0,
      heatSlewLimited: false,
      cooling: true,
      zoneIndex: index,
      zoneEntrySec,
      holdingAtZoneEnd,
      goalC,
      requiredRateCPerMin,
      baselineRateCPerMin: requiredRateCPerMin,
      commandedRateCPerMin,
      saturated: Math.abs(achievable - wantedRate) > 1,
      saturatedHigh: achievable > wantedRate + 1,
      saturatedLow: achievable < wantedRate - 1,
    }
  }

  const heaterAuthority = Math.max(0.1, calibration.heaterGainCPerMinAt10)
  const fanCooling = Math.max(0.1, calibration.fanCoolingCPerMinAt10)
  const circulationFloor = journeyCirculationFloor(beanTempC)
  const fanMin = Math.max(zone.fanMin, circulationFloor)
  // The full-airflow floor is protective and may override an authored lower fan ceiling.
  const fanMax = Math.max(zone.fanMax, fanMin)
  // (1): the heat a given fan needs to produce a plant rate at this temperature.
  const heatFor = (fan: number, plantRate: number) =>
    (10 * (plantRate - PLANT_BIAS_C_PER_MIN + (fan / 10) * calibration.fanCoolingCPerMinAt10 + passiveLoss)) /
    heaterAuthority
  // (2): the fan at which a given heat produces a plant rate.
  const fanFor = (heat: number, plantRate: number) =>
    (10 * ((heat / 10) * heaterAuthority - plantRate + PLANT_BIAS_C_PER_MIN - passiveLoss)) / fanCooling
  // (3): the plant rate a pair delivers - the model equation read forwards.
  const plantRateOf = (fan: number, heat: number) =>
    PLANT_BIAS_C_PER_MIN + (heat / 10) * heaterAuthority - (fan / 10) * calibration.fanCoolingCPerMinAt10 - passiveLoss

  // FEED-FORWARD BASELINE: the greatest airflow whose required Heat fits the plan's own slope, the
  // heat clamped into the band, and the heat-on Fan floor folded back once so the pair is the one
  // the roaster will really be driven at.
  const requiredPlantRate = requiredRateCPerMin / capacityScale
  let baselineFan = clamp(fanFor(zone.heatMax, requiredPlantRate), fanMin, fanMax)
  let baselineHeat = clamp(heatFor(baselineFan, requiredPlantRate), zone.heatMin, zone.heatMax)
  const baselineFloored = effectiveLevels({ fan: baselineFan, heat: baselineHeat })
  if (baselineFloored.fan !== baselineFan) {
    baselineFan = baselineFloored.fan
    baselineHeat = clamp(heatFor(baselineFan, requiredPlantRate), zone.heatMin, zone.heatMax)
  }
  const baselinePlantRate = plantRateOf(baselineFan, baselineHeat)

  // CORRECTION ALLOCATION (4)/(5): Heat first, at the baseline Fan. Fan moves only for the part of
  // the correction Heat could not deliver - down for more heating, up for more airflow.
  const solvePlantRate = baselinePlantRate + correction / capacityScale
  let fan = baselineFan
  const heatAtBaselineFan = heatFor(fan, solvePlantRate)
  if (heatAtBaselineFan > zone.heatMax + 1e-9) {
    fan = clamp(fanFor(zone.heatMax, solvePlantRate), fanMin, baselineFan)
  } else if (heatAtBaselineFan < zone.heatMin - 1e-9) {
    fan = clamp(fanFor(zone.heatMin, solvePlantRate), baselineFan, fanMax)
  }
  const heat = heatFor(fan, solvePlantRate)

  // SATURATION describes the rate the plan and the feedback asked for, at the fan finally chosen.
  const requestedPlantRate = commandedRateCPerMin / capacityScale
  const heatingFloorRate = -5 * capacityScale
  const floorLimited = commandedRateCPerMin < heatingFloorRate
  const heatForRequested = heatFor(fan, requestedPlantRate)
  let saturatedHigh = heatForRequested > zone.heatMax + 1e-9
  const saturatedLow = floorLimited || heatForRequested < zone.heatMin - 1e-9
  let saturated = saturatedHigh || saturatedLow

  let commandedHeat = clamp(heat, zone.heatMin, zone.heatMax)
  let commandedFan = clamp(fan, fanMin, fanMax)

  /*
   * Command-layer level normalization, accounted for rather than discovered.
   *
   * Heat on means Fan 1.0 or higher (a heat-carrying bed must circulate), and a nonzero fan-only value below
   * public level 0.1 is lifted to 0.1. Either lift's extra airflow is folded back into the heat
   * solve once, so the command describes the pair that will actually be driven.
   */
  const floored = effectiveLevels({ fan: commandedFan, heat: commandedHeat })
  if (floored.fan !== commandedFan) {
    commandedFan = floored.fan
    commandedHeat = clamp(heatFor(commandedFan, solvePlantRate), zone.heatMin, zone.heatMax)
    // The extra airflow can push the required heat past the band it was inside a moment ago.
    if (heatFor(commandedFan, requestedPlantRate) > zone.heatMax) {
      saturated = true
      saturatedHigh = true
    }
  }

  return {
    fan: commandedFan,
    heat: commandedHeat,
    unconstrainedHeat: commandedHeat,
    heatSlewLimited: false,
    cooling: false,
    zoneIndex: index,
    zoneEntrySec,
    holdingAtZoneEnd,
    goalC,
    requiredRateCPerMin,
    baselineRateCPerMin: baselinePlantRate * capacityScale,
    commandedRateCPerMin,
    saturated,
    saturatedHigh,
    saturatedLow,
  }
}

/** One measured sample the rate estimate keeps: when, and what the probe read. */
export interface RateSample {
  sec: number
  tempC: number
}

/**
 * (6)/(7): the trailing-window RoR and its one-lag-ahead prediction, from the history of earlier
 * samples plus the sample being controlled on. `undefined` until a sample at least `RATE_WINDOW_SEC`
 * older exists; the lead is zero until a second window before that one exists too.
 */
export interface RateEstimate {
  measuredCPerMin: number
  leadCPerMin: number
  predictedCPerMin: number
}

export const predictedRate = (history: readonly RateSample[], now: RateSample): RateEstimate | undefined => {
  // The newest sample at least one window old anchors the measured RoR.
  let refIndex = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (now.sec - history[index].sec >= RATE_WINDOW_SEC) {
      refIndex = index
      break
    }
  }
  if (refIndex < 0) return undefined
  const ref = history[refIndex]
  const measuredCPerMin = (60 * (now.tempC - ref.tempC)) / (now.sec - ref.sec)

  // The window before it gives the trend; without one there is no lead, and no fiction of one.
  let earlierIndex = -1
  for (let index = refIndex - 1; index >= 0; index -= 1) {
    if (ref.sec - history[index].sec >= RATE_WINDOW_SEC) {
      earlierIndex = index
      break
    }
  }
  let leadCPerMin = 0
  if (earlierIndex >= 0) {
    const earlier = history[earlierIndex]
    const previousCPerMin = (60 * (ref.tempC - earlier.tempC)) / (ref.sec - earlier.sec)
    const trendCPerMinPerSec = (measuredCPerMin - previousCPerMin) / (now.sec - ref.sec)
    leadCPerMin = clamp(RATE_LEAD_SEC * trendCPerMinPerSec, -MAX_RATE_LEAD_C_PER_MIN, MAX_RATE_LEAD_C_PER_MIN)
  }
  return { measuredCPerMin, leadCPerMin, predictedCPerMin: measuredCPerMin + leadCPerMin }
}

/**
 * The history after this sample: samples older than `RATE_HISTORY_SEC` are dropped, the capacity is
 * enforced oldest-first, and a sample that does not advance the clock is not recorded twice.
 */
export const appendRateSample = (history: readonly RateSample[], sample: RateSample): RateSample[] => {
  const newest = history[history.length - 1]
  if (newest !== undefined && sample.sec <= newest.sec) return [...history]
  const kept = history.filter((entry) => sample.sec - entry.sec <= RATE_HISTORY_SEC)
  kept.push(sample)
  while (kept.length > RATE_HISTORY_CAPACITY) kept.shift()
  return kept
}

/**
 * The feedback layer's entire memory. It lives here, in a value the caller owns and threads, rather
 * than in a module variable: `journeyControlStep` has to be replayable, and two identical sequences
 * of inputs have to produce two identical sequences of outputs or none of the tests below mean
 * anything. There is no hidden state anywhere in this file.
 */
export interface JourneyControlState {
  /** The accumulated integral term, in °C/min of wanted rate. Cleared only at roast start. */
  integralRateCPerMin: number
  /** The timestamp the last integration ran at, so `dt` comes from the samples and not from a guess. */
  lastSampleSec?: number
  /**
   * Which zone the roast is IN. Advanced by attainment and by nothing else, so it can lag the plan's
   * clock indefinitely. It never moves backwards.
   */
  zoneIndex: number
  /**
   * When the roast actually entered that zone - the anchor the in-zone target is measured from. It
   * is what makes the plan's time axis stretch at boundaries instead of re-planning inside a zone.
   */
  zoneEntrySec: number
  /** Last journey Heat actually commanded. Absent until the first solve, which remains immediate. */
  lastCommandHeat?: number
  /** Separate from the measurement clock so holdover commands still advance the slew state. */
  lastCommandSec?: number
  /** The measured samples the rate estimate (6)/(7) reads over, oldest first. */
  rateHistory: RateSample[]
}

/**
 * A roast starts in zone 0 at time zero with no accumulated correction. This is the ONLY place the
 * integral is cleared and the ONLY place the zone anchor is reset.
 */
export const initialJourneyControlState = (): JourneyControlState => ({
  integralRateCPerMin: 0,
  zoneIndex: 0,
  zoneEntrySec: 0,
  rateHistory: [],
})

/**
 * Shape Journey Heat only. Fan follows the solve IMMEDIATELY — increases, reductions and cooling
 * alike; there is no gradual-reduction limit and no reduced-airflow retention.
 * Heat keeps its symmetric positive-to-positive bound. Manual and timed commands bypass this
 * function. If the slew holds Heat above zero after the solve asked for less, the universal
 * heat-on Fan floor still applies to the pair actually commanded.
 */
const slewLimitedJourneyCommand = (
  state: JourneyControlState,
  elapsedSec: number,
  zone: ThermalSegment | undefined,
  unconstrained: JourneyCommand,
): JourneyCommand => {
  const rawHeat = unconstrained.heat
  const base = { ...unconstrained, unconstrainedHeat: rawHeat, heatSlewLimited: false }
  if (unconstrained.cooling) return base
  if (state.lastCommandHeat === undefined || state.lastCommandSec === undefined) return base

  const stepSec = Math.min(MAX_HEAT_SLEW_STEP_SEC, Math.max(0, elapsedSec - state.lastCommandSec))
  const maxDelta = MAX_HEAT_SLEW_PER_SEC * stepSec
  let heat = clamp(rawHeat, state.lastCommandHeat - maxDelta, state.lastCommandHeat + maxDelta)
  // A lower authored ceiling is a hard bound, not something the smoothing layer may exceed.
  heat = Math.min(heat, zone?.heatMax ?? 10)
  // Heat on means Fan 1.0 or higher on every command path. The solve already folds the rule into
  // its own pair; a slewed Heat that outlives a solved Heat of zero must not escape it.
  const fan = Math.max(unconstrained.fan, minimumFanForHeat(heat))
  if (Math.abs(heat - rawHeat) <= 1e-9) return { ...base, fan, heat }

  const limitingRise = rawHeat > heat
  return {
    ...base,
    fan,
    heat,
    heatSlewLimited: true,
    saturatedHigh: base.saturatedHigh || limitingRise,
    saturatedLow: base.saturatedLow || !limitingRise,
  }
}

export interface JourneyStepInput {
  plan: JourneyPlan
  elapsedSec: number
  /** The measured bean temperature. Non-finite means the reading is missing; see `holdover`. */
  beanTempC: number
  ambientC: number
  batchMassG: number
  calibration: CalibrationSettings
}

/** What the rate feedback saw and did on one step; NaN rates mean there was not yet enough history. */
export interface RateFeedback {
  measuredRateCPerMin: number
  predictedRateCPerMin: number
  /** `nominalRate - predictedRoR`; zero when no rate could be estimated. */
  rateErrorCPerMin: number
  /** `TRACKING_RATE_GAIN x rateErrorCPerMin`, the term added to P and I before the clamp. */
  rateRatePerMin: number
}

export interface JourneyStepResult {
  /** The state to thread into the next step. The input state is never mutated. */
  state: JourneyControlState
  /** What was actually commanded: feed-forward plus the correction. */
  command: JourneyCommand
  /** What the model ALONE would have said. The difference between the two is the measured residual. */
  feedForward: JourneyCommand
  correction: ControlCorrection
  rate: RateFeedback
  /** The zone this step was controlled in, and when the roast entered it. */
  zoneIndex: number
  zoneEntrySec: number
  /** True when THIS step is the one that attained the previous zone's endpoint. */
  zoneAdvanced: boolean
  /**
   * Whether the zone this step ran in has now been attained. For every zone but the last this is
   * false by construction - an attained zone was left in the same step - so it is really the signal
   * that the JOURNEY is done. The controller does nothing with it: a live roast simply keeps holding
   * the endpoint, which is correct. It is the simulation's terminal condition.
   */
  zoneCompleted: boolean
}

const NO_RATE_FEEDBACK: RateFeedback = {
  measuredRateCPerMin: Number.NaN,
  predictedRateCPerMin: Number.NaN,
  rateErrorCPerMin: 0,
  rateRatePerMin: 0,
}

/**
 * One closed-loop control step: feed-forward from the calibration, PI feedback on the zone's own
 * nominal ramp plus lag-compensated rate feedback, anchored where the roast actually entered the
 * zone.
 *
 * The order matters and is worth stating, because it is the anti-windup rule.
 *
 *   0. The zone anchor is advanced first, by ATTAINMENT only (`advanceZoneAnchor`). Everything after
 *      this point - the target, the zone's Fan and Heat band, the error - belongs to the zone the
 *      roast has actually earned, not to the zone a clock says it should be in.
 *   1. `dt` comes from the sample timestamps, guarded (see `MAX_INTEGRATION_STEP_SEC`). The same
 *      continuity test decides whether the rate history survives into this step.
 *   2. The integral is tentatively advanced by `Ki x e x dt` and clamped; the rate term is read
 *      from the history, (6)/(7).
 *   3. The inversion is solved with the resulting correction.
 *   4. If that command turns out to be saturated IN THE DIRECTION THE CORRECTION WAS PUSHING - heat
 *      pinned at the zone maximum while the roast is behind, heat at its floor with the fan wide
 *      open while the roast is ahead, or the correction clamp itself binding - the tentative
 *      integration is DISCARDED and the command re-solved with the integral the step started with.
 *
 * That is conditional integration, and step 4 is why: an integrator that keeps accumulating against
 * an actuator that cannot respond is storing up an overshoot it will pay for the moment the plant
 * comes back into range. Re-solving is one extra closed-form pass, no search and no iteration.
 *
 * **A missing measurement is a holdover, not a zero.** If `beanTempC` is not finite there is no
 * error to act on, so the correction is dropped to zero, the integral is frozen exactly as it was,
 * and the inversion is solved against the PLAN's own temperature - the model running open loop on
 * its own plan, which is the honest meaning of "feed-forward only". Substituting the last good
 * reading was rejected: a stale temperature drives a confident wrong correction, and a dropout that
 * lasts is precisely when that correction would be most wrong. Recovery needs no special case,
 * because the integral was never disturbed and the rate history is purged by the gap rule if the
 * dropout outlasted it.
 */
export const journeyControlStep = (state: JourneyControlState, input: JourneyStepInput): JourneyStepResult => {
  const { plan, elapsedSec, beanTempC, ambientC, batchMassG, calibration } = input
  const measured = Number.isFinite(beanTempC)
  const startingIntegral = state.integralRateCPerMin

  /*
   * Zone advancement happens first, and it happens on the MEASUREMENT. A blind step cannot observe
   * an arrival, so `advanceZoneAnchor` leaves the anchor exactly where it was - the same holdover
   * rule the integral follows, for the same reason.
   */
  const anchor = advanceZoneAnchor(
    plan,
    { zoneIndex: state.zoneIndex, zoneEntrySec: state.zoneEntrySec },
    elapsedSec,
    beanTempC,
  )
  const zoneAdvanced = anchor.zoneIndex !== state.zoneIndex
  const zone = anchoredZone(plan, anchor.zoneIndex)
  const goalC = anchoredTargetC(plan, anchor, elapsedSec)
  const completedNow =
    zone !== undefined && measured && zoneCompleted(zone, beanTempC, elapsedSec - anchor.zoneEntrySec)

  const solve = (rateCorrectionCPerMin: number, temperatureC: number) =>
    journeyCommand({
      plan,
      elapsedSec,
      beanTempC: temperatureC,
      ambientC,
      batchMassG,
      calibration,
      rateCorrectionCPerMin,
      zoneAnchor: anchor,
    })

  // The model's own answer, always computed, always recorded. It is the baseline the correction is
  // the residual against, so it is solved at the same temperature the applied command is.
  const modelTemperatureC = measured ? beanTempC : goalC
  const feedForward = solve(0, modelTemperatureC)
  const applySlew = (unconstrained: JourneyCommand) => slewLimitedJourneyCommand(state, elapsedSec, zone, unconstrained)

  if (!measured) {
    const command = applySlew(feedForward)
    return {
      state: {
        integralRateCPerMin: startingIntegral,
        lastSampleSec: state.lastSampleSec,
        lastCommandHeat: command.heat,
        lastCommandSec: elapsedSec,
        rateHistory: state.rateHistory,
        ...anchor,
      },
      command,
      feedForward,
      correction: {
        errorC: 0,
        proportionalRatePerMin: 0,
        integralRatePerMin: startingIntegral,
        totalRatePerMin: 0,
        saturated: false,
        holdover: true,
      },
      rate: NO_RATE_FEEDBACK,
      zoneIndex: anchor.zoneIndex,
      zoneEntrySec: anchor.zoneEntrySec,
      zoneAdvanced,
      zoneCompleted: completedNow,
    }
  }

  const errorC = goalC - beanTempC
  const proportionalRatePerMin = TRACKING_KP_RATE_PER_C * errorC

  // `dt` from the samples. A first step, a step that went backwards in time, and a step across a
  // gap the control did not observe all integrate nothing.
  const rawDtSec = state.lastSampleSec === undefined ? 0 : elapsedSec - state.lastSampleSec
  const observed = rawDtSec > 0 && rawDtSec <= STALE_SAMPLE_GAP_SEC
  const dtSec = observed ? Math.min(rawDtSec, MAX_INTEGRATION_STEP_SEC) : 0
  // A cooling zone always commands Fan 10 / Heat 0 whatever the correction says, so there is nothing
  // for the integral to act on there. Accumulating anyway could carry up to the clamp into a heating
  // zone authored after a cooling one; the integral is held as it entered.
  const mayIntegrate = elapsedSec >= INTEGRAL_HOLDOFF_SEC && dtSec > 0 && !feedForward.cooling

  const integralGainPerSec = TRACKING_KP_RATE_PER_C / Math.max(1, TRACKING_INTEGRAL_TIME_SEC)
  const advancedIntegral = mayIntegrate
    ? clampIntegral(startingIntegral + integralGainPerSec * errorC * dtSec)
    : startingIntegral

  // The rate history survives only across a continuous stretch of samples: a stale gap or a clock
  // that went backwards means the trend across it was never observed, so it is not pretended.
  const continuous = state.lastSampleSec === undefined || (rawDtSec >= 0 && rawDtSec <= STALE_SAMPLE_GAP_SEC)
  const history = continuous ? state.rateHistory : []
  const now: RateSample = { sec: elapsedSec, tempC: beanTempC }
  const estimate = predictedRate(history, now)
  const rate: RateFeedback =
    estimate === undefined
      ? NO_RATE_FEEDBACK
      : (() => {
          const rateErrorCPerMin = feedForward.requiredRateCPerMin - estimate.predictedCPerMin
          return {
            measuredRateCPerMin: estimate.measuredCPerMin,
            predictedRateCPerMin: estimate.predictedCPerMin,
            rateErrorCPerMin,
            rateRatePerMin: TRACKING_RATE_GAIN * rateErrorCPerMin,
          }
        })()
  const rateHistory = appendRateSample(history, now)

  /**
   * A correction is "blocked" when the plant cannot move any further the way the correction is
   * pushing. The clamp binding counts: a correction welded to its own limit cannot be improved by
   * accumulating more of it either.
   */
  const blocked = (rateCPerMin: number, solved: JourneyCommand) => {
    if (rateCPerMin > 0 && (solved.saturatedHigh || rateCPerMin >= MAX_CORRECTION_C_PER_MIN)) return true
    return rateCPerMin < 0 && (solved.saturatedLow || rateCPerMin <= -MAX_COOLING_CORRECTION_C_PER_MIN)
  }

  const totalWith = (integral: number) => clampCorrection(proportionalRatePerMin + rate.rateRatePerMin + integral)

  let integralRatePerMin = advancedIntegral
  let totalRatePerMin = totalWith(integralRatePerMin)
  let command = applySlew(solve(totalRatePerMin, beanTempC))
  const integrationBlocked = blocked(totalRatePerMin, command)
  // Slew is transient actuator shaping, not evidence that the calibrated plant is infeasible.
  // It still blocks the integrator, but only an underlying zone/authority clamp is reported as
  // saturation to the post-roast residual analysis.
  const saturated =
    integrationBlocked && (!command.heatSlewLimited || command.saturated || correctionAtBound(totalRatePerMin))

  const integralDelta = integralRatePerMin - startingIntegral
  const accumulationPushesIntoBlock =
    integrationBlocked && integralDelta !== 0 && Math.sign(integralDelta) === Math.sign(totalRatePerMin)

  if (accumulationPushesIntoBlock) {
    // Conditional integration freezes only accumulation that pushes farther into the bound. Error
    // in the opposite direction must be allowed to unwind an existing integral even while the
    // resulting command is still saturated; otherwise a pinned +8 or -8 term can never recover.
    // The command stays saturated either way, so the flag is not recomputed.
    integralRatePerMin = startingIntegral
    totalRatePerMin = totalWith(integralRatePerMin)
    command = applySlew(solve(totalRatePerMin, beanTempC))
  }

  return {
    state: {
      integralRateCPerMin: integralRatePerMin,
      lastSampleSec: elapsedSec,
      lastCommandHeat: command.heat,
      lastCommandSec: elapsedSec,
      rateHistory,
      ...anchor,
    },
    command,
    feedForward,
    correction: {
      errorC,
      proportionalRatePerMin,
      integralRatePerMin,
      totalRatePerMin,
      saturated,
      holdover: false,
    },
    rate,
    zoneIndex: anchor.zoneIndex,
    zoneEntrySec: anchor.zoneEntrySec,
    zoneAdvanced,
    zoneCompleted: completedNow,
  }
}

/**
 * The steady-state temperature a pair holds at, from the same balance the inversion solves. Exposed
 * because it is the honest way to explain a saturated zone: "at these limits this pair settles at
 * X, and the zone asks for Y".
 */
export const modelledSteadyStateC = (
  { fan, heat, batchMassG, ambientC }: { fan: number; heat: number; batchMassG: number; ambientC: number },
  calibration: CalibrationSettings,
) => {
  void batchMassG // Thermal capacity changes time-to-target, not the equilibrium energy balance.
  const heating = (heat / 10) * calibration.heaterGainCPerMinAt10
  const airflow = (fan / 10) * calibration.fanCoolingCPerMinAt10
  if (calibration.thermalLossPerMinPerC <= 0) return Number.POSITIVE_INFINITY
  return ambientC + (PLANT_BIAS_C_PER_MIN + heating - airflow) / calibration.thermalLossPerMinPerC
}

/**
 * The verdict a temperature-gated zone makes unavoidable: **can this zone ever be left?**
 *
 * Under the old clock-gated advance an unreachable endpoint merely produced a large deviation and
 * the roast moved on. Under attainment it does not move on at all, so the question has to be asked
 * outright rather than discovered by waiting.
 *
 * A rising zone's best safe case is maximum heat at the greater of its authored minimum, the
 * full-airflow-through-130 floor, and the universal heat-on Fan 1.0 rule (via `effectiveLevels`).
 * `modelledSteadyStateC` is the temperature that pair settles at. A cooling zone's floor is
 * ambient, because the plant is never modelled below it.
 */
export const zoneFeasibility = (
  zone: ThermalSegment,
  { batchMassG, ambientC }: { batchMassG: number; ambientC: number },
  calibration: CalibrationSettings,
) => {
  const rising = zone.endC >= zone.startC
  if (!rising) {
    return { rising, reachableC: ambientC, infeasible: zone.endC < ambientC }
  }
  const circulationFloor = journeyCirculationFloor(zone.endC)
  const best = effectiveLevels({
    fan: Math.max(Math.min(zone.fanMin, zone.fanMax), circulationFloor),
    heat: Math.max(zone.heatMin, zone.heatMax),
  })
  const reachableC = modelledSteadyStateC({ fan: best.fan, heat: best.heat, batchMassG, ambientC }, calibration)
  return { rising, reachableC, infeasible: zone.endC > reachableC }
}
