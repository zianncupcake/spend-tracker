import { describe, expect, it } from 'vitest'
import type { Product } from '../src/catalogue/types'
import { uobEvol } from '../src/catalogue/uob-evol'
import { breakDown, perCurrency } from '../src/domain/breakdown'
import type { CategoryTotal } from '../src/store'
import { breakdownLines } from '../src/telegram/purchases'

const TERMS = "Limits are from the bank's terms for the UOB EVOL Card, as of 10 June 2026."

/** The same card, were it to take a purchase to be nowhere until something says where it is. */
const NO_DEFAULT: Product = { ...uobEvol, defaultCategory: undefined }

/** What a window's purchases come to, as the store sums them: for a currency and a category at a time. */
function sum(category: string | null, amountMinor: number, currency = 'SGD', count = 1): CategoryTotal {
  return { category, amountMinor, currency, count }
}

describe('what a product makes of a window', () => {
  it('sums each group, with what no category is stored for summed into the group of the default one', () => {
    const made = breakDown(uobEvol, [
      sum('online', 12000),
      sum(null, 4550),
      sum('selected', 1598),
      sum('other', 800),
      sum('fx', 500, 'USD'),
    ])

    expect(made.groups).toEqual([
      {
        name: 'Online and Mobile Contactless Spend',
        spent: [{ currency: 'SGD', amountMinor: 16550 }],
        limitMinor: 30000,
      },
      {
        name: 'Selected Gym, Telco and Streaming Spend',
        spent: [{ currency: 'SGD', amountMinor: 1598 }],
        limitMinor: 20000,
      },
      { name: 'Other Spend', spent: [{ currency: 'SGD', amountMinor: 800 }], limitMinor: undefined },
      {
        name: 'Overseas Foreign Currency Spend',
        spent: [{ currency: 'USD', amountMinor: 500 }],
        limitMinor: undefined,
      },
    ])
    expect(made.unsorted).toEqual([])
  })

  it('has every group even when nothing was spent in it', () => {
    const made = breakDown(uobEvol, [])

    expect(made.groups.map((group) => [group.name, group.spent])).toEqual([
      ['Online and Mobile Contactless Spend', []],
      ['Selected Gym, Telco and Streaming Spend', []],
      ['Other Spend', []],
      ['Overseas Foreign Currency Spend', []],
    ])
    expect(made).toMatchObject({ unsorted: [], countedMinor: 0, foreignLeftOut: false })
  })

  it('takes a category that the product does not have for the default one too, and leaves nothing unsorted', () => {
    // A category of a product that the card was linked to before is not one of this product's.
    const made = breakDown(uobEvol, [sum('dining', 360), sum(null, 1240), sum('online', 100), sum('other', 5000)])

    expect(made.groups[0].spent).toEqual([{ currency: 'SGD', amountMinor: 1700 }])
    expect(made.groups[2].spent).toEqual([{ currency: 'SGD', amountMinor: 5000 }])
    expect(made.unsorted).toEqual([])
  })

  it('keeps apart what is not sorted, on a product with no default category', () => {
    const made = breakDown(NO_DEFAULT, [
      sum(null, 1240),
      sum(null, 700, 'USD'),
      sum('dining', 360),
      sum('online', 100),
    ])

    expect(made.unsorted).toEqual([
      { currency: 'SGD', amountMinor: 1600 },
      { currency: 'USD', amountMinor: 700 },
    ])
    expect(made.groups[0].spent).toEqual([{ currency: 'SGD', amountMinor: 100 }])
    // Sorted or not, it counts towards the minimum spend.
    expect(made.countedMinor).toBe(1700)
  })

  it("counts towards the minimum spend whatever is in the product's currency, wherever it is sorted", () => {
    const made = breakDown(uobEvol, [
      sum('online', 30000),
      sum('other', 20000),
      sum(null, 10000),
      sum('selected', 5000),
    ])

    expect(made.countedMinor).toBe(65000)
    expect(made.foreignLeftOut).toBe(false)
  })

  it('leaves purchases in other currencies out of the minimum spend, and says that it has', () => {
    // The last of them was flagged as made with the physical card, and is no more known in the card's own currency.
    const made = breakDown(uobEvol, [sum('online', 30000), sum('fx', 500, 'USD'), sum('other', 9900, 'JPY')])

    expect(made.countedMinor).toBe(30000)
    expect(made.foreignLeftOut).toBe(true)
  })

  it('totals a currency once, however many categories it was spent in', () => {
    expect(perCurrency([sum('online', 100), sum('fx', 500, 'USD'), sum(null, 20), sum('fx', 7, 'USD')])).toEqual([
      { currency: 'SGD', amountMinor: 120 },
      { currency: 'USD', amountMinor: 507 },
    ])
    expect(perCurrency([])).toEqual([])
  })
})

describe('what comes after the tables of a window', () => {
  it('is how far the spend is towards the minimum, and whose terms the limits are from', () => {
    const sums = [sum('online', 12000), sum(null, 4550), sum('selected', 1598), sum('other', 800)]

    expect(breakdownLines(uobEvol, breakDown(uobEvol, sums))).toEqual([
      'Minimum spend: SGD 189.48 of SGD 800.00',
      TERMS,
    ])
  })

  it('counts what was spent past a limit too, and says when other currencies are left out of the minimum', () => {
    const sums = [sum('online', 35000), sum(null, 1240), sum('fx', 500, 'USD'), sum('fx', 120000, 'JPY')]

    expect(breakdownLines(uobEvol, breakDown(uobEvol, sums))).toEqual([
      'Minimum spend: SGD 362.40 of SGD 800.00, not counting purchases in other currencies',
      TERMS,
    ])
  })

  it('counts what is not sorted towards the minimum too, on a product with no default category', () => {
    const sums = [sum('online', 35000), sum(null, 1240)]

    expect(breakdownLines(NO_DEFAULT, breakDown(NO_DEFAULT, sums))).toEqual([
      'Minimum spend: SGD 362.40 of SGD 800.00',
      TERMS,
    ])
  })
})
