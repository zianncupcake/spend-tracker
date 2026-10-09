import { categoriesOf } from '../catalogue'
import type { Product } from '../catalogue/types'
import type { CategoryTotal } from '../store'

export interface Amount {
  currency: string
  amountMinor: number
}

/** What a product's rules make of the purchases in a card's window. */
export interface Breakdown {
  /** One for each group of the product, in the product's order, with what was spent in the group's categories. */
  groups: { name: string; spent: Amount[]; limitMinor?: number }[]
  /** What is sorted into no category of the product. */
  unsorted: Amount[]
  /** What the bank pays nothing on. */
  excluded: Amount[]
  /** What counts towards the minimum spend: the purchases in the product's own currency, but for the excluded ones. */
  countedMinor: number
  /** Whether other purchases would count too, were they not in other currencies: what they come to is not known. */
  foreignLeftOut: boolean
}

/** One total for each currency, in the order that the currencies first come in. */
export function perCurrency(amounts: Amount[]): Amount[] {
  const totals = new Map<string, number>()
  for (const { currency, amountMinor } of amounts) totals.set(currency, (totals.get(currency) ?? 0) + amountMinor)
  return [...totals].map(([currency, amountMinor]) => ({ currency, amountMinor }))
}

/** `sums` are those of the window, a currency and a category at a time, as a store's `sumByCategory` gives them. */
export function breakDown(product: Product, sums: CategoryTotal[]): Breakdown {
  const { groups, excluded, homeCurrency } = product
  const known = categoriesOf(product).map((category) => category.key)
  const spentIn = (keys: string[]) =>
    perCurrency(sums.filter((sum) => sum.category !== null && keys.includes(sum.category)))
  const counted = sums.filter((sum) => sum.category !== excluded.key)

  return {
    groups: groups.map(({ name, limitMinor, categories }) => ({
      name,
      spent: spentIn(categories.map((category) => category.key)),
      limitMinor,
    })),
    // A category that the product does not have is one of a product that the card was linked to before.
    unsorted: perCurrency(sums.filter((sum) => sum.category === null || !known.includes(sum.category))),
    excluded: spentIn([excluded.key]),
    countedMinor: counted
      .filter((sum) => sum.currency === homeCurrency)
      .reduce((total, sum) => total + sum.amountMinor, 0),
    foreignLeftOut: counted.some((sum) => sum.currency !== homeCurrency),
  }
}
