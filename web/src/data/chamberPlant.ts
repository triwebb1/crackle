/**
 * The EMPTY-CHAMBER physics of a simulated SR800, and the chamber-mass node both regimes share.
 *
 * ============================================================================================
 * WHY THIS EXISTS, AND WHY IT LIVES HERE
 * ============================================================================================
 *
 * Two things in this repository have to agree about what an empty SR800 chamber does: the mock
 * controller's plant (`web/dev/plant.ts`), which a developer drives through a real calibration pass,
 * and the rich demo dataset (`demoDataset.ts`), whose two seeded baseline passes are what the
 * Calibrate screens render before anybody has run anything. When those two disagreed, the app showed
 * one air map in its library and produced a different one from its own roaster, and neither was
 * recognisable as a fluid-bed roaster.
 *
 * So the physics is written once, here, and both consume it. The mock reads from `web/src` on
 * purpose - that is the established direction, the same way the plant already reads the actuator
 * floors and the journey control law rather than re-typing them - and nothing in the shipped app
 * imports this module. `demoDataset` is the only importer inside `src`, and it is reached solely
 * through the dynamic import behind `richSeedEnabled`, which `vite build` drops entirely. Nothing
 * here can reach a firmware-served bundle.
 *
 * ============================================================================================
 * THE MODEL: TWO NODES, BECAUSE ONE CANNOT REBOUND
 * ============================================================================================
 *
 * A single first-order node cannot produce the one behaviour the tail analysis is built around: when
 * the fan stops, a real probe climbs back before it decays, because the element and the chamber wall
 * are still hotter than the air and there is no longer any airflow carrying that stored heat out of
 * the top. `afterRebound` in `thermalLog.ts` exists to trim exactly that, and the three-minute
 * recording tail was sized against it. A plant with no rebound leaves that whole path unexercised.
 *
 * So there are two masses:
 *
 *   **The air** at bean-bed height, where the probe sits. Almost no mass; it is whatever the element
 *   and the wall are doing to the air stream right now.
 *
 *     dT/dt = drive(heat, fan) + wallToAir(fan) x (W - T) - airLoss(fan) x (T - ambient)
 *
 *   **The wall**: the glass chamber, the base, and the element assembly. Slow, and the only thing in
 *   the machine that stores enough heat to push a probe upward with everything switched off.
 *
 *     dW/dt = element(heat) + wallFromAir(fan) x (T - W) - WALL_LOSS x (W - ambient)
 *
 * Three of the coefficients are functions of airflow rather than constants, and that is the whole
 * difference between this and the app's own model:
 *
 *   - `airLoss(fan)` rises with airflow. Air carries the heat out, so the chamber both settles
 *     COOLER and settles FASTER as the fan opens. The app's model instead subtracts a fixed
 *     `fanCooling` offset and keeps one loss coefficient, which is why its rise time constant is the
 *     same at fan 1 and fan 10. That simplification is fine for a bean model over a narrow band of
 *     roasting airflow and visibly wrong across a whole baseline grid - and having the plant differ
 *     from the model in a STRUCTURED way is the point of a plant.
 *   - `absorb(fan)` raises how much element power the air stream actually picks up, because forced
 *     convection off the element improves with mass flow. Without it the fan-1 corner of the grid
 *     runs to absurd temperatures: heat is captured perfectly and then barely carried away.
 *   - `wallToAir(fan)` is the still-air path from the wall back to the probe, and it is swamped the
 *     moment the fan turns: with air moving, stored wall heat leaves through the top rather than
 *     reaching the probe. It is ~0 across the whole working grid and full-strength only with the fan
 *     off, which is exactly where the rebound is observed and nowhere else.
 *
 * ============================================================================================
 * WHAT ANCHORS THE NUMBERS
 * ============================================================================================
 *
 * Only one number here is MEASURED on the real machine, and it is treated as fixed:
 *
 *   **Forced-cooling tau ~94 s at fan 10**, salvaged from the first (otherwise invalid) baseline air
 *   map (`data/captures/sr800-thermal-2026-07-26-first-airmap-analysis.md`). With heat off the wall
 *   path is swamped and the air node is a plain exponential, so this pins
 *   `airLoss(10) = 60/94 = 0.638 °C/min per C` directly.
 *   `CHAMBER_LOSS_STILL_PER_MIN + CHAMBER_LOSS_FLOW_PER_MIN` is that number and nothing else, and
 *   every rise time constant in the grid follows from it - a first-order plant has one time constant
 *   per operating point, so the same coefficient that sets the cooling tail sets the rise.
 *
 * The rest are chosen to put the settled surface where an SR800 plausibly sits, with the same
 * analysis that condemned the first air map applied to the choices:
 *
 *   - Mid-grid, at the pairs an SR800 is actually roasted on (fan 5-8, heat 7-9), the chamber settles
 *     in the 180-220 °C band.
 *   - Full heat at low fan is genuinely hot - the high-280s - which is the corner the operator's
 *     measurement ceiling exists for. (The firmware's overheat limit ends a pass that reaches it.)
 *   - Heat 1 is a small rise, not a large one. The demo's previous air map put +96 °C on the board at
 *     heat 1, which is about a tenth of the element's power producing about half of its temperature.
 *   - Chamber air rises 2-3 °C/s mid-transient (the first air-map analysis, on why its settle
 *     band passed on slope). `CHAMBER_HEATER_C_PER_MIN_AT_10` is 130 °C/min, i.e. 2.2 °C/s at full
 *     heat and full flow, which lands inside that observed band.
 *
 * And the whole set is deliberately a DIFFERENT REGIME from the bean model in `estimatedBaseline.ts`,
 * which is the distinction the app spends real effort explaining. Run a pass through
 * `stageCalibration` and it derives a loss near 0.22 °C/min/C against the bean model's 0.17, and an
 * airflow term under half the bean model's - a chamber patch applied as a bean model then predicts a
 * roast settling some 50 °C cool. Replay a whole chamber pass against the bean model and the residual
 * is around 50 °C RMS. That gap is not an artefact to be tuned away: it is the reason a chamber patch
 * may never be applied as a bean model, and the demo has to actually contain it for the warning to
 * mean anything.
 * ============================================================================================
 */

/**
 * Airflow as a fraction of full, by fan level. The SR800's fan does not span 10:1 - a fluid bed has
 * to keep beans off the screen at level 1 - so level 1 is already about a third of full flow. A
 * linear map from that floor is as much shape as any of the available evidence supports.
 */
export const FAN_FLOW_FLOOR = 0.35

export const chamberAirflow = (fan: number): number =>
  fan <= 0 ? 0 : Math.min(1, FAN_FLOW_FLOOR + ((1 - FAN_FLOW_FLOOR) * fan) / 10)

/** How much element power the air stream picks up, normalised to 1 at full flow. */
export const CHAMBER_ABSORB_EXPONENT = 0.3

export const chamberAbsorption = (fan: number): number =>
  fan <= 0 ? 0 : chamberAirflow(fan) ** CHAMBER_ABSORB_EXPONENT

/** Anchored to the measured forced-cooling response: about 94 s at fan 10 and 170 s at fan 1. */
export const CHAMBER_LOSS_STILL_PER_MIN = 0.15
export const CHAMBER_LOSS_FLOW_PER_MIN = 0.488

export const chamberLossPerMin = (fan: number): number =>
  CHAMBER_LOSS_STILL_PER_MIN + CHAMBER_LOSS_FLOW_PER_MIN * chamberAirflow(fan)

/**
 * The air node's own time constant, which is the one a rise step or a cooling tail exhibits. Written
 * out because it is the number a reviewer checks a pass against: about 94 s at fan 10 is the development-device
 * anchor, and everything else follows from the same coefficient.
 */
export const chamberTauSec = (fan: number): number => 60 / chamberLossPerMin(fan)

/** Element authority into the air at heat 10 and full flow, in C per minute. */
export const CHAMBER_HEATER_C_PER_MIN_AT_10 = 132

/**
 * `elementScale` is the one per-machine, per-day knob: a fouled screen, a dusty element, a different
 * supply voltage. 1 is the nominal chamber. It exists so two passes months apart can differ by
 * something real rather than only by the room temperature, which is what a pass comparison is for.
 */
export const chamberDriveCPerMin = (fan: number, heat: number, elementScale = 1): number =>
  heat <= 0 ? 0 : (heat / 10) * CHAMBER_HEATER_C_PER_MIN_AT_10 * chamberAbsorption(fan) * elementScale

/**
 * The wall: element assembly, base and glass. It is heated directly by the element, exchanges with
 * the air stream at a rate that rises with airflow, and leaks slowly to the room.
 */
export const WALL_ELEMENT_C_PER_MIN_AT_10 = 30
export const WALL_AIR_STILL_PER_MIN = 0.15
export const WALL_AIR_FLOW_PER_MIN = 0.62
export const WALL_LOSS_PER_MIN = 0.24

export const wallFromAirPerMin = (fan: number): number =>
  WALL_AIR_STILL_PER_MIN + WALL_AIR_FLOW_PER_MIN * chamberAirflow(fan)

/**
 * The still-air path back from the wall to the probe, and the airflow that swamps it.
 *
 * The square, and the small swamp constant, are what keep it out of the working range entirely: it
 * is at 6% of its still-air value by fan 1, and under 0.5% by fan 4. So it perturbs no settled point
 * the calibration mesh will ever show, it leaves the loaded regime's disagreement with the app's
 * model exactly the documented heater-scale error and nothing else, and at fan 0 it is the whole
 * reason the tail rebounds. That is the physical claim as well as the numerical convenience: with
 * air moving, stored wall heat leaves through the top instead of reaching the probe.
 */
export const WALL_TO_AIR_STILL_PER_MIN = 3
export const WALL_TO_AIR_FAN_SWAMP = 0.25

export const wallToAirPerMin = (fan: number): number =>
  WALL_TO_AIR_STILL_PER_MIN / (1 + (Math.max(0, fan) / WALL_TO_AIR_FAN_SWAMP) ** 2)

/**
 * A loaded chamber's probe reads BEANS, and a bean mass does not equilibrate with the chamber wall
 * the way a few grams of still air does. The same wall drives the same rebound in a roast's tail at
 * about a third of the strength, and correspondingly later and smaller - roughly a degree, against
 * the empty chamber's ten - which is what a bean bed does.
 */
export const LOADED_WALL_COUPLING_SCALE = 0.35

export interface ChamberNodes {
  /** The air at bean-bed height. What a perfect, instantaneous probe would read. */
  airC: number
  /** The chamber mass. Never measured directly; it is what the tail rebounds toward. */
  wallC: number
}

/**
 * The wall's own step. Shared by both load regimes, because it is the same chamber either way: only
 * what the probe is sitting in changes.
 */
export interface ChamberDrive {
  fan: number
  heat: number
  ambientC: number
  dtSec: number
  elementScale?: number
}

export const stepWallC = (
  nodes: ChamberNodes,
  { fan, heat, ambientC, dtSec, elementScale = 1 }: ChamberDrive,
): number => {
  const rate =
    (heat / 10) * WALL_ELEMENT_C_PER_MIN_AT_10 * elementScale +
    wallFromAirPerMin(fan) * (nodes.airC - nodes.wallC) -
    WALL_LOSS_PER_MIN * (nodes.wallC - ambientC)
  return Math.max(ambientC, nodes.wallC + (rate * dtSec) / 60)
}

/** The empty chamber's air node: element drive, the still-air wall path, and airflow losses. */
export const chamberAirRateCPerMin = (
  nodes: ChamberNodes,
  { fan, heat, ambientC, elementScale = 1 }: Omit<ChamberDrive, 'dtSec'>,
): number =>
  chamberDriveCPerMin(fan, heat, elementScale) +
  wallToAirPerMin(fan) * (nodes.wallC - nodes.airC) -
  chamberLossPerMin(fan) * (nodes.airC - ambientC)

/** One integration step of the empty chamber. Both nodes advance off the same starting state. */
export const stepChamber = (nodes: ChamberNodes, drive: ChamberDrive): ChamberNodes => ({
  airC: Math.max(drive.ambientC, nodes.airC + (chamberAirRateCPerMin(nodes, drive) * drive.dtSec) / 60),
  wallC: stepWallC(nodes, drive),
})

/**
 * Where a pair settles, in closed form, with both nodes at rest. This is the surface a baseline pass
 * measures, and it is written out rather than only simulated so a reviewer can check a mesh point by
 * hand. Solving the wall row for W and substituting gives
 *
 *     T - ambient = (drive + wallToAir x element / (wallFromAir + wallLoss))
 *                 / (airLoss + wallToAir x wallLoss / (wallFromAir + wallLoss))
 */
export const chamberSteadyStateC = (fan: number, heat: number, ambientC: number, elementScale = 1): number => {
  if (heat <= 0) return ambientC
  const wallTotal = wallFromAirPerMin(fan) + WALL_LOSS_PER_MIN
  const toAir = wallToAirPerMin(fan)
  const numerator =
    chamberDriveCPerMin(fan, heat, elementScale) +
    (toAir * (heat / 10) * WALL_ELEMENT_C_PER_MIN_AT_10 * elementScale) / wallTotal
  const denominator = chamberLossPerMin(fan) + (toAir * WALL_LOSS_PER_MIN) / wallTotal
  return ambientC + numerator / denominator
}
