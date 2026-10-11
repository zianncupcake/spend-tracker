import { productOf, startingCategory } from '../catalogue'
import type { Product } from '../catalogue/types'
import type { Card, Store } from '../store'
import { countedIn, currentWindow } from './window'

/**
 * How many of the purchases in a card's window are read at once: the latest of them. A request has little CPU time
 * and Telegram takes a few messages at a time, and no card comes near this many purchases in a month. The rich
 * message that lists them has a row for each, and Telegram takes 500 blocks and rows in one: see RichMessage.
 */
export const WINDOW_LIMIT = 200

/**
 * The category that is stored for a new purchase on the card. Null when the card is linked to no product, and when
 * no rule of its product places the purchase: see `startingCategory`.
 */
export function startingCategoryOn(
  card: Card | undefined,
  purchase: { currency: string; merchant: string | null },
): string | null {
  const product = productOf(card?.product)
  return product ? startingCategory(product, purchase) : null
}

/**
 * Sorts the purchases in the card's current window that the product's own rules settle, and that no category is
 * stored for yet. This is for a card that has just been linked to the product: its purchases until then were stored
 * with no category, and the categories that only a rule gives have no button to choose them by.
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
