/**
 * The simulated roaster and the simulated MAX31856.
 *
 * ============================================================================================
 * THE PLANT: ONE CHAMBER, TWO LOAD REGIMES, TWO MASSES
 * ============================================================================================
 *
 * There is one simulated machine here, and it is asked to do two quite different jobs. A baseline
 * calibration pass drives an EMPTY chamber over a fan x heat grid; a journey roast drives the same
 * chamber with a couple of hundred grams of green coffee in it. Those are not the same plant, and the
 * app spends real effort saying so - `calibrationProvenance.ts` calls the difference out by name, and
 * `roastPreflight` refuses to descend from a bean model to a chamber fit because a chamber fit is on
 * another scale entirely. A mock that ran both regimes off one set of coefficients would make that
 * warning describe nothing.
 *
 * So the plant carries a LOAD, and it carries two thermal masses.
 *
 *   **Empty chamber** (no roast running: calibration, manual, a heater proof). The physics is
 *   `src/data/chamberPlant.ts`, shared with the demo dataset's seeded baseline passes so the air map
 *   the mock produces and the air map the library ships are the same machine. Fast, hot, lossy: rise
 *   time constants of 94 s at fan 10 out to ~170 s at fan 1, a settled surface running from about
 *   40 C at fan 10 / heat 1 to the high 280s at the floored fan 1.34 / heat 10, and a passive-decay
 *   loss around 0.22 C/min/C - a third again the bean model's 0.17.
 *
 *   **Loaded** (a roast is running or its passive recording tail still has the batch in). The bean
 *   model the app itself inverts, driven by the SAME equation `thermalStep` uses and the SAME
 *   coefficients `estimatedBaseline.ts` ships, deliberately weakened by `PLANT_HEATER_SCALE`:
 *
 *       heating: dT/dt = capacityScale x (4 + heating - airflow - loss x (T - ambient))
 *       forced cooling: dT/dt = -capacityScale x max(8, (fan/10) x coolingFan + loss x (T - ambient))
 *
 *   A bean load is slow: one time constant near six minutes at every operating point, which is what
 *   a couple of hundred grams of coffee does to a chamber that on its own settles in under two.
 *
 * **The wall is shared, because it is the same chamber either way.** The glass, the base and the
 * element assembly are one slow mass that both regimes heat and both regimes rebound toward. It is
 * the second node, and the only reason the plant can do the one thing a single first-order chamber
 * cannot: when the fan STOPS, the probe climbs back before it decays, because stored wall heat is no
 * longer being carried out of the top. `afterRebound` in `thermalLog.ts` exists to trim exactly that
 * first ~30 s, the firmware's three-minute recording tail was sized against it, and a plant without
 * one leaves that whole path unexercised in the dev app. With a bean load in the way the same wall
 * drives the same rebound a quarter as hard (`LOADED_WALL_COUPLING_SCALE`), because a bean bed does
 * not equilibrate with a chamber wall the way a few grams of still air does.
 *
 * **The deliberate model-versus-plant offset is unchanged.** `wallToAir` is ~0 at every airflow a
 * roast ever runs at, so the loaded regime's disagreement with the app's model is still exactly the
 * documented `PLANT_HEATER_SCALE` gain error and nothing else. In-roast corrections stay visibly
 * nonzero, and they stay attributable.
 *
 * The plant is integrated with NO lag: `trueC` is the chamber, and lag belongs to the probe.
 *
 * ============================================================================================
 * THE THERMOCOUPLE
 * ============================================================================================
 *
 * A MAX31856 on a probe in a moving air stream does not report the chamber, it reports the probe,
 * and the probe is a thermal mass with its own time constant. So the sensor is a first-order lag of
 * about 5 s (`sensorLagSec`, taken from the shipped calibration rather than invented here) on the
 * true temperature, plus a small band of noise.
 *
 * The noise is added to the REPORTED value and never integrated back into the state, so it stays
 * noise instead of becoming a random walk that would slowly cook the simulated batch.
 *
 * The cold junction is the board, not the room: it sits a little above ambient and warms slowly
 * toward the chamber while the roaster is hot, with a five-minute time constant. That is the drift
 * the firmware's "ambient is frozen at roast start" rule exists to defend against, so the mock has
 * to actually have it or the rule has nothing to demonstrate.
 */

import { chamberAirRateCPerMin, LOADED_WALL_COUPLING_SCALE, stepWallC, wallToAirPerMin } from '../src/data/chamberPlant'
import { MINIMUM_MODELLED_COOLING_C_PER_MIN, PLANT_BIAS_C_PER_MIN } from '../src/domain/journeyControl'
import { thermalPlantMode } from '../src/domain/thermalModel'
import { AMBIENT_C, BASELINE, BASELINE_MASS_G, PLANT_HEATER_SCALE, SENSOR_LAG_SEC, SENSOR_NOISE_C } from './config'

/** Deterministic noise. A mock that is not reproducible is a mock that cannot be reasoned about. */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** How fast the board's cold junction follows the chamber, and how far. */
const COLD_JUNCTION_LAG_SEC = 300
const COLD_JUNCTION_OFFSET_C = 1.5
const COLD_JUNCTION_COUPLING = 0.035

export interface PlantDrive {
  /** The EFFECTIVE levels the actuator is really driving, floors already applied. */
  fan: number
  heat: number
  /**
   * The batch in the chamber, in grams, or undefined for an EMPTY chamber. Undefined is not "use the
   * reference mass": it selects the chamber-scale regime, which is a different plant, not the same
   * plant at a different weight.
   */
  batchMassG?: number
}

export class Plant {
  /** The chamber at bean-bed height. What a perfect, instantaneous probe would read. */
  trueC = AMBIENT_C
  /** The chamber mass: glass, base and element assembly. Never measured; the tail rebounds toward it. */
  wallC = AMBIENT_C
  /** The probe. What the MAX31856 reports, before noise. */
  probeC = AMBIENT_C
  coldJunctionC = AMBIENT_C + COLD_JUNCTION_OFFSET_C
  /** The chamber's rate of rise, C per minute. Reported for diagnostics; nothing controls on it. */
  rorCPerMin = 0
  /**
   * The reading, noise included, refreshed once per tick rather than once per caller. Two readers of
   * the same instant - a status poll and a live frame - have to see the same number, and a noise
   * sample taken per call would also make the sequence depend on how often the app happened to ask.
   */
  private reportedC = AMBIENT_C

  private readonly random = mulberry32(0x53523830)

  /**
   * The bean-scale branch: the app's own model, weakened by `PLANT_HEATER_SCALE`, plus the same wall
   * the empty chamber has - damped, because the probe is reading beans rather than air.
   */
  private loadedRateCPerMin(fan: number, heat: number, batchMassG: number): number {
    const overAmbient = Math.max(0, this.trueC - AMBIENT_C)
    const loss = overAmbient * BASELINE.thermalLossPerMinPerC
    const fromWall = wallToAirPerMin(fan) * LOADED_WALL_COUPLING_SCALE * (this.wallC - this.trueC)

    const capacityScale = BASELINE_MASS_G / Math.max(1, batchMassG)
    const mode = thermalPlantMode(fan, heat)
    if (mode === 'heating') {
      const heating = (heat / 10) * BASELINE.heaterGainCPerMinAt10 * PLANT_HEATER_SCALE
      const airflow = (fan / 10) * BASELINE.fanCoolingCPerMinAt10
      return capacityScale * Math.max(-5, PLANT_BIAS_C_PER_MIN + heating - airflow - loss + fromWall)
    }
    if (mode === 'forced-cooling') {
      const airflow = (fan / 10) * BASELINE.coolingFanCPerMinAt10
      return capacityScale * (-Math.max(MINIMUM_MODELLED_COOLING_C_PER_MIN, airflow + loss) + fromWall)
    }
    /*
     * Fan off, heat off. A mock ticks forever, and a chamber left alone has to decay toward the
     * room. This is the branch the recorded tail lives in, and the wall term is what makes it rebound
     * before it decays rather than falling from the first sample.
     */
    return capacityScale * (fromWall - loss)
  }

  step(dtSec: number, { fan, heat, batchMassG }: PlantDrive) {
    if (!(dtSec > 0)) return

    const rate =
      batchMassG === undefined
        ? chamberAirRateCPerMin({ airC: this.trueC, wallC: this.wallC }, { fan, heat, ambientC: AMBIENT_C })
        : this.loadedRateCPerMin(fan, heat, batchMassG)

    // The wall advances off the state the air node was solved at, so neither node leads the other.
    const wallC = stepWallC({ airC: this.trueC, wallC: this.wallC }, { fan, heat, ambientC: AMBIENT_C, dtSec })
    this.rorCPerMin = rate
    this.trueC = Math.max(AMBIENT_C, this.trueC + (rate * dtSec) / 60)
    this.wallC = wallC

    // The probe: a first-order lag on the chamber. This IS the simulated thermocouple.
    const probeResponse = 1 - Math.exp(-dtSec / Math.max(0.1, SENSOR_LAG_SEC))
    this.probeC += (this.trueC - this.probeC) * probeResponse

    // The board, warming inside the roaster over tens of minutes.
    const coldJunctionTarget =
      AMBIENT_C + COLD_JUNCTION_OFFSET_C + Math.max(0, this.trueC - AMBIENT_C) * COLD_JUNCTION_COUPLING
    const boardResponse = 1 - Math.exp(-dtSec / COLD_JUNCTION_LAG_SEC)
    this.coldJunctionC += (coldJunctionTarget - this.coldJunctionC) * boardResponse

    const noise = (this.random() - 0.5) * SENSOR_NOISE_C
    this.reportedC = Math.round((this.probeC + noise) * 100) / 100
  }

  /** The thermocouple reading, noise included. Rounded the way the firmware serializes it. */
  thermocoupleC(): number {
    return this.reportedC
  }

  coldJunctionReadingC(): number {
    return Math.round(this.coldJunctionC * 100) / 100
  }
}
