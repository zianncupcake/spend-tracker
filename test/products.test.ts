import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { spendingSummary } from '../src/mcp/tools'
import { storeFor } from '../src/store'
import { TelegramError } from '../src/telegram/api'
import { BY_HAND_NOTE } from '../src/telegram/purchases'
import { NO_CARDS, PRODUCT_USAGE } from '../src/telegram/texts'
import { clock, deps, NOW, openChat } from './connect-helpers'
import {
  BY_PURCHASE_DAY,
  buy,
  CARDS_HEADER,
  ESTIMATED,
  inCatalogue,
  linesOf,
  plain,
  SPEND_HEADER,
  tableOf,
  userCount,
} from './helpers'
import { record } from './mcp-helpers'

// Linking a card to a product of the catalogue. The clock stands at 12:00 on 9 October 2026 in Singapore.

const LINKED = 'Linked evol ••••1234 to UOB EVOL Card. For how its purchases are sorted, send /sort evol.'

/** The categories of a user's purchases, by their merchants. It reads the table directly, to see what is stored. */
async function categoriesOf(userId: number): Promise<Record<string, string | null>> {
  const { results } = await env.DB.prepare('SELECT merchant, category FROM transactions WHERE owner_id = ? ORDER BY id')
    .bind(userId)
    .all<{ merchant: string; category: string | null }>()
  return Object.fromEntries(results.map(({ merchant, category }) => [merchant, category]))
}

describe('/products', () => {
  const KNOWN = 'The card products whose reward rules are known:'
  const HOW = 'To link a card to one, send /product <nickname> <product key>. Or add the key to the end of /addcard.'

  it('lists the products in a table of their keys and their names, says how to link a card to one, and stores nothing', async () => {
    const chat = openChat()

    // As Telegram is posted it: this is all of the `rich_message`, and no text is sent with it.
    expect(await chat.rich('/products')).toEqual({
      skip_entity_detection: true,
      blocks: [
        plain(KNOWN),
        tableOf(
          [
            { text: 'Key', is_header: true },
            { text: 'Product', is_header: true },
          ],
          [{ text: 'uob-evol' }, { text: 'UOB EVOL Card' }],
          [{ text: 'hsbc-revolution' }, { text: 'HSBC Revolution Credit Card' }],
          [{ text: 'ocbc-rewards' }, { text: 'OCBC Rewards Card' }],
          [{ text: 'dbs-womans-world' }, { text: "DBS Woman's World Card" }],
        ),
        plain(HOW),
      ],
    })
    expect(await userCount(chat.telegramId)).toBe(0)
  })

  it('is a line for each product, as it was before it was a table, when Telegram does not take the table', async () => {
    vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new TelegramError('sendRichMessage', 400))

    expect(await openChat().say('/products')).toBe(
      [
        KNOWN,
        'uob-evol - UOB EVOL Card',
        'hsbc-revolution - HSBC Revolution Credit Card',
        'ocbc-rewards - OCBC Rewards Card',
        "dbs-womans-world - DBS Woman's World Card",
        '',
        HOW,
      ].join('\n'),
    )
  })
})

describe('/product', () => {
  it('links a card to a product, which /cards then names, and unlinks it again', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 statement 5')
    await chat.say('/addcard amex 0005 calendar')
    const store = storeFor(env.DB, await chat.userId())

    expect(await chat.say('/product evol uob-evol')).toBe(LINKED)

    expect(await chat.lines('/cards')).toEqual([
      CARDS_HEADER,
      'evol | ••••1234 | statement closes on the 5th of the month | UOB EVOL Card',
      'amex | ••••0005 | calendar month | -',
    ])
    expect(await store.listCards()).toEqual([
      { nickname: 'evol', last4: '1234', windowType: 'statement', statementDay: 5, product: 'uob-evol' },
      { nickname: 'amex', last4: '0005', windowType: 'calendar' },
    ])

    expect(await chat.say('/product evol none')).toBe('evol ••••1234 is linked to no product now.')

    expect(await chat.lines('/cards')).toEqual([
      CARDS_HEADER,
      'evol | ••••1234 | statement closes on the 5th of the month | -',
      'amex | ••••0005 | calendar month | -',
    ])
    expect((await store.listCards())[0]).toEqual({
      nickname: 'evol',
      last4: '1234',
      windowType: 'statement',
      statementDay: 5,
    })
  })

  it('takes the key of a product, and the word that unlinks, in any case', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar')

    expect(await chat.say('/product evol UOB-Evol')).toBe(LINKED)
    expect(await chat.say('/product evol NONE')).toBe('evol ••••1234 is linked to no product now.')
  })

  it.each([
    ['/product', PRODUCT_USAGE],
    ['/product evol uob-evol now', PRODUCT_USAGE],
    ['/product my!card uob-evol', PRODUCT_USAGE],
    ['/product evol uob/evol', PRODUCT_USAGE],
    ['/product evol visa-infinite', 'There is no product called visa-infinite. Send /products for the ones there are.'],
    ['/product spare uob-evol', 'You have no card called spare.'],
  ])('answers "%s" with what is wrong, and links nothing', async (message, reply) => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar')

    expect(await chat.say(message)).toBe(reply)

    expect(await chat.lines('/cards')).toEqual([CARDS_HEADER, 'evol | ••••1234 | calendar month | -'])
  })

  it("links a user's own card, and not the card that another user calls the same", async () => {
    const [chat, bystander] = [openChat(), openChat()]
    for (const each of [chat, bystander]) await each.say('/addcard evol 1234 calendar')

    await chat.say('/product evol uob-evol')

    expect(await chat.lines('/cards')).toEqual([CARDS_HEADER, 'evol | ••••1234 | calendar month | UOB EVOL Card'])
    expect(await bystander.lines('/cards')).toEqual([CARDS_HEADER, 'evol | ••••1234 | calendar month | -'])
  })

  it("sorts the purchases of the card's current window that the product's rules settle, and no others", async () => {
    const [chat, bystander] = [openChat(), openChat()]
    // October, which counts the purchases made from 29 September on.
    for (const each of [chat, bystander]) await each.say('/addcard evol 1234 calendar')
    await chat.say('/addcard amex 0005 calendar')
    const userId = await chat.userId()
    await record(userId, [
      ['2026-09-28T23:00:00+08:00', 1598, 'SGD', '1234', 'NETFLIX.COM LAST MONTH'],
      ['2026-09-30T23:00:00+08:00', 1598, 'SGD', '1234', 'NETFLIX.COM ON THE LAST DAY'],
      ['2026-10-02T10:00:00+08:00', 1598, 'SGD', '1234', 'NETFLIX.COM'],
      ['2026-10-03T10:00:00+08:00', 500, 'USD', '1234', 'AIRLINE'],
      ['2026-10-04T10:00:00+08:00', 1240, 'SGD', '1234', 'COFFEE PLACE'],
      ['2026-10-05T10:00:00+08:00', 4500, 'SGD', '1234', 'SINGTEL MOBILE'],
      ['2026-10-06T10:00:00+08:00', 1598, 'SGD', '0005', 'SPOTIFY ON ANOTHER CARD'],
    ])
    // One that its user has sorted already stays where it was put, whatever a rule would make of it.
    await storeFor(env.DB, userId).insertTransaction({
      sourceId: 'sorted-by-hand',
      cardLast4: '1234',
      amountMinor: 900,
      currency: 'USD',
      merchant: 'SORTED BY HAND',
      occurredAt: Date.parse('2026-10-07T10:00:00+08:00') / 1000,
      parser: 'example-bank',
      category: 'other',
    })
    await record(await bystander.userId(), [['2026-10-02T10:00:00+08:00', 1598, 'SGD', '1234', 'NETFLIX.COM']])

    expect(await chat.say('/product evol uob-evol')).toBe(LINKED)

    // Nothing is stored for the purchase that no rule settles. It is online, as the product takes a purchase to be.
    expect(await categoriesOf(userId)).toEqual({
      'NETFLIX.COM LAST MONTH': null,
      'NETFLIX.COM ON THE LAST DAY': 'selected',
      'NETFLIX.COM': 'selected',
      AIRLINE: 'fx',
      'COFFEE PLACE': null,
      'SINGTEL MOBILE': 'selected',
      'SPOTIFY ON ANOTHER CARD': null,
      'SORTED BY HAND': 'other',
    })
    expect(await categoriesOf(await bystander.userId())).toEqual({ 'NETFLIX.COM': null })
  })
})

describe('/addcard with the key of a product', () => {
  it('adds the card linked to the product, with either kind of window', async () => {
    const chat = openChat()

    expect(await chat.say('/addcard evol 1234 statement 5 uob-evol')).toBe(
      'Added evol ••••1234: statement closes on the 5th of the month, UOB EVOL Card.',
    )
    expect(await chat.say('/addcard spare 9999 calendar UOB-EVOL')).toBe(
      'Added spare ••••9999: calendar month, UOB EVOL Card.',
    )

    expect(await storeFor(env.DB, await chat.userId()).listCards()).toEqual([
      { nickname: 'evol', last4: '1234', windowType: 'statement', statementDay: 5, product: 'uob-evol' },
      { nickname: 'spare', last4: '9999', windowType: 'calendar', product: 'uob-evol' },
    ])
  })

  it('adds nothing when there is no such product', async () => {
    const chat = openChat()

    expect(await chat.say('/addcard evol 1234 statement 5 visa-infinite')).toBe(
      'There is no product called visa-infinite. Send /products for the ones there are.',
    )

    expect(await chat.say('/cards')).toBe(NO_CARDS)
  })

  it('sorts the purchases that were stored for the card before it was added', async () => {
    const chat = openChat()
    const userId = await chat.userId()
    await record(userId, [
      ['2026-10-02T10:00:00+08:00', 1598, 'SGD', '1234', 'SPOTIFY'],
      ['2026-10-03T10:00:00+08:00', 500, 'JPY', '1234', 'RAMEN'],
      ['2026-10-04T10:00:00+08:00', 1240, 'SGD', '1234', 'COFFEE PLACE'],
    ])

    await chat.say('/addcard evol 1234 calendar uob-evol')

    expect(await categoriesOf(userId)).toEqual({ SPOTIFY: 'selected', RAMEN: 'fx', 'COFFEE PLACE': null })
  })
})

describe('a card that is linked to the HSBC Revolution Credit Card', () => {
  /** What the terms of the product call its two groups. A purchase is in the first until it is marked otherwise. */
  const ELIGIBLE = 'Eligible Transactions'
  const OTHER = 'Other Transactions'

  it('has a table for each of its two groups, the limit of the first, and no line of a minimum spend', async () => {
    const chat = openChat()
    expect(await chat.say('/addcard hsbc 1234 calendar hsbc-revolution')).toBe(
      'Added hsbc ••••1234: calendar month, HSBC Revolution Credit Card.',
    )
    const id = await buy(await chat.userId())

    expect(linesOf(await chat.rich('/spend hsbc'))).toEqual([
      'hsbc ••••1234: 1 Oct to 31 Oct',
      ELIGIBLE,
      'ID | Date | SGD | Merchant',
      `${id} | 5 Oct | 12.40 | COFFEE PLACE`,
      'Total | 12.40',
      'Cap | 1,000.00',
      'Left | 987.60',
      OTHER,
      'Total | 0.00',
      'Total: SGD 12.40 in 1 purchase, resets 1 Nov',
      'The total counts purchases made from 29 Sep to 29 Oct. The bank counts a purchase by the day it is posted, ' +
        'so one made in the last 2 days of a month is counted in the next month.',
      // The terms of the product set no minimum spend, so no line tells of one.
      "Limits are from the bank's terms for the HSBC Revolution Credit Card, as of 1 April 2026.",
    ])

    // The UOB EVOL Card has a minimum spend, and its line as before.
    await chat.say('/addcard evol 5678 calendar uob-evol')
    expect(linesOf(await chat.rich('/spend evol')).slice(-2)).toEqual([
      'Minimum spend: SGD 0.00 of SGD 800.00',
      "Limits are from the bank's terms for the UOB EVOL Card, as of 10 June 2026.",
    ])
  })

  it('takes a purchase for an Eligible Transaction until its user marks it as one of the others', async () => {
    const chat = openChat()
    await chat.say('/addcard hsbc 1234 calendar hsbc-revolution')
    const userId = await chat.userId()
    const id = await buy(userId)

    expect(await chat.say('/sort hsbc')).toBe(
      'Every purchase on hsbc ••••1234 counts as Eligible Transactions unless it is marked otherwise. ' +
        'Eligible Transactions are online and contactless purchases in travel, department and retail stores, ' +
        'dining, taxis and membership clubs. Anything else is Other Transactions. ' +
        'A travel agency such as Trip.com, Agoda or Klook is not travel to the bank, so a purchase there starts in ' +
        'Other Transactions. A purchase at a merchant whose category code the bot knows starts where that code ' +
        'puts it. To mark one, send /sort <purchase id>. /spend hsbc shows the ids.',
    )
    const [message] = await chat.ask(`/sort ${id}`)
    expect(message.text).toBe(`ID ${id} · 5 Oct · SGD 12.40 · COFFEE PLACE\nID ${id}: ${ELIGIBLE}`)
    expect(message.buttons).toEqual([[{ text: `Mark as ${OTHER}`, data: `${id}:other` }]])
    // Nothing is stored for it: it is where the product takes a purchase to be.
    expect(await categoriesOf(userId)).toEqual({ 'COFFEE PLACE': null })

    expect((await chat.press(message, `Mark as ${OTHER}`)).answer).toBe(`ID ${id}: ${OTHER}`)

    expect(await categoriesOf(userId)).toEqual({ 'COFFEE PLACE': 'other' })
    expect(message.buttons).toEqual([[{ text: `Mark as ${ELIGIBLE}`, data: `${id}:eligible` }]])
    // It is in the table of the others now, and nothing is held against the limit.
    expect(linesOf(await chat.rich('/spend hsbc')).slice(1, 9)).toEqual([
      ELIGIBLE,
      'Total | 0.00',
      'Cap | 1,000.00',
      'Left | 1,000.00',
      OTHER,
      'ID | Date | SGD | Merchant',
      `${id} | 5 Oct | 12.40 | COFFEE PLACE`,
      'Total | 12.40',
    ])
  })

  it('starts a purchase at a travel agency in Other Transactions, where its user can mark it as eligible', async () => {
    const chat = openChat()
    await chat.say('/addcard hsbc 1234 calendar hsbc-revolution')
    const userId = await chat.userId()
    const labels = (message: { buttons?: { text: string }[][] }) => message.buttons?.flat().map((button) => button.text)

    const [agency] = await chat.ask('/add hsbc 250 Trip.com')
    const [cafe] = await chat.ask('/add hsbc 4.50 COFFEE PLACE')

    // The rule stores where the first one is. Nothing is stored for the second, as at any other merchant.
    expect(await categoriesOf(userId)).toEqual({ 'Trip.com': 'other', 'COFFEE PLACE': null })
    expect(agency.text).toMatch(/\nID \d+: Other Transactions$/)
    expect(labels(agency)).toEqual([`Mark as ${ELIGIBLE}`])
    expect(cafe.text).toMatch(/\nID \d+: Eligible Transactions$/)
    expect(labels(cafe)).toEqual([`Mark as ${OTHER}`])

    // The code is the merchant's bank's to set, so its user can say that this purchase was one after all.
    expect((await chat.press(agency, `Mark as ${ELIGIBLE}`)).answer).toMatch(/^ID \d+: Eligible Transactions$/)

    expect(await categoriesOf(userId)).toEqual({ 'Trip.com': 'eligible', 'COFFEE PLACE': null })
    expect(labels(agency)).toEqual([`Mark as ${OTHER}`])
  })

  it('says under its tables why a purchase in another currency is not taken off what is left', async () => {
    const chat = openChat()
    await chat.say('/addcard hsbc 1234 calendar hsbc-revolution')
    /** The id of the purchase that a line of /add stores, which its reply begins with. */
    const added = async (line: string) => /^ID (\d+) /.exec((await chat.ask(line))[0].text)?.[1]
    const shop = await added('/add hsbc USD 1.00 SOME SHOP')
    const coffee = await added('/add hsbc 1.00 COFFEE PLACE')

    expect(linesOf(await chat.rich('/spend hsbc'))).toEqual([
      'hsbc ••••1234: 1 Oct to 31 Oct',
      ELIGIBLE,
      // The table holds two currencies, so each amount has its code, and each currency a Total. The limit is held
      // against the one in the card's own.
      'ID | Date | Amount | Merchant',
      `${shop}* | 9 Oct | USD 1.00 | SOME SHOP`,
      `${coffee}* | 9 Oct | SGD 1.00 | COFFEE PLACE`,
      'Total | SGD 1.00',
      'Total | USD 1.00',
      'Cap | SGD 1,000.00',
      'Left | SGD 999.00',
      OTHER,
      'Total | 0.00',
      BY_HAND_NOTE,
      'Total: SGD 1.00 + USD 1.00 in 2 purchases, resets 1 Nov',
      expect.stringMatching(/^The total counts purchases made from 29 Sep to 29 Oct\./),
      'A table has a Total for each currency. A Cap counts SGD only, so USD 1.00 is not taken off what is Left: ' +
        'an alert does not say what a purchase in another currency comes to in SGD.',
      "Limits are from the bank's terms for the HSBC Revolution Credit Card, as of 1 April 2026.",
    ])
  })
})

describe('a card that is linked to the OCBC Rewards Card', () => {
  /** The two groups of the product. A purchase is in the first until it is marked otherwise. */
  const SHOPPING = 'Shopping Spend'
  const OTHER = 'Other Spend'

  const labels = (message: { buttons?: { text: string }[][] }) => message.buttons?.flat().map((button) => button.text)

  it('has a table for each of its two groups, the limit of the first, and no line of a minimum spend', async () => {
    const chat = openChat()
    expect(await chat.say('/addcard ocbc 1234 calendar ocbc-rewards')).toBe(
      'Added ocbc ••••1234: calendar month, OCBC Rewards Card.',
    )
    const id = await buy(await chat.userId())

    expect(linesOf(await chat.rich('/spend ocbc'))).toEqual([
      'ocbc ••••1234: 1 Oct to 31 Oct',
      SHOPPING,
      'ID | Date | SGD | Merchant',
      `${id} | 5 Oct | 12.40 | COFFEE PLACE`,
      'Total | 12.40',
      'Cap | 1,110.00',
      'Left | 1,097.60',
      OTHER,
      'Total | 0.00',
      'Total: SGD 12.40 in 1 purchase, resets 1 Nov',
      'The total counts purchases made from 29 Sep to 29 Oct. The bank counts a purchase by the day it is posted, ' +
        'so one made in the last 2 days of a month is counted in the next month.',
      // The terms of the product set no minimum spend, so no line tells of one.
      "Limits are from the bank's terms for the OCBC Rewards Card, as of 5 October 2026.",
    ])
  })

  it('takes a purchase for Shopping Spend until its user marks it as Other Spend', async () => {
    const chat = openChat()
    await chat.say('/addcard ocbc 1234 calendar ocbc-rewards')
    const userId = await chat.userId()
    const id = await buy(userId)

    expect(await chat.say('/sort ocbc')).toBe(
      'Every purchase on ocbc ••••1234 counts as Shopping Spend unless it is marked otherwise. ' +
        'Shopping Spend is spend at department, clothing, shoe, bag, sports and duty-free shops, and at Shopee, ' +
        'Lazada, Taobao, TikTok Shop, Amazon, AliExpress, Alibaba, Ezbuy, Watsons, Guardian, Mustafa Centre and ' +
        'NTUC Unity. Anything else is Other Spend, and so are groceries and Shopee Pay. ' +
        'A purchase at a merchant whose category code the bot knows starts where that code puts it. ' +
        'To mark one, send /sort <purchase id>. /spend ocbc shows the ids.',
    )
    const [message] = await chat.ask(`/sort ${id}`)
    expect(message.text).toBe(`ID ${id} · 5 Oct · SGD 12.40 · COFFEE PLACE\nID ${id}: ${SHOPPING}`)
    expect(labels(message)).toEqual([`Mark as ${OTHER}`])
    // Nothing is stored for it: it is where the product takes a purchase to be.
    expect(await categoriesOf(userId)).toEqual({ 'COFFEE PLACE': null })

    expect((await chat.press(message, `Mark as ${OTHER}`)).answer).toBe(`ID ${id}: ${OTHER}`)

    expect(await categoriesOf(userId)).toEqual({ 'COFFEE PLACE': 'other' })
    expect(labels(message)).toEqual([`Mark as ${SHOPPING}`])
    // It is in the table of the other spend now, and nothing is held against the limit.
    expect(linesOf(await chat.rich('/spend ocbc')).slice(1, 9)).toEqual([
      SHOPPING,
      'Total | 0.00',
      'Cap | 1,110.00',
      'Left | 1,110.00',
      OTHER,
      'ID | Date | SGD | Merchant',
      `${id} | 5 Oct | 12.40 | COFFEE PLACE`,
      'Total | 12.40',
    ])
  })

  it('starts a purchase described as Shopee Pay in Other Spend, and one at Shopee in Shopping Spend', async () => {
    const chat = openChat()
    await chat.say('/addcard ocbc 1234 calendar ocbc-rewards')
    const userId = await chat.userId()

    const wallet = []
    for (const merchant of ['SHOPEE PAY', 'ShopeePay', 'SHOPEEPAY SG']) {
      const [reply] = await chat.ask(`/add ocbc 10 ${merchant}`)
      // The terms name that description as earning nothing. Its user can say that the purchase earned all the same.
      expect(reply.text).toMatch(/\nID \d+: Other Spend$/)
      expect(labels(reply)).toEqual([`Mark as ${SHOPPING}`])
      wallet.push(reply)
    }
    const [marketplace] = await chat.ask('/add ocbc 10 SHOPEE SINGAPORE MP')
    expect(marketplace.text).toMatch(/\nID \d+: Shopping Spend$/)
    expect(labels(marketplace)).toEqual([`Mark as ${OTHER}`])

    // A rule stores where each of them is: the last is at a merchant that the terms name for Shopping Spend.
    expect(await categoriesOf(userId)).toEqual({
      'SHOPEE PAY': 'other',
      ShopeePay: 'other',
      'SHOPEEPAY SG': 'other',
      'SHOPEE SINGAPORE MP': 'shopping',
    })

    expect((await chat.press(wallet[0], `Mark as ${SHOPPING}`)).answer).toMatch(/^ID \d+: Shopping Spend$/)
    expect((await categoriesOf(userId))['SHOPEE PAY']).toBe('shopping')
  })
})

describe('a card of a product whose terms count a purchase by the day that it was made', () => {
  // The catalogue has no such product with the groups of the UOB EVOL Card, so a made-up one is put there.
  inCatalogue(BY_PURCHASE_DAY)

  it('has a window that counts the purchases of its own days, and nothing said of which days those are', async () => {
    const chat = openChat()
    expect(await chat.say(`/addcard plain 1234 statement 5 ${BY_PURCHASE_DAY.key}`)).toBe(
      'Added plain ••••1234: statement closes on the 5th of the month, Made-up Card.',
    )
    const userId = await chat.userId()
    // The cycle is that of 6 October to 5 November. The 4th and the 5th are of the one before it.
    await record(userId, [
      ['2026-10-04T10:00:00+08:00', 2000, 'SGD', '1234'],
      ['2026-10-05T10:00:00+08:00', 5000, 'SGD', '1234'],
      ['2026-10-06T10:00:00+08:00', 10000, 'SGD', '1234'],
    ])

    // The days that its total counts are those of its cycle, and nothing under the table says why any are not.
    expect(await chat.lines('/spend')).toEqual([
      SPEND_HEADER,
      'plain | SGD 100.00 | 1 | 6 Oct to 5 Nov | 6 Nov',
      ESTIMATED,
    ])
    // As text, no line under the card says which days its total counts, and none under the others says why.
    vi.spyOn(deps.messenger, 'sendRich').mockRejectedValueOnce(new TelegramError('sendRichMessage', 400))
    expect(await chat.say('/spend')).toBe(
      'plain ••••1234: SGD 100.00 in 1 purchase, resets 6 Nov\n\nTotals are estimated from bank alerts.',
    )
    const detail = linesOf(await chat.rich('/spend plain'))
    expect(detail[0]).toBe('plain ••••1234: 6 Oct to 5 Nov')
    expect(detail.slice(-3)).toEqual([
      'Total: SGD 100.00 in 1 purchase, resets 6 Nov',
      'Minimum spend: SGD 100.00 of SGD 800.00',
      "Limits are from the bank's terms for the Made-up Card, as of 10 June 2026.",
    ])
    // An assistant is given the window, and nothing of a total that counts from before it.
    expect((await spendingSummary(storeFor(env.DB, userId), NOW, 'Asia/Singapore')).cards).toEqual([
      {
        nickname: 'plain',
        last4: '1234',
        windowType: 'statement',
        windowStart: '2026-10-05T16:00:00.000Z',
        windowEnd: '2026-11-05T16:00:00.000Z',
        totals: [{ currency: 'SGD', amount: '100.00', amountMinor: 10000 }],
        purchaseCount: 1,
      },
    ])

    // On the day that the statement closes the window is still that one, and a purchase of the day is in it, with
    // nothing said of where it is counted.
    clock.now = new Date('2026-11-05T12:00:00+08:00')
    const [reply] = await chat.ask('/add plain 7 Lunch')
    expect(reply.text.split('\n').slice(1)).toEqual([
      'plain ••••1234: SGD 107.00 in 2 purchases, resets 6 Nov',
      expect.stringMatching(/^ID \d+: Online \/ Mobile Contactless Spend$/),
    ])
  })
})
