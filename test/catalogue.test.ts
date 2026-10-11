import { describe, expect, it } from 'vitest'
import {
  categoriesOf,
  categoryName,
  categoryOf,
  choicesOf,
  productOf,
  products,
  ruledByName,
  startingCategory,
} from '../src/catalogue'
import { hsbcRevolution } from '../src/catalogue/hsbc-revolution'
import type { Product } from '../src/catalogue/types'
import { uobEvol } from '../src/catalogue/uob-evol'
import { sortEnd } from '../src/telegram/purchases'

/** Where the bank publishes the terms of the UOB EVOL Card. */
const FAQ =
  'https://www.uob.com.sg/web-resources/personal/pdf/personal/cards/credit-cards/rebates-cards/evol/uob-evol-faq.pdf'

/** The category that the product's rules give a purchase in the product's own currency. */
function at(merchant: string | null, product: Product = uobEvol): string | null {
  return startingCategory(product, { currency: product.homeCurrency, merchant })
}

describe('the catalogue', () => {
  it('holds the products that a card can be linked to, each found by its key', () => {
    expect(products.map((product) => product.key)).toEqual(['uob-evol', 'hsbc-revolution'])
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
    // A button sends back the id of a purchase and the key of a category, in 64 bytes at most. Each choice has one
    // under a purchase that is in another category.
    const buttons = keys.flatMap((category) => sortEnd(product, { id: 999_999_999_999_999, category }).buttons.flat())
    expect(new Set(buttons.map((button) => button.data)).size).toBe(choicesOf(product).length)
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
    expect(uobEvol.termsUrl).toBe(FAQ)
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

  it('has a button for each category that is chosen by hand, and none for those that a rule gives', () => {
    expect(choicesOf(uobEvol).map(({ key, label }) => [key, label])).toEqual([
      ['online', 'Online / Mobile Contactless Spend'],
      ['other', 'Other Spend'],
    ])
  })

  it('calls a category by what its button calls it, or by the name of its group when it has no button', () => {
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

  it.each([
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
  ])('puts a purchase at %s under gym, telco and streaming, however the name is written', (name) => {
    expect(at(name)).toBe('selected')
    expect(at(name.toUpperCase())).toBe('selected')
    expect(at(name.toLowerCase())).toBe('selected')
    expect(at(`PAYMENT*${name.toUpperCase()} SINGAPORE SG`)).toBe('selected')
  })

  it('takes the two characters of M1 for the telco only when they are a word of their own', () => {
    for (const merchant of ['M1', 'M1 LIMITED', 'm1 shop', 'PAYMENT*M1', 'BILL-M1-OCT', 'M1.COM.SG']) {
      expect(at(merchant)).toBe('selected')
    }
    for (const merchant of ['M1X STUDIO', 'ROOM1 CAFE', 'FILM100', 'TEAM1 SPORTS', 'M10 ELECTRONICS', 'ATOM1C']) {
      expect(at(merchant)).toBeNull()
    }
  })

  it('stores nothing for a purchase that no rule settles, which leaves it online', () => {
    for (const merchant of ['COFFEE PLACE', 'BOOK SHOP SINGAPORE', null]) {
      expect(at(merchant)).toBeNull()
      expect(categoryOf(uobEvol, at(merchant))).toBe('online')
    }
  })

  it('tells which merchants a rule places, by the text of their names', () => {
    expect(ruledByName(uobEvol, 'NETFLIX.COM')).toBe('selected')
    expect(ruledByName(uobEvol, 'payment*singtel sg')).toBe('selected')
    expect(ruledByName(uobEvol, 'COFFEE PLACE')).toBeUndefined()
    // A rule for another currency places a purchase, and no merchant.
    expect(ruledByName(uobEvol, 'AIRLINE')).toBeUndefined()
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

describe('a product with other rules', () => {
  // Made up, to show that the rules are data: another currency, other groups and limits, no foreign category, and
  // no category that a purchase is in by default.
  const other: Product = {
    key: 'made-up-card',
    name: 'Made-up Card',
    homeCurrency: 'USD',
    termsUrl: 'https://bank.example.test/terms',
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
    expect(choicesOf(other).map((choice) => choice.key)).toEqual(['dining', 'rest'])
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
