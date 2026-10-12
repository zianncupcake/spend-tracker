import { dbsWomansWorld } from './dbs-womans-world'
import { hsbcRevolution } from './hsbc-revolution'
import { codeOf } from './merchants'
import { ocbcRewards } from './ocbc-rewards'
import type { Category, Choice, Group, Mcc, Product } from './types'
import { uobEvol } from './uob-evol'

/** The card products whose reward rules are known. A user links a card to one by its key. */
export const products: Product[] = [uobEvol, hsbcRevolution, ocbcRewards, dbsWomansWorld]

/** The product with the key. Undefined when there is none, and for the key of a card that is linked to no product. */
export function productOf(key: string | undefined): Product | undefined {
  return products.find((product) => product.key === key)
}

/** Every category of the product, in the order of its groups. */
export function categoriesOf(product: Product): Category[] {
  return product.groups.flatMap((group) => group.categories)
}

/** The categories that a user can put a purchase in, in the order of their buttons. */
export function choicesOf(product: Product): Choice[] {
  return categoriesOf(product).filter((category): category is Choice => category.label !== undefined)
}

/**
 * What the user is shown for a category: what it is called on its button or, for one that has no button, the name
 * of its group. Undefined for a key that is none of the product's, and for the null of a purchase that is not sorted.
 */
export function categoryName(product: Product, key: string | null): string | undefined {
  for (const group of product.groups) {
    const category = group.categories.find((each) => each.key === key)
    if (category) return category.label ?? group.name
  }
  return undefined
}

/**
 * The category that a purchase is in, from the key that is stored for it. That is the stored one when the product
 * has it. Otherwise it is the product's default: when nothing is stored, and when what is stored is a category of a
 * product that the card was linked to before. Null when the product has no default either, which leaves the
 * purchase not sorted.
 */
export function categoryOf(product: Product, stored: string | null): string | null {
  const known = categoriesOf(product).some((category) => category.key === stored)
  return known ? stored : (product.defaultCategory ?? null)
}

/** The group of the product that the category with the key is in. Undefined for a key that is none of the product's. */
export function groupOf(product: Product, key: string | null): Group | undefined {
  return product.groups.find(({ categories }) => categories.some((category) => category.key === key))
}

/**
 * The category that a rule of the product places the merchant in: the one whose pattern the text of the merchant
 * matches. Undefined for a merchant that no rule places.
 */
export function ruledByName(product: Product, merchant: string): string | undefined {
  return categoriesOf(product).find(({ automatic }) => automatic instanceof RegExp && automatic.test(merchant))?.key
}

/**
 * The category that the product puts a merchant of the code in: the one whose codes hold it or, when none does, the
 * one that takes the unlisted. Undefined when the product has neither, as one that lists no codes at all.
 */
export function ruledByCode(product: Product, mcc: number): string | undefined {
  const categories = categoriesOf(product)
  const holds = (listed: Mcc) => (typeof listed === 'number' ? listed === mcc : listed[0] <= mcc && mcc <= listed[1])
  const listing = categories.find(({ mccs }) => Array.isArray(mccs) && mccs.some(holds))
  return (listing ?? categories.find(({ mccs }) => mccs === 'unlisted'))?.key
}

/**
 * The category that is stored for a new purchase, or null when none is: the purchase is then in the product's
 * default category or, on a product that has none, is left for its user to sort.
 *
 * Only a rule of the product gives one. A purchase in another currency is known by that alone. After that come the
 * names that the product lists, and then the code of the merchant, when ./merchants knows it. Nothing that the user
 * chose for another purchase counts: a purchase is where its user put it only when its own button was pressed.
 */
export function startingCategory(
  product: Product,
  purchase: { currency: string; merchant: string | null },
): string | null {
  const { currency, merchant } = purchase
  const foreign = categoriesOf(product).find(({ automatic }) => automatic === 'foreign-currency')?.key

  const byCurrency = currency === product.homeCurrency ? undefined : foreign
  const byName = merchant === null ? undefined : ruledByName(product, merchant)
  const code = merchant === null ? undefined : codeOf(merchant)
  const byCode = code === undefined ? undefined : ruledByCode(product, code)
  return byCurrency ?? byName ?? byCode ?? null
}

/**
 * Where each product counts a purchase in its own currency, at a merchant of the code or of the name: what the
 * assistant's card_rules answers. A name that the product lists comes before a code, as in `startingCategory`. The
 * code is the one that was given or, with none, the one that ./merchants knows for the name: `mcc` is that, or null.
 * `bonus` is 'yes' or 'no' when a rule of the product put the purchase in its group: a group with a limit is one
 * that earns the bonus, on every product here. It is 'depends' when no rule did: the group is then only the one
 * that a purchase starts in, and is null on a product that leaves such a purchase not sorted.
 */
export function rulesFor(asked: { mcc?: number; merchant?: string }) {
  const { merchant } = asked
  const mcc = asked.mcc ?? (merchant === undefined ? undefined : codeOf(merchant))
  return {
    mcc: mcc ?? null,
    products: products.map((product) => {
      const byName = merchant === undefined ? undefined : ruledByName(product, merchant)
      const byCode = mcc === undefined ? undefined : ruledByCode(product, mcc)
      const ruled = byName ?? byCode
      const key = categoryOf(product, ruled ?? null)
      const group = groupOf(product, key)
      const limit = group?.limitMinor
      return {
        product: product.name,
        group: group?.name ?? null,
        // Hundredths as a decimal number in a string, which is how find_purchases gives the model an amount.
        monthlyCap: limit === undefined ? null : { amount: (limit / 100).toFixed(2), currency: product.homeCurrency },
        bonus: ruled === undefined ? 'depends' : limit === undefined ? 'no' : 'yes',
      }
    }),
  }
}
