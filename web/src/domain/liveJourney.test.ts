import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { overrunJourneyRun, starterThermalIntent } from '../data/demo'
import { initialJourneyControlState, journeyControlStep, journeyPlan } from './journeyControl'
import { adjustedJourneyTargetPath, deviceJourneyChartState, liveJourneyControl, zoneOverran } from './liveJourney'
import type { TelemetrySample, ThermalSegment } from './types'

const AMBIENT_C = 24.5

const read = (samples: TelemetrySample[], elapsedSec: number, probeC?: number) =>
  liveJourneyControl({
    intent: starterThermalIntent,
    samples,
    elapsedSec,
    ambientC: AMBIENT_C,
    massG: 225,
    calibration: defaultCalibration,
    probeC,
  })

const sampleAt = (elapsedSec: number, beanTempC: number): TelemetrySample => ({
  elapsedSec,
  beanTempC,
  rorCPerMin: 0,
  requestedFan: 5,
  effectiveFan: 5,
  requestedHeat: 8,
  effectiveHeat: 8,
  phase: 'DRYING',
})

/**
 * The requirement is about SHARING code, not about behaving similarly: the algorithms that drive the
 * simulation drive the live roast too - the exact same code. So the first test
 * is not about a number this module produces - it is that the number comes from `journeyControlStep`
 * and can be reproduced by calling that function directly.
 */
describe("the live roast runs the simulation's own control law", () => {
  it('reproduces exactly what journeyControlStep returns for the same sample series', () => {
    const samples = [sampleAt(0, 25), sampleAt(5, 32), sampleAt(10, 40), sampleAt(15, 49)]
    const reading = read(samples, 15, 49)

    // The same fold, spelled out by hand against the exported step function.
    const plan = journeyPlan(starterThermalIntent)
    let state = initialJourneyControlState()
    for (const sample of samples) {
      state = journeyControlStep(state, {
        plan,
        elapsedSec: sample.elapsedSec,
        beanTempC: sample.beanTempC,
        ambientC: AMBIENT_C,
        batchMassG: 225,
        calibration: defaultCalibration,
      }).state
    }
    const expected = journeyControlStep(state, {
      plan,
      elapsedSec: 15,
      beanTempC: 49,
      ambientC: AMBIENT_C,
      batchMassG: 225,
      calibration: defaultCalibration,
    })

    expect(reading?.command.fan).toBe(expected.command.fan)
    expect(reading?.command.heat).toBe(expected.command.heat)
    expect(reading?.targetC).toBe(expected.command.goalC)
    expect(reading?.correction).toEqual(expected.correction)
    expect(reading?.feedForward.heat).toBe(expected.feedForward.heat)
  })

  it('is a pure fold, so the same session read twice reads the same', () => {
    // A re-render must not be able to perturb the controller. `plan` carries closures, so the
    // comparison is over everything the page actually displays.
    const samples = [sampleAt(0, 25), sampleAt(5, 34), sampleAt(10, 45)]
    const shown = ({ plan, ...rest }: NonNullable<ReturnType<typeof read>>) => rest
    expect(shown(read(samples, 10, 45)!)).toEqual(shown(read(samples, 10, 45)!))
  })

  it('resets at roast start and nowhere else: a fresh session carries no integral', () => {
    const fresh = read([], 0, 25)
    expect(fresh?.correction.integralRatePerMin).toBe(0)
    expect(fresh?.zoneIndex).toBe(0)
    expect(fresh?.zoneEntrySec).toBe(0)
  })
})

/**
 * The holdover contract is `journeyControl.ts`'s, and the live path must not soften it: no
 * measurement means no correction, a frozen integral, and feed-forward against the PLAN - never the
 * last good reading, which is exactly the confident wrong answer a dropout would produce.
 */
describe('a missing thermocouple is a holdover, not a zero and not a stale reading', () => {
  const samples = [sampleAt(0, 25), sampleAt(5, 40), sampleAt(10, 60), sampleAt(15, 80)]

  it('reports the holdover and drops the correction to zero', () => {
    const reading = read(samples, 20, undefined)
    expect(reading?.correction.holdover).toBe(true)
    expect(reading?.correction.totalRatePerMin).toBe(0)
    expect(reading?.measuredC).toBeUndefined()
  })

  it('does not advance the zone anchor across a blind step', () => {
    const blind = read(samples, 20, undefined)
    expect(blind?.zoneIndex).toBe(0)
    // Nor does it invent an arrival: zone 0 ends at 150 °C and nothing measured has reached it.
    expect(blind?.zones[0].attained).toBe(false)
  })

  it('still recommends a fan and heat, because feed-forward has a plan to follow', () => {
    const reading = read(samples, 20, undefined)
    expect(reading?.command.heat).toBeGreaterThan(0)
    expect(reading?.command.fan).toBe(reading?.feedForward.fan)
    expect(reading?.command.unconstrainedHeat).toBe(reading?.feedForward.unconstrainedHeat)
    expect(reading?.command.heat).toBeLessThanOrEqual(reading?.feedForward.heat ?? 0)
    expect(reading?.command.heatSlewLimited).toBe(true)
  })
})

/**
 * The overrun scenario, on the demo run built for it: zone 2 is given two minutes for 25 °C and takes
 * five. Everything the chart draws is read off this.
 */
describe('reading a zone that ran three minutes long', () => {
  // The probe reports what the last sample did, which is 6.9 °C into zone 3's climb to 196 °C.
  const reading = read(overrunJourneyRun.samples, 600, overrunJourneyRun.samples.at(-1)!.beanTempC)

  it("places the zones by attainment, not by the plan's clock", () => {
    expect(reading?.zones[0].attainedSec).toBe(210)
    expect(reading?.zones[1].entrySec).toBe(210)
    expect(reading?.zones[1].attainedSec).toBe(515)
    expect(reading?.zonesAttained).toBe(2)
  })

  it('reports the overrun as the measured fact it is, in seconds a clock can print', () => {
    const zone = reading!.zones[1]
    expect(zone.nominalDurationSec).toBe(120)
    expect(zone.actualDurationSec).toBe(305)
    expect(zone.overrunSec).toBe(185)
    expect(zoneOverran(zone)).toBe(true)
  })

  it('leaves the planned boundaries exactly where the profile put them', () => {
    // Zone 2 is planned to end at 5:30 whatever the roast did. The plan does not move.
    expect(reading?.zones[1].plannedStartSec).toBe(210)
    expect(reading?.zones[1].plannedEndSec).toBe(330)
  })

  it('says nothing about an overrun for a zone that ran on time', () => {
    expect(reading?.zones[0].overrunSec).toBe(0)
    expect(zoneOverran(reading!.zones[0])).toBe(false)
  })

  it('stretches the in-zone target from the actual entry, and holds it at the endpoint', () => {
    // The roast is in zone 3 by 8:35, so the segment is anchored there rather than at 5:30.
    const segment = reading!.segment
    expect(segment[0].timeSec).toBe(515)
    expect(segment[0].temperatureC).toBe(175)
    expect(segment[1].temperatureC).toBe(196)
    // Past the nominal ramp the target stops moving, which is what makes arrival guaranteed.
    expect(segment.at(-1)?.temperatureC).toBe(196)
  })
})

describe('the adjusted journey schedule', () => {
  const zones = [
    {
      index: 0,
      zoneId: 'z1',
      role: 'ramp' as const,
      startC: 25,
      endC: 150,
      nominalDurationSec: 100,
      plannedStartSec: 0,
      plannedEndSec: 100,
      entrySec: 0,
      attainedSec: 130,
      actualDurationSec: 130,
      overrunSec: 30,
      attained: true,
      current: false,
    },
    {
      index: 1,
      zoneId: 'z2',
      role: 'controlled' as const,
      startC: 150,
      endC: 175,
      nominalDurationSec: 60,
      plannedStartSec: 100,
      plannedEndSec: 160,
      entrySec: 130,
      actualDurationSec: 40,
      overrunSec: -20,
      attained: false,
      current: true,
    },
    {
      index: 2,
      zoneId: 'z3',
      role: 'controlled' as const,
      startC: 175,
      endC: 195,
      nominalDurationSec: 50,
      plannedStartSec: 160,
      plannedEndSec: 210,
      attained: false,
      current: false,
    },
  ]

  it('anchors future zones after actual attainment and never leaves a stale current-only remnant', () => {
    expect(adjustedJourneyTargetPath(zones, 170)).toEqual([
      { timeSec: 0, temperatureC: 25 },
      { timeSec: 100, temperatureC: 150 },
      { timeSec: 130, temperatureC: 150 },
      { timeSec: 130, temperatureC: 150 },
      { timeSec: 190, temperatureC: 175 },
      { timeSec: 190, temperatureC: 175 },
      { timeSec: 240, temperatureC: 195 },
    ])
  })
})
describe('degenerate journeys', () => {
  it('declines to read a journey with no zones rather than inventing one', () => {
    expect(
      liveJourneyControl({
        intent: { ...starterThermalIntent, segments: [] },
        samples: [],
        elapsedSec: 0,
        ambientC: AMBIENT_C,
        calibration: defaultCalibration,
      }),
    ).toBeUndefined()
  })

  it('falls back to the default batch mass rather than poisoning the solve with NaN', () => {
    const reading = liveJourneyControl({
      intent: starterThermalIntent,
      samples: [sampleAt(0, 25)],
      elapsedSec: 0,
      ambientC: AMBIENT_C,
      massG: Number.NaN,
      calibration: defaultCalibration,
      probeC: 25,
    })
    expect(Number.isFinite(reading?.command.heat ?? Number.NaN)).toBe(true)
  })
})

describe('device-authored live chart annotations', () => {
  /*
   * Chart rule: when a zone completes late, the ADJUSTED PLAN
   * must re-anchor on the timeline - the current zone's target drawn from the device's actual zone
   * entry, and every upcoming zone re-projected from that boundary instead of from 0:00.
   */
  it('re-anchors the adjusted plan at the actual (late) zone completion the device reported', () => {
    // Zone 1's 150 °C endpoint was planned for 3:30 but attained at 7:26; the roast is in zone 2.
    const chart = deviceJourneyChartState(starterThermalIntent.segments, {
      active: true,
      mode: 'journey',
      planRev: 2,
      sessionId: '9',
      elapsedSec: 500,
      zoneIndex: 1,
      zoneEntrySec: 446,
      targetC: 161.3,
      zoneAttainedSec: [446, null, null, null, null],
      saturated: false,
      holdover: false,
    })
    // The current zone's target ramp starts where the roast really entered it...
    expect(chart.targetPath).toContainEqual({ timeSec: 446, temperatureC: 150 })
    expect(chart.targetPath).toContainEqual({ timeSec: 566, temperatureC: 175 })
    // ...and the upcoming zones are drawn offset from that boundary, not from the nominal clock.
    expect(chart.targetPath).toContainEqual({ timeSec: 701, temperatureC: 196 })
    expect(chart.zones[2].entrySec).toBeUndefined()
    // The nominal plan itself never moves; the offset is entirely in the adjusted path.
    expect(chart.zones[1].plannedStartSec).toBe(210)
  })

  it('terminates the overrun the moment the device reports the zone attained', () => {
    const at = (elapsedSec: number) =>
      deviceJourneyChartState(starterThermalIntent.segments, {
        active: true,
        mode: 'journey',
        planRev: 2,
        sessionId: '9',
        elapsedSec,
        zoneIndex: 1,
        zoneEntrySec: 446,
        targetC: 161.3,
        zoneAttainedSec: [446, null, null, null, null],
        saturated: false,
        holdover: false,
      })
    const attained = at(500).zones[0]
    expect(attained).toMatchObject({ attainedSec: 446, actualDurationSec: 446, overrunSec: 236 })
    expect(zoneOverran(attained)).toBe(true)
    // The bar no longer counts: a later clock leaves the attained zone's row exactly as it was.
    expect(at(600).zones[0]).toEqual(attained)
  })

  it('uses the roaster entry, attainment, elapsed, and target values without replaying browser samples', () => {
    const chart = deviceJourneyChartState(starterThermalIntent.segments, {
      active: true,
      mode: 'journey',
      planRev: 2,
      sessionId: '9',
      elapsedSec: 400,
      zoneIndex: 1,
      zoneEntrySec: 245,
      targetC: 181.5,
      zoneAttainedSec: [245, null],
      saturated: false,
      holdover: false,
    })
    expect(chart.zones[0]).toMatchObject({
      entrySec: 0,
      attainedSec: 245,
      actualDurationSec: 245,
      attained: true,
      current: false,
    })
    expect(chart.zones[1]).toMatchObject({ entrySec: 245, actualDurationSec: 155, attained: false, current: true })
    expect(chart.targetPath).toContainEqual({ timeSec: 245, temperatureC: starterThermalIntent.segments[1].startC })
    expect(chart.targetPath).toContainEqual({ timeSec: 400, temperatureC: starterThermalIntent.segments[1].endC })
    expect(chart.targetPath.at(-1)!.timeSec).toBeGreaterThan(400)
  })
})

/**
 * A recorded five-zone journey replayed as the progress tuple the roaster streams: zone index,
 * zone entry, per-zone attainments (null until attained), elapsed. The plan:
 * 28.8 -> 150 in 2:00, 150 -> 180 in 1:00, 180 -> 215 in 2:00, 215 -> 233 in 1:00, 233 -> 60 in
 * 0:15. The measured attainments, from the recording: 150 at 2:50, 180 at 4:22, 215 at 6:51, 233 at
 * 7:51, 60 at 15:49. Zones 1, 2 and 3 ran long; zone 4 was on time; the cooling zone was very long.
 *
 * The model of the adjusted plan, asserted as exact geometry at each instant: the current
 * zone's ramp anchored at the roaster's actual entry with its nominal slope, the target holding at
 * the endpoint while the zone overruns, every upcoming zone chained from the actual boundary, and
 * the overrun bar spanning nominal end -> now until it terminates at attainment.
 */
describe('a recorded journey through the device-authored chart state', () => {
  const plan: ThermalSegment[] = [
    { id: 'z1', startC: 28.8, endC: 150, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z2', startC: 150, endC: 180, durationSec: 60, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z3', startC: 180, endC: 215, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z4', startC: 215, endC: 233, durationSec: 60, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z5', startC: 233, endC: 60, durationSec: 15, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
  ]
  const ATTAINED = [170, 262, 411, 471, 949]
  /** The roaster's tuple at an instant: what the firmware publishes from its executor state. */
  const tupleAt = (elapsedSec: number, attainments = ATTAINED, ended?: 'completed' | 'stopped') => {
    const zoneAttainedSec = attainments.map((at) => (at <= elapsedSec ? at : null))
    const zoneIndex = Math.min(plan.length - 1, zoneAttainedSec.filter((at) => at !== null).length)
    return {
      active: ended === undefined,
      mode: 'journey' as const,
      planRev: 1,
      sessionId: '39',
      elapsedSec,
      zoneIndex,
      zoneEntrySec: zoneIndex === 0 ? 0 : (zoneAttainedSec[zoneIndex - 1] as number),
      zoneCount: plan.length,
      zoneAttainedSec,
      saturated: false,
      holdover: false,
      ...(ended ? { endReason: ended } : {}),
    }
  }
  const at = (elapsedSec: number, attainments?: number[], ended?: 'completed' | 'stopped') =>
    deviceJourneyChartState(plan, tupleAt(elapsedSec, attainments, ended))
  const point = (timeSec: number, temperatureC: number) => ({ timeSec, temperatureC })

  it('3:00 - zone 1 ran 50 s long; zone 2 is anchored at 2:50 and everything downstream shifts with it', () => {
    const chart = at(180)
    expect(chart.targetPath).toEqual([
      point(0, 28.8),
      point(120, 150),
      point(170, 150),
      point(170, 150),
      point(230, 180),
      point(230, 180),
      point(350, 215),
      point(350, 215),
      point(410, 233),
      point(410, 233),
      point(425, 60),
    ])
    expect(chart.zones[0]).toMatchObject({
      entrySec: 0,
      attainedSec: 170,
      actualDurationSec: 170,
      overrunSec: 50,
      attained: true,
      current: false,
    })
    expect(chart.zones[1]).toMatchObject({
      entrySec: 170,
      attainedSec: undefined,
      actualDurationSec: 10,
      overrunSec: -50,
      attained: false,
      current: true,
    })
    expect(chart.zones[2].entrySec).toBeUndefined()
    // The nominal plan never moves.
    expect(chart.zones.map((zone) => [zone.plannedStartSec, zone.plannedEndSec])).toEqual([
      [0, 120],
      [120, 180],
      [180, 300],
      [300, 360],
      [360, 375],
    ])
  })

  it('4:30 - zone 2 attained at 4:22 after holding its endpoint; zone 3 is anchored there', () => {
    expect(at(270).targetPath).toEqual([
      point(0, 28.8),
      point(120, 150),
      point(170, 150),
      point(170, 150),
      point(230, 180),
      point(262, 180),
      point(262, 180),
      point(382, 215),
      point(382, 215),
      point(442, 233),
      point(442, 233),
      point(457, 60),
    ])
    expect(at(270).zones[1]).toMatchObject({ entrySec: 170, attainedSec: 262, overrunSec: 32, attained: true })
  })

  it('6:30 - zone 3 is overrunning: the target holds at 215 from its nominal end out to now, and the rest chains from now', () => {
    const chart = at(390)
    expect(chart.targetPath.slice(6)).toEqual([
      point(262, 180),
      point(382, 215),
      point(390, 215),
      point(390, 215),
      point(450, 233),
      point(450, 233),
      point(465, 60),
    ])
    expect(chart.zones[2]).toMatchObject({
      entrySec: 262,
      attainedSec: undefined,
      actualDurationSec: 128,
      overrunSec: 8,
      current: true,
    })
    // A second later the downstream curve has moved a second further: the overrun is drawn as time.
    expect(at(391).targetPath.slice(8)).toEqual([
      point(391, 215),
      point(391, 215),
      point(451, 233),
      point(451, 233),
      point(466, 60),
    ])
  })

  it('7:00 - zone 3 attained at 6:51: its hold terminates there and zone 4 is anchored at 6:51', () => {
    const chart = at(420)
    expect(chart.targetPath.slice(6)).toEqual([
      point(262, 180),
      point(382, 215),
      point(411, 215),
      point(411, 215),
      point(471, 233),
      point(471, 233),
      point(486, 60),
    ])
    expect(chart.zones[2]).toMatchObject({
      entrySec: 262,
      attainedSec: 411,
      actualDurationSec: 149,
      overrunSec: 29,
      attained: true,
      current: false,
    })
    expect(zoneOverran(chart.zones[2])).toBe(true)
    expect(chart.zones[3]).toMatchObject({ entrySec: 411, actualDurationSec: 9, overrunSec: -51, current: true })
    // Attained rows are finished measurements: a later clock leaves them exactly as they were.
    expect(at(600).zones.slice(0, 3)).toEqual(chart.zones.slice(0, 3))
  })

  it('9:00 - zone 4 was on time; the cooling zone entered at 7:51 is overrunning its 15 s plan', () => {
    const chart = at(540)
    expect(chart.targetPath.slice(9)).toEqual([
      point(411, 215),
      point(471, 233),
      point(471, 233),
      point(486, 60),
      point(540, 60),
    ])
    expect(chart.zones[3]).toMatchObject({
      entrySec: 411,
      attainedSec: 471,
      actualDurationSec: 60,
      overrunSec: 0,
      attained: true,
    })
    expect(zoneOverran(chart.zones[3])).toBe(false)
    expect(chart.zones[4]).toMatchObject({
      entrySec: 471,
      attainedSec: undefined,
      actualDurationSec: 69,
      overrunSec: 54,
      current: true,
    })
  })

  it('15:49 - completed: every attainment stands, the last hold ends at 60 C, and no zone is current', () => {
    const chart = at(949, ATTAINED, 'completed')
    expect(chart.targetPath.slice(11)).toEqual([point(471, 233), point(486, 60), point(949, 60)])
    expect(chart.zones.map((zone) => zone.attainedSec)).toEqual(ATTAINED)
    expect(chart.zones[4]).toMatchObject({
      entrySec: 471,
      actualDurationSec: 478,
      overrunSec: 463,
      attained: true,
      current: false,
    })
    expect(chart.zones.some((zone) => zone.current)).toBe(false)
  })

  it('a zone attained EARLY keeps its nominal slope to the instant of attainment and hands over there', () => {
    // Zone 2 (150 -> 180 in 60 s) attained 30 s in, at 3:20: the target it was following was 165 C.
    const chart = at(210, [170, 200, 411, 471, 949])
    expect(chart.targetPath).toEqual([
      point(0, 28.8),
      point(120, 150),
      point(170, 150),
      point(170, 150),
      point(200, 165),
      point(200, 180),
      point(320, 215),
      point(320, 215),
      point(380, 233),
      point(380, 233),
      point(395, 60),
    ])
    expect(chart.zones[1]).toMatchObject({
      entrySec: 170,
      attainedSec: 200,
      actualDurationSec: 30,
      overrunSec: -30,
      attained: true,
    })
    expect(zoneOverran(chart.zones[1])).toBe(false)
  })

  it('a roast stopped mid-zone measures that zone to the roaster final clock, as a finished overrun', () => {
    const chart = at(400, [170, 262, 949, 949, 949], 'stopped')
    expect(chart.zones[2]).toMatchObject({
      entrySec: 262,
      attainedSec: undefined,
      actualDurationSec: 138,
      overrunSec: 18,
      attained: false,
      current: false,
    })
    expect(chart.zones[3].entrySec).toBeUndefined()
    expect(chart.targetPath.slice(6)).toEqual([
      point(262, 180),
      point(382, 215),
      point(382, 215),
      point(442, 233),
      point(442, 233),
      point(457, 60),
    ])
  })
})
describe('non-finite advisory inputs never reach the command', () => {
  const samples = [sampleAt(0, 25), sampleAt(5, 32), sampleAt(10, 40), sampleAt(15, 49)]
  const readWith = (overrides: { ambientC?: number; massG?: number; calibration?: typeof defaultCalibration }) =>
    liveJourneyControl({
      intent: starterThermalIntent,
      samples,
      elapsedSec: 15,
      probeC: 49,
      ambientC: AMBIENT_C,
      massG: 225,
      calibration: defaultCalibration,
      ...overrides,
    })

  it('substitutes 24.5 °C, the default mass and baseline coefficients, reading exactly as the defaults do', () => {
    const reference = readWith({})!
    for (const reading of [
      readWith({ ambientC: Number.NaN }),
      readWith({ massG: Number.NaN }),
      readWith({ calibration: { ...defaultCalibration, thermalLossPerMinPerC: Number.NaN } }),
      readWith({ calibration: { ...defaultCalibration, heaterGainCPerMinAt10: Number.POSITIVE_INFINITY } }),
    ]) {
      expect(Number.isFinite(reading!.command.heat)).toBe(true)
      expect(Number.isFinite(reading!.command.fan)).toBe(true)
      expect(reading!.command.heat).toBe(reference.command.heat)
    }
  })
})
