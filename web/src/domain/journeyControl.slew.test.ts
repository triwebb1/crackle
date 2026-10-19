import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { starterThermalIntent } from '../data/demo'
import {
  initialJourneyControlState,
  type JourneyControlState,
  journeyControlStep,
  journeyPlan,
  MAX_HEAT_SLEW_PER_SEC,
} from './journeyControl'
import { simulateJourney } from './profileSimulation'
import type { ThermalIntent, ThermalSegment } from './types'

const AMBIENT_C = 24.5
const MASS_G = 225

const intentOf = (segments: ThermalSegment[]): ThermalIntent => ({
  ...starterThermalIntent,
  id: 'slew-test',
  segments,
})

const step = (segments: ThermalSegment[], state: JourneyControlState, elapsedSec: number, beanTempC: number) =>
  journeyControlStep(state, {
    plan: journeyPlan(intentOf(segments)),
    elapsedSec,
    beanTempC,
    ambientC: AMBIENT_C,
    batchMassG: MASS_G,
    calibration: defaultCalibration,
  })

const climbing: ThermalSegment = {
  id: 'climb',
  startC: 25,
  endC: 200,
  durationSec: 900,
  fanMin: 4,
  fanMax: 10,
  heatMin: 6,
  heatMax: 10,
}

const prior = (heat: number, atSec: number): JourneyControlState => ({
  ...initialJourneyControlState(),
  lastSampleSec: atSec,
  lastCommandHeat: heat,
  lastCommandSec: atSec,
})

describe('journey Heat slew limiting', () => {
  it('leaves the first command immediate, then caps an upward command at 0.25 per control step', () => {
    const first = step([climbing], initialJourneyControlState(), 0, 25)
    expect(first.command.heat).toBe(first.command.unconstrainedHeat)
    expect(first.command.heatSlewLimited).toBe(false)

    const limited = step([climbing], prior(4, 99), 100, 25)
    expect(limited.command.unconstrainedHeat).toBeGreaterThanOrEqual(climbing.heatMin)
    expect(limited.command.heat).toBeCloseTo(4 + MAX_HEAT_SLEW_PER_SEC, 9)
    expect(limited.command.heat).toBeLessThan(climbing.heatMin)
    expect(limited.command.heatSlewLimited).toBe(true)
    expect(limited.command.saturatedHigh).toBe(true)
  })

  it('does not bank a delayed tick into one large visible jump and does not wind up against the limiter', () => {
    const limited = step([climbing], prior(4, 0), 100, 25)
    expect(limited.command.heat).toBeCloseTo(4.25, 9)
    expect(limited.correction.saturated).toBe(true)
    expect(limited.correction.integralRatePerMin).toBe(0)
  })

  it('moves Fan immediately to the solve — reductions, reopenings and the protective 130 C floor alike', () => {
    // No gradual-reduction limit and no reduced-airflow retention: the solve's Fan is the commanded
    // Fan on the very tick it changes.
    const lowCeiling = { ...climbing, fanMin: 0.1, fanMax: 4 }
    const reduced = step([lowCeiling], prior(8, 99), 100, 150)
    expect(reduced.command.fan).toBe(4)

    // A shallower request may reopen airflow the moment the solve asks for it; nothing retains the
    // previously reduced level.
    const shallowRequest = { ...climbing, durationSec: 1800, heatMin: 6 }
    const reopened = step([shallowRequest], prior(8, 99), 100, 150)
    expect(reopened.command.fan).toBe(10)

    const protectiveIncrease = step([climbing], prior(8, 99), 100, 100)
    expect(protectiveIncrease.command.fan).toBe(10)
  })

  it('slews downward in a heating zone but enforces a newly lower heatMax immediately', () => {
    const shallow: ThermalSegment = {
      id: 'shallow',
      startC: 25,
      endC: 30,
      durationSec: 900,
      fanMin: 4,
      fanMax: 10,
      heatMin: 0,
      heatMax: 10,
    }
    const down = step([shallow], prior(8, 99), 100, 100)
    expect(down.command.unconstrainedHeat).toBeLessThan(down.command.heat)
    expect(down.command.heat).toBeCloseTo(7.75, 9)
    expect(down.command.heatSlewLimited).toBe(true)
    expect(down.command.saturatedLow).toBe(true)

    const lowerCeiling = { ...climbing, heatMax: 4, heatMin: 3 }
    const capped = step([lowerCeiling], prior(8, 99), 100, 25)
    expect(capped.command.heat).toBeLessThanOrEqual(4)
    expect(capped.command.heat).toBe(capped.command.unconstrainedHeat)
  })

  it('keeps Heat active across a rising-to-rising zone transition', () => {
    const zones: ThermalSegment[] = [
      { id: 'rise-1', startC: 25, endC: 100, durationSec: 300, fanMin: 4, fanMax: 9, heatMin: 3, heatMax: 9 },
      { id: 'rise-2', startC: 100, endC: 150, durationSec: 240, fanMin: 4, fanMax: 9, heatMin: 3, heatMax: 9 },
    ]
    const state = { ...prior(7.4, 99), zoneIndex: 0, zoneEntrySec: 0 }
    const nextRise = step(zones, state, 100, 100)
    expect(nextRise.zoneAdvanced).toBe(true)
    expect(nextRise.command.cooling).toBe(false)
    expect(nextRise.command.heat).toBeGreaterThan(0)
  })
  it('drops Heat to zero on the exact tick that enters cooling', () => {
    const zones: ThermalSegment[] = [
      { id: 'rise', startC: 25, endC: 100, durationSec: 300, fanMin: 4, fanMax: 9, heatMin: 3, heatMax: 9 },
      { id: 'cool', startC: 100, endC: 40, durationSec: 180, fanMin: 3, fanMax: 10, heatMin: 0, heatMax: 0 },
    ]
    const state = { ...prior(7.4, 99), zoneIndex: 0, zoneEntrySec: 0 }
    const cooling = step(zones, state, 100, 100)
    expect(cooling.zoneAdvanced).toBe(true)
    expect(cooling.command.cooling).toBe(true)
    expect(cooling.command.heat).toBe(0)
    expect(cooling.command.heatSlewLimited).toBe(false)
  })

  it('keeps the tenths-quantized starter demo within 0.3 while retaining immediate cooling', () => {
    const run = simulateJourney({ profile: starterThermalIntent, calibration: defaultCalibration, massG: MASS_G })
    const changes = run.samples.slice(1).map((sample, index) => ({
      from: run.samples[index].requestedHeat,
      to: sample.requestedHeat,
      at: sample.elapsedSec,
    }))
    const heating = changes.filter(({ from, to }) => from > 0 && to > 0)
    // The controller bound is 0.25; telemetry is intentionally quantized to tenths, so an
    // alternating round can display one 0.3 step even though the actuator command moved by 0.25.
    expect(Math.max(...heating.map(({ from, to }) => Math.abs(to - from)))).toBeLessThanOrEqual(0.3 + 1e-9)
    const cooling = changes.find(({ from, to }) => from > 0 && to === 0)
    expect(cooling).toBeDefined()
    expect(cooling!.from - cooling!.to).toBeGreaterThan(MAX_HEAT_SLEW_PER_SEC)
  })

  it.each([150, 250])('keeps the %d g heating trace inside the surviving airflow rules', (massG) => {
    // Opening Fan 10 through 130 C and cooling Fan 10 / Heat 0 apply; there is no mass-scaled late
    // floor (such as 2 at 170 g to 5 at 250 g), no reduction rate limit, and no monotonic-Fan
    // retention. Above 130 C, Heat on means Fan 1.0 or higher — nothing else constrains the solve.
    const profile = intentOf([
      { id: 'z1', startC: 25, endC: 170, durationSec: 300, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
      { id: 'z2', startC: 170, endC: 210, durationSec: 180, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
      { id: 'z3', startC: 210, endC: 220, durationSec: 180, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
      { id: 'z4', startC: 220, endC: 223, durationSec: 180, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
      { id: 'cool', startC: 223, endC: 50, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 0 },
    ])
    const run = simulateJourney({ profile, calibration: defaultCalibration, massG })
    const opening = run.samples.filter((sample) => sample.effectiveHeat > 0 && sample.beanTempC <= 130)
    expect(opening.length).toBeGreaterThan(0)
    expect(opening.every((sample) => sample.effectiveFan === 10)).toBe(true)

    const heating = run.samples.filter((sample) => sample.effectiveHeat > 0 && sample.beanTempC > 130)
    expect(heating.length).toBeGreaterThan(0)
    expect(Math.min(...heating.map((sample) => sample.effectiveFan))).toBeGreaterThanOrEqual(1)

    const cooling = run.samples.filter((sample) => sample.phase === 'COOLING')
    expect(cooling.length).toBeGreaterThan(0)
    expect(cooling.every((sample) => sample.effectiveFan === 10)).toBe(true)
  })
})
