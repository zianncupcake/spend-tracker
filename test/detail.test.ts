import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { WINDOW_LIMIT } from '../src/domain/sorting'
import { openChat, type Posted } from './connect-helpers'
import { buy } from './helpers'

// /spend with a card: every purchase of its current window, one by one. The clock stands at 12:00 on 9 October 2026
// in Singapore, where a card whose statement closes on the 15th is in the window of 16 September to 15 October.

const TERMS = "Limits are from the bank's terms for the UOB EVOL Card, as of 10 June 2026."

/** The stretches of a message that are marked as code. */
function markedIn({ text, entities = [] }: Posted): string[] {
  return entities.map(({ offset, length }) => text.slice(offset, offset + length))
}

/** A user with a card that is linked to the UOB EVOL Card, and with purchases of every kind on it. */
async function shopper() {
  const chat = openChat()
  await chat.say('/addcard evol 1234 statement 15 uob-evol')
  const userId = await chat.userId()
  const ids: number[] = []
  const purchases: Parameters<typeof buy>[1][] = [
    { at: '2026-09-15T23:59:59+08:00', amountMinor: 9900, merchant: 'BEFORE THE WINDOW', category: 'online' },
    { at: '2026-09-16T00:00:00+08:00', amountMinor: 12000, merchant: 'BOOK SHOP', category: 'online' },
    { at: '2026-09-20T09:00:00+08:00', amountMinor: 4550, merchant: 'SUPERMARKET', category: 'mobile' },
    { at: '2026-09-25T09:00:00+08:00', amountMinor: 1598, merchant: 'NETFLIX.COM', category: 'selected' },
    { at: '2026-10-01T09:00:00+08:00', amountMinor: 500, currency: 'USD', merchant: 'AIRLINE', category: 'fx' },
    { at: '2026-10-02T09:00:00+08:00', amountMinor: 800, merchant: 'HAWKER', category: 'other', parser: 'manual' },
    { at: '2026-10-05T09:00:00+08:00', amountMinor: 1240, merchant: 'COFFEE PLACE' },
    { at: '2026-10-06T09:00:00+08:00', amountMinor: 5000, merchant: 'INSURANCE', category: 'excluded' },
    { at: '2026-10-07T09:00:00+08:00', amountMinor: 300, merchant: null },
    { at: '2026-10-08T09:00:00+08:00', amountMinor: 7700, merchant: 'ON ANOTHER CARD', cardLast4: '0005' },
  ]
  for (const purchase of purchases) ids.push(await buy(userId, purchase))
  return { chat, userId, ids }
}

describe('/spend with a card that is linked to a product', () => {
  it('lists every purchase of the window, totals them, and shows what the product makes of them', async () => {
    const { chat, ids } = await shopper()

    const [message, ...more] = await chat.ask('/spend evol')

    expect(more).toEqual([])
    expect(message.text).toBe(
      [
        'evol ••••1234: 16 Sep to 15 Oct',
        '',
        `#${ids[1]} 16 Sep · SGD 120.00 · BOOK SHOP · Online`,
        `#${ids[2]} 20 Sep · SGD 45.50 · SUPERMARKET · Phone tap`,
        `#${ids[3]} 25 Sep · SGD 15.98 · NETFLIX.COM · Gym, telco and streaming`,
        `#${ids[4]} 1 Oct · USD 5.00 · AIRLINE · Foreign currency`,
        `#${ids[5]} 2 Oct · SGD 8.00 · HAWKER · Physical card or other · by hand`,
        `#${ids[6]} 5 Oct · SGD 12.40 · COFFEE PLACE · not sorted`,
        `#${ids[7]} 6 Oct · SGD 50.00 · INSURANCE · Doesn't count`,
        `#${ids[8]} 7 Oct · SGD 3.00 · not sorted`,
        '',
        'Total: SGD 254.88 + USD 5.00 in 8 purchases, resets 16 Oct',
        '',
        'Online and mobile contactless: SGD 165.50 of SGD 300.00',
        'Gym, telco and streaming: SGD 15.98 of SGD 200.00',
        'Other local spend: SGD 8.00',
        'Foreign currency: USD 5.00',
        'Not sorted: SGD 15.40',
        "Doesn't count: SGD 50.00",
        'Minimum spend: SGD 204.88 of SGD 800.00, not counting purchases in other currencies',
        TERMS,
      ].join('\n'),
    )
    // Every merchant's name is marked as code, and nothing else is.
    expect(markedIn(message)).toEqual([
      'BOOK SHOP',
      'SUPERMARKET',
      'NETFLIX.COM',
      'AIRLINE',
      'HAWKER',
      'COFFEE PLACE',
      'INSURANCE',
    ])
    expect(message.buttons).toBeUndefined()
  })

  it('shows the table with nothing spent when the window holds no purchases', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')

    expect(await chat.say('/spend evol')).toBe(
      [
        'evol ••••1234: 1 Oct to 31 Oct',
        '',
        'Total: no purchases, resets 1 Nov',
        '',
        'Online and mobile contactless: SGD 0.00 of SGD 300.00',
        'Gym, telco and streaming: SGD 0.00 of SGD 200.00',
        'Other local spend: SGD 0.00',
        'Foreign currency: SGD 0.00',
        'Minimum spend: SGD 0.00 of SGD 800.00',
        TERMS,
      ].join('\n'),
    )
  })

  it("names a merchant so that nothing in the name can be tapped, as it is text from an email", async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const merchant = '𝒳 /delete confirm https://attacker.test/x @someone'
    const id = await buy(await chat.userId(), { merchant, category: 'online' })

    const [message] = await chat.ask('/spend evol')

    expect(message.text).toContain(`#${id} 5 Oct · SGD 12.40 · ${merchant} · Online`)
    expect(markedIn(message)).toEqual([merchant])
  })

  it('takes two queries for the window, however many purchases it holds', async () => {
    const { chat } = await shopper()
    const queried = vi.spyOn(env.DB, 'prepare')

    await chat.ask('/spend evol')

    // After one for the user and one for the cards.
    expect(queried).toHaveBeenCalledTimes(1 + 1 + 2)
  })
})

describe('/spend with a card that is linked to no product', () => {
  it('lists the purchases and totals them, with no categories and no table', async () => {
    const { chat, userId, ids } = await shopper()
    await chat.say('/addcard amex 0005 calendar')
    const onAmex = { cardLast4: '0005' }
    const lunch = await buy(userId, { ...onAmex, at: '2026-10-09T08:00:00+08:00', merchant: 'LUNCH', parser: 'manual' })
    // What a purchase was sorted into is not shown on a card with no product.
    const sorted = await buy(userId, { ...onAmex, at: '2026-10-09T09:00:00+08:00', category: 'online' })

    const [message, ...more] = await chat.ask('/spend amex')

    expect(more).toEqual([])
    expect(message.text).toBe(
      [
        'amex ••••0005: 1 Oct to 31 Oct',
        '',
        `#${ids[9]} 8 Oct · SGD 77.00 · ON ANOTHER CARD`,
        `#${lunch} 9 Oct · SGD 12.40 · LUNCH · by hand`,
        `#${sorted} 9 Oct · SGD 12.40 · COFFEE PLACE`,
        '',
        'Total: SGD 101.80 in 3 purchases, resets 1 Nov',
      ].join('\n'),
    )
    expect(markedIn(message)).toEqual(['ON ANOTHER CARD', 'LUNCH', 'COFFEE PLACE'])
  })

  it('says so when the window holds no purchases', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 statement 8') // The cycle that began on 9 October.

    expect(await chat.say('/spend amex')).toBe('amex ••••0005: 9 Oct to 8 Nov\n\nTotal: no purchases, resets 9 Nov')
  })
})

describe('/spend with a card', () => {
  it("shows the window's dates, and each purchase's day, in the user's time zone", async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar')
    await chat.say('/timezone America/New_York')
    const userId = await chat.userId()
    // Half past midnight on 1 October in Singapore is still 30 September in New York.
    await buy(userId, { at: '2026-10-01T00:30:00+08:00', merchant: 'SEPTEMBER IN NEW YORK' })
    const id = await buy(userId, { at: '2026-10-01T12:30:00+08:00', merchant: 'OCTOBER IN BOTH' })

    expect(await chat.say('/spend evol')).toBe(
      [
        'evol ••••1234: 1 Oct to 31 Oct',
        '',
        `#${id} 1 Oct · SGD 12.40 · OCTOBER IN BOTH`,
        '',
        'Total: SGD 12.40 in 1 purchase, resets 1 Nov',
      ].join('\n'),
    )
  })

  it("shows a user their own purchases, and never those on another user's card of the same name", async () => {
    const [first, second] = [await shopper(), openChat()]
    await second.say('/addcard evol 1234 statement 15 uob-evol')
    const own = await buy(await second.userId(), { amountMinor: 100, merchant: 'ONLY THE SECOND', category: 'mobile' })

    const toFirst = (await first.chat.ask('/spend evol')).map((message) => message.text).join('\n')
    const toSecond = (await second.ask('/spend evol')).map((message) => message.text).join('\n')

    expect(toFirst).not.toContain('ONLY THE SECOND')
    expect(toFirst).toContain('Total: SGD 254.88 + USD 5.00 in 8 purchases')
    expect(toSecond).toContain(`#${own} 5 Oct · SGD 1.00 · ONLY THE SECOND · Phone tap`)
    expect(toSecond).toContain('Total: SGD 1.00 in 1 purchase, resets 16 Oct')
    expect(toSecond).toContain('Online and mobile contactless: SGD 1.00 of SGD 300.00')
    for (const merchant of ['BOOK SHOP', 'NETFLIX.COM', 'AIRLINE', 'COFFEE PLACE', 'INSURANCE']) {
      expect(toSecond).not.toContain(merchant)
    }
  })

  it.each([
    ['/spend visa', 'You have no card called visa.'],
    ['/spend EVOL', 'You have no card called EVOL.'],
    ['/spend evol amex', 'Usage:\n/spend\n/spend <nickname>'],
    ['/spend my!card', 'Usage:\n/spend\n/spend <nickname>'],
  ])('answers "%s" with what is wrong', async (message, reply) => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar')

    expect(await chat.say(message)).toBe(reply)
  })

  it('says how to add a card when the user has none', async () => {
    expect(await openChat().say('/spend evol')).toContain('You have no cards yet')
  })
})

describe('a window with many purchases', () => {
  /** A merchant's name of the 80 characters that a name can have. */
  const merchant = (index: number) => `MERCHANT ${String(index).padStart(3, '0')} `.padEnd(80, 'X')

  it('is sent as several messages that end at the ends of lines, each with its own merchants marked', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const userId = await chat.userId()
    const ids: number[] = []
    for (let index = 0; index < 120; index++) {
      const at = new Date(Date.parse('2026-10-01T08:00:00+08:00') + index * 60_000).toISOString()
      ids.push(await buy(userId, { at, merchant: merchant(index), category: index % 2 ? 'online' : null }))
    }

    const messages = await chat.ask('/spend evol')

    expect(messages.length).toBeGreaterThan(1)
    for (const message of messages) expect(message.text.length).toBeLessThanOrEqual(4096)
    // Put together again, the messages are the lines of the whole: no line was cut, and none was left out. Only
    // an empty line can be missing, where a message would have begun or ended with it.
    const lines = messages.flatMap((message) => message.text.split('\n')).filter((line) => line !== '')
    const sorted = (index: number) => (index % 2 ? 'Online' : 'not sorted')
    expect(lines).toEqual([
      'evol ••••1234: 1 Oct to 31 Oct',
      ...ids.map((id, index) => `#${id} 1 Oct · SGD 12.40 · ${merchant(index)} · ${sorted(index)}`),
      'Total: SGD 1,488.00 in 120 purchases, resets 1 Nov',
      'Online and mobile contactless: SGD 744.00 of SGD 300.00',
      'Gym, telco and streaming: SGD 0.00 of SGD 200.00',
      'Other local spend: SGD 0.00',
      'Foreign currency: SGD 0.00',
      'Not sorted: SGD 744.00',
      'Minimum spend: SGD 1,488.00 of SGD 800.00',
      TERMS,
    ])
    for (const message of messages) {
      expect(message.text).not.toMatch(/^\n|\n$/)
    }
    // The marks of each message are counted from where that message begins.
    expect(messages.flatMap(markedIn)).toEqual(ids.map((_, index) => merchant(index)))
    for (const message of messages) expect(message.entities?.length ?? 0).toBeLessThanOrEqual(100)
  })

  it(`lists the latest ${WINDOW_LIMIT} of them, and still totals them all, in the same four queries`, async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const userId = await chat.userId()
    const ids: number[] = []
    for (let index = 0; index < WINDOW_LIMIT + 5; index++) {
      const at = new Date(Date.parse('2026-10-01T08:00:00+08:00') + index * 60_000).toISOString()
      ids.push(await buy(userId, { at, amountMinor: 100, merchant: merchant(index), category: 'other' }))
    }
    const queried = vi.spyOn(env.DB, 'prepare')

    const messages = await chat.ask('/spend evol')

    expect(queried).toHaveBeenCalledTimes(4)
    const lines = messages.flatMap((message) => message.text.split('\n'))
    expect(lines.slice(0, 4)).toEqual([
      'evol ••••1234: 1 Oct to 31 Oct',
      '',
      `The latest ${WINDOW_LIMIT} of ${WINDOW_LIMIT + 5} purchases:`,
      `#${ids[5]} 1 Oct · SGD 1.00 · ${merchant(5)} · Physical card or other`,
    ])
    expect(lines.filter((line) => line.startsWith('#'))).toHaveLength(WINDOW_LIMIT)
    expect(lines).toContain(`Total: SGD 205.00 in ${WINDOW_LIMIT + 5} purchases, resets 1 Nov`)
    expect(lines).toContain('Other local spend: SGD 205.00')
    // With names as long as a name can be. Each message is one request to Telegram, of the 50 that a request may make.
    expect(messages.length).toBeLessThanOrEqual(8)
  })
})
