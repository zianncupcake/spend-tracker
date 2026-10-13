import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramError } from '../src/telegram/api'
import { COUNTED_BY_POSTING } from '../src/telegram/format'
import { BY_HAND_NOTE } from '../src/telegram/purchases'
import { FAILED } from '../src/telegram/texts'
import { clock, deps, openChat, sent, sentRich, type Posted } from './connect-helpers'
import { buy } from './helpers'
import { catchConsole } from './log-helpers'

// /spend with a card, as text: the purchases of its current window, in tables. It is what the bot sends when
// Telegram does not take the rich message that test/detail-rich.test.ts is about, so in these tests Telegram takes
// none. The clock stands at 12:00 on 9 October 2026 in Singapore, where a card whose statement closes on the 15th is
// in the window of 16 September to 15 October. The last two days of a window are counted in the next one, so that
// window counts the purchases of 14 September to 13 October, and the calendar month those of 29 September to 29
// October.

const TERMS = "Limits are from the bank's terms for the UOB EVOL Card, as of 10 June 2026."

/** What is said under the total of a card with a statement cycle: which days of purchases it counts, and why. */
function counting(from: string, to: string): string {
  return (
    `The total counts purchases made from ${from} to ${to}. The bank counts a purchase by the day it is posted, so ` +
    'one made in the last 2 days before a statement closes is counted in the next statement month.'
  )
}

/** The same under the total of a card for the calendar month, which is October. */
const OCTOBER_COUNTS =
  'The total counts purchases made from 29 Sep to 29 Oct. The bank counts a purchase by the day it is posted, so ' +
  'one made in the last 2 days of a month is counted in the next month.'

beforeEach(() => {
  vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new TelegramError('sendRichMessage', 400))
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
    // The last second that the window does not count, and the first that it does.
    { at: '2026-09-13T23:59:59+08:00', amountMinor: 9900, merchant: 'BEFORE THE WINDOW', category: 'online' },
    { at: '2026-09-14T00:00:00+08:00', amountMinor: 12000, merchant: 'BOOK SHOP', category: 'online' },
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
  it('sends the same as text instead, and logs the update as one that was replied to, with nothing of the reply', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 calendar')
    const id = await buy(await chat.userId(), { cardLast4: '0005' })
    const logged = catchConsole()

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
        OCTOBER_COUNTS,
      ].join('\n'),
    )
    // Nothing of the message is logged: no text of it, and no merchant. The request that Telegram refused is logged
    // where it is made, by the messenger that posts to Telegram, which the one of these tests stands in for: see
    // test/webhook.test.ts.
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'command', command: 'spend', outcome: 'replied', ms: 0 },
    ])
    for (const text of ['amex', '0005', 'COFFEE', '12.40']) expect(logged.text()).not.toContain(text)
  })

  it('sends nothing as text after a request that never reached Telegram, and logs the update as one that failed', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 calendar')
    await buy(await chat.userId(), { cardLast4: '0005' })
    vi.mocked(deps.messenger.sendRich).mockRejectedValueOnce(new TypeError('A made-up failure of the network'))
    const logged = catchConsole()

    await chat.send('/spend amex')

    // All that a chat is sent then is that something went wrong.
    expect(sent).toEqual([{ chatId: chat.telegramId, text: FAILED }])
    // The reply had been made, and it was the sending of it that failed: so the log has the command as handled.
    const line = { event: 'update', kind: 'command', command: 'spend', outcome: 'failed', handled: true, told: true }
    expect(logged.events()).toEqual([{ ...line, ms: 0, error: 'TypeError' }])
  })
})

describe('/spend with a card that is linked to a product', () => {
  it('marks a purchase that was added by hand, and has a dash for a merchant that is not known', async () => {
    const { chat, ids } = await shopper()

    const [message, ...more] = await chat.ask('/spend evol')

    // A purchase is in the table of the group that it is in: online, unless something says otherwise. A group
    // whose purchases are all in one other currency has that currency named in its header.
    const online = [
      'ID  Date       SGD  Merchant',
      // It was made before the window's first day, and is listed with its own.
      `${two(ids[1])}  14 Sep  120.00  BOOK SHOP`,
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
        BY_HAND_NOTE,
        '',
        'Total: SGD 254.88 + USD 5.00 in 8 purchases, resets 16 Oct',
        counting('14 Sep', '13 Oct'),
        '',
        'Minimum spend: SGD 254.88 of SGD 800.00, not counting purchases in other currencies',
        TERMS,
      ].join('\n'),
    )
    expect(blocksIn(message)).toEqual([online, gym, physical, foreign].map((rows) => rows.join('\n')))
  })
})

describe('/spend, where the last two days of a window are counted in the next one', () => {
  /** What /spend says of one card: what its window comes to, which days of purchases that counts, and why. */
  const spend = (total: string, from: string, to: string) =>
    [
      total,
      `The total counts purchases made from ${from} to ${to}.`,
      '',
      COUNTED_BY_POSTING,
      'Totals are estimated from bank alerts.',
    ].join('\n')

  /** Stores a purchase of so much on a day, on the card ending 1234, and returns its id. */
  const boughtOn = (userId: number, day: string, amountMinor: number) =>
    buy(userId, { at: `${day}T09:00:00+08:00`, amountMinor, merchant: `BOUGHT ON ${Number(day.slice(-2))}` })

  it('counts a purchase of the 4th or the 5th in the statement month that begins on the 6th', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 statement 5 uob-evol')
    const userId = await chat.userId()
    const ids = [await boughtOn(userId, '2026-10-03', 100), await boughtOn(userId, '2026-10-04', 2000)]

    // On the 3rd the cycle is the one that closes on the 5th, which counts the purchase of the 3rd.
    clock.now = new Date('2026-10-03T12:00:00+08:00')
    expect(await chat.say('/spend')).toBe(
      spend('evol ••••1234: SGD 1.00 in 1 purchase, resets 6 Oct', '4 Sep', '3 Oct'),
    )
    // On the 4th it is the statement month that begins on the 6th already, which counts the purchase of today.
    clock.now = new Date('2026-10-04T12:00:00+08:00')
    expect(await chat.say('/spend')).toBe(
      spend('evol ••••1234: SGD 20.00 in 1 purchase, resets 6 Nov', '4 Oct', '3 Nov'),
    )

    // On the 9th that statement month counts the 4th and the 5th with the 6th.
    ids.push(await boughtOn(userId, '2026-10-05', 5000), await boughtOn(userId, '2026-10-06', 10000))
    clock.now = new Date('2026-10-09T12:00:00+08:00')
    expect(await chat.say('/spend')).toBe(
      spend('evol ••••1234: SGD 170.00 in 3 purchases, resets 6 Nov', '4 Oct', '3 Nov'),
    )
    // The statement month is shown as the bank has it. Each purchase has its own day, and the limit of its group is
    // held against all three.
    expect(await chat.say('/spend evol')).toBe(
      [
        'evol ••••1234: 6 Oct to 5 Nov',
        '',
        'Online and Mobile Contactless Spend',
        'ID  Date      SGD  Merchant',
        `${two(ids[1])}  4 Oct   20.00  BOUGHT ON 4`,
        `${two(ids[2])}  5 Oct   50.00  BOUGHT ON 5`,
        `${two(ids[3])}  6 Oct  100.00  BOUGHT ON 6`,
        '    Total  170.00',
        '    Cap    300.00',
        '    Left   130.00',
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
        'Total: SGD 170.00 in 3 purchases, resets 6 Nov',
        counting('4 Oct', '3 Nov'),
        '',
        'Minimum spend: SGD 170.00 of SGD 800.00',
        TERMS,
      ].join('\n'),
    )
  })

  it('counts a purchase of the last two days of a calendar month in the next month', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    const userId = await chat.userId()

    // September has 30 days. October counts its 29th and its 30th, and not its 28th.
    const september: [day: string, amountMinor: number][] = [
      ['2026-09-28', 100],
      ['2026-09-29', 200],
      ['2026-09-30', 400],
      ['2026-10-01', 800],
    ]
    for (const [day, amountMinor] of september) await boughtOn(userId, day, amountMinor)
    expect(await chat.say('/spend')).toBe(
      spend('visa ••••1234: SGD 14.00 in 3 purchases, resets 1 Nov', '29 Sep', '29 Oct'),
    )

    // On the 31st of October the month is November already, which counts the 30th and the 31st, and not the 29th.
    const ids = [
      await boughtOn(userId, '2026-10-29', 1000),
      await boughtOn(userId, '2026-10-30', 2000),
      await boughtOn(userId, '2026-10-31', 4000),
    ]
    clock.now = new Date('2026-10-31T12:00:00+08:00')
    expect(await chat.say('/spend')).toBe(
      spend('visa ••••1234: SGD 60.00 in 2 purchases, resets 1 Dec', '30 Oct', '28 Nov'),
    )

    // In November it counts those two with a purchase of the 1st. Each is listed with its own day.
    ids.push(await boughtOn(userId, '2026-11-01', 8000))
    clock.now = new Date('2026-11-05T12:00:00+08:00')
    expect(await chat.say('/spend visa')).toBe(
      [
        'visa ••••1234: 1 Nov to 30 Nov',
        '',
        'ID  Date       SGD  Merchant',
        `${two(ids[1])}  30 Oct   20.00  BOUGHT ON 30`,
        `${two(ids[2])}  31 Oct   40.00  BOUGHT ON 31`,
        `${two(ids[3])}   1 Nov   80.00  BOUGHT ON 1`,
        '    Total   140.00',
        '',
        'Total: SGD 140.00 in 3 purchases, resets 1 Dec',
        'The total counts purchases made from 30 Oct to 28 Nov. The bank counts a purchase by the day it is posted, ' +
          'so one made in the last 2 days of a month is counted in the next month.',
      ].join('\n'),
    )
  })
})

describe('/spend with a card', () => {
  it("shows the window's dates, and each purchase's day, in the user's time zone", async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar')
    await chat.say('/timezone America/New_York')
    const userId = await chat.userId()
    // October counts the purchases made from 29 September on. Half past midnight on that day in Singapore is still
    // the 28th in New York, which September counts there.
    await buy(userId, { at: '2026-09-29T00:30:00+08:00', merchant: 'SEPTEMBER IN NEW YORK' })
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
        OCTOBER_COUNTS,
      ].join('\n'),
    )
  })

  it.each([
    ['/spend EVOL', 'You have no card called EVOL.'],
    ['/spend evol amex', 'Usage:\n/spend\n/spend <nickname>'],
    ['/spend my!card', 'Usage:\n/spend\n/spend <nickname>'],
  ])('answers "%s" with what is wrong', async (message, reply) => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar')

    expect(await chat.say(message)).toBe(reply)
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
      OCTOBER_COUNTS,
      'Minimum spend: SGD 1,488.00 of SGD 800.00',
      TERMS,
    ])
  })
})
