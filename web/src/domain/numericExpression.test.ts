import { describe, expect, it } from 'vitest'
import { evaluateNumericExpression, formatCalculatedNumber } from './numericExpression'

describe('numeric expressions', () => {
  it('calculates a grams-per-milliliter ratio', () => {
    expect(evaluateNumericExpression('225 / 350')).toBeCloseTo(0.642857, 6)
  })

  it('supports ordinary arithmetic and parentheses', () => {
    expect(evaluateNumericExpression('(100 + 25) / 200')).toBe(0.625)
    expect(evaluateNumericExpression('2 * 3 + 1')).toBe(7)
  })

  it('rejects malformed and non-finite expressions', () => {
    expect(evaluateNumericExpression('225g / 350ml')).toBeUndefined()
    expect(evaluateNumericExpression('1 / 0')).toBeUndefined()
    expect(evaluateNumericExpression('2 +')).toBeUndefined()
  })

  it('formats calculated values without trailing zeroes', () => {
    expect(formatCalculatedNumber(225 / 350)).toBe('0.642857')
    expect(formatCalculatedNumber(0.75)).toBe('0.75')
  })
})
