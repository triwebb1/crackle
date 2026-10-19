import { effectiveLevels } from '../domain/actuatorFloors'
import { expandBaselineGrid } from '../domain/calibrationProgram'
import { fitCoefficientsFromLog, fitSourceFromRun } from '../domain/coefficientFit'
import { automaticRunName } from '../domain/model'
import { simulateProfileSnapshot } from '../domain/profileSimulation'
import { summarizeBeanChange, summarizeProfileChange } from '../domain/revisionDiff'
import {
  analyzeCalibrationRun,
  buildBaselineMap,
  curveFamily,
  curvesFromBaselineMap,
  stageCalibration,
} from '../domain/thermalLog'
import { thermalStep } from '../domain/thermalModel'
import type {
  BeanLot,
  BeanRevision,
  CalibrationRun,
  CalibrationSettings,
  CalibrationSnapshot,
  ManualEvent,
  Profile,
  ProfileRevision,
  RoastRun,
  TelemetrySample,
  ThermalIntent,
  ThermalSample,
  TimedProfile,
} from '../domain/types'
import { defaultCalibration } from './calibration'
import { type ChamberNodes, chamberTauSec, stepChamber } from './chamberPlant'
import { starterBean, starterProfile, starterThermalIntent } from './demo'
import { DEMO_RECORDED_ON } from './demoIdentity'

/**
 * The rich development dataset.
 *
 * The minimal seed in `demo.ts` - one profile, one journey, one bean, two roasts - suits a fresh
 * library and is a poor thing for reviewing a screen that only has something to show after months
 * of use. This module builds what the app looks like after a season
 * of real roasting: catalogs with edit histories, roasts spread over months, a manual log, and two
 * baseline passes far enough apart to drift.
 *
 * It is dev-server only (see `richSeedEnabled` in `repository.ts`). Nothing here can reach a
 * firmware-served build.
 *
 * Every timestamp is derived from one fixed reference instant rather than from `Date.now()`, so the
 * dataset is byte-identical on every seed and no test can be flaky because of it. The calibration
 * coefficients are not written by hand either: the passes are generated from a physical model, then
 * put through the real analysis, so the saved calibrations agree with the passes they came from.
 */
export const DEMO_REFERENCE_MS = Date.UTC(2026, 6, 20, 9, 0, 0)
const at = (daysAgo: number, hour = 9, minute = 0): string =>
  new Date(DEMO_REFERENCE_MS - daysAgo * 86_400_000 + (hour - 9) * 3_600_000 + minute * 60_000).toISOString()

const atMs = (daysAgo: number, hour = 9, minute = 0): number =>
  DEMO_REFERENCE_MS - daysAgo * 86_400_000 + (hour - 9) * 3_600_000 + minute * 60_000

export interface DemoDataset {
  profiles: Profile[]
  beans: BeanLot[]
  runs: RoastRun[]
  profileRevisions: ProfileRevision[]
  beanRevisions: BeanRevision[]
  manualEvents: ManualEvent[]
  calibrationRuns: CalibrationRun[]
  calibrationSnapshots: CalibrationSnapshot[]
  /**
   * The thermal model the demo browser has APPLIED: the coefficients fitted from the loaded
   * characterization roast (bean regime) - see the value's own comment where it is built. What may
   * NEVER be seeded here is a chamber pass's patch: chamber and bean coefficient sets describe
   * different regimes, and a chamber set driven through the bean model equilibrates near 90 °C with
   * heat pinned at its ceiling - the measured failure that made applying a calibration a
   * deliberate act behind the lock and its diff. The chamber passes stay in the library as chamber
   * examples, never as the applied model.
   */
  appliedCalibration: Partial<CalibrationSettings>
}

/* ------------------------------------------------------------------ bean lots */

const bean = (
  id: string,
  name: string,
  origins: string[],
  fields: Partial<BeanLot>,
  createdDaysAgo: number,
  updatedDaysAgo: number,
): BeanLot => ({
  id,
  name,
  origins,
  cultivars: [],
  notes: '',
  ...fields,
  createdAt: at(createdDaysAgo),
  updatedAt: at(updatedDaysAgo),
})

const guji = bean(
  'bean-ethiopia-guji-2026',
  'Guji Natural',
  ['Ethiopia', 'Guji', 'Hambela'],
  {
    lotId: 'ET-GUJI-26-04',
    species: 'Arabica',
    cultivars: ['Heirloom (74110)', 'Heirloom (74112)'],
    process: 'Natural, 18 days raised bed',
    greenDensityGPerMl: 0.62,
    moisturePercent: 10.8,
    notes:
      'Very sweet, ferments easily. Wants a gentle Maillard and an early drop; scorches above heat 8 with the fan under 6.',
  },
  96,
  34,
)

const lintong = bean(
  'bean-sumatra-lintong-2026',
  'Lintong Wet-Hulled',
  ['Indonesia', 'North Sumatra', 'Lintong'],
  {
    lotId: 'ID-LNT-26-01',
    species: 'Arabica',
    cultivars: ['Ateng', 'Jember'],
    process: 'Wet-hulled (giling basah)',
    greenDensityGPerMl: 0.68,
    moisturePercent: 12.4,
    notes:
      'High moisture and irregular screen. Takes a long, hot drying phase without stalling. Chaff is heavy - the fan floor matters.',
  },
  122,
  41,
)

const cerrado = bean(
  'bean-brazil-cerrado-2026',
  'Cerrado Yellow Bourbon',
  ['Brazil', 'Minas Gerais', 'Cerrado'],
  {
    lotId: 'BR-CER-26-11',
    species: 'Arabica',
    cultivars: ['Yellow Bourbon'],
    process: 'Pulped natural',
    greenDensityGPerMl: 0.71,
    moisturePercent: 10.1,
    notes: 'Dense and forgiving. The house blend base; roasts almost identically batch to batch.',
  },
  150,
  150,
)

const nyeri = bean(
  'bean-kenya-nyeri-2026',
  'Nyeri AA',
  ['Kenya', 'Nyeri', 'Gichathaini'],
  {
    lotId: 'KE-NYR-26-02',
    species: 'Arabica',
    cultivars: ['SL28', 'SL34', 'Ruiru 11'],
    process: 'Washed, 72 h fermentation',
    greenDensityGPerMl: 0.66,
    moisturePercent: 10.6,
    notes: 'Hardest bean in the cupboard. Needs real heat through drying or the acidity goes flat.',
  },
  78,
  21,
)

const huehue = bean(
  'bean-guatemala-huehue-2026',
  'Huehuetenango La Libertad',
  ['Guatemala', 'Huehuetenango'],
  {
    lotId: 'GT-HUE-26-07',
    species: 'Arabica',
    cultivars: ['Bourbon', 'Caturra'],
    process: 'Washed',
    greenDensityGPerMl: 0.64,
    moisturePercent: 10.9,
    notes: 'Reliable espresso component. Interchangeable with the Huila lot in the house profile.',
  },
  64,
  64,
)

const decafSidamo = bean(
  'bean-decaf-sidamo-2026',
  'Sidamo Decaf (EA)',
  ['Ethiopia', 'Sidamo'],
  {
    lotId: 'ET-SID-DEC-26',
    species: 'Arabica',
    cultivars: ['Heirloom'],
    process: 'Ethyl acetate decaffeinated',
    greenDensityGPerMl: 0.58,
    moisturePercent: 9.4,
    notes: 'Decaf: colours early and lies about its development. Ignore the colour, watch the time.',
  },
  45,
  45,
)

const demoBeanLots: BeanLot[] = [starterBean, cerrado, lintong, huehue, nyeri, guji, decafSidamo]

/* ------------------------------------------------------------------ profiles */

const timedPoints = (rows: Array<[number, number, number]>) =>
  rows.map(([timeSec, fan, heat], index) => ({ id: `p${index}`, timeSec, fan, heat }))

const timed = (
  id: string,
  name: string,
  fields: Partial<TimedProfile>,
  rows: Array<[number, number, number]>,
): TimedProfile => ({
  id,
  name,
  revision: 1,
  strategy: 'timed',
  createdAt: at(120),
  updatedAt: at(120),
  metadata: { intent: '' },
  notes: '',
  coolFan: 9,
  coolDurationSec: 240,
  ...fields,
  points: timedPoints(rows),
})

const journey = (
  id: string,
  name: string,
  fields: Partial<ThermalIntent>,
  zones: Array<[number, number, number]>,
): ThermalIntent => ({
  id,
  name,
  revision: 1,
  strategy: 'thermal-intent',
  createdAt: at(120),
  updatedAt: at(120),
  metadata: { intent: '' },
  notes: '',
  calibrationStatus: 'unavailable',
  ...fields,
  segments: zones.map(([startC, endC, durationSec], index) => ({
    id: `${id}-z${index}`,
    startC,
    endC,
    durationSec,
    fanMin: 4,
    fanMax: 9,
    heatMin: endC < startC ? 0 : 3,
    heatMax: endC < startC ? 0 : 9,
  })),
})

/**
 * One profile's life, oldest first. Each entry after the first becomes a history row whose summary
 * is computed by the same differ the editor uses, so the demo history says exactly what a real one
 * would have said.
 */
interface ProfileHistory {
  variants: Profile[]
  savedDaysAgo: number[]
}

const foldProfileHistory = ({ variants, savedDaysAgo }: ProfileHistory) => {
  const revisions: ProfileRevision[] = []
  const stamped = variants.map(
    (variant, index) =>
      ({
        ...structuredClone(variant),
        revision: index + 1,
        createdAt: at(savedDaysAgo[0]),
        updatedAt: at(savedDaysAgo[index]),
      }) as Profile,
  )
  for (const [index, variant] of stamped.entries()) {
    revisions.push({
      id: `${variant.id}-rev-${index + 1}`,
      profileId: variant.id,
      revision: variant.revision,
      savedAt: at(savedDaysAgo[index], 9 + (index % 6)),
      summary: index === 0 ? 'Created' : summarizeProfileChange(stamped[index - 1], variant),
      profile: variant,
    })
  }
  return { current: stamped[stamped.length - 1], revisions }
}

// House espresso keeps the shipped starter's identity so a dev database and a fresh install talk
// about the same profile; only its history and its bean links are richer here.
const houseEspressoV1: TimedProfile = {
  ...structuredClone(starterProfile),
  coolDurationSec: 240,
  notes: 'Reliable starting point for a medium espresso roast.',
  metadata: { intent: 'Medium espresso' },
  points: timedPoints([
    [0, 8.2, 5.0],
    [135, 7.8, 6.2],
    [285, 7.2, 7.4],
    [430, 6.4, 8.3],
    [570, 5.8, 7.8],
    [615, 9.0, 0],
  ]),
}
const houseEspressoV2: TimedProfile = {
  ...houseEspressoV1,
  metadata: { ...houseEspressoV1.metadata },
  notes: 'Reliable starting point for a medium espresso roast. Huehuetenango behaves the same as the Huila lot here.',
  points: timedPoints([
    [0, 8.2, 5.0],
    [135, 7.8, 6.6],
    [285, 7.2, 7.4],
    [430, 6.4, 8.3],
    [570, 5.8, 7.8],
    [615, 9.0, 0],
  ]),
}
const houseEspressoV3: TimedProfile = {
  ...houseEspressoV2,
  metadata: { intent: 'Medium espresso, longer development' },
  points: timedPoints([
    [0, 8.2, 5.0],
    [135, 7.8, 6.6],
    [285, 7.2, 7.4],
    [455, 6.4, 8.3],
    [585, 5.8, 7.8],
    [630, 9.0, 0],
  ]),
}

const houseEspresso = foldProfileHistory({
  variants: [houseEspressoV1, houseEspressoV2, houseEspressoV3],
  savedDaysAgo: [118, 57, 8.3],
})

const gujiFilterV1 = timed(
  'profile-guji-filter',
  'Guji filter - gentle',
  {
    createdAt: at(92),
    metadata: { intent: 'Light filter' },
    notes: 'Natural process, so the Maillard stage runs cool and long. Drop before second crack has any chance.',
    coolFan: 10,
    coolDurationSec: 240,
  },
  [
    [0, 9.0, 5.6],
    [150, 8.6, 6.4],
    [320, 8.0, 6.8],
    [470, 7.4, 6.4],
    [560, 10, 0],
  ],
)

const gujiFilterV2: TimedProfile = {
  ...gujiFilterV1,
  metadata: { ...gujiFilterV1.metadata },
  points: timedPoints([
    [0, 9.0, 5.6],
    [150, 8.6, 6.8],
    [320, 8.0, 6.8],
    [470, 7.4, 6.4],
    [560, 10, 0],
  ]),
}
const gujiFilterV3: TimedProfile = {
  ...gujiFilterV2,
  notes:
    'Natural process, so the Maillard stage runs cool and long. Drop before second crack has any chance. Third revision pulls 20 s out of development after the March cupping.',
  points: timedPoints([
    [0, 9.0, 5.6],
    [150, 8.6, 6.8],
    [320, 8.0, 6.8],
    [470, 7.4, 6.4],
    [540, 10, 0],
  ]),
}
const gujiFilter = foldProfileHistory({
  variants: [gujiFilterV1, gujiFilterV2, gujiFilterV3],
  savedDaysAgo: [92, 48, 8.3],
})

const lintongDarkV1 = timed(
  'profile-lintong-dark',
  'Lintong - long dry',
  {
    createdAt: at(110),
    metadata: { intent: 'Dark, syrupy' },
    notes: 'Wet-hulled and wet. Drying gets an extra two minutes and the fan stays high for the chaff.',
    coolFan: 10,
    coolDurationSec: 260,
  },
  [
    [0, 9.4, 6.4],
    [180, 9.0, 7.6],
    [360, 8.4, 8.3],
    [540, 7.6, 8.3],
    [690, 7.0, 8.2],
    [740, 10, 0],
  ],
)

const lintongDarkV2: TimedProfile = {
  ...lintongDarkV1,
  metadata: { ...lintongDarkV1.metadata },
  points: timedPoints([
    [0, 9.4, 6.4],
    [180, 9.0, 7.6],
    [360, 8.4, 8.3],
    [540, 7.6, 8.3],
    [700, 7.0, 8.2],
    [755, 10, 0],
  ]),
}
const lintongDark = foldProfileHistory({ variants: [lintongDarkV1, lintongDarkV2], savedDaysAgo: [110, 29] })

const decafV1 = timed(
  'profile-decaf-steady',
  'Decaf - by the clock',
  {
    createdAt: at(44),
    metadata: { intent: 'Medium, timed only' },
    notes:
      'Decaf colours two shades ahead of its development, so this one is run on the clock and the colour is ignored entirely.',
  },
  [
    [0, 8.8, 5.8],
    [140, 8.4, 7.0],
    [300, 7.8, 7.6],
    [440, 7.0, 7.0],
    [520, 9.5, 0],
  ],
)
const decafV2: TimedProfile = {
  ...decafV1,
  points: timedPoints([
    [0, 8.8, 5.8],
    [140, 8.4, 7.0],
    [300, 7.8, 7.6],
    [455, 7.0, 7.0],
    [530, 9.5, 0],
  ]),
  notes:
    'Decaf colours two shades ahead of its development, so this one is run on the clock and the colour is ignored entirely. Fifteen seconds more development after the second batch came out thin.',
}
const decafSteady = foldProfileHistory({ variants: [decafV1, decafV2], savedDaysAgo: [44, 9] })

const gentleJourneyV1: ThermalIntent = {
  ...structuredClone(starterThermalIntent),
  metadata: { intent: 'Medium espresso' },
}
const gentleJourneyV2: ThermalIntent = {
  ...gentleJourneyV1,
  calibrationStatus: 'experimental',
  segments: gentleJourneyV1.segments.map((segment, index) =>
    index === 1 ? { ...segment, durationSec: 150 } : segment,
  ),
}
const gentleJourneyV3: ThermalIntent = {
  ...gentleJourneyV2,
  notes:
    'A gentle five-zone temperature journey with a final cooling zone. Zone 3 pushed two degrees after the June baseline pass.',
  segments: gentleJourneyV2.segments.map((segment, index) =>
    index === 2 ? { ...segment, endC: 198 } : index === 3 ? { ...segment, startC: 198 } : segment,
  ),
}
const gentleJourney = foldProfileHistory({
  variants: [gentleJourneyV1, gentleJourneyV2, gentleJourneyV3],
  savedDaysAgo: [118, 63, 8.3],
})

const nyeriJourneyV1 = journey(
  'intent-nyeri-fast-development',
  'Nyeri - fast development',
  {
    createdAt: at(74),
    metadata: { intent: 'Light filter' },
    notes: 'Hard bean: heat hard through drying, then hold the ramp flat so development is short but not violent.',
    calibrationStatus: 'experimental',
    /*
     * The third number is the zone's DURATION IN SECONDS. It read 8.3 in all five zones - the heat
     * column from the timed-profile rows above, pasted into the duration slot - which asked this
     * journey to climb from 24 °C to 160 °C in eight seconds. Simulating it produced a run that gave up
     * in zone 1 having reached 118 °C, with every zone after it "Not reached", at zero assumed error:
     * the demo's own loudest example of a simulation apparently ignoring its profile.
     */
  },
  [
    [24, 160, 330],
    [160, 182, 120],
    [182, 199, 120],
    [199, 208, 130],
    [208, 40, 180],
  ],
)

const nyeriJourneyV2: ThermalIntent = {
  ...nyeriJourneyV1,
  segments: nyeriJourneyV1.segments.map((segment, index) => (index === 3 ? { ...segment, durationSec: 110 } : segment)),
}
const nyeriJourneyV3: ThermalIntent = {
  ...nyeriJourneyV2,
  metadata: { ...nyeriJourneyV2.metadata },
  segments: nyeriJourneyV2.segments.map((segment, index) =>
    index === 0 ? { ...segment, endC: 165 } : index === 1 ? { ...segment, startC: 165 } : segment,
  ),
}
const nyeriJourney = foldProfileHistory({
  variants: [nyeriJourneyV1, nyeriJourneyV2, nyeriJourneyV3],
  savedDaysAgo: [74, 40, 6.4],
})

const timedCurrent = [houseEspresso, gujiFilter, lintongDark, decafSteady]
const journeyCurrent = [gentleJourney, nyeriJourney]

const demoProfileList: Profile[] = [
  houseEspresso.current,
  gujiFilter.current,
  lintongDark.current,
  decafSteady.current,
  gentleJourney.current,
  nyeriJourney.current,
]

const demoProfileRevisions = [...timedCurrent, ...journeyCurrent].flatMap((history) => history.revisions)

/* ------------------------------------------------------------------ bean history */

const beanHistory = (
  subject: BeanLot,
  earlier: Array<{ daysAgo: number; patch: Partial<BeanLot> }>,
): BeanRevision[] => {
  const chain = [...earlier.map((entry) => ({ ...subject, ...entry.patch })), subject]
  return earlier
    .map((entry, index) => ({
      id: `${subject.id}-rev-${index + 1}`,
      beanId: subject.id,
      savedAt: at(entry.daysAgo, 11),
      summary: index === 0 ? 'Created' : summarizeBeanChange(chain[index - 1], chain[index]),
      bean: { ...chain[index], updatedAt: at(entry.daysAgo, 11) },
    }))
    .concat([
      {
        id: `${subject.id}-rev-current`,
        beanId: subject.id,
        savedAt: subject.updatedAt,
        summary: summarizeBeanChange(chain[chain.length - 2], subject),
        bean: subject,
      },
    ])
}

const demoBeanRevisions: BeanRevision[] = [
  ...beanHistory(guji, [
    { daysAgo: 96, patch: { notes: '', greenDensityGPerMl: undefined, moisturePercent: undefined } },
    { daysAgo: 62, patch: { notes: 'Very sweet, ferments easily.' } },
  ]),
  ...beanHistory(lintong, [
    { daysAgo: 122, patch: { notes: '', moisturePercent: undefined } },
    { daysAgo: 80, patch: { notes: 'High moisture and irregular screen.' } },
  ]),
  ...beanHistory(nyeri, [{ daysAgo: 78, patch: { notes: '', cultivars: ['SL28'] } }]),
]

/* ------------------------------------------------------------------ roast runs */

/**
 * Roast telemetry generated by the app's OWN thermal model, with the estimated baseline
 * coefficients and a little repeatable noise.
 *
 * This is what makes the dev database coherent rather than merely populated. Every screen that
 * derives something - the simulation, the model-fit reading, a fitted calibration - is now looking
 * at data the model can actually explain, so a healthy demo reads as healthy and a genuinely bad
 * number is a genuinely bad number rather than an artefact of hand-drawn sample data.
 */
const roastSamples = (profile: Profile, massG: number, offsetC: number): TelemetrySample[] => {
  // The app's own simulator produces the telemetry, so a demo roast IS what the model says that
  // profile does. A timed profile replays its commands; a journey is driven by the same derived
  // control law a runner would use. Only the sensor wobble is added afterwards.
  const modelled = simulateProfileSnapshot({ profile, calibration: defaultCalibration, massG })
  return modelled.map((sample, index) => ({
    ...sample,
    beanTempC: Number(
      (sample.beanTempC + Math.sin(index / 23) * 0.5 + Math.sin(index / 7.5) * 0.25 + offsetC).toFixed(2),
    ),
    rorCPerMin: Number(sample.rorCPerMin.toFixed(2)),
  }))
}

interface RoastSpec {
  id: string
  profile: Profile
  beanLot: BeanLot
  daysAgo: number
  offsetC: number
  notes: string
  startingMassG: number
  finalMassG: number
  ambientC?: number
}

const roastRun = (spec: RoastSpec): RoastRun => {
  const ambientC = spec.ambientC ?? 21.5
  const samples = roastSamples(spec.profile, spec.startingMassG, spec.offsetC)
  const total = samples[samples.length - 1]?.elapsedSec ?? 600
  const startedAt = at(spec.daysAgo, 8 + (spec.daysAgo % 5))
  return {
    id: spec.id,
    name: automaticRunName(spec.profile, new Date(startedAt), spec.beanLot, spec.startingMassG),
    startedAt,
    completedAt: new Date(new Date(startedAt).getTime() + (total + 180) * 1000).toISOString(),
    profile: structuredClone(spec.profile),
    beanLotId: spec.beanLot.id,
    beanLotSnapshot: structuredClone(spec.beanLot),
    notes: spec.notes,
    controllerVersion: '2026-07-26.36',
    recordedOn: DEMO_RECORDED_ON,
    measurements: {
      startingMassG: spec.startingMassG,
      startingVolumeMl: Math.round(spec.startingMassG / (spec.beanLot.greenDensityGPerMl ?? 0.64)),
      finalMassG: spec.finalMassG,
      finalVolumeMl: Math.round(spec.finalMassG / 0.38),
      ambientC,
      moisturePercent: spec.beanLot.moisturePercent,
    },
    outcome: 'complete',
    samples,
    events: [
      { id: `${spec.id}-dry`, type: 'DRY_END', label: 'Dry end', elapsedSec: Math.round(total * 0.34) },
      { id: `${spec.id}-fc`, type: 'FIRST_CRACK', label: 'First crack', elapsedSec: Math.round(total * 0.76) },
      { id: `${spec.id}-drop`, type: 'DROP', label: 'Drop', elapsedSec: Math.round(total * 0.94) },
    ],
  }
}

const demoRunList: RoastRun[] = [
  roastRun({
    id: 'roast-house-1',
    profile: demoProfileList[0],
    beanLot: starterBean,
    daysAgo: 104,
    offsetC: -1.4,
    notes: 'First batch on the new house revision. Slightly flat finish.',
    startingMassG: 225,
    finalMassG: 190,
  }),
  roastRun({
    id: 'roast-lintong-1',
    profile: lintongDark.current,
    beanLot: lintong,
    daysAgo: 88,
    offsetC: 0.9,
    notes: 'Chaff everywhere. Long dry phase worked; the bean chamber needed a clean afterwards.',
    startingMassG: 250,
    finalMassG: 203,
  }),
  roastRun({
    id: 'roast-guji-1',
    profile: gujiFilter.current,
    beanLot: guji,
    daysAgo: 71,
    offsetC: -0.6,
    notes: 'Dropped at the very start of first crack. Cup was jammy but a touch under.',
    startingMassG: 200,
    finalMassG: 172,
  }),
  roastRun({
    id: 'roast-house-2',
    profile: demoProfileList[0],
    beanLot: huehue,
    daysAgo: 52,
    offsetC: 0.4,
    notes: 'Huehuetenango in the house profile, unchanged. Indistinguishable from the Huila.',
    startingMassG: 225,
    finalMassG: 189,
  }),
  roastRun({
    id: 'roast-nyeri-1',
    profile: nyeriJourney.current,
    beanLot: nyeri,
    daysAgo: 38,
    offsetC: 1.1,
    notes: 'Journey used as a comparison target only - the run itself was driven by hand.',
    startingMassG: 200,
    finalMassG: 171,
  }),
  roastRun({
    id: 'roast-guji-2',
    profile: gujiFilter.current,
    beanLot: guji,
    daysAgo: 27,
    offsetC: 0.2,
    notes: 'Twenty seconds shorter in development. Much better clarity.',
    startingMassG: 200,
    finalMassG: 171,
  }),
  roastRun({
    id: 'roast-decaf-1',
    profile: decafSteady.current,
    beanLot: decafSidamo,
    daysAgo: 16,
    offsetC: -0.9,
    notes: 'Colour said done at 6:30, the clock said otherwise. Trusted the clock.',
    startingMassG: 210,
    finalMassG: 176,
  }),
  roastRun({
    id: 'roast-house-3',
    profile: demoProfileList[0],
    beanLot: cerrado,
    daysAgo: 8,
    offsetC: 0.7,
    notes: 'Cerrado at 240 g on the current revision. Best espresso of the month.',
    startingMassG: 240,
    finalMassG: 202,
  }),
  roastRun({
    id: 'roast-lintong-2',
    profile: lintongDark.current,
    beanLot: lintong,
    daysAgo: 3,
    offsetC: -0.3,
    notes: 'Second Lintong. Oil just starting at drop, which is where this one wants to be.',
    startingMassG: 260,
    finalMassG: 210,
  }),
  // The Kenya has now been through two different profiles, which is what makes the Roast page's
  // usage-derived "Recommended" grouping worth looking at.
  roastRun({
    id: 'roast-nyeri-2',
    profile: gujiFilter.current,
    beanLot: nyeri,
    daysAgo: 2,
    offsetC: -0.4,
    notes: 'Nyeri on the Guji filter profile. Brighter than the journey run, and easier to repeat.',
    startingMassG: 200,
    finalMassG: 170,
  }),
]

/* ------------------------------------------------------------------ manual history */

const manualSession = (
  prefix: string,
  daysAgo: number,
  hour: number,
  steps: Array<{
    minute: number
    fan: number
    heat: number
    temperatureC?: number
    source?: 'local' | 'firmware'
    detail?: string
  }>,
): ManualEvent[] =>
  steps.map((step, index) => ({
    id: `${prefix}-${index}`,
    atMs: atMs(daysAgo, hour, step.minute),
    kind: step.fan === 0 && step.heat === 0 ? ('stop' as const) : ('apply' as const),
    fan: step.fan,
    heat: step.heat,
    temperatureC: step.temperatureC,
    source: step.source ?? 'local',
    detail: step.detail,
    recordedOn: DEMO_RECORDED_ON,
  }))

const demoManualEvents: ManualEvent[] = [
  ...manualSession('manual-chaff', 34, 10, [
    { minute: 0, fan: 9, heat: 0, temperatureC: 24.8 },
    { minute: 3, fan: 10, heat: 0, temperatureC: 24.4 },
    { minute: 6, fan: 0, heat: 0, temperatureC: 24.2 },
  ]),
  ...manualSession('manual-warm', 21, 14, [
    { minute: 0, fan: 6, heat: 4, temperatureC: 25.1 },
    { minute: 4, fan: 6, heat: 7, temperatureC: 96.4 },
    { minute: 9, fan: 4, heat: 8, temperatureC: 168.2 },
    { minute: 14, fan: 0, heat: 0, temperatureC: 214.7 },
  ]),
  ...manualSession('manual-probe', 11, 16, [
    { minute: 0, fan: 5, heat: 5, temperatureC: 24.9 },
    { minute: 7, fan: 5, heat: 9, temperatureC: 142.6 },
    { minute: 13, fan: 0, heat: 0, temperatureC: 231.9, source: 'firmware', detail: 'fault' },
  ]),
  ...manualSession('manual-dry', 4, 15, [
    { minute: 0, fan: 8, heat: 3, temperatureC: 24.6 },
    { minute: 5, fan: 8, heat: 6, temperatureC: 88.1 },
    { minute: 11, fan: 9, heat: 0, temperatureC: 176.3 },
    { minute: 15, fan: 0, heat: 0, temperatureC: 61.4 },
  ]),
]

/* ------------------------------------------------------------------ calibration passes */

const GRID_FANS = [1, 4, 7, 10]
/**
 * Declared hottest-first, and that is a real choice rather than a typo.
 *
 * `expandBaselineGrid` walks the heats forwards in the first fan group and backwards in the second,
 * so with an EVEN number of fan groups the serpentine ends on whichever end of the heat list it
 * started from. Starting at heat 1 therefore ends the whole pass on its coldest step, with the
 * chamber near ambient - and the passive tail that follows then has little decay to measure, so the
 * forced tail cannot constrain the cooling coefficient at all. Starting hot ends hot, and the
 * cooling tail is worth something.
 */
const GRID_HEATS = [8.3, 5, 1]

// A repeatable low-amplitude wobble instead of Math.random, so the seed stays byte-identical.
const wobble = (index: number) => Math.sin(index * 1.7) * 0.16 + Math.sin(index * 0.41) * 0.11

/**
 * The two baseline passes are INTEGRATED, not drawn.
 *
 * A closed-form exponential toward a hand-written surface - a rise that barely grows with heat, a
 * large fan term, and one rise time constant at every point - is not a fluid-bed roaster, and worse,
 * it is a different machine from the one the mock controller simulates, so the air map in the
 * library and the air map the dev roaster produces would disagree.
 *
 * Both therefore run `src/data/chamberPlant.ts`, one second at a time, through the same serpentine the
 * firmware walks, then the deliberate fan-off tail - the wall node included, so the
 * tail really does soak back before it decays and `afterRebound` has something to trim. The result is
 * a pass whose numbers were produced by physics rather than asserted. Its empty-air node is
 * anchored to the measured response (about 94-170 s across the working fan range); the slower wall node also preserves the
 * physically important fan-off rebound.
 */
interface PassSpec {
  id: string
  daysAgo: number
  ambientC: number
  /** The chamber's own condition on the day. 1 is nominal; see `chamberDriveCPerMin`. */
  elementScale: number
  /** The program's step cap. A short cap is what leaves points extrapolated rather than measured. */
  maxStepSeconds: number
  notes: string
}

/**
 * How long a step is held. A step advances when the reading holds still, and a first-order chamber
 * holds still after a few of its own time constants, so the dwell is written in time constants:
 * four of them is about 98% of the way there, which is comfortably beyond `PLATEAU_FRACTION` before
 * it will call a point measured rather than extrapolated. The step cap then decides whether that is
 * affordable. Both demo passes respect the controller's 300 s cap: that truncates
 * some rows while their clean rise still identifies an asymptote, so the UI contains honest
 * extrapolated markers alongside the fully settled newer pass.
 */
const SETTLE_TIME_CONSTANTS = 4

const buildPass = (spec: PassSpec): CalibrationRun => {
  const steps = expandBaselineGrid(GRID_FANS, GRID_HEATS)
  const samples: ThermalSample[] = []
  let nodes: ChamberNodes = { airC: spec.ambientC, wallC: spec.ambientC }
  let seconds = 0
  let index = 0

  const record = (fan: number, heat: number) => {
    nodes = stepChamber(nodes, { fan, heat, ambientC: spec.ambientC, dtSec: 1, elementScale: spec.elementScale })
    seconds += 1
    index += 1
    samples.push({
      tMs: seconds * 1000,
      thermocoupleC: Number((nodes.airC + wobble(index)).toFixed(2)),
      coldJunctionC: Number((spec.ambientC + Math.sin(index / 900) * 0.3).toFixed(2)),
      effectiveFan: fan,
      effectiveHeat: heat,
    })
  }

  for (const step of steps) {
    const actual = effectiveLevels(step)
    const dwell = Math.min(spec.maxStepSeconds, Math.round(chamberTauSec(actual.fan) * SETTLE_TIME_CONSTANTS))
    for (let second = 0; second < dwell; second += 1) record(actual.fan, actual.heat)
  }

  /*
   * Deliberate fan-only tail: the profile keeps the fan running with heat off. This
   * half of the tail falls from its first sample and is what the cooling-fan coefficient comes from.
   * It runs its minimum whatever the chamber is at - the serpentine's last group is a low-heat one
   * and can finish well under 60 °C; retaining the full tail makes its coefficient measurable.
   */
  for (let second = 0; second < 300 && (second < 90 || nodes.airC > 60); second += 1) record(10, 0)

  /*
   * And then the fan stops. Everything the thermal-loss coefficient is derived from lives in this
   * window and nowhere else, which is why the firmware keeps recording for three minutes after the
   * last output. The first ~30 s of it is heat-soak rebound - the wall is still hotter than the air
   * and nothing is carrying that away any more - and `afterRebound` trims exactly that before fitting
   * the clean decay behind it.
   */
  for (let second = 0; second < 180; second += 1) record(0, 0)

  return {
    id: spec.id,
    capturedAt: at(spec.daysAgo, 13),
    recordedOn: DEMO_RECORDED_ON,
    // The roaster recorded these under its diagnostic program, which is what lets Calibrate STATE
    // that the chamber was empty rather than asking a question whose answer is already known.
    sourceMode: 'calibration',
    form: 'grid',
    steps,
    maxStepSeconds: spec.maxStepSeconds,
    minStepSeconds: 20,
    settleSeconds: 15,
    settleBandC: 1.5,
    ambientC: spec.ambientC,
    samples,
    notes: spec.notes,
  }
}

const springPass = buildPass({
  id: 'calibration-spring-baseline',
  daysAgo: 97,
  ambientC: 21.8,
  elementScale: 1,
  maxStepSeconds: 300,
  notes:
    'Spring baseline, empty chamber, workshop at 21.8 °C. Run with the 300 s step cap, so the fastest points settle while slower points are honestly extrapolated from their clean rise curves.',
})

const summerPass = buildPass({
  id: 'calibration-summer-baseline',
  daysAgo: 15,
  ambientC: 24.6,
  elementScale: 1.005,
  maxStepSeconds: 300,
  notes:
    'Summer repeat of the same grid, three months on, with the same realistic 300 s step cap. Same chamber, no cleaning between passes; the workshop is 2.8 °C warmer.',
})

const demoCalibrationRuns = [summerPass, springPass]

/* ------------------------------------------------ the loaded characterization roast */

/**
 * The demo's first real baseline: a LOADED roast, driven by hand from Controls, recorded at
 * 1 Hz exactly as the controller records a diagnostic pass.
 *
 * It is deliberately roasted the way the Calibrate guide tells the user to roast one - the fan is
 * swept at a constant heat, and the heat is stepped at a constant fan - because that is what lets a
 * fit tell heater gain and fan cooling apart instead of trading one against the other. Everything
 * else in the demo is a normal roast; this one exists to be fitted.
 *
 * The samples are generated from the app's own thermal model with coefficients that are NOT the
 * shipped estimate: a slightly stronger element, more airflow bite and a lossier chamber, standing
 * in for a real machine's departure from the estimate. The fit then has something real to find, and the
 * applied calibration in the demo genuinely differs from the starting baseline.
 */
const DEMO_ROASTER_TRUTH = {
  heaterGainCPerMinAt10: 58,
  fanCoolingCPerMinAt10: 24,
  coolingFanCPerMinAt10: 31,
  thermalLossPerMinPerC: 0.19,
}

const CHARACTERIZATION_MASS_G = 225
const CHARACTERIZATION_AMBIENT_C = 21.5

interface HandStep {
  fan: number
  heat: number
  seconds: number
}

const characterizationSteps: HandStep[] = [
  // Drying, with the fan swept twice at a held heat: this is the part that identifies airflow.
  { fan: 8, heat: 7, seconds: 150 },
  { fan: 5, heat: 7, seconds: 120 },
  { fan: 8, heat: 7, seconds: 120 },
  // Then heat stepped at a held fan, which identifies the element.
  { fan: 6, heat: 5, seconds: 120 },
  { fan: 6, heat: 9, seconds: 150 },
  // And a full cooling tail, which is the only thing that constrains the cooling coefficient.
  { fan: 10, heat: 0, seconds: 240 },
]

interface HandRecording {
  steps: HandStep[]
  massG: number
  ambientC: number
  truth: Partial<CalibrationSettings>
  /** Shifts the repeatable wobble, so two recordings of the same shape are not the same bytes. */
  phase: number
}

const handRecordedSamples = ({ steps, massG, ambientC, truth, phase }: HandRecording): ThermalSample[] => {
  const calibration = { ...defaultCalibration, ...truth }
  const samples: ThermalSample[] = []
  let temperatureC = ambientC
  let rorCPerMin: number | undefined
  let seconds = 0
  samples.push({
    tMs: 0,
    thermocoupleC: Number(temperatureC.toFixed(2)),
    coldJunctionC: ambientC,
    effectiveFan: steps[0].fan,
    effectiveHeat: steps[0].heat,
  })
  for (const step of steps) {
    const levels = effectiveLevels({ fan: step.fan, heat: step.heat })
    for (let second = 0; second < step.seconds; second += 1) {
      const result = thermalStep(
        {
          previousBeanTempC: temperatureC,
          previousRorCPerMin: rorCPerMin,
          fan: levels.fan,
          heat: levels.heat,
          cooling: levels.heat === 0,
          batchMassG: massG,
          ambientC,
        },
        calibration,
      )
      temperatureC = result.beanTempC
      rorCPerMin = result.rorCPerMin
      seconds += 1
      samples.push({
        tMs: seconds * 1000,
        thermocoupleC: Number((temperatureC + wobble(seconds + phase) * 1.4).toFixed(2)),
        coldJunctionC: Number((ambientC + Math.sin((seconds + phase) / 700) * 0.2).toFixed(2)),
        effectiveFan: levels.fan,
        effectiveHeat: levels.heat,
      })
    }
  }
  return samples
}

const handRecordedRun = (
  spec: HandRecording & { id: string; capturedAt: string; notes: string; roastRunId?: string; densityGPerMl?: number },
): CalibrationRun => ({
  id: spec.id,
  capturedAt: spec.capturedAt,
  recordedOn: DEMO_RECORDED_ON,
  roastRunId: spec.roastRunId,
  // A hand-driven roast is a MANUAL recording as far as the roaster is concerned, which is exactly
  // the case where the classification control still has a real question to ask.
  sourceMode: 'manual',
  form: 'steps',
  steps: spec.steps.map((step) => ({ fan: step.fan, heat: step.heat })),
  maxStepSeconds: 300,
  minStepSeconds: 20,
  settleSeconds: 15,
  settleBandC: 1.5,
  ambientC: spec.ambientC,
  samples: handRecordedSamples(spec),
  notes: spec.notes,
  // Recording the batch is what marks this a LOADED run rather than an empty-chamber pass.
  massG: spec.massG,
  densityGPerMl: spec.densityGPerMl,
})

const characterizationRun = handRecordedRun({
  id: 'calibration-loaded-characterization',
  capturedAt: at(9, 11),
  steps: characterizationSteps,
  massG: CHARACTERIZATION_MASS_G,
  ambientC: CHARACTERIZATION_AMBIENT_C,
  truth: DEMO_ROASTER_TRUTH,
  phase: 0,
  densityGPerMl: 0.62,
  notes:
    'Loaded characterization roast, driven by hand. Fan swept at held heat, then heat stepped at held fan, then a full cooling tail - the shape that lets a fit separate the element from the airflow.',
})

/**
 * ============================================================================================
 * FOUR MORE ROASTS THAT CARRY A RECORDING, SO THE PICKER IS A CHOICE RATHER THAN A FORMALITY
 * ============================================================================================
 *
 * The demo had exactly one loaded recording, and it was linked to no roast at all, so the roast
 * picker under Loaded roasts offered a single unnamed candidate. A picker with one option in it
 * cannot be reviewed - you cannot see whether the labels distinguish anything, whether the badges
 * mean different things on different rows, or what pooling several roasts actually does.
 *
 * These four are linked to roasts that already exist in the archive, so each one arrives with a
 * name, a batch weight and its measured covariates, exactly as a real one would. They deliberately
 * differ in the ONE property that decides what a fit can learn from them:
 *
 *   guji-2    fan swept at a held heat, then heat stepped at a held fan - fully separable
 *   house-3   the same shape, shorter, on a slightly different machine day
 *   decaf-1   heat stepped at one fan and never a fan move - the element is identifiable, airflow is not
 *   lintong-2 fan and heat only ever moved together - neither can be told from the other
 *
 * Their coefficients differ a little from each other around the demo roaster's truth, which is what
 * makes pooling several of them mean something: a set that suits one and ruins another scores badly,
 * and with one recording in the library that could never be shown.
 */
const shiftedTruth = (heat: number, fan: number, loss: number) => ({
  heaterGainCPerMinAt10: DEMO_ROASTER_TRUTH.heaterGainCPerMinAt10 + heat,
  fanCoolingCPerMinAt10: DEMO_ROASTER_TRUTH.fanCoolingCPerMinAt10 + fan,
  coolingFanCPerMinAt10: DEMO_ROASTER_TRUTH.coolingFanCPerMinAt10,
  thermalLossPerMinPerC: DEMO_ROASTER_TRUTH.thermalLossPerMinPerC + loss,
})

const loadedRoastRecordings: CalibrationRun[] = [
  handRecordedRun({
    id: 'calibration-loaded-guji-2',
    roastRunId: 'roast-guji-2',
    capturedAt: at(27, 10),
    massG: 200,
    ambientC: 22.4,
    truth: shiftedTruth(1.5, -1, 0.004),
    phase: 311,
    densityGPerMl: 0.62,
    notes:
      'Guji driven by hand to be fittable: the fan was swept at a held heat through drying, then the heat stepped at a held fan.',
    steps: [
      { fan: 8, heat: 7, seconds: 140 },
      { fan: 5, heat: 7, seconds: 110 },
      { fan: 8, heat: 7, seconds: 110 },
      { fan: 6, heat: 5, seconds: 110 },
      { fan: 6, heat: 9, seconds: 140 },
      { fan: 10, heat: 0, seconds: 210 },
    ],
  }),
  handRecordedRun({
    id: 'calibration-loaded-house-3',
    roastRunId: 'roast-house-3',
    capturedAt: at(8, 10),
    massG: 240,
    ambientC: 23.9,
    truth: shiftedTruth(-2, 1.5, -0.006),
    phase: 733,
    densityGPerMl: 0.71,
    notes: 'Cerrado on the house profile, driven by hand for the same separable shape. Warmer room than the Guji day.',
    steps: [
      { fan: 9, heat: 7, seconds: 120 },
      { fan: 6, heat: 7, seconds: 100 },
      { fan: 7, heat: 4, seconds: 100 },
      { fan: 7, heat: 8, seconds: 130 },
      { fan: 10, heat: 0, seconds: 200 },
    ],
  }),
  handRecordedRun({
    id: 'calibration-loaded-decaf-1',
    roastRunId: 'roast-decaf-1',
    capturedAt: at(16, 10),
    massG: 210,
    ambientC: 21.9,
    truth: shiftedTruth(0.5, 2, 0.002),
    phase: 1279,
    densityGPerMl: 0.58,
    notes:
      'Decaf run on the clock. The heat was stepped but the fan never moved, so this one constrains the element and says nothing about airflow.',
    steps: [
      { fan: 8, heat: 6, seconds: 150 },
      { fan: 8, heat: 8, seconds: 150 },
      { fan: 8, heat: 5, seconds: 120 },
      { fan: 10, heat: 0, seconds: 200 },
    ],
  }),
  handRecordedRun({
    id: 'calibration-loaded-lintong-2',
    roastRunId: 'roast-lintong-2',
    capturedAt: at(3, 10),
    massG: 260,
    ambientC: 24.1,
    truth: shiftedTruth(-1, -2, 0.005),
    phase: 1811,
    densityGPerMl: 0.68,
    notes:
      'Lintong roasted normally: fan and heat were walked together the whole way, which is what an ordinary roast looks like and why an ordinary roast is a poor fit input.',
    steps: [
      { fan: 9, heat: 6, seconds: 150 },
      { fan: 8, heat: 7, seconds: 130 },
      { fan: 7, heat: 8, seconds: 150 },
      { fan: 10, heat: 0, seconds: 200 },
    ],
  }),
]

const characterizationFit = fitCoefficientsFromLog(
  [fitSourceFromRun(characterizationRun, 'Loaded characterization roast')],
  defaultCalibration,
)

const characterizationSnapshot: CalibrationSnapshot = {
  id: 'calibration-snapshot-loaded',
  name: 'Loaded characterization roast',
  createdAt: at(9, 12),
  // What the roaster echoes as its fit id once this set is applied, so the app can name it.
  applicationFitId: characterizationRun.id,
  recordedOn: DEMO_RECORDED_ON,
  runIds: [characterizationRun.id, summerPass.id, springPass.id],
  ambientC: CHARACTERIZATION_AMBIENT_C,
  patch: characterizationFit?.coefficients ?? {},
  curves: curvesFromBaselineMap(buildBaselineMap([summerPass, springPass])),
}

// The loaded roast the model is actually fitted from first, then the other four loaded roasts, then
// the two chamber passes. Order matters only to the tests that read "the loaded one" as the first.
const allCalibrationRuns = [characterizationRun, ...loadedRoastRecordings, ...demoCalibrationRuns]

const snapshotFrom = (run: CalibrationRun, id: string, name: string, daysAgo: number): CalibrationSnapshot => {
  const analysis = analyzeCalibrationRun(run)
  const staging = stageCalibration(analysis)
  return {
    id,
    name,
    createdAt: at(daysAgo, 14),
    recordedOn: run.recordedOn,
    runIds: [run.id],
    ambientC: analysis.ambientC,
    patch: staging.patch,
    curves: curveFamily(analysis),
  }
}

const springSnapshot = snapshotFrom(springPass, 'calibration-snapshot-spring', 'Spring baseline 4x3', 97)
const summerSnapshot = snapshotFrom(summerPass, 'calibration-snapshot-summer', 'Summer baseline 4x3', 15)

/* ------------------------------------------------------------------ the dataset */

export const richDemoDataset = (): DemoDataset => ({
  profiles: structuredClone(demoProfileList),
  beans: structuredClone(demoBeanLots),
  runs: structuredClone(demoRunList),
  profileRevisions: structuredClone(demoProfileRevisions),
  beanRevisions: structuredClone(demoBeanRevisions),
  manualEvents: structuredClone(demoManualEvents),
  calibrationRuns: structuredClone(allCalibrationRuns),
  calibrationSnapshots: structuredClone([characterizationSnapshot, summerSnapshot, springSnapshot]),
  /**
   * The demo has a real applied model: the coefficients fitted from the loaded characterization
   * roast. That is the whole point of the flow - a roast the user actually ran becomes the
   * baseline - and it is why the demo's provenance indicator reads "calibrated from" rather than
   * "estimated". The two chamber passes stay in the library as chamber examples; their large
   * model-fit residual against a bean model is real and is left visible on purpose.
   */
  appliedCalibration: {
    ...characterizationSnapshot.patch,
    thermalSourceDeviceId: characterizationSnapshot.recordedOn.deviceId,
    thermalSourceModelId: characterizationSnapshot.recordedOn.modelId,
    thermalSourceRunId: characterizationRun.id,
    thermalSourceCapturedAt: characterizationRun.capturedAt,
    thermalStagedAt: characterizationSnapshot.createdAt,
    updatedAt: characterizationSnapshot.createdAt,
  },
})
