import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ingestAlert } from '../src/ingest'
import { serveMcp } from '../src/mcp/server'
import { storeFor } from '../src/store'
import { clock, deps, NOW, openChat, type Posted } from './connect-helpers'
import { alertEmail, buy, linesOf, seconds } from './helpers'
import { dataIn, mcpRequest, messageIn, toolCall } from './mcp-helpers'

// Purchases that a user adds by hand, and purchases that a user takes out. The clock stands at 12:00 on 9 October
// 2026 in Singapore, unless a test moves it.

const USAGE = [
  'Usage:',
  '/add <nickname> <amount> <merchant>',
  '/add <nickname> <amount> <date> <merchant>',
  'The amount can have a currency before it, as in USD 12.50. The date is written YYYY-MM-DD.',
  "A day of the card's current window, up to today, can be written D/M or D/M/YY too.",
  'Any other D/M is read as part of the merchant.',
].join('\n')

const TOO_MANY =
  'You have added 100 purchases by hand in the last 24 hours, which is as many as can be added in that time. ' +
  'Try again later.'

const NOW_SECONDS = NOW.getTime() / 1000

/** The id of a message that Telegram delivers twice. The ids that a chat gives its other messages never get to it. */
const TWICE = 1_000_001

type Chat = ReturnType<typeof openChat>

/** A chat whose user has two cards for the calendar month: one linked to no product, and one to the UOB EVOL Card. */
async function chatWithCards(): Promise<Chat> {
  const chat = openChat()
  await chat.say('/addcard visa 1234 calendar')
  await chat.say('/addcard evol 5678 calendar uob-evol')
  return chat
}

/** The one message that the bot replies with, whole. */
async function ask(chat: Chat, text: string): Promise<Posted> {
  const [message, ...more] = await chat.ask(text)
  expect(more).toEqual([])
  return message
}

function markedIn({ text, entities = [] }: Posted): string[] {
  return entities.map(({ offset, length }) => text.slice(offset, offset + length))
}

/** A user's transactions as they are stored. It reads the table directly, so it sees what a store leaves out. */
async function rowsOf(userId: number) {
  const { results } = await env.DB.prepare(
    `SELECT id, source_id, card_last4, amount_minor, currency, merchant, occurred_at, parser, category, removed_at
     FROM transactions WHERE owner_id = ? ORDER BY id`,
  )
    .bind(userId)
    .all<Record<string, string | number | null>>()
  return results
}

/** What a tool of the MCP endpoint gives a user. */
async function tool(userId: number, name: string, args: Record<string, unknown> = {}) {
  const response = await serveMcp(deps, { id: userId, timezone: 'Asia/Singapore' }, mcpRequest(toolCall(name, args)))
  return dataIn((await messageIn(response)).result)
}

describe('/add', () => {
  it('records a purchase made now, and replies with it and with where it leaves the card', async () => {
    const chat = await chatWithCards()

    const reply = await ask(chat, '/add visa 12.50 Lunch at the corner')

    const [row] = await rowsOf(await chat.userId())
    expect(row).toEqual({
      id: expect.any(Number),
      // It is known by the id of the message that added it.
      source_id: expect.stringMatching(/^manual:\d+$/),
      card_last4: '1234',
      amount_minor: 1250,
      currency: 'SGD',
      merchant: 'Lunch at the corner',
      occurred_at: NOW_SECONDS,
      parser: 'manual',
      category: null,
      removed_at: null,
    })
    expect(reply.text).toBe(
      `ID ${row.id} · 9 Oct · SGD 12.50 · Lunch at the corner · by hand\n` +
        'visa ••••1234: SGD 12.50 in 1 purchase, resets 1 Nov',
    )
    // What a user types is marked as what an email says is: nothing in it can be tapped.
    expect(markedIn(reply)).toEqual(['Lunch at the corner'])
    expect(reply.buttons).toBeUndefined()
  })

  it.each([
    ['3/10', '3 Oct', '2026-10-03T12:00:00+08:00'],
    ['03/10', '3 Oct', '2026-10-03T12:00:00+08:00'],
    ['3/10/26', '3 Oct', '2026-10-03T12:00:00+08:00'],
    ['3/10/2026', '3 Oct', '2026-10-03T12:00:00+08:00'],
    // The first day that the card's current window counts, which is October: two days before it begins.
    ['29/9', '29 Sep', '2026-09-29T12:00:00+08:00'],
    // With its year first, a day of any window.
    ['2025-12-25', '25 Dec', '2025-12-25T12:00:00+08:00'],
    // Today, though noon has only just come.
    ['9/10', '9 Oct', '2026-10-09T12:00:00+08:00'],
  ])('records a purchase of %s at noon on that day', async (date, shown, noon) => {
    const chat = await chatWithCards()

    const reply = await ask(chat, `/add visa 12.50 ${date} Lunch`)

    const [row] = await rowsOf(await chat.userId())
    expect(row).toMatchObject({ merchant: 'Lunch', occurred_at: seconds(noon), parser: 'manual' })
    expect(reply.text.split('\n')[0]).toBe(`ID ${row.id} · ${shown} · SGD 12.50 · Lunch · by hand`)
  })

  it.each(['9/10', '2026-10-09'])(
    'records a purchase of today, written %s, at the time that it is while noon is still to come',
    async (date) => {
      const chat = await chatWithCards()
      clock.now = new Date('2026-10-09T09:15:00+08:00')

      const reply = await ask(chat, `/add visa 12.50 ${date} Breakfast`)

      // Noon would be a time that has not come yet.
      const [row] = await rowsOf(await chat.userId())
      expect(row).toMatchObject({ merchant: 'Breakfast', occurred_at: seconds('2026-10-09T09:15:00+08:00') })
      expect(reply.text.split('\n')[0]).toBe(`ID ${row.id} · 9 Oct · SGD 12.50 · Breakfast · by hand`)
    },
  )

  it.each([
    // The start of a merchant's name, which no day of October is written like.
    '24/7 Fitness gym',
    // A day before those that the card's current window counts.
    '28/9 Lunch',
    '25/12/25 Lunch',
    // A day that is still to come. The latest 10 October that is not is last year's.
    '10/10 Lunch',
    '1/1/27 Lunch',
    // A day that no calendar has.
    '0/10 Lunch',
  ])('takes all of "%s" for the merchant, as it begins with no day of the window up to today', async (words) => {
    const chat = await chatWithCards()

    const reply = await ask(chat, `/add visa 5 ${words}`)

    const [row] = await rowsOf(await chat.userId())
    expect(row).toMatchObject({ merchant: words, occurred_at: NOW_SECONDS })
    expect(reply.text.split('\n')[0]).toBe(`ID ${row.id} · 9 Oct · SGD 5.00 · ${words} · by hand`)
  })

  it('looks for a date in the first word only, so a merchant that begins like one can follow a date', async () => {
    const chat = await chatWithCards()

    await chat.ask('/add visa 5 2026-10-08 3/10 Scale Models')

    expect(await rowsOf(await chat.userId())).toMatchObject([
      { merchant: '3/10 Scale Models', occurred_at: seconds('2026-10-08T12:00:00+08:00') },
    ])
  })

  it('reads a day and month with no year as the latest such day that is not after today', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 statement 15')
    // On 2 January the card is in the window of 16 December to 15 January.
    clock.now = new Date('2027-01-02T12:00:00+08:00')

    const reply = await ask(chat, '/add visa 12.50 30/12 Lunch')

    const [row] = await rowsOf(await chat.userId())
    expect(row).toMatchObject({ merchant: 'Lunch', occurred_at: seconds('2026-12-30T12:00:00+08:00') })
    expect(reply.text.split('\n')[0]).toBe(`ID ${row.id} · 30 Dec · SGD 12.50 · Lunch · by hand`)
  })

  it('goes by the current window of the card that the purchase was made with', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 statement 15') // 16 September to 15 October, counted from 14 September
    await chat.say('/addcard amex 0005 calendar') // October, counted from 29 September

    await chat.ask('/add visa 5 14/9 Lunch')
    await chat.ask('/add visa 5 13/9 Lunch')
    await chat.ask('/add amex 5 14/9 Lunch')
    // On the last two days of October the current window is November. A day of October is still taken for one.
    clock.now = new Date('2026-10-31T12:00:00+08:00')
    await chat.ask('/add amex 5 5/10 Lunch')

    expect(await rowsOf(await chat.userId())).toMatchObject([
      { card_last4: '1234', merchant: 'Lunch', occurred_at: seconds('2026-09-14T12:00:00+08:00') },
      { card_last4: '1234', merchant: '13/9 Lunch', occurred_at: NOW_SECONDS },
      { card_last4: '0005', merchant: '14/9 Lunch', occurred_at: NOW_SECONDS },
      { card_last4: '0005', merchant: 'Lunch', occurred_at: seconds('2026-10-05T12:00:00+08:00') },
    ])
  })

  it("takes a date to be a day in the user's time zone, where today may be another day", async () => {
    const chat = await chatWithCards()
    await chat.say('/timezone America/New_York')

    // In New York it is midnight, at the start of 9 October. Noon on the 8th there is 16:00 UTC.
    await chat.ask('/add visa 12.50 8/10 Lunch')

    expect(await rowsOf(await chat.userId())).toMatchObject([{ occurred_at: seconds('2026-10-08T16:00:00Z') }])
  })

  it.each([
    ['12.50', 'SGD', 1250],
    ['7.5', 'SGD', 750],
    ['1234.56', 'SGD', 123456],
    ['USD12.50', 'USD', 1250],
    ['jpy 1,500', 'JPY', 150000],
  ])('reads the amount %s, with its currency when it has one', async (amount, currency, amountMinor) => {
    const chat = await chatWithCards()

    await chat.ask(`/add visa ${amount} Lunch`)
    await chat.ask(`/add visa ${amount} 3/10 Lunch`)

    expect(await rowsOf(await chat.userId())).toMatchObject([
      { currency, amount_minor: amountMinor, merchant: 'Lunch', occurred_at: NOW_SECONDS },
      { currency, amount_minor: amountMinor, merchant: 'Lunch', occurred_at: seconds('2026-10-03T12:00:00+08:00') },
    ])
  })

  it('keeps the merchant as it was written, with one space between its words', async () => {
    const chat = await chatWithCards()

    await chat.ask('/add  visa   12.50   The   Corner    Café,  no. 3/10  ')

    expect(await rowsOf(await chat.userId())).toMatchObject([{ merchant: 'The Corner Café, no. 3/10' }])
  })

  it("leaves the purchase out of the card's running total when it was made before the current window", async () => {
    const chat = await chatWithCards()
    await chat.ask('/add visa 10 today')

    // The last day that October does not count: it counts the last two days of September.
    const reply = await ask(chat, '/add visa 99 2026-09-28 last month')

    expect(reply.text.split('\n')[1]).toBe('visa ••••1234: SGD 10.00 in 1 purchase, resets 1 Nov')
    expect(await chat.lines('/spend')).toContain('visa | SGD 10.00 | 1 | 29 Sep to 29 Oct | 1 Nov')
  })

  it.each([
    ['/add', USAGE],
    ['/add my!card 12.50 Lunch', USAGE],
    ['/add visa twelve Lunch', USAGE],
    ['/add visa 12.505 Lunch', USAGE],
    ['/add visa -12.50 Lunch', USAGE],
    ['/add visa $12.50 Lunch', USAGE],
    ['/add visa 12,50 Lunch', USAGE],
    ['/add visa .50 Lunch', USAGE],
    ['/add visa US12.50 Lunch', USAGE],
    ['/add visa USD USD12.50 Lunch', USAGE],
    // What is taken for a date is a date, so a merchant has to come after it.
    ['/add visa 12.50 3/10', USAGE],
    ['/add visa 0.00 Lunch', 'The amount must be more than zero.'],
    // With its year first it is always a date, and one that has to be a day that has come.
    ['/add visa 12.50 2026-02-29 Lunch', 'There is no such date.'],
    ['/add visa 12.50 0026-10-03 Lunch', 'There is no such date.'],
    ['/add visa 12.50 2026-10-10 Lunch', 'That date is still to come.'],
    [`/add visa 12.50 ${'x'.repeat(81)}`, 'The merchant can be 80 characters at most.'],
    ['/add VISA 12.50 Lunch', 'You have no card called VISA.'],
  ])('answers "%s" with what is wrong, and records nothing', async (message, reply) => {
    const chat = await chatWithCards()

    expect(await chat.say(message)).toBe(reply)

    expect(await rowsOf(await chat.userId())).toEqual([])
  })

  it('takes a merchant of as many characters as a name from an alert can have', async () => {
    const chat = await chatWithCards()
    const merchant = 'x'.repeat(80)

    await chat.ask(`/add visa 12.50 ${merchant}`)

    expect(await rowsOf(await chat.userId())).toMatchObject([{ merchant }])
  })

  it("records a purchase for the user's own card, and nobody else's card of the same name", async () => {
    const [chat, bystander] = [await chatWithCards(), await chatWithCards()]

    await chat.ask('/add visa 12.50 Lunch')

    expect(await rowsOf(await bystander.userId())).toEqual([])
    expect(await bystander.lines('/spend')).toContain('visa | SGD 0.00 | 0 | 29 Sep to 29 Oct | 1 Nov')
    expect(await chat.lines('/spend')).toContain('visa | SGD 12.50 | 1 | 29 Sep to 29 Oct | 1 Nov')
  })

  it('records one purchase for a message that Telegram delivers twice, and answers both alike', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()

    // Telegram delivers a message again, with the id it had, when it has not heard that the message was taken.
    const [first, ...more] = await chat.ask('/add evol 12.50 Lunch', TWICE)
    const [again, ...moreAgain] = await chat.ask('/add evol 12.50 Lunch', TWICE)

    expect([...more, ...moreAgain]).toEqual([])
    const rows = await rowsOf(userId)
    expect(rows).toMatchObject([{ source_id: `manual:${TWICE}`, merchant: 'Lunch', amount_minor: 1250 }])
    // The purchase, counted once in the total of its card, and the button that flags it.
    expect(again.text).toBe(
      [
        `ID ${rows[0].id} · 9 Oct · SGD 12.50 · Lunch · by hand`,
        'evol ••••5678: SGD 12.50 in 1 purchase, resets 1 Nov',
        `ID ${rows[0].id}: Online / Mobile Contactless Spend`,
      ].join('\n'),
    )
    expect(again.buttons).toEqual([[{ text: 'Mark as Other Spend', data: `${rows[0].id}:other` }]])
    expect(again).toMatchObject({ text: first.text, entities: first.entities, buttons: first.buttons })
    expect(await chat.lines('/spend')).toContain('evol | SGD 12.50 | 1 | 29 Sep to 29 Oct | 1 Nov')

    // The same words in a message of their own are another purchase.
    await chat.ask('/add evol 12.50 Lunch')
    expect(await rowsOf(userId)).toHaveLength(2)
  })

  it('answers a message that comes again with its purchase as it is by then: flagged, or taken out', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    const [first] = await chat.ask('/add evol 12.50 Lunch', TWICE)
    const [{ id }] = await rowsOf(userId)
    await chat.press(first, 'Mark as Other Spend')

    const [flagged] = await chat.ask('/add evol 12.50 Lunch', TWICE)

    expect(flagged.text.split('\n')[2]).toBe(`ID ${id}: Other Spend`)
    expect(flagged.buttons).toEqual([[{ text: 'Mark as Online / Mobile Contactless Spend', data: `${id}:online` }]])

    await chat.say(`/remove ${id}`)
    const [takenOut] = await chat.ask('/add evol 12.50 Lunch', TWICE)

    // A purchase that was taken out is never stored again, and this is not said to be the limit on adding.
    expect(takenOut.text).toBe(`ID ${id} has been taken out, and is not added again.`)
    expect(await rowsOf(userId)).toMatchObject([{ id, removed_at: expect.any(Number) }])
  })

  it('adds no more than a hundred purchases by hand in 24 hours, and says so when asked for one more', async () => {
    const [chat, bystander] = [await chatWithCards(), await chatWithCards()]
    const userId = await chat.userId()
    // 99 that were added by hand already.
    const earliest = await buy(userId, { parser: 'manual' })
    for (let added = 2; added <= 99; added++) await buy(userId, { parser: 'manual' })

    expect((await ask(chat, '/add visa 1 The hundredth')).text).toContain('The hundredth')
    expect(await chat.say('/add visa 1 One too many')).toBe(TOO_MANY)

    expect(await rowsOf(userId)).toHaveLength(100)
    // The limit is each user's own.
    expect((await ask(bystander, '/add visa 1 Lunch')).text).toContain('Lunch')

    // Once the earliest of them is 24 hours old, there is room for one more, and only for one.
    await env.DB.prepare('UPDATE transactions SET created_at = unixepoch() - 86400 WHERE id = ?').bind(earliest).run()
    expect((await ask(chat, '/add visa 1 Room for one')).text).toContain('Room for one')
    expect(await chat.say('/add visa 1 One too many')).toBe(TOO_MANY)
    expect(await rowsOf(userId)).toHaveLength(101)
  })
})

describe('/add for a card that is linked to a product', () => {
  it('says that the purchase is online when no rule places it, with the one button that flags it', async () => {
    const chat = await chatWithCards()

    const reply = await ask(chat, '/add evol 12.50 3/10 Lunch')

    const [row] = await rowsOf(await chat.userId())
    // Nothing is stored for where it is: online is where a purchase is until something says otherwise.
    expect(row).toMatchObject({ card_last4: '5678', currency: 'SGD', category: null })
    expect(reply.text).toBe(
      [
        `ID ${row.id} · 3 Oct · SGD 12.50 · Lunch · by hand`,
        'evol ••••5678: SGD 12.50 in 1 purchase, resets 1 Nov',
        `ID ${row.id}: Online / Mobile Contactless Spend`,
      ].join('\n'),
    )
    expect(markedIn(reply)).toEqual(['Lunch'])
    expect(reply.buttons).toEqual([[{ text: 'Mark as Other Spend', data: `${row.id}:other` }]])

    // A press flags the purchase. The message says so, and has the button that takes the flag off again.
    const pressed = await chat.press(reply, 'Mark as Other Spend')
    expect(pressed).toEqual({ answer: `ID ${row.id}: Other Spend`, sent: [] })
    expect(reply.text.split('\n')).toEqual([
      `ID ${row.id} · 3 Oct · SGD 12.50 · Lunch · by hand`,
      'evol ••••5678: SGD 12.50 in 1 purchase, resets 1 Nov',
      `ID ${row.id}: Other Spend`,
    ])
    expect(reply.buttons).toEqual([[{ text: 'Mark as Online / Mobile Contactless Spend', data: `${row.id}:online` }]])
    expect(await rowsOf(await chat.userId())).toMatchObject([{ category: 'other' }])
  })

  it.each([
    ['USD 12.50 Airline', 'USD 12.50 · Airline', 'fx', 'Overseas Foreign Currency Spend'],
    ['15.98 netflix.com', 'SGD 15.98 · netflix.com', 'selected', 'Selected Gym, Telco and Streaming Spend'],
    ['20 3/10 M1 top-up', 'SGD 20.00 · M1 top-up', 'selected', 'Selected Gym, Telco and Streaming Spend'],
  ])('says where a rule put the purchase, with the buttons that move it: %s', async (words, shown, category, name) => {
    const chat = await chatWithCards()

    const reply = await ask(chat, `/add evol ${words}`)

    const [row] = await rowsOf(await chat.userId())
    expect(row.category).toBe(category)
    expect(reply.text.split('\n')[0]).toContain(shown)
    expect(reply.text.split('\n')[2]).toBe(`ID ${row.id}: ${name}`)
    expect(reply.buttons).toEqual([
      [{ text: 'Mark as Online / Mobile Contactless Spend', data: `${row.id}:online` }],
      [{ text: 'Mark as Other Spend', data: `${row.id}:other` }],
    ])
  })

  it("takes an amount with no currency to be in the product's own", async () => {
    const chat = await chatWithCards()

    await chat.ask('/add evol 12.50 Lunch')

    expect(await rowsOf(await chat.userId())).toMatchObject([{ currency: 'SGD' }])
  })
})

describe('/add of a purchase that was made in the last two days of a window', () => {
  /** What a reply says after its first line, which is the purchase. */
  const after = (reply: Posted) => reply.text.split('\n').slice(1)

  it('says that it is counted in the statement month that begins after the statement closes', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 5678 statement 5 uob-evol')
    const counted = (closes: string, begins: string) =>
      `This purchase was made in the last 2 days before the statement ${closes}, and so is counted in the statement ` +
      `month that ${begins}. The bank counts a purchase by the day it is posted.`
    /** The line that a reply ends with, which says where the purchase is sorted. */
    const ONLINE = expect.stringMatching(/^ID \d+: Online \/ Mobile Contactless Spend$/)

    // On the 4th, the day before the statement closes, the card's total is that of the statement month to come. A
    // purchase of the day before counts for the cycle that closes, and one of today for the one that begins on the 6th.
    clock.now = new Date('2026-10-04T12:00:00+08:00')
    const before = await ask(chat, '/add evol 1 2026-10-03 Breakfast')
    const today = await ask(chat, '/add evol 20 Lunch')
    expect(after(before)).toEqual(['evol ••••5678: no purchases, resets 6 Nov', ONLINE])
    expect(after(today)).toEqual([
      'evol ••••5678: SGD 20.00 in 1 purchase, resets 6 Nov',
      counted('closes on 5 Oct', 'begins on 6 Oct'),
      ONLINE,
    ])
    // The note stays where it is when a press moves the purchase: only the last line says where the purchase is.
    await chat.press(today, 'Mark as Other Spend')
    expect(after(today)).toEqual([
      'evol ••••5678: SGD 20.00 in 1 purchase, resets 6 Nov',
      counted('closes on 5 Oct', 'begins on 6 Oct'),
      expect.stringMatching(/^ID \d+: Other Spend$/),
    ])

    // Once the statement has closed, the same is said of a purchase of the 5th as of what has been. One of the 6th
    // was made in the statement month that counts it.
    clock.now = NOW
    const closing = await ask(chat, '/add evol 50 2026-10-05 Dinner')
    const first = await ask(chat, '/add evol 100 2026-10-06 Groceries')
    expect(after(closing)).toEqual([
      'evol ••••5678: SGD 70.00 in 2 purchases, resets 6 Nov',
      counted('closed on 5 Oct', 'began on 6 Oct'),
      ONLINE,
    ])
    expect(after(first)).toEqual(['evol ••••5678: SGD 170.00 in 3 purchases, resets 6 Nov', ONLINE])
  })

  it('says that it is counted in the next month, on a card whose window is the calendar month', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    const counted = (made: string, next: string) =>
      `This purchase was made in the last 2 days of ${made}, and so is counted in ${next}. The bank counts a ` +
      'purchase by the day it is posted.'

    // September has 30 days. October counts its 29th and its 30th, and not its 28th.
    const earlier = await ask(chat, '/add visa 1 2026-09-28 Breakfast')
    const dayBefore = await ask(chat, '/add visa 20 2026-09-29 Lunch')
    const lastDay = await ask(chat, '/add visa 50 2026-09-30 Dinner')
    const first = await ask(chat, '/add visa 100 2026-10-01 Groceries')
    expect(after(earlier)).toEqual(['visa ••••1234: no purchases, resets 1 Nov'])
    expect(after(dayBefore)).toEqual([
      'visa ••••1234: SGD 20.00 in 1 purchase, resets 1 Nov',
      counted('September', 'October'),
    ])
    expect(after(lastDay)).toEqual([
      'visa ••••1234: SGD 70.00 in 2 purchases, resets 1 Nov',
      counted('September', 'October'),
    ])
    expect(after(first)).toEqual(['visa ••••1234: SGD 170.00 in 3 purchases, resets 1 Nov'])

    // On the 31st of October a purchase of today is counted in November, which is the current month from the 30th.
    clock.now = new Date('2026-10-31T12:00:00+08:00')
    const today = await ask(chat, '/add visa 5 Coffee')
    expect(after(today)).toEqual([
      'visa ••••1234: SGD 5.00 in 1 purchase, resets 1 Dec',
      counted('October', 'November'),
    ])
    expect(today.buttons).toBeUndefined()
  })
})

describe('/remove', () => {
  it('takes a purchase out and replies with what it was, read from an alert or added by hand', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    const fromAlert = await buy(userId)
    await chat.ask('/add visa 3 3/10 Tea')
    const byHand = Number((await rowsOf(userId))[1].id)

    const first = await ask(chat, `/remove ${fromAlert}`)
    const second = await ask(chat, `/remove #${byHand}`)

    expect(first.text).toBe(`Removed from ••••1234:\nID ${fromAlert} · 5 Oct · SGD 12.40 · COFFEE PLACE`)
    expect(markedIn(first)).toEqual(['COFFEE PLACE'])
    expect(second.text).toBe(`Removed from ••••1234:\nID ${byHand} · 3 Oct · SGD 3.00 · Tea · by hand`)
    expect(markedIn(second)).toEqual(['Tea'])
    // The rows stay, marked.
    expect(await rowsOf(userId)).toMatchObject([
      { id: fromAlert, removed_at: expect.any(Number) },
      { id: byHand, removed_at: expect.any(Number) },
    ])
  })

  it('leaves the purchase out of every total and list from then on', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    const kept = await buy(userId, { cardLast4: '5678', merchant: 'BOOK SHOP', amountMinor: 3000, category: 'other' })
    const removed = await buy(userId, { cardLast4: '5678', merchant: 'TAKEN OUT', amountMinor: 990000 })
    const store = storeFor(env.DB, userId)

    await chat.ask(`/remove ${removed}`)

    expect(await chat.lines('/spend')).toContain('evol | SGD 30.00 | 1 | 29 Sep to 29 Oct | 1 Nov')
    const detail = linesOf(await chat.rich('/spend evol')).join('\n')
    const row = `${kept} | 5 Oct | 30.00 | BOOK SHOP`
    expect(detail).toContain(`Other Spend\nID | Date | SGD | Merchant\n${row}\nTotal | 30.00\n`)
    expect(detail).toContain('Total: SGD 30.00 in 1 purchase, resets 1 Nov')
    // It would have counted as online.
    expect(detail).toContain('Online and Mobile Contactless Spend\nTotal | 0.00\n')
    expect(detail).toContain('Minimum spend: SGD 30.00 of SGD 800.00')
    expect(detail).not.toContain('TAKEN OUT')
    // It is not there to be moved, to be taken out again, or to be found at all.
    expect(await chat.say(`/sort ${removed}`)).toBe(`You have no purchase with ID ${removed}.`)
    expect(await chat.say(`/remove ${removed}`)).toBe(`You have no purchase with ID ${removed}.`)
    expect(await store.findTransaction(removed)).toBeNull()
    expect(await store.sumByCurrency('5678', 0, 4_000_000_000)).toEqual([
      { currency: 'SGD', amountMinor: 3000, count: 1 },
    ])
  })

  it('leaves the purchase out of what an assistant is given', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    const kept = await buy(userId, { cardLast4: '5678', merchant: 'BOOK SHOP', amountMinor: 3000, category: 'online' })
    const removed = await buy(userId, { cardLast4: '5678', merchant: 'TAKEN OUT', amountMinor: 990000 })

    await chat.ask(`/remove ${removed}`)

    const summary = await tool(userId, 'get_spending_summary')
    expect(summary.cards[1]).toMatchObject({
      nickname: 'evol',
      totals: [{ currency: 'SGD', amount: '30.00', amountMinor: 3000 }],
      purchaseCount: 1,
    })
    const listing = await tool(userId, 'list_transactions', { from: '2000-01-01' })
    expect(listing.transactions).toMatchObject([{ id: kept, merchant: 'BOOK SHOP', category: 'online' }])
    expect(JSON.stringify([summary, listing])).not.toContain('TAKEN OUT')
  })

  it('keeps the purchase out when its alert is read again', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    const store = storeFor(env.DB, userId)
    const email = alertEmail({ sourceId: 'msg-7' })
    expect((await ingestAlert(store, email)).status).toBe('stored')
    const [{ id }] = await rowsOf(userId)

    await chat.ask(`/remove ${id}`)

    expect(await ingestAlert(store, email)).toEqual({ status: 'duplicate' })
    expect(await rowsOf(userId)).toMatchObject([{ id, source_id: 'msg-7', removed_at: expect.any(Number) }])
    expect(await chat.lines('/spend')).toContain('visa | SGD 0.00 | 0 | 29 Sep to 29 Oct | 1 Nov')
  })

  it("takes out none of another user's purchases", async () => {
    const [chat, other] = [await chatWithCards(), await chatWithCards()]
    const theirs = await buy(await other.userId())

    expect(await chat.say(`/remove ${theirs}`)).toBe(`You have no purchase with ID ${theirs}.`)

    expect(await rowsOf(await other.userId())).toMatchObject([{ id: theirs, removed_at: null }])
    expect(await other.lines('/spend')).toContain('visa | SGD 12.40 | 1 | 29 Sep to 29 Oct | 1 Nov')
  })

  it.each(['/remove 12 13', '/remove 1.5', '/remove -3', '/remove #'])(
    'answers "%s" with the usage',
    async (message) => {
      expect(await openChat().say(message)).toBe('Usage: /remove <purchase id>')
    },
  )
})
