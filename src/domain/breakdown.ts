import { categoryOf } from '../catalogue'
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
  /** What is in no category of the product. Only a product with no default category leaves a purchase so. */
  unsorted: Amount[]
  /** What counts towards the minimum spend: the purchases in the product's own currency. */
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
  const { groups, homeCurrency } = product
  // A sum is told apart by what is stored for its purchases. Where they are is what the product makes of that.
  const placed = sums.map((sum) => ({ ...sum, category: categoryOf(product, sum.category) }))
  const spentIn = (keys: string[]) =>
    perCurrency(placed.filter((sum) => sum.category !== null && keys.includes(sum.category)))

  return {
    groups: groups.map(({ name, limitMinor, categories }) => ({
      name,
      spent: spentIn(categories.map((category) => category.key)),
      limitMinor,
    })),
    unsorted: perCurrency(placed.filter((sum) => sum.category === null)),
    countedMinor: sums
      .filter((sum) => sum.currency === homeCurrency)
      .reduce((total, sum) => total + sum.amountMinor, 0),
    foreignLeftOut: sums.some((sum) => sum.currency !== homeCurrency),
  }
}
