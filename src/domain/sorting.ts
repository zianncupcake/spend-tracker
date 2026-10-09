import { productOf, startingCategory } from '../catalogue'
import type { Product } from '../catalogue/types'
import type { Card, Store } from '../store'
import { currentWindow } from './window'

/**
 * How many of the purchases in a card's window are read at once: the latest of them. A request has little CPU time
 * and Telegram takes a few messages at a time, and no card comes near this many purchases in a month.
 */
export const WINDOW_LIMIT = 200

/**
 * The category that a purchase on the card starts in. Null when the card is linked to no product, and when nothing
 * settles where the purchase belongs, which leaves it for its user to sort.
 */
export async function startingCategoryOn(
  store: Store,
  card: Card | undefined,
  purchase: { currency: string; merchant: string | null },
): Promise<string | null> {
  const product = productOf(card?.product)
  if (!product) return null
  const remembered = purchase.merchant ? await store.rememberedCategory(product.key, purchase.merchant) : null
  return startingCategory(product, purchase, remembered)
}

/**
 * Sorts the purchases in the card's current window that the product's own rules settle, and that are not sorted
 * yet. This is for a card that has just been linked to the product: its purchases until then were stored unsorted,
 * and the categories that only a rule gives have no button to choose them by.
 */
export async function sortByRules(
  store: Store,
  card: Card,
  product: Product,
  now: Date,
  timeZone: string,
): Promise<void> {
  const { start, end } = currentWindow(card, now, timeZone)
  const purchases = await store.listTransactions(card.last4, start.getTime() / 1000, end.getTime() / 1000, WINDOW_LIMIT)
  const sorted = new Map<string, number[]>()
  for (const purchase of purchases) {
    const category = purchase.category === null ? startingCategory(product, purchase, null) : null
    if (category) sorted.set(category, [...(sorted.get(category) ?? []), purchase.id])
  }
  // One statement for each category that a rule gives, which is a few at most.
  for (const [category, ids] of sorted) await store.sortUnsorted(ids, category)
}
