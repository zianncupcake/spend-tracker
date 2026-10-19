import {
  byCodes,
  categoryOf,
  productOf,
  ruledByCode,
  ruledByName,
  startingCategory,
  unplaced,
  type Placed,
} from '../catalogue'
import { codeOf, lettersOf, nameOf } from '../catalogue/merchants'
import type { Product } from '../catalogue/types'
import { codesFoundFor } from '../mcc-lookup'
import type { Card, Mark, Store, Transaction } from '../store'
import { countedIn, currentWindow } from './window'

/**
 * How many of the purchases in a card's window are read at once: the latest of them. A request has little CPU time
 * and Telegram takes a few messages at a time, and no card comes near this many purchases in a month. The rich
 * message that lists them has a row for each, and Telegram takes 500 blocks and rows in one: see RichMessage.
 */
export const WINDOW_LIMIT = 200

/** Where a new purchase starts: its category, or null, and whether its user's mark of the merchant put it there. */
export interface Start {
  category: string | null
  remembered: boolean
}

/**
 * Where each new purchase on the card starts, in their order: what is stored for a purchase from an alert and for
 * one that is added by hand alike. Null when the card is linked to no product, and when nothing places the purchase.
 * See `startOf` for what comes first. A purchase that is still one that `unplaced` holds for after that goes by what
 * ../mcc-lookup finds. One query, for the user's marks, however many purchases there are. None on a product that
 * goes by no codes, which has no marks: see markAs.
 */
export async function startingCategoriesOn(
  store: Store,
  card: Card | undefined,
  purchases: { currency: string; merchant: string | null }[],
): Promise<Start[]> {
  const product = productOf(card?.product)
  if (!product) return purchases.map(() => ({ category: null, remembered: false }))
  const marks = byCodes(product) ? await store.listMarks() : []
  const starts = purchases.map((purchase) => startOf(product, marks, purchase))
  const open = purchases.flatMap(({ currency, merchant }, at) =>
    merchant !== null && unplaced(product, { currency, category: starts[at].category }) ? [{ at, merchant }] : [],
  )
  const codes = await codesFoundFor(open.map(({ merchant }) => merchant))
  for (const [nth, { at }] of open.entries()) starts[at].category = categoryByCodes(product, codes[nth])
  return starts
}

/**
 * Where a purchase at the merchant in its own currency would start on each of the products, in their order: by
 * `startOf`, and then by what ../mcc-lookup finds. Undefined on a product that nothing places it on. One query, for
 * the user's marks, and the merchant is looked up once, when a product is left that would go by its codes. `mcc` is
 * the merchant's code that ./merchants knows or, with none, that the stores which were found all have, or null.
 */
export async function placedOn(
  store: Store,
  products: Product[],
  merchant: string,
): Promise<{ mcc: number | null; placed: (Placed | undefined)[] }> {
  const marks = await store.listMarks()
  const starts = products.map((product) => startOf(product, marks, { currency: product.homeCurrency, merchant }))
  const asks = products.some((product, at) =>
    unplaced(product, { currency: product.homeCurrency, category: starts[at].category }),
  )
  const [codes = []] = asks ? await codesFoundFor([merchant]) : []
  const [found, ...others] = new Set(codes)
  const mcc = codeOf(merchant) ?? (others.length === 0 ? (found ?? null) : null)
  const placed = products.map((product, at): Placed | undefined => {
    const { category, remembered } = starts[at]
    if (category === null) {
      const found = categoryByCodes(product, codes)
      return found === null ? undefined : { category: found, by: 'code' }
    }
    // A rule of the product goes by a name that the product lists before a code: see `startingCategory`.
    return { category, by: remembered ? 'mark' : ruledByName(product, merchant) === undefined ? 'code' : 'name' }
  })
  return { mcc, placed }
}

/**
 * Where a new purchase starts before anything is looked up for it: where a rule of the product puts it and, for one
 * that `unplaced` then holds for, where its user marked a purchase at the merchant on the product: see `markAs`.
 * `marks` are the user's.
 */
export function startOf(
  product: Product,
  marks: Mark[],
  purchase: { currency: string; merchant: string | null },
): Start {
  const { currency, merchant } = purchase
  const category = startingCategory(product, purchase)
  const open = merchant !== null && unplaced(product, { currency, category })
  const letters = open ? lettersOf(nameOf(merchant)) : undefined
  const mark = marks.find((each) => each.product === product.key && each.letters === letters)
  return mark ? { category: mark.category, remembered: true } : { category, remembered: false }
}

/**
 * Puts the purchase in the category that its user marked it as, and moves no other that is stored. On a product that
 * goes by the codes of merchants, the mark is remembered by the merchant's name for the user's later purchases there,
 * in the place of the one before. It never overrides a rule of the product, as the rules come first: see `startOf`.
 * On a product that goes by no codes, a mark says how the one purchase was made, and is not remembered.
 */
export async function markAs(store: Store, product: Product, purchase: Transaction, category: string): Promise<void> {
  // Nothing moves a purchase to where it is already. With no category stored for it, that is the default of its
  // product, which the store would take for a move.
  if (categoryOf(product, purchase.category) === category) return
  await store.setCategory(purchase.id, category)
  const name = purchase.merchant === null ? '' : nameOf(purchase.merchant)
  if (byCodes(product) && name !== '') await store.remember(product.key, name, category)
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
 * with no category, or with one of another product that is forgotten by now, and what the rules settle is not left
 * for its user to mark.
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
