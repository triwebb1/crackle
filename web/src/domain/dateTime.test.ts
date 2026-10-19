import { describe, expect, it } from 'vitest'
import { formatLocalDateTime } from './dateTime'

describe('occurrence date and time labels', () => {
  it('uses local date with zero-padded 24-hour hours and minutes', () => {
    expect(formatLocalDateTime(new Date(2026, 6, 30, 0, 5))).toBe('2026-07-30 00:05')
    expect(formatLocalDateTime(new Date(2026, 6, 30, 19, 42))).toBe('2026-07-30 19:42')
  })

  it('does not invent a timestamp for invalid input', () => {
    expect(formatLocalDateTime('not-a-date')).toBe('time unknown')
  })
})
