import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { storeFor } from '../src/store'
import { handleUpdate } from '../src/telegram/handler'
import { answered, deps, openChat, posted, sent, type Posted } from './connect-helpers'
import { buy, userCount } from './helpers'

// Sorting purchases into the categories of a card's product: /sort, and the buttons under the bot's messages. The
// clock stands at 12:00 on 9 October 2026 in Singapore.

const BUTTONS = ['Online', 'Phone tap', 'Physical card or other', "Doesn't count"]
const REFUSED = 'That button no longer works.'
const ALL_SORTED = 'Every purchase on evol ••••1234 in its current window is sorted.'

type Chat = ReturnType<typeof openChat>

/** A chat whose user has a card that is linked to the UOB EVOL Card, with the calendar month for its window. */
async function chatWithCard(): Promise<Chat> {
  const chat = openChat()
  await chat.say('/addcard evol 1234 calendar uob-evol')
  return chat
}

/** The one message that the bot replies with, whole. */
async function ask(chat: Chat, text: string): Promise<Posted> {
  const [message, ...more] = await chat.ask(text)
  expect(more).toEqual([])
  return message
}

function labels(message: Posted): string[] | undefined {
  return message.buttons?.flat().map((button) => button.text)
}

function markedIn({ text, entities = [] }: Posted): string[] {
  return entities.map(({ offset, length }) => text.slice(offset, offset + length))
}

// The two functions below read the tables directly, to see what is stored.

async function categoryOf(purchaseId: number): Promise<string | null | undefined> {
  const row = await env.DB.prepare('SELECT category FROM transactions WHERE id = ?').bind(purchaseId).first<{
    category: string | null
  }>()
  return row?.category
}

async function rememberedBy(userId: number) {
  const { results } = await env.DB.prepare(
    'SELECT product, merchant, category FROM merchant_categories WHERE owner_id = ? ORDER BY merchant',
  )
    .bind(userId)
    .all()
  return results
}

describe('/sort with a card', () => {
  it('shows the earliest unsorted purchase of the current window, with a button for each choice', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    await buy(userId, { at: '2026-09-30T10:00:00+08:00', merchant: 'LAST MONTH' })
    await buy(userId, { at: '2026-10-01T10:00:00+08:00', merchant: 'SORTED ALREADY', category: 'online' })
    await buy(userId, { at: '2026-10-03T10:00:00+08:00', merchant: 'BOOK SHOP' })
    const coffee = await buy(userId, { at: '2026-10-02T10:00:00+08:00' })
    await buy(userId, { at: '2026-10-01T09:00:00+08:00', merchant: 'ON ANOTHER CARD', cardLast4: '0005' })

    const message = await ask(chat, '/sort evol')

    expect(message.text).toBe(`#${coffee} 2 Oct · SGD 12.40 · COFFEE PLACE\n#${coffee}: not sorted. Which was it?`)
    expect(markedIn(message)).toEqual(['COFFEE PLACE'])
    expect(labels(message)).toEqual(BUTTONS)
    // A row to each button.
    expect(message.buttons?.map((row) => row.length)).toEqual([1, 1, 1, 1])
  })

  it('sorts the purchase when a button is pressed, says so in the message, and goes on to the next one', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const coffee = await buy(userId, { at: '2026-10-02T10:00:00+08:00' })
    const books = await buy(userId, { at: '2026-10-03T10:00:00+08:00', merchant: 'BOOK SHOP', amountMinor: 3000 })
    const first = await ask(chat, '/sort evol')

    const pressed = await chat.press(first, 'Phone tap')

    expect(pressed.answer).toBe(`#${coffee}: Phone tap`)
    expect(await categoryOf(coffee)).toBe('mobile')
    // The message now ends with where the purchase is, and has no buttons. The merchant's name is still marked.
    expect(first.text).toBe(`#${coffee} 2 Oct · SGD 12.40 · COFFEE PLACE\n#${coffee}: Phone tap`)
    expect(markedIn(first)).toEqual(['COFFEE PLACE'])
    expect(first.buttons).toBeUndefined()
    // And the next unsorted purchase follows, with buttons that will bring the one after it.
    const [second, ...more] = pressed.sent
    expect(more).toEqual([])
    expect(second.text).toBe(`#${books} 3 Oct · SGD 30.00 · BOOK SHOP\n#${books}: not sorted. Which was it?`)
    expect(labels(second)).toEqual(BUTTONS)

    const last = await chat.press(second, "Doesn't count")

    expect(last.answer).toBe(`#${books}: Doesn't count`)
    expect(await categoryOf(books)).toBe('excluded')
    expect(second.text).toBe(`#${books} 3 Oct · SGD 30.00 · BOOK SHOP\n#${books}: Doesn't count`)
    expect(last.sent.map((message) => message.text)).toEqual([ALL_SORTED])
    expect(last.sent[0].buttons).toBeUndefined()
  })

  it('says that everything is sorted when nothing in the window is left to sort', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    await buy(userId, { at: '2026-09-30T10:00:00+08:00', merchant: 'LAST MONTH' })
    await buy(userId, { category: 'online' })

    expect(await chat.say('/sort evol')).toBe(ALL_SORTED)
  })

  it('says how to link a product when the card is linked to none', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 calendar')
    await buy(await chat.userId(), { cardLast4: '0005' })

    expect(await chat.say('/sort amex')).toBe(
      'amex ••••0005 is linked to no product, so its purchases are not sorted. ' +
        'To link it to one, send /product amex <product key>.',
    )
  })
})

describe('/sort with the id of a purchase', () => {
  it('shows the purchase with the buttons, and ticks the one for where it is now', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { category: 'mobile', parser: 'manual' })

    const message = await ask(chat, `/sort ${id}`)

    expect(message.text).toBe(`#${id} 5 Oct · SGD 12.40 · COFFEE PLACE · by hand\n#${id}: Phone tap. Which was it?`)
    expect(labels(message)).toEqual(['Online', '✓ Phone tap', 'Physical card or other', "Doesn't count"])
  })

  it('sorts the purchase again when a button is pressed, and sends nothing more', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const id = await buy(userId, { category: 'mobile' })
    const unsorted = await buy(userId, { merchant: 'BOOK SHOP' })
    // With the # that the id is shown with.
    const message = await ask(chat, `/sort #${id}`)

    const pressed = await chat.press(message, 'Online')

    expect(pressed).toEqual({ answer: `#${id}: Online`, sent: [] })
    expect(await categoryOf(id)).toBe('online')
    expect(message.text).toBe(`#${id} 5 Oct · SGD 12.40 · COFFEE PLACE\n#${id}: Online`)
    expect(message.buttons).toBeUndefined()
    expect(await categoryOf(unsorted)).toBeNull()
  })

  it('shows a purchase that a rule sorted with no button ticked, and moves it from where the rule put it', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { currency: 'USD', merchant: 'AIRLINE', category: 'fx' })

    const message = await ask(chat, `/sort ${id}`)

    expect(message.text).toBe(`#${id} 5 Oct · USD 12.40 · AIRLINE\n#${id}: Foreign currency. Which was it?`)
    expect(labels(message)).toEqual(BUTTONS)

    expect((await chat.press(message, "Doesn't count")).answer).toBe(`#${id}: Doesn't count`)
    expect(await categoryOf(id)).toBe('excluded')
  })

  it('sorts a purchase of an earlier window too', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { at: '2026-08-20T10:00:00+08:00' })

    const message = await ask(chat, `/sort ${id}`)
    await chat.press(message, 'Online')

    expect(message.text).toBe(`#${id} 20 Aug · SGD 12.40 · COFFEE PLACE\n#${id}: Online`)
  })

  it('goes by the card when a card has a number for a nickname, and by the purchase when the id has a #', async () => {
    const chat = openChat()
    await chat.say('/addcard 2024 1234 calendar uob-evol')
    const id = await buy(await chat.userId(), { category: 'online' })

    expect(await chat.say('/sort 2024')).toBe('Every purchase on 2024 ••••1234 in its current window is sorted.')
    expect((await ask(chat, `/sort #${id}`)).text).toContain(`#${id}: Online. Which was it?`)
  })

  it.each([
    ['/sort', 'Usage:\n/sort <nickname>\n/sort <purchase id>'],
    ['/sort evol 57', 'Usage:\n/sort <nickname>\n/sort <purchase id>'],
    ['/sort my!card', 'Usage:\n/sort <nickname>\n/sort <purchase id>'],
    ['/sort #evol', 'Usage:\n/sort <nickname>\n/sort <purchase id>'],
    ['/sort visa', 'You have no card called visa.'],
    ['/sort 999999999', 'You have no purchase #999999999.'],
    ['/sort #999999999', 'You have no purchase #999999999.'],
  ])('answers "%s" with what is wrong', async (message, reply) => {
    const chat = await chatWithCard()
    await buy(await chat.userId())

    expect(await chat.say(message)).toBe(reply)
  })

  it('has nothing to sort a purchase into when its card is linked to no product, or is not added', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 calendar')
    const userId = await chat.userId()
    const onAmex = await buy(userId, { cardLast4: '0005' })
    const onNone = await buy(userId, { cardLast4: '7777' })

    for (const id of [onAmex, onNone]) {
      expect(await chat.say(`/sort ${id}`)).toBe(
        `#${id} is on a card that is linked to no product, so there is nothing to sort it into.`,
      )
    }
  })
})

describe('what is chosen for a merchant', () => {
  it('is remembered, and is where the later purchases at that merchant start', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const first = await buy(userId, { merchant: 'Corner Cafe' })
    await chat.press(await ask(chat, `/sort ${first}`), 'Phone tap')

    expect(await rememberedBy(userId)).toEqual([{ product: 'uob-evol', merchant: 'Corner Cafe', category: 'mobile' }])

    // The same merchant in any case. Added by hand, as a purchase from an alert is stored: with where it starts.
    const reply = await ask(chat, '/add evol 4.50 CORNER CAFE')
    expect(reply.text).toMatch(/^#\d+ 9 Oct · SGD 4\.50 · CORNER CAFE · by hand\n.*\n#\d+: Phone tap$/)
    expect(reply.buttons).toBeUndefined()
  })

  it('is what was chosen last, and is kept for each product of each user by itself', async () => {
    const [chat, bystander] = [await chatWithCard(), await chatWithCard()]
    const userId = await chat.userId()
    const [first, second] = [await buy(userId), await buy(userId)]

    await chat.press(await ask(chat, `/sort ${first}`), 'Phone tap')
    await chat.press(await ask(chat, `/sort ${second}`), 'Online')

    expect(await rememberedBy(userId)).toEqual([{ product: 'uob-evol', merchant: 'COFFEE PLACE', category: 'online' }])
    expect(await rememberedBy(await bystander.userId())).toEqual([])
    // What one user chose is nothing to another: their purchase at the merchant is left for them to sort.
    expect((await ask(bystander, '/add evol 4.50 COFFEE PLACE')).text).toContain(': not sorted. Which was it?')
  })

  it('changes no other purchase, not even one at the same merchant', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const [first, second, third] = [await buy(userId), await buy(userId), await buy(userId, { category: 'other' })]

    await chat.press(await ask(chat, `/sort ${first}`), 'Online')

    const categories = [await categoryOf(first), await categoryOf(second), await categoryOf(third)]
    expect(categories).toEqual(['online', null, 'other'])
  })

  it('is not remembered for a purchase that names no merchant', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const id = await buy(userId, { merchant: null })

    await chat.press(await ask(chat, `/sort ${id}`), 'Online')

    expect(await categoryOf(id)).toBe('online')
    expect(await rememberedBy(userId)).toEqual([])
  })
})

describe('a press that is refused', () => {
  it("changes nothing when it is for another user's purchase, made under a message of the presser's own", async () => {
    const [owner, other] = [await chatWithCard(), await chatWithCard()]
    const theirs = await buy(await owner.userId())
    const own = await buy(await other.userId(), { merchant: 'BOOK SHOP' })
    const message = await ask(other, `/sort ${own}`)
    const before = message.text

    // What a button under the owner's message would hold, sent from the other user's chat.
    const pressed = await other.pressWith(message, `${theirs}:online`)

    expect(pressed).toEqual({ answer: REFUSED, sent: [] })
    expect(await categoryOf(theirs)).toBeNull()
    expect(await categoryOf(own)).toBeNull()
    expect(message.text).toBe(before)
    expect(labels(message)).toEqual(BUTTONS)
    expect(await rememberedBy(await other.userId())).toEqual([])
    expect(await rememberedBy(await owner.userId())).toEqual([])
  })

  it.each([
    ['a category that only a rule gives', (id: number) => `${id}:fx`],
    ['a category that the product does not have', (id: number) => `${id}:dining`],
    ['a purchase that there is not', () => '999999999:online'],
    ['no category', (id: number) => `${id}`],
    ['words', () => 'online'],
    ['more than a button holds', (id: number) => `${id}:online:next:${id}:mobile`],
    ['nothing', () => ''],
  ])('changes nothing when it brings %s', async (_, data) => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)

    const pressed = await chat.pressWith(message, data(id))

    expect(pressed).toEqual({ answer: REFUSED, sent: [] })
    expect(await categoryOf(id)).toBeNull()
    expect(labels(message)).toEqual(BUTTONS)
  })

  it('changes nothing once the purchase has been taken out, or its card is linked to no product', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const [removed, unlinked] = [await buy(userId), await buy(userId, { merchant: 'BOOK SHOP' })]
    const [first, second] = [await ask(chat, `/sort ${removed}`), await ask(chat, `/sort ${unlinked}`)]

    await chat.say(`/remove ${removed}`)
    expect(await chat.press(first, 'Online')).toEqual({ answer: REFUSED, sent: [] })

    await chat.say('/product evol none')
    expect(await chat.press(second, 'Online')).toEqual({ answer: REFUSED, sent: [] })
    expect(await categoryOf(unlinked)).toBeNull()
  })

  it('is answered, with nothing stored, when it comes from somebody who is not a user', async () => {
    const chat = await chatWithCard()
    const message = await ask(chat, `/sort ${await buy(await chat.userId())}`)
    const stranger = openChat()

    const pressed = await stranger.pressWith(message, message.buttons?.[0][0].data ?? '')

    expect(pressed).toEqual({ answer: REFUSED, sent: [] })
    expect(await userCount(stranger.telegramId)).toBe(0)
  })
})

describe('a press that is ignored', () => {
  it.each<[what: string, chat: (id: number) => { id?: number; type?: string } | undefined]>([
    ['a group chat', () => ({ id: -5001, type: 'group' })],
    ["a private chat that is not the presser's own", (id) => ({ id: id + 1, type: 'private' })],
    ['a chat of no known type', (id) => ({ id })],
    ['no chat at all', () => undefined],
  ])('is one under a message in %s', async (_, chatOf) => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)
    const under = { message_id: message.id, chat: chatOf(chat.telegramId), text: message.text }

    await handleUpdate(deps, {
      callback_query: { id: 'press-ignored', from: { id: chat.telegramId }, data: `${id}:online`, message: under },
    })

    expect(await categoryOf(id)).toBeNull()
    expect(answered).toEqual([])
    expect(sent).toEqual([])
  })

  it('is one that does not say who pressed, or which press it is', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const under = { message_id: 1, chat: { id: chat.telegramId, type: 'private' }, text: 'A line\nAnother' }

    const data = `${id}:online`

    await handleUpdate(deps, { callback_query: { id: 'press-ignored', data, message: under } })
    await handleUpdate(deps, { callback_query: { from: { id: chat.telegramId }, data, message: under } })

    expect(await categoryOf(id)).toBeNull()
    expect(answered).toEqual([])
  })
})

describe('a press', () => {
  it('is acted on once when the same button is pressed twice', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const [first, second] = [await buy(userId), await buy(userId, { merchant: 'BOOK SHOP' })]
    const message = await ask(chat, '/sort evol')
    // The message as it stood when both presses were made: Telegram tells of each with the buttons still there.
    const asItStood = { ...message }

    const once = await chat.press(asItStood, 'Online')
    const twice = await chat.press(asItStood, 'Online')

    expect(once.answer).toBe(`#${first}: Online`)
    expect(once.sent.map((each) => each.text)).toEqual([
      `#${second} 5 Oct · SGD 12.40 · BOOK SHOP\n#${second}: not sorted. Which was it?`,
    ])
    // The second is answered with where the purchase is. It edits nothing, and sends no second copy of what follows.
    expect(twice).toEqual({ answer: `#${first}: Online`, sent: [] })
    expect(posted.filter((each) => each.text.includes(`#${second}`))).toHaveLength(1)
  })

  it('moves the purchase when another button is pressed after the first', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const asItStood = { ...(await ask(chat, `/sort ${id}`)) }

    await chat.press(asItStood, 'Online')
    const again = await chat.press(asItStood, 'Phone tap')

    expect(again.answer).toBe(`#${id}: Phone tap`)
    expect(await categoryOf(id)).toBe('mobile')
  })

  it('sorts the purchase, and leaves the message as it is, when Telegram no longer gives its text', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)
    const before = message.text
    // Of a message that it can no longer get at, Telegram gives the chat and the id, and nothing else.
    const under = { message_id: message.id, chat: { id: chat.telegramId, type: 'private' }, date: 0 }

    await handleUpdate(deps, {
      callback_query: { id: 'press-old', from: { id: chat.telegramId }, data: `${id}:online`, message: under },
    })

    expect(answered).toEqual([{ pressId: 'press-old', text: `#${id}: Online` }])
    expect(await categoryOf(id)).toBe('online')
    expect(message.text).toBe(before)
  })

  it('keeps every line of the message but the last, with what was marked in them', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { merchant: '𝒳 /start https://attacker.test' })
    // As the message of a purchase from an alert is: the purchase, the running total, and where it is sorted.
    const reply = await ask(chat, '/add evol 3.00 𝒳 /start https://attacker.test')
    const [purchased, total] = reply.text.split('\n')

    await chat.press(reply, 'Online')

    expect(reply.text).toMatch(new RegExp(`^.*\\n.*\\n#\\d+: Online$`))
    expect(reply.text.split('\n').slice(0, 2)).toEqual([purchased, total])
    expect(markedIn(reply)).toEqual(['𝒳 /start https://attacker.test'])
    expect(await categoryOf(id)).toBeNull()
  })

  it('takes six queries and three requests to Telegram at its most: with the next purchase to follow it', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    await buy(userId)
    await buy(userId, { merchant: 'BOOK SHOP' })
    const message = await ask(chat, '/sort evol')
    const queried = vi.spyOn(env.DB, 'prepare')
    const [answer, edit, send] = [
      vi.spyOn(deps.messenger, 'answer'),
      vi.spyOn(deps.messenger, 'edit'),
      vi.spyOn(deps.messenger, 'send'),
    ]

    await chat.press(message, 'Online')

    // The user, the purchase, the cards, the sorting, the choice to remember, and the next unsorted purchase.
    expect(queried).toHaveBeenCalledTimes(6)
    // Each of these is one request: see the messenger's own test, in webhook.test.ts.
    expect([answer, edit, send].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1])
  })

  it("sorts a user's own purchases only, when two users sort at once", async () => {
    const [first, second] = [await chatWithCard(), await chatWithCard()]
    const [firstId, secondId] = [await buy(await first.userId()), await buy(await second.userId())]
    const [toFirst, toSecond] = [await ask(first, '/sort evol'), await ask(second, '/sort evol')]

    await Promise.all([first.press(toFirst, 'Online'), second.press(toSecond, "Doesn't count")])

    expect([await categoryOf(firstId), await categoryOf(secondId)]).toEqual(['online', 'excluded'])
    expect(await storeFor(env.DB, await first.userId()).findTransaction(secondId)).toBeNull()
    expect(toFirst.text).toContain(`#${firstId}: Online`)
    expect(toSecond.text).toContain(`#${secondId}: Doesn't count`)
  })
})
