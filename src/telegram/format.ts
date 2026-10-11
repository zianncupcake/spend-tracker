import type { CardTotals } from '../domain/totals'
import { carriedInto, type SpendWindow, type WindowRule } from '../domain/window'
import type { Card } from '../store'

const thousands = new Intl.NumberFormat('en-US')

/** An amount from hundredths of a unit, with no currency: 123456 is "1,234.56". */
export function formatAmount(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : ''
  const amount = Math.abs(amountMinor)
  const cents = String(amount % 100).padStart(2, '0')
  return `${sign}${thousands.format(Math.floor(amount / 100))}.${cents}`
}

/** Money from hundredths of a unit: 123456 in SGD is "SGD 1,234.56". */
export function formatMoney(amountMinor: number, currency: string): string {
  return `${currency} ${formatAmount(amountMinor)}`
}

/** A day and month as seen in the time zone, such as "16 Oct". */
export function formatShortDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric', month: 'short' }).formatToParts(date)
  const get = (type: 'day' | 'month') => parts.find((part) => part.type === type)?.value
  return `${get('day')} ${get('month')}`
}

/**
 * `formatShortDate` for many dates in one time zone. It is the making of a formatter that takes the time, a
 * hundred of them a few milliseconds, so the one that every date here goes through is made once.
 */
export function shortDateIn(timeZone: string): (date: Date) => string {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric', month: 'short' })
  return (date) => {
    const parts = format.formatToParts(date)
    const get = (type: 'day' | 'month') => parts.find((part) => part.type === type)?.value
    return `${get('day')} ${get('month')}`
  }
}

/** A day, month and time as seen in the time zone, such as "16 Oct, 09:05". */
export function formatShortDateTime(date: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${formatShortDate(date, timeZone)}, ${time.format(date)}`
}

export function describeWindow(card: WindowRule): string {
  return card.windowType === 'calendar'
    ? 'calendar month'
    : `statement closes on the ${ordinal(card.statementDay)} of the month`
}

/** What a card's window holds and when it starts again, such as "SGD 12.40 in 1 purchase, resets 16 Oct". */
export function describeTotals({ window, totals, count }: CardTotals, timeZone: string): string {
  const amounts = totals.map((total) => formatMoney(total.amountMinor, total.currency)).join(' + ')
  const spent = count === 0 ? 'no purchases' : `${amounts} in ${count} ${count === 1 ? 'purchase' : 'purchases'}`
  return `${spent}, resets ${formatShortDate(window.end, timeZone)}`
}

// What the bot says of the days that a total counts. A purchase is known by the day that it was made, and a bank
// counts one by the day that it is posted. So the last days of a window are counted in the next one, and a window
// is still shown as its bank has it: see `currentWindow`. Its user is told which days a total counts, and of each
// purchase that is counted in the window after the one that it was made in. Where a window counts the purchases of
// its own days, as a product can have it, there is nothing to tell. No text here names a bank.

/** Why a total counts other days than those of its window, as /spend says it once under all the cards. */
export const COUNTED_BY_POSTING =
  'A bank counts a purchase by the day it is posted, so one made in the last days of a cycle or a month is counted ' +
  'in the next one.'

/**
 * Which days of purchases the total of a window counts, when they are not the window's own: a line to go under the
 * total, or none. `shortDate` writes a day.
 */
export function countedDays({ counts }: SpendWindow, shortDate: (date: Date) => string): string[] {
  if (!counts) return []
  return [`The total counts purchases made from ${shortDate(counts.start)} to ${shortDate(dayBefore(counts.end))}.`]
}

/**
 * The same of the window of one card, and why, in the words for that card: of a statement, or of a month. It is the
 * line under the total of /spend with a card, or none.
 */
export function describeCounted(card: WindowRule, window: SpendWindow, shortDate: (date: Date) => string): string[] {
  if (!window.counts) return []
  const last = lastDays(window.counts.days)
  const so =
    card.windowType === 'calendar'
      ? `one made in ${last} of a month is counted in the next month`
      : `one made in ${last} before a statement closes is counted in the next statement month`
  return [`${countedDays(window, shortDate)[0]} The bank counts a purchase by the day it is posted, so ${so}.`]
}

/**
 * What a user is told of purchases that were just stored, when any of them is counted in the window after the one
 * that it was made in: see `carriedInto`. `on` are the purchases by the card that each is on, and those on no card
 * of their user's are in no window. `now` tells whether a statement has closed, and `shortDate` writes a day.
 *
 * It is one note, however many the purchases are, or none. It has a sentence for each window that any of them is
 * carried into, which is one window but for purchases of more than one month, and ends with why.
 */
export function carriedNotes(
  on: { card?: Card; purchases: { occurredAt: number }[] }[],
  now: Date,
  timeZone: string,
  shortDate: (date: Date) => string,
): string[] {
  const told = on.reduce((count, { purchases }) => count + purchases.length, 0)
  // Each window that a purchase is carried into, with its card and with how many purchases are.
  const into = new Map<SpendWindow, { card: Card; count: number }>()
  for (const { card, purchases } of on) {
    if (!card) continue
    const made = purchases.map(({ occurredAt }) => new Date(occurredAt * 1000))
    for (const window of carriedInto(card, made, timeZone)) {
      into.set(window, { card, count: (into.get(window)?.count ?? 0) + 1 })
    }
  }
  if (into.size === 0) return []

  /** How a sentence begins that is of `count` of the purchases, and the verb that goes with them after that. */
  const said = (count: number): [these: string, are: string] => {
    if (told === 1) return ['This purchase was', 'is']
    if (count === told) return ['These purchases were', 'are']
    return count === 1 ? ['1 of these purchases was', 'is'] : [`${count} of these purchases were`, 'are']
  }
  const sentences = [...into].map(([{ start, counts }, { card, count }]) => {
    const [these, are] = said(count)
    const made = `${these} made in ${lastDays(counts?.days ?? 0)}`
    if (card.windowType === 'calendar') {
      // A month is named as the calendar has it: the one that the purchase was made in, and the one after it.
      const month = new Intl.DateTimeFormat('en-US', { timeZone, month: 'long' })
      return `${made} of ${month.format(dayBefore(start))}, and so ${are} counted in ${month.format(start)}.`
    }
    // The statement closes on the day before the one that the window which counts the purchase starts on.
    const [closes, begins] = start.getTime() <= now.getTime() ? ['closed', 'began'] : ['closes', 'begins']
    return (
      `${made} before the statement ${closes} on ${shortDate(dayBefore(start))}, and so ${are} counted in the ` +
      `statement month that ${begins} on ${shortDate(start)}.`
    )
  })
  return [[...sentences, 'The bank counts a purchase by the day it is posted.'].join(' ')]
}

/** An instant of the day before the one that begins at `start`: its last. */
function dayBefore(start: Date): Date {
  return new Date(start.getTime() - 1)
}

/** The last days of a window, as a user is told how many they are: "the last 2 days", or "the last day". */
function lastDays(days: number): string {
  return days === 1 ? 'the last day' : `the last ${days} days`
}

export function maskLast4(last4: string): string {
  return `••••${last4}`
}

/** A whole number with its English ordinal ending, such as "1st", "22nd" or "13th". */
function ordinal(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}
