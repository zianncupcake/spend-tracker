import type { CardTotals } from '../domain/totals'
import type { WindowRule } from '../domain/window'

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

export function maskLast4(last4: string): string {
  return `••••${last4}`
}

/** A whole number with its English ordinal ending, such as "1st", "22nd" or "13th". */
function ordinal(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}
