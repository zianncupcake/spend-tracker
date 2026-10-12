// What a user's monthly patterns hold back of the caps of a card's product, in the card's current window.

import { categoryOf, groupOf, startingCategory } from '../catalogue'
import { lettersOf, namedIn } from '../catalogue/merchants'
import type { Group, Product } from '../catalogue/types'
import type { Pattern, Transaction } from '../store'
import { countedIn, dayOf, type SpendWindow } from './window'

type Bought = Pick<Transaction, 'merchant' | 'currency' | 'amountMinor'>

/**
 * What each of a card's patterns holds back in the window, in their order: its amount, less what the window's
 * purchases at its merchant come to in the card's own currency, and never less than nothing. Nothing in a window
 * that counts one of its skipped days. A purchase counts for one pattern: of those whose names it holds, the one
 * with the longest name, or one at SAMPLE GYM would pay off "gym" as well. `purchases` are the window's.
 */
export function heldBack(
  patterns: Pattern[],
  purchases: Bought[],
  homeCurrency: string,
  window: SpendWindow,
  timeZone: string,
): number[] {
  // Most cards have none, and a request has little CPU time.
  if (patterns.length === 0) return []
  const names = patterns.map(({ merchant }) => lettersOf(merchant))
  const longestFirst = names.map((_, at) => at).sort((one, other) => names[other].length - names[one].length)
  const spent = patterns.map(() => 0)
  for (const { merchant, currency, amountMinor } of purchases) {
    if (merchant === null || currency !== homeCurrency) continue
    const holds = namedIn(merchant)
    const its = longestFirst.find((at) => holds(names[at]))
    if (its !== undefined) spent[its] += amountMinor
  }
  // A skipped day is one of its user's calendar, and so are the first and the last day that the window counts.
  const { start, end } = countedIn(window)
  const [first, last] = [written(start, timeZone), written(end - 1, timeZone)]
  return patterns.map(({ amountMinor, skips }, at) =>
    skips.some((day) => day >= first && day <= last) ? 0 : Math.max(0, amountMinor - spent[at]),
  )
}

/**
 * The group of the product that a pattern for the merchant counts against: the one that a purchase there would
 * start in. Undefined on a product that leaves such a purchase unsorted.
 */
export function groupFor(product: Product, merchant: string): Group | undefined {
  const key = categoryOf(product, startingCategory(product, { currency: product.homeCurrency, merchant }))
  return groupOf(product, key)
}

/**
 * What the patterns hold back of the cap of each group of the product, in the product's order: nothing of a group
 * that has no cap.
 */
export function toComeByGroup(
  product: Product,
  patterns: Pattern[],
  purchases: Bought[],
  window: SpendWindow,
  timeZone: string,
): number[] {
  const held = heldBack(patterns, purchases, product.homeCurrency, window, timeZone)
  const against = patterns.map(({ merchant }) => groupFor(product, merchant))
  return product.groups.map((group) => {
    if (group.limitMinor === undefined) return 0
    return held.reduce((sum, minor, at) => (against[at] === group ? sum + minor : sum), 0)
  })
}

/** The day that the unix seconds fall on in the time zone, written as a skipped day is: YYYY-MM-DD. */
function written(seconds: number, timeZone: string): string {
  const { year, month, day } = dayOf(new Date(seconds * 1000), timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
