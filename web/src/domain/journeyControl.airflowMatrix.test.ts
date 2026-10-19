import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import { richDemoDataset } from '../data/demoDataset'
import { journeyCirculationFloor } from './journeyControl'
import { simulateJourney } from './profileSimulation'
import type { CalibrationSettings, ThermalIntent } from './types'

const screenshotProfile: ThermalIntent = {
  id: 'airflow-prototype',
  name: 'Journey airflow prototype',
  revision: 1,
  strategy: 'thermal-intent',
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
  metadata: { intent: 'Airflow continuity validation' },
  notes: '',
  calibrationStatus: 'experimental',
  segments: [
    { id: 'z1', startC: 25, endC: 170, durationSec: 300, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z2', startC: 170, endC: 210, durationSec: 180, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z3', startC: 210, endC: 220, durationSec: 180, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'z4', startC: 220, endC: 223, durationSec: 180, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 10 },
    { id: 'cool', startC: 223, endC: 50, durationSec: 120, fanMin: 1, fanMax: 10, heatMin: 0, heatMax: 0 },
  ],
}

const authoredMinimumProfile: ThermalIntent = {
  ...screenshotProfile,
  id: 'authored-minimum-profile',
  name: 'Authored minimum Heat and Fan',
  segments: screenshotProfile.segments.map((zone, index) =>
    zone.endC < zone.startC
      ? { ...zone, id: `minimum-${index}` }
      : { ...zone, id: `minimum-${index}`, fanMin: index < 2 ? 5 : 3, heatMin: index < 2 ? 3 : 1 },
  ),
}

const calibrationSets: Array<{ name: string; calibration: CalibrationSettings }> = [
  { name: 'estimated baseline', calibration: defaultCalibration },
  {
    name: 'applied fit from recorded roasts',
    calibration: {
      ...defaultCalibration,
      heaterGainCPerMinAt10: 29.92,
      fanCoolingCPerMinAt10: 2.76,
      coolingFanCPerMinAt10: 43.31,
      thermalLossPerMinPerC: 0.174,
    },
  },
  {
    name: 'corrected mass-law refit',
    calibration: {
      ...defaultCalibration,
      heaterGainCPerMinAt10: 35.25,
      fanCoolingCPerMinAt10: 3.08,
      coolingFanCPerMinAt10: 23.33,
      thermalLossPerMinPerC: 0.1613,
    },
  },
  {
    name: 'strong low-loss chamber',
    calibration: {
      ...defaultCalibration,
      heaterGainCPerMinAt10: 90,
      fanCoolingCPerMinAt10: 32,
      coolingFanCPerMinAt10: 48,
      thermalLossPerMinPerC: 0.08,
    },
  },
  {
    name: 'weak high-loss chamber',
    calibration: {
      ...defaultCalibration,
      heaterGainCPerMinAt10: 24,
      fanCoolingCPerMinAt10: 12,
      coolingFanCPerMinAt10: 20,
      thermalLossPerMinPerC: 0.26,
    },
  },
]

const assumedErrors = [
  { name: 'matched plant', heaterGainErrorPercent: 0, thermalLossErrorPercent: 0 },
  { name: '30% weaker and leakier', heaterGainErrorPercent: -30, thermalLossErrorPercent: 30 },
  { name: '30% stronger and tighter', heaterGainErrorPercent: 30, thermalLossErrorPercent: -30 },
]

const massesG = [100, 150, 170, 206, 250, 300]
const datasetProfiles = richDemoDataset().profiles.filter(
  (profile): profile is ThermalIntent => profile.strategy === 'thermal-intent',
)
const profiles = [...datasetProfiles, screenshotProfile, authoredMinimumProfile]

describe('Journey airflow multi-dataset matrix', () => {
  it('keeps every command finite, bounded, circulated, and slew-safe', () => {
    const failures: string[] = []
    let scenarioCount = 0

    for (const profile of profiles) {
      for (const { name: calibrationName, calibration } of calibrationSets) {
        for (const massG of massesG) {
          for (const assumedError of assumedErrors) {
            scenarioCount += 1
            const label = `${profile.name} / ${calibrationName} / ${massG} g / ${assumedError.name}`
            const run = simulateJourney({ profile, calibration, massG, assumedError })
            if (run.samples.length === 0) {
              failures.push(`${label}: no samples`)
              continue
            }
            if (run.completedSec > 7200) failures.push(`${label}: exceeded bounded simulation time`)

            for (const [sampleIndex, sample] of run.samples.entries()) {
              // This command was solved from the preceding reading; `sample.beanTempC` is the plant
              // temperature produced one second later and can cross back over a policy boundary.
              const controlTempC =
                sampleIndex === 0 ? profile.segments[0].startC : run.samples[sampleIndex - 1].beanTempC
              const values = [sample.beanTempC, sample.rorCPerMin, sample.effectiveFan, sample.effectiveHeat]
              if (!values.every(Number.isFinite)) failures.push(`${label}: non-finite output at ${sample.elapsedSec} s`)
              if (sample.effectiveFan < 0 || sample.effectiveFan > 10) failures.push(`${label}: Fan out of bounds`)
              if (sample.effectiveHeat < 0 || sample.effectiveHeat > 10) failures.push(`${label}: Heat out of bounds`)

              if (sample.phase === 'COOLING') {
                if (sample.effectiveFan !== 10 || sample.effectiveHeat !== 0) {
                  failures.push(`${label}: cooling was not Fan 10 / Heat 0 at ${sample.elapsedSec} s`)
                }
              } else {
                const floor = journeyCirculationFloor(controlTempC)
                if (sample.effectiveFan + 1e-9 < floor) {
                  failures.push(`${label}: Fan ${sample.effectiveFan} below ${floor} floor at ${controlTempC} C`)
                }
                if (controlTempC <= 130 && sample.effectiveFan !== 10) {
                  failures.push(`${label}: opening Fan was not 10 at ${controlTempC} C`)
                }
                // Design rule: Heat on means Fan 1.0 or higher, on every command path, always.
                // There is no other floor above 130 C and no reduction rate limit.
                if (sample.effectiveHeat > 0 && sample.effectiveFan + 1e-9 < 1) {
                  failures.push(
                    `${label}: Fan ${sample.effectiveFan} carried Heat ${sample.effectiveHeat} at ${sample.elapsedSec} s`,
                  )
                }
              }
            }
          }
        }
      }
    }

    expect(scenarioCount).toBe(360)
    expect(failures).toEqual([])
  })

  it('lets Fan follow the solve immediately at 150 g and 250 g — no retention, no walk, no mass floor', () => {
    // There is no gradual-reduction limit and no reduced-airflow retention or rebound logic. Fan
    // may fall by whole levels in one tick and may reopen freely; the only invariants are the ones
    // the matrix above asserts (opening Fan 10, cooling Fan 10, and Fan 1.0 whenever Heat is on).
    for (const calibration of calibrationSets.map((item) => item.calibration)) {
      for (const massG of [150, 250]) {
        for (const assumedError of assumedErrors) {
          const run = simulateJourney({
            profile: screenshotProfile,
            calibration,
            massG,
            assumedError,
          })
          for (const sample of run.samples) {
            if (sample.phase !== 'COOLING' && sample.effectiveHeat > 0) {
              expect(sample.effectiveFan).toBeGreaterThanOrEqual(1)
            }
          }
        }
      }
    }
  })
  it('keeps volume-derived density observational until physical airflow evidence exists', () => {
    for (const calibration of calibrationSets.map((item) => item.calibration)) {
      for (const massG of [150, 250]) {
        const reference = simulateJourney({ profile: screenshotProfile, calibration, massG })
        for (const densityGPerMl of [0.4, 0.735, 0.9]) {
          const withVolume = simulateJourney({
            profile: screenshotProfile,
            calibration,
            massG,
            volumeMl: massG / densityGPerMl,
          })
          expect(withVolume.samples).toEqual(reference.samples)
        }
      }
    }
  })

  it('pins the one remaining circulation anchor: full airflow through 130 C, nothing above', () => {
    expect(journeyCirculationFloor(130)).toBe(10)
    expect(journeyCirculationFloor(131)).toBe(0)
    expect(journeyCirculationFloor(180)).toBe(0)
    expect(journeyCirculationFloor(300)).toBe(0)
  })
})
