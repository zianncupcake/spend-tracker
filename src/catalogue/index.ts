import { hsbcRevolution } from './hsbc-revolution'
import type { Category, Choice, Product } from './types'
import { uobEvol } from './uob-evol'

/** The card products whose reward rules are known. A user links a card to one by its key. */
export const products: Product[] = [uobEvol, hsbcRevolution]

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

/**
 * The category that a rule of the product places the merchant in: the one whose pattern the text of the merchant
 * matches. Undefined for a merchant that no rule places.
 */
export function ruledByName(product: Product, merchant: string): string | undefined {
  return categoriesOf(product).find(({ automatic }) => automatic instanceof RegExp && automatic.test(merchant))?.key
}

/**
 * The category that is stored for a new purchase, or null when none is: the purchase is then in the product's
 * default category or, on a product that has none, is left for its user to sort.
 *
 * Only a rule of the product gives one. A purchase in another currency is known by that alone, and after that come
 * the names that the product lists. Nothing that the user chose for another purchase counts, not even for one at
 * the same merchant: a purchase is where its user put it only when it was that purchase's own button they pressed.
 */
export function startingCategory(
  product: Product,
  purchase: { currency: string; merchant: string | null },
): string | null {
  const { currency, merchant } = purchase
  const foreign = categoriesOf(product).find(({ automatic }) => automatic === 'foreign-currency')?.key

  const byCurrency = currency === product.homeCurrency ? undefined : foreign
  const byName = merchant === null ? undefined : ruledByName(product, merchant)
  return byCurrency ?? byName ?? null
}
