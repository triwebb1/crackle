import { describe, expect, it } from 'vitest'
import { formatMetric, hasExpansionData, missingMeasurements, roastMetrics } from './roastMetrics'

const full = { startingMassG: 225, startingVolumeMl: 350, finalMassG: 190, finalVolumeMl: 420 }

describe('roast covariates', () => {
  it('derives every figure once the measurements are all there', () => {
    const metrics = roastMetrics(full)
    expect(metrics.greenDensityGPerMl).toBeCloseTo(0.6429, 4)
    expect(metrics.roastedDensityGPerMl).toBeCloseTo(0.4524, 4)
    expect(metrics.expansionRatio).toBeCloseTo(1.2, 4)
    expect(metrics.massLossPercent).toBeCloseTo(15.56, 2)
    expect(metrics.densityLossPercent).toBeCloseTo(29.63, 2)
  })

  /** A missing measurement has no derived value. Zero would be a lie that averages into a fit. */
  it('returns undefined rather than a plausible zero', () => {
    expect(roastMetrics(undefined)).toEqual({
      greenDensityGPerMl: undefined,
      roastedDensityGPerMl: undefined,
      expansionRatio: undefined,
      massLossPercent: undefined,
      densityLossPercent: undefined,
    })
    const partial = roastMetrics({ startingMassG: 225, startingVolumeMl: 350 })
    expect(partial.greenDensityGPerMl).toBeCloseTo(0.6429, 4)
    expect(partial.roastedDensityGPerMl).toBeUndefined()
    expect(partial.expansionRatio).toBeUndefined()
    expect(partial.massLossPercent).toBeUndefined()
  })

  it('treats a zero or nonsense measurement as absent, not as a divide by zero', () => {
    expect(roastMetrics({ startingMassG: 225, startingVolumeMl: 0 }).greenDensityGPerMl).toBeUndefined()
    expect(roastMetrics({ startingMassG: Number.NaN, startingVolumeMl: 350 }).greenDensityGPerMl).toBeUndefined()
    expect(roastMetrics({ startingMassG: -5, startingVolumeMl: 350 }).greenDensityGPerMl).toBeUndefined()
  })

  it('reports what a roast is still missing', () => {
    expect(missingMeasurements(full)).toEqual([])
    expect(missingMeasurements({ startingMassG: 225 })).toEqual(['green volume', 'roasted mass', 'roasted volume'])
    expect(missingMeasurements(undefined)).toHaveLength(4)
    expect(hasExpansionData(full)).toBe(true)
    expect(hasExpansionData({ startingMassG: 225 })).toBe(false)
  })

  it('formats a missing figure as a dash rather than as NaN', () => {
    expect(formatMetric(undefined)).toBe('--')
    expect(formatMetric(1.2345)).toBe('1.23')
    expect(formatMetric(15.55, 1, ' %')).toBe('15.6 %')
  })
})
