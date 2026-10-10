import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { WINDOW_LIMIT } from '../src/domain/sorting'
import { ChatBlockedError, TelegramError } from '../src/telegram/api'
import { clock, deps, openChat, sent, sentRich, type Posted } from './connect-helpers'
import { buy } from './helpers'

// /spend with a card, as text: the purchases of its current window, in tables. It is what the bot sends when
// Telegram does not take the rich message that test/detail-rich.test.ts is about, so in these tests Telegram takes
// none. The clock stands at 12:00 on 9 October 2026 in Singapore, where a card whose statement closes on the 15th is
// in the window of 16 September to 15 October.

const TERMS = "Limits are from the bank's terms for the UOB EVOL Card, as of 10 June 2026."

/** What the bot logs, which is that it sent text in the place of a rich message. */
let logged: MockInstance<typeof console.error>

beforeEach(() => {
  vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new TelegramError('sendRichMessage', 400))
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
})

/** The blocks of a message: each stretch of its text that is set as the rows of a table, and as nothing else. */
function blocksIn({ text, entities = [] }: Posted): string[] {
  expect(entities.map((entity) => entity.type)).toEqual(entities.map(() => 'pre'))
  return entities.map(({ offset, length }) => text.slice(offset, offset + length))
}

/** What a message says outside its blocks, a line at a time. */
function outside({ text, entities = [] }: Posted): string[] {
  let rest = text
  // From the last block back, so that taking one out moves none of those before it.
  for (const { offset, length } of entities.toReversed()) rest = rest.slice(0, offset) + rest.slice(offset + length)
  return rest.split('\n').filter((line) => line !== '')
}

/** An id as a table shows it while no id has more than two digits: under the two letters of its header. */
function two(id: number): string {
  return String(id).padStart(2)
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
    { at: '2026-09-20T09:00:00+08:00', amountMinor: 4550, merchant: 'SUPERMARKET', category: 'other' },
    { at: '2026-09-25T09:00:00+08:00', amountMinor: 1598, merchant: 'NETFLIX.COM', category: 'selected' },
    { at: '2026-10-01T09:00:00+08:00', amountMinor: 500, currency: 'USD', merchant: 'AIRLINE', category: 'fx' },
    { at: '2026-10-02T09:00:00+08:00', amountMinor: 800, merchant: 'HAWKER', category: 'other', parser: 'manual' },
    // The three that no category is stored for count as online, as the one that it is stored for does.
    { at: '2026-10-05T09:00:00+08:00', amountMinor: 1240, merchant: 'COFFEE PLACE' },
    { at: '2026-10-06T09:00:00+08:00', amountMinor: 5000, merchant: 'INSURANCE' },
    { at: '2026-10-07T09:00:00+08:00', amountMinor: 300, merchant: null },
    { at: '2026-10-08T09:00:00+08:00', amountMinor: 7700, merchant: 'ON ANOTHER CARD', cardLast4: '0005' },
  ]
  for (const purchase of purchases) ids.push(await buy(userId, purchase))
  return { chat, userId, ids }
}

describe('/spend with a card, when Telegram does not take the rich message', () => {
  it('sends the same as text instead, and logs the status that Telegram answered with and no more', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 calendar')
    const id = await buy(await chat.userId(), { cardLast4: '0005' })

    const [message, ...more] = await chat.ask('/spend amex')

    // The rich message was tried once, for this chat, and none was sent.
    expect(deps.messenger.sendRich).toHaveBeenCalledTimes(1)
    expect(deps.messenger.sendRich).toHaveBeenCalledWith(chat.telegramId, expect.anything())
    expect(sentRich).toEqual([])
    expect(more).toEqual([])
    expect(message.text).toBe(
      [
        'amex ••••0005: 1 Oct to 31 Oct',
        '',
        'ID  Date     SGD  Merchant',
        `${two(id)}  5 Oct  12.40  COFFEE PLACE`,
        '    Total  12.40',
        '',
        'Total: SGD 12.40 in 1 purchase, resets 1 Nov',
      ].join('\n'),
    )
    // Nothing of the message is logged: no text of it, and no merchant.
    expect(logged.mock.calls).toEqual([['rich message failed, sent as text:', 400]])
  })

  it.each([
    ['a chat that Telegram will send nothing to', new ChatBlockedError()],
    ['a request that Telegram never answered', new TypeError('A made-up failure of the network')],
  ])('sends nothing as text after %s, and leaves the error as it is', async (_, error) => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 calendar')
    await buy(await chat.userId(), { cardLast4: '0005' })
    vi.mocked(deps.messenger.sendRich).mockRejectedValueOnce(error)

    await expect(chat.send('/spend amex')).rejects.toBe(error)

    expect(sent).toEqual([])
    expect(logged).not.toHaveBeenCalled()
  })
})

describe('/spend with a card that is linked to a product', () => {
  it("has a table for each group of the product: its purchases, what they come to, and the group's limit", async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const userId = await chat.userId()
    const shop = await buy(userId, { at: '2026-10-09T08:30:00+08:00', amountMinor: 3825, merchant: 'example-shop-sg' })
    // A name as a bank cuts it short, and longer than a row has room for.
    const eatery = { at: '2026-10-09T08:00:00+08:00', amountMinor: 4560, merchant: 'SAMPLE EATERY HOLDINGS PTE. LT' }
    const lunch = await buy(userId, eatery)
    const byCard = { amountMinor: 210, merchant: 'TRAIN FARE', category: 'other' }
    const there = await buy(userId, { ...byCard, at: '2026-10-09T09:00:00+08:00' })
    const back = await buy(userId, { ...byCard, at: '2026-10-10T09:00:00+08:00', amountMinor: 185 })
    clock.now = new Date('2026-10-10T12:00:00+08:00')

    const [message, ...more] = await chat.ask('/spend evol')

    // A group with no purchases has no header, and its numbers are under those of the groups that have one.
    const online = [
      'ID  Date       SGD  Merchant',
      `${two(lunch)}   9 Oct   45.60  SAMPLE EATERY H…`,
      `${two(shop)}   9 Oct   38.25  example-shop-sg`,
      '    Total    83.85',
      '    Cap     300.00',
      '    Left    216.15',
    ]
    const gym = ['    Total     0.00', '    Cap     200.00', '    Left    200.00']
    const physical = [
      'ID  Date       SGD  Merchant',
      `${two(there)}   9 Oct    2.10  TRAIN FARE`,
      `${two(back)}  10 Oct    1.85  TRAIN FARE`,
      '    Total     3.95',
    ]
    const foreign = ['    Total     0.00']
    expect(more).toEqual([])
    expect(message.text).toBe(
      [
        'evol ••••1234: 1 Oct to 31 Oct',
        '',
        'Online and Mobile Contactless Spend',
        ...online,
        '',
        'Selected Gym, Telco and Streaming Spend',
        ...gym,
        '',
        'Other Spend',
        ...physical,
        '',
        'Overseas Foreign Currency Spend',
        ...foreign,
        '',
        'Total: SGD 87.80 in 4 purchases, resets 1 Nov',
        '',
        'Minimum spend: SGD 87.80 of SGD 800.00',
        TERMS,
      ].join('\n'),
    )
    // Each table is a block of its own, of its rows and of nothing else.
    expect(blocksIn(message)).toEqual([online, gym, physical, foreign].map((rows) => rows.join('\n')))
    expect(message.buttons).toBeUndefined()
  })

  it('marks a purchase that was added by hand, and has a dash for a merchant that is not known', async () => {
    const { chat, ids } = await shopper()

    const [message, ...more] = await chat.ask('/spend evol')

    // A purchase is in the table of the group that it is in: online, unless something says otherwise. A group
    // whose purchases are all in one other currency has that currency named in its header.
    const online = [
      'ID  Date       SGD  Merchant',
      `${two(ids[1])}  16 Sep  120.00  BOOK SHOP`,
      `${two(ids[6])}   5 Oct   12.40  COFFEE PLACE`,
      `${two(ids[7])}   6 Oct   50.00  INSURANCE`,
      `${two(ids[8])}   7 Oct    3.00  -`,
      '    Total   185.40',
      '    Cap     300.00',
      '    Left    114.60',
    ]
    const gym = [
      'ID  Date       SGD  Merchant',
      `${two(ids[3])}  25 Sep   15.98  NETFLIX.COM`,
      '    Total    15.98',
      '    Cap     200.00',
      '    Left    184.02',
    ]
    const physical = [
      'ID  Date       SGD  Merchant',
      `${two(ids[2])}  20 Sep   45.50  SUPERMARKET`,
      `${two(ids[5])}*  2 Oct    8.00  HAWKER`,
      '    Total    53.50',
    ]
    const foreign = ['ID  Date       USD  Merchant', `${two(ids[4])}   1 Oct    5.00  AIRLINE`, '    Total     5.00']
    expect(more).toEqual([])
    expect(message.text).toBe(
      [
        'evol ••••1234: 16 Sep to 15 Oct',
        '',
        'Online and Mobile Contactless Spend',
        ...online,
        '',
        'Selected Gym, Telco and Streaming Spend',
        ...gym,
        '',
        'Other Spend',
        ...physical,
        '',
        'Overseas Foreign Currency Spend',
        ...foreign,
        '',
        '* = added by hand',
        '',
        'Total: SGD 254.88 + USD 5.00 in 8 purchases, resets 16 Oct',
        '',
        'Minimum spend: SGD 254.88 of SGD 800.00, not counting purchases in other currencies',
        TERMS,
      ].join('\n'),
    )
    expect(blocksIn(message)).toEqual([online, gym, physical, foreign].map((rows) => rows.join('\n')))
  })

  it('shows every group with nothing spent in it, and its limit, when the window holds no purchases', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')

    const [message, ...more] = await chat.ask('/spend evol')

    expect(more).toEqual([])
    expect(message.text).toBe(
      [
        'evol ••••1234: 1 Oct to 31 Oct',
        '',
        'Online and Mobile Contactless Spend',
        '    Total    0.00',
        '    Cap    300.00',
        '    Left   300.00',
        '',
        'Selected Gym, Telco and Streaming Spend',
        '    Total    0.00',
        '    Cap    200.00',
        '    Left   200.00',
        '',
        'Other Spend',
        '    Total    0.00',
        '',
        'Overseas Foreign Currency Spend',
        '    Total    0.00',
        '',
        'Total: no purchases, resets 1 Nov',
        '',
        'Minimum spend: SGD 0.00 of SGD 800.00',
        TERMS,
      ].join('\n'),
    )
    expect(blocksIn(message)).toEqual([
      '    Total    0.00\n    Cap    300.00\n    Left   300.00',
      '    Total    0.00\n    Cap    200.00\n    Left   200.00',
      '    Total    0.00',
      '    Total    0.00',
    ])
  })

  it('says how far past its limit a group is, in place of what is left, once nothing is', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const userId = await chat.userId()
    const books = await buy(userId, { amountMinor: 36240, merchant: 'BOOK SHOP' })
    const gym = { at: '2026-10-06T09:00:00+08:00', amountMinor: 20000, merchant: 'ANYTIME FITNESS' }
    const fitness = await buy(userId, { ...gym, category: 'selected' })

    const [message] = await chat.ask('/spend evol')

    // What was spent past a limit is shown as it is: the total is not cut to the limit.
    expect(message.text).toContain(
      [
        'Online and Mobile Contactless Spend',
        'ID  Date      SGD  Merchant',
        `${two(books)}  5 Oct  362.40  BOOK SHOP`,
        '    Total  362.40',
        '    Cap    300.00',
        '    Over    62.40',
        '',
        'Selected Gym, Telco and Streaming Spend',
        'ID  Date      SGD  Merchant',
        `${two(fitness)}  6 Oct  200.00  ANYTIME FITNESS`,
        '    Total  200.00',
        '    Cap    200.00',
        '    Left     0.00',
        '',
      ].join('\n'),
    )
    expect(message.text).toContain('Total: SGD 562.40 in 2 purchases, resets 1 Nov')
  })

  it("has the code on each amount of a group that holds two currencies, with a limit on the card's own", async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const userId = await chat.userId()
    const coffee = await buy(userId)
    // Moved by hand out of foreign currency, where its currency put it.
    const abroad = { at: '2026-10-06T09:00:00+08:00', amountMinor: 500, currency: 'USD', merchant: 'AIRLINE' }
    const flight = await buy(userId, { ...abroad, category: 'online' })
    const noodles = { at: '2026-10-07T09:00:00+08:00', amountMinor: 150000, currency: 'JPY', merchant: 'RAMEN' }
    const ramen = await buy(userId, { ...noodles, category: 'fx' })

    const [message, ...more] = await chat.ask('/spend evol')

    // A total for each currency. What the purchase in another currency comes to in the card's own is not known,
    // so it is left out of what is held against the limit.
    const online = [
      'ID  Date       Amount  Merchant',
      `${two(coffee)}  5 Oct   SGD 12.40  COFFEE PLACE`,
      `${two(flight)}  6 Oct    USD 5.00  AIRLINE`,
      '    Total   SGD 12.40',
      '    Total    USD 5.00',
      '    Cap    SGD 300.00',
      '    Left   SGD 287.60',
    ]
    const gym = ['    Total        0.00', '    Cap        200.00', '    Left       200.00']
    const physical = ['    Total        0.00']
    // A group of one currency names it in its header, and has plain numbers under it.
    const foreign = [
      'ID  Date          JPY  Merchant',
      `${two(ramen)}  7 Oct    1,500.00  RAMEN`,
      '    Total    1,500.00',
    ]
    expect(more).toEqual([])
    expect(message.text).toBe(
      [
        'evol ••••1234: 1 Oct to 31 Oct',
        '',
        'Online and Mobile Contactless Spend',
        ...online,
        '',
        'Selected Gym, Telco and Streaming Spend',
        ...gym,
        '',
        'Other Spend',
        ...physical,
        '',
        'Overseas Foreign Currency Spend',
        ...foreign,
        '',
        'Total: JPY 1,500.00 + SGD 12.40 + USD 5.00 in 3 purchases, resets 1 Nov',
        '',
        'Minimum spend: SGD 12.40 of SGD 800.00, not counting purchases in other currencies',
        TERMS,
      ].join('\n'),
    )
    expect(blocksIn(message)).toEqual([online, gym, physical, foreign].map((rows) => rows.join('\n')))
  })

  it("has a merchant's name in the block of its table, where nothing in it can be tapped", async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const userId = await chat.userId()
    // In UTF-16 code units, as the offsets of a message's entities are: each 𝒳 is two of them.
    const first = await buy(userId, { merchant: '𝒳𝒳 /start @someone' })
    const hostile = { at: '2026-10-06T09:00:00+08:00', merchant: '/delete confirm https://attacker.test/x #tag' }
    const second = await buy(userId, { ...hostile, category: 'other' })

    const [message] = await chat.ask('/spend evol')

    // A name is cut to the room that its row has left, and the cut leaves it in the block.
    const blocks = blocksIn(message)
    expect(blocks).toHaveLength(4)
    expect(blocks[0].split('\n')[1]).toBe(`${two(first)}  5 Oct   12.40  𝒳𝒳 /start @someo…`)
    expect(blocks[2].split('\n')[1]).toBe(`${two(second)}  6 Oct   12.40  /delete confirm…`)
    // Nothing of either name is anywhere else in the message.
    expect(outside(message)).toEqual([
      'evol ••••1234: 1 Oct to 31 Oct',
      'Online and Mobile Contactless Spend',
      'Selected Gym, Telco and Streaming Spend',
      'Other Spend',
      'Overseas Foreign Currency Spend',
      'Total: SGD 24.80 in 2 purchases, resets 1 Nov',
      'Minimum spend: SGD 24.80 of SGD 800.00',
      TERMS,
    ])
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
  it('has one table of all its purchases, which ends with what they come to, and no limit', async () => {
    const { chat, userId, ids } = await shopper()
    await chat.say('/addcard amex 0005 calendar')
    const onAmex = { cardLast4: '0005' }
    const lunch = await buy(userId, { ...onAmex, at: '2026-10-09T08:00:00+08:00', merchant: 'LUNCH', parser: 'manual' })
    // What a purchase was sorted into is not shown on a card with no product.
    const sorted = await buy(userId, { ...onAmex, at: '2026-10-09T09:00:00+08:00', category: 'other' })

    const [message, ...more] = await chat.ask('/spend amex')

    const table = [
      'ID  Date      SGD  Merchant',
      `${two(ids[9])}  8 Oct   77.00  ON ANOTHER CARD`,
      `${two(lunch)}* 9 Oct   12.40  LUNCH`,
      `${two(sorted)}  9 Oct   12.40  COFFEE PLACE`,
      '    Total  101.80',
    ]
    expect(more).toEqual([])
    expect(message.text).toBe(
      [
        'amex ••••0005: 1 Oct to 31 Oct',
        '',
        ...table,
        '',
        '* = added by hand',
        '',
        'Total: SGD 101.80 in 3 purchases, resets 1 Nov',
      ].join('\n'),
    )
    expect(blocksIn(message)).toEqual([table.join('\n')])
  })

  it('has the code on each amount when its purchases are in more than one currency, and a total for each', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 calendar')
    const userId = await chat.userId()
    const coffee = await buy(userId, { cardLast4: '0005' })
    const abroad = { cardLast4: '0005', at: '2026-10-06T09:00:00+08:00', amountMinor: 500, currency: 'USD' }
    const flight = await buy(userId, { ...abroad, merchant: 'AIRLINE' })

    const [message] = await chat.ask('/spend amex')

    const table = [
      'ID  Date      Amount  Merchant',
      `${two(coffee)}  5 Oct  SGD 12.40  COFFEE PLACE`,
      `${two(flight)}  6 Oct   USD 5.00  AIRLINE`,
      '    Total  SGD 12.40',
      '    Total   USD 5.00',
    ]
    expect(message.text).toBe(
      [
        'amex ••••0005: 1 Oct to 31 Oct',
        '',
        ...table,
        '',
        'Total: SGD 12.40 + USD 5.00 in 2 purchases, resets 1 Nov',
      ].join('\n'),
    )
    expect(blocksIn(message)).toEqual([table.join('\n')])
  })

  it('has no table when the window holds no purchases, and says so', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 statement 8') // The cycle that began on 9 October.

    const [message, ...more] = await chat.ask('/spend amex')

    expect(more).toEqual([])
    expect(message.text).toBe('amex ••••0005: 9 Oct to 8 Nov\n\nTotal: no purchases, resets 9 Nov')
    expect(message.entities).toBeUndefined()
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
        'ID  Date     SGD  Merchant',
        `${two(id)}  1 Oct  12.40  OCTOBER IN BOTH`,
        '    Total  12.40',
        '',
        'Total: SGD 12.40 in 1 purchase, resets 1 Nov',
      ].join('\n'),
    )
  })

  it("shows a user their own purchases, and never those on another user's card of the same name", async () => {
    const [first, second] = [await shopper(), openChat()]
    await second.say('/addcard evol 1234 statement 15 uob-evol')
    const own = await buy(await second.userId(), { amountMinor: 100, merchant: 'ONLY THE SECOND', category: 'other' })

    const toFirst = (await first.chat.ask('/spend evol')).map((message) => message.text).join('\n')
    const toSecond = (await second.ask('/spend evol')).map((message) => message.text).join('\n')

    expect(toFirst).not.toContain('ONLY THE SECOND')
    expect(toFirst).toContain('Total: SGD 254.88 + USD 5.00 in 8 purchases')
    expect(toFirst).toContain('Other Spend\nID  Date       SGD  Merchant\n')
    const row = `${two(own)}  5 Oct    1.00  ONLY THE SECOND`
    expect(toSecond).toContain(`Other Spend\nID  Date      SGD  Merchant\n${row}\n    Total    1.00\n`)
    expect(toSecond).toContain('Total: SGD 1.00 in 1 purchase, resets 16 Oct')
    expect(toSecond).toContain('Online and Mobile Contactless Spend\n    Total    0.00\n    Cap    300.00\n')
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

  /** The name as a row has it, with ids of three digits in the window: cut to the 16 characters that are left. */
  const cut = (index: number) => `MERCHANT ${String(index).padStart(3, '0')} XX…`

  const HEADER = 'ID   Date      SGD  Merchant'

  it('is sent as several messages, each with a block for every table or part of a table that it holds', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const userId = await chat.userId()
    const ids: number[] = []
    for (let index = 0; index < 120; index++) {
      const at = new Date(Date.parse('2026-10-01T08:00:00+08:00') + index * 60_000).toISOString()
      ids.push(await buy(userId, { at, merchant: merchant(index), category: index % 2 ? 'other' : null }))
    }
    const rows = ids.map((id, index) => `${String(id).padStart(3)}  1 Oct   12.40  ${cut(index)}`)
    const [online, physical] = [rows.filter((_, index) => index % 2 === 0), rows.filter((_, index) => index % 2 === 1)]

    const [first, second, ...more] = await chat.ask('/spend evol')

    expect(more).toEqual([])
    for (const message of [first, second]) {
      expect(message.text.length).toBeLessThanOrEqual(4096)
      expect(message.text).not.toMatch(/^\n|\n$/)
      const rowsOf = blocksIn(message).flatMap((block) => block.split('\n'))
      for (const row of rowsOf) expect(row.length).toBeLessThanOrEqual(36)
    }
    // The first message holds two tables and the start of a third, each in a block of its own.
    const [whole, empty, begun, ...none] = blocksIn(first)
    expect(none).toEqual([])
    expect(whole).toBe([HEADER, ...online, '     Total  744.00', '     Cap    300.00', '     Over   444.00'].join('\n'))
    expect(empty).toBe('     Total    0.00\n     Cap    200.00\n     Left   200.00')
    const held = begun.split('\n').length - 1
    expect(held).toBeGreaterThan(0)
    expect(begun).toBe([HEADER, ...physical.slice(0, held)].join('\n'))
    // The name of a table is in the message that the table begins in, above its block and no part of it.
    expect(outside(first)).toEqual([
      'evol ••••1234: 1 Oct to 31 Oct',
      'Online and Mobile Contactless Spend',
      'Selected Gym, Telco and Streaming Spend',
      'Other Spend',
    ])
    expect(first.text.endsWith(`\n\nOther Spend\n${begun}`)).toBe(true)
    // The second goes on with the third table, under its header again, and holds the fourth.
    const [continued, last, ...other] = blocksIn(second)
    expect(other).toEqual([])
    expect(continued).toBe([HEADER, ...physical.slice(held), '     Total  744.00'].join('\n'))
    expect(last).toBe('     Total    0.00')
    expect(second.text.startsWith(`${continued}\n\nOverseas Foreign Currency Spend\n${last}\n\n`)).toBe(true)
    expect(outside(second)).toEqual([
      'Overseas Foreign Currency Spend',
      'Total: SGD 1,488.00 in 120 purchases, resets 1 Nov',
      'Minimum spend: SGD 1,488.00 of SGD 800.00',
      TERMS,
    ])
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
    expect(lines.slice(0, 5)).toEqual([
      'evol ••••1234: 1 Oct to 31 Oct',
      '',
      `The latest ${WINDOW_LIMIT} of ${WINDOW_LIMIT + 5} purchases:`,
      '',
      'Online and Mobile Contactless Spend',
    ])
    const listed = lines.filter((line) => line.includes('MERCHANT'))
    expect(listed).toHaveLength(WINDOW_LIMIT)
    expect(listed[0]).toBe(`${String(ids[5]).padStart(3)}  1 Oct    1.00  ${cut(5)}`)
    expect(listed.at(-1)).toBe(`${String(ids.at(-1)).padStart(3)}  1 Oct    1.00  ${cut(WINDOW_LIMIT + 4)}`)
    // What a table's purchases come to takes in those that are not listed.
    expect(lines).toContain('     Total  205.00')
    expect(lines).toContain(`Total: SGD 205.00 in ${WINDOW_LIMIT + 5} purchases, resets 1 Nov`)
    // Each message is one request to Telegram, of the 50 that a request may make.
    expect(messages.length).toBeLessThanOrEqual(3)
  })
})
