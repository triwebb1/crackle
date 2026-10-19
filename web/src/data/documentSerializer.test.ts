import { describe, expect, it } from 'vitest'
import { recordingKey } from '../domain/provenance'
import { analyzeCalibrationRun, stageCalibration } from '../domain/thermalLog'
import type {
  BeanRevision,
  CalibrationRun,
  CalibrationSnapshot,
  ManualEvent,
  ProfileRevision,
  RoastRun,
  TelemetrySample,
} from '../domain/types'
import { defaultCalibration } from './calibration'
import { demoRuns, starterBean, starterProfile, starterThermalIntent } from './demo'
import {
  byteLength,
  COLLECTION_CAP_BYTES,
  calibrationSamples,
  DOCUMENT_PREFIX,
  diskLevel,
  diskTemperatureC,
  packDocumentJson,
  parseBeansDocument,
  parseCalibrationsDocument,
  parseMetaDocument,
  parseProfilesDocument,
  parseRunDocument,
  RUN_CAP_BYTES,
  RUN_TARGET_BYTES,
  serializeBeansDocument,
  serializeCalibrationsDocument,
  serializeMetaDocument,
  serializeProfilesDocument,
  serializeRunDocument,
  stridedSample,
  unpackDocumentJson,
} from './documentSerializer'

const body = (payload: string) => JSON.parse(unpackDocumentJson(payload)) as Record<string, unknown>
const recordedOn = {
  deviceId: 'test-device',
  modelId: 'freshroast-sr800',
  displayNameAtCapture: 'Test SR800',
  simulated: true,
  simulatesModelId: 'freshroast-sr800',
  firmwareVersion: 'test',
  identitySource: 'roaster' as const,
}
const origin = (logId: string) => ({ deviceId: recordedOn.deviceId, logId })
const deviceRoast = (logId: string) => ({
  recordingOrigin: origin(logId),
  storageAddress: origin(logId),
  name: 'House espresso',
  dateUnknown: false,
  profileLinked: true,
})

const sample = (elapsedSec: number, beanTempC: number): TelemetrySample => ({
  elapsedSec,
  beanTempC,
  rorCPerMin: 12.345,
  requestedFan: 7.25,
  effectiveFan: 7.25,
  requestedHeat: 5.04,
  effectiveHeat: 5.04,
  phase: 'MAILLARD',
})

const runWith = (patch: Partial<RoastRun>): RoastRun => ({ ...structuredClone(demoRuns[0]), ...patch })

describe('minimal calibration storage', () => {
  const snapshot = (): CalibrationSnapshot => ({
    id: 'provisional-fit',
    name: 'Provisional chamber fit',
    createdAt: '2026-07-30T16:05:00.000Z',
    recordedOn,
    runIds: ['empty-pass-1'],
    patch: { heaterGainCPerMinAt10: 64.25, thermalLossPerMinPerC: 0.019 },
    curves: [],
  })

  it('drops firmware electrical timing and synthetic sensor fields at the persistence boundary', () => {
    const legacyShaped = {
      ...defaultCalibration,
      thermalSourceDeviceId: 'esp32-a',
      thermalSourceModelId: 'freshroast-sr800',
      fanMinimumDelayUs: 1000,
      heaterMaximumDelayUs: 8000,
      pulseWidthUs: 70,
      probeOffsetC: 3,
      sensorLagSec: 12,
    }
    const stored = body(serializeCalibrationsDocument(legacyShaped, [], [])).settings as Record<string, unknown>
    expect(stored).toMatchObject({
      referenceBatchMassG: defaultCalibration.referenceBatchMassG,
      coolingTargetMarginC: 5,
      thermalSourceDeviceId: 'esp32-a',
      thermalSourceModelId: 'freshroast-sr800',
    })
    expect(stored).not.toHaveProperty('fanMinimumDelayUs')
    expect(stored).not.toHaveProperty('pulseWidthUs')
    expect(stored).not.toHaveProperty('probeOffsetC')
    expect(stored).not.toHaveProperty('sensorLagSec')
  })

  it('round-trips attributed inherited coefficients without changing ordinary snapshots', () => {
    const provisional: CalibrationSnapshot = {
      ...snapshot(),
      patch: {
        ...snapshot().patch,
        fanCoolingCPerMinAt10: 18.375,
        coolingFanCPerMinAt10: 21.5,
      },
      inheritedCoefficients: {
        fanCoolingCPerMinAt10: {
          source: 'roaster-applied',
          value: 18.375,
          fitId: 'fit-device-41',
          appliedAt: '2026-07-30T15:59:12.000Z',
        },
        coolingFanCPerMinAt10: { source: 'roaster-applied', value: 21.5 },
      },
      applicationFitId: 'provisional:empty-pass-1',
    }

    const restored = parseCalibrationsDocument(
      serializeCalibrationsDocument(undefined, [snapshot(), provisional], []),
    ).snapshots

    expect(restored[0]).toEqual(snapshot())
    expect(restored[0]).not.toHaveProperty('inheritedCoefficients')
    expect(restored[0]).not.toHaveProperty('applicationFitId')
    expect(restored[1]).toEqual(provisional)
  })

  it('keeps only known, finite, explicitly roaster-applied inheritance from an incoming document', () => {
    const malformed = {
      ...snapshot(),
      patch: {
        heaterGainCPerMinAt10: 64.25,
        fanCoolingCPerMinAt10: 18,
        coolingFanCPerMinAt10: 21.5,
        thermalLossPerMinPerC: 0.01875,
      },
      inheritedCoefficients: {
        heaterGainCPerMinAt10: { source: 'browser-cache', value: 64 },
        fanCoolingCPerMinAt10: { source: 'roaster-applied', value: 19 },
        coolingFanCPerMinAt10: {
          source: 'roaster-applied',
          value: 21.5,
          fitId: 'bad\u0000id',
          appliedAt: 'not-a-date',
        },
        thermalLossPerMinPerC: {
          source: 'roaster-applied',
          value: 0.01875,
          fitId: '  fit-device-42  ',
          appliedAt: '2026-07-30T16:00:00.000Z',
        },
        nominalHalfCycleUs: { source: 'roaster-applied', value: 8333 },
      },
      applicationFitId: 'bad\nfit-id',
    }
    const payload = packDocumentJson(JSON.stringify({ v: 2, snapshots: [malformed], runs: [] }))

    expect(parseCalibrationsDocument(payload).snapshots[0]).toMatchObject({
      id: 'provisional-fit',
      inheritedCoefficients: {
        coolingFanCPerMinAt10: { source: 'roaster-applied', value: 21.5 },
        thermalLossPerMinPerC: {
          source: 'roaster-applied',
          value: 0.01875,
          fitId: 'fit-device-42',
          appliedAt: '2026-07-30T16:00:00.000Z',
        },
      },
    })
    const restored = parseCalibrationsDocument(payload).snapshots[0]
    expect(restored).not.toHaveProperty('applicationFitId')
    expect(restored.inheritedCoefficients).not.toHaveProperty('heaterGainCPerMinAt10')
    expect(restored.inheritedCoefficients).not.toHaveProperty('fanCoolingCPerMinAt10')
    expect(restored.inheritedCoefficients).not.toHaveProperty('nominalHalfCycleUs')
    expect(restored.inheritedCoefficients?.coolingFanCPerMinAt10).not.toHaveProperty('fitId')
    expect(restored.inheritedCoefficients?.coolingFanCPerMinAt10).not.toHaveProperty('appliedAt')

    const rewritten = parseCalibrationsDocument(
      serializeCalibrationsDocument(undefined, [malformed as unknown as CalibrationSnapshot], []),
    ).snapshots[0]
    expect(rewritten.inheritedCoefficients).toEqual(restored.inheritedCoefficients)
    expect(rewritten).not.toHaveProperty('applicationFitId')
  })
})

describe('compact controller document format', () => {
  it('stores only the compact ASCII envelope and rejects raw or damaged JSON', () => {
    const payload = serializeBeansDocument([starterBean], [])
    expect(payload.startsWith(DOCUMENT_PREFIX)).toBe(true)
    expect(payload).toMatch(/^[A-Za-z0-9+/=:]+$/)
    expect(parseBeansDocument(payload).beans).toEqual([starterBean])
    expect(() => parseBeansDocument('{"v":1,"beans":[]}')).toThrow(/compact Crackle document/)
    expect(() => parseBeansDocument(`${DOCUMENT_PREFIX}not-valid-base64`)).toThrow(/damaged/)
  })

  it('rejects malformed profile and bean rows instead of trusting parsed JSON casts', () => {
    const badProfiles = packDocumentJson(
      JSON.stringify({ v: 1, profiles: [{ id: 'p', name: 'broken' }], profileRevisions: [] }),
    )
    const badBeans = packDocumentJson(
      JSON.stringify({ v: 1, beans: [{ id: 'b', name: 'broken', origins: 'not-a-list' }], beanRevisions: [] }),
    )
    expect(() => parseProfilesDocument(badProfiles)).toThrow(/profiles document schema/)
    expect(() => parseBeansDocument(badBeans)).toThrow(/beans document schema/)
  })

  it('uses a storage target below the firmware hard cap so savings create room for more roasts', () => {
    const run = runWith({
      id: 'storage-target',
      samples: Array.from({ length: 4000 }, (_, index) => sample(index, 25 + index * 0.05)),
    })
    const payload = serializeRunDocument(run)
    expect(byteLength(payload)).toBeLessThanOrEqual(RUN_TARGET_BYTES)
    expect(RUN_TARGET_BYTES).toBeLessThan(RUN_CAP_BYTES)
  })
})

/**
 * The rounding rule, and the reason it lives in ONE module: a rounding rule applied in four screens
 * is a rounding rule applied in three. Everything a document can carry is checked here, in both
 * directions - what must round, and what must emphatically not.
 */
describe('tenths of a degree on disk', () => {
  it('rounds a measured temperature to a tenth, half away from zero, in both signs', () => {
    expect(diskTemperatureC(186.44)).toBe(186.4)
    expect(diskTemperatureC(186.45)).toBe(186.5)
    expect(diskTemperatureC(-0.05)).toBe(-0.1)
    expect(diskTemperatureC(-2.44)).toBe(-2.4)
    // A tenth is the quantum, not a floor: a whole degree stays a whole degree.
    expect(diskTemperatureC(186)).toBe(186)
    /*
     * The reason it is tenths rather than integers. On a decay tail moving 0.4 °C a minute, whole
     * degrees flatten four consecutive samples onto one value and the rate computed from them reads
     * as exactly zero before jumping a full degree - a staircase the roaster never produced.
     */
    const tail = [212.6, 212.2, 211.8, 211.4].map(diskTemperatureC)
    expect(new Set(tail).size).toBe(4)
    // A level is exact for every 0.1 step the controller can command, and stays that way.
    expect(diskLevel(7.25)).toBe(7.3)
    expect(diskLevel(5.04)).toBe(5)
  })

  it('rounds every measured temperature a run document carries, and the peak with them', () => {
    const run = runWith({
      id: 'rounding-run',
      deviceRoast: undefined,
      measurements: { startingMassG: 227.5, ambientC: 24.62 },
      samples: [sample(0, 24.62), sample(60, 121.44), sample(120, 214.51)],
    })
    const document = body(serializeRunDocument(run))
    const samples = document.samples as number[][]
    expect(samples.map((tuple) => tuple[1])).toEqual([24.6, 121.4, 214.5])
    expect(document.summary).toMatchObject({ peakC: 214.5, durationSec: 120, sampleCount: 3 })
    // Ambient is a cold-junction reading. The mass on the scale beside it is not a temperature.
    expect((document.run as { measurements: { ambientC: number; startingMassG: number } }).measurements).toEqual({
      ambientC: 24.6,
      startingMassG: 227.5,
    })
    // Serialization is a one-way narrowing at the boundary. RAM keeps its decimals.
    expect(run.samples[0].beanTempC).toBe(24.62)
    expect(run.measurements?.ambientC).toBe(24.62)
  })

  it('keeps authored setpoints, fitted coefficients, R2 and tau at full precision', () => {
    const snapshot: CalibrationSnapshot = {
      id: 'fit-1',
      name: 'July fit',
      createdAt: '2026-07-01T00:00:00.000Z',
      recordedOn,
      runIds: ['pass-1'],
      ambientC: 24.62,
      patch: { heaterGainCPerMinAt10: 66.4173, thermalLossPerMinPerC: 0.017253 },
      fitRmsC: 2.7419,
      curves: [
        {
          fanLevel: 5,
          points: [
            {
              heat: 7,
              steadyStateC: 244.63,
              riseOverAmbientC: 220.01,
              tauSec: 71.4832,
              extrapolated: true,
              r2: 0.99731,
            },
          ],
        },
      ],
    }
    const document = body(serializeCalibrationsDocument(undefined, [snapshot], []))
    const stored = (document.snapshots as CalibrationSnapshot[])[0]
    // Measured: the settled temperature, the rise over ambient, and ambient itself.
    expect(stored.curves[0].points[0].steadyStateC).toBe(244.6)
    expect(stored.curves[0].points[0].riseOverAmbientC).toBe(220)
    expect(stored.ambientC).toBe(24.6)
    // Regression output: every digit is real and every digit survives.
    expect(stored.curves[0].points[0].tauSec).toBe(71.4832)
    expect(stored.curves[0].points[0].r2).toBe(0.99731)
    expect(stored.patch.heaterGainCPerMinAt10).toBe(66.4173)
    expect(stored.fitRmsC).toBe(2.7419)

    // Authored intent. 205.5 °C means 205.5 °C, and a zone endpoint is not a measurement.
    const profiles = body(
      serializeProfilesDocument(
        [{ ...starterThermalIntent, segments: [{ ...starterThermalIntent.segments[0], endC: 205.5 }] }],
        [],
      ),
    )
    expect(JSON.stringify(profiles)).toContain('205.5')
    expect(JSON.stringify(body(serializeProfilesDocument([starterProfile], [])))).toContain('8.2')
  })
})

describe('run documents', () => {
  it('carries a recording reference plus a bounded fallback curve for retention', () => {
    const run = runWith({
      id: 'device-roast-41',
      samples: Array.from({ length: 900 }, (_, index) => sample(index, 25 + index * 0.2)),
      deviceRoast: deviceRoast('41'),
    })
    const document = body(serializeRunDocument(run))
    expect(document.recordingId).toBe(recordingKey(origin('41')))
    expect((document.samples as number[]).length).toBeGreaterThan(0)
    expect((document.samples as number[]).length).toBeLessThan(900)
    // The summary still describes the full recording rather than only the fallback density.
    expect(document.summary).toMatchObject({ sampleCount: 900, durationSec: 899 })
    expect(byteLength(serializeRunDocument(run))).toBeLessThan(RUN_CAP_BYTES)
    expect(parseRunDocument(serializeRunDocument(run)).samples.at(-1)?.elapsedSec).toBe(899)
  })

  it('downsamples a browser-only series to fit, keeps the ends, and says that it did', () => {
    const samples = Array.from({ length: 4000 }, (_, index) => sample(index, 25 + index * 0.05))
    const run = runWith({ id: 'legacy-import', deviceRoast: undefined, samples })
    const payload = serializeRunDocument(run)
    expect(byteLength(payload)).toBeLessThanOrEqual(RUN_CAP_BYTES)
    const document = body(payload)
    const stored = document.samples as number[][]
    expect(stored.length).toBeLessThan(samples.length)
    expect(stored[0][0]).toBe(0)
    // The last sample is always kept: the end of a roast is the part a reviewer looks at.
    expect(stored[stored.length - 1][0]).toBe(3999)
    expect(document.samplesNote).toMatch(/Downsampled from 4000 samples/)
  })

  it('round-trips a run through the document and back', () => {
    const run = runWith({ id: 'round-trip', deviceRoast: undefined, samples: [sample(0, 24.6), sample(30, 120.2)] })
    const restored = parseRunDocument(serializeRunDocument(run))
    expect(restored.id).toBe('round-trip')
    expect(restored.name).toBe(run.name)
    expect(restored.profile.id).toBe(run.profile.id)
    expect(restored.samples).toEqual([
      {
        elapsedSec: 0,
        beanTempC: 24.6,
        rorCPerMin: 12.3,
        requestedFan: 7.3,
        effectiveFan: 7.3,
        requestedHeat: 5,
        effectiveHeat: 5,
        phase: 'MAILLARD',
      },
      {
        elapsedSec: 30,
        beanTempC: 120.2,
        rorCPerMin: 12.3,
        requestedFan: 7.3,
        effectiveFan: 7.3,
        requestedHeat: 5,
        effectiveHeat: 5,
        phase: 'MAILLARD',
      },
    ])
  })

  it('round-trips a manual roast origin and applies the run document precision rules', () => {
    const run = runWith({
      id: 'manual-round-trip',
      deviceRoast: undefined,
      samples: [sample(0, 24.6)],
      manualRoast: {
        stoppedElapsedSec: 90.06,
        endReason: 'instruction_expired',
        logId: '52',
        changes: [
          {
            id: 'manual-change-1',
            elapsedSec: 0.06,
            requestedFan: 1.34,
            requestedHeat: 8.04,
            effectiveFan: 1.38,
            effectiveHeat: 8.04,
            temperatureC: 186.45,
            source: 'local',
          },
        ],
      },
    })
    const restored = parseRunDocument(serializeRunDocument(run))
    expect(restored.manualRoast).toEqual({
      stoppedElapsedSec: 90.1,
      endReason: 'instruction_expired',
      logId: '52',
      changes: [
        {
          id: 'manual-change-1',
          elapsedSec: 0.1,
          requestedFan: 1.3,
          requestedHeat: 8,
          effectiveFan: 1.4,
          effectiveHeat: 8,
          temperatureC: 186.5,
          source: 'local',
        },
      ],
    })
  })

  it('stores codec-2 provenance in its bounded envelope and hydrates the exact plan on read', () => {
    const envelope = Uint8Array.of(0xc7, 1, 3, 1, 0, 9, 0, 50, 60)
    let binary = ''
    for (const byte of envelope) binary += String.fromCharCode(byte)
    const planEnvelope = btoa(binary)
    const run = runWith({
      id: 'codec-2-round-trip',
      deviceRoast: {
        ...deviceRoast('62'),
        initialPlan: { mode: 'manual', fan: 5, heat: 6 },
        planJournal: [],
        planEnvelope,
      },
      samples: [sample(0, 24.6)],
    })
    const payload = serializeRunDocument(run)
    const stored = (body(payload).run as { deviceRoast: Record<string, unknown> }).deviceRoast
    expect(stored.planEnvelope).toBe(planEnvelope)
    expect(stored.initialPlan).toBeUndefined()
    expect(stored.planJournal).toBeUndefined()
    expect(byteLength(payload)).toBeLessThan(RUN_CAP_BYTES)
    expect(parseRunDocument(payload).deviceRoast).toMatchObject({
      planEnvelope,
      initialPlan: { mode: 'manual', fan: 5, heat: 6 },
      planJournal: [],
    })
  })

  it('spreads a downsample evenly rather than truncating it', () => {
    expect(stridedSample([1, 2, 3, 4, 5, 6, 7, 8], 4)).toEqual([1, 3, 5, 8])
    expect(stridedSample([1, 2, 3], 9)).toEqual([1, 2, 3])
    expect(stridedSample([1, 2, 3], 0)).toEqual([])
  })
})

describe('collection documents', () => {
  const revision = (index: number, profileId: string): ProfileRevision => ({
    id: `revision-${profileId}-${index}`,
    profileId,
    revision: index,
    savedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    summary: 'Heat step 3 changed',
    profile: { ...starterProfile, id: profileId, revision: index },
  })

  it('keeps the newest revisions per profile and fits the collection cap', () => {
    const revisions = ['a', 'b', 'c'].flatMap((id) => Array.from({ length: 40 }, (_, index) => revision(index + 1, id)))
    const payload = serializeProfilesDocument([starterProfile, starterThermalIntent], revisions)
    expect(byteLength(payload)).toBeLessThanOrEqual(COLLECTION_CAP_BYTES)
    const document = body(payload)
    const stored = document.profileRevisions as ProfileRevision[]
    // Per subject, so one heavily edited profile can never push another's history out.
    for (const id of ['a', 'b', 'c']) {
      const mine = stored.filter((row) => row.profileId === id)
      expect(mine.length).toBeGreaterThan(0)
      expect(mine[0].revision).toBe(40)
    }
    expect(document.revisionNote).toMatch(/newest \d+ profile revisions/)
    // Profiles themselves are never shed: they are the library, not its history.
    expect(parseProfilesDocument(payload).profiles.map((profile) => profile.id)).toEqual([
      starterProfile.id,
      starterThermalIntent.id,
    ])
  })

  it('round-trips bean lots and their history', () => {
    const beanRevision: BeanRevision = {
      id: 'bean-revision-1',
      beanId: starterBean.id,
      savedAt: '2026-02-01T00:00:00.000Z',
      summary: 'Notes edited',
      bean: starterBean,
    }
    const restored = parseBeansDocument(serializeBeansDocument([starterBean], [beanRevision]))
    expect(restored.beans).toEqual([starterBean])
    expect(restored.beanRevisions).toEqual([beanRevision])
  })

  it('downsamples calibration pass samples until the calibrations document fits', () => {
    const pass = (id: string): CalibrationRun => ({
      id,
      capturedAt: '2026-07-01T00:00:00.000Z',
      recordedOn,
      form: 'grid',
      steps: [{ fan: 5, heat: 7 }],
      maxStepSeconds: 180,
      minStepSeconds: 20,
      settleSeconds: 15,
      settleBandC: 1.5,
      ambientC: 24.62,
      samples: Array.from({ length: 2000 }, (_, index) => ({
        tMs: index * 1000,
        thermocoupleC: 25 + index * 0.1,
        coldJunctionC: 24.55,
        effectiveFan: 5,
        effectiveHeat: 7,
      })),
      notes: '',
    })
    const payload = serializeCalibrationsDocument(undefined, [], [pass('one'), pass('two'), pass('three')])
    expect(byteLength(payload)).toBeLessThanOrEqual(COLLECTION_CAP_BYTES)
    const restored = parseCalibrationsDocument(payload)
    expect(restored.runs).toHaveLength(3)
    expect(restored.runs[0].samples.length).toBeLessThan(2000)
    // Ambient rounds to a tenth; the authored settle band does not round at all.
    expect(restored.runs[0].ambientC).toBe(24.6)
    expect(restored.runs[0].settleBandC).toBe(1.5)
    // Every stored sample temperature is already at the disk quantum: rounding it again changes nothing.
    for (const stored of restored.runs[0].samples) {
      expect(diskTemperatureC(stored.thermocoupleC ?? 0)).toBe(stored.thermocoupleC)
    }
    expect(restored.runs[0].samples[0].coldJunctionC).toBe(24.6)
  })

  it('keeps every actuator segment, including a three-second forced-cooling tail', () => {
    const segment = (
      length: number,
      fan: number,
      heat: number,
      startMs: number,
      temperature: (index: number) => number,
    ) =>
      Array.from({ length }, (_, index) => ({
        tMs: startMs + index * 1000,
        thermocoupleC: temperature(index),
        coldJunctionC: 25,
        effectiveFan: fan,
        effectiveHeat: heat,
      }))
    const source = [
      ...segment(100, 1, 1, 0, (index) => 45 + index * 0.05),
      ...segment(100, 10, 1, 100_000, (index) => 50 - index * 0.05),
      ...segment(3, 10, 0, 200_000, (index) => 45 - index * 5),
      ...segment(97, 0, 0, 203_000, (index) => 35 - index * 0.05),
    ]

    const kept = calibrationSamples(source, 120)

    expect(kept).toHaveLength(120)
    expect(kept.map((sample) => sample.tMs)).toEqual([...kept].map((sample) => sample.tMs).sort((a, b) => a - b))
    expect(
      kept.filter((sample) => sample.effectiveFan === 10 && sample.effectiveHeat === 0).map((sample) => sample.tMs),
    ).toEqual([200_000, 201_000, 202_000])
    for (const [fan, heat] of [
      [1, 1],
      [10, 1],
      [10, 0],
      [0, 0],
    ]) {
      expect(
        kept.filter((sample) => sample.effectiveFan === fan && sample.effectiveHeat === heat).length,
      ).toBeGreaterThanOrEqual(2)
    }
  })

  it('retains all four staged coefficients after calibration compaction', () => {
    const samples: CalibrationRun['samples'] = []
    const add = (seconds: number, fan: number, heat: number, temperature: (second: number) => number) => {
      const start = samples.length * 1000
      for (let second = 0; second < seconds; second += 1)
        samples.push({
          tMs: start + second * 1000,
          thermocoupleC: temperature(second),
          coldJunctionC: 25,
          effectiveFan: fan,
          effectiveHeat: heat,
        })
    }
    add(60, 1, 1, () => 50)
    add(60, 1, 5, () => 100)
    add(60, 10, 5, () => 70)
    add(60, 10, 1, () => 35)
    add(3, 10, 0, (second) => 170 - second * 10)
    add(180, 0, 0, (second) => 25 + 125 * Math.exp(-second / 300))
    const run: CalibrationRun = {
      id: 'compact-model',
      capturedAt: '2026-07-30T15:35:00.000Z',
      recordedOn,
      form: 'steps',
      steps: [
        { fan: 1, heat: 1 },
        { fan: 1, heat: 5 },
        { fan: 10, heat: 5 },
        { fan: 10, heat: 1 },
      ],
      maxStepSeconds: 300,
      minStepSeconds: 20,
      settleSeconds: 20,
      settleBandC: 0.2,
      ambientC: 25,
      samples,
      notes: '',
    }

    const variants = Array.from(
      { length: 8 },
      (_, runIndex): CalibrationRun => ({
        ...run,
        id: `${run.id}-${runIndex}`,
        capturedAt: `2026-07-30T15:${String(35 + runIndex).padStart(2, '0')}:00.000Z`,
        samples: run.samples.map((sample, sampleIndex) => ({
          ...sample,
          thermocoupleC:
            sample.thermocoupleC === undefined
              ? undefined
              : sample.thermocoupleC + (((sampleIndex * 17 + runIndex * 31) % 11) - 5) / 10,
        })),
      }),
    )
    const compact = parseCalibrationsDocument(serializeCalibrationsDocument(undefined, [], variants)).runs[0]
    expect(compact.samples.length).toBeLessThanOrEqual(120)
    expect(compact.samples.filter((sample) => sample.effectiveFan === 10 && sample.effectiveHeat === 0)).toHaveLength(3)
    expect(Object.keys(stageCalibration(analyzeCalibrationRun(compact)).patch).sort()).toEqual([
      'coolingFanCPerMinAt10',
      'fanCoolingCPerMinAt10',
      'heaterGainCPerMinAt10',
      'thermalLossPerMinPerC',
    ])
  })

  it('carries the imported-recording ledger and the newest manual events', () => {
    const events: ManualEvent[] = Array.from({ length: 500 }, (_, index) => ({
      id: `event-${index}`,
      atMs: index * 1000,
      kind: index % 2 === 0 ? 'apply' : 'stop',
      fan: 6.5,
      heat: 4.25,
      temperatureC: 180.6,
      source: 'local',
      recordedOn,
    }))
    const payload = serializeMetaDocument([recordingKey(origin('43')), recordingKey(origin('41'))], events)
    expect(byteLength(payload)).toBeLessThanOrEqual(COLLECTION_CAP_BYTES)
    const restored = parseMetaDocument(payload)
    // The ledger travels whole: it is what stops a deleted roast reappearing on the other browser.
    expect(restored.importedDeviceLogs).toEqual([recordingKey(origin('41')), recordingKey(origin('43'))])
    expect(restored.manualEvents.length).toBeLessThanOrEqual(events.length)
    expect(restored.manualEvents.at(-1)).toMatchObject({
      id: 'event-499',
      fan: 6.5,
      heat: 4.3,
      temperatureC: 180.6,
      source: 'local',
    })
  })

  it('drops manual events at the zero tier without dropping the imported-recording ledger', () => {
    const noisyDetail = (seed: number) => {
      let state = seed
      return Array.from({ length: 1024 }, () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return String.fromCharCode(33 + (state % 90))
      }).join('')
    }
    const events: ManualEvent[] = Array.from({ length: 80 }, (_, index) => ({
      id: `large-event-${index}`,
      atMs: index * 1000,
      kind: 'apply',
      fan: 6.5,
      heat: 4.25,
      source: 'local',
      detail: noisyDetail(index + 1),
      recordedOn,
    }))
    const ledger = [recordingKey(origin('43')), recordingKey(origin('41'))]

    const payload = serializeMetaDocument(ledger, events)
    const stored = body(payload)
    const restored = parseMetaDocument(payload)

    expect(byteLength(payload)).toBeLessThanOrEqual(COLLECTION_CAP_BYTES)
    expect(restored.importedDeviceLogs).toEqual([...ledger].sort())
    expect(restored.manualEvents).toEqual([])
    expect(stored.manualNote).toBe(
      'The roaster keeps the newest 0 manual events (0 of 80); manual history is an operating log, not an archive.',
    )
  })
})

describe('calibrations document stays under the roaster cap as calibrations accumulate', () => {
  // Measured: 9.5 KB of the 12 KB cap after 12 saved calibrations, with nothing left to
  // compact but their display curves.
  const curves = Array.from({ length: 4 }, (_, fan) => ({
    fanLevel: fan * 3 + 1,
    points: Array.from({ length: 3 }, (_, heat) => ({
      heat: heat * 4 + 1,
      steadyStateC: 150.12 + fan + heat,
      riseOverAmbientC: 120.34 + heat,
      tauSec: 71.4832 + fan,
      extrapolated: false,
      r2: 0.99731,
    })),
  }))
  // Real calibrations differ in every measured value, which is what defeats the document compression.
  let seed = 7
  const noise = () => {
    seed = (seed * 16807) % 2147483647
    return (seed % 100000) / 1000
  }
  const measuredCurves = () =>
    curves.map((curve) => ({
      ...curve,
      points: curve.points.map((point) => ({
        ...point,
        steadyStateC: 120 + noise(),
        riseOverAmbientC: 90 + noise(),
        tauSec: 40 + noise(),
        r2: 0.9 + noise() / 1000,
      })),
    }))
  const saved = (index: number, patch: CalibrationSnapshot['patch']): CalibrationSnapshot => ({
    id: `calibration-${String(index).padStart(2, '0')}`,
    name: `Fitted from roasts with a deliberately long descriptive name ${index}`,
    createdAt: new Date(Date.UTC(2026, 6, 1) + index * 3_600_000).toISOString(),
    recordedOn,
    runIds: ['a', 'b', 'c'],
    patch,
    curves: measuredCurves(),
  })
  const applied = {
    heaterGainCPerMinAt10: 52.15,
    fanCoolingCPerMinAt10: 2.89,
    coolingFanCPerMinAt10: 17.12,
    thermalLossPerMinPerC: 0.253,
  }
  const settings = { ...defaultCalibration, ...applied }

  it('sheds the oldest curves first, keeping the newest three and the applied calibration intact', () => {
    const snapshots = Array.from({ length: 80 }, (_, index) =>
      saved(index + 1, index === 4 ? applied : { heaterGainCPerMinAt10: 40 + index, thermalLossPerMinPerC: 0.2 }),
    )
    const payload = serializeCalibrationsDocument(settings, snapshots, [])
    expect(byteLength(payload)).toBeLessThanOrEqual(COLLECTION_CAP_BYTES - 512)
    const restored = parseCalibrationsDocument(payload).snapshots
    const byId = new Map(restored.map((snapshot) => [snapshot.id, snapshot]))
    expect(restored).toHaveLength(80)
    for (const id of ['calibration-80', 'calibration-79', 'calibration-78', 'calibration-05'])
      expect(byId.get(id)!.curves.length).toBeGreaterThan(0)
    expect(byId.get('calibration-01')!.curves).toEqual([])
    // Every record keeps its coefficients.
    expect(byId.get('calibration-01')!.patch.heaterGainCPerMinAt10).toBe(40)
    // Shedding is oldest-first: once a newer one keeps curves, every newer one does too (the applied one aside).
    const kept = restored
      .filter((snapshot) => snapshot.id !== 'calibration-05')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((snapshot) => snapshot.curves.length > 0)
    expect(kept.indexOf(true)).toBeGreaterThan(0)
    expect(kept.slice(kept.indexOf(true)).every(Boolean)).toBe(true)
  })

  it('sheds nothing while the document fits', () => {
    const snapshots = [saved(1, applied), saved(2, { heaterGainCPerMinAt10: 41 })]
    const restored = parseCalibrationsDocument(serializeCalibrationsDocument(settings, snapshots, [])).snapshots
    expect(restored.every((snapshot) => snapshot.curves.length > 0)).toBe(true)
  })
})
