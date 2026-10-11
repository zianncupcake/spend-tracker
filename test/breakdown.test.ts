import { describe, expect, it } from 'vitest'
import { hsbcRevolution } from '../src/catalogue/hsbc-revolution'
import type { Product } from '../src/catalogue/types'
import { uobEvol } from '../src/catalogue/uob-evol'
import { breakDown, perCurrency } from '../src/domain/breakdown'
import type { CategoryTotal } from '../src/store'
import { breakdownLines } from '../src/telegram/purchases'

const TERMS = "Limits are from the bank's terms for the UOB EVOL Card, as of 10 June 2026."

/** The same of the HSBC Revolution Credit Card. It has no minimum spend, so this is the one line that it always has. */
const HSBC_TERMS = "Limits are from the bank's terms for the HSBC Revolution Credit Card, as of 1 April 2026."

/** The line that says of what a group with a limit holds in other currencies that it is not taken off the limit. */
function notTakenOff(amounts: string): string {
  return (
    `A table has a Total for each currency. A Cap counts SGD only, so ${amounts} is not taken off what is Left: ` +
    'an alert does not say what a purchase in another currency comes to in SGD.'
  )
}

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

    // The purchases in other currencies are where the product's rule puts them, in a group with no limit. So these
    // two lines are all: nothing is said of a limit that they were not taken off.
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

  it('says of a purchase in another currency that it is not taken off a limit, in a group that has one', () => {
    // On the HSBC Revolution Credit Card a purchase is in the group with the limit, whatever its currency.
    const sums = [sum('eligible', 100), sum('eligible', 100, 'USD')]

    expect(breakdownLines(hsbcRevolution, breakDown(hsbcRevolution, sums))).toEqual([
      notTakenOff('USD 1.00'),
      HSBC_TERMS,
    ])
  })

  it('names a total for each of the other currencies, joined as the total of a card joins them', () => {
    // Two sums of one currency are one total. Nothing is stored for the first, which is eligible all the same.
    const sums = [sum(null, 40, 'USD'), sum('eligible', 200, 'EUR'), sum('eligible', 60, 'USD'), sum('eligible', 100)]

    expect(breakdownLines(hsbcRevolution, breakDown(hsbcRevolution, sums))).toEqual([
      notTakenOff('USD 1.00 + EUR 2.00'),
      HSBC_TERMS,
    ])
  })

  it('names one total for a currency that more than one group with a limit holds, under the minimum spend', () => {
    // The UOB EVOL Card has two groups with a limit, and a minimum spend. The third sum is in a group without one.
    const sums = [sum('online', 100, 'USD'), sum('selected', 250, 'USD'), sum('fx', 700, 'USD')]

    expect(breakdownLines(uobEvol, breakDown(uobEvol, sums))).toEqual([
      'Minimum spend: SGD 0.00 of SGD 800.00, not counting purchases in other currencies',
      notTakenOff('USD 3.50'),
      TERMS,
    ])
  })

  it('says nothing of other currencies that only a group without a limit holds, or that there are none of', () => {
    const lines = (sums: CategoryTotal[]) => breakdownLines(hsbcRevolution, breakDown(hsbcRevolution, sums))

    expect(lines([sum('eligible', 100), sum('other', 100, 'USD')])).toEqual([HSBC_TERMS])
    expect(lines([sum('eligible', 100), sum('other', 100)])).toEqual([HSBC_TERMS])
    expect(lines([])).toEqual([HSBC_TERMS])
  })
})
