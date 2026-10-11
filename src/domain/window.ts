import { productOf } from '../catalogue'

export type WindowRule =
  | { windowType: 'calendar' }
  | { windowType: 'statement'; statementDay: number }

/** A card as far as its window goes: its rule, and the key of the product that it is linked to, when it is to one. */
type Windowed = WindowRule & { product?: string }

export interface SpendWindow {
  start: Date // inclusive
  end: Date // exclusive
  /**
   * What the window counts, when that is not the purchases of its own days: those made from `start` to before `end`
   * of this, which are `days` days earlier than the window's own. See `currentWindow`.
   */
  counts?: { start: Date; end: Date; days: number }
}

const DAY_MS = 86_400_000

/**
 * How many days at the end of a window are counted in the next one, on a card whose product does not say: the day
 * that the window closes on, and the day before it. A purchase is known by the day that it was made, and a bank
 * counts it by the day that it is posted, which is usually a day or two later. So a purchase of those days is taken
 * to be in the window after, where its bank will mostly have it. That it is two days is the owner's choice: how
 * long a posting takes was not measured. And that a bank counts by the day of posting is from the terms of one
 * card, which ../catalogue/uob-evol quotes: it is taken to hold for the others, and was not checked for them. A
 * product can say another number: see `daysCountedInNext` in ../catalogue/types.
 */
export const DAYS_COUNTED_IN_NEXT = 2

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
 *
 * That is the window as its bank has it, or the calendar. What it counts are
 * the purchases of other days: the last days of a window are counted in the
 * next one, as many of them as the card's product says, or else
 * DAYS_COUNTED_IN_NEXT. So a window counts what was bought from that many days
 * before it starts to that many days before it ends, which `counts` has. And on
 * its last days the current window is the one that is still to start, as that
 * is the one that counts what is bought then. With no such days, as a product
 * can have it, a window counts the purchases of its own days and has no
 * `counts`.
 */
export function currentWindow(card: Windowed, now: Date, timeZone: string): SpendWindow {
  const clock = wallClock(timeZone)
  // A window is the current one from so many days before it starts. So the day that tells which window it is, which
  // `today` is here, is the day that it will be in as many days.
  const days = productOf(card.product)?.daysCountedInNext ?? DAYS_COUNTED_IN_NEXT
  const early = days * DAY_MS
  const today = new Date(clock(now.getTime()) + early)
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth()

  // A calendar month is the cycle that closes on the last day of every month.
  const closeDay = card.windowType === 'calendar' ? 31 : card.statementDay
  // Midnight after a month's close day, where one cycle ends and the next
  // begins. Date.UTC carries a month or day outside its range over, so month
  // -1 is last December and day 32 of a 31-day month is the 1st of the next.
  const boundary = (m: number) => Date.UTC(year, m, Math.min(closeDay, daysInMonth(year, m)) + 1)

  const closingMonth = today.getTime() < boundary(month) ? month : month + 1
  const [start, end] = [boundary(closingMonth - 1), boundary(closingMonth)]
  const between = (from: number, to: number) => ({
    start: new Date(toInstant(from, clock)),
    end: new Date(toInstant(to, clock)),
  })
  if (days === 0) return between(start, end)
  return { ...between(start, end), counts: { ...between(start - early, end - early), days } }
}

/** The stretch of time whose purchases the window counts, in unix seconds: `start <= occurred_at < end`. */
export function countedIn(window: SpendWindow): { start: number; end: number } {
  const { start, end } = window.counts ?? window
  return { start: start.getTime() / 1000, end: end.getTime() / 1000 }
}

/**
 * The windows that purchases on a card are carried into: those of the purchases that were made in the last days of
 * a window are counted in the next one, which starts after they were made. There is a window for each such
 * purchase, in their order, and `instants` are when the purchases were made. Purchases that are carried into one
 * window have the same window here, and not only one like it.
 */
export function carriedInto(card: Windowed, instants: Date[], timeZone: string): SpendWindow[] {
  // Purchases that are told of together are mostly of one window, and to find a window takes more computing than
  // the rest of this does. So each window is worked out once.
  const found: { window: SpendWindow; start: number; end: number }[] = []
  return instants.flatMap((instant) => {
    const at = instant.getTime() / 1000
    let its = found.find(({ start, end }) => at >= start && at < end)
    if (!its) {
      const window = currentWindow(card, instant, timeZone)
      its = { window, ...countedIn(window) }
      found.push(its)
    }
    return instant.getTime() < its.window.start.getTime() ? [its.window] : []
  })
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
