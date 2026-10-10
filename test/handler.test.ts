import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { depsFor, type Deps } from '../src/deps'
import { ingestAlert } from '../src/ingest'
import { findOrCreateUser, storeFor } from '../src/store'
import { handleUpdate, type Update } from '../src/telegram/handler'
import { alertEmail, alertText, newTelegramId, rowsOwnedBy, seconds, userCount } from './helpers'

const NOW = new Date('2026-10-09T12:00:00+08:00')

/**
 * Dependencies with a Messenger that records what it is asked to send. The service that they make has no assistant:
 * test/assistant.test.ts has the one that has, and what comes of a question there.
 */
function recorder() {
  const sent: { chatId: number; text: string }[] = []
  const deps: Deps = {
    ...depsFor(env),
    ai: undefined,
    now: () => NOW,
    messenger: {
      async send(chatId, text) {
        sent.push({ chatId, text })
      },
      // No reply here is a rich message, which /spend with a card is, and an answer of the assistant's:
      // test/detail-rich.test.ts and test/assistant.test.ts have those. And no reply to a message answers a press
      // or edits a message. test/sort.test.ts has the presses.
      async sendRich() {},
      async answer() {},
      async edit() {},
      async typing() {},
    },
  }
  return { sent, deps }
}

let lastMessage = 0

/** A message in a user's private chat with the bot, with an id that no message before it had. */
function privateMessage(telegramId: number, text: string): Update {
  const message_id = ++lastMessage
  return { message: { message_id, text, chat: { id: telegramId, type: 'private' }, from: { id: telegramId } } }
}

/** A new user's private chat with the bot. */
function openChat() {
  const telegramId = newTelegramId()
  const { sent, deps } = recorder()
  return {
    telegramId,
    /** Sends the bot a message and returns its one reply. */
    async say(text: string): Promise<string> {
      sent.length = 0
      await handleUpdate(deps, privateMessage(telegramId, text))
      expect(sent).toHaveLength(1)
      expect(sent[0].chatId).toBe(telegramId)
      return sent[0].text
    },
    async user() {
      return findOrCreateUser(env.DB, telegramId)
    },
  }
}

describe('/start', () => {
  it('creates the user once and replies with a welcome and the commands', async () => {
    const chat = openChat()
    expect(await userCount(chat.telegramId)).toBe(0)

    const reply = await chat.say('/start')

    expect(reply).toContain('Welcome to Spend Tracker')
    const commands = [
      '/addcard',
      '/cards',
      '/removecard',
      '/spend',
      '/timezone',
      '/connect',
      '/status',
      '/disconnect',
      '/mcp',
      '/delete',
    ]
    for (const command of commands) expect(reply).toContain(command)
    expect(await userCount(chat.telegramId)).toBe(1)

    await chat.say('/start')
    expect(await userCount(chat.telegramId)).toBe(1)
  })

  it('says which time zone the windows are counted in until another is set, and how to set one', async () => {
    const reply = await openChat().say('/start')

    expect(reply).toContain(
      'Cycles and months begin and end by Singapore time (Asia/Singapore), unless you set another time zone ' +
        'with /timezone.',
    )
    expect(reply).toContain("/timezone - show the time zone that your cards' windows are counted in")
    expect(reply).toContain('/timezone <name> - change it, for example /timezone Asia/Tokyo')
  })

  it('lists the commands for purchases and for card products', async () => {
    const lines = (await openChat().say('/start')).split('\n')

    for (const line of [
      '/spend <nickname> - every purchase on one card in its current window',
      '/add <nickname> <amount> <merchant> - add a purchase by hand; its date can go before the merchant',
      '/remove <purchase id> - take a purchase out',
      '/products - list the card products whose reward rules are known',
      '/product <nickname> <product key> - link a card to a product, or to none',
      "/sort <nickname> - how a card's purchases are sorted into the reward categories of its product",
      '/sort <purchase id> - move one purchase to another category',
    ]) {
      expect(lines).toContain(line)
    }
  })
})

describe('/addcard and /cards', () => {
  it('adds cards and lists them with their windows', async () => {
    const chat = openChat()

    const added = [await chat.say('/addcard visa 1234 statement 15'), await chat.say('/addcard amex 0005 calendar')]
    const listed = await chat.say('/cards')

    expect(added).toEqual([
      'Added visa ••••1234: statement closes on the 15th of the month.',
      'Added amex ••••0005: calendar month.',
    ])
    expect(listed).toBe('visa ••••1234: statement closes on the 15th of the month\namex ••••0005: calendar month')
  })

  it('accepts values at the limits', async () => {
    const chat = openChat()
    const longest = 'a'.repeat(20)

    expect(await chat.say(`/addcard ${longest} 0000 statement 1`)).toContain('Added')
    expect(await chat.say('/addcard My_card-2 9999 statement 31')).toContain('Added')

    expect(await chat.say('/cards')).toBe(
      `${longest} ••••0000: statement closes on the 1st of the month\n` +
        'My_card-2 ••••9999: statement closes on the 31st of the month',
    )
  })

  it.each([
    ['/addcard', 'Usage:'],
    ['/addcard visa', 'Usage:'],
    ['/addcard visa 1234', 'Usage:'],
    ['/addcard visa 1234 weekly', 'Usage:'],
    ['/addcard visa 1234 statement', 'Usage:'],
    // What comes after all that says what the card's window is, is taken for the key of a product.
    ['/addcard visa 1234 calendar 15', 'There is no product called 15.'],
    ['/addcard visa 1234 statement 15 extra', 'There is no product called extra.'],
    ['/addcard visa 1234 calendar uob-evol extra', 'Usage:'],
    ['/addcard visa 1234 statement 15 uob-evol extra', 'Usage:'],
    ['/addcard visa 1234 calendar not/a/key', 'Usage:'],
    ['/addcard my!card 1234 calendar', 'The nickname must be'],
    [`/addcard ${'a'.repeat(21)} 1234 calendar`, 'The nickname must be'],
    ['/addcard visa 123 calendar', 'The last four digits must be'],
    ['/addcard visa 12345 calendar', 'The last four digits must be'],
    ['/addcard visa 12a4 calendar', 'The last four digits must be'],
    ['/addcard visa 1234 statement 0', 'The statement day must be'],
    ['/addcard visa 1234 statement 32', 'The statement day must be'],
    ['/addcard visa 1234 statement 1.5', 'The statement day must be'],
    ['/addcard visa 1234 statement fifteen', 'The statement day must be'],
  ])('answers "%s" with what is wrong and adds nothing', async (message, expected) => {
    const chat = openChat()

    expect(await chat.say(message)).toContain(expected)

    expect(await chat.say('/cards')).toContain('You have no cards yet')
  })

  it('refuses a second card with the same nickname or the same last four digits', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')

    expect(await chat.say('/addcard visa 5678 calendar')).toContain('You already have a card')
    expect(await chat.say('/addcard other 1234 statement 15')).toContain('You already have a card')

    expect(await chat.say('/cards')).toBe('visa ••••1234: calendar month')
  })

  it('says how to add a card when there are none', async () => {
    expect(await openChat().say('/cards')).toBe(
      [
        'You have no cards yet. Add one with:',
        '/addcard <nickname> <last4> statement <day>',
        '/addcard <nickname> <last4> calendar',
      ].join('\n'),
    )
  })

  it('adds no more than twenty cards, which keeps /spend well inside the queries that a request may make', async () => {
    const chat = openChat()
    for (let card = 1; card <= 20; card++) {
      expect(await chat.say(`/addcard card-${card} ${String(card).padStart(4, '0')} calendar`)).toContain('Added')
    }

    expect(await chat.say('/addcard another 9999 calendar')).toBe(
      'You have 20 cards, which is as many as can be tracked. To add another, first remove one with ' +
        '/removecard <nickname>.',
    )
    expect((await chat.say('/cards')).split('\n')).toHaveLength(20)

    // /spend runs a query for each card, after one for the user and one for the cards. A request may run 50.
    const queried = vi.spyOn(env.DB, 'prepare')
    expect((await chat.say('/spend')).split('\n')).toHaveLength(20 + 2)
    expect(queried).toHaveBeenCalledTimes(1 + 1 + 20)
    queried.mockRestore()

    expect(await chat.say('/removecard card-1')).toBe('Removed card-1.')
    expect(await chat.say('/addcard another 9999 calendar')).toContain('Added')
  })
})

describe('/removecard', () => {
  it('removes a card by nickname', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    await chat.say('/addcard amex 0005 calendar')

    expect(await chat.say('/removecard visa')).toBe('Removed visa.')

    expect(await chat.say('/cards')).toBe('amex ••••0005: calendar month')
    expect(await chat.say('/removecard visa')).toBe('You have no card called visa.')
  })

  const malformed = ['/removecard', '/removecard visa amex', '/removecard my!card']

  it.each(malformed)('answers "%s" with the usage', async (message) => {
    expect(await openChat().say(message)).toBe('Usage: /removecard <nickname>')
  })
})

describe('/spend', () => {
  it("shows each card's total per currency, purchase count and reset date", async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 statement 15') // 16 September to 16 October
    await chat.say('/addcard amex 0005 calendar') // October
    await chat.say('/addcard spare 9999 calendar')
    const store = storeFor(env.DB, (await chat.user()).id)
    const alerts: [receivedAt: string, text: string][] = [
      ['2026-09-10T10:00:00+08:00', alertText('SGD 99.00', '1234')], // before the visa window
      ['2026-09-20T10:00:00+08:00', alertText('SGD 1,234.56', '1234', 'BOOK SHOP')],
      ['2026-10-05T10:00:00+08:00', alertText('SGD 12.40', '1234')],
      ['2026-10-06T10:00:00+08:00', alertText('USD 5.00', '1234')],
      ['2026-09-30T23:00:00+08:00', alertText('SGD 50.00', '0005')], // September
      ['2026-10-02T10:00:00+08:00', alertText('SGD 20.00', '0005')],
    ]
    for (const [index, [receivedAt, text]] of alerts.entries()) {
      const email = alertEmail({ sourceId: `msg-${index}`, receivedAt: seconds(receivedAt), text })
      expect((await ingestAlert(store, email)).status).toBe('stored')
    }

    expect(await chat.say('/spend')).toBe(
      [
        'visa ••••1234: SGD 1,246.96 + USD 5.00 in 3 purchases, resets 16 Oct',
        'amex ••••0005: SGD 20.00 in 1 purchase, resets 1 Nov',
        'spare ••••9999: no purchases, resets 1 Nov',
        '',
        'Totals are estimated from bank alerts.',
      ].join('\n'),
    )
  })

  it('says how to add a card when there are none', async () => {
    const reply = await openChat().say('/spend')

    expect(reply).toContain('You have no cards yet')
    expect(reply).toContain('/addcard <nickname> <last4> statement <day>')
  })
})

describe('/timezone', () => {
  const USAGE = '/timezone <IANA name>, for example /timezone Asia/Tokyo'

  it("shows the user's time zone, which is Singapore's until they set another", async () => {
    const chat = openChat()

    expect(await chat.say('/timezone')).toBe(`Your time zone is Asia/Singapore. To change it, send ${USAGE}.`)

    await chat.say('/timezone Asia/Tokyo')
    expect(await chat.say('/timezone')).toBe(`Your time zone is Asia/Tokyo. To change it, send ${USAGE}.`)
  })

  it("sets the time zone that the windows of the user's cards are counted in, and nobody else's", async () => {
    const chat = openChat()
    const bystander = openChat()
    for (const each of [chat, bystander]) await each.say('/addcard visa 1234 statement 8')
    // It is noon on 9 October in Singapore, where the cycle that closed with the 8th is over.
    expect(await chat.say('/spend')).toContain('visa ••••1234: no purchases, resets 9 Nov')

    const reply = await chat.say('/timezone America/Los_Angeles')

    expect(reply).toBe("Your time zone is now America/Los_Angeles. Your cards' cycles and months begin and end by it.")
    expect((await chat.user()).timezone).toBe('America/Los_Angeles')
    // In Los Angeles it is nine in the evening of the 8th, and that cycle has three hours to go.
    expect(await chat.say('/spend')).toContain('visa ••••1234: no purchases, resets 9 Oct')
    expect(await bystander.say('/spend')).toContain('visa ••••1234: no purchases, resets 9 Nov')
  })

  it('takes a name in any case, and keeps it as the IANA list spells it', async () => {
    const chat = openChat()

    expect(await chat.say('/timezone europe/LONDON')).toContain('Your time zone is now Europe/London.')

    expect((await chat.user()).timezone).toBe('Europe/London')
  })

  it.each(['/timezone Mars/Olympus_Mons', '/timezone Asia/Tokio', '/timezone tomorrow', '/timezone /start'])(
    'answers "%s" with what a time zone is called, and changes nothing',
    async (message) => {
      const chat = openChat()

      expect(await chat.say(message)).toBe(
        'That is not a time zone the bot knows. Use an IANA name, such as Asia/Tokyo or Europe/London.',
      )

      expect((await chat.user()).timezone).toBe('Asia/Singapore')
    },
  )

  it.each(['/timezone Asia Tokyo', '/timezone Asia/Tokyo please'])('answers "%s" with the usage', async (message) => {
    const chat = openChat()

    expect(await chat.say(message)).toBe(`Usage: ${USAGE}`)

    expect((await chat.user()).timezone).toBe('Asia/Singapore')
  })
})

describe('/delete', () => {
  it('asks for confirmation, then deletes the user and all their data', async () => {
    const chat = openChat()
    const bystander = openChat()
    for (const each of [chat, bystander]) {
      await each.say('/addcard visa 1234 calendar')
      await ingestAlert(storeFor(env.DB, (await each.user()).id), alertEmail())
    }
    const user = await chat.user()
    const other = await bystander.user()

    expect(await chat.say('/delete')).toContain('Send /delete confirm')
    expect(await rowsOwnedBy(user.id)).toEqual({ users: 1, cards: 1, transactions: 1 })

    expect(await chat.say('/delete confirm')).toContain('has been deleted')
    expect(await rowsOwnedBy(user.id)).toEqual({ users: 0, cards: 0, transactions: 0 })
    expect(await userCount(chat.telegramId)).toBe(0)
    expect(await rowsOwnedBy(other.id)).toEqual({ users: 1, cards: 1, transactions: 1 })
  })

  it('lets a deleted user start again with nothing', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    await chat.say('/delete confirm')

    expect(await chat.say('/cards')).toContain('You have no cards yet')
  })
})

describe('anything else', () => {
  const messages = ['/unknown', '/', '/delete_everything']

  it.each(messages)('answers "%s" with the command list and stores nothing', async (message) => {
    const chat = openChat()

    const reply = await chat.say(message)

    expect(reply.startsWith('Commands:\n/addcard')).toBe(true)
    expect(await userCount(chat.telegramId)).toBe(0)
  })

  // What is no command is a question for the assistant, which this service has not got.
  const questions = ['hello', '12345', 'How much have I spent this month?', 'delete everything']

  it.each(questions)('answers "%s" that there is no assistant to ask, and stores nothing', async (message) => {
    const chat = openChat()

    const reply = await chat.say(message)

    expect(reply).toBe(
      'The assistant, which answers questions asked in your own words, is not available on this service. ' +
        'Send /start for the list of commands.',
    )
    expect(await userCount(chat.telegramId)).toBe(0)
  })

  it('reads a command whatever its case, bot suffix or surrounding space', async () => {
    const chat = openChat()

    const reply = await chat.say('  /AddCard@SpendTrackerBot   visa  1234  Calendar ')

    expect(reply).toBe('Added visa ••••1234: calendar month.')
  })
})

describe('updates that are ignored', () => {
  const text = '/start'
  // The id and the text that a message of Telegram's has, so that each of these is ignored for what it is said to be.
  const body = { message_id: 1, text }
  const updates: [what: string, update: (id: number) => Update][] = [
    ['a group chat', (id) => ({ message: { ...body, chat: { id: -5001, type: 'group' }, from: { id } } })],
    ['a supergroup chat', (id) => ({ message: { ...body, chat: { id: -5002, type: 'supergroup' }, from: { id } } })],
    ['a channel', () => ({ message: { ...body, chat: { id: -5003, type: 'channel' } } })],
    ['a message without text', (id) => ({ message: { message_id: 1, chat: { id, type: 'private' }, from: { id } } })],
    ['a message without a sender', (id) => ({ message: { ...body, chat: { id, type: 'private' } } })],
    ['a message without an id', (id) => ({ message: { text, chat: { id, type: 'private' }, from: { id } } })],
    ['an update without a message', () => ({})],
  ]

  it.each(updates)('ignores %s', async (_, update) => {
    const telegramId = newTelegramId()
    const { sent, deps } = recorder()

    await handleUpdate(deps, update(telegramId))

    expect(sent).toEqual([])
    expect(await userCount(telegramId)).toBe(0)
  })

  it("ignores a message in a private chat that is not its sender's own", async () => {
    const [senderId, chatId] = [newTelegramId(), newTelegramId()]
    const { sent, deps } = recorder()

    // The user is known by the sender, and the reply goes to the chat. It would be the sender's reply, sent elsewhere.
    await handleUpdate(deps, { message: { ...body, chat: { id: chatId, type: 'private' }, from: { id: senderId } } })

    expect(sent).toEqual([])
    expect(await userCount(senderId)).toBe(0)
    expect(await userCount(chatId)).toBe(0)
  })
})
