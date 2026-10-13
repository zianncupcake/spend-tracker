import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { depsFor, type Deps } from '../src/deps'
import { ingestAlert } from '../src/ingest'
import { findOrCreateUser, storeFor } from '../src/store'
import { ChatBlockedError, TelegramError, type RichMessage } from '../src/telegram/api'
import { COUNTED_BY_POSTING } from '../src/telegram/format'
import { handleUpdate, type Update } from '../src/telegram/handler'
import {
  COMMANDS,
  EDITED,
  FAILED,
  NO_ASSISTANT,
  NO_CARDS,
  NOT_TEXT,
  RENAME_CARD_USAGE,
  STORED_NO_REPLY,
  TIMEZONE_USAGE,
  TOO_MANY_CARDS,
  WELCOME,
} from '../src/telegram/texts'
import {
  alertEmail,
  alertText,
  buy,
  CARDS_HEADER,
  ESTIMATED,
  linesOf,
  newTelegramId,
  rowsOwnedBy,
  seconds,
  SPEND_HEADER,
  userCount,
} from './helpers'
import { catchConsole } from './log-helpers'

const NOW = new Date('2026-10-09T12:00:00+08:00')

/**
 * Dependencies with a Messenger that records what it is asked to send: its messages of text, and its rich messages.
 * The service that they make has no assistant: test/assistant.test.ts has the one that has, and what comes of a
 * question there.
 */
function recorder() {
  const sent: { chatId: number; text: string }[] = []
  const rich: { chatId: number; message: RichMessage }[] = []
  const deps: Deps = {
    ...depsFor(env),
    ai: undefined,
    now: () => NOW,
    messenger: {
      async send(chatId, text) {
        sent.push({ chatId, text })
      },
      // A reply that is a table is a rich message: /cards, /spend, /products and /status have one. The tables of
      // /spend with a card are in test/detail-rich.test.ts, and an answer of the assistant's is in
      // test/assistant.test.ts. No reply to a message answers a press or edits a message: test/sort.test.ts has the
      // presses. Nor is anything here sent for its id, or deleted, as the placeholder of a question is:
      // test/working.test.ts has that. And no file is fetched, as a photo's is: test/photo.test.ts has that.
      async post() {
        return 0
      },
      async sendRich(chatId, message) {
        rich.push({ chatId, message })
      },
      async answer() {},
      async edit() {},
      async delete() {},
      async typing() {},
      async file() {
        throw new Error('A test fetched a file that it should not have')
      },
    },
  }
  return { sent, rich, deps }
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
  const { sent, rich, deps } = recorder()
  /** Sends the bot a message and returns the rich message that is its one reply, with which no text is sent. */
  const richReply = async (text: string): Promise<RichMessage> => {
    sent.length = 0
    rich.length = 0
    await handleUpdate(deps, privateMessage(telegramId, text))
    expect(sent).toEqual([])
    expect(rich).toHaveLength(1)
    expect(rich[0].chatId).toBe(telegramId)
    return rich[0].message
  }
  return {
    telegramId,
    /** Sends the bot a message and returns its one reply, which is a message of text. */
    async say(text: string): Promise<string> {
      sent.length = 0
      rich.length = 0
      await handleUpdate(deps, privateMessage(telegramId, text))
      expect(rich).toEqual([])
      expect(sent).toHaveLength(1)
      expect(sent[0].chatId).toBe(telegramId)
      return sent[0].text
    },
    rich: richReply,
    /**
     * Sends the bot a message and returns what the rich message that is its one reply says, a line at a time: each
     * row of a table with " | " between its cells, and the text of each paragraph. See `linesOf`.
     */
    async lines(text: string): Promise<string[]> {
      return linesOf(await richReply(text))
    },
    /** Sends the bot a message and returns its one reply as text, whichever of the two the reply is. */
    async reply(text: string): Promise<string> {
      sent.length = 0
      rich.length = 0
      await handleUpdate(deps, privateMessage(telegramId, text))
      expect([...sent, ...rich]).toHaveLength(1)
      return [...sent.map((each) => each.text), ...rich.flatMap(({ message }) => linesOf(message))].join('\n')
    },
    /** Has Telegram take no rich message from here on, so that a reply that is one is sent as text. */
    refuseRich() {
      vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new TelegramError('sendRichMessage', 400))
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

    expect(reply).toContain(WELCOME)
    expect(reply).toContain(COMMANDS)
    expect(await userCount(chat.telegramId)).toBe(1)

    await chat.say('/start')
    expect(await userCount(chat.telegramId)).toBe(1)
  })
})

describe('/addcard and /cards', () => {
  it('adds cards and lists them with their windows', async () => {
    const chat = openChat()

    const added = [await chat.say('/addcard visa 1234 statement 15'), await chat.say('/addcard amex 0005 calendar')]
    const listed = await chat.lines('/cards')

    expect(added).toEqual([
      'Added visa ••••1234: statement closes on the 15th of the month.',
      'Added amex ••••0005: calendar month.',
    ])
    expect(listed).toEqual([
      CARDS_HEADER,
      'visa | ••••1234 | statement closes on the 15th of the month | - | -',
      'amex | ••••0005 | calendar month | - | -',
    ])
  })

  it('accepts values at the limits', async () => {
    const chat = openChat()
    const longest = 'a'.repeat(20)

    expect(await chat.say(`/addcard ${longest} 0000 statement 1`)).toContain('Added')
    expect(await chat.say('/addcard My_card-2 9999 statement 31')).toContain('Added')

    expect(await chat.lines('/cards')).toEqual([
      CARDS_HEADER,
      `${longest} | ••••0000 | statement closes on the 1st of the month | - | -`,
      'My_card-2 | ••••9999 | statement closes on the 31st of the month | - | -',
    ])
  })

  it.each([
    ['/addcard visa', 'Usage:'],
    ['/addcard visa 1234 weekly', 'Usage:'],
    ['/addcard visa 1234 statement', 'Usage:'],
    // What comes after all that says what the card's window is, is taken for the key of a product.
    ['/addcard visa 1234 calendar uob-evol extra', 'Usage:'],
    ['/addcard visa 1234 calendar not/a/key', 'Usage:'],
    ['/addcard my!card 1234 calendar', 'The nickname must be'],
    ['/addcard visa 123 calendar', 'The last four digits must be'],
    ['/addcard visa 12345 calendar', 'The last four digits must be'],
    ['/addcard visa 12a4 calendar', 'The last four digits must be'],
    ['/addcard visa 1234 statement 0', 'The statement day must be'],
    ['/addcard visa 1234 statement 32', 'The statement day must be'],
    ['/addcard visa 1234 statement 1.5', 'The statement day must be'],
  ])('answers "%s" with what is wrong and adds nothing', async (message, expected) => {
    const chat = openChat()

    expect(await chat.say(message)).toContain(expected)

    expect(await chat.say('/cards')).toBe(NO_CARDS)
  })

  it('refuses a second card with the same nickname or the same last four digits', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')

    expect(await chat.say('/addcard visa 5678 calendar')).toContain('You already have a card')
    expect(await chat.say('/addcard other 1234 statement 15')).toContain('You already have a card')

    expect(await chat.lines('/cards')).toEqual([CARDS_HEADER, 'visa | ••••1234 | calendar month | - | -'])
  })

  it('says how to add a card when there are none', async () => {
    expect(await openChat().say('/cards')).toBe(NO_CARDS)
  })

  it('adds no more than twenty cards, which keeps /spend well inside the queries that a request may make', async () => {
    const chat = openChat()
    for (let card = 1; card <= 20; card++) {
      expect(await chat.say(`/addcard card-${card} ${String(card).padStart(4, '0')} calendar`)).toContain('Added')
    }

    expect(await chat.say('/addcard another 9999 calendar')).toBe(TOO_MANY_CARDS)
    // A row for each card, under the row that names the columns.
    expect(await chat.lines('/cards')).toHaveLength(1 + 20)

    // /spend runs a query for each card, after one for the user and one for the cards. A request may run 50. Its
    // table has a row for each card too, and two lines under it.
    const queried = vi.spyOn(env.DB, 'prepare')
    expect(await chat.lines('/spend')).toHaveLength(1 + 20 + 2)
    expect(queried).toHaveBeenCalledTimes(1 + 1 + 20)
    queried.mockRestore()

    expect(await chat.say('/removecard card-1')).toBe('Removed card-1.')
    expect(await chat.say('/addcard another 9999 calendar')).toContain('Added')

    // As text, which is what is sent when Telegram does not take the table, each card has a line and under it the
    // line that says which days its total counts. The whole is inside the 4,096 characters that a message of text
    // may have, and so are the cards.
    chat.refuseRich()
    const [spent, cards] = [await chat.say('/spend'), await chat.say('/cards')]
    expect(spent.split('\n')).toHaveLength(2 * 20 + 3)
    expect(spent.length).toBeLessThan(4096)
    expect(cards.split('\n')).toHaveLength(20)
  })
})

describe('/cards', () => {
  /** A user with three cards: one that is linked to a product, between two that are linked to none. */
  async function chatWithCards() {
    const chat = openChat()
    await chat.say('/addcard visa 1234 statement 5')
    await chat.say('/addcard evol 5678 calendar uob-evol')
    await chat.say('/addcard amex 0005 calendar')
    return chat
  }

  it('is one table: a row for each card, in the order that they were added, under a row that says what each value is', async () => {
    const chat = await chatWithCards()

    // As Telegram is posted it: this is all of the `rich_message`, and no text is sent with it. A card that is
    // linked to no product has a dash for its product, and one with no reminder has a dash for that.
    const header = (text: string) => ({ text, is_header: true })
    expect(await chat.rich('/cards')).toEqual({
      skip_entity_detection: true,
      blocks: [
        {
          type: 'table',
          is_bordered: true,
          cells: [
            [header('Nickname'), header('Card'), header('Window'), header('Product'), header('Reminder')],
            [
              { text: 'visa' },
              { text: '••••1234' },
              { text: 'statement closes on the 5th of the month' },
              { text: '-' },
              { text: '-' },
            ],
            [
              { text: 'evol' },
              { text: '••••5678' },
              { text: 'calendar month' },
              { text: 'UOB EVOL Card' },
              { text: '-' },
            ],
            [{ text: 'amex' }, { text: '••••0005' }, { text: 'calendar month' }, { text: '-' }, { text: '-' }],
          ],
        },
      ],
    })
  })

  it('is a line for each card, as it was before it was a table, when Telegram does not take the table', async () => {
    const chat = await chatWithCards()
    chat.refuseRich()

    expect(await chat.say('/cards')).toBe(
      [
        'visa ••••1234: statement closes on the 5th of the month',
        'evol ••••5678: calendar month, UOB EVOL Card',
        'amex ••••0005: calendar month',
      ].join('\n'),
    )
  })
})

describe('/removecard', () => {
  it('removes a card by nickname', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    await chat.say('/addcard amex 0005 calendar')

    expect(await chat.say('/removecard visa')).toBe('Removed visa.')

    expect(await chat.lines('/cards')).toEqual([CARDS_HEADER, 'amex | ••••0005 | calendar month | - | -'])
    expect(await chat.say('/removecard visa')).toBe('You have no card called visa.')
  })

  const malformed = ['/removecard', '/removecard visa amex', '/removecard my!card']

  it.each(malformed)('answers "%s" with the usage', async (message) => {
    expect(await openChat().say(message)).toBe('Usage: /removecard <nickname>')
  })
})

describe('/renamecard', () => {
  it('gives a card another nickname, and leaves its digits, its window, its product and its purchases as they were', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 statement 15 uob-evol') // 16 September to 15 October
    await chat.say('/addcard amex 0005 calendar')
    await buy((await chat.user()).id)

    expect(await chat.say('/renamecard visa travel')).toBe('Renamed visa ••••1234 to travel.')

    expect(await chat.lines('/cards')).toEqual([
      CARDS_HEADER,
      'travel | ••••1234 | statement closes on the 15th of the month | UOB EVOL Card | -',
      'amex | ••••0005 | calendar month | - | -',
    ])
    // A purchase goes by the digits of its card, so the card has it still: test/actions.test.ts has it in the tables
    // of /spend with the new nickname.
    expect(await chat.lines('/spend')).toContain('travel | SGD 12.40 | 1 | 14 Sep to 13 Oct | 16 Oct')
    // The card is known by its new nickname only.
    expect(await chat.say('/renamecard visa travel')).toBe('You have no card called visa.')
  })

  it.each<[what: string, message: string, said: string]>([
    ['a card that there is not', '/renamecard evol travel', 'You have no card called evol.'],
    ['a nickname that another card has', '/renamecard visa amex', 'You already have a card called amex.'],
    ["the card's own nickname", '/renamecard visa visa', 'You already have a card called visa.'],
  ])('renames nothing when it is given %s, and says so', async (_, message, said) => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    await chat.say('/addcard amex 0005 calendar')

    expect(await chat.say(message)).toBe(said)

    expect(await chat.lines('/cards')).toEqual([
      CARDS_HEADER,
      'visa | ••••1234 | calendar month | - | -',
      'amex | ••••0005 | calendar month | - | -',
    ])
  })

  const malformed = [
    '/renamecard',
    '/renamecard visa',
    '/renamecard visa travel daily',
    '/renamecard visa my!card',
    '/renamecard my!card travel',
    `/renamecard visa ${'a'.repeat(21)}`,
  ]

  it.each(malformed)('answers "%s" with the usage', async (message) => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')

    expect(await chat.say(message)).toBe(RENAME_CARD_USAGE)

    expect(await chat.lines('/cards')).toEqual([CARDS_HEADER, 'visa | ••••1234 | calendar month | - | -'])
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
      ['2026-09-28T23:00:00+08:00', alertText('SGD 50.00', '0005')], // September
      ['2026-10-02T10:00:00+08:00', alertText('SGD 20.00', '0005')],
    ]
    for (const [index, [receivedAt, text]] of alerts.entries()) {
      const email = alertEmail({ sourceId: `msg-${index}`, receivedAt: seconds(receivedAt), text })
      expect((await ingestAlert(store, email)).status).toBe('stored')
    }

    // One table, with a row for each card: what its window comes to, a currency at a time, how many purchases that
    // is, which days of purchases the total counts, and the day that the window ends. The last two days of a window
    // are counted in the next one, of a statement and of a month. Why is said once, under the table. A card with no
    // purchases has spent none of its own currency.
    expect(await chat.lines('/spend')).toEqual([
      SPEND_HEADER,
      'visa | SGD 1,246.96 + USD 5.00 | 3 | 14 Sep to 13 Oct | 16 Oct',
      'amex | SGD 20.00 | 1 | 29 Sep to 29 Oct | 1 Nov',
      'spare | SGD 0.00 | 0 | 29 Sep to 29 Oct | 1 Nov',
      COUNTED_BY_POSTING,
      ESTIMATED,
    ])

    // As text, which is sent when Telegram does not take the table, it is what it was before it was a table: under
    // each card is which days of purchases its total counts.
    chat.refuseRich()
    expect(await chat.say('/spend')).toBe(
      [
        'visa ••••1234: SGD 1,246.96 + USD 5.00 in 3 purchases, resets 16 Oct',
        'The total counts purchases made from 14 Sep to 13 Oct.',
        'amex ••••0005: SGD 20.00 in 1 purchase, resets 1 Nov',
        'The total counts purchases made from 29 Sep to 29 Oct.',
        'spare ••••9999: no purchases, resets 1 Nov',
        'The total counts purchases made from 29 Sep to 29 Oct.',
        '',
        COUNTED_BY_POSTING,
        ESTIMATED,
      ].join('\n'),
    )
  })

  it('is one rich message as Telegram is posted it: the amounts and the counts are set to the right', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 5678 statement 15 uob-evol')

    // A card with no purchases has spent none of its product's own currency.
    expect(await chat.rich('/spend')).toEqual({
      skip_entity_detection: true,
      blocks: [
        {
          type: 'table',
          is_bordered: true,
          cells: [
            [
              { text: 'Nickname', is_header: true },
              { text: 'Spent', is_header: true, align: 'right' },
              { text: 'Purchases', is_header: true, align: 'right' },
              { text: 'Counted', is_header: true },
              { text: 'Resets', is_header: true },
            ],
            [
              { text: 'evol' },
              { text: 'SGD 0.00', align: 'right' },
              { text: '0', align: 'right' },
              { text: '14 Sep to 13 Oct' },
              { text: '16 Oct' },
            ],
          ],
        },
        { type: 'paragraph', text: COUNTED_BY_POSTING },
        { type: 'paragraph', text: ESTIMATED },
      ],
    })
  })

  it('says how to add a card when there are none', async () => {
    expect(await openChat().say('/spend')).toBe(NO_CARDS)
  })
})

describe('/timezone', () => {
  it("shows the user's time zone, which is Singapore's until they set another", async () => {
    const chat = openChat()

    expect(await chat.say('/timezone')).toBe(`Your time zone is Asia/Singapore. To change it, send ${TIMEZONE_USAGE}.`)

    await chat.say('/timezone Asia/Tokyo')
    expect(await chat.say('/timezone')).toBe(`Your time zone is Asia/Tokyo. To change it, send ${TIMEZONE_USAGE}.`)
  })

  it("sets the time zone that the windows of the user's cards are counted in, and nobody else's", async () => {
    const chat = openChat()
    const bystander = openChat()
    for (const each of [chat, bystander]) await each.say('/addcard visa 1234 statement 10')
    // It is noon on 9 October in Singapore, the day before the statement closes: a purchase of today is counted in
    // the cycle that begins on the 11th, which is the current one from today.
    const fromToday = 'visa | SGD 0.00 | 0 | 9 Oct to 8 Nov | 11 Nov'
    expect(await chat.lines('/spend')).toContain(fromToday)

    const reply = await chat.say('/timezone America/Los_Angeles')

    expect(reply).toBe("Your time zone is now America/Los_Angeles. Your cards' cycles and months begin and end by it.")
    expect((await chat.user()).timezone).toBe('America/Los_Angeles')
    // In Los Angeles it is nine in the evening of the 8th, and the cycle that closes on the 10th has three hours to
    // go as the current one.
    expect(await chat.lines('/spend')).toContain('visa | SGD 0.00 | 0 | 9 Sep to 8 Oct | 11 Oct')
    expect(await bystander.lines('/spend')).toContain(fromToday)
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

    expect(await chat.say(message)).toBe(`Usage: ${TIMEZONE_USAGE}`)

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

    expect(await chat.say('/cards')).toBe(NO_CARDS)
  })
})

describe('anything else', () => {
  const messages = ['/unknown', '/', '/delete_everything']

  it.each(messages)('answers "%s" with the command list and stores nothing', async (message) => {
    const chat = openChat()

    const reply = await chat.say(message)

    expect(reply).toBe(COMMANDS)
    expect(await userCount(chat.telegramId)).toBe(0)
  })

  // What is no command is a question for the assistant, which this service has not got.
  const questions = ['hello', '12345', 'How much have I spent this month?', 'delete everything']

  it.each(questions)('answers "%s" that there is no assistant to ask, and stores nothing', async (message) => {
    const chat = openChat()

    const reply = await chat.say(message)

    expect(reply).toBe(NO_ASSISTANT)
    expect(await userCount(chat.telegramId)).toBe(0)
  })

  it('reads a command whatever its case, bot suffix or surrounding space', async () => {
    const chat = openChat()

    const reply = await chat.say('  /AddCard@SpendTrackerBot   visa  1234  Calendar ')

    expect(reply).toBe('Added visa ••••1234: calendar month.')
  })
})

/**
 * An update with the parts that Telegram posts of what is not text, which the bot does not read: a photo, say, and
 * the words under it. An update comes to the bot as JSON that nothing has checked.
 */
function unchecked(update: object): Update {
  return update
}

/** A photo as Telegram posts one: the picture in each of the sizes that it is kept in. */
const photo = [{ file_id: 'made-up-file-id', file_unique_id: 'made-up-id', width: 90, height: 51, file_size: 1234 }]

const sticker = {
  file_id: 'made-up-file-id',
  file_unique_id: 'made-up-id',
  type: 'regular',
  width: 512,
  height: 512,
  is_animated: false,
  is_video: false,
  emoji: '👍',
}

/** A place that is shared for a time, which Telegram posts again as an edited message each time it moves. */
const liveLocation = { latitude: 1.29, longitude: 103.85, live_period: 900 }

describe('a message that is not text', () => {
  it.each<[what: string, content: object]>([
    // The words under an attachment are its caption. Here they are a command.
    ['a photo with words under it', { photo, caption: '/addcard visa 1234 calendar' }],
    // Whatever the bot does not know is answered so too, and not passed over: silence would be the worse mistake.
    ['a note of Telegram’s that the bot does not know', { made_up_note_of_telegrams: { made_up: true } }],
  ])('answers %s with that the bot only reads text, and does nothing else about it', async (_, content) => {
    const telegramId = newTelegramId()
    const { sent, deps } = recorder()
    const [chat, from] = [{ id: telegramId, type: 'private' }, { id: telegramId }]

    const later = await handleUpdate(deps, unchecked({ message: { message_id: 1, date: 1, chat, from, ...content } }))

    expect(sent).toEqual([{ chatId: telegramId, text: NOT_TEXT }])
    expect(later).toBeUndefined()
    // The words under it are not read: the command in them is not run, which would have stored its user.
    expect(await userCount(telegramId)).toBe(0)
  })
})

describe('a message that was edited', () => {
  it('is answered with that the bot does not read it again, and the command that it now is is not run', async () => {
    const telegramId = newTelegramId()
    const { sent, rich, deps } = recorder()
    await handleUpdate(deps, privateMessage(telegramId, '/addcard visa 1234 calendar'))
    const { message } = privateMessage(telegramId, '/removecard visa')

    // Telegram posts the message as it stands after the edit, in the place of a new message.
    const later = await handleUpdate(deps, { edited_message: message })

    expect(later).toBeUndefined()
    expect(sent.map((each) => each.text)).toEqual(['Added visa ••••1234: calendar month.', EDITED])
    // The card is there still: the table of /cards has its row.
    await handleUpdate(deps, privateMessage(telegramId, '/cards'))
    const row = 'visa | ••••1234 | calendar month | - | -'
    expect(rich.map((each) => linesOf(each.message))).toEqual([[CARDS_HEADER, row]])
  })

  it('is answered so whatever it says, and for somebody whom nothing is stored about', async () => {
    const telegramId = newTelegramId()
    const { sent, deps } = recorder()

    await handleUpdate(deps, { edited_message: privateMessage(telegramId, 'How much have I spent?').message })

    expect(sent).toEqual([{ chatId: telegramId, text: EDITED }])
    expect(await userCount(telegramId)).toBe(0)
  })
})

describe('updates that are ignored', () => {
  const text = '/start'
  // The id and the text that a message of Telegram's has, so that each of these is ignored for what it is said to be.
  const body = { message_id: 1, text }
  const group = { id: -5001, type: 'group' }
  /** Each with what the log has of it: what it was, as far as the bot looked, and why it was ignored. */
  const updates: [what: string, update: (id: number) => Update, kind: string, why: string][] = [
    [
      'a group chat',
      (id) => ({ message: { ...body, chat: { id: -5001, type: 'group' }, from: { id } } }),
      'message',
      'not_private',
    ],
    [
      'a message without a sender',
      (id) => ({ message: { ...body, chat: { id, type: 'private' } } }),
      'message',
      'not_own_chat',
    ],
    [
      'a message without an id',
      (id) => ({ message: { text, chat: { id, type: 'private' }, from: { id } } }),
      'message',
      'no_id',
    ],
    // What was edited is answered in a user's own private chat with the bot, and nowhere else.
    [
      'an edited message in a group',
      (id) => ({ edited_message: { ...body, chat: group, from: { id } } }),
      'edited',
      'not_private',
    ],
    [
      'an edited message without a sender',
      (id) => ({ edited_message: { ...body, chat: { id, type: 'private' } } }),
      'edited',
      'not_own_chat',
    ],
    [
      'an edited post of a channel',
      () => unchecked({ edited_channel_post: { ...body, chat: { id: -5003, type: 'channel' } } }),
      'other',
      'nothing_read',
    ],
    // Telegram posts a live location as an edited message each time it moves, which is no edit of its user's. It
    // was answered when it first came, as a message that is not text.
    [
      'an edited message that is not text, as a live location is',
      (id) => {
        const [chat, from] = [{ id, type: 'private' }, { id }]
        return unchecked({ edited_message: { message_id: 1, edit_date: 2, location: liveLocation, chat, from } })
      },
      'edited',
      'not_text',
    ],
    // What Telegram writes in a chat itself is no message of its user's. It says that a message was pinned by
    // holding that message, and that the timer which deletes the chat's messages was set by holding the new time.
    [
      'what Telegram writes when a message is pinned',
      (id) => {
        const [chat, from] = [{ id, type: 'private' }, { id }]
        return unchecked({ message: { message_id: 2, date: 2, chat, from, pinned_message: { ...body, chat, from } } })
      },
      'message',
      'service_message',
    ],
    [
      'what Telegram writes when the timer that deletes messages is set',
      (id) => {
        const [chat, from] = [{ id, type: 'private' }, { id }]
        const set = { message_auto_delete_time: 86_400 }
        return unchecked({ message: { message_id: 2, date: 2, chat, from, message_auto_delete_timer_changed: set } })
      },
      'message',
      'service_message',
    ],
  ]

  it.each(updates)('ignores %s, and logs that it did and why', async (_, update, kind, why) => {
    const telegramId = newTelegramId()
    const { sent, deps } = recorder()
    const logged = catchConsole()

    const later = await handleUpdate(deps, update(telegramId))

    expect(sent).toEqual([])
    expect(later).toBeUndefined()
    expect(await userCount(telegramId)).toBe(0)
    expect(logged.events()).toEqual([{ event: 'update', kind, outcome: 'ignored', why, ms: 0 }])
    // To ignore an update is no failure.
    expect(logged.failures()).toEqual([])
  })

  it.each<[what: string, update: (message: object) => Update, kind: string]>([
    ['a message', (message) => ({ message }), 'message'],
    [
      'a message that is not text',
      (message) => unchecked({ message: { ...message, text: undefined, sticker } }),
      'message',
    ],
    ['an edited message', (message) => ({ edited_message: message }), 'edited'],
  ])("ignores %s in a private chat that is not its sender's own", async (_, update, kind) => {
    const [senderId, chatId] = [newTelegramId(), newTelegramId()]
    const { sent, deps } = recorder()
    const logged = catchConsole()

    // The user is known by the sender, and the reply goes to the chat. It would be the sender's reply, sent elsewhere.
    await handleUpdate(deps, update({ ...body, chat: { id: chatId, type: 'private' }, from: { id: senderId } }))

    expect(sent).toEqual([])
    expect(await userCount(senderId)).toBe(0)
    expect(await userCount(chatId)).toBe(0)
    expect(logged.events()).toEqual([{ event: 'update', kind, outcome: 'ignored', why: 'not_own_chat', ms: 0 }])
  })
})

describe('what the log has of an update', () => {
  // A name is what the log has its command as: the command, without the slash. These are the two commands that the
  // bot's list of them does not name: the test after this one has every command that it names.
  it.each(['start', 'code'])('is that /%s came, as the command of that name, and that it was replied to', async (name) => {
    const chat = openChat()
    const logged = catchConsole()

    // With nothing after it. What a command does with that is its own affair: it replies, in text or in a table.
    const reply = await chat.reply(`/${name}`)

    expect(logged.events('update')).toEqual([
      { event: 'update', kind: 'command', command: name, outcome: 'replied', ms: 0 },
    ])
    // It is a command that there is: one that there is not is answered with the list of those that there are.
    expect(reply).not.toBe(COMMANDS)
  })

  it('is each command that the bot lists, under the name that the list gives it', async () => {
    const chat = openChat()
    // The names at the start of the lines of the list, each of them once: /spend is there with and without a card.
    const lines = (await chat.say('/help')).split('\n')
    const listed = [...new Set(lines.flatMap((line) => /^\/([a-z]+)/.exec(line)?.[1] ?? []))]
    expect(listed).toHaveLength(19)
    const logged = catchConsole()

    for (const name of listed) await chat.reply(`/${name}`)

    expect(logged.events('update').map((event) => event.command)).toEqual(listed)
  })

  it.each<[what: string, text: string, as: object]>([
    ['a command that there is not', '/nosuchcommand', { kind: 'command', command: 'unknown' }],
    ['a slash with nothing after it', '/', { kind: 'command', command: 'unknown' }],
    ['a command with arguments', '/addcard visa 1234 calendar', { kind: 'command', command: 'addcard' }],
    ['a command in capitals, with the name of a bot', '/SPEND@SpendTrackerBot', { kind: 'command', command: 'spend' }],
    ['a command that only starts like one of the bot’s', '/spending', { kind: 'command', command: 'unknown' }],
    ['the six digits of a sign-in', '123456', { kind: 'code' }],
    ['the six digits of a sign-in, after /code', '/code 123456', { kind: 'command', command: 'code' }],
    // The service of these tests has no assistant, so a question is answered at once, with that.
    ['a question', 'How much have I spent?', { kind: 'question' }],
    ['the name of a command with no slash, which is a question', 'spend', { kind: 'question' }],
  ])('is that %s came, as what it is, and that it was replied to', async (_, text, as) => {
    const chat = openChat()
    const logged = catchConsole()

    await chat.say(text)

    expect(logged.events('update')).toEqual([{ event: 'update', ...as, outcome: 'replied', ms: 0 }])
  })

  it('is how long the handling took, by the clock that the service goes by', async () => {
    const telegramId = newTelegramId()
    const { deps } = recorder()
    await handleUpdate(deps, privateMessage(telegramId, '/start'))
    let now = NOW.getTime()
    // The database takes 40 milliseconds over each statement, and Telegram takes 300 over the reply.
    const prepare = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      now += 40
      return prepare(query)
    })
    vi.spyOn(deps.messenger, 'send').mockImplementation(async () => {
      now += 300
    })
    const logged = catchConsole()

    // Two statements: the user is looked up, and then their cards.
    await handleUpdate({ ...deps, now: () => new Date(now) }, privateMessage(telegramId, '/cards'))

    expect(logged.events()).toEqual([
      { event: 'update', kind: 'command', command: 'cards', outcome: 'replied', ms: 2 * 40 + 300 },
    ])
  })

  it('is nothing of what a message said, and nothing that Telegram knows its user or its chat by', async () => {
    const logged = catchConsole()
    const chat = openChat()

    await chat.say('/addcard privatecard 4321 calendar')
    await chat.say('/add privatecard 98.76 PRIVATE CLINIC')
    await chat.say('/remove 424242')
    await chat.say('/timezone Asia/Tokyo')
    await chat.say('/nosuchcommand PRIVATE')
    await chat.say('What did I spend at PRIVATE CLINIC?')

    expect(logged.events().map((event) => [event.kind, event.command])).toEqual([
      ['command', 'addcard'],
      ['command', 'add'],
      ['command', 'remove'],
      ['command', 'timezone'],
      ['command', 'unknown'],
      ['question', undefined],
    ])
    const never = ['privatecard', '4321', '98.76', '9876', 'PRIVATE', 'CLINIC', 'calendar', '424242', 'Tokyo', 'nosuch']
    for (const text of [...never, 'What did', String(chat.telegramId)]) expect(logged.text()).not.toContain(text)
  })
})

/** The line that the log has of a message whose handling failed, by the fake clock of these tests: in no time. */
function failedLine(as: object, handled: boolean, told = true) {
  return { event: 'update', ...as, outcome: 'failed', handled, told, ms: 0 }
}

describe('an update whose handling fails', () => {
  it('has its chat told in one line that something went wrong, and is logged as one that failed', async () => {
    const telegramId = newTelegramId()
    const { sent, deps } = recorder()
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('a made-up failure that quotes: /addcard visa 1234 calendar')
    })
    const logged = catchConsole()

    // It does not throw: there is nobody for it to throw to, and Telegram is to be told that the update was taken.
    const later = await handleUpdate(deps, privateMessage(telegramId, '/addcard visa 1234 calendar'))

    expect(later).toBeUndefined()
    expect(sent).toEqual([{ chatId: telegramId, text: FAILED }])
    // The command failed on the database before anything was done, which is what `handled` says of it.
    const line = failedLine({ kind: 'command', command: 'addcard' }, false)
    expect(logged.events()).toEqual([{ ...line, error: 'Error' }])
    // A failure is written at the level of one, with the name of its error and nothing that the error said.
    expect(logged.failures()).toEqual(logged.events())
    for (const text of ['visa', '1234', 'made-up']) expect(logged.text()).not.toContain(text)
  })

  it.each<[what: string, update: (id: number) => Update, kind: string]>([
    [
      'a message that is not text',
      (id) => unchecked({ message: { message_id: 1, sticker, chat: { id, type: 'private' }, from: { id } } }),
      'not_text',
    ],
    ['an edited message', (id) => ({ edited_message: privateMessage(id, 'How much?').message }), 'edited'],
  ])('is logged as what it was when it is %s whose reply cannot be sent, with its chat told the same', async (_, update, kind) => {
    const telegramId = newTelegramId()
    const { sent, deps } = recorder()
    // Telegram cannot be reached for the reply, and can after that.
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TypeError('A made-up failure of the network'))
    const logged = catchConsole()

    await handleUpdate(deps, update(telegramId))

    // The bot does nothing about such a message but reply to it, so it is no message that was handled.
    expect(sent).toEqual([{ chatId: telegramId, text: FAILED }])
    expect(logged.events()).toEqual([{ ...failedLine({ kind }, false), error: 'TypeError' }])
  })

  it('is logged as the code of a sign-in when it is one that cannot be checked, with nothing of the code', async () => {
    const telegramId = newTelegramId()
    const { sent, deps } = recorder()
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new TypeError('A made-up failure of the database')
    })
    const logged = catchConsole()

    await handleUpdate(deps, privateMessage(telegramId, '123456'))

    expect(sent).toEqual([{ chatId: telegramId, text: FAILED }])
    expect(logged.events()).toEqual([{ ...failedLine({ kind: 'code' }, false), error: 'TypeError' }])
    expect(logged.text()).not.toContain('123456')
  })

  it('is logged as one that nobody was told of, when the chat is one that Telegram will send nothing to', async () => {
    const telegramId = newTelegramId()
    const { sent, deps } = recorder()
    // The reply to /products is a rich message, which Telegram takes for the chat no more than it takes text.
    const send = vi.spyOn(deps.messenger, 'send').mockRejectedValue(new ChatBlockedError())
    const sendRich = vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new ChatBlockedError())
    const logged = catchConsole()

    await handleUpdate(deps, privateMessage(telegramId, '/products'))

    // The reply was tried, and nothing after it: not the reply as text, and not that something went wrong.
    expect(sendRich).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    const line = failedLine({ kind: 'command', command: 'products' }, true, false)
    expect(logged.events()).toEqual([{ ...line, error: 'ChatBlockedError', reason: 'chat_blocked' }])
  })

  it('is logged as one that nobody was told of, when what the chat was to be told cannot be sent either', async () => {
    const telegramId = newTelegramId()
    const { deps } = recorder()
    // Telegram takes nothing: not the rich message that the reply to /products is, not the reply as text, which is
    // sent in the place of that, and not what the chat is then to be told.
    vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new TelegramError('sendRichMessage', 502))
    const send = vi.spyOn(deps.messenger, 'send').mockRejectedValue(new TelegramError('sendMessage', 502))
    const logged = catchConsole()

    await handleUpdate(deps, privateMessage(telegramId, '/products'))

    expect(send.mock.calls).toEqual([
      [telegramId, expect.stringMatching(/^The card products whose reward rules are known:/), undefined, undefined],
      [telegramId, FAILED],
    ])
    const line = failedLine({ kind: 'command', command: 'products' }, true, false)
    expect(logged.events()).toEqual([{ ...line, error: 'Error', reason: 'http_error', status: 502 }])
  })
})

describe('a message that was handled, whose reply cannot be sent', () => {
  it.each<[what: string, text: string, as: object]>([
    // What these two make is nowhere but in the reply that was lost: to send them again is the way to it.
    ['an /mcp, which made a token', '/mcp', { kind: 'command', command: 'mcp' }],
    ['a /connect, which made a link', '/connect', { kind: 'command', command: 'connect' }],
    ['a command that changed nothing', '/cards', { kind: 'command', command: 'cards' }],
    ['a command that there is not', '/nosuchcommand', { kind: 'command', command: 'unknown' }],
    ['a question, on a service with no assistant', 'How much have I spent?', { kind: 'question' }],
  ])('is answered with "try again" when it is %s, and logged as one that had been handled', async (_, text, as) => {
    const telegramId = newTelegramId()
    const { sent, deps } = recorder()
    // Telegram refuses the reply, and takes what comes after it.
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TelegramError('sendMessage', 502))
    const logged = catchConsole()

    await handleUpdate(deps, privateMessage(telegramId, text))

    // Sent again, none of these does any harm. So the chat is told what it is told when anything else fails.
    expect(sent).toEqual([{ chatId: telegramId, text: FAILED }])
    expect(logged.events('update')).toEqual([
      { ...failedLine(as, true), error: 'Error', reason: 'http_error', status: 502 },
    ])
  })
})

describe('an /add whose purchase is stored, when something fails after that', () => {
  /** A user with a card, and the messenger and the messages of somebody who is to get the reply to their /add. */
  async function shopper() {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    return { chat, ...recorder() }
  }

  /** The line of an /add that failed once its purchase was stored: handled, with its user told. */
  const STORED = failedLine({ kind: 'command', command: 'add' }, true)

  it('is told that the purchase was stored, and not to try again, when what its card comes to cannot be read', async () => {
    const { chat, sent, deps } = await shopper()
    // The purchase goes in, and the database fails at the next thing: the reading of what the card then comes to.
    const prepare = env.DB.prepare.bind(env.DB)
    const queried = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('SUM(amount_minor)')) throw new Error('a made-up failure that quotes: Lunch')
      return prepare(query)
    })
    const logged = catchConsole()

    await handleUpdate(deps, privateMessage(chat.telegramId, '/add visa 12.50 Lunch'))

    // The insert went through before the statement that failed.
    const statements = queried.mock.calls.map(([query]) => query)
    const inserted = statements.findIndex((query) => query.includes('INSERT INTO transactions'))
    expect(inserted).toBeGreaterThan(-1)
    expect(statements.findIndex((query) => query.includes('SUM(amount_minor)'))).toBeGreaterThan(inserted)
    queried.mockRestore()
    // So the chat is not told to try again, which would store the purchase a second time.
    expect(sent).toEqual([{ chatId: chat.telegramId, text: STORED_NO_REPLY }])
    expect(sent[0].text).not.toMatch(/try again/i)
    expect(logged.events()).toEqual([{ ...STORED, error: 'Error' }])
    expect(logged.text()).not.toContain('Lunch')
    // The purchase is stored, once.
    expect(await chat.lines('/spend')).toContain('visa | SGD 12.50 | 1 | 29 Sep to 29 Oct | 1 Nov')
  })

  it('is told the same when it is the reply that Telegram refuses: sent again, its words would store another', async () => {
    const { chat, sent, deps } = await shopper()
    // Telegram refuses the reply, and takes what comes after it.
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TelegramError('sendMessage', 502))
    const logged = catchConsole()

    await handleUpdate(deps, privateMessage(chat.telegramId, '/add visa 12.50 Lunch'))

    expect(sent).toEqual([{ chatId: chat.telegramId, text: STORED_NO_REPLY }])
    expect(logged.events()).toEqual([{ ...STORED, error: 'Error', reason: 'http_error', status: 502 }])
    expect(await chat.lines('/spend')).toContain('visa | SGD 12.50 | 1 | 29 Sep to 29 Oct | 1 Nov')

    // Which is what the advice is for: the same words in a new message are a second purchase.
    await chat.say('/add visa 12.50 Lunch')
    expect(await chat.lines('/spend')).toContain('visa | SGD 25.00 | 2 | 29 Sep to 29 Oct | 1 Nov')
  })

  it('is told the same when Telegram delivers its message again, and it is the reply to that which fails', async () => {
    const { chat, sent, deps } = await shopper()
    const message = privateMessage(chat.telegramId, '/add visa 12.50 Lunch')
    await handleUpdate(deps, message)
    expect(sent).toHaveLength(1)
    sent.length = 0
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TelegramError('sendMessage', 502))
    const logged = catchConsole()

    // The message as it was, with the id that it had: its purchase is the one that the first delivery stored.
    await handleUpdate(deps, message)

    expect(sent).toEqual([{ chatId: chat.telegramId, text: STORED_NO_REPLY }])
    expect(logged.events()).toEqual([{ ...STORED, error: 'Error', reason: 'http_error', status: 502 }])
    expect(await chat.lines('/spend')).toContain('visa | SGD 12.50 | 1 | 29 Sep to 29 Oct | 1 Nov')
  })
})

describe('an /add that stored no purchase, whose reply cannot be sent', () => {
  /** The line of an /add that failed with nothing stored for its message: not handled, with its user told. */
  const NOT_STORED = failedLine({ kind: 'command', command: 'add' }, false)
  const refused = { error: 'Error', reason: 'http_error', status: 502 }

  it.each<[what: string, text: string]>([
    ['names no card of its user’s', '/add amex 12.50 Lunch'],
    ['gives no amount', '/add visa Lunch'],
  ])('is answered with "try again" when it %s: there is no purchase to store twice', async (_, text) => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    const { sent, deps } = recorder()
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TelegramError('sendMessage', 502))
    const logged = catchConsole()

    await handleUpdate(deps, privateMessage(chat.telegramId, text))

    expect(sent).toEqual([{ chatId: chat.telegramId, text: FAILED }])
    expect(logged.events()).toEqual([{ ...NOT_STORED, ...refused }])
  })

  it('is answered with "try again" when its purchase is one too many for a day, and was not stored', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    const userId = (await chat.user()).id
    for (let added = 1; added <= 100; added++) await buy(userId, { parser: 'manual' })
    const { sent, deps } = recorder()
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TelegramError('sendMessage', 502))
    const logged = catchConsole()

    await handleUpdate(deps, privateMessage(chat.telegramId, '/add visa 12.50 One too many'))

    expect(sent).toEqual([{ chatId: chat.telegramId, text: FAILED }])
    expect(logged.events()).toEqual([{ ...NOT_STORED, ...refused }])
    expect((await rowsOwnedBy(userId))?.transactions).toBe(100)
  })

  it('is answered with "try again" when its message comes again after its purchase was taken out', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    const { sent, deps } = recorder()
    const message = privateMessage(chat.telegramId, '/add visa 12.50 Lunch')
    await handleUpdate(deps, message)
    const [, id] = /^ID (\d+) /.exec(sent[0].text) ?? []
    await chat.say(`/remove ${id}`)
    sent.length = 0
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TelegramError('sendMessage', 502))
    const logged = catchConsole()

    // The message as it was. Its purchase is not added again, which is what the reply that fails was to say.
    await handleUpdate(deps, message)

    expect(sent).toEqual([{ chatId: chat.telegramId, text: FAILED }])
    expect(logged.events()).toEqual([{ ...NOT_STORED, ...refused }])
  })
})
