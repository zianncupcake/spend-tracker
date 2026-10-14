import { productOf, ruledByCode, startingCategory, unplaced } from '../catalogue'
import type { Product } from '../catalogue/types'
import { codesFoundFor } from '../mcc-lookup'
import type { Card, Store } from '../store'
import { countedIn, currentWindow } from './window'

/**
 * How many of the purchases in a card's window are read at once: the latest of them. A request has little CPU time
 * and Telegram takes a few messages at a time, and no card comes near this many purchases in a month. The rich
 * message that lists them has a row for each, and Telegram takes 500 blocks and rows in one: see RichMessage.
 */
export const WINDOW_LIMIT = 200

/**
 * The category that each new purchase on the card starts in, in their order: what is stored for a purchase from an
 * alert and for one that is added by hand alike. Null when the card is linked to no product, and when nothing places
 * the purchase. A rule of the product comes first: see `startingCategory`. A purchase that no rule placed on a
 * product that goes by the codes of merchants, which is when `unplaced` holds, goes by what ../mcc-lookup finds.
 */
export async function startingCategoriesOn(
  card: Card | undefined,
  purchases: { currency: string; merchant: string | null }[],
): Promise<(string | null)[]> {
  const product = productOf(card?.product)
  if (!product) return purchases.map(() => null)
  const categories = purchases.map((purchase) => startingCategory(product, purchase))
  const open = purchases.flatMap(({ currency, merchant }, at) =>
    merchant !== null && unplaced(product, { currency, category: categories[at] }) ? [{ at, merchant }] : [],
  )
  const codes = await codesFoundFor(open.map(({ merchant }) => merchant))
  for (const [nth, { at }] of open.entries()) categories[at] = categoryByCodes(product, codes[nth])
  return categories
}

/**
 * The category that the product puts a merchant in by the codes that ../mcc-lookup found for it. The stores that
 * were found can differ in their codes, so it is null unless the product puts them all in one category.
 */
export function categoryByCodes(product: Product, codes: number[]): string | null {
  const [category, ...others] = new Set(codes.map((code) => ruledByCode(product, code)))
  return others.length === 0 ? (category ?? null) : null
}

/**
 * Sorts the purchases in the card's current window that the product's own rules settle, and that no category is
 * stored for yet. This is for a card that has just been linked to the product: its purchases until then were stored
 * with no category, or with one of another product that is forgotten by now, and the categories that only a rule
 * gives have no button to choose them by.
 */
export async function sortByRules(
  store: Store,
  card: Card,
  product: Product,
  now: Date,
  timeZone: string,
): Promise<void> {
  // The window is the one that the card has as it is linked now: a product can say which days a cycle counts, and the
  // card may be given as it was before it was linked.
  const { start, end } = countedIn(currentWindow({ ...card, product: product.key }, now, timeZone))
  const purchases = await store.listTransactions(card.last4, start, end, WINDOW_LIMIT)
  const sorted = new Map<string, number[]>()
  for (const purchase of purchases) {
    const category = purchase.category === null ? startingCategory(product, purchase) : null
    if (category) sorted.set(category, [...(sorted.get(category) ?? []), purchase.id])
  }
  // One statement for each category that a rule gives, which is a few at most.
  for (const [category, ids] of sorted) await store.sortUnsorted(ids, category)
}
