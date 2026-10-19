import { automaticRunName } from '../domain/model'
import type { BeanLot, RoastRun, ThermalIntent, TimedProfile } from '../domain/types'
import { DEMO_RECORDED_ON } from './demoIdentity'

const now = new Date().toISOString()
export const starterBean: BeanLot = {
  id: 'bean-house-huila-2026',
  name: 'House Huila',
  origins: ['Colombia', 'Huila'],
  lotId: 'house-huila-2026',
  species: 'Arabica',
  cultivars: ['Caturra', 'Castillo'],
  process: 'Washed',
  greenDensityGPerMl: 0.55,
  moisturePercent: 10.5,
  notes: 'Starter bean lot created from the original profile metadata.',
  createdAt: now,
  updatedAt: now,
}

export const starterProfile: TimedProfile = {
  id: 'profile-house-espresso',
  name: 'House espresso',
  revision: 3,
  strategy: 'timed',
  createdAt: now,
  updatedAt: now,
  metadata: { intent: 'Medium espresso' },
  notes: 'Reliable starting point for a medium espresso roast.',
  points: [
    { id: 'p0', timeSec: 0, fan: 8.2, heat: 4.6 },
    { id: 'p1', timeSec: 135, fan: 7.8, heat: 5.8 },
    { id: 'p2', timeSec: 285, fan: 7.2, heat: 7.0 },
    { id: 'p3', timeSec: 430, fan: 6.4, heat: 8.1 },
    { id: 'p4', timeSec: 570, fan: 5.8, heat: 7.4 },
    { id: 'p5', timeSec: 615, fan: 9.0, heat: 0 },
  ],
  coolFan: 9,
  coolDurationSec: 90,
}

export const starterThermalIntent: ThermalIntent = {
  id: 'intent-gentle-espresso',
  name: 'Gentle espresso journey',
  revision: 1,
  strategy: 'thermal-intent',
  createdAt: now,
  updatedAt: now,
  metadata: { ...starterProfile.metadata },
  notes: 'A gentle five-zone temperature journey with a final cooling zone.',
  calibrationStatus: 'unavailable',
  segments: [
    { id: 't0', startC: 25, endC: 150, durationSec: 210, fanMin: 5, fanMax: 9, heatMin: 3, heatMax: 8 },
    { id: 't1', startC: 150, endC: 175, durationSec: 120, fanMin: 5, fanMax: 9, heatMin: 3, heatMax: 9 },
    { id: 't2', startC: 175, endC: 196, durationSec: 135, fanMin: 4, fanMax: 8, heatMin: 4, heatMax: 9 },
    { id: 't3', startC: 196, endC: 210, durationSec: 120, fanMin: 4, fanMax: 8, heatMin: 3, heatMax: 9 },
    { id: 't4', startC: 210, endC: 40, durationSec: 180, fanMin: 3, fanMax: 10, heatMin: 0, heatMax: 0 },
  ],
}

const makeHistoricalRun = (id: string, offset: number, finish: number): RoastRun => {
  const samples = Array.from({ length: 112 }, (_, index) => {
    const elapsedSec = index * 5.5
    const progress = Math.min(1, elapsedSec / 610)
    const beanTempC =
      25 +
      ((finish - 25) * (1 - Math.exp(-3.05 * progress))) / (1 - Math.exp(-3.05)) +
      Math.sin(index / 7) * 0.7 +
      offset
    const previousProgress = Math.max(0, (elapsedSec - 11) / 610)
    const previousTemp =
      25 + ((finish - 25) * (1 - Math.exp(-3.05 * previousProgress))) / (1 - Math.exp(-3.05)) + offset
    const rorCPerMin = Math.max(2.5, ((beanTempC - previousTemp) / 11) * 60)
    const point = starterProfile.points.reduce(
      (current, candidate) => (candidate.timeSec <= elapsedSec ? candidate : current),
      starterProfile.points[0],
    )
    return {
      elapsedSec,
      beanTempC,
      rorCPerMin,
      requestedFan: point.fan,
      effectiveFan: point.fan,
      requestedHeat: point.heat,
      effectiveHeat: point.heat,
      phase:
        elapsedSec < 205 ? ('DRYING' as const) : elapsedSec < 475 ? ('MAILLARD' as const) : ('DEVELOPMENT' as const),
    }
  })
  const profile = { ...starterProfile, id: `${starterProfile.id}-${id}`, revision: 2 }
  return {
    id,
    name: automaticRunName(profile, new Date(Date.now() - Number(id.slice(-1)) * 86400000), starterBean, 225),
    startedAt: new Date(Date.now() - Number(id.slice(-1)) * 86400000).toISOString(),
    completedAt: new Date(Date.now() - Number(id.slice(-1)) * 86400000 + 700000).toISOString(),
    profile,
    beanLotId: starterBean.id,
    notes: '',
    controllerVersion: 'demo',
    recordedOn: DEMO_RECORDED_ON,
    outcome: 'complete',
    measurements: { startingMassG: 225, ambientC: 24.5 },
    samples,
    events: [
      { id: `${id}-dry`, type: 'DRY_END', label: 'Dry end', elapsedSec: 205 + offset * 2 },
      { id: `${id}-fc`, type: 'FIRST_CRACK', label: 'First crack', elapsedSec: 475 + offset * 2 },
      { id: `${id}-drop`, type: 'DROP', label: 'Drop', elapsedSec: 610 },
    ],
  }
}

/*
 * ==============================================================================================
 * A ROAST WHOSE SECOND ZONE RUNS THREE MINUTES LONG - the overrun scenario, on purpose
 * ==============================================================================================
 *
 * The zone-overrun rendering cannot be reviewed against a roast that went to plan, and every other
 * demo run is a timed one. This run shows how the display reads when zone 2 takes three minutes
 * longer than the profile expected.
 *
 * It is arithmetic rather than a recording, and deliberately so - the times are chosen so the
 * reading is exact and can be asserted:
 *
 *   - zone 1 (25 to 150 °C, nominal 3:30) attains 150 °C at 3:30, dead on plan;
 *   - zone 2 (150 to 175 °C, nominal 2:00) attains 175 °C at 8:35, so it took 5:05 - **+3:05**;
 *   - zone 3 is still climbing at 10:00, where the run stops.
 *
 * Because zone advancement is by ATTAINMENT, those crossings are what the control law reads back
 * out of these samples; nothing here declares a zone boundary directly.
 */
const journeyOverrunSamples = (): RoastRun['samples'] => {
  const at = (elapsedSec: number, beanTempC: number, fan: number, heat: number) => ({
    elapsedSec,
    beanTempC,
    rorCPerMin: 0,
    requestedFan: fan,
    effectiveFan: fan,
    requestedHeat: heat,
    effectiveHeat: heat,
    phase: (elapsedSec < 210
      ? 'DRYING'
      : elapsedSec < 515
        ? 'MAILLARD'
        : 'DEVELOPMENT') as RoastRun['samples'][number]['phase'],
  })
  const samples: RoastRun['samples'] = []
  for (let elapsedSec = 0; elapsedSec <= 600; elapsedSec += 5) {
    if (elapsedSec <= 210) samples.push(at(elapsedSec, 25 + 125 * (elapsedSec / 210), 5, 8))
    // 305 seconds to climb the 25 °C zone 2 was given 120 for: the roaster simply cannot do it faster
    // at this zone's own heat ceiling, which is what an overrun means.
    else if (elapsedSec <= 515) samples.push(at(elapsedSec, 150 + 25 * ((elapsedSec - 210) / 305), 4, 9))
    else samples.push(at(elapsedSec, 175 + 21 * ((elapsedSec - 515) / 260), 4, 9))
  }
  return samples
}

export const overrunJourneyRun: RoastRun = {
  id: 'roast-journey-overrun',
  name: 'Demo / journey with a three-minute zone 2 overrun',
  startedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  completedAt: new Date(Date.now() - 3 * 86400000 + 600000).toISOString(),
  profile: starterThermalIntent,
  beanLotId: starterBean.id,
  beanLotSnapshot: starterBean,
  notes:
    'Demo data. Zone 2 asks for 25 °C in two minutes and the roaster takes five, so the chart states the overrun rather than sliding the plan under it.',
  controllerVersion: 'demo',
  recordedOn: DEMO_RECORDED_ON,
  outcome: 'complete',
  measurements: { startingMassG: 225, ambientC: 24.5 },
  samples: journeyOverrunSamples(),
  events: [],
}

export const demoRuns: RoastRun[] = [
  makeHistoricalRun('roast-1', -1.6, 207),
  makeHistoricalRun('roast-2', 1.2, 211),
  overrunJourneyRun,
]
export const demoProfiles = [starterProfile, starterThermalIntent]
export const demoBeans = [starterBean]
