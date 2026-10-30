import { describe, expect, it } from 'vitest'
import { formatDayLabel, formatTime, formatTimeWithDay } from './formatting'

describe('Vienna timetable formatting', () => {
  it('renders both instances of the repeated autumn hour in Vienna', () => {
    const first = Date.parse('2026-10-25T00:30:00Z')
    const second = Date.parse('2026-10-25T01:30:00Z')
    expect(formatTime(first, 'de')).toBe('02:30')
    expect(formatTime(second, 'de')).toBe('02:30')
    expect(formatDayLabel(first, second, 'en')).toBe('Today')
  })

  it('labels an arrival on the next Vienna civil day', () => {
    const departure = Date.parse('2026-10-30T22:30:00Z')
    const arrival = Date.parse('2026-10-30T23:30:00Z')
    expect(formatTime(departure, 'en')).toBe('23:30')
    expect(formatTime(arrival, 'en')).toBe('00:30')
    expect(formatTimeWithDay(arrival, departure, 'en')).toContain('31')
    expect(formatDayLabel(arrival, departure, 'en')).not.toBe('Today')
  })
})
