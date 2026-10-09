import { describe, expect, it } from 'vitest'
import { uobEvol } from '../src/catalogue/uob-evol'
import { breakDown, perCurrency } from '../src/domain/breakdown'
import type { CategoryTotal } from '../src/store'
import { breakdownLines } from '../src/telegram/purchases'

/** What a window's purchases come to, as the store sums them: for a currency and a category at a time. */
function sum(category: string | null, amountMinor: number, currency = 'SGD', count = 1): CategoryTotal {
  return { category, amountMinor, currency, count }
}

describe('what a product makes of a window', () => {
  it('sums each group, with the categories that share a limit summed together', () => {
    const made = breakDown(uobEvol, [
      sum('online', 12000),
      sum('mobile', 4550),
      sum('selected', 1598),
      sum('other', 800),
      sum('fx', 500, 'USD'),
    ])

    expect(made.groups).toEqual([
      { name: 'Online and mobile contactless', spent: [{ currency: 'SGD', amountMinor: 16550 }], limitMinor: 30000 },
      { name: 'Gym, telco and streaming', spent: [{ currency: 'SGD', amountMinor: 1598 }], limitMinor: 20000 },
      { name: 'Other local spend', spent: [{ currency: 'SGD', amountMinor: 800 }], limitMinor: undefined },
      { name: 'Foreign currency', spent: [{ currency: 'USD', amountMinor: 500 }], limitMinor: undefined },
    ])
    expect(made.unsorted).toEqual([])
    expect(made.excluded).toEqual([])
  })

  it('has every group even when nothing was spent in it', () => {
    const made = breakDown(uobEvol, [])

    expect(made.groups.map((group) => [group.name, group.spent])).toEqual([
      ['Online and mobile contactless', []],
      ['Gym, telco and streaming', []],
      ['Other local spend', []],
      ['Foreign currency', []],
    ])
    expect(made).toMatchObject({ unsorted: [], excluded: [], countedMinor: 0, foreignLeftOut: false })
  })

  it('keeps apart what is not sorted, and what the bank pays nothing on', () => {
    const made = breakDown(uobEvol, [
      sum(null, 1240),
      sum(null, 700, 'USD'),
      // A category of a product that the card was linked to before is not one of this product's.
      sum('dining', 360),
      sum('excluded', 5000),
      sum('online', 100),
    ])

    expect(made.unsorted).toEqual([
      { currency: 'SGD', amountMinor: 1600 },
      { currency: 'USD', amountMinor: 700 },
    ])
    expect(made.excluded).toEqual([{ currency: 'SGD', amountMinor: 5000 }])
    expect(made.groups[0].spent).toEqual([{ currency: 'SGD', amountMinor: 100 }])
  })

  it("counts towards the minimum spend what is in the product's currency and is not excluded, sorted or not", () => {
    const made = breakDown(uobEvol, [
      sum('online', 30000),
      sum('other', 20000),
      sum(null, 10000),
      sum('excluded', 99900),
    ])

    expect(made.countedMinor).toBe(60000)
    expect(made.foreignLeftOut).toBe(false)
  })

  it('leaves purchases in other currencies out of the minimum spend, and says that it has', () => {
    const made = breakDown(uobEvol, [sum('online', 30000), sum('fx', 500, 'USD'), sum(null, 9900, 'JPY')])

    expect(made.countedMinor).toBe(30000)
    expect(made.foreignLeftOut).toBe(true)
    // An excluded purchase would not have counted in any currency, so it is not one that was left out.
    expect(breakDown(uobEvol, [sum('excluded', 500, 'USD')]).foreignLeftOut).toBe(false)
  })

  it('totals a currency once, however many categories it was spent in', () => {
    expect(perCurrency([sum('online', 100), sum('fx', 500, 'USD'), sum(null, 20), sum('fx', 7, 'USD')])).toEqual([
      { currency: 'SGD', amountMinor: 120 },
      { currency: 'USD', amountMinor: 507 },
    ])
    expect(perCurrency([])).toEqual([])
  })
})

describe('the table of a window', () => {
  it('has a row for each group with its limit, then the minimum spend and whose terms these are', () => {
    const sums = [sum('online', 12000), sum('mobile', 4550), sum('selected', 1598), sum('other', 800)]

    expect(breakdownLines(uobEvol, breakDown(uobEvol, sums))).toEqual([
      'Online and mobile contactless: SGD 165.50 of SGD 300.00',
      'Gym, telco and streaming: SGD 15.98 of SGD 200.00',
      'Other local spend: SGD 8.00',
      'Foreign currency: SGD 0.00',
      'Minimum spend: SGD 189.48 of SGD 800.00',
      "Limits are from the bank's terms for the UOB EVOL Card, as of 10 June 2026.",
    ])
  })

  it('has rows for what is not sorted and for what does not count, when there is any', () => {
    const sums = [
      sum('online', 35000),
      sum(null, 1240),
      sum('excluded', 5000),
      sum('fx', 500, 'USD'),
      sum('fx', 120000, 'JPY'),
    ]

    expect(breakdownLines(uobEvol, breakDown(uobEvol, sums))).toEqual([
      // Past its limit: what was spent is shown as it is.
      'Online and mobile contactless: SGD 350.00 of SGD 300.00',
      'Gym, telco and streaming: SGD 0.00 of SGD 200.00',
      'Other local spend: SGD 0.00',
      'Foreign currency: USD 5.00 + JPY 1,200.00',
      'Not sorted: SGD 12.40',
      "Doesn't count: SGD 50.00",
      'Minimum spend: SGD 362.40 of SGD 800.00, not counting purchases in other currencies',
      "Limits are from the bank's terms for the UOB EVOL Card, as of 10 June 2026.",
    ])
  })
})
