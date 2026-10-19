import { describe, expect, it } from 'vitest'
import { testRecordedOn } from '../testFixtures/provenance'
import { effectiveLevels as deviceLevels } from './actuatorFloors'
import {
  adaptiveTargetPoints,
  adaptiveTargetTemperatureAt,
  clampLevel,
  compressTelemetry,
  correctedLegacyRunName,
  effectiveCoolingTargetC,
  effectiveLevels,
  effectiveThermalIntent,
  normalizeThermalContinuity,
  parseClock,
  profileFromRun,
  resolveRunName,
  runDurationSec,
  targetTemperatureAt,
  thermalZoneCompletions,
  timedDuration,
  valuesAt,
} from './model'
import type { BeanLot, TelemetrySample, ThermalIntent, TimedProfile } from './types'

const profile: TimedProfile = {
  id: 'test',
  name: 'Test',
  revision: 1,
  strategy: 'timed',
  createdAt: '',
  updatedAt: '',
  metadata: { intent: '' },
  notes: '',
  points: [
    { id: 'a', timeSec: 0, fan: 5, heat: 2 },
    { id: 'b', timeSec: 60, fan: 4, heat: 8 },
  ],
  coolFan: 9,
  coolDurationSec: 90,
}

const sample = (elapsedSec: number, overrides: Partial<TelemetrySample> = {}): TelemetrySample => ({
  elapsedSec,
  beanTempC: 100,
  rorCPerMin: 10,
  requestedFan: 5,
  effectiveFan: 5,
  requestedHeat: 5,
  effectiveHeat: 5,
  phase: 'DRYING',
  ...overrides,
})

describe('roast domain model', () => {
  it('uses the final heat-off transition for a completed manual roast while retaining its thermal tail', () => {
    const thermalTail = [
      sample(0),
      sample(7),
      sample(8, { effectiveHeat: 0, requestedHeat: 0, phase: 'COOLING' }),
      sample(187, { effectiveHeat: 0, requestedHeat: 0, phase: 'COOLING' }),
    ]
    expect(runDurationSec({ samples: thermalTail, manualRoast: { changes: [], stoppedElapsedSec: 187 } })).toBe(8)
    expect(runDurationSec({ samples: thermalTail, manualRoast: undefined })).toBe(187)
    expect(thermalTail).toHaveLength(4)
  })

  it('clamps continuous levels to the supported 0 or 0.1 through 10 range', () => {
    expect(clampLevel(0.04)).toBe(0.1)
    expect(clampLevel(4.56)).toBe(4.6)
    expect(clampLevel(22)).toBe(10)
    expect(clampLevel(0)).toBe(0)
  })

  it('lifts a heat-on Fan to the device floor of 1.0 without hiding the requested value', () => {
    // Heat on means Fan 1.0 or higher, exactly as the firmware drives it.
    expect(effectiveLevels(0.1, 8)).toEqual({ requestedFan: 0.1, requestedHeat: 8, effectiveFan: 1, effectiveHeat: 8 })
    expect(effectiveLevels(0.1, 8).effectiveFan).toBe(deviceLevels({ fan: 0.1, heat: 8 }).fan)
    expect(effectiveLevels(3, 8)).toEqual({ requestedFan: 3, requestedHeat: 8, effectiveFan: 3, effectiveHeat: 8 })
    expect(effectiveLevels(0.5, 0)).toEqual({
      requestedFan: 0.5,
      requestedHeat: 0,
      effectiveFan: 0.5,
      effectiveHeat: 0,
    })
    expect(effectiveLevels(0, 0)).toEqual({ requestedFan: 0, requestedHeat: 0, effectiveFan: 0, effectiveHeat: 0 })
  })

  it('uses the last timed point at or before the current time', () => {
    expect(valuesAt(profile, 59).id).toBe('a')
    expect(valuesAt(profile, 60).id).toBe('b')
  })

  it('treats the final point as a step with a duration', () => {
    expect(timedDuration(profile)).toBe(150)
    expect(parseClock('2:30')).toBe(150)
    expect(parseClock('2:75')).toBeUndefined()
  })

  it('interpolates the desired temperature journey', () => {
    const intent: ThermalIntent = {
      id: 'intent',
      name: 'Intent',
      revision: 1,
      strategy: 'thermal-intent',
      createdAt: '',
      updatedAt: '',
      metadata: profile.metadata,
      notes: '',
      calibrationStatus: 'unavailable',
      segments: [
        { id: 'zone', startC: 20, endC: 120, durationSec: 100, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
      ],
    }
    expect(targetTemperatureAt(intent, 50)).toBe(70)
    expect(targetTemperatureAt(intent, 150)).toBe(120)
  })

  it('holds an overdue journey at the current zone target until measured completion', () => {
    const intent: ThermalIntent = {
      id: 'adaptive',
      name: 'Adaptive',
      revision: 1,
      strategy: 'thermal-intent',
      createdAt: '',
      updatedAt: '',
      metadata: profile.metadata,
      notes: '',
      calibrationStatus: 'unavailable',
      segments: [
        { id: 'one', startC: 20, endC: 120, durationSec: 100, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
        { id: 'two', startC: 120, endC: 180, durationSec: 60, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
      ],
    }
    const lateSamples = [sample(0, { beanTempC: 20 }), sample(150, { beanTempC: 110 })]
    expect(adaptiveTargetTemperatureAt(intent, lateSamples, 150)).toBe(120)
    expect(adaptiveTargetPoints(intent, lateSamples, 150)[1].timeSec).toBe(150)
  })

  it('moves the next journey zone to an early measured completion', () => {
    const intent: ThermalIntent = {
      id: 'adaptive',
      name: 'Adaptive',
      revision: 1,
      strategy: 'thermal-intent',
      createdAt: '',
      updatedAt: '',
      metadata: profile.metadata,
      notes: '',
      calibrationStatus: 'unavailable',
      segments: [
        { id: 'one', startC: 20, endC: 120, durationSec: 100, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
        { id: 'two', startC: 120, endC: 180, durationSec: 60, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
      ],
    }
    const earlySamples = [sample(0, { beanTempC: 20 }), sample(50, { beanTempC: 120 })]
    expect(adaptiveTargetPoints(intent, earlySamples, 50).map((point) => point.timeSec)).toEqual([0, 50, 110])
    expect(adaptiveTargetTemperatureAt(intent, earlySamples, 80)).toBe(150)
  })

  it('normalizes adjacent thermal zone boundaries', () => {
    const intent: ThermalIntent = {
      id: 'continuous',
      name: 'Continuous',
      revision: 1,
      strategy: 'thermal-intent',
      createdAt: '',
      updatedAt: '',
      metadata: profile.metadata,
      notes: '',
      calibrationStatus: 'unavailable',
      segments: [
        { id: 'one', startC: 20, endC: 120, durationSec: 100, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
        { id: 'two', startC: 90, endC: 180, durationSec: 60, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
      ],
    }
    expect(normalizeThermalContinuity(intent).segments[1].startC).toBe(120)
  })
  it('records measured thermal-zone completion at the interpolated crossing time', () => {
    const intent: ThermalIntent = {
      id: 'journey',
      name: 'Journey',
      revision: 1,
      strategy: 'thermal-intent',
      createdAt: '',
      updatedAt: '',
      metadata: profile.metadata,
      notes: '',
      calibrationStatus: 'unavailable',
      segments: [
        { id: 'rise', startC: 20, endC: 120, durationSec: 100, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
        { id: 'cool', startC: 120, endC: 80, durationSec: 60, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 0 },
      ],
    }
    const completions = thermalZoneCompletions(intent, [
      sample(0, { beanTempC: 20 }),
      sample(50, { beanTempC: 70 }),
      sample(100, { beanTempC: 130 }),
      sample(130, { beanTempC: 110 }),
      sample(160, { beanTempC: 70 }),
    ])
    expect(completions).toHaveLength(2)
    expect(completions[0].elapsedSec).toBeCloseTo(91.67, 1)
    expect(completions[1].elapsedSec).toBeCloseTo(152.5, 1)
  })

  it('bounds impossible cooling endpoints above ambient', () => {
    expect(effectiveCoolingTargetC(-100, 23, 5)).toBe(28)
    expect(effectiveCoolingTargetC(40, 23, 5)).toBe(40)
  })
  it('retains event, actuator, temperature, and maximum-gap archive keyframes', () => {
    const samples = [
      sample(0),
      sample(5),
      sample(10, { beanTempC: 101.2 }),
      sample(15, { beanTempC: 101.2 }),
      sample(20, { beanTempC: 101.2, effectiveHeat: 5.6 }),
      sample(25, { beanTempC: 101.2, effectiveHeat: 5.6 }),
      sample(35, { beanTempC: 101.2, effectiveHeat: 5.6 }),
      sample(40, { beanTempC: 101.2, effectiveHeat: 5.6 }),
    ]
    const compressed = compressTelemetry(samples, [25])
    expect(compressed.map((item) => item.elapsedSec)).toEqual([0, 10, 20, 25, 40])
  })

  it('converts an overridden run into the next requested-path revision', () => {
    const revision = profileFromRun({
      id: 'run',
      name: 'Run',
      startedAt: '',
      profile,
      notes: '',
      controllerVersion: 'test',
      recordedOn: testRecordedOn,
      outcome: 'complete',
      events: [],
      samples: [
        sample(0, { requestedFan: 5, requestedHeat: 2 }),
        sample(1, { requestedFan: 5, requestedHeat: 2 }),
        sample(20, { requestedFan: 5.5, requestedHeat: 2.5 }),
      ],
    })
    expect(revision?.revision).toBe(2)
    expect(revision?.points.map(({ timeSec, fan, heat }) => ({ timeSec, fan, heat }))).toEqual([
      { timeSec: 0, fan: 5, heat: 2 },
      { timeSec: 20, fan: 5.5, heat: 2.5 },
    ])
  })

  it('uses a custom roast name or falls back to the automatic name', () => {
    const date = new Date(2026, 6, 25, 19, 5)
    expect(resolveRunName('  Saturday test  ', profile, date)).toBe('Saturday test')
    expect(resolveRunName('   ', profile, date, undefined, 100)).toBe('2026-07-25 19:05 / Coffee / 100 g')
    // A profile carries no batch size, so a name asked for without one simply omits it.
    expect(resolveRunName('   ', profile, date)).toBe('2026-07-25 19:05 / Coffee')
  })
  it('does not repeat an origin already carried by the bean-lot name', () => {
    const bean = {
      id: 'chiapas',
      name: 'Mexico Chiapas',
      origins: ['Mexico'],
      cultivars: [],
      notes: '',
      createdAt: '',
      updatedAt: '',
    } satisfies BeanLot
    expect(resolveRunName('', profile, new Date(2026, 7, 2, 14, 4), bean, 168)).toContain('/ Mexico Chiapas / 168 g')
  })

  it('repairs only legacy automatic bean names proven by their bean snapshot', () => {
    const date = new Date(2026, 6, 31, 2, 56)
    const beanLotSnapshot = {
      id: 'bean-mexico',
      name: 'Mexico Chiapas',
      origins: ['Mexico'],
      cultivars: ['Chiapas'],
      species: 'Arabica' as const,
      notes: '',
      createdAt: date.toISOString(),
      updatedAt: date.toISOString(),
    }
    expect(
      correctedLegacyRunName({
        name: '2026-07-31 02:56 - Mexico Mexico',
        beanLotSnapshot,
      }),
    ).toBe('2026-07-31 02:56 - Mexico Chiapas')
    expect(
      correctedLegacyRunName({
        name: '2026-07-31 / Mexico Mexico Chiapas / 225 g',
        beanLotSnapshot,
      }),
    ).toBe('2026-07-31 / Mexico Chiapas / 225 g')
    expect(
      correctedLegacyRunName({
        name: 'My Mexico tasting',
        beanLotSnapshot,
      }),
    ).toBe('My Mexico tasting')
  })

  it('re-anchors the next zone target to the previous measured completion', () => {
    const intent: ThermalIntent = {
      id: 'anchored',
      name: 'Anchored',
      revision: 1,
      strategy: 'thermal-intent',
      createdAt: '',
      updatedAt: '',
      metadata: profile.metadata,
      notes: '',
      calibrationStatus: 'unavailable',
      segments: [
        { id: 'one', startC: 20, endC: 100, durationSec: 100, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
        { id: 'two', startC: 150, endC: 200, durationSec: 100, fanMin: 0, fanMax: 10, heatMin: 0, heatMax: 10 },
      ],
    }
    const earlySamples = [sample(0, { beanTempC: 20 }), sample(40, { beanTempC: 100 })]
    expect(adaptiveTargetTemperatureAt(intent, earlySamples, 40)).toBe(100)
    expect(adaptiveTargetTemperatureAt(intent, earlySamples, 90)).toBe(150)
    expect(adaptiveTargetTemperatureAt(intent, earlySamples, 140)).toBe(200)
  })

  it('returns safe values for a profile without points', () => {
    const empty: TimedProfile = { ...profile, points: [] }
    expect(timedDuration(empty)).toBe(0)
    expect(valuesAt(empty, 30)).toMatchObject({ fan: 0, heat: 0 })
  })
})

describe('an authored cooling zone stays a cooling zone in the effective intent', () => {
  const zone = (id: string, startC: number, endC: number, durationSec: number) => ({
    id,
    startC,
    endC,
    durationSec,
    fanMin: 1,
    fanMax: 10,
    heatMin: 0,
    heatMax: 10,
  })
  const intentOf = (segments: ReturnType<typeof zone>[]): ThermalIntent =>
    ({
      id: 'p',
      name: 'p',
      revision: 1,
      strategy: 'thermal-intent',
      calibrationStatus: 'experimental',
      createdAt: '',
      updatedAt: '',
      metadata: { intent: '' },
      segments,
    }) as unknown as ThermalIntent

  it('relinks after lifting, and a collapsed cooling zone becomes an UNHEATED hold', () => {
    // Lifting without relinking turns 25->200, 200->28, 28->20 into 200->29.5 | 28->29.5: a heated final zone.
    const effective = effectiveThermalIntent(
      intentOf([zone('a', 25, 200, 480), zone('b', 200, 28, 240), zone('c', 28, 20, 120)]),
      24.5,
      5,
    )
    const [a, b, c] = effective.segments
    expect(a).toMatchObject({ startC: 25, endC: 200, heatMax: 10 })
    expect(b).toMatchObject({ startC: 200, endC: 29.5 })
    expect(c).toMatchObject({ startC: 29.5, endC: 29.5, heatMin: 0, heatMax: 0, durationSec: 120 })
    // Every zone starts where the previous one ends, and none authored as cooling can rise.
    for (let index = 1; index < effective.segments.length; index += 1) {
      expect(effective.segments[index].startC).toBe(effective.segments[index - 1].endC)
    }
    expect(c.endC).toBeLessThanOrEqual(c.startC)
  })

  it('leaves a cooling zone that still cools, and every heating zone, exactly as authored', () => {
    const authored = intentOf([zone('a', 25, 200, 480), zone('b', 200, 60, 240), zone('c', 60, 150, 200)])
    const effective = effectiveThermalIntent(authored, 24.5, 5)
    expect(effective.segments).toEqual(authored.segments)
  })

  it('collapses a cooling zone whose lifted span lands inside the hold band', () => {
    // 30 -> 20 lifts to 29.5: a 0.5 °C span the control law would solve as a HEATED hold.
    const effective = effectiveThermalIntent(intentOf([zone('a', 25, 30, 60), zone('b', 30, 20, 120)]), 24.5, 5)
    expect(effective.segments[1]).toMatchObject({ startC: 30, endC: 30, heatMin: 0, heatMax: 0 })
  })
})
