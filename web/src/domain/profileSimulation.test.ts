import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterProfile, starterThermalIntent } from '../data/demo'
import { adaptiveTargetTemperatureAt, effectiveThermalIntent, thermalZoneCompletions } from './model'
import { finiteControlCalibration, simulateJourney, simulateProfileSnapshot } from './profileSimulation'
import { SIMULATED_ROASTER_SENSOR_MODEL } from './thermalModel'
import type { ThermalIntent } from './types'

describe('profile simulation snapshot', () => {
  it('uses the same explicit five-second probe response as the development roaster', () => {
    expect(SIMULATED_ROASTER_SENSOR_MODEL).toEqual({ probeOffsetC: 0, sensorLagSec: 5 })
  })

  it('renders the complete timed command path', () => {
    const samples = simulateProfileSnapshot({ profile: starterProfile, calibration: defaultCalibration, massG: 225 })
    expect(samples[0].elapsedSec).toBe(0)
    expect(samples.at(-1)?.elapsedSec).toBeGreaterThanOrEqual(700)
    expect(samples.some((sample) => sample.effectiveHeat === 0 && sample.effectiveFan > 0)).toBe(true)
  })

  it('completes a thermal journey at the ambient-bounded cooling floor', () => {
    const impossible = {
      ...starterThermalIntent,
      segments: starterThermalIntent.segments.map((segment) =>
        segment.id === 't4' ? { ...segment, endC: -100 } : segment,
      ),
    }
    const effective = effectiveThermalIntent(impossible, 24.5, 5)
    expect(effective.segments.at(-1)?.endC).toBe(29.5)
    const samples = simulateProfileSnapshot({ profile: impossible, calibration: defaultCalibration, massG: 225 })
    // The plant is never modelled below ambient, whatever the zone asks for.
    expect(Math.min(...samples.map((sample) => sample.beanTempC))).toBeGreaterThanOrEqual(24.5)
    /*
     * What a simulation may do about an impossible zone: running its clock forward until the plant
     * catches up - up to three times the profile's own duration - would let an unachievable cooling
     * ramp still finish at its endpoint and report nothing. The run steps on the PLAN's clock, so a zone the roaster cannot follow ends short, and
     * the gap is the reading the simulation exists to give.
     */
    expect(samples.at(-1)?.effectiveHeat).toBe(0)
    expect(samples.at(-1)?.phase).toBe('COOLING')
  })

  it('enters an aggressive cooling zone at maximum fan without an initial dip', () => {
    const samples = simulateProfileSnapshot({
      profile: starterThermalIntent,
      calibration: defaultCalibration,
      massG: 225,
    })
    const firstCoolingIndex = samples.findIndex((sample) => sample.phase === 'COOLING')
    const transition = samples.slice(firstCoolingIndex, firstCoolingIndex + 10)

    expect(firstCoolingIndex).toBeGreaterThan(0)
    expect(samples[firstCoolingIndex - 1].effectiveHeat).toBeGreaterThan(0)
    expect(transition.every((sample) => sample.effectiveHeat === 0)).toBe(true)
    // High fan, but not necessarily pinned at 10: the estimated baseline loses far more heat
    // passively than the old arbitrary defaults did, so less airflow buys the same cooling rate.
    // The very first cooling second can sit a shade under 8 because the closed loop now tracks the
    // plan so closely that the roast enters the zone slightly BELOW its target, and a roast that is
    // already cool needs marginally less cooling. It is at the ceiling within three seconds.
    expect(transition.every((sample) => sample.effectiveFan >= 7.5)).toBe(true)
    expect(transition.slice(3).every((sample) => sample.effectiveFan >= 9)).toBe(true)
  })

  it('anchors the live target to the same measured completion the simulation uses', () => {
    const intent: ThermalIntent = {
      ...starterThermalIntent,
      id: 'parity',
      calibrationStatus: 'unavailable',
      segments: [
        { id: 'z0', startC: 25, endC: 120, durationSec: 600, fanMin: 4, fanMax: 9, heatMin: 3, heatMax: 9 },
        { id: 'z1', startC: 180, endC: 200, durationSec: 300, fanMin: 4, fanMax: 9, heatMin: 3, heatMax: 9 },
      ],
    }
    const samples = simulateProfileSnapshot({ profile: intent, calibration: defaultCalibration, massG: 225 })
    const boundary = thermalZoneCompletions(intent, samples)[0]
    /*
     * 0.7.1: a zone completes by ATTAINMENT, so the boundary lands a few seconds AFTER the nominal
     * 600 rather than a hair before it. It cannot land before: the target ramp only reaches 120 °C at
     * t = 600, and the measured temperature reaches the commanded rate through the 5 s sensor pole.
     * Under the old clock-gated plan the target kept climbing past 600 toward the next zone's 200 °C,
     * which pulled the crossing a fraction early - an artefact of reading a zone off a clock.
     */
    expect(boundary.elapsedSec).toBeGreaterThan(595)
    expect(boundary.elapsedSec).toBeLessThan(640)
    const untilBoundary = samples.filter((item) => item.elapsedSec <= Math.ceil(boundary.elapsedSec))
    const liveTarget = adaptiveTargetTemperatureAt(intent, untilBoundary, boundary.elapsedSec)
    expect(liveTarget).toBeCloseTo(boundary.temperatureC, 6)
    expect(liveTarget).not.toBeCloseTo(intent.segments[1].startC, 6)
  })

  it('runs the trailing cool window at the profile cooling fan without an authored cooling row', () => {
    const withoutCoolingRow = {
      ...starterProfile,
      points: starterProfile.points.filter((point) => point.heat > 0),
      coolFan: 9,
      coolDurationSec: 60,
    }
    const samples = simulateProfileSnapshot({ profile: withoutCoolingRow, calibration: defaultCalibration, massG: 225 })
    // The final authored hot row keeps its 60-second dwell (570 through 629);
    // the appended safety cooling window starts at 630.
    const trailing = samples.filter((sample) => sample.elapsedSec >= 630)
    expect(trailing.length).toBeGreaterThan(0)
    expect(trailing.every((sample) => sample.effectiveHeat === 0 && sample.effectiveFan === 9)).toBe(true)
  })

  it('preserves a reheated final dwell before terminal cooling', () => {
    const reheated = {
      ...starterProfile,
      points: [
        { id: 'hot', timeSec: 0, fan: 8, heat: 5 },
        { id: 'pause', timeSec: 60, fan: 9, heat: 0 },
        { id: 'reheat', timeSec: 120, fan: 7, heat: 6 },
      ],
      coolFan: 10,
      coolDurationSec: 45,
    }
    const samples = simulateProfileSnapshot({ profile: reheated, calibration: defaultCalibration, massG: 225 })
    const finalHeat = samples.filter((sample) => sample.elapsedSec >= 120 && sample.elapsedSec < 165)
    const terminalCool = samples.filter((sample) => sample.elapsedSec >= 165)
    expect(finalHeat).toHaveLength(45)
    expect(finalHeat.every((sample) => sample.effectiveHeat === 6 && sample.effectiveFan === 7)).toBe(true)
    expect(terminalCool.length).toBeGreaterThanOrEqual(45)
    expect(terminalCool.every((sample) => sample.effectiveHeat === 0 && sample.effectiveFan === 10)).toBe(true)
  })

  it('survives inverted zone limits and empty profiles', () => {
    const inverted: ThermalIntent = {
      ...starterThermalIntent,
      segments: [{ id: 'bad', startC: 25, endC: 150, durationSec: 200, fanMin: 9, fanMax: 2, heatMin: 9, heatMax: 1 }],
    }
    const samples = simulateProfileSnapshot({ profile: inverted, calibration: defaultCalibration, massG: 225 })
    expect(
      samples.every(
        (sample) => Number.isFinite(sample.beanTempC) && sample.effectiveFan <= 10 && sample.effectiveHeat <= 10,
      ),
    ).toBe(true)
    expect(
      simulateProfileSnapshot({
        profile: { ...starterProfile, points: [] },
        calibration: defaultCalibration,
        massG: 225,
      }),
    ).toEqual([])
    expect(
      simulateProfileSnapshot({
        profile: { ...starterThermalIntent, segments: [] },
        calibration: defaultCalibration,
        massG: 225,
      }),
    ).toEqual([])
  })

  it('keeps volume as metadata rather than inventing a density-to-mass heuristic', () => {
    const loose = simulateProfileSnapshot({
      profile: starterProfile,
      calibration: defaultCalibration,
      massG: 225,
      volumeMl: 500,
    })
    const dense = simulateProfileSnapshot({
      profile: starterProfile,
      calibration: defaultCalibration,
      massG: 225,
      volumeMl: 300,
    })
    expect(loose.at(-1)?.beanTempC).toBe(dense.at(-1)?.beanTempC)
  })
})

describe('simulated timed profiles drive the device heat-on Fan floor', () => {
  it('runs a heat-on step asking for Fan below 1.0 at Fan 1.0, as the roaster does', () => {
    const lowFan = {
      ...starterProfile,
      points: [
        { id: 'a', timeSec: 0, fan: 0.3, heat: 6 },
        { id: 'b', timeSec: 60, fan: 9, heat: 0 },
      ],
    }
    const samples = simulateProfileSnapshot({ profile: lowFan, calibration: defaultCalibration, massG: 225 })
    const heated = samples.filter((sample) => sample.effectiveHeat > 0)
    expect(heated.length).toBeGreaterThan(0)
    for (const sample of heated) {
      expect(sample.requestedFan).toBe(0.3)
      expect(sample.effectiveFan).toBe(1)
    }
  })
})

describe('non-finite simulation inputs are replaced, never propagated', () => {
  it('repairs a NaN coefficient to the baseline and leaves a finite calibration untouched', () => {
    expect(finiteControlCalibration(defaultCalibration)).toBe(defaultCalibration)
    const repaired = finiteControlCalibration({
      ...defaultCalibration,
      thermalLossPerMinPerC: Number.NaN,
      coolingTargetMarginC: Number.NaN,
    })
    expect(repaired.thermalLossPerMinPerC).toBe(0.17)
    expect(repaired.coolingTargetMarginC).toBe(5)
    const samples = simulateProfileSnapshot({
      profile: starterThermalIntent,
      calibration: { ...defaultCalibration, heaterGainCPerMinAt10: Number.NaN },
      massG: Number.NaN,
    })
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.every((sample) => Number.isFinite(sample.beanTempC) && Number.isFinite(sample.effectiveHeat))).toBe(
      true,
    )
  })
})

describe('an authored cooling zone is never simulated as a heated one', () => {
  it('runs a journey whose final cooling zone collapses with zero Heat in that zone', () => {
    const seg = (id: string, startC: number, endC: number, durationSec: number) => ({
      id,
      startC,
      endC,
      durationSec,
      fanMin: 1,
      fanMax: 10,
      heatMin: 0,
      heatMax: 10,
    })
    const intent: ThermalIntent = {
      ...starterThermalIntent,
      segments: [seg('a', 25, 200, 480), seg('b', 200, 28, 240), seg('c', 28, 20, 120)],
    }
    const run = simulateJourney({ profile: intent, calibration: defaultCalibration, massG: 225 })
    const finalZone = run.samples.filter((_, index) => run.rows[index].zoneIndex === 2)
    expect(finalZone.length).toBeGreaterThan(0)
    // Lifted without relinking, this zone would run the heating solve at Heat 3.5.
    expect(Math.max(...finalZone.map((sample) => sample.effectiveHeat))).toBe(0)
    const coolingZone = run.samples.filter((_, index) => run.rows[index].zoneIndex === 1)
    expect(Math.max(...coolingZone.map((sample) => sample.effectiveHeat))).toBe(0)
  })
})
