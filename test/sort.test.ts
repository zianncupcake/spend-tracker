import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { storeFor } from '../src/store'
import { ChatBlockedError, TelegramError } from '../src/telegram/api'
import { handleUpdate } from '../src/telegram/handler'
import { PRESS_FAILED, SORT_USAGE } from '../src/telegram/texts'
import { answered, deps, openChat, sent, type Posted } from './connect-helpers'
import { buy, linesOf, marksOf, userCount } from './helpers'
import { catchConsole } from './log-helpers'

// Moving purchases between the categories of a card's product: /sort, and the buttons under the bot's messages. On
// the UOB EVOL Card a purchase is online until its user marks it otherwise, as made with the physical card for
// one, with a button for each other category. The clock stands at 12:00 on 9 October 2026 in Singapore.

/** What the bank calls the two categories: the one that a purchase is in until it is flagged, and the one after. */
const ONLINE = 'Online / Mobile Contactless Spend'
const OTHER = 'Other Spend'

const FLAG = `Mark as ${OTHER}`
const UNFLAG = `Mark as ${ONLINE}`
const REFUSED = 'That button no longer works.'

/** The categories that the buttons under an online purchase, and under a flagged one, move it to. */
const FROM_ONLINE = ['selected', 'other', 'fx']
const FROM_OTHER = ['online', 'selected', 'fx']

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

function markedIn({ text, entities = [] }: Posted): string[] {
  return entities.map(({ offset, length }) => text.slice(offset, offset + length))
}

/** The category that is stored for a purchase. It reads the table directly, to see what is stored. */
async function categoryOf(purchaseId: number): Promise<string | null | undefined> {
  const row = await env.DB.prepare('SELECT category FROM transactions WHERE id = ?').bind(purchaseId).first<{
    category: string | null
  }>()
  return row?.category
}

describe('/sort with a card', () => {
  it('says where every purchase counts unless it is marked otherwise, and how to mark one', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())

    const message = await ask(chat, '/sort evol')

    expect(message.text).toBe(
      'Every purchase on evol ••••1234 counts as Online / Mobile Contactless Spend unless it is marked otherwise. ' +
        'Other Spend is where a purchase made with the physical card goes. ' +
        'To mark one, send /sort <purchase id>. /spend evol shows the ids.',
    )
    // There is no purchase to go through, so nothing to press and nothing changed.
    expect(message.buttons).toBeUndefined()
    expect(await categoryOf(id)).toBeNull()
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
  it('shows a purchase that nothing is stored for as online, with a button for each other category of its product', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { parser: 'manual' })

    const message = await ask(chat, `/sort ${id}`)

    expect(message.text).toBe(`ID ${id} · 5 Oct · SGD 12.40 · COFFEE PLACE · by hand\nID ${id}: ${ONLINE}`)
    expect(markedIn(message)).toEqual(['COFFEE PLACE'])
    expect(message.buttons?.flat().map((button) => button.data)).toEqual([`${id}:selected`, `${id}:other`, `${id}:fx`])
  })

  it('flags the purchase when the button is pressed, says so in the message, and changes the buttons', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const id = await buy(userId)
    const untouched = await buy(userId, { merchant: 'BOOK SHOP' })
    // With a # before the id, which is taken as the id alone is.
    const message = await ask(chat, `/sort #${id}`)

    const pressed = await chat.press(message, FLAG)

    expect(pressed).toEqual({ answer: `ID ${id}: ${OTHER}`, sent: [] })
    expect(await categoryOf(id)).toBe('other')
    // The message now ends with where the purchase is. The merchant's name is still marked.
    expect(message.text).toBe(`ID ${id} · 5 Oct · SGD 12.40 · COFFEE PLACE\nID ${id}: ${OTHER}`)
    expect(markedIn(message)).toEqual(['COFFEE PLACE'])
    expect(marksOf(message)).toEqual(FROM_OTHER)
    expect(await categoryOf(untouched)).toBeNull()
  })

  it('takes the flag off again when the other button is pressed, and changes the buttons back', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)
    await chat.press(message, FLAG)

    const pressed = await chat.press(message, UNFLAG)

    expect(pressed).toEqual({ answer: `ID ${id}: ${ONLINE}`, sent: [] })
    expect(await categoryOf(id)).toBe('online')
    expect(message.text).toBe(`ID ${id} · 5 Oct · SGD 12.40 · COFFEE PLACE\nID ${id}: ${ONLINE}`)
    expect(marksOf(message)).toEqual(FROM_ONLINE)

    // And so on, as often as it is pressed.
    await chat.press(message, FLAG)
    expect(await categoryOf(id)).toBe('other')
    expect(marksOf(message)).toEqual(FROM_OTHER)
  })

  it('moves a purchase of an earlier window too', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { at: '2026-08-20T10:00:00+08:00' })

    const message = await ask(chat, `/sort ${id}`)
    await chat.press(message, FLAG)

    expect(message.text).toBe(`ID ${id} · 20 Aug · SGD 12.40 · COFFEE PLACE\nID ${id}: ${OTHER}`)
  })

  it('goes by the card when a card has a number for a nickname, and by the purchase when the id has a #', async () => {
    const chat = openChat()
    await chat.say('/addcard 2024 1234 calendar uob-evol')
    const id = await buy(await chat.userId())

    expect(await chat.say('/sort 2024')).toContain(`Every purchase on 2024 ••••1234 counts as ${ONLINE}`)
    expect((await ask(chat, `/sort #${id}`)).text).toContain(`ID ${id}: ${ONLINE}`)
  })

  it.each([
    ['/sort evol 57', SORT_USAGE],
    ['/sort #evol', SORT_USAGE],
    ['/sort visa', 'You have no card called visa.'],
    ['/sort 999999999', 'You have no purchase with ID 999999999.'],
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
        `ID ${id} is on a card that is linked to no product, so there is nothing to sort it into.`,
      )
    }
  })
})

describe('a flag', () => {
  it('is of the one purchase: a later purchase at the same merchant starts online, as any other does', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const flagged = await buy(userId, { merchant: 'Corner Cafe' })
    await chat.press(await ask(chat, `/sort ${flagged}`), FLAG)
    expect(await categoryOf(flagged)).toBe('other')

    // The same merchant, as it was written and in another case.
    const replies = [await ask(chat, '/add evol 4.50 Corner Cafe'), await ask(chat, '/add evol 4.50 CORNER CAFE')]

    for (const reply of replies) {
      expect(reply.text).toMatch(/\nID \d+: Online \/ Mobile Contactless Spend$/)
      expect(marksOf(reply)).toEqual(FROM_ONLINE)
    }
    // Nothing is stored for where the later two are, and the first is still the one that is flagged.
    const { results } = await env.DB.prepare('SELECT category FROM transactions WHERE owner_id = ? ORDER BY id')
      .bind(userId)
      .all()
    expect(results).toEqual([{ category: 'other' }, { category: null }, { category: null }])
  })

  it('changes no other purchase, not even one at the same merchant', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const [first, second, third] = [await buy(userId), await buy(userId), await buy(userId, { category: 'online' })]

    await chat.press(await ask(chat, `/sort ${first}`), FLAG)

    const categories = [await categoryOf(first), await categoryOf(second), await categoryOf(third)]
    expect(categories).toEqual(['other', null, 'online'])
  })

  it('is put on a purchase that names no merchant too', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { merchant: null })

    await chat.press(await ask(chat, `/sort ${id}`), FLAG)

    expect(await categoryOf(id)).toBe('other')
  })

  it('moves the one purchase that a rule placed, and the rule goes on placing the later ones', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { merchant: 'NETFLIX.COM', category: 'selected' })

    const pressed = await chat.press(await ask(chat, `/sort ${id}`), FLAG)

    expect(pressed.answer).toBe(`ID ${id}: ${OTHER}`)
    expect(await categoryOf(id)).toBe('other')
    // The next purchase there starts where the rule puts it.
    const reply = await ask(chat, '/add evol 15.98 NETFLIX.COM')
    expect(reply.text).toMatch(/\nID \d+: Selected Gym, Telco and Streaming Spend$/)
    expect(marksOf(reply)).toEqual(['online', 'other', 'fx'])
  })

  it('takes an SGD purchase out of Online when it is marked as foreign currency spend, and off what Online has spent', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    await buy(userId, { amountMinor: 2000 })
    const id = await buy(userId, { merchant: 'BOOK SHOP', amountMinor: 1500 })
    /** The lines of /spend evol for a group: its name, its purchases, and its total. */
    const group = async (name: string) => {
      const lines = linesOf(await chat.rich('/spend evol'))
      const start = lines.indexOf(name)
      return lines.slice(start, lines.findIndex((line, at) => at > start && line.startsWith('Total | ')) + 1)
    }
    expect((await group('Online and Mobile Contactless Spend')).at(-1)).toBe('Total | 35.00')

    await chat.pressWith(await ask(chat, `/sort ${id}`), `${id}:fx`)

    expect(await categoryOf(id)).toBe('fx')
    expect((await group('Online and Mobile Contactless Spend')).at(-1)).toBe('Total | 20.00')
    expect(await group('Overseas Foreign Currency Spend')).toContain(`${id} | 5 Oct | 15.00 | BOOK SHOP`)
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
    const pressed = await other.pressWith(message, `${theirs}:other`)

    expect(pressed).toEqual({ answer: REFUSED, sent: [] })
    expect(await categoryOf(theirs)).toBeNull()
    expect(await categoryOf(own)).toBeNull()
    expect(message.text).toBe(before)
    expect(marksOf(message)).toEqual(FROM_ONLINE)
  })

  it.each([
    ['a category that the product does not have', (id: number) => `${id}:dining`],
    ['a purchase that there is not', () => '999999999:other'],
    ['more than a button holds', (id: number) => `${id}:other:next`],
  ])('changes nothing when it brings %s', async (_, data) => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)

    const pressed = await chat.pressWith(message, data(id))

    expect(pressed).toEqual({ answer: REFUSED, sent: [] })
    expect(await categoryOf(id)).toBeNull()
    expect(marksOf(message)).toEqual(FROM_ONLINE)
  })

  it('changes nothing once the purchase has been taken out, or its card is linked to no product', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const [removed, unlinked] = [await buy(userId), await buy(userId, { merchant: 'BOOK SHOP' })]
    const [first, second] = [await ask(chat, `/sort ${removed}`), await ask(chat, `/sort ${unlinked}`)]

    await chat.say(`/remove ${removed}`)
    expect(await chat.press(first, FLAG)).toEqual({ answer: REFUSED, sent: [] })

    await chat.say('/product evol none')
    expect(await chat.press(second, FLAG)).toEqual({ answer: REFUSED, sent: [] })
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
  it.each<[what: string, chat: (id: number) => { id?: number; type?: string } | undefined, why: string]>([
    ['a group chat', () => ({ id: -5001, type: 'group' }), 'not_private'],
    ["a private chat that is not the presser's own", (id) => ({ id: id + 1, type: 'private' }), 'not_own_chat'],
    ['no chat at all', () => undefined, 'not_private'],
  ])('is one under a message in %s, which is logged with why', async (_, chatOf, why) => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)
    const under = { message_id: message.id, chat: chatOf(chat.telegramId), text: message.text }
    const logged = catchConsole()

    await handleUpdate(deps, {
      callback_query: { id: 'press-ignored', from: { id: chat.telegramId }, data: `${id}:other`, message: under },
    })

    expect(await categoryOf(id)).toBeNull()
    expect(answered).toEqual([])
    expect(sent).toEqual([])
    expect(logged.events()).toEqual([{ event: 'update', kind: 'press', outcome: 'ignored', why, ms: 0 }])
  })

  it('is one that does not say who pressed, or which press it is', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const under = { message_id: 1, chat: { id: chat.telegramId, type: 'private' }, text: 'A line\nAnother' }
    const logged = catchConsole()

    const data = `${id}:other`

    await handleUpdate(deps, { callback_query: { id: 'press-ignored', data, message: under } })
    await handleUpdate(deps, { callback_query: { from: { id: chat.telegramId }, data, message: under } })

    expect(await categoryOf(id)).toBeNull()
    expect(answered).toEqual([])
    // A press that names nobody is in nobody's own chat, and one with no id is one that cannot be answered.
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'press', outcome: 'ignored', why: 'not_own_chat', ms: 0 },
      { event: 'update', kind: 'press', outcome: 'ignored', why: 'no_id', ms: 0 },
    ])
  })
})

describe('a press that fails', () => {
  it('is answered with that something went wrong when it fails before it is answered, so that its button stops waiting', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { merchant: 'PRIVATE CLINIC' })
    const message = await ask(chat, `/sort ${id}`)
    const prepare = env.DB.prepare.bind(env.DB)
    const failing = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('FROM transactions')) throw new Error('a made-up failure that quotes: PRIVATE CLINIC')
      return prepare(query)
    })
    const logged = catchConsole()

    const pressed = await chat.press(message, FLAG)
    failing.mockRestore()

    expect(pressed).toEqual({ answer: PRESS_FAILED, sent: [] })
    expect(answered).toHaveLength(1)
    expect(await categoryOf(id)).toBeNull()
    expect(marksOf(message)).toEqual(FROM_ONLINE)
    // The log has that a press failed before its purchase was moved, and that it was answered so: the name of the
    // error, and nothing of the press.
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'press', outcome: 'failed', handled: false, told: true, ms: 0, error: 'Error' },
    ])
    for (const text of ['PRIVATE', 'press-', ':other', String(chat.telegramId)]) {
      expect(logged.text()).not.toContain(text)
    }
  })

  it('is answered so when it is the answer that Telegram did not take, as it may take the next', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)
    const refusal = new TelegramError('answerCallbackQuery', 502)
    const answer = vi.spyOn(deps.messenger, 'answer').mockRejectedValueOnce(refusal)
    const logged = catchConsole()

    const pressed = await chat.press(message, FLAG)

    // The purchase was moved before the answer failed. Its message is left as it was, and the press that follows
    // brings it up to date.
    expect(answer.mock.calls.map(([, text]) => text)).toEqual([`ID ${id}: ${OTHER}`, PRESS_FAILED])
    expect(pressed).toEqual({ answer: PRESS_FAILED, sent: [] })
    expect(await categoryOf(id)).toBe('other')
    expect(marksOf(message)).toEqual(FROM_ONLINE)
    // The log has that the press had been handled when it failed: what it asked for was done.
    const failure = { error: 'Error', reason: 'http_error', status: 502 }
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'press', outcome: 'failed', handled: true, told: true, ms: 0, ...failure },
    ])
  })

  it('is answered with nothing when its chat is one that Telegram will send nothing to', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)
    const answer = vi.spyOn(deps.messenger, 'answer').mockRejectedValue(new ChatBlockedError())
    const logged = catchConsole()

    await chat.press(message, FLAG)

    expect(answer).toHaveBeenCalledTimes(1)
    const failure = { error: 'ChatBlockedError', reason: 'chat_blocked' }
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'press', outcome: 'failed', handled: true, told: false, ms: 0, ...failure },
    ])
  })
})

describe('a press', () => {
  it('stores nothing when it is for online, on a purchase that is online with nothing stored for it', async () => {
    const chat = await chatWithCard()
    const untouched = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${untouched}`)

    // What no button under the message holds.
    const pressed = await chat.pressWith(message, `${untouched}:online`)

    expect(pressed).toEqual({ answer: `ID ${untouched}: ${ONLINE}`, sent: [] })
    expect(await categoryOf(untouched)).toBeNull()
    expect(marksOf(message)).toEqual(FROM_ONLINE)
  })

  it('is carried through again when the same button is pressed twice, with the purchase moved once', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const id = await buy(userId)
    const message = await ask(chat, `/sort ${id}`)
    // The message as it stood when both presses were made: Telegram tells of each with the button as it was.
    const asItStood = { ...message }

    const once = await chat.press(asItStood, FLAG)
    const twice = await chat.press(asItStood, FLAG)

    expect(once).toEqual({ answer: `ID ${id}: ${OTHER}`, sent: [] })
    // The second cannot be told from a press that comes after Telegram failed the first, so it does what that one
    // would: it leaves the message as the first press made it.
    expect(twice).toEqual(once)
    expect(message.text).toBe(`ID ${id} · 5 Oct · SGD 12.40 · COFFEE PLACE\nID ${id}: ${OTHER}`)
    expect(marksOf(message)).toEqual(FROM_OTHER)
    expect(await categoryOf(id)).toBe('other')
  })

  it('brings the message up to date when Telegram failed the edit of its first', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)
    // The purchase is flagged, and then Telegram does not take the edit of the message.
    vi.spyOn(deps.messenger, 'edit').mockRejectedValueOnce(new TelegramError('editMessageText', 400))
    const logged = catchConsole()
    const failed = await chat.press(message, FLAG)
    // The press had its answer before the edit failed, and Telegram takes one answer to a press: so it is not
    // answered again, with that something went wrong. The log has that the update failed once the press had been
    // handled, and that nobody was told.
    expect(failed).toEqual({ answer: `ID ${id}: ${OTHER}`, sent: [] })
    expect(answered).toHaveLength(1)
    const failure = { error: 'Error', reason: 'http_error', status: 400 }
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'press', outcome: 'failed', handled: true, told: false, ms: 0, ...failure },
    ])
    expect(await categoryOf(id)).toBe('other')
    expect(message.text).toBe(`ID ${id} · 5 Oct · SGD 12.40 · COFFEE PLACE\nID ${id}: ${ONLINE}`)
    expect(marksOf(message)).toEqual(FROM_ONLINE)

    // The message still has the button that flags, so the same one is pressed again.
    const again = await chat.press(message, FLAG)

    expect(again).toEqual({ answer: `ID ${id}: ${OTHER}`, sent: [] })
    expect(message.text).toBe(`ID ${id} · 5 Oct · SGD 12.40 · COFFEE PLACE\nID ${id}: ${OTHER}`)
    expect(marksOf(message)).toEqual(FROM_OTHER)
  })

  it('moves the purchase when the other button is pressed after the first, under a message that had both', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { merchant: 'NETFLIX.COM', category: 'selected' })
    const asItStood = { ...(await ask(chat, `/sort ${id}`)) }

    await chat.press(asItStood, UNFLAG)
    const again = await chat.press(asItStood, FLAG)

    expect(again.answer).toBe(`ID ${id}: ${OTHER}`)
    expect(await categoryOf(id)).toBe('other')
  })

  it('moves the purchase, and leaves the message as it is, when Telegram no longer gives its text', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId())
    const message = await ask(chat, `/sort ${id}`)
    const before = message.text
    // Of a message that it can no longer get at, Telegram gives the chat and the id, and nothing else.
    const under = { message_id: message.id, chat: { id: chat.telegramId, type: 'private' }, date: 0 }

    await handleUpdate(deps, {
      callback_query: { id: 'press-old', from: { id: chat.telegramId }, data: `${id}:other`, message: under },
    })

    expect(answered).toEqual([{ pressId: 'press-old', text: `ID ${id}: ${OTHER}` }])
    expect(await categoryOf(id)).toBe('other')
    expect(message.text).toBe(before)
    expect(marksOf(message)).toEqual(FROM_ONLINE)
  })

  it('keeps every line of the message but the last, with what was marked in them', async () => {
    const chat = await chatWithCard()
    const id = await buy(await chat.userId(), { merchant: '𝒳 /start https://attacker.test' })
    // As the message of a purchase from an alert is: the purchase, the running total, and where it is sorted.
    const reply = await ask(chat, '/add evol 3.00 𝒳 /start https://attacker.test')
    const [purchased, total] = reply.text.split('\n')

    await chat.press(reply, FLAG)

    expect(reply.text).toMatch(new RegExp(`^.*\\n.*\\nID \\d+: Other Spend$`))
    expect(reply.text.split('\n').slice(0, 2)).toEqual([purchased, total])
    expect(markedIn(reply)).toEqual(['𝒳 /start https://attacker.test'])
    expect(await categoryOf(id)).toBeNull()
  })

  it("moves a user's own purchases only, when two users press at once", async () => {
    const [first, second] = [await chatWithCard(), await chatWithCard()]
    const firstId = await buy(await first.userId())
    const secondId = await buy(await second.userId(), { category: 'other' })
    const [toFirst, toSecond] = [await ask(first, `/sort ${firstId}`), await ask(second, `/sort ${secondId}`)]

    await Promise.all([first.press(toFirst, FLAG), second.press(toSecond, UNFLAG)])

    expect([await categoryOf(firstId), await categoryOf(secondId)]).toEqual(['other', 'online'])
    expect(await storeFor(env.DB, await first.userId()).findTransaction(secondId)).toBeNull()
    expect(toFirst.text).toContain(`ID ${firstId}: ${OTHER}`)
    expect(toSecond.text).toContain(`ID ${secondId}: ${ONLINE}`)
    expect([marksOf(toFirst), marksOf(toSecond)]).toEqual([FROM_OTHER, FROM_ONLINE])
  })
})
