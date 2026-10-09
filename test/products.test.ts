import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { storeFor } from '../src/store'
import { openChat } from './connect-helpers'
import { userCount } from './helpers'
import { record } from './mcp-helpers'

// Linking a card to a product of the catalogue. The clock stands at 12:00 on 9 October 2026 in Singapore.

const LINKED = 'Linked evol ••••1234 to UOB EVOL Card. To sort its purchases, send /sort evol.'

/** The categories of a user's purchases, by their merchants. It reads the table directly, to see what is stored. */
async function categoriesOf(userId: number): Promise<Record<string, string | null>> {
  const { results } = await env.DB.prepare('SELECT merchant, category FROM transactions WHERE owner_id = ? ORDER BY id')
    .bind(userId)
    .all<{ merchant: string; category: string | null }>()
  return Object.fromEntries(results.map(({ merchant, category }) => [merchant, category]))
}

describe('/products', () => {
  it('lists the products by key and name, says how to link a card to one, and stores nothing', async () => {
    const chat = openChat()

    expect(await chat.say('/products')).toBe(
      [
        'The card products whose reward rules are known:',
        'uob-evol - UOB EVOL Card',
        '',
        'To link a card to one, send /product <nickname> <product key>. Or add the key to the end of /addcard.',
      ].join('\n'),
    )
    expect(await userCount(chat.telegramId)).toBe(0)
  })
})

describe('/product', () => {
  it('links a card to a product, which /cards then names, and unlinks it again', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 statement 5')
    await chat.say('/addcard amex 0005 calendar')
    const store = storeFor(env.DB, await chat.userId())

    expect(await chat.say('/product evol uob-evol')).toBe(LINKED)

    expect(await chat.say('/cards')).toBe(
      'evol ••••1234: statement closes on the 5th of the month, UOB EVOL Card\namex ••••0005: calendar month',
    )
    expect(await store.listCards()).toEqual([
      { nickname: 'evol', last4: '1234', windowType: 'statement', statementDay: 5, product: 'uob-evol' },
      { nickname: 'amex', last4: '0005', windowType: 'calendar' },
    ])

    expect(await chat.say('/product evol none')).toBe('evol ••••1234 is linked to no product now.')

    expect(await chat.say('/cards')).toBe(
      'evol ••••1234: statement closes on the 5th of the month\namex ••••0005: calendar month',
    )
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
    ['/product', 'Usage:\n/product <nickname> <product key>\n/product <nickname> none'],
    ['/product evol', 'Usage:\n/product <nickname> <product key>\n/product <nickname> none'],
    ['/product evol uob-evol now', 'Usage:\n/product <nickname> <product key>\n/product <nickname> none'],
    ['/product my!card uob-evol', 'Usage:\n/product <nickname> <product key>\n/product <nickname> none'],
    ['/product evol uob/evol', 'Usage:\n/product <nickname> <product key>\n/product <nickname> none'],
    ['/product evol visa-infinite', 'There is no product called visa-infinite. Send /products for the ones there are.'],
    ['/product spare uob-evol', 'You have no card called spare.'],
    ['/product spare none', 'You have no card called spare.'],
  ])('answers "%s" with what is wrong, and links nothing', async (message, reply) => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar')

    expect(await chat.say(message)).toBe(reply)

    expect(await chat.say('/cards')).toBe('evol ••••1234: calendar month')
  })

  it("links a user's own card, and not the card that another user calls the same", async () => {
    const [chat, bystander] = [openChat(), openChat()]
    for (const each of [chat, bystander]) await each.say('/addcard evol 1234 calendar')

    await chat.say('/product evol uob-evol')

    expect(await chat.say('/cards')).toBe('evol ••••1234: calendar month, UOB EVOL Card')
    expect(await bystander.say('/cards')).toBe('evol ••••1234: calendar month')
  })

  it("sorts the card's unsorted purchases of its current window that the product's own rules settle", async () => {
    const [chat, bystander] = [openChat(), openChat()]
    for (const each of [chat, bystander]) await each.say('/addcard evol 1234 calendar') // October
    await chat.say('/addcard amex 0005 calendar')
    const userId = await chat.userId()
    await record(userId, [
      ['2026-09-30T23:00:00+08:00', 1598, 'SGD', '1234', 'NETFLIX.COM LAST MONTH'],
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
      category: 'excluded',
    })
    await record(await bystander.userId(), [['2026-10-02T10:00:00+08:00', 1598, 'SGD', '1234', 'NETFLIX.COM']])

    expect(await chat.say('/product evol uob-evol')).toBe(LINKED)

    expect(await categoriesOf(userId)).toEqual({
      'NETFLIX.COM LAST MONTH': null,
      'NETFLIX.COM': 'selected',
      AIRLINE: 'fx',
      'COFFEE PLACE': null,
      'SINGTEL MOBILE': 'selected',
      'SPOTIFY ON ANOTHER CARD': null,
      'SORTED BY HAND': 'excluded',
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

    expect(await chat.say('/cards')).toContain('You have no cards yet')
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
