import { describe, expect, it } from 'vitest'
import {
  categoriesOf,
  categoryName,
  categoryOf,
  productOf,
  products,
  productTerms,
  ruledByCode,
  rulesFor,
  startingCategory,
} from '../src/catalogue'
import { dbsWomansWorld } from '../src/catalogue/dbs-womans-world'
import { hsbcRevolution } from '../src/catalogue/hsbc-revolution'
import { codeOf } from '../src/catalogue/merchants'
import { ocbcRewards } from '../src/catalogue/ocbc-rewards'
import type { Product } from '../src/catalogue/types'
import { uobEvol } from '../src/catalogue/uob-evol'
import { sortEnd } from '../src/telegram/purchases'

/** The category that the product's rules give a purchase in the product's own currency. */
function at(merchant: string | null, product: Product = uobEvol): string | null {
  return startingCategory(product, { currency: product.homeCurrency, merchant })
}

describe('the catalogue', () => {
  it('holds the products that a card can be linked to, each found by its key', () => {
    const keys = ['uob-evol', 'hsbc-revolution', 'ocbc-rewards', 'dbs-womans-world']
    expect(products.map((product) => product.key)).toEqual(keys)
    expect(productOf('uob-evol')).toBe(uobEvol)
    expect(productOf('UOB-EVOL')).toBeUndefined()
    expect(productOf('none')).toBeUndefined()
    // A card that is linked to no product has no key to look up.
    expect(productOf(undefined)).toBeUndefined()
  })

  it.each(products)('gives $key keys that stand for nothing else, and buttons that Telegram takes', (product) => {
    const keys = categoriesOf(product).map((category) => category.key)

    // "none" is what unlinks a card.
    expect(product.key).toMatch(/^[a-z0-9-]{1,30}$/)
    expect(product.key).not.toBe('none')
    expect(new Set(keys).size).toBe(keys.length)
    // The category that a purchase is in by default, when the product has one, is one of its own.
    expect([undefined, ...keys]).toContain(product.defaultCategory)
    // A button sends back the id of a purchase and the key of a category, in 64 bytes at most. Each category has
    // one under a purchase that is in another category.
    const buttons = keys.flatMap((category) => sortEnd(product, { id: 999_999_999_999_999, category }).buttons.flat())
    expect(new Set(buttons.map((button) => button.data)).size).toBe(keys.length)
    for (const button of buttons) {
      expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64)
      expect(button.data).toMatch(/^\d{1,15}:[a-z0-9-]{1,40}$/)
    }
  })
})

describe('the UOB EVOL Card', () => {
  it("is as the bank's FAQ of 10 June 2026 has it", () => {
    expect(uobEvol).toMatchObject({
      key: 'uob-evol',
      name: 'UOB EVOL Card',
      homeCurrency: 'SGD',
      termsAsOf: '10 June 2026',
      minimumSpendMinor: 80000,
    })
    // 10% on each of the two groups with a limit: on S$300 and on S$200 of spend, which earn the S$30 and the S$20
    // of cashback that the bank caps them at.
    const groups = uobEvol.groups.map(({ name, limitMinor, categories }) => ({
      name,
      limitMinor,
      keys: categories.map((category) => category.key),
    }))
    expect(groups).toEqual([
      { name: 'Online and Mobile Contactless Spend', limitMinor: 30000, keys: ['online'] },
      { name: 'Selected Gym, Telco and Streaming Spend', limitMinor: 20000, keys: ['selected'] },
      { name: 'Other Spend', limitMinor: undefined, keys: ['other'] },
      { name: 'Overseas Foreign Currency Spend', limitMinor: undefined, keys: ['fx'] },
    ])
  })

  it('takes a purchase to be online unless something says otherwise', () => {
    expect(uobEvol.defaultCategory).toBe('online')
    // Nothing is stored for it, or what is stored is a category of a product that its card was linked to before.
    expect(categoryOf(uobEvol, null)).toBe('online')
    expect(categoryOf(uobEvol, 'dining')).toBe('online')
    // What is stored for it says otherwise.
    for (const key of ['online', 'selected', 'other', 'fx']) expect(categoryOf(uobEvol, key)).toBe(key)
  })

  it('calls a category by what its button calls it', () => {
    const names = ['online', 'selected', 'other', 'fx'].map((key) => categoryName(uobEvol, key))

    expect(names).toEqual([
      'Online / Mobile Contactless Spend',
      'Selected Gym, Telco and Streaming Spend',
      'Other Spend',
      'Overseas Foreign Currency Spend',
    ])
    expect(categoryName(uobEvol, null)).toBeUndefined()
    expect(categoryName(uobEvol, 'dining')).toBeUndefined()
  })

  it('puts a purchase in another currency under foreign currency, whoever the merchant is', () => {
    const foreign = (merchant: string | null) => startingCategory(uobEvol, { currency: 'USD', merchant })

    expect(foreign('BOOK SHOP')).toBe('fx')
    expect(foreign('NETFLIX.COM')).toBe('fx')
    expect(foreign(null)).toBe('fx')
    expect(startingCategory(uobEvol, { currency: 'SGD', merchant: 'BOOK SHOP' })).toBeNull()
  })

  it('puts a purchase at a merchant that it names under gym, telco and streaming, however the name is written', () => {
    const names = [
      'Anytime Fitness',
      'Classpass',
      'Virgin Active',
      'Fitness First',
      'Body Fit Training',
      'True Fitness',
      '247 Fitness',
      'Pure Yoga',
      'True Yoga',
      'Revolution SG',
      'Starhub',
      'Singtel',
      'M1',
      'Gomo',
      'MyRepublic',
      'Giga',
      'CirclesLife',
      'Netflix',
      'Spotify',
      'Disney plus',
    ]

    for (const name of names) {
      expect(at(name)).toBe('selected')
      expect(at(name.toUpperCase())).toBe('selected')
      expect(at(name.toLowerCase())).toBe('selected')
      expect(at(`PAYMENT*${name.toUpperCase()} SINGAPORE SG`)).toBe('selected')
    }
  })

  it('takes the two characters of M1 for the telco only when they are a word of their own', () => {
    for (const merchant of ['M1', 'M1 LIMITED', 'm1 shop', 'PAYMENT*M1', 'BILL-M1-OCT', 'M1.COM.SG']) {
      expect(at(merchant)).toBe('selected')
    }
    for (const merchant of ['M1X STUDIO', 'ROOM1 CAFE', 'FILM100', 'TEAM1 SPORTS', 'M10 ELECTRONICS', 'ATOM1C']) {
      expect(at(merchant)).toBeNull()
    }
  })
})

describe('the HSBC Revolution Credit Card', () => {
  it('starts a purchase at a travel agency that it names in Other Transactions, however the name is written', () => {
    const names = [
      'Trip.com',
      'Agoda',
      'Booking.com',
      'Expedia',
      'Hotels.com',
      'Kayak',
      'Klook',
      'KKday',
      'Pelago',
      'Traveloka',
      'Airbnb',
    ]

    for (const name of names) {
      expect(at(name, hsbcRevolution)).toBe('other')
      expect(at(`PAYMENT*${name.toUpperCase()} SINGAPORE SG`, hsbcRevolution)).toBe('other')
    }
    // With more of the merchant's text to either side of the name.
    for (const merchant of ['TRIP.COM INTERNATIONAL', 'AGODA.COM', 'WWW.HOTELS.COM', 'BOOKING.COM123456']) {
      expect(at(merchant, hsbcRevolution)).toBe('other')
    }
  })

  it('takes no other merchant for a travel agency, though its name holds one of theirs or comes near one', () => {
    const merchants = [
      'ROUND TRIP COMPANY',
      'KAYAKING CLUB',
      'GOLDEN PAGODA CAFE',
      'ARCHIPELAGO BAR',
      'SOMEHOTELS.COM',
      'SOMEBOOKING.COM',
      'COFFEE PLACE',
      null,
    ]

    for (const merchant of merchants) {
      // Nothing is stored for it, which leaves it an Eligible Transaction.
      expect(at(merchant, hsbcRevolution)).toBeNull()
      expect(categoryOf(hsbcRevolution, at(merchant, hsbcRevolution))).toBe('eligible')
    }
  })
})

describe("the DBS Woman's World Card", () => {
  it('takes a purchase to be online when nothing places it, against S$1,000 of the month that it was made in', () => {
    expect(at('COFFEE PLACE', dbsWomansWorld)).toBeNull()
    expect(categoryOf(dbsWomansWorld, null)).toBe('online')
    expect(dbsWomansWorld.groups[0]).toMatchObject({ limitMinor: 100000, categories: [{ key: 'online' }] })
    expect(dbsWomansWorld.daysCountedInNext).toBe(0)
  })
})

describe('the category code of a merchant', () => {
  it('is that of a name that begins at a word of the text, by its letters and digits alone', () => {
    expect(codeOf('KOI THE SG')).toBe(5814)
    // Text before the name, and a blank inside it.
    expect(codeOf('fp*Food Panda')).toBe(5814)
    expect(codeOf('SALAD STOP @ MALL')).toBe(5814)
    // Punctuation counts as the end of a word.
    expect(codeOf('GRAB*A-123')).toBe(4121)
    expect(codeOf('BUS/MRT 4471 SINGAPORE SG')).toBe(4111)
    // A name may end in the middle of a word.
    expect(codeOf('FAIRPRICEXTRA')).toBe(5411)
    // A name does not begin in the middle of a word.
    expect(codeOf('TOKO INDONESIA')).toBeUndefined()
    expect(codeOf('COFFEE PLACE')).toBeUndefined()
  })

  it.each([
    { product: hsbcRevolution, mcc: 2999, category: 'other' },
    { product: hsbcRevolution, mcc: 3000, category: 'eligible' },
    { product: hsbcRevolution, mcc: 3999, category: 'eligible' },
    { product: hsbcRevolution, mcc: 4000, category: 'other' },
    { product: hsbcRevolution, mcc: 4121, category: 'eligible' },
    { product: hsbcRevolution, mcc: 5814, category: 'other' },
    { product: ocbcRewards, mcc: 5651, category: 'shopping' },
    { product: dbsWomansWorld, mcc: 6300, category: 'other' },
    // No category of the product takes a code that it does not list.
    { product: dbsWomansWorld, mcc: 7922, category: undefined },
  ])('puts $mcc in $category on $product.key', ({ product, mcc, category }) => {
    expect(ruledByCode(product, mcc)).toBe(category)
  })

  it.each([
    // A merchant that the terms name is placed by its name, whatever its code.
    { product: ocbcRewards, merchant: 'SHOPEE SINGAPORE', category: 'shopping' },
    { product: ocbcRewards, merchant: 'SHOPEEPAY*WATSONS', category: 'other' },
    { product: ocbcRewards, merchant: 'NTUC FAIRPRICE', category: 'other' },
    { product: ocbcRewards, merchant: 'UNITY BY FAIRPRICE', category: 'shopping' },
    { product: ocbcRewards, merchant: 'TIKTOK*SHOP', category: 'shopping' },
    { product: hsbcRevolution, merchant: 'BUS/MRT 4471 SINGAPORE SG', category: 'other' },
    { product: dbsWomansWorld, merchant: 'YOUTRIP', category: 'other' },
    { product: dbsWomansWorld, merchant: 'SHOPEE PAY', category: 'other' },
    { product: dbsWomansWorld, merchant: 'EZ LINK', category: 'other' },
  ])('starts a purchase at $merchant in $category on $product.key', ({ product, merchant, category }) => {
    expect(at(merchant, product)).toBe(category)
  })
})

describe('where the products count a purchase, by the code or the name of its merchant', () => {
  type Asked = Parameters<typeof rulesFor>[0]

  it.each<[key: string, asked: Asked, mcc: number | null, group: string, cap: string | null, bonus: string]>([
    // A code that the product lists, and one that falls to its category for the codes that it does not list.
    ['hsbc-revolution', { mcc: 5812 }, 5812, 'Eligible Transactions', '1000.00', 'yes'],
    ['ocbc-rewards', { mcc: 5812 }, 5812, 'Other Spend', null, 'no'],
    // The product lists other codes and has no such category, or lists none: the group is where a purchase starts.
    ['dbs-womans-world', { mcc: 5812 }, 5812, 'Online Spend', '1000.00', 'depends'],
    ['uob-evol', { mcc: 5812 }, 5812, 'Online and Mobile Contactless Spend', '300.00', 'depends'],
    // A name that the product lists comes before the merchant's code, which the product does not list.
    ['ocbc-rewards', { merchant: 'SHOPEE SINGAPORE' }, 5262, 'Shopping Spend', '1110.00', 'yes'],
    // A merchant that nothing knows.
    ['ocbc-rewards', { merchant: 'A MADE-UP SHOP' }, null, 'Shopping Spend', '1110.00', 'depends'],
  ])('on %s, has %j, with the code %s, in %s', (key, asked, mcc, group, cap, bonus) => {
    const at = products.findIndex((product) => product.key === key)

    const rules = rulesFor(asked)

    // The code and the products, and nothing of the name that was asked about.
    expect(rules).toEqual({ mcc, products: expect.any(Array) })
    const monthlyCap = cap && { amount: cap, currency: 'SGD' }
    expect(rules.products[at]).toEqual({ product: products[at].name, group, monthlyCap, bonus })
  })
})

describe("what the products' terms set for a month", () => {
  it('has the products in their order, each with its minimum spend and the limit of each of its groups', () => {
    const terms = productTerms()

    expect(terms.map(({ product }) => product)).toEqual(products.map(({ name }) => name))
    const [uob, , , dbs] = terms
    expect(uob.monthlyMinimumSpend).toEqual({ amount: '800.00', currency: 'SGD' })
    expect(dbs).toEqual({
      product: dbsWomansWorld.name,
      termsAsOf: dbsWomansWorld.termsAsOf,
      monthlyMinimumSpend: null,
      groups: [
        { group: 'Online Spend', monthlyCap: { amount: '1000.00', currency: 'SGD' } },
        { group: 'Other Spend', monthlyCap: null },
      ],
    })
  })
})

describe('a product with other rules', () => {
  // Made up, to show that the rules are data: another currency, other groups and limits, no foreign category, and
  // no category that a purchase is in by default.
  const other: Product = {
    key: 'made-up-card',
    name: 'Made-up Card',
    homeCurrency: 'USD',
    termsAsOf: '1 January 2026',
    minimumSpendMinor: 50000,
    groups: [
      { name: 'Dining', limitMinor: 10000, categories: [{ key: 'dining', label: 'dining', automatic: /\bcafe\b/i }] },
      { name: 'Everything else', categories: [{ key: 'rest', label: 'everything else' }] },
    ],
  }

  it('is sorted by its own rules', () => {
    expect(at('CORNER CAFE', other)).toBe('dining')
    expect(at('NETFLIX.COM', other)).toBeNull()
    // With no category for another currency, such a purchase goes by its merchant like any other.
    expect(startingCategory(other, { currency: 'SGD', merchant: 'CORNER CAFE' })).toBe('dining')
    expect(categoryName(other, 'rest')).toBe('everything else')
  })

  it('leaves a purchase that nothing places not sorted, with a button for each of its choices', () => {
    expect(categoryOf(other, at('BOOK SHOP', other))).toBeNull()
    // A category of another product is none of its own.
    expect(categoryOf(other, 'online')).toBeNull()
    expect(categoryOf(other, 'rest')).toBe('rest')
    expect(sortEnd(other, { id: 57, category: null })).toEqual({
      line: 'ID 57: not sorted',
      buttons: [
        [{ text: 'Mark as dining', data: '57:dining' }],
        [{ text: 'Mark as everything else', data: '57:rest' }],
      ],
    })
  })
})
