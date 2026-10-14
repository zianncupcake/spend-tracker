import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as assistant from '../src/ai/assistant'
import type { Action, Answer } from '../src/ai/assistant'
import { userOfToken } from '../src/mcp/tokens'
import { TelegramError, type RichMessage } from '../src/telegram/api'
import { noSuchProduct } from '../src/telegram/arguments'
import { handleUpdate } from '../src/telegram/handler'
import {
  CANCELLED,
  DOING,
  NO_CARDS,
  NO_PURCHASES_SAID,
  NOT_DONE,
  SEE_REPLY,
  SORTED_AGAIN,
  WILL_SORT_AGAIN,
} from '../src/telegram/texts'
import { connectedChat, connectionOf, deps, openChat, sentRich, signIn, type Posted } from './connect-helpers'
import {
  bold,
  buy,
  CARDS_HEADER,
  headerRow,
  linesOf,
  plain,
  purchaseRow,
  rowsOwnedBy,
  sumRow,
  tableOf,
  userCount,
} from './helpers'
import { catchConsole } from './log-helpers'
import {
  bought,
  BY_HAND,
  chatWithCard,
  chatWithCards,
  labels,
  markedIn,
  MESSAGE,
  read,
  REFUSED,
  rowsOf,
  unsure,
  type Chat,
} from './photo-helpers'

// What the bot does when its assistant makes out, in a message, things for the bot to do: the spending that it
// shows, the purchases that it adds, the purchases that it sorts and the commands that it runs, what it asks about
// before it does it, and what the press of a button then does. The assistant is a model's work and is stood in for:
// a test says what the assistant made of a message, and the tests are of what the bot then does.
// test/assistant-actions.test.ts has the assistant's half. The chats, the clock and the service are those of
// ./connect-helpers: it is 12:00 on 9 October 2026 in Singapore.

const DELETE_WARNING =
  'This deletes your cards and every purchase stored for you, and cannot be undone. Send /delete confirm to go ahead.'
const TOKYO = "Your time zone is now Asia/Tokyo. Your cards' cycles and months begin and end by it."

/** The stand-in for the assistant. With nothing said, a test is to have nothing asked of it. */
let answering: MockInstance<typeof assistant.answerQuestion>

beforeEach(() => {
  const unexpected = new Error('A test had the assistant asked what it should not have')
  answering = vi.spyOn(assistant, 'answerQuestion').mockRejectedValue(unexpected)
})

/**
 * Has the assistant make these actions of every message that follows, after one request and a call for each. `how`
 * says what the answer has besides: whether the model had read before it asked for them, and how many of its calls
 * the assistant did not hand on. The model says with none of them that there is more to do: test/assistant.test.ts
 * has a message whose things come an answer at a time.
 */
function actingWith(how: { afterReading?: boolean; dropped?: number }, ...actions: Action[]): void {
  const { afterReading = false, dropped = 0 } = how
  answering.mockImplementation(async (_deps, _provider, _user, _question, taken) => {
    taken.requests++
    taken.tool_calls += actions.length
    return { status: 'acting', actions, afterReading, dropped, more: false }
  })
}

/** The same, for a model that had read nothing, all of whose calls were handed on. */
function acting(...actions: Action[]): void {
  actingWith({}, ...actions)
}

/** An action that runs a command, by the line that the model gave for it. */
function command(line: string): Action {
  return { kind: 'command', line }
}

/**
 * Sends the bot a message, and returns what it has left in the chat for it when it is done: its rich messages and
 * its messages of text, each in their order. The placeholder is among the messages of text only when it is still
 * there. What the message says is nothing to these tests: what the assistant made of it is.
 */
async function told(chat: Chat, messageId?: number): Promise<{ rich: RichMessage[]; texts: Posted[] }> {
  const beforeRich = sentRich.length
  const texts = await chat.ask('made-up words', messageId)
  return { rich: sentRich.splice(beforeRich).map(({ message }) => message), texts }
}

/** Has a command asked about, and returns the message that asks, with its buttons. */
async function askedAbout(chat: Chat, line: string): Promise<Posted> {
  acting(command(line))
  const { texts } = await told(chat)
  expect(texts).toHaveLength(1)
  return texts[0]
}

/** The buttons under a message that asks before a command is run, with what each holds. */
function buttonsFor(line: string) {
  return [[{ text: 'Do it', data: `do:${line}` }], [{ text: 'Cancel', data: `no:${line}` }]]
}

/** The lines that the log has of one message whose actions were all carried out, in no time by this clock. */
function loggedFor(user: number, actions: object[]) {
  const question = { user, outcome: 'acted', sent: 'text', placeholder: true, requests: 1, tool_calls: actions.length }
  return [
    { event: 'update', kind: 'question', outcome: 'deferred', ms: 0 },
    ...actions.map((action) => ({ event: 'action', user, ...action })),
    { event: 'question', ...question, actions: actions.length, ms: 0 },
  ]
}

describe('what was spent, when the assistant makes out that it is to be shown', () => {
  it('is shown as /spend with the card shows it, when a card is named: in the bot’s own table, which ends with its total', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    // Two purchases on visa, which is linked to no product, and one on the other card.
    const coffee = await buy(userId)
    const books = await buy(userId, { at: '2026-10-08T10:00:00+08:00', amountMinor: 7700, merchant: 'BOOK SHOP' })
    await buy(userId, { cardLast4: '5678', merchant: 'ON ANOTHER CARD' })
    acting({ kind: 'show', card: 'visa' })
    const logged = catchConsole()

    const { rich, texts } = await told(chat)

    // One rich message is all that the chat is left with: the placeholder is gone, and there is no text beside it.
    const [shown, ...more] = rich
    expect(more).toEqual([])
    expect(texts).toEqual([])
    // A card with no product has one table, of all its purchases, which ends with what they come to.
    expect(shown.blocks).toContainEqual(
      tableOf(
        headerRow('SGD'),
        purchaseRow(coffee, '5 Oct', '12.40', 'COFFEE PLACE'),
        purchaseRow(books, '8 Oct', '77.00', 'BOOK SHOP'),
        sumRow('Total', '89.40'),
      ),
    )
    expect(logged.events()).toEqual([
      ...loggedFor(userId, [{ kind: 'show', outcome: 'done' }]).slice(0, 2),
      { ...loggedFor(userId, [{}])[2], sent: 'rich' },
    ])
    // It is the reply to /spend with that card, whole.
    expect(shown).toEqual(await chat.rich('/spend visa'))
  })

  it('is shown for every card when none is named, each in a message of its own and in the order of the cards: with nothing asked first, whatever the model had read', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    await buy(userId)
    await buy(userId, { cardLast4: '5678', merchant: 'TEA HOUSE' })
    actingWith({ afterReading: true }, { kind: 'show' })

    const { rich, texts } = await told(chat)

    expect(texts).toEqual([])
    expect(rich.map(({ blocks }) => blocks[0])).toEqual([
      bold('visa ••••1234: 1 Oct to 31 Oct'),
      bold('evol ••••5678: 1 Oct to 31 Oct'),
    ])
    // Each is the reply to /spend with its card, whole.
    expect(rich).toEqual([await chat.rich('/spend visa'), await chat.rich('/spend evol')])
  })

  it('is shown in full for five cards at the most: a user with six is shown what /spend with no card named shows, which is one table of them all', async () => {
    const chat = openChat()
    for (let card = 1; card <= 5; card++) await chat.say(`/addcard card-${card} 000${card} calendar`)
    await buy(await chat.userId(), { cardLast4: '0003' })
    acting({ kind: 'show' })

    expect((await told(chat)).rich).toHaveLength(5)

    await chat.say('/addcard card-6 0006 calendar')
    const { rich, texts } = await told(chat)

    // One rich message, and not six: a table with a row for each card.
    const [shown, ...more] = rich
    expect(more).toEqual([])
    expect(texts).toEqual([])
    expect(linesOf(shown)).toHaveLength(1 + 6 + 2)
    expect(linesOf(shown)).toContain('card-3 | SGD 12.40 | 1 | 29 Sep to 29 Oct | 1 Nov')
    expect(shown).toEqual(await chat.rich('/spend'))
  })

  it('is answered with how to add a card, for a user who has none', async () => {
    const chat = openChat()
    acting({ kind: 'show' })
    const logged = catchConsole()

    const { rich, texts } = await told(chat)

    expect(rich).toEqual([])
    expect(texts.map((message) => message.text)).toEqual([NO_CARDS])
    const refused = { event: 'action', user: await chat.userId(), kind: 'show', outcome: 'refused' }
    expect(logged.events('action')).toEqual([refused])
  })

  it('is not shown for a card that its user has not got: the nickname is a model’s text, and is not said back', async () => {
    const chat = await chatWithCard()
    acting({ kind: 'show', card: 'amex' })

    const { rich, texts } = await told(chat)

    expect(rich).toEqual([])
    expect(texts.map((message) => message.text)).toEqual([NOT_DONE])
  })
})

describe('purchases that the assistant makes out in a message', () => {
  it('are added as those of a photo are: stored under the id of the message, and told of in a table with their ids', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    acting({
      kind: 'add',
      reading: read([bought(520, 'LUNCH'), bought(300, 'TEA HOUSE')], { card: 'evol', category: 'other' }),
    })
    // What is stored by the time the placeholder is made to say something else.
    let storedBy: number | undefined
    const edited = vi.spyOn(deps.messenger, 'edit').mockImplementation(async () => {
      storedBy = (await rowsOf(userId)).length
    })
    const logged = catchConsole()

    const { rich, texts } = await told(chat, MESSAGE)

    const rows = await rowsOf(userId)
    const stored = { card_last4: '5678', currency: 'SGD', parser: 'manual', category: 'other', removed_at: null }
    expect(rows).toMatchObject([
      { ...stored, source_id: 'manual:7001:0', amount_minor: 520, merchant: 'LUNCH' },
      { ...stored, source_id: 'manual:7001:1', amount_minor: 300, merchant: 'TEA HOUSE' },
    ])
    expect(rich.map((message) => message.blocks)).toEqual([
      [
        bold('Added to evol ••••5678 as Other Spend:'),
        tableOf(
          headerRow('SGD'),
          purchaseRow(`${rows[0].id}*`, '5 Oct', '5.20', 'LUNCH'),
          purchaseRow(`${rows[1].id}*`, '5 Oct', '3.00', 'TEA HOUSE'),
          sumRow('Total', '8.20'),
        ),
        BY_HAND,
        plain('evol ••••5678: SGD 8.20 in 2 purchases, resets 1 Nov'),
      ],
    ])
    // The table is all that the chat is left with. The placeholder said to ask again, so it was made to say
    // otherwise before anything was stored.
    expect(texts).toEqual([])
    expect(edited.mock.calls.map(([, , text]) => text)).toEqual([DOING])
    expect(storedBy).toBe(0)
    expect(logged.events()).toEqual([
      ...loggedFor(userId, [{ kind: 'add', outcome: 'done', stored: 2, held: 0 }]).slice(0, 2),
      { ...loggedFor(userId, [{}])[2], sent: 'rich' },
    ])
  })

  it('are none when the assistant found none to add, which is said in one line', async () => {
    const chat = await chatWithCard()
    acting({ kind: 'add', reading: { status: 'nothing' } })

    const { rich, texts } = await told(chat)

    expect(rich).toEqual([])
    expect(texts.map((message) => message.text)).toEqual([NO_PURCHASES_SAID])
    expect(await rowsOf(await chat.userId())).toEqual([])
  })
})

describe('purchases that the assistant is asked to sort', () => {
  it('are moved as a press of "Mark as" moves one, each with a line that says where it now is', async () => {
    const [chat, other] = [await chatWithCard(), await chatWithCard()]
    const [userId, otherId] = [await chat.userId(), await other.userId()]
    const [mine, alsoMine] = [await buy(userId, { cardLast4: '5678' }), await buy(userId, { cardLast4: '5678' })]
    // A purchase of somebody else's, on a card of the same digits.
    const theirs = await buy(otherId, { cardLast4: '5678' })
    acting({ kind: 'category', ids: [mine, theirs, alsoMine], category: 'other' })
    const logged = catchConsole()

    const { rich, texts } = await told(chat)

    expect(rich).toEqual([])
    expect(texts.map((message) => message.text)).toEqual([
      `ID ${mine}: Other Spend\nYou have no purchase with ID ${theirs}.\nID ${alsoMine}: Other Spend`,
    ])
    expect(texts[0].buttons).toBeUndefined()
    expect((await rowsOf(userId)).map((row) => row.category)).toEqual(['other', 'other'])
    // The purchase that is not the user's is where it was.
    expect(await rowsOf(otherId)).toMatchObject([{ id: theirs, category: null }])
    expect(logged.events()).toEqual(loggedFor(userId, [{ kind: 'category', outcome: 'done' }]))
  })

  it('are not moved to a category that cannot be chosen for their card’s product: one that only a rule of the product gives', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const purchase = await buy(userId, { cardLast4: '5678' })
    acting({ kind: 'category', ids: [purchase], category: 'fx' })
    const logged = catchConsole()

    const { texts } = await told(chat)

    expect(texts.map((message) => message.text)).toEqual([
      `ID ${purchase} was not moved: a purchase on evol ••••5678 cannot be marked as that. ` +
        `Send /sort ${purchase} for what it can be marked as.`,
    ])
    expect(await rowsOf(userId)).toMatchObject([{ id: purchase, category: null }])
    expect(logged.events('action')).toEqual([{ event: 'action', user: userId, kind: 'category', outcome: 'refused' }])
  })
})

describe('a command that the assistant gives to be run', () => {
  it('is run at once, as if its user had sent it, when it is one that can be undone in a step: /timezone', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    acting(command('/timezone Asia/Tokyo'))
    const logged = catchConsole()

    const { rich, texts } = await told(chat)

    expect(rich).toEqual([])
    expect(texts.map((message) => message.text)).toEqual([TOKYO])
    expect(await chat.say('/timezone')).toContain('Your time zone is Asia/Tokyo.')
    expect(logged.events().slice(0, 3)).toEqual(
      loggedFor(userId, [{ kind: 'command', command: 'timezone', outcome: 'done' }]),
    )
  })

  it('is run at once when it is /best, which only shows', async () => {
    const chat = await chatWithCard()
    acting(command('/best SAMPLE EATERY'))

    const { texts } = await told(chat)

    expect(texts.map((message) => message.text)).toEqual([await chat.say('/best SAMPLE EATERY')])
  })

  it('is answered with the table that the command replies with, when it is one that shows things in a table', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    const shows = ['/cards', '/products', '/status']
    acting(...shows.map(command))
    const logged = catchConsole()

    const { rich, texts } = await told(chat)

    // A rich message for each, in their order, and no text beside them.
    expect(texts).toEqual([])
    expect(rich.map((message) => linesOf(message)[0])).toEqual([
      CARDS_HEADER,
      'The card products whose reward rules are known:',
      'Gmail | not connected',
    ])
    expect(linesOf(rich[0])).toEqual([
      CARDS_HEADER,
      'visa | ••••1234 | calendar month | - | -',
      'evol | ••••5678 | calendar month | UOB EVOL Card | -',
    ])
    const done = (name: string) => ({ kind: 'command', command: name, outcome: 'done' })
    expect(logged.events()).toEqual([
      ...loggedFor(userId, ['cards', 'products', 'status'].map(done)).slice(0, 4),
      { ...loggedFor(userId, [{}, {}, {}])[4], sent: 'rich' },
    ])
    // Each is what its user is sent when they send the command themselves.
    const sentDirectly = []
    for (const line of shows) sentDirectly.push(await chat.rich(line))
    expect(rich).toEqual(sentDirectly)
  })

  it('is not run when it removes or revokes: each of the five is asked about, with what it concerns, and changes nothing', async () => {
    const chat = await connectedChat('jane@example.test')
    await chat.say('/addcard evol 5678 calendar uob-evol')
    const userId = await chat.userId()
    const purchase = await buy(userId, { cardLast4: '5678' })
    await chat.say('/mcp')
    const tokenOf = () =>
      env.DB.prepare('SELECT token_hash FROM mcp_tokens WHERE owner_id = ?').bind(userId).first('token_hash')
    const token = await tokenOf()
    const logged = catchConsole()

    // The line as the model gave it, the line that rides under the buttons, and what the message says.
    const five: [given: string, line: string, text: string][] = [
      [
        `/REMOVE  #${purchase}`,
        `/remove ${purchase}`,
        `Take this purchase out of ••••5678?\nID ${purchase} · 5 Oct · SGD 12.40 · COFFEE PLACE`,
      ],
      ['/removecard evol', '/removecard evol', 'Stop tracking evol ••••5678?'],
      [
        '/disconnect',
        '/disconnect',
        'Disconnect your Gmail jane@example.test? Its mail will no longer be read for this chat.',
      ],
      [
        '/mcp',
        '/mcp',
        'Make a new assistant access token? The one that you have now, if you have one, will stop working.',
      ],
      [
        '/mcp Revoke',
        '/mcp revoke',
        'Remove your assistant access token? An assistant that uses it will no longer read your data.',
      ],
    ]
    for (const [given, line, text] of five) {
      acting(command(given))
      const { rich, texts } = await told(chat)
      expect(rich).toEqual([])
      expect(texts).toMatchObject([{ text, buttons: buttonsFor(line) }])
    }

    expect(logged.events('action').map(({ command: name, outcome }) => [name, outcome])).toEqual([
      ['remove', 'asked'],
      ['removecard', 'asked'],
      ['disconnect', 'asked'],
      ['mcp', 'asked'],
      ['mcp', 'asked'],
    ])
    // Nothing was removed and nothing was revoked: the purchase, the card, the Gmail and the token are as they were.
    expect(await rowsOf(userId)).toMatchObject([{ id: purchase, removed_at: null }])
    expect(await chat.lines('/cards')).toContain('evol | ••••5678 | calendar month | UOB EVOL Card | -')
    expect(await connectionOf(userId)).toMatchObject({ email: 'jane@example.test', status: 'active' })
    expect(await tokenOf()).toBe(token)
  })

  it.each(['/delete confirm', '/DELETE  Confirm'])(
    'is never run when it is "%s": it is answered with what /delete alone answers, and nothing is deleted',
    async (line) => {
      const chat = await chatWithCard()
      const userId = await chat.userId()
      await buy(userId, { cardLast4: '5678' })
      acting(command(line))
      const logged = catchConsole()

      const { texts } = await told(chat)

      expect(texts.map((message) => message.text)).toEqual([DELETE_WARNING])
      expect(texts[0].buttons).toBeUndefined()
      expect(await rowsOwnedBy(userId)).toEqual({ users: 1, cards: 1, transactions: 1 })
      const refused = { event: 'action', user: userId, kind: 'command', command: 'delete', outcome: 'refused' }
      expect(logged.events('action')).toEqual([refused])
    },
  )

  it.each<[what: string, line: string, name: string]>([
    ['/add', '/add evol 5.20 LUNCH', 'add'],
    ['a command that there is not', '/nosuchcommand evol', 'unknown'],
  ])('is refused when it is %s, and the assistant is not asked again', async (_, line, name) => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    acting(command(line))
    const logged = catchConsole()

    const { rich, texts } = await told(chat)

    expect(rich).toEqual([])
    expect(texts.map((message) => message.text)).toEqual([NOT_DONE])
    // The one asking is that of the message itself: the line went to nobody.
    expect(answering).toHaveBeenCalledTimes(1)
    expect(await rowsOf(userId)).toEqual([])
    const refused = { event: 'action', user: userId, kind: 'command', command: name, outcome: 'refused' }
    expect(logged.events('action')).toEqual([refused])
  })

  it('is run only when it is one that is listed to be run: /start and /code are commands of the bot’s, and are not', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    acting(command('/start'), command('/code 123456'))
    const logged = catchConsole()

    const { rich, texts } = await told(chat)

    expect(rich).toEqual([])
    expect(texts.map((message) => message.text)).toEqual([NOT_DONE, NOT_DONE])
    // Each is known for the command that it is, and neither was run: no code was tried against a sign-in.
    const refused = { event: 'action', user: userId, kind: 'command', outcome: 'refused' }
    expect(logged.events('action')).toEqual([
      { ...refused, command: 'start' },
      { ...refused, command: 'code' },
    ])
    expect(logged.events('connect_code')).toEqual([])
  })

  it('is asked about first when it is /connect, which would cancel a sign-in that is waiting for its code', async () => {
    const chat = openChat()
    // The user has approved at Google, and has still to send the six digits that the page showed them.
    const code = await signIn(chat, 'jane@example.test')
    acting(command('/connect'))

    const { texts } = await told(chat)

    expect(texts).toMatchObject([
      {
        text:
          'Start a new sign-in to connect your Gmail? A sign-in that is waiting for its code is cancelled, and its ' +
          'code will no longer work.',
        buttons: buttonsFor('/connect'),
      },
    ])
    // Nothing was started for the model's asking: the six digits still find their sign-in.
    expect(await chat.say(code)).toContain('Connected jane@example.test.')
  })

  it('is asked about first when it links a card to another product: the card is linked on "Do it", and not before', async () => {
    const chat = await chatWithCard()

    const asking = await askedAbout(chat, '/product evol hsbc-revolution')

    // The card has no purchases: what the question and the reply say goes by its products, whatever is stored.
    expect(asking.text).toContain(WILL_SORT_AGAIN)
    expect(await chat.lines('/cards')).toContain('evol | ••••5678 | calendar month | UOB EVOL Card | -')

    const { sent } = await chat.press(asking, 'Do it')

    expect(sent.map((message) => message.text)).toEqual([expect.stringContaining(SORTED_AGAIN)])
    expect(await chat.lines('/cards')).toContain('evol | ••••5678 | calendar month | HSBC Revolution Credit Card | -')
  })
})

describe('a press of a button under a message that asks before a command is run', () => {
  /** A user with a card and a purchase on it, and the message that asks whether to take the purchase out. */
  async function asked() {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const purchase = await buy(userId, { cardLast4: '5678' })
    const asking = await askedAbout(chat, `/remove ${purchase}`)
    const shown = `Take this purchase out of ••••5678?\nID ${purchase} · 5 Oct · SGD 12.40 · COFFEE PLACE`
    expect(asking.text).toBe(shown)
    return { chat, userId, purchase, asking, shown }
  }

  it('runs the command once when it is "Do it": the command’s reply is sent, and the message points to it and has no buttons', async () => {
    const { chat, userId, purchase, asking, shown } = await asked()
    const logged = catchConsole()

    const pressed = await chat.press(asking, 'Do it')

    expect(pressed.answer).toBe(SEE_REPLY)
    expect(pressed.sent.map((message) => message.text)).toEqual([
      `Removed from ••••5678:\nID ${purchase} · 5 Oct · SGD 12.40 · COFFEE PLACE`,
    ])
    expect(asking.text).toBe(`${shown}\n${SEE_REPLY}`)
    expect(markedIn(asking)).toEqual(['COFFEE PLACE'])
    expect(asking.buttons).toBeUndefined()
    expect(await rowsOf(userId)).toMatchObject([{ id: purchase, removed_at: expect.any(Number) }])
    expect(logged.events()).toEqual([
      { event: 'confirm_press', user: userId, command: 'remove', outcome: 'done' },
      { event: 'update', kind: 'press', outcome: 'replied', ms: 0 },
    ])
    expect(answering).toHaveBeenCalledTimes(1)

    // A press that Telegram delivers again takes nothing out twice: the command says that there is nothing to take.
    // The press is answered as the first was: it is the reply that says what came of the command.
    const again = await chat.pressWith(asking, `do:/remove ${purchase}`)
    expect(again.sent.map((message) => message.text)).toEqual([`You have no purchase with ID ${purchase}.`])
    expect(again.answer).toBe(SEE_REPLY)
    expect(await rowsOf(userId)).toHaveLength(1)
  })

  it('sends the command’s reply before anything else that "Do it" does: the token that /mcp makes is shown though the answer and the edit both fail', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const asking = await askedAbout(chat, '/mcp')
    // Telegram takes the reply, and then neither the answer to the press nor the edit of the message: as it takes
    // no edit of a press that it delivers a second time, whose message says what the edit would have it say.
    const done: string[] = []
    const send = deps.messenger.send.bind(deps.messenger)
    vi.spyOn(deps.messenger, 'send').mockImplementation(async (...message) => {
      done.push('send')
      return send(...message)
    })
    vi.spyOn(deps.messenger, 'answer').mockImplementation(async () => {
      done.push('answer')
      throw new TelegramError('answerCallbackQuery', 400)
    })
    vi.spyOn(deps.messenger, 'edit').mockImplementation(async () => {
      done.push('edit')
      throw new TelegramError('editMessageText', 400)
    })
    const logged = catchConsole()

    const pressed = await chat.press(asking, 'Do it')

    // The reply first, and then both of the others, whatever came of the first of them.
    expect(done).toEqual(['send', 'answer', 'edit'])
    // The token that the chat was sent is the one that now lets an assistant in.
    const [token = ''] = /stmcp_\S+/.exec(pressed.sent[0].text) ?? []
    expect(await userOfToken(env.DB, token)).toMatchObject({ id: userId })
    // Nothing that failed after the reply fails the press: nobody is told to try again, which would end this token.
    expect(logged.events()).toEqual([
      { event: 'confirm_press', user: userId, command: 'mcp', outcome: 'done' },
      { event: 'update', kind: 'press', outcome: 'replied', ms: 0 },
    ])
  })

  it('runs nothing when it is "Cancel", and the message says so', async () => {
    const { chat, userId, purchase, asking, shown } = await asked()
    const logged = catchConsole()

    const pressed = await chat.press(asking, 'Cancel')

    expect(pressed).toEqual({ answer: CANCELLED, sent: [] })
    expect(asking.text).toBe(`${shown}\n${CANCELLED}`)
    expect(asking.buttons).toBeUndefined()
    expect(await rowsOf(userId)).toMatchObject([{ id: purchase, removed_at: null }])
    expect(logged.events('confirm_press')).toEqual([
      { event: 'confirm_press', user: userId, command: 'remove', outcome: 'cancelled' },
    ])
  })

  it('by somebody else takes nothing of the user’s out: it is run for whoever pressed, in their own chat, or not at all', async () => {
    const { chat, userId, purchase, asking } = await asked()
    const before = { ...asking }
    const data = `do:/remove ${purchase}`
    // Somebody with a card and a message of their own that asks, who presses what the user's button holds.
    const other = await chatWithCard()
    const theirs = await askedAbout(other, `/remove ${await buy(await other.userId(), { cardLast4: '5678' })}`)
    const stranger = openChat()

    const pressed = await other.pressWith(theirs, data)
    const byNobody = await stranger.pressWith(asking, data)
    // And a press in the user's chat that is not the user's own, which is passed over as any such press is.
    const [from, chatOf] = [{ id: other.telegramId }, { id: chat.telegramId, type: 'private' }]
    const under = { message_id: asking.id, chat: chatOf, text: asking.text }
    await handleUpdate(deps, { callback_query: { id: 'press-made-up', from, data, message: under } })

    // The store of whoever pressed has no such purchase, and says so.
    expect(pressed.sent.map((message) => message.text)).toEqual([`You have no purchase with ID ${purchase}.`])
    expect(byNobody).toEqual({ answer: REFUSED, sent: [] })
    expect(await userCount(stranger.telegramId)).toBe(0)
    expect(await rowsOf(userId)).toMatchObject([{ id: purchase, removed_at: null }])
    expect(await rowsOf(await other.userId())).toMatchObject([{ removed_at: null }])
    expect(asking).toEqual(before)
    expect(labels(asking)).toEqual(['Do it', 'Cancel'])
  })

  it.each(['do:/delete confirm', 'do:/spend evol'])(
    'runs nothing that no message asks about, whatever a client sends in the place of a button’s line: "%s"',
    async (data) => {
      const { chat, userId, asking } = await asked()
      const before = { ...asking }
      answering.mockClear()
      const logged = catchConsole()

      expect(await chat.pressWith(asking, data)).toEqual({ answer: REFUSED, sent: [] })

      expect(await rowsOwnedBy(userId)).toEqual({ users: 1, cards: 1, transactions: 1 })
      expect(await chat.say('/timezone')).toContain('Your time zone is Asia/Singapore.')
      expect(answering).not.toHaveBeenCalled()
      expect(asking).toEqual(before)
      expect(logged.events('confirm_press')).toEqual([{ event: 'confirm_press', user: userId, outcome: 'refused' }])
    },
  )
})

describe('several things in one answer of the assistant’s', () => {
  it('are done in their order, each with its reply: when one fails, those before it stay done and the user is told which', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    acting(command('/timezone Asia/Tokyo'), { kind: 'add', reading: read([bought(520, 'LUNCH')]) })
    const prepare = env.DB.prepare.bind(env.DB)
    const failing = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('INSERT INTO transactions')) throw new Error('a made-up failure that quotes: LUNCH')
      return prepare(query)
    })
    const logged = catchConsole()

    const { rich, texts } = await told(chat)
    failing.mockRestore()

    expect(rich).toEqual([])
    expect(texts.map((message) => message.text)).toEqual([
      TOKYO,
      'The first of the 2 things that you asked for is answered above. Something then went wrong on the ' +
        "bot's side, and the rest may not have been done. Check /spend before you ask for the rest again.",
    ])
    // The first of them stays done.
    expect(await chat.say('/timezone')).toContain('Your time zone is Asia/Tokyo.')
    expect(await rowsOf(userId)).toEqual([])
    const failed = { event: 'action', user: userId, kind: 'add', outcome: 'failed', error: 'Error' }
    expect(logged.events().slice(0, 4)).toEqual([
      { event: 'update', kind: 'question', outcome: 'deferred', ms: 0 },
      { event: 'action', user: userId, kind: 'command', command: 'timezone', outcome: 'done' },
      failed,
      { ...loggedFor(userId, [{}, {}])[3], tool_calls: 2, actions: 2 },
    ])
    // The action that failed is the one line at the level of an error.
    expect(logged.failures().slice(0, 1)).toEqual([failed])
  })

  it('end with the line that says something could not be done, once, when the assistant did not hand on all that the model asked for', async () => {
    const chat = await chatWithCard()
    actingWith({ dropped: 2 }, command('/timezone Asia/Tokyo'))

    expect((await told(chat)).texts.map((message) => message.text)).toEqual([TOKYO, NOT_DONE])

    // The line is the last of the reply, and is not said a second time after itself.
    actingWith({ dropped: 1 }, command('/nosuchcommand'))
    expect((await told(chat)).texts.map((message) => message.text)).toEqual([NOT_DONE])
  })
})

describe('what a message asks for next, once the first thing that it asked for is done', () => {
  /** Has the assistant make these actions of every message, with more to come, and `then` when it is asked again. */
  function goingOn(first: Action[], then: Answer) {
    const next = vi.fn(async (_came: string[], _changed: boolean) => then)
    const more = { afterReading: false, dropped: 0, more: true, next }
    answering.mockResolvedValue({ status: 'acting', actions: first, ...more })
    return next
  }

  /** An answer that asks for the one action, and for nothing after it. */
  function lastly(action: Action): Answer {
    return { status: 'acting', actions: [action], afterReading: false, dropped: 0, more: false }
  }

  it('is done for the user as a command left them, with the assistant told that the cards may have changed: what was spent is shown by the time zone that the message set', async () => {
    const chat = await chatWithCard()
    // At 09:30 on 5 October in Singapore, which is the evening of the 4th in New York.
    await buy(await chat.userId(), { cardLast4: '5678' })
    const next = goingOn([command('/timezone America/New_York')], lastly({ kind: 'show' }))

    const { rich } = await told(chat)

    expect(next.mock.calls).toEqual([[['Done.'], true]])
    expect(rich.flatMap(linesOf)).toContainEqual(expect.stringMatching(/ \| 4 Oct \| 12\.40 \| COFFEE PLACE$/))
  })

  it('is asked for with nothing read again, after a command that changes neither the cards nor the user', async () => {
    const chat = await chatWithCard()
    const next = goingOn([command('/cards')], { status: 'answered', text: 'Made-up words.' })

    await told(chat)

    expect(next.mock.calls).toEqual([[['Done.'], false]])
  })

  it('has no room left when the reading again took it: its two queries are counted with those of the actions', async () => {
    const chat = await chatWithCard()
    const zone = command('/timezone Asia/Tokyo')
    // Four commands at six queries each leave six of the thirty, which a fifth would take but for those two.
    goingOn([zone, zone, zone, zone], lastly(zone))

    const { texts } = await told(chat)

    expect(texts.filter((message) => message.text === TOKYO)).toHaveLength(4)
  })
})

describe('what the model asks for after a tool has read for it', () => {
  it('is asked about first where it would change something: purchases are held whole, and a card, a product and a time zone wait for "Do it"', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const purchase = await buy(userId, { cardLast4: '5678' })
    actingWith(
      { afterReading: true },
      { kind: 'add', reading: read([bought(520, 'LUNCH'), bought(300, 'TEA HOUSE')], { card: 'evol' }) },
      command('/timezone Asia/Tokyo'),
      command('/addcard visa 1234 calendar'),
      command('/product evol none'),
      { kind: 'category', ids: [purchase], category: 'other' },
    )
    const logged = catchConsole()

    const { rich, texts } = await told(chat, MESSAGE)

    // The model was sure of both purchases, and neither is stored: they are asked about, as an unsure one is.
    expect(rich).toEqual([])
    expect(await rowsOf(userId)).toMatchObject([{ id: purchase }])
    expect(texts.map((message) => [message.text, message.buttons])).toEqual([
      [
        'Not sure about these 2 purchases. Check the amount and the date of each before you add them to ' +
          'evol ••••5678:\n5 Oct · SGD 5.20 · LUNCH\n5 Oct · SGD 3.00 · TEA HOUSE',
        [[{ text: 'Add these 2', data: 'held:7001:add' }], [{ text: 'Skip', data: 'held:7001:skip' }]],
      ],
      [
        "Change your time zone to Asia/Tokyo? Your cards' cycles and months will begin and end by it.",
        buttonsFor('/timezone Asia/Tokyo'),
      ],
      ['Add this card?\nvisa ••••1234: calendar month', buttonsFor('/addcard visa 1234 calendar')],
      [
        'Link evol ••••5678 to no product? Its purchases will no longer be sorted.',
        buttonsFor('/product evol none'),
      ],
      // Sorting is done as before: the purchase is the user's own, and is moved back with one press.
      [`ID ${purchase}: Other Spend`, undefined],
    ])
    expect(logged.events('action').map(({ kind, command: name, outcome }) => [kind, name, outcome])).toEqual([
      ['add', undefined, 'asked'],
      ['command', 'timezone', 'asked'],
      ['command', 'addcard', 'asked'],
      ['command', 'product', 'asked'],
      ['category', undefined, 'done'],
    ])
    // Nothing of the three was done: the time zone, the cards and the product are as they were.
    expect(await chat.say('/timezone')).toContain('Your time zone is Asia/Singapore.')
    expect(await chat.lines('/cards')).toEqual([CARDS_HEADER, 'evol | ••••5678 | calendar month | UOB EVOL Card | -'])

    // A press of "Do it" then runs the one that its button holds, and the one that adds the purchases adds them.
    expect((await chat.press(texts[1], 'Do it')).sent.map((message) => message.text)).toEqual([TOKYO])
    expect((await chat.press(texts[0], 'Add these 2')).answer).toBe('Added 2 purchases.')
    expect(await rowsOf(userId)).toHaveLength(3)
  })

  it('has the room that any other answer has: /spend with no card named, which is counted at 22 queries, is run', async () => {
    const chat = await chatWithCard()
    actingWith({ afterReading: true }, command('/spend'))

    const { rich, texts } = await told(chat)

    // The reply is the table that the command replies with, and nothing beside it.
    expect(texts).toEqual([])
    expect(rich).toEqual([await chat.rich('/spend')])
  })

  it('has the renaming of a card wait for "Do it" too: nothing is renamed until the press, which renames the card', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    actingWith({ afterReading: true }, command('/renamecard  evol   daily'))
    const logged = catchConsole()

    const { rich, texts } = await told(chat)

    // The line under the buttons is made from what the model's line was read to mean, and is none of its text.
    expect(rich).toEqual([])
    expect(texts.map((message) => [message.text, message.buttons])).toEqual([
      ['Rename evol ••••5678 to daily?', buttonsFor('/renamecard evol daily')],
    ])
    const action = { event: 'action', user: userId, kind: 'command', command: 'renamecard' }
    expect(logged.events('action')).toEqual([{ ...action, outcome: 'asked' }])
    expect(await chat.lines('/cards')).toEqual([CARDS_HEADER, 'evol | ••••5678 | calendar month | UOB EVOL Card | -'])

    const pressed = await chat.press(texts[0], 'Do it')

    expect(pressed.answer).toBe(SEE_REPLY)
    expect(pressed.sent.map((message) => message.text)).toEqual(['Renamed evol ••••5678 to daily.'])
    expect(texts[0].text).toBe(`Rename evol ••••5678 to daily?\n${SEE_REPLY}`)
    expect(texts[0].buttons).toBeUndefined()
    expect(await chat.lines('/cards')).toEqual([CARDS_HEADER, 'daily | ••••5678 | calendar month | UOB EVOL Card | -'])
    const press = { event: 'confirm_press', user: userId, command: 'renamecard', outcome: 'done' }
    expect(logged.events('confirm_press')).toEqual([press])
  })

  it.each<[what: string, line: string, said: string]>([
    ['a card that its user has not got', '/renamecard visa daily', 'You have no card called visa.'],
    ['a card to the nickname that it has', '/renamecard evol evol', 'You already have a card called evol.'],
    ['a product that there is not', '/product evol visa-infinite', noSuchProduct('visa-infinite')],
  ])('has nothing asked where there is nothing to do: for %s, what the command would say, and no buttons', async (_, line, said) => {
    const chat = await chatWithCard()
    actingWith({ afterReading: true }, command(line))
    const logged = catchConsole()

    const { texts } = await told(chat)

    expect(texts.map((message) => [message.text, message.buttons])).toEqual([[said, undefined]])
    expect(logged.events('action')).toMatchObject([{ outcome: 'refused' }])
  })
})

describe('what the log has of the things that the assistant was asked to do', () => {
  /** An id of a purchase that no count and no duration in a line could be. */
  const PURCHASE = 88_664_422

  it('is the kind of each and what came of it, and nothing of a line, an id, a merchant or an amount', async () => {
    const logged = catchConsole()
    const chat = openChat()
    await chat.say('/addcard privatecard 4321 calendar uob-evol')
    const userId = await chat.userId()
    await env.DB.prepare(
      `INSERT INTO transactions
         (id, owner_id, source_id, card_last4, amount_minor, currency, merchant, occurred_at, parser)
       VALUES (?, ?, 'made-up-source', '4321', 9876, 'SGD', 'PRIVATE CLINIC', 1791000000, 'example-bank')`,
    )
      .bind(PURCHASE, userId)
      .run()
    acting(
      { kind: 'add', reading: read([unsure(54321, 'SECRET SHOP', { currency: 'JPY' })], { card: 'privatecard' }) },
      { kind: 'category', ids: [PURCHASE], category: 'other' },
      command('/timezone Asia/Tokyo'),
      command(`/remove ${PURCHASE}`),
      command('/nosuchcommand PRIVATE'),
    )

    const { texts } = await told(chat, 424242)
    await chat.press(texts[3], 'Cancel')
    await chat.press(await askedAbout(chat, `/remove ${PURCHASE}`), 'Do it')

    const action = { event: 'action', user: userId }
    expect(logged.events().slice(1)).toEqual([
      { event: 'update', kind: 'question', outcome: 'deferred', ms: 0 },
      { ...action, kind: 'add', outcome: 'asked', stored: 0, held: 1 },
      { ...action, kind: 'category', outcome: 'done' },
      { ...action, kind: 'command', command: 'timezone', outcome: 'done' },
      { ...action, kind: 'command', command: 'remove', outcome: 'asked' },
      { ...action, kind: 'command', command: 'unknown', outcome: 'refused' },
      { ...loggedFor(userId, [])[1], tool_calls: 5, actions: 5 },
      { event: 'confirm_press', user: userId, command: 'remove', outcome: 'cancelled' },
      { event: 'update', kind: 'press', outcome: 'replied', ms: 0 },
      ...loggedFor(userId, [{ kind: 'command', command: 'remove', outcome: 'asked' }]),
      { event: 'confirm_press', user: userId, command: 'remove', outcome: 'done' },
      { event: 'update', kind: 'press', outcome: 'replied', ms: 0 },
    ])
    // As it is written, the line of an action is this.
    expect(logged.text().split('\n')[2]).toBe(
      `{"event":"action","user":${userId},"kind":"add","outcome":"asked","stored":0,"held":1}`,
    )
    const said = ['privatecard', 'PRIVATE', 'CLINIC', 'SECRET', 'SHOP', 'Tokyo', 'nosuch', 'made-up', '/', 'do:', 'no:']
    const numbers = ['4321', '98.76', '9876', '543', 'JPY', 'SGD', '424242', String(PURCHASE), String(chat.telegramId)]
    for (const text of [...said, ...numbers]) expect(logged.text()).not.toContain(text)
  })
})
