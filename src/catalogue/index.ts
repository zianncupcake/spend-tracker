import { dbsWomansWorld } from './dbs-womans-world'
import { hsbcRevolution } from './hsbc-revolution'
import { codeOf } from './merchants'
import { ocbcRewards } from './ocbc-rewards'
import type { Category, Group, Mcc, Product } from './types'
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

/**
 * What the user is shown for a category: what it is called on its button. Undefined for a key that is none of the
 * product's, and for the null of a purchase that is not sorted.
 */
export function categoryName(product: Product, key: string | null): string | undefined {
  return categoriesOf(product).find((category) => category.key === key)?.label
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
 * names that the product lists, and then the code of the merchant, when ./merchants knows it. What its user marked
 * another purchase as comes after this: see `startOf` in ../domain/sorting.
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
 * Whether the purchase is one to ask its user about: no rule placed it, so nothing is stored for it, on a product
 * whose rules go by the codes of merchants. A product that lists no codes has no more to learn from a merchant. And
 * one in another currency is left out, as a cap is held against what was spent in the product's own: see `sumsOf`
 * in ../telegram/purchases.
 */
export function unplaced(product: Product, purchase: { currency: string; category: string | null }): boolean {
  return byCodes(product) && purchase.category === null && purchase.currency === product.homeCurrency
}

/** Whether the rules of the product go by the codes of merchants. */
export function byCodes(product: Product): boolean {
  return categoriesOf(product).some(({ mccs }) => mccs !== undefined)
}

/**
 * The category that a purchase is placed in on a product, and by what: a name that the product lists, a merchant
 * code, or its user's mark of the merchant.
 */
export interface Placed {
  category: string
  by: 'name' | 'code' | 'mark'
}

/**
 * Where each product counts a purchase in its own currency: what the assistant's card_rules answers. `placed` is
 * where each product, in the order of `products`, places the purchase, or undefined where nothing does. `mcc` is the
 * code that was asked about or that is known for the merchant, or null. `bonus` is 'yes' or 'no' when the purchase
 * was placed in its group: a group with a limit is one that earns the bonus, on every product here. It is 'depends'
 * when it was not: the group is then only the one that a purchase starts in, and is null on a product that leaves
 * such a purchase not sorted. `bonusGroups` are the groups with a limit, and what each goes by.
 */
export function rulesFor(mcc: number | null, placed: (Placed | undefined)[]) {
  return {
    mcc,
    products: products.map((product, at) => {
      const { group, bonus } = placing(product, placed[at]?.category)
      return {
        product: product.name,
        group: group?.name ?? null,
        monthlyCap: money(group?.limitMinor, product.homeCurrency),
        bonus,
        by: placed[at]?.by ?? null,
        bonusGroups: product.groups
          .filter(({ limitMinor }) => limitMinor !== undefined)
          .map((each) => ({ group: each.name, goesBy: goesBy(each) })),
      }
    }),
  }
}

/**
 * What card_rules answers for a code that it is given, at the merchant when one is named: the rules of each product
 * alone place the purchase, and a name that the product lists comes before the code, as in `startingCategory`.
 */
export function rulesForCode(mcc: number, merchant: string | undefined) {
  return rulesFor(
    mcc,
    products.map((product): Placed | undefined => {
      const byName = merchant === undefined ? undefined : ruledByName(product, merchant)
      if (byName !== undefined) return { category: byName, by: 'name' }
      const byCode = ruledByCode(product, mcc)
      return byCode === undefined ? undefined : { category: byCode, by: 'code' }
    }),
  )
}

/**
 * The group that a purchase in the product's own currency counts in, when it was placed in the category `ruled` or
 * was not, and whether that earns the bonus: see `rulesFor`.
 */
export function placing(product: Product, ruled: string | undefined): { group?: Group; bonus: Bonus } {
  const group = groupOf(product, categoryOf(product, ruled ?? null))
  return { group, bonus: ruled === undefined ? 'depends' : group?.limitMinor === undefined ? 'no' : 'yes' }
}

export type Bonus = 'yes' | 'no' | 'depends'

/**
 * What each product's terms set for a month, in the order of the catalogue: its minimum spend, and the limit of each
 * of its groups and what a purchase gets into the group by. Null is for one that the terms do not set. It is what the
 * assistant's card_rules answers when it is asked about no purchase.
 */
export function productTerms() {
  return products.map(({ name, termsAsOf, minimumSpendMinor, homeCurrency, groups }) => ({
    product: name,
    termsAsOf,
    monthlyMinimumSpend: money(minimumSpendMinor, homeCurrency),
    groups: groups.map((group) => ({
      group: group.name,
      monthlyCap: money(group.limitMinor, homeCurrency),
      goesBy: goesBy(group),
    })),
  }))
}

/**
 * What a purchase gets into the group by: merchant codes, or only the merchants that the terms name, which a merchant
 * of the same kind is not. Null for neither, as for a group that goes by how a purchase is paid.
 */
function goesBy({ categories }: Group): 'codes' | 'named merchants' | null {
  if (categories.some(({ mccs }) => mccs !== undefined)) return 'codes'
  return categories.some(({ automatic }) => automatic instanceof RegExp) ? 'named merchants' : null
}

/** Hundredths as a decimal number in a string, which is how find_purchases gives the model an amount. Null for none. */
function money(minor: number | undefined, currency: string) {
  return minor === undefined ? null : { amount: (minor / 100).toFixed(2), currency }
}
