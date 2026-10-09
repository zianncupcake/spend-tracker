import { describe, expect, it } from 'vitest'
import { currentWindow, dayOf, startOfDay, type WindowRule } from '../src/domain/window'

const SINGAPORE = 'Asia/Singapore' // UTC+8 all year

const calendar: WindowRule = { windowType: 'calendar' }
const closingOn = (statementDay: number): WindowRule => ({ windowType: 'statement', statementDay })

/** The current window in Singapore at a local date and time such as "2026-10-09 12:00". */
const singaporeWindow = (card: WindowRule, local: string) =>
  currentWindow(card, new Date(`${local.replace(' ', 'T')}:00+08:00`), SINGAPORE)

/** A window from one Singapore midnight to another, each given as a date such as "2026-10-01". */
const singaporeDays = (start: string, end: string) => ({
  start: new Date(`${start}T00:00:00+08:00`),
  end: new Date(`${end}T00:00:00+08:00`),
})

describe('calendar window', () => {
  it('is the local calendar month', () => {
    const window = singaporeWindow(calendar, '2026-10-09 12:00')

    expect(window).toEqual(singaporeDays('2026-10-01', '2026-11-01'))
    expect(window.start.toISOString()).toBe('2026-09-30T16:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-10-31T16:00:00.000Z')
  })

  it('goes by the local date, not the UTC date', () => {
    const now = new Date('2026-09-30T18:00:00Z') // 02:00 on 1 October in Singapore

    expect(currentWindow(calendar, now, SINGAPORE)).toEqual(singaporeDays('2026-10-01', '2026-11-01'))
  })

  it('keeps to local midnight on both sides of a clock change', () => {
    // New York is on UTC-5 until 8 March 2026 and on UTC-4 after it.
    const window = currentWindow(calendar, new Date('2026-03-15T12:00:00-04:00'), 'America/New_York')

    expect(window.start.toISOString()).toBe('2026-03-01T05:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-04-01T04:00:00.000Z')
  })
})

describe('statement window', () => {
  it('runs from the day after one close day to the day after the next', () => {
    expect(singaporeWindow(closingOn(15), '2026-10-09 12:00')).toEqual(singaporeDays('2026-09-16', '2026-10-16'))
  })

  it('still covers the last minute of the close day', () => {
    expect(singaporeWindow(closingOn(15), '2026-10-15 23:59')).toEqual(singaporeDays('2026-09-16', '2026-10-16'))
  })

  it('moves to the next cycle at midnight after the close day', () => {
    expect(singaporeWindow(closingOn(15), '2026-10-16 00:00')).toEqual(singaporeDays('2026-10-16', '2026-11-16'))
  })

  it('closes day 31 on 28 February 2026', () => {
    expect(singaporeWindow(closingOn(31), '2026-02-10 12:00')).toEqual(singaporeDays('2026-02-01', '2026-03-01'))
    expect(singaporeWindow(closingOn(31), '2026-02-28 23:59')).toEqual(singaporeDays('2026-02-01', '2026-03-01'))
    expect(singaporeWindow(closingOn(31), '2026-03-01 00:00')).toEqual(singaporeDays('2026-03-01', '2026-04-01'))
  })

  it('closes day 31 on 30 April 2026', () => {
    expect(singaporeWindow(closingOn(31), '2026-04-10 12:00')).toEqual(singaporeDays('2026-04-01', '2026-05-01'))
  })

  it('closes day 30 on 29 February 2028, a leap year', () => {
    // January closes on the 30th, so this cycle starts on the 31st.
    expect(singaporeWindow(closingOn(30), '2028-02-10 12:00')).toEqual(singaporeDays('2028-01-31', '2028-03-01'))
  })

  it('crosses the end of the year', () => {
    expect(singaporeWindow(closingOn(15), '2026-12-20 12:00')).toEqual(singaporeDays('2026-12-16', '2027-01-16'))
    expect(singaporeWindow(closingOn(15), '2027-01-05 12:00')).toEqual(singaporeDays('2026-12-16', '2027-01-16'))
  })

  it('begins a day at the clock change when the change skips midnight', () => {
    // In Havana the clocks went from 23:59 on 7 March 2026 straight to 01:00 on
    // the 8th (UTC-5 to UTC-4), so that day has no midnight.
    const window = currentWindow(closingOn(7), new Date('2026-03-05T12:00:00-05:00'), 'America/Havana')

    expect(window.start.toISOString()).toBe('2026-02-08T05:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-03-08T05:00:00.000Z')
  })
})

describe('the start of a day', () => {
  it('is midnight on that date in the time zone', () => {
    expect(startOfDay(2026, 10, 1, SINGAPORE).toISOString()).toBe('2026-09-30T16:00:00.000Z')
    expect(startOfDay(2026, 10, 1, 'America/New_York').toISOString()).toBe('2026-10-01T04:00:00.000Z')
    expect(startOfDay(2026, 10, 1, 'UTC').toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('carries a day past the end of its month over into the next', () => {
    expect(startOfDay(2026, 10, 32, SINGAPORE)).toEqual(startOfDay(2026, 11, 1, SINGAPORE))
    expect(startOfDay(2026, 12, 32, SINGAPORE)).toEqual(startOfDay(2027, 1, 1, SINGAPORE))
    expect(startOfDay(2026, 2, 29, SINGAPORE)).toEqual(startOfDay(2026, 3, 1, SINGAPORE))
  })

  it('keeps to local midnight on both sides of a clock change', () => {
    // New York goes from UTC-5 to UTC-4 at 02:00 on 8 March 2026.
    expect(startOfDay(2026, 3, 8, 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(startOfDay(2026, 3, 9, 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })

  it('is the clock change, on a day that the change leaves without a midnight', () => {
    // Havana, where 8 March 2026 began at 01:00.
    expect(startOfDay(2026, 3, 8, 'America/Havana').toISOString()).toBe('2026-03-08T05:00:00.000Z')
  })
})

describe('the day that an instant falls on', () => {
  it('is the day on the calendar of the time zone', () => {
    const instant = new Date('2026-10-09T16:30:00Z') // half past midnight on 10 October in Singapore

    expect(dayOf(instant, SINGAPORE)).toEqual({ year: 2026, month: 10, day: 10 })
    expect(dayOf(instant, 'America/New_York')).toEqual({ year: 2026, month: 10, day: 9 })
    expect(dayOf(instant, 'UTC')).toEqual({ year: 2026, month: 10, day: 9 })
  })

  it('is in the next year once the year has turned there', () => {
    const instant = new Date('2026-12-31T16:00:00Z') // midnight starting 1 January in Singapore

    expect(dayOf(instant, SINGAPORE)).toEqual({ year: 2027, month: 1, day: 1 })
    expect(dayOf(instant, 'America/New_York')).toEqual({ year: 2026, month: 12, day: 31 })
  })

  it('begins where startOfDay says that day begins', () => {
    const { year, month, day } = dayOf(new Date('2026-03-08T12:00:00Z'), 'America/New_York')

    expect(startOfDay(year, month, day, 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z')
  })
})
