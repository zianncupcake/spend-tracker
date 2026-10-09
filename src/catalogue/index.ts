import type { Category, Choice, Product } from './types'
import { uobEvol } from './uob-evol'

/** The card products whose reward rules are known. A user links a card to one by its key. */
export const products: Product[] = [uobEvol]

/** The product with the key. Undefined when there is none, and for the key of a card that is linked to no product. */
export function productOf(key: string | undefined): Product | undefined {
  return products.find((product) => product.key === key)
}

/** Every category of the product: those of its groups, and then the one for what the bank pays nothing on. */
export function categoriesOf(product: Product): Category[] {
  return [...product.groups.flatMap((group) => group.categories), product.excluded]
}

/** The categories that a user can put a purchase in, in the order of their buttons. */
export function choicesOf(product: Product): Choice[] {
  return categoriesOf(product).filter((category): category is Choice => category.label !== undefined)
}

/**
 * What the user is shown for a category: the words on its button or, for one that has no button, the name of its
 * group. Undefined for a key that is none of the product's, and for the null of a purchase that is not sorted.
 */
export function categoryName(product: Product, key: string | null): string | undefined {
  if (key === product.excluded.key) return product.excluded.label
  for (const group of product.groups) {
    const category = group.categories.find((each) => each.key === key)
    if (category) return category.label ?? group.name
  }
  return undefined
}

/**
 * The category that a purchase starts in, or null when it is left for its user to sort. `remembered` is the
 * category that the user last chose for a purchase at the same merchant, if they chose one.
 *
 * A purchase in another currency is known by that alone. After that, what the user chose goes before the names that
 * the product lists: it is the user who knows what a purchase was.
 */
export function startingCategory(
  product: Product,
  purchase: { currency: string; merchant: string | null },
  remembered: string | null,
): string | null {
  const { currency, merchant } = purchase
  const ruled = (applies: (rule: NonNullable<Category['automatic']>) => boolean) =>
    categoriesOf(product).find(({ automatic }) => automatic !== undefined && applies(automatic))?.key

  const byCurrency = currency === product.homeCurrency ? undefined : ruled((rule) => rule === 'foreign-currency')
  const byChoice = choicesOf(product).find((choice) => choice.key === remembered)?.key
  const byName = merchant === null ? undefined : ruled((rule) => rule instanceof RegExp && rule.test(merchant))
  return byCurrency ?? byChoice ?? byName ?? null
}
