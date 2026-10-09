export type WindowRule =
  | { windowType: 'calendar' }
  | { windowType: 'statement'; statementDay: number }

export interface SpendWindow {
  start: Date // inclusive
  end: Date // exclusive
}

const DAY_MS = 86_400_000

// Local dates and times are handled as "wall time": the reading of a local
// clock, encoded as if that reading were UTC.
type WallClock = (instant: number) => number

/**
 * The window a card's running total covers at `now`.
 *
 * calendar: the local calendar month.
 * statement: `statementDay` is the day the statement closes, and a purchase on
 * that day belongs to the closing cycle. A month with fewer days closes on its
 * last day. If today is on or before this month's close day, the window runs
 * from the day after last month's close day to the day after this month's.
 * Otherwise it runs from the day after this month's close day to the day after
 * next month's. Both ends are local midnights.
 */
export function currentWindow(card: WindowRule, now: Date, timeZone: string): SpendWindow {
  const clock = wallClock(timeZone)
  const today = new Date(clock(now.getTime()))
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth()

  // A calendar month is the cycle that closes on the last day of every month.
  const closeDay = card.windowType === 'calendar' ? 31 : card.statementDay
  // Midnight after a month's close day, where one cycle ends and the next
  // begins. Date.UTC carries a month or day outside its range over, so month
  // -1 is last December and day 32 of a 31-day month is the 1st of the next.
  const boundary = (m: number) => Date.UTC(year, m, Math.min(closeDay, daysInMonth(year, m)) + 1)

  const closingMonth = today.getTime() < boundary(month) ? month : month + 1
  return {
    start: new Date(toInstant(boundary(closingMonth - 1), clock)),
    end: new Date(toInstant(boundary(closingMonth), clock)),
  }
}

/**
 * The instant at which a calendar day begins in the time zone. `month` is 1 to
 * 12. A day past the end of its month carries over into the next, so the day
 * after the 31st of October can be given as the 32nd.
 */
export function startOfDay(year: number, month: number, day: number, timeZone: string): Date {
  return new Date(toInstant(Date.UTC(year, month - 1, day), wallClock(timeZone)))
}

/** The calendar day that an instant falls on in the time zone. `month` is 1 to 12. */
export function dayOf(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const shown = new Date(wallClock(timeZone)(instant.getTime()))
  return { year: shown.getUTCFullYear(), month: shown.getUTCMonth() + 1, day: shown.getUTCDate() }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function wallClock(timeZone: string): WallClock {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  return (instant) => {
    const parts = format.formatToParts(instant)
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  }
}

/** The instant at which a wall-time midnight begins in the clock's time zone. */
function toInstant(midnight: number, clock: WallClock): number {
  const offset = (instant: number) => clock(instant) - instant
  const before = midnight - offset(midnight - DAY_MS)
  const after = midnight - offset(midnight + DAY_MS)
  // The two differ only when the clocks change around this midnight. `after`
  // is right once they have changed. Otherwise `before` is, which also covers
  // a change that skips midnight (the day then begins at the change) or
  // repeats it (the day begins at the first of the two).
  return clock(before) !== midnight && clock(after) === midnight ? after : before
}
