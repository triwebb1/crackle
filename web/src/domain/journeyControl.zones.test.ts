import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterThermalIntent } from '../data/demo'
import { effectiveLevels } from './actuatorFloors'
import { type JourneyZoneRow, summarizeJourneyZones, zoneRoles } from './controlResidual'
import {
  initialJourneyControlState,
  journeyControlStep,
  journeyPlan,
  ZONE_HOLD_EPSILON_C,
  zoneAttained,
  zoneCompleted,
  zoneFeasibility,
  zoneTargetC,
} from './journeyControl'
import { simulateJourney } from './profileSimulation'
import { roastRuntimeEnvelopeSec } from './roastProgram'
import { thermalStep } from './thermalModel'
import type { CalibrationSettings, ControlCorrection, ThermalIntent, ThermalSegment } from './types'

/**
 * The core principle of a temperature journey, made into acceptance criteria: the roast stays in a
 * zone until that zone's target temperature is reached. It tries to get there in the authored time,
 * but arrival is guaranteed.
 *
 * Same harness as `journeyControl.pi.test.ts` and for the same reason: the plant runs one coefficient
 * set and the controller inverts another, because a control law verified only against a model of
 * itself has been verified against nothing.
 */
const AMBIENT_C = 24.5

const intentOf = (segments: ThermalSegment[]): ThermalIntent => ({ ...starterThermalIntent, id: 'zone-test', segments })

interface ZoneRow {
  elapsedSec: number
  /**
   * The temperature the STEP was handed, which is the one zone advancement was decided on. A
   * controller acts on the last measurement, here as in a roast, so this is the honest column for
   * "what had the roast attained when this decision was taken".
   */
  observedC: number
  /** The temperature the plant produced during this second. */
  beanTempC: number
  /** The target the control was holding: the zone's nominal ramp from its ACTUAL entry. */
  goalC: number
  zoneIndex: number
  zoneEntrySec: number
  holdingAtZoneEnd: boolean
  correction: ControlCorrection
  fan: number
  heat: number
}

const runClosedLoop = ({
  intent,
  truth,
  model,
  seconds,
}: {
  intent: ThermalIntent
  truth: CalibrationSettings
  model: CalibrationSettings
  seconds: number
}): ZoneRow[] => {
  const plan = journeyPlan(intent)
  const batchMassG = truth.referenceBatchMassG
  let state = initialJourneyControlState()
  let beanTempC = intent.segments[0].startC
  let rorCPerMin: number | undefined
  const rows: ZoneRow[] = []

  for (let elapsedSec = 0; elapsedSec <= seconds; elapsedSec += 1) {
    const observedC = beanTempC
    const step = journeyControlStep(state, {
      plan,
      elapsedSec,
      beanTempC,
      ambientC: AMBIENT_C,
      batchMassG,
      calibration: model,
    })
    state = step.state
    const levels = effectiveLevels({ fan: step.command.fan, heat: step.command.heat })
    const result = thermalStep(
      {
        previousBeanTempC: beanTempC,
        previousRorCPerMin: rorCPerMin,
        fan: levels.fan,
        heat: levels.heat,
        cooling: step.command.cooling,
        batchMassG,
        ambientC: AMBIENT_C,
      },
      truth,
    )
    beanTempC = result.beanTempC
    rorCPerMin = result.rorCPerMin
    rows.push({
      elapsedSec,
      observedC,
      beanTempC,
      goalC: step.command.goalC,
      zoneIndex: step.zoneIndex,
      zoneEntrySec: step.zoneEntrySec,
      holdingAtZoneEnd: step.command.holdingAtZoneEnd,
      correction: step.correction,
      fan: levels.fan,
      heat: levels.heat,
    })
  }
  return rows
}

const firstIn = (rows: ZoneRow[], zoneIndex: number) => rows.find((row) => row.zoneIndex === zoneIndex)

describe('a zone is left by attainment, never by a clock', () => {
  /*
   * Zone 1 asks for 175 °C in 110 s - 95 °C/min - and heat 10 at the fan floor is worth about 62 °C/min
   * at charge temperature, falling as the roast heats. It cannot be followed, so the zone runs roughly
   * twice its nominal length. Zone 2 is a gentle development the plant reaches easily.
   */
  const behindSchedule = intentOf([
    { id: 'ramp', startC: 25, endC: 200, durationSec: 110, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
    { id: 'develop', startC: 200, endC: 215, durationSec: 300, fanMin: 4, fanMax: 10, heatMin: 1, heatMax: 10 },
  ])
  const rows = runClosedLoop({
    intent: behindSchedule,
    truth: defaultCalibration,
    model: defaultCalibration,
    seconds: 700,
  })
  const entry = firstIn(rows, 1)!

  it('really is behind schedule, or the test proves nothing', () => {
    const atNominal = rows.find((row) => row.elapsedSec === 110)!
    expect(atNominal.beanTempC).toBeLessThan(160)
    // Twice its nominal length, and more: the overrun is the reading, not a fault.
    expect(entry.elapsedSec).toBeGreaterThan(220)
  })

  it('stays in zone 1 long past its nominal duration, until 200 °C is actually reached', () => {
    for (const row of rows.filter((candidate) => candidate.elapsedSec < entry.elapsedSec)) {
      expect(row.zoneIndex).toBe(0)
      expect(row.observedC).toBeLessThan(200)
    }
    // Not one step of zone 2 was ever taken on a temperature that had not earned it.
    expect(rows.filter((row) => row.zoneIndex === 1 && row.observedC < 200)).toHaveLength(0)
  })

  it('holds the target at the zone endpoint once the nominal ramp is spent', () => {
    const holding = rows.filter((row) => row.zoneIndex === 0 && row.elapsedSec >= 110)
    expect(holding.length).toBeGreaterThan(100)
    for (const row of holding) {
      expect(row.goalC).toBeCloseTo(200, 6)
      expect(row.holdingAtZoneEnd).toBe(true)
    }
    // And the loop keeps pushing toward it the whole time rather than settling for where it is.
    expect(holding.every((row) => row.correction.totalRatePerMin > 0)).toBe(true)
  })

  it('anchors zone 2 at the ACTUAL entry and at zone 1 END temperature, not at the plan clock', () => {
    expect(entry.zoneEntrySec).toBe(entry.elapsedSec)
    // The plan says zone 2 begins at 110 s; the roast says it begins where it arrived.
    expect(entry.zoneEntrySec).toBeGreaterThan(220)
    expect(entry.goalC).toBeCloseTo(200, 1)
    // Nominal slope from there: 15 °C over 300 s, measured from the real entry and nothing else.
    const later = rows.find((row) => row.elapsedSec === entry.elapsedSec + 150)!
    expect(later.zoneIndex).toBe(1)
    expect(later.goalC).toBeCloseTo(200 + 15 * (150 / 300), 4)
  })

  it('advances within one sample of attainment', () => {
    const previous = rows[rows.indexOf(entry) - 1]
    expect(previous.zoneIndex).toBe(0)
    expect(previous.observedC).toBeLessThan(200)
    // The step that saw 200 °C is the step that moved on. There is no dwell and no hysteresis: the
    // sample immediately before the boundary had already crossed, and the very next step acted on it.
    expect(previous.beanTempC).toBeGreaterThanOrEqual(200)
    expect(entry.observedC).toBeGreaterThanOrEqual(200)
    expect(entry.elapsedSec - previous.elapsedSec).toBe(1)
  })

  it('never moves the zone backwards, however the roast wanders', () => {
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].zoneIndex).toBeGreaterThanOrEqual(rows[index - 1].zoneIndex)
    }
  })
})

describe('attainment is direction-aware', () => {
  const cooling: ThermalSegment = {
    id: 'cool',
    startC: 210,
    endC: 40,
    durationSec: 180,
    fanMin: 3,
    fanMax: 10,
    heatMin: 0,
    heatMax: 0,
  }
  const rising: ThermalSegment = {
    id: 'rise',
    startC: 25,
    endC: 150,
    durationSec: 210,
    fanMin: 4,
    fanMax: 9,
    heatMin: 3,
    heatMax: 9,
  }

  it('completes a rising zone from below and a cooling zone from above', () => {
    expect(zoneAttained(rising, 149.9)).toBe(false)
    expect(zoneAttained(rising, 150)).toBe(true)
    expect(zoneAttained(cooling, 40.1)).toBe(false)
    expect(zoneAttained(cooling, 40)).toBe(true)
    // A cooling zone is emphatically NOT completed by being hot, which a direction-blind test would.
    expect(zoneAttained(cooling, 300)).toBe(false)
  })

  // The simulated plant always charges from ambient, so a journey has to start there to mean anything.
  const coolingJourney = intentOf([
    { id: 'charge', startC: 25, endC: 205, durationSec: 400, fanMin: 4, fanMax: 9, heatMin: 1, heatMax: 9 },
    { ...cooling, startC: 205, endC: 90, durationSec: 240 },
    // 10 °C over 300 s is 2 °C/min, and `thermalStep` never models cooling slower than 8 °C/min. The
    // plant cannot help but beat this zone, so it must ARRIVE EARLY.
    { id: 'rest', startC: 90, endC: 80, durationSec: 300, fanMin: 3, fanMax: 10, heatMin: 0, heatMax: 0 },
  ])

  it('leaves a cooling zone the moment the roast falls to its target, and not before', () => {
    const rows = runClosedLoop({
      intent: coolingJourney,
      truth: defaultCalibration,
      model: defaultCalibration,
      seconds: 900,
    })
    const entry = firstIn(rows, 2)!
    expect(entry.observedC).toBeLessThanOrEqual(90)
    // Every single step of the cooling zone was taken while the roast was still above its target.
    for (const row of rows.filter((candidate) => candidate.zoneIndex === 1)) expect(row.observedC).toBeGreaterThan(90)
    expect(entry.elapsedSec).toBe(entry.zoneEntrySec)
  })

  it('compresses the time axis when a zone arrives early, exactly as it stretches when one is late', () => {
    const run = simulateJourney({ profile: coolingJourney, calibration: defaultCalibration, massG: 225 })
    const rest = run.zones[2]
    expect(rest.attained).toBe(true)
    expect(rest.nominalDurationSec).toBe(300)
    // Arrival is what moves the axis, and it moves it in both directions.
    expect(rest.simulatedDurationSec).toBeLessThan(120)
    expect(rest.overrunSec).toBeLessThan(-180)
  })

  it('lets a hold zone - which has no temperature to attain - be decided by its duration', () => {
    const hold: ThermalSegment = {
      id: 'soak',
      startC: 180,
      endC: 180,
      durationSec: 90,
      fanMin: 4,
      fanMax: 9,
      heatMin: 1,
      heatMax: 9,
    }
    expect(Math.abs(hold.endC - hold.startC)).toBeLessThan(ZONE_HOLD_EPSILON_C)
    expect(zoneCompleted(hold, 180, 89)).toBe(false)
    expect(zoneCompleted(hold, 500, 89)).toBe(false)
    expect(zoneCompleted(hold, 180, 90)).toBe(true)
    const epsilonHold = { ...hold, endC: hold.startC - ZONE_HOLD_EPSILON_C }
    expect(zoneCompleted(epsilonHold, 500, 89)).toBe(false)
    expect(zoneCompleted(epsilonHold, 500, 90)).toBe(true)
    // A real climb ignores the clock entirely, in both directions.
    expect(zoneCompleted(rising, 149.9, 100000)).toBe(false)
    expect(zoneCompleted(rising, 150, 0)).toBe(true)
  })
})

describe('the in-zone target', () => {
  const zone: ThermalSegment = {
    id: 'z',
    startC: 150,
    endC: 180,
    durationSec: 120,
    fanMin: 4,
    fanMax: 9,
    heatMin: 1,
    heatMax: 9,
  }

  it('is the nominal ramp measured from zone entry, capped at the endpoint', () => {
    expect(zoneTargetC(zone, 0)).toBeCloseTo(150, 9)
    expect(zoneTargetC(zone, 60)).toBeCloseTo(165, 9)
    expect(zoneTargetC(zone, 120)).toBeCloseTo(180, 9)
    // Past the nominal duration it HOLDS. It never overshoots into a ramp the profile never asked for.
    expect(zoneTargetC(zone, 121)).toBeCloseTo(180, 9)
    expect(zoneTargetC(zone, 100000)).toBeCloseTo(180, 9)
  })

  it('holds a cooling zone at its floor rather than driving below it', () => {
    const cool: ThermalSegment = {
      id: 'c',
      startC: 210,
      endC: 40,
      durationSec: 180,
      fanMin: 3,
      fanMax: 10,
      heatMin: 0,
      heatMax: 0,
    }
    expect(zoneTargetC(cool, 90)).toBeCloseTo(125, 9)
    expect(zoneTargetC(cool, 180)).toBeCloseTo(40, 9)
    expect(zoneTargetC(cool, 10000)).toBeCloseTo(40, 9)
  })
})

/**
 * The feasibility question a temperature-gated zone forces. Under the old clock-gated advance an
 * unreachable endpoint merely produced a large deviation and the roast moved on; now it produces a
 * zone that never ends, so the simulation has to answer it outright.
 */
describe('a zone whose endpoint the plant cannot hold', () => {
  // Heat 5 at fan 8 settles at about 153 °C: 24.5 + (4 + 33 - 15.2) / 0.17. The zone asks for 200.
  const strangled: ThermalSegment = {
    id: 'strangled',
    startC: 25,
    endC: 200,
    durationSec: 300,
    fanMin: 8,
    fanMax: 10,
    heatMin: 1,
    heatMax: 5,
  }
  const journey = intentOf([
    strangled,
    { id: 'after', startC: 200, endC: 210, durationSec: 120, fanMin: 4, fanMax: 9, heatMin: 1, heatMax: 9 },
  ])

  it('is flagged infeasible from the model, without waiting to find out', () => {
    const verdict = zoneFeasibility(
      strangled,
      { batchMassG: defaultCalibration.referenceBatchMassG, ambientC: AMBIENT_C },
      defaultCalibration,
    )
    expect(verdict.infeasible).toBe(true)
    expect(verdict.reachableC).toBeGreaterThan(140)
    expect(verdict.reachableC).toBeLessThan(170)
    // The same zone with its own heat ceiling lifted is reachable, so the verdict is about the BAND.
    expect(
      zoneFeasibility(
        { ...strangled, heatMax: 9 },
        { batchMassG: defaultCalibration.referenceBatchMassG, ambientC: AMBIENT_C },
        defaultCalibration,
      ).infeasible,
    ).toBe(false)
  })

  it('ends the simulation with the zone marked, rather than hanging forever', () => {
    const run = simulateJourney({ profile: journey, calibration: defaultCalibration, massG: 225 })
    expect(run.abandonedZoneIndex).toBe(0)
    expect(run.completedSec).toBe(roastRuntimeEnvelopeSec(420))
    const zone = run.zones[0]
    expect(zone.infeasible).toBe(true)
    expect(zone.attained).toBe(false)
    expect(zone.attainedSec).toBeUndefined()
    /*
     * It says WHERE it got to, which is the reading. Note that it does not quite reach the steady
     * state either: the approach is first-order with a time constant of 1/0.17 min. The shared
     * whole-plan envelope gives this 7-minute nominal journey 24 minutes total before reporting
     * that it is stuck, exactly as the mock and firmware do.
     */
    expect(zone.plateauC).toBeGreaterThan(110)
    expect(zone.plateauC).toBeLessThan(zone.reachableC)
    expect(zone.reachableC).toBeLessThan(zone.endC)
    // And it never pretended to enter the zone after it.
    expect(run.zones[1].entrySec).toBe(0)
    expect(run.zones[1].attained).toBe(false)
    expect(run.samples.every((sample) => sample.beanTempC < 200)).toBe(true)
  })

  it('leaves the CONTROLLER holding, which is the correct live behaviour', () => {
    // Nothing in `journeyControlStep` gives up. A real roast at an unreachable endpoint keeps asking
    // for the endpoint; it is the simulation, which has to terminate, that draws the conclusion.
    const plan = journeyPlan(journey)
    const step = journeyControlStep(
      { ...initialJourneyControlState(), lastSampleSec: 3599 },
      {
        plan,
        elapsedSec: 3600,
        beanTempC: 152,
        ambientC: AMBIENT_C,
        batchMassG: defaultCalibration.referenceBatchMassG,
        calibration: defaultCalibration,
      },
    )
    expect(step.zoneIndex).toBe(0)
    expect(step.zoneCompleted).toBe(false)
    expect(step.command.goalC).toBeCloseTo(200, 6)
    expect(step.command.heat).toBe(5)
    expect(step.command.saturatedHigh).toBe(true)
  })
})

describe('per-zone accounting', () => {
  const zones: ThermalSegment[] = [
    { id: 'ramp', startC: 25, endC: 150, durationSec: 100, fanMin: 4, fanMax: 9, heatMin: 1, heatMax: 9 },
    { id: 'mid', startC: 150, endC: 175, durationSec: 100, fanMin: 4, fanMax: 9, heatMin: 1, heatMax: 9 },
    { id: 'dev', startC: 175, endC: 200, durationSec: 100, fanMin: 4, fanMax: 9, heatMin: 1, heatMax: 9 },
    { id: 'cool', startC: 200, endC: 40, durationSec: 100, fanMin: 4, fanMax: 10, heatMin: 0, heatMax: 0 },
  ]

  const correction = (over: Partial<ControlCorrection> = {}): ControlCorrection => ({
    errorC: 0,
    proportionalRatePerMin: 0,
    integralRatePerMin: 0,
    totalRatePerMin: 0,
    saturated: false,
    holdover: false,
    ...over,
  })

  /*
   * A constructed run with exact, hand-checkable numbers:
   *   zone 0: 0..149   (150 s against 100 nominal, +50 overrun), integral 2, half of it saturated
   *   zone 1: 150..249 (100 s, exactly nominal), integral 4
   *   zone 2: 250..319 (70 s, 30 s early), integral 6
   *   zone 3: 320..399 (80 s, ends with the run), integral -9
   */
  const rows: JourneyZoneRow[] = [
    ...Array.from({ length: 150 }, (_, index) => ({
      elapsedSec: index,
      zoneIndex: 0,
      correction: correction({ integralRatePerMin: 2, errorC: index < 75 ? 10 : -10, saturated: index < 75 }),
    })),
    ...Array.from({ length: 100 }, (_, index) => ({
      elapsedSec: 150 + index,
      zoneIndex: 1,
      correction: correction({ integralRatePerMin: 4, errorC: 1 }),
    })),
    ...Array.from({ length: 70 }, (_, index) => ({
      elapsedSec: 250 + index,
      zoneIndex: 2,
      correction: correction({ integralRatePerMin: 6, errorC: -1 }),
    })),
    ...Array.from({ length: 80 }, (_, index) => ({
      elapsedSec: 320 + index,
      zoneIndex: 3,
      correction: correction({ integralRatePerMin: -9, errorC: 3 }),
    })),
  ]
  const report = summarizeJourneyZones(zones, rows, { finalZoneAttained: true, endSec: 400 })

  it('labels the ramp, the controllable middle and the trailing cooling zone', () => {
    expect(report.zones.map((zone) => zone.role)).toEqual(['ramp', 'controlled', 'controlled', 'cooling'])
    expect(zoneRoles(zones.slice(0, 1))).toEqual(['ramp'])
    // A descending zone in the MIDDLE is a deliberate drop the loop authors, not a cool-down.
    expect(zoneRoles([zones[0], { ...zones[1], startC: 200, endC: 150 }, zones[2]])).toEqual([
      'ramp',
      'controlled',
      'controlled',
    ])
  })

  it('measures nominal against actual duration, which for a ramp zone IS the result', () => {
    expect(report.zones.map((zone) => zone.actualDurationSec)).toEqual([150, 100, 70, 80])
    expect(report.zones.map((zone) => zone.overrunSec)).toEqual([50, 0, -30, -20])
    expect(report.zones.every((zone) => zone.attained)).toBe(true)
  })

  it('reports each zone tracking and saturation on its own samples', () => {
    expect(report.zones[0].meanAbsErrorC).toBeCloseTo(10, 9)
    expect(report.zones[0].saturatedFraction).toBeCloseTo(0.5, 9)
    // Saturated samples are INCLUDED here, unlike in the bias: a ramp zone is pinned nearly
    // throughout and excluding them would leave it with no reading at all.
    expect(report.zones[0].meanIntegralRatePerMin).toBeCloseTo(2, 9)
    expect(report.zones[1].saturatedFraction).toBe(0)
    expect(report.zones[3].meanIntegralRatePerMin).toBeCloseTo(-9, 9)
  })

  it('estimates the model bias from the CONTROLLED zones alone', () => {
    expect(report.biasZoneIndexes).toEqual([1, 2])
    // 4 over a hundred samples and 6 over seventy: (400 + 420) / 170 = 4.8235...
    expect(report.bias.meanIntegralRatePerMin).toBeCloseTo((4 * 100 + 6 * 70) / 170, 9)
    expect(report.bias.usableSamples).toBe(170)
    // Emphatically not the whole-roast figure, which the ramp's +2 and the cooling zone's -9 drag
    // to somewhere that describes neither.
    const wholeRoast = (2 * 75 + 4 * 100 + 6 * 70 + -9 * 80) / (75 + 100 + 70 + 80)
    expect(Math.abs(report.bias.meanIntegralRatePerMin - wholeRoast)).toBeGreaterThan(4)
  })

  it('says a zone was never entered rather than scoring it as instantaneous', () => {
    const partial = summarizeJourneyZones(
      zones,
      rows.filter((row) => row.zoneIndex <= 1),
      { endSec: 250 },
    )
    expect(partial.zones[2].entered).toBe(false)
    expect(partial.zones[2].actualDurationSec).toBe(0)
    expect(partial.zones[2].overrunSec).toBe(0)
    expect(partial.zones[2].attained).toBe(false)
    // Zone 1 was reached but, without `finalZoneAttained`, is not claimed to have been completed.
    expect(partial.zones[0].attained).toBe(true)
    expect(partial.zones[1].attained).toBe(false)
  })
})

/**
 * The end-to-end check against the demo dataset. A clock-gated controller produces a predicted line
 * sitting far below the goal while zone 1 is marked complete. That is impossible by construction,
 * and this is the assertion that says so.
 */
describe('the demo journey, simulated', () => {
  const run = simulateJourney({ profile: starterThermalIntent, calibration: defaultCalibration, massG: 225 })

  it('attains every zone endpoint, in sequence', () => {
    expect(run.zones).toHaveLength(5)
    expect(run.abandonedZoneIndex).toBeUndefined()
    for (const zone of run.zones) {
      expect(zone.attained).toBe(true)
      const arrival = run.samples.find((sample) => sample.elapsedSec >= (zone.attainedSec ?? 0))!
      if (zone.endC >= zone.startC) expect(arrival.beanTempC).toBeGreaterThanOrEqual(zone.endC)
      else expect(arrival.beanTempC).toBeLessThanOrEqual(zone.endC)
    }
    // Strictly increasing entries: no zone begins before the one before it ended.
    const entries = run.zones.map((zone) => zone.entrySec)
    expect(entries).toEqual([...entries].sort((a, b) => a - b))
  })

  it('reports the ramp zone as an overrun rather than as an error', () => {
    const ramp = run.zones[0]
    expect(ramp.role).toBe('ramp')
    expect(ramp.nominalDurationSec).toBe(210)
    // Reached 150 °C in about 4:02 against a planned 3:30. Expected to miss; the miss is the reading.
    expect(ramp.overrunSec).toBeGreaterThan(0)
    expect(ramp.overrunSec).toBeLessThan(120)
  })

  it('reads no meaningful model bias from a perfect-model run', () => {
    expect(run.assumedError).toEqual({ heaterGainErrorPercent: 0, thermalLossErrorPercent: 0 })
    expect(run.truth).toBe(defaultCalibration)
    expect(run.residual.biasZoneIndexes).toEqual([1, 2, 3])
    expect(Math.abs(run.residual.bias.meanIntegralRatePerMin)).toBeLessThan(1)
  })

  it('states plainly that this model does not rebound, instead of implying it does', () => {
    const cooling = run.zones[run.zones.length - 1]
    expect(cooling.role).toBe('cooling')
    // `thermalStep` floors cooling at 8 °C/min and never warms with the element off, so the modelled
    // rebound is zero. A real roaster's surface probe DOES climb back as the fan slows; reporting a
    // zero here is the honest way to say the model has nothing to offer about it.
    expect(cooling.reboundC).toBe(0)
  })
})

describe('an assumed model error, which is the only thing that makes accuracy meaningful', () => {
  const base = { profile: starterThermalIntent, calibration: defaultCalibration, massG: 225 }
  const perfect = simulateJourney(base)

  it('changes nothing at all when it is zero', () => {
    const explicitZero = simulateJourney({
      ...base,
      assumedError: { heaterGainErrorPercent: 0, thermalLossErrorPercent: 0 },
    })
    expect(explicitZero.samples).toEqual(perfect.samples)
    expect(explicitZero.truth).toBe(defaultCalibration)
  })

  it('perturbs the PLANT and leaves the controller believing what it believed', () => {
    const weak = simulateJourney({ ...base, assumedError: { heaterGainErrorPercent: -20, thermalLossErrorPercent: 0 } })
    expect(weak.truth.heaterGainCPerMinAt10).toBeCloseTo(defaultCalibration.heaterGainCPerMinAt10 * 0.8, 9)
    expect(weak.truth.thermalLossPerMinPerC).toBe(defaultCalibration.thermalLossPerMinPerC)
    // A weaker heater than believed means the loop had to push up all roast, and it says so.
    expect(weak.residual.bias.meanIntegralRatePerMin).toBeGreaterThan(3)
    // And the zones take longer than they did with a perfect model. That is model error, whereas the
    // overrun in the perfect run is infeasibility - two different findings, told apart by this input.
    expect(weak.zones[0].simulatedDurationSec).toBeGreaterThan(perfect.zones[0].simulatedDurationSec)
  })

  it('reads the opposite sign for a stronger heater than believed', () => {
    const strong = simulateJourney({
      ...base,
      assumedError: { heaterGainErrorPercent: 20, thermalLossErrorPercent: 0 },
    })
    expect(strong.residual.bias.meanIntegralRatePerMin).toBeLessThan(0)
    /*
     * A stronger heater does NOT make the roast faster here, and that is worth recording rather than
     * asserting away. The demo's zones insist on a heat floor of 3, and at 140 °C with the fan at its
     * ceiling that pair is net COOLING. A roast running ahead of its ramp is cut to that floor, and a
     * 20% stronger heater simply puts it there sooner and more often. The reading is the correction,
     * not the clock: both runs still arrive, and the integral says which way the model was wrong.
     */
    expect(Math.abs(strong.residual.bias.meanIntegralRatePerMin)).toBeGreaterThan(
      Math.abs(perfect.residual.bias.meanIntegralRatePerMin),
    )
    expect(strong.zones[0].simulatedDurationSec).not.toBe(perfect.zones[0].simulatedDurationSec)
  })

  it('clamps the assumed error to the range the PI tests actually validated', () => {
    const absurd = simulateJourney({
      ...base,
      assumedError: { heaterGainErrorPercent: -500, thermalLossErrorPercent: 900 },
    })
    expect(absurd.truth.heaterGainCPerMinAt10).toBeCloseTo(defaultCalibration.heaterGainCPerMinAt10 * 0.7, 9)
    expect(absurd.truth.thermalLossPerMinPerC).toBeCloseTo(defaultCalibration.thermalLossPerMinPerC * 1.3, 9)
  })
})
