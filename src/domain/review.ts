// What of a card's spending looks monthly, for the monthly review: see ../review.

import { lettersOf, nameOf } from '../catalogue/merchants'
import type { Transaction } from '../store'
import { dayOf, startOfDay } from './window'

/** What was spent at a merchant in a month, by a name for the merchant and the letters that a pattern goes by. */
export interface Monthly {
  name: string
  letters: string
  /** A text that the name was made from: that of a purchase of the month. */
  text: string
  amountMinor: number
}

/**
 * The two calendar months before the one that `now` is in, by the calendar of the time zone, in unix seconds: the
 * earlier runs from `start` to `later`, and the later from there to `end`.
 */
export function monthsBefore(now: Date, timeZone: string): { start: number; later: number; end: number } {
  const { year, month } = dayOf(now, timeZone)
  // `month` is 1 to 12 here, and a month before January carries over into the year before.
  const startOf = (monthOf: number) => startOfDay(year, monthOf, 1, timeZone).getTime() / 1000
  return { start: startOf(month - 2), later: startOf(month - 1), end: startOf(month) }
}

/**
 * What looks monthly among one card's purchases of two months, of which the later begins at `later`, in unix
 * seconds: each merchant with a purchase in both, with what was spent there in the later one. Purchases are of one
 * merchant when their names have the same letters, as they would be to a pattern.
 */
export function monthlyAmong(
  purchases: Pick<Transaction, 'merchant' | 'amountMinor' | 'occurredAt'>[],
  later: number,
): Monthly[] {
  const earlier = new Set<string>()
  const spent = new Map<string, Monthly>()
  for (const { merchant, amountMinor, occurredAt } of purchases) {
    if (merchant === null) continue
    const name = nameOf(merchant)
    const letters = lettersOf(name)
    const before = spent.get(letters)?.amountMinor ?? 0
    if (occurredAt < later) earlier.add(letters)
    else spent.set(letters, { name, letters, text: merchant, amountMinor: before + amountMinor })
  }
  return [...spent.values()].filter(({ letters }) => earlier.has(letters))
}
