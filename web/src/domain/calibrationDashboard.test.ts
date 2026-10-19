import { describe, expect, it } from 'vitest'
import { defaultCalibration } from '../data/calibration'
import {
  buildCalibrationDashboard,
  CALIBRATION_DASHBOARD_LEVELS,
  modelledSettleSeconds,
  workingPreviewLoads,
} from './calibrationDashboard'
import { modelledSteadyStateC } from './journeyControl'
import { type TauObservation, tauByFan } from './meshMetrics'
import { type BaselineCell, type BaselineMap, meshKey } from './thermalLog'
import { thermalStep } from './thermalModel'
import type { CalibrationSettings } from './types'

const cell = (fan: number, heat: number, steadyStateC: number): [string, BaselineCell] => [
  meshKey(fan, heat),
  {
    fan,
    heat,
    steadyStateC,
    extrapolated: false,
    quality: 'measured',
    runId: 'baseline',
    capturedAt: '2026-07-30T12:00:00.000Z',
  },
]

const baselineMap: BaselineMap = {
  fans: [2, 1],
  heats: [0, 1],
  cells: Object.fromEntries([cell(1, 0, 100), cell(1, 1, 120), cell(2, 0, 80), cell(2, 1, 100)]),
  runCount: 1,
  extrapolatedCount: 0,
  unreliableCount: 0,
  flooredCount: 0,
  suspectFans: [],
}

const observation = (fan: number, tauSec: number): TauObservation => ({
  runId: 'baseline',
  capturedAt: '2026-07-30T12:00:00.000Z',
  stepIndex: fan,
  fan,
  heat: 1,
  tauSec,
  r2: 0.99,
  direction: 'rising',
  quality: 'measured',
  kind: 'step',
  source: `fan ${fan}`,
})

const calibration: CalibrationSettings = {
  referenceBatchMassG: 225,
  heaterGainCPerMinAt10: 55,
  fanCoolingCPerMinAt10: 18,
  coolingFanCPerMinAt10: 30,
  thermalLossPerMinPerC: 0.2,
  coolingTargetMarginC: 5,
  updatedAt: '2026-07-30T12:00:00.000Z',
}

const dashboard = () =>
  buildCalibrationDashboard({
    baselineMap,
    emptyTauByFan: tauByFan([observation(1, 10), observation(2, 20)]),
    calibration,
    ambientC: 20,
  })

describe('six calibration destination heatmaps', () => {
  it('builds fixed 11x11 axes for every direction and load', () => {
    const result = dashboard()
    expect(result.axes).toEqual(CALIBRATION_DASHBOARD_LEVELS)
    for (const direction of ['heating', 'cooling'] as const) {
      for (const load of ['empty', '100g', '250g'] as const) {
        const map = result.heatmaps[direction][load]
        expect(map.cells).toHaveLength(11)
        expect(map.cells.every((row) => row.length === 11)).toBe(true)
      }
    }
  })

  it('averages empty-chamber transitions over every valid origin in the requested direction', () => {
    const result = dashboard()
    const heating = result.heatmaps.heating.empty.cells[1][1]
    // Destination fan 1 / heat 1 is 120 °C. Three origins are more than 2 °C cooler:
    // 100, 80, 100. Tau is 10 s, the 2 °C practical band bounds the exponential tail, and the
    // 20 s settle window is added to every move.
    const expected = [10 * Math.log(20 / 2) + 20, 10 * Math.log(40 / 2) + 20, 10 * Math.log(20 / 2) + 20]
    const average = expected.reduce((sum, value) => sum + value, 0) / expected.length
    expect(heating.count).toBe(3)
    expect(heating.average).toBeCloseTo(average, 9)
    expect(heating.min).toBeCloseTo(Math.min(...expected), 9)
    expect(heating.max).toBeCloseTo(Math.max(...expected), 9)
    expect(heating.stddev).toBeGreaterThan(0)
    expect(heating.basis).toBe('calculated')
    expect(heating.basis).not.toBe('measured')
    expect(heating.detail).toContain('Weakest source evidence: measured')

    const cooling = result.heatmaps.cooling.empty.cells[2][0]
    expect(cooling.count).toBe(3)
    expect(cooling.basis).toBe('calculated')
  })

  it('marks invalid, outside-surface, and unsupported destinations unavailable', () => {
    const result = dashboard()
    expect(result.heatmaps.heating.empty.cells[0][1]).toMatchObject({ count: 0, basis: 'unavailable' })
    expect(result.heatmaps.heating.empty.cells[10][10]).toMatchObject({ count: 0, basis: 'unavailable' })

    const withoutTau = buildCalibrationDashboard({
      baselineMap,
      emptyTauByFan: [],
      calibration,
      ambientC: 20,
    })
    expect(withoutTau.heatmaps.heating.empty.cells[1][1]).toMatchObject({ count: 0, basis: 'unavailable' })
  })

  it('labels both loaded mass maps as modelled and never as measured or interpolated', () => {
    const result = dashboard()
    for (const direction of ['heating', 'cooling'] as const) {
      for (const load of ['100g', '250g'] as const) {
        const available = result.heatmaps[direction][load].cells.flat().filter((entry) => entry.count > 0)
        expect(available.length).toBeGreaterThan(0)
        expect(new Set(available.map((entry) => entry.basis))).toEqual(new Set(['modelled']))
        expect(available.every((entry) => entry.detail.includes('no loaded-roast measurement is implied'))).toBe(true)
      }
    }
  })

  it('uses mass in loaded transition time without changing equilibrium and includes the same settle window', () => {
    const result = dashboard()
    expect(result.meaningfulDeltaC).toBe(2)
    expect(result.toleranceC).toBe(2)
    expect(result.settleWindowSec).toBe(20)

    const hundred = result.heatmaps.heating['100g'].cells[1][1]
    const twoFifty = result.heatmaps.heating['250g'].cells[1][1]
    expect(hundred.count).toBe(twoFifty.count)
    expect(twoFifty.average!).toBeGreaterThan(hundred.average!)
    expect(hundred.min).toBeGreaterThanOrEqual(20)
    expect(twoFifty.min).toBeGreaterThanOrEqual(20)
    // Loaded cooling uses the runtime plant, including forced-air cooling. From the same set of
    // modelled hot origins, a Fan 10 / Heat 0 destination must settle faster than Fan 5 / Heat 0.
    const fanFive = result.heatmaps.cooling['100g'].cells[5][0]
    const fanTen = result.heatmaps.cooling['100g'].cells[10][0]
    expect(fanFive.count).toBeGreaterThan(0)
    expect(fanTen.count).toBe(fanFive.count)
    expect(fanTen.average!).toBeLessThan(fanFive.average!)
  })

  it('matches the runtime one-second plant for heating and forced-air cooling moves', () => {
    const legacy = (originC: number, destinationC: number, fan: number, heat: number, massG: number) => {
      let temperatureC = originC
      let rorCPerMin: number | undefined
      let insideSinceSec: number | undefined
      for (let elapsedSec = 1; elapsedSec <= 3600; elapsedSec += 1) {
        const next = thermalStep(
          {
            previousBeanTempC: temperatureC,
            previousRorCPerMin: rorCPerMin,
            fan,
            heat,
            cooling: heat === 0,
            batchMassG: massG,
            ambientC: 20,
          },
          calibration,
        )
        temperatureC = next.beanTempC
        rorCPerMin = next.rorCPerMin
        if (Math.abs(temperatureC - destinationC) <= 0.3) {
          insideSinceSec ??= elapsedSec
          if (elapsedSec - insideSinceSec >= 10) return elapsedSec
        } else insideSinceSec = undefined
      }
      return undefined
    }
    const cases = [
      { originC: 35, fan: 2, heat: 6, massG: 100 },
      { originC: 280, fan: 8, heat: 2, massG: 250 },
      { originC: 220, fan: 1, heat: 0, massG: 100 },
      { originC: 220, fan: 10, heat: 0, massG: 250 },
    ]
    for (const item of cases) {
      const destinationC =
        item.heat === 0
          ? 20
          : modelledSteadyStateC({ fan: item.fan, heat: item.heat, batchMassG: item.massG, ambientC: 20 }, calibration)
      expect(
        modelledSettleSeconds(item.originC, destinationC, calibration, item.fan, item.heat, item.massG, 20, 0.3, 10),
      ).toBe(legacy(item.originC, destinationC, item.fan, item.heat, item.massG))
    }
  })
  it('models Fan 0 / Heat 0 as passive decay, agreeing with the iterated plant', () => {
    // The heat-off branch must not apply the forced-cooling -8 °C/min floor at Fan 0, where
    // `thermalPlantMode` is passive; doing so reads about half the true time.
    for (const cal of [defaultCalibration, calibration]) {
      let temperatureC = 200
      let steps = 0
      while (Math.abs(temperatureC - 24.5) > 2 && steps < 7200) {
        temperatureC = thermalStep(
          { previousBeanTempC: temperatureC, fan: 0, heat: 0, cooling: true, batchMassG: 250, ambientC: 24.5 },
          cal,
        ).beanTempC
        steps += 1
      }
      expect(modelledSettleSeconds(200, 24.5, cal, 0, 0, 250, 24.5, 2, 0)).toBe(steps)
    }
    expect(modelledSettleSeconds(200, 24.5, defaultCalibration, 0, 0, 250, 24.5, 2, 0)).toBeGreaterThan(1700)
  })
  it('does not calculate or expose load maps omitted by a working preview', () => {
    const result = buildCalibrationDashboard({
      baselineMap,
      emptyTauByFan: tauByFan([observation(1, 10), observation(2, 20)]),
      calibration,
      ambientC: 20,
      loads: ['empty'],
    })
    expect(result.heatmaps.heating.empty.cells.flat().some((entry) => entry.count > 0)).toBe(true)
    expect(result.heatmaps.heating['100g'].cells.flat().every((entry) => entry.count === 0)).toBe(true)
    expect(
      result.heatmaps.cooling['250g'].cells
        .flat()
        .every((entry) => entry.detail === 'No loaded-roast evidence is selected.'),
    ).toBe(true)
  })
  it('offers bean-load panels to a working preview only behind an applyable loaded fit', () => {
    expect(workingPreviewLoads(false, false)).toEqual([])
    expect(workingPreviewLoads(true, false)).toEqual(['empty'])
    expect(workingPreviewLoads(false, true)).toEqual(['100g', '250g'])
    expect(workingPreviewLoads(true, true)).toEqual(['empty', '100g', '250g'])
  })
  it('builds modelled bean-load maps without any baseline surface when requested alone', () => {
    const result = buildCalibrationDashboard({
      baselineMap: {
        fans: [],
        heats: [],
        cells: {},
        runCount: 0,
        extrapolatedCount: 0,
        unreliableCount: 0,
        flooredCount: 0,
        suspectFans: [],
      },
      emptyTauByFan: [],
      calibration,
      ambientC: 20,
      loads: ['100g', '250g'],
    })
    expect(result.heatmaps.heating['100g'].cells.flat().some((entry) => entry.basis === 'modelled')).toBe(true)
    expect(result.heatmaps.heating['100g'].massG).toBe(100)
    expect(result.heatmaps.cooling['250g'].massG).toBe(250)
    expect(result.heatmaps.heating.empty.cells.flat().every((entry) => entry.count === 0)).toBe(true)
  })
  it('rejects non-finite or unsafe model equilibria', () => {
    const unsafe = buildCalibrationDashboard({
      baselineMap,
      emptyTauByFan: tauByFan([observation(1, 10)]),
      calibration: { ...calibration, heaterGainCPerMinAt10: Number.POSITIVE_INFINITY },
      ambientC: 20,
    })
    expect(unsafe.heatmaps.heating['100g'].cells[1][10]).toMatchObject({ count: 0, basis: 'unavailable' })
  })
})
