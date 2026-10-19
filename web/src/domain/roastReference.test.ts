import { describe, expect, it } from 'vitest'
import {
  celsiusToFahrenheit,
  formatApproximateTemperature,
  formatReferenceRange,
  roastColorStops,
  roastReferenceBands,
  roastStyleReferences,
} from './roastReference'

describe('roast reference data', () => {
  it('keeps working bands ordered with valid ranges', () => {
    expect(roastReferenceBands.length).toBeGreaterThanOrEqual(6)
    expect(roastReferenceBands.map((band) => band.minimumC)).toEqual(
      [...roastReferenceBands.map((band) => band.minimumC)].sort((a, b) => a - b),
    )
    expect(roastReferenceBands.every((band) => band.maximumC == null || band.maximumC > band.minimumC)).toBe(true)
  })

  it('keeps visual color stops in ascending temperature order', () => {
    const temperatures = roastColorStops.map((stop) => stop.temperatureC)
    expect(temperatures).toEqual([...temperatures].sort((a, b) => a - b))
    expect(new Set(roastColorStops.map((stop) => stop.name)).size).toBe(roastColorStops.length)
  })

  it('keeps traditional roast styles ordered and provides the familiar names', () => {
    const temperatures = roastStyleReferences.map((style) => style.minimumC)
    const names = roastStyleReferences.map((style) => style.names).join(' ')
    expect(temperatures).toEqual([...temperatures].sort((a, b) => a - b))
    expect(new Set(roastStyleReferences.map((style) => style.id)).size).toBe(roastStyleReferences.length)
    expect(names).toContain('City')
    expect(names).toContain('City+')
    expect(names).toContain('Full City')
    expect(names).toContain('Italian')
  })

  it('formats both temperature units without false decimal precision', () => {
    expect(celsiusToFahrenheit(100)).toBe(212)
    expect(formatReferenceRange(140, 165)).toEqual({ celsius: '140-165 °C', fahrenheit: '284-329 °F' })
    expect(formatReferenceRange(230)).toEqual({ celsius: '230+ °C', fahrenheit: '446+ °F' })
    expect(formatApproximateTemperature(219)).toEqual({ celsius: '219 °C', fahrenheit: '426 °F' })
    expect(formatApproximateTemperature(243, 245)).toEqual({ celsius: '243-245 °C', fahrenheit: '469-473 °F' })
  })
})
