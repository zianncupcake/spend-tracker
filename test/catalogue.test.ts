import { describe, expect, it } from 'vitest'
import { categoriesOf, categoryName, choicesOf, productOf, products, startingCategory } from '../src/catalogue'
import type { Product } from '../src/catalogue/types'
import { uobEvol } from '../src/catalogue/uob-evol'
import { sortEnd } from '../src/telegram/purchases'

/** Where the bank publishes the terms of the UOB EVOL Card. */
const FAQ =
  'https://www.uob.com.sg/web-resources/personal/pdf/personal/cards/credit-cards/rebates-cards/evol/uob-evol-faq.pdf'

/** The category that the product's rules give a purchase in the product's own currency, with nothing remembered. */
function at(merchant: string | null, product: Product = uobEvol): string | null {
  return startingCategory(product, { currency: product.homeCurrency, merchant }, null)
}

describe('the catalogue', () => {
  it('holds the products that a card can be linked to, each found by its key', () => {
    expect(products.map((product) => product.key)).toEqual(['uob-evol'])
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
    // A button sends back the id of a purchase and the key of a category, in 64 bytes at most.
    const { buttons = [] } = sortEnd(product, { id: 999_999_999_999_999, category: null }, true, true)
    expect(buttons.flat()).toHaveLength(choicesOf(product).length)
    for (const button of buttons.flat()) {
      expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64)
      expect(button.data).toMatch(/^\d{1,15}:[a-z0-9-]{1,40}:next$/)
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
      { name: 'Online and mobile contactless', limitMinor: 30000, keys: ['online', 'mobile'] },
      { name: 'Gym, telco and streaming', limitMinor: 20000, keys: ['selected'] },
      { name: 'Other local spend', limitMinor: undefined, keys: ['other'] },
      { name: 'Foreign currency', limitMinor: undefined, keys: ['fx'] },
    ])
    expect(uobEvol.excluded.key).toBe('excluded')
  })

  it('has a button for each category that is chosen by hand, and none for those that a rule gives', () => {
    expect(choicesOf(uobEvol).map(({ key, label }) => [key, label])).toEqual([
      ['online', 'Online'],
      ['mobile', 'Phone tap'],
      ['other', 'Physical card or other'],
      ['excluded', "Doesn't count"],
    ])
  })

  it('calls a category by the words on its button, or by the name of its group when it has no button', () => {
    const names = ['online', 'mobile', 'selected', 'other', 'fx', 'excluded'].map((key) => categoryName(uobEvol, key))

    expect(names).toEqual([
      'Online',
      'Phone tap',
      'Gym, telco and streaming',
      'Physical card or other',
      'Foreign currency',
      "Doesn't count",
    ])
    expect(categoryName(uobEvol, null)).toBeUndefined()
    expect(categoryName(uobEvol, 'dining')).toBeUndefined()
  })

  it('puts a purchase in another currency under foreign currency, whoever the merchant is', () => {
    const foreign = (merchant: string | null) => startingCategory(uobEvol, { currency: 'USD', merchant }, null)

    expect(foreign('BOOK SHOP')).toBe('fx')
    expect(foreign('NETFLIX.COM')).toBe('fx')
    expect(foreign(null)).toBe('fx')
    expect(startingCategory(uobEvol, { currency: 'SGD', merchant: 'BOOK SHOP' }, null)).toBeNull()
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

  it('leaves a purchase that no rule settles for its user to sort', () => {
    expect(at('COFFEE PLACE')).toBeNull()
    expect(at('BOOK SHOP SINGAPORE')).toBeNull()
    expect(at(null)).toBeNull()
  })

  it('starts a purchase where its user put the last one at the merchant, whatever names the product lists', () => {
    const local = { currency: 'SGD', merchant: 'GIGA PIZZA' }

    expect(startingCategory(uobEvol, local, null)).toBe('selected')
    expect(startingCategory(uobEvol, local, 'other')).toBe('other')
    expect(startingCategory(uobEvol, { currency: 'SGD', merchant: 'COFFEE PLACE' }, 'mobile')).toBe('mobile')
    expect(startingCategory(uobEvol, { currency: 'SGD', merchant: 'COFFEE PLACE' }, 'excluded')).toBe('excluded')
  })

  it('goes by the currency before what was remembered, as the purchase remembered may have been a local one', () => {
    expect(startingCategory(uobEvol, { currency: 'USD', merchant: 'COFFEE PLACE' }, 'online')).toBe('fx')
  })

  it('makes nothing of a remembered category that is not one of its buttons', () => {
    const local = { currency: 'SGD', merchant: 'COFFEE PLACE' }

    // One that only a rule gives, and one that the product does not have.
    expect(startingCategory(uobEvol, local, 'fx')).toBeNull()
    expect(startingCategory(uobEvol, local, 'dining')).toBeNull()
    expect(startingCategory(uobEvol, { currency: 'SGD', merchant: 'NETFLIX.COM' }, 'dining')).toBe('selected')
  })
})

describe('a product with other rules', () => {
  // Made up, to show that the rules are data: another currency, other groups and limits, and no foreign category.
  const other: Product = {
    key: 'made-up-card',
    name: 'Made-up Card',
    homeCurrency: 'USD',
    termsUrl: 'https://bank.example.test/terms',
    termsAsOf: '1 January 2026',
    minimumSpendMinor: 50000,
    groups: [
      { name: 'Dining', limitMinor: 10000, categories: [{ key: 'dining', label: 'Dining', automatic: /\bcafe\b/i }] },
      { name: 'Everything else', categories: [{ key: 'rest', label: 'Everything else' }] },
    ],
    excluded: { key: 'nothing', label: 'Earns nothing' },
  }

  it('is sorted by its own rules', () => {
    expect(at('CORNER CAFE', other)).toBe('dining')
    expect(at('NETFLIX.COM', other)).toBeNull()
    // With no category for another currency, such a purchase goes by its merchant like any other.
    expect(startingCategory(other, { currency: 'SGD', merchant: 'CORNER CAFE' }, null)).toBe('dining')
    expect(startingCategory(other, { currency: 'SGD', merchant: 'BOOK SHOP' }, 'rest')).toBe('rest')
    expect(choicesOf(other).map((choice) => choice.key)).toEqual(['dining', 'rest', 'nothing'])
    expect(categoryName(other, 'nothing')).toBe('Earns nothing')
  })
})
