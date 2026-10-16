import { categoryOf } from '../catalogue'
import type { Product } from '../catalogue/types'
import type { Rates } from '../reference-rates'
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
  /**
   * What counts towards the minimum spend, in the product's own currency. The terms count every purchase of the
   * window, whatever its currency, so one in another currency counts at the rates, or is left out without them.
   */
  countedMinor: number
  /** What became of the purchases in other currencies in `countedMinor`: 'none' when the window has none. */
  foreign: 'none' | 'converted' | 'left out'
}

/** One total for each currency, in the order that the currencies first come in. */
export function perCurrency(amounts: Amount[]): Amount[] {
  const totals = new Map<string, number>()
  for (const { currency, amountMinor } of amounts) totals.set(currency, (totals.get(currency) ?? 0) + amountMinor)
  return [...totals].map(([currency, amountMinor]) => ({ currency, amountMinor }))
}

/** An amount in the home currency at `rates`, rounded to the cent: see ratesFor. */
export function inHome({ currency, amountMinor }: Amount, homeCurrency: string, rates: Rates): number {
  return currency === homeCurrency ? amountMinor : Math.round(amountMinor / rates[currency])
}

/**
 * `sums` are those of the window, a currency and a category at a time, as a store's `sumByCategory` gives them, or
 * its purchases one at a time. `rates` are today's of its other currencies against the product's own, when known.
 */
export function breakDown(product: Product, sums: Omit<CategoryTotal, 'count'>[], rates: Rates | null): Breakdown {
  const { groups, homeCurrency } = product
  // A sum is told apart by what is stored for its purchases. Where they are is what the product makes of that.
  const placed = sums.map((sum) => ({ ...sum, category: categoryOf(product, sum.category) }))
  const spentIn = (keys: string[]) =>
    perCurrency(placed.filter((sum) => sum.category !== null && keys.includes(sum.category)))
  const foreign = sums.some((sum) => sum.currency !== homeCurrency)
  // Each currency is converted as a whole, as the total of a card is: see describeTotals.
  const counted = rates
    ? perCurrency(sums).map((amount) => inHome(amount, homeCurrency, rates))
    : sums.filter((sum) => sum.currency === homeCurrency).map((sum) => sum.amountMinor)

  return {
    groups: groups.map(({ name, limitMinor, categories }) => ({
      name,
      spent: spentIn(categories.map((category) => category.key)),
      limitMinor,
    })),
    unsorted: perCurrency(placed.filter((sum) => sum.category === null)),
    countedMinor: counted.reduce((total, minor) => total + minor, 0),
    foreign: !foreign ? 'none' : rates ? 'converted' : 'left out',
  }
}

/**
 * What is left of a group's limit, in the product's own currency: less what was spent in that currency, which is
 * what the limit is held against, and less what the card's patterns hold back of it. Less than nothing past it.
 */
export function leftOf(limitMinor: number, spent: Amount[], homeCurrency: string, toComeMinor: number): number {
  return limitMinor - (spent.find(({ currency }) => currency === homeCurrency)?.amountMinor ?? 0) - toComeMinor
}
