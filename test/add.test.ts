import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { ingestAlert } from '../src/ingest'
import { serveMcp } from '../src/mcp/server'
import { storeFor } from '../src/store'
import { deps, NOW, openChat, type Posted } from './connect-helpers'
import { alertEmail, buy, seconds } from './helpers'
import { dataIn, mcpRequest, messageIn, toolCall } from './mcp-helpers'

// Purchases that a user adds by hand, and purchases that a user takes out. The clock stands at 12:00 on 9 October
// 2026 in Singapore.

const USAGE = [
  'Usage:',
  '/add <nickname> <amount> <merchant>',
  '/add <nickname> <amount> <date> <merchant>',
  'The amount can have a currency before it, as in USD 12.50. The date is written YYYY-MM-DD, D/M or D/M/YY.',
].join('\n')

const NOW_SECONDS = NOW.getTime() / 1000

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
      source_id: expect.stringMatching(/^manual-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
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
      `#${row.id} 9 Oct · SGD 12.50 · Lunch at the corner · by hand\n` +
        'visa ••••1234: SGD 12.50 in 1 purchase, resets 1 Nov',
    )
    // What a user types is marked as what an email says is: nothing in it can be tapped.
    expect(markedIn(reply)).toEqual(['Lunch at the corner'])
    expect(reply.buttons).toBeUndefined()
  })

  it.each([
    ['2026-10-03', '3 Oct', '2026-10-03T12:00:00+08:00'],
    ['3/10', '3 Oct', '2026-10-03T12:00:00+08:00'],
    ['03/10', '3 Oct', '2026-10-03T12:00:00+08:00'],
    ['3/10/26', '3 Oct', '2026-10-03T12:00:00+08:00'],
    ['3/10/2026', '3 Oct', '2026-10-03T12:00:00+08:00'],
    ['25/12/25', '25 Dec', '2025-12-25T12:00:00+08:00'],
    ['2024-02-29', '29 Feb', '2024-02-29T12:00:00+08:00'],
    // Today, though noon has only just come.
    ['9/10', '9 Oct', '2026-10-09T12:00:00+08:00'],
  ])('records a purchase of %s at noon on that day', async (date, shown, noon) => {
    const chat = await chatWithCards()

    const reply = await ask(chat, `/add visa 12.50 ${date} Lunch`)

    const [row] = await rowsOf(await chat.userId())
    expect(row).toMatchObject({ merchant: 'Lunch', occurred_at: seconds(noon), parser: 'manual' })
    expect(reply.text.split('\n')[0]).toBe(`#${row.id} ${shown} · SGD 12.50 · Lunch · by hand`)
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
    ['7', 'SGD', 700],
    ['7.5', 'SGD', 750],
    ['1,234.56', 'SGD', 123456],
    ['1234.56', 'SGD', 123456],
    ['USD12.50', 'USD', 1250],
    ['usd12.50', 'USD', 1250],
    ['USD 12.50', 'USD', 1250],
    ['jpy 1,500', 'JPY', 150000],
    ['SGD 3', 'SGD', 300],
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

    const reply = await ask(chat, '/add visa 99 30/9 last month')

    expect(reply.text.split('\n')[1]).toBe('visa ••••1234: SGD 10.00 in 1 purchase, resets 1 Nov')
    expect(await chat.say('/spend')).toContain('visa ••••1234: SGD 10.00 in 1 purchase, resets 1 Nov')
  })

  it.each([
    ['/add', USAGE],
    ['/add visa', USAGE],
    ['/add visa 12.50', USAGE],
    ['/add visa Lunch 12.50', USAGE],
    ['/add 12.50 Lunch', USAGE],
    ['/add my!card 12.50 Lunch', USAGE],
    ['/add visa twelve Lunch', USAGE],
    ['/add visa 12.505 Lunch', USAGE],
    ['/add visa -12.50 Lunch', USAGE],
    ['/add visa $12.50 Lunch', USAGE],
    ['/add visa 12,50 Lunch', USAGE],
    ['/add visa .50 Lunch', USAGE],
    ['/add visa US12.50 Lunch', USAGE],
    ['/add visa USD USD12.50 Lunch', USAGE],
    ['/add visa USD Lunch', USAGE],
    // What is written as a date is a date, so a merchant has to come after it.
    ['/add visa 12.50 3/10', USAGE],
    ['/add visa USD 12.50 2026-10-03', USAGE],
    ['/add visa 0 Lunch', 'The amount must be more than zero.'],
    ['/add visa 0.00 Lunch', 'The amount must be more than zero.'],
    ['/add visa 12.50 31/2 Lunch', 'There is no such date.'],
    ['/add visa 12.50 2026-02-29 Lunch', 'There is no such date.'],
    ['/add visa 12.50 2026-13-01 Lunch', 'There is no such date.'],
    ['/add visa 12.50 0/10 Lunch', 'There is no such date.'],
    ['/add visa 12.50 1/0 Lunch', 'There is no such date.'],
    ['/add visa 12.50 0026-10-03 Lunch', 'There is no such date.'],
    ['/add visa 12.50 10/10 Lunch', 'That date is still to come.'],
    ['/add visa 12.50 2026-10-10 Lunch', 'That date is still to come.'],
    ['/add visa 12.50 1/1/27 Lunch', 'That date is still to come.'],
    [`/add visa 12.50 ${'x'.repeat(81)}`, 'The merchant can be 80 characters at most.'],
    [`/add visa 12.50 3/10 ${'word '.repeat(16)}x`, 'The merchant can be 80 characters at most.'],
    ['/add amex 12.50 Lunch', 'You have no card called amex.'],
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
    expect(await bystander.say('/spend')).toContain('visa ••••1234: no purchases, resets 1 Nov')
    expect(await chat.say('/spend')).toContain('visa ••••1234: SGD 12.50 in 1 purchase, resets 1 Nov')
  })

  it('runs five queries for a card with a product, which is its most', async () => {
    const chat = await chatWithCards()
    const queried = vi.spyOn(env.DB, 'prepare')

    await chat.ask('/add evol 12.50 Lunch')

    // The user, the cards, what was chosen for the merchant, the purchase, and the card's total.
    expect(queried).toHaveBeenCalledTimes(5)
  })
})

describe('/add for a card that is linked to a product', () => {
  it('comes with the buttons that sort the purchase when no rule settles where it belongs', async () => {
    const chat = await chatWithCards()

    const reply = await ask(chat, '/add evol 12.50 3/10 Lunch')

    const [row] = await rowsOf(await chat.userId())
    expect(row).toMatchObject({ card_last4: '5678', currency: 'SGD', category: null })
    expect(reply.text).toBe(
      [
        `#${row.id} 3 Oct · SGD 12.50 · Lunch · by hand`,
        'evol ••••5678: SGD 12.50 in 1 purchase, resets 1 Nov',
        `#${row.id}: not sorted. Which was it?`,
      ].join('\n'),
    )
    expect(markedIn(reply)).toEqual(['Lunch'])
    expect(reply.buttons?.flat()).toEqual([
      { text: 'Online', data: `${row.id}:online` },
      { text: 'Phone tap', data: `${row.id}:mobile` },
      { text: 'Physical card or other', data: `${row.id}:other` },
      { text: "Doesn't count", data: `${row.id}:excluded` },
    ])

    // A press sorts the purchase, and the message says where it is.
    const pressed = await chat.press(reply, 'Physical card or other')
    expect(pressed).toEqual({ answer: `#${row.id}: Physical card or other`, sent: [] })
    expect(reply.text.split('\n')).toEqual([
      `#${row.id} 3 Oct · SGD 12.50 · Lunch · by hand`,
      'evol ••••5678: SGD 12.50 in 1 purchase, resets 1 Nov',
      `#${row.id}: Physical card or other`,
    ])
    expect(reply.buttons).toBeUndefined()
    expect(await rowsOf(await chat.userId())).toMatchObject([{ category: 'other' }])
  })

  it.each([
    ['USD 12.50 Airline', 'USD 12.50 · Airline', 'fx', 'Foreign currency'],
    ['15.98 netflix.com', 'SGD 15.98 · netflix.com', 'selected', 'Gym, telco and streaming'],
    ['20 3/10 M1 top-up', 'SGD 20.00 · M1 top-up', 'selected', 'Gym, telco and streaming'],
  ])('says where a rule put the purchase, with no buttons: %s', async (words, shown, category, name) => {
    const chat = await chatWithCards()

    const reply = await ask(chat, `/add evol ${words}`)

    const [row] = await rowsOf(await chat.userId())
    expect(row.category).toBe(category)
    expect(reply.text.split('\n')[0]).toContain(shown)
    expect(reply.text.split('\n')[2]).toBe(`#${row.id}: ${name}`)
    expect(reply.buttons).toBeUndefined()
  })

  it("takes an amount with no currency to be in the product's own", async () => {
    const chat = await chatWithCards()

    await chat.ask('/add evol 12.50 Lunch')

    expect(await rowsOf(await chat.userId())).toMatchObject([{ currency: 'SGD' }])
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

    expect(first.text).toBe(`Removed from ••••1234:\n#${fromAlert} 5 Oct · SGD 12.40 · COFFEE PLACE`)
    expect(markedIn(first)).toEqual(['COFFEE PLACE'])
    expect(second.text).toBe(`Removed from ••••1234:\n#${byHand} 3 Oct · SGD 3.00 · Tea · by hand`)
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
    const kept = await buy(userId, { cardLast4: '5678', merchant: 'BOOK SHOP', amountMinor: 3000, category: 'online' })
    const removed = await buy(userId, { cardLast4: '5678', merchant: 'TAKEN OUT', amountMinor: 990000 })
    const store = storeFor(env.DB, userId)

    await chat.ask(`/remove ${removed}`)

    expect(await chat.say('/spend')).toContain('evol ••••5678: SGD 30.00 in 1 purchase, resets 1 Nov')
    const detail = (await chat.ask('/spend evol')).map((message) => message.text).join('\n')
    expect(detail).toContain(`#${kept} 5 Oct · SGD 30.00 · BOOK SHOP · Online`)
    expect(detail).toContain('Total: SGD 30.00 in 1 purchase, resets 1 Nov')
    expect(detail).toContain('Minimum spend: SGD 30.00 of SGD 800.00')
    expect(detail).not.toContain('TAKEN OUT')
    expect(detail).not.toContain('Not sorted')
    // It is not there to be sorted, to be taken out again, or to be found at all.
    expect(await chat.say('/sort evol')).toBe('Every purchase on evol ••••5678 in its current window is sorted.')
    expect(await chat.say(`/sort ${removed}`)).toBe(`You have no purchase #${removed}.`)
    expect(await chat.say(`/remove ${removed}`)).toBe(`You have no purchase #${removed}.`)
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
    expect(await chat.say('/spend')).toContain('visa ••••1234: no purchases, resets 1 Nov')
  })

  it("takes out none of another user's purchases", async () => {
    const [chat, other] = [await chatWithCards(), await chatWithCards()]
    const theirs = await buy(await other.userId())

    expect(await chat.say(`/remove ${theirs}`)).toBe(`You have no purchase #${theirs}.`)

    expect(await rowsOf(await other.userId())).toMatchObject([{ id: theirs, removed_at: null }])
    expect(await other.say('/spend')).toContain('visa ••••1234: SGD 12.40 in 1 purchase, resets 1 Nov')
  })

  it.each(['/remove', '/remove evol', '/remove 12 13', '/remove 1.5', '/remove -3', '/remove #'])(
    'answers "%s" with the usage',
    async (message) => {
      expect(await openChat().say(message)).toBe('Usage: /remove <purchase id>')
    },
  )
})
