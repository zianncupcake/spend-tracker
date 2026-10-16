// Which of a user's cards to pay with at a merchant: where a purchase there would start on each card's product,
// whether that earns the bonus, and what is left of the cap that it would count against.

import { placing, productOf, unplaced, type Bonus } from '../catalogue'
import type { Group, Product } from '../catalogue/types'
import { codesFoundFor } from '../mcc-lookup'
import { ratesFor } from '../reference-rates'
import type { Card, Pattern, Store } from '../store'
import { breakDown, leftOf } from './breakdown'
import { toComeByGroup } from './patterns'
import { categoryByCodes, startOf, WINDOW_LIMIT } from './sorting'
import { countedIn, currentWindow } from './window'

/** What a purchase at the merchant would do on one card, in its product's own currency. */
export interface Option {
  card: Card
  product: Product
  /** 'depends' when no rule and no code placed the purchase: it counts in `group` until its user marks it. */
  bonus: Bonus
  /** The group that it would count in. None on a product that leaves such a purchase not sorted. */
  group?: Group
  /** What is left of the group's cap in the card's current window, for a group with one: see `leftOf`. */
  leftMinor?: number
  /** What the window has still to spend to reach the product's minimum, when it has one and has not reached it. */
  neededMinor?: number
  /** Whether purchases in other currencies went into `neededMinor`, at today's rates. */
  neededConverted: boolean
}

/**
 * A pick for each of the cards that is linked to a product, best first: a bonus with some of its cap left, the most
 * left first, then those that are not sure, then a bonus whose cap is used up, then no bonus.
 *
 * A purchase there is placed as a new one would be: see `startOf`. One query for the user's marks, and one for each
 * such card: its window's latest purchases, which give both what each group has spent and what the patterns hold
 * back. And the merchant's codes are looked up once, as they are the merchant's and not a card's. Today's rates are
 * asked once for each home currency, of the other currencies of the cards with a minimum, when they hold any.
 */
export async function bestFor(
  store: Store,
  cards: Card[],
  patterns: Pattern[],
  merchant: string,
  now: Date,
  timeZone: string,
): Promise<Option[]> {
  const linked = cards.flatMap((card) => {
    const product = productOf(card.product)
    return product ? [{ card, product }] : []
  })
  const marks = await store.listMarks()
  const starts = linked.map(({ product }) => startOf(product, marks, { currency: product.homeCurrency, merchant }))
  const asks = linked.some(({ product }, at) =>
    unplaced(product, { currency: product.homeCurrency, category: starts[at].category }),
  )
  const [codes = []] = asks ? await codesFoundFor([merchant]) : []

  const read = await Promise.all(
    linked.map(async ({ card }) => {
      const window = currentWindow(card, now, timeZone)
      const { start, end } = countedIn(window)
      return { window, purchases: await store.listTransactions(card.last4, start, end, WINDOW_LIMIT) }
    }),
  )
  const foreign = new Map<string, Set<string>>()
  linked.forEach(({ product: { homeCurrency, minimumSpendMinor } }, at) => {
    if (minimumSpendMinor === undefined) return
    const currencies = foreign.get(homeCurrency) ?? new Set()
    for (const { currency } of read[at].purchases) if (currency !== homeCurrency) currencies.add(currency)
    foreign.set(homeCurrency, currencies)
  })
  const asked = [...foreign].map(async ([home, currencies]) => [home, await ratesFor(home, [...currencies])] as const)
  const rates = new Map(await Promise.all(asked))

  const options = linked.map(({ card, product }, at): Option => {
    const { group, bonus } = placing(product, starts[at].category ?? categoryByCodes(product, codes) ?? undefined)
    const { window, purchases } = read[at]
    const { homeCurrency, minimumSpendMinor } = product
    // A card with no minimum has no use for rates, which were not asked of its currencies.
    const known = minimumSpendMinor === undefined ? null : (rates.get(homeCurrency) ?? null)
    const breakdown = breakDown(product, purchases, known)
    const limit = group?.limitMinor
    const index = group ? product.groups.indexOf(group) : -1
    const onCard = patterns.filter(({ cardLast4 }) => cardLast4 === card.last4)
    const toCome = toComeByGroup(product, onCard, purchases, window, timeZone)
    const leftMinor =
      limit === undefined ? undefined : leftOf(limit, breakdown.groups[index].spent, homeCurrency, toCome[index])
    const needed = (minimumSpendMinor ?? 0) - breakdown.countedMinor
    const neededConverted = breakdown.foreign === 'converted'
    return { card, product, bonus, group, leftMinor, neededMinor: needed > 0 ? needed : undefined, neededConverted }
  })
  const tier = ({ bonus, leftMinor = 0 }: Option) => ({ yes: leftMinor > 0 ? 0 : 2, depends: 1, no: 3 })[bonus]
  return options.sort((one, other) => tier(one) - tier(other) || (other.leftMinor ?? 0) - (one.leftMinor ?? 0))
}
