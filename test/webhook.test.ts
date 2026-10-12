import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODEL } from '../src/ai/provider'
import worker from '../src/index'
import { BY_HAND_NOTE } from '../src/telegram/purchases'
import { busyReply } from '../src/telegram/replies'
import { ASK, EDITED, FAILED, WELCOME, WORKING } from '../src/telegram/texts'
import { AI_URL, refusing, saying } from './ai-helpers'
import { newTelegramId, userCount, withoutCarried } from './helpers'
import { catchConsole } from './log-helpers'

const SECRET = env.TELEGRAM_WEBHOOK_SECRET

/** How long the handling of an update took, which is whatever it took: the Worker goes by the real clock. */
const took = expect.any(Number)

/**
 * The line that the log has of an update whose handling failed: what the update was, whether what it asked for had
 * been done by then, and whether whoever sent it was told. A test says what its line has of the failure besides.
 */
function failedUpdate(as: object, handled: boolean, told: boolean) {
  return { event: 'update', ...as, outcome: 'failed', handled, told, ms: took }
}

/** The line that the log has of a request that Telegram answered with an error: its method, and the status. */
function refusedCall(method: string, status: number) {
  return { event: 'telegram_failed', method, status, error: 'Error', reason: 'http_error' }
}

// The Worker sends its replies with the global fetch. It is replaced here, so
// these tests see what would be sent to Telegram without sending anything.
const telegramApi = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()

// The Worker asks the AI provider with the global fetch too. What it posts there comes to this, and is no call of
// `telegramApi`. A test that has a question answered says what the provider answers with.
const provider = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()

/** How many messages the stand-in for Telegram has sent in a test. The number of a message is its id. */
let messagesSent = 0

/**
 * Telegram's answer to a request that it takes, as far as the Worker reads one: to a request that sends a message,
 * the message with the id that Telegram gave it, which is what the Worker edits or deletes the message by.
 */
function taken(url: string): Response {
  const sends = url.endsWith('/sendMessage') || url.endsWith('/sendRichMessage')
  return Response.json({ ok: true, result: sends ? { message_id: ++messagesSent, date: 1 } : true })
}

beforeEach(() => {
  messagesSent = 0
  telegramApi.mockReset()
  telegramApi.mockImplementation(async (url) => taken(url))
  provider.mockReset()
  provider.mockImplementation(async () => {
    throw new Error('A test made a request it should not have')
  })
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => (url === AI_URL ? provider : telegramApi)(url, init))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * A request as the Worker's own handler takes one. The handler is called with one, in place of the Worker being
 * fetched from, where a test brings an execution context or settings of its own.
 */
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>

/** Calls the Worker and returns the status and body of its response. */
async function request(method: string, path: string, init: { secret?: string; body?: string } = {}) {
  const response = await exports.default.fetch(`https://spend-tracker.test${path}`, {
    method,
    headers: init.secret === undefined ? {} : { 'X-Telegram-Bot-Api-Secret-Token': init.secret },
    body: init.body,
  })
  return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() }
}

/** The body Telegram posts when a user sends /start in a private chat. */
function startMessage(telegramId: number): string {
  const message = { message_id: 1, text: '/start', chat: { id: telegramId, type: 'private' }, from: { id: telegramId } }
  return JSON.stringify({ update_id: 1, message })
}

let lastMessage = 0

/**
 * Posts the Worker a message that a user sent in their private chat with the bot, as Telegram does: with an id that
 * no message before it had.
 */
function say(telegramId: number, text: string) {
  const [chat, from] = [{ id: telegramId, type: 'private' }, { id: telegramId }]
  const message = { message_id: ++lastMessage, date: 1, text, chat, from }
  return request('POST', '/telegram', { secret: SECRET, body: JSON.stringify({ update_id: 1, message }) })
}

/** A message as the Worker posts it to Telegram, with the buttons under it. */
interface Sent {
  chat_id: number
  text: string
  entities?: { type: string; offset: number; length: number }[]
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] }
}

/**
 * What the Worker has asked of the Telegram API since the calls were last cleared: the method of each request, and
 * what it was sent. The Worker goes by the real clock, and on the last two days of a month a purchase that is made
 * today is counted in the next month, which the bot's message about it says in a line of its own. That line is
 * taken out here, so that the tests say the same on every day: see `withoutCarried`.
 */
function asked(): [method: string, body: Record<string, unknown>][] {
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/`
  return telegramApi.mock.calls.map(([url, init]) => {
    expect(url.startsWith(api)).toBe(true)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    return [url.slice(api.length), withoutCarried(JSON.parse(init.body as string))]
  })
}

/** Posts the Worker a message, and returns the one message that it sends in reply. The calls are cleared after it. */
async function replyTo(telegramId: number, text: string): Promise<Sent> {
  telegramApi.mockClear()
  await say(telegramId, text)
  const [[method, body], ...more] = asked()
  expect(method).toBe('sendMessage')
  expect(more).toEqual([])
  telegramApi.mockClear()
  return body as unknown as Sent
}

/**
 * Posts the Worker the press of a button under a message of the bot's, as Telegram does: with what the button holds,
 * and with the message as it stands.
 */
function press(telegramId: number, { text, entities }: Pick<Sent, 'text' | 'entities'>, data: unknown) {
  const message = { message_id: 77, date: 1, chat: { id: telegramId, type: 'private' }, text, entities }
  const callback_query = { id: 'press-1', from: { id: telegramId }, chat_instance: 'made-up', data, message }
  return request('POST', '/telegram', { secret: SECRET, body: JSON.stringify({ update_id: 2, callback_query }) })
}

describe('POST /telegram', () => {
  it.each([
    ['no secret', undefined, 'no_secret'],
    ['an empty secret', '', 'no_secret'],
    ['a wrong secret', 'not-the-secret', 'wrong_secret'],
    ['a wrong secret of the right length', SECRET.replace(/.$/, '!'), 'wrong_secret'],
    ['the start of the secret', SECRET.slice(0, -1), 'wrong_secret'],
    ['the secret with more after it', `${SECRET}!`, 'wrong_secret'],
  ])('answers 401 to %s and handles nothing, which it logs with nothing of a secret', async (_, secret, why) => {
    const telegramId = newTelegramId()
    const logged = catchConsole()

    const response = await request('POST', '/telegram', { secret, body: startMessage(telegramId) })

    expect(response.status).toBe(401)
    expect(telegramApi).not.toHaveBeenCalled()
    expect(await userCount(telegramId)).toBe(0)
    // Whether a secret came with the request, and nothing of the one that did or of the one that it was to be.
    expect(logged.events()).toEqual([{ event: 'webhook_refused', why }])
    for (const text of [SECRET, secret || SECRET, String(telegramId)]) expect(logged.text()).not.toContain(text)
  })

  it('answers 200 to the right secret and replies through the Telegram API', async () => {
    const telegramId = newTelegramId()

    const response = await request('POST', '/telegram', { secret: SECRET, body: startMessage(telegramId) })

    expect(response.status).toBe(200)
    expect(await userCount(telegramId)).toBe(1)
    expect(telegramApi).toHaveBeenCalledTimes(1)
    const [url, init] = telegramApi.mock.calls[0]
    expect(url).toBe(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`)
    expect(init.method).toBe('POST')
    // Plain text, with nothing marked in it and no parse mode, and with no link previewed.
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: telegramId,
      text: expect.stringContaining(WELCOME),
      link_preview_options: { is_disabled: true },
    })
  })

  it('adds a purchase once when Telegram posts the same update twice, and replies to both', async () => {
    const telegramId = newTelegramId()
    await say(telegramId, '/addcard visa 1234 calendar')
    const [chat, from] = [{ id: telegramId, type: 'private' }, { id: telegramId }]
    const message = { message_id: 9001, date: 1, text: '/add visa 12.50 Lunch', chat, from }
    const body = JSON.stringify({ update_id: 7, message })
    telegramApi.mockClear()

    // Telegram posts an update again when it has not heard that the update was taken.
    const responses = [
      await request('POST', '/telegram', { secret: SECRET, body }),
      await request('POST', '/telegram', { secret: SECRET, body }),
    ]

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const [[, first], [, again], ...more] = asked()
    expect(more).toEqual([])
    // The second reply is the first again: the same purchase, counted once in the total of its card.
    expect(first.text).toMatch(/^ID \d+ · \d+ \w+ · SGD 12\.50 · Lunch · by hand\n/)
    expect(first.text).toMatch(/\nvisa ••••1234: SGD 12\.50 in 1 purchase, resets 1 \w+$/)
    expect(again).toEqual(first)
  })

  it('still answers 200 when Telegram takes no reply, not even that something went wrong, and logs no message content', async () => {
    const logged = catchConsole()
    const telegramId = newTelegramId()
    telegramApi.mockImplementation(async () => new Response('Internal Server Error', { status: 500 }))

    const response = await request('POST', '/telegram', { secret: SECRET, body: startMessage(telegramId) })

    expect(response.status).toBe(200)
    // The welcome, and then one line to say that it failed, which Telegram takes no more than it took the welcome.
    expect(asked()).toEqual([
      ['sendMessage', expect.objectContaining({ text: expect.stringContaining(WELCOME) })],
      ['sendMessage', { chat_id: telegramId, text: FAILED, link_preview_options: { is_disabled: true } }],
    ])
    // Both requests are logged. The update is logged as one that failed when all that was left of it was the
    // sending of its reply, with nobody told.
    const failure = { error: 'Error', reason: 'http_error', status: 500 }
    expect(logged.events()).toEqual([
      refusedCall('sendMessage', 500),
      refusedCall('sendMessage', 500),
      { ...failedUpdate({ kind: 'command', command: 'start' }, true, false), ...failure },
    ])
    for (const text of ['Welcome', 'Something went wrong', 'Internal Server Error', String(telegramId)]) {
      expect(logged.text()).not.toContain(text)
    }
  })

  it('still answers 200 to a body that is not JSON, and logs none of it', async () => {
    const logged = catchConsole()

    const response = await request('POST', '/telegram', { secret: SECRET, body: 'private words that are not JSON' })

    expect(response.status).toBe(200)
    expect(telegramApi).not.toHaveBeenCalled()
    // An update that could not be read, which there is nobody to tell of. Only the name of the error is logged.
    expect(logged.events()).toEqual([
      { ...failedUpdate({ kind: 'unreadable' }, false, false), error: 'SyntaxError' },
    ])
    expect(logged.text()).not.toContain('private')
  })
})

describe('POST /telegram when the handling of a message fails', () => {
  /** Has the database fail at every statement that reads a user's cards, with an error that quotes a card. */
  function failAtCards() {
    const prepare = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('FROM cards')) throw new Error('a made-up failure that quotes a card: visa 1234')
      return prepare(query)
    })
  }

  it('says to try again when it is the reply to /mcp, whose token is nowhere but in its reply that Telegram refuses', async () => {
    const telegramId = newTelegramId()
    telegramApi.mockImplementationOnce(async () => new Response('Bad Gateway', { status: 502 }))
    const logged = catchConsole()

    const response = await say(telegramId, '/mcp')

    // Sent again, the command does no harm, and for a token it is the only way to one that its user has seen.
    expect(response.status).toBe(200)
    expect(asked().map(([method, body]) => [method, body.text])).toEqual([
      ['sendMessage', expect.any(String)],
      ['sendMessage', FAILED],
    ])
    const failure = { error: 'Error', reason: 'http_error', status: 502 }
    expect(logged.events()).toEqual([
      refusedCall('sendMessage', 502),
      { ...failedUpdate({ kind: 'command', command: 'mcp' }, true, true), ...failure },
    ])
    // Nothing of the token that was made and lost is in the log.
    expect(logged.text()).not.toContain('stmcp_')
  })

  it('answers 200 all the same when the chat cannot be told that something went wrong, which is logged', async () => {
    const telegramId = newTelegramId()
    failAtCards()
    telegramApi.mockImplementation(async () => new Response('Bad Gateway', { status: 502 }))
    const logged = catchConsole()

    const response = await say(telegramId, '/spend')

    expect(response.status).toBe(200)
    expect(asked()).toEqual([
      ['sendMessage', { chat_id: telegramId, text: FAILED, link_preview_options: { is_disabled: true } }],
    ])
    // What the update failed with is the database's error, and the telling that failed has its own line before it.
    // That line does not make the command one that had been handled: `handled` says that it was not.
    expect(logged.events()).toEqual([
      refusedCall('sendMessage', 502),
      { ...failedUpdate({ kind: 'command', command: 'spend' }, false, false), error: 'Error' },
    ])
  })
})

describe('POST /telegram with buttons', () => {
  const MERCHANT = '𝒳 Lunch /start'

  /**
   * A user with a card that is linked to a product, and the bot's message about a purchase on it: one that is online,
   * as no rule places it. With the message comes the id of the purchase, which the message begins with.
   */
  async function onlinePurchase() {
    const telegramId = newTelegramId()
    await say(telegramId, '/addcard evol 1234 calendar uob-evol')
    const message = await replyTo(telegramId, `/add evol 12.50 ${MERCHANT}`)
    const [, id] = /^ID (\d+) /.exec(message.text) ?? []
    return { telegramId, message, id }
  }

  it('sends a message with its button as an inline keyboard, and what the button holds for the bot', async () => {
    const { telegramId, message, id } = await onlinePurchase()

    const [purchased, total, sorted] = message.text.split('\n')
    expect(purchased).toMatch(new RegExp(`^ID ${id} · \\d+ \\w+ · SGD 12\\.50 · ${MERCHANT} · by hand$`))
    expect(total).toMatch(/^evol ••••1234: SGD 12\.50 in 1 purchase, resets 1 \w+$/)
    expect(sorted).toBe(`ID ${id}: Online / Mobile Contactless Spend`)
    expect(message).toEqual({
      chat_id: telegramId,
      text: message.text,
      // The merchant's name is marked as code, so that nothing in it can be tapped.
      entities: [{ type: 'code', offset: message.text.indexOf(MERCHANT), length: MERCHANT.length }],
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: 'Mark as Other Spend', callback_data: `${id}:other` }]] },
    })
  })

  it('answers a press and edits the message it was made under, in one request each', async () => {
    const { telegramId, message, id } = await onlinePurchase()
    const [purchased, total] = message.text.split('\n')

    const response = await press(telegramId, message, `${id}:other`)

    expect(response.status).toBe(200)
    expect(asked()).toEqual([
      ['answerCallbackQuery', { callback_query_id: 'press-1', text: `ID ${id}: Other Spend` }],
      [
        'editMessageText',
        {
          chat_id: telegramId,
          message_id: 77,
          text: `${purchased}\n${total}\nID ${id}: Other Spend`,
          entities: message.entities,
          link_preview_options: { is_disabled: true },
          // The button that flagged the purchase gives way to the one that takes the flag off.
          reply_markup: {
            inline_keyboard: [[{ text: 'Mark as Online / Mobile Contactless Spend', callback_data: `${id}:online` }]],
          },
        },
      ],
    ])
  })

  it.each([
    ['something that is not text', { purchase: 1 }],
    ['nothing', undefined],
  ])('answers a press that brings %s, and does nothing else', async (_, data) => {
    const { telegramId, message } = await onlinePurchase()

    const response = await press(telegramId, message, data)

    expect(response.status).toBe(200)
    expect(asked()).toEqual([
      ['answerCallbackQuery', { callback_query_id: 'press-1', text: 'That button no longer works.' }],
    ])
  })

  it('logs a press that is carried through as an update that was replied to, with nothing of the press', async () => {
    const { telegramId, message, id } = await onlinePurchase()
    const logged = catchConsole()

    await press(telegramId, message, `${id}:other`)
    await press(telegramId, message, 'DROP TABLE transactions')

    // A press that brings what no button holds is answered too, with that the button no longer works.
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'press', outcome: 'replied', ms: took },
      { event: 'update', kind: 'press', outcome: 'replied', ms: took },
    ])
    for (const text of ['press-1', ':other', 'DROP', 'made-up', String(telegramId)]) {
      expect(logged.text()).not.toContain(text)
    }
  })
})

describe('POST /telegram with /spend and a card', () => {
  /** A name with what Telegram would make a command, a link and a mention of, and with the markup of a tag. */
  const MERCHANT = 'Lunch /start https://attacker.test/x <b>@someone</b>'

  /** The line under the total of the card: which days of purchases the total counts, whatever today is, and why. */
  const COUNTS = new RegExp(
    '^The total counts purchases made from \\d+ \\w+ to \\d+ \\w+\\. The bank counts a purchase by the day it is ' +
      'posted, so one made in the last 2 days of a month is counted in the next month\\.$',
  )

  /** A user with a card, and the id of the one purchase on it, which its user added by hand. */
  async function purchaseOnCard() {
    const telegramId = newTelegramId()
    await say(telegramId, '/addcard visa 1234 calendar')
    const [, id] = /^ID (\d+) /.exec((await replyTo(telegramId, `/add visa 12.50 ${MERCHANT}`)).text) ?? []
    return { telegramId, id }
  }

  it('sends the purchases as one rich message, in whose plain text Telegram is to detect nothing', async () => {
    const { telegramId, id } = await purchaseOnCard()

    const response = await say(telegramId, '/spend visa')

    expect(response.status).toBe(200)
    expect(asked()).toEqual([
      [
        'sendRichMessage',
        {
          chat_id: telegramId,
          rich_message: {
            skip_entity_detection: true,
            blocks: [
              {
                type: 'paragraph',
                text: { type: 'bold', text: expect.stringMatching(/^visa ••••1234: 1 \w+ to \d+ \w+$/) },
              },
              {
                type: 'table',
                is_bordered: true,
                cells: [
                  [
                    { text: 'ID', is_header: true },
                    { text: 'Date', is_header: true },
                    { text: 'SGD', is_header: true, align: 'right' },
                    { text: 'Merchant', is_header: true },
                  ],
                  [
                    { text: `${id}*`, align: 'right' },
                    { text: expect.stringMatching(/^\d+ \w+$/) },
                    { text: '12.50', align: 'right' },
                    // The merchant's name as it was given, and as a string, which is plain text.
                    { text: MERCHANT },
                  ],
                  [{ text: 'Total', colspan: 2 }, { text: '12.50', align: 'right' }, { text: '' }],
                ],
              },
              { type: 'paragraph', text: BY_HAND_NOTE },
              { type: 'paragraph', text: expect.stringMatching(/^Total: SGD 12\.50 in 1 purchase, resets 1 \w+$/) },
              { type: 'paragraph', text: expect.stringMatching(COUNTS) },
            ],
          },
        },
      ],
    ])
  })

  it('sends text instead when Telegram answers the rich message with an error, and logs only the status', async () => {
    const { telegramId, id } = await purchaseOnCard()
    // An answer can quote what it was sent.
    const refusal = { ok: false, error_code: 400, description: `Bad Request: can't parse ${MERCHANT}` }
    telegramApi.mockImplementation(async (url) =>
      url.endsWith('/sendRichMessage') ? Response.json(refusal, { status: 400 }) : Response.json({ ok: true }),
    )
    const logged = catchConsole()

    const response = await say(telegramId, '/spend visa')

    expect(response.status).toBe(200)
    const [[first], [second, body], ...more] = asked()
    expect([first, second]).toEqual(['sendRichMessage', 'sendMessage'])
    expect(more).toEqual([])
    const { text, entities = [], ...rest } = body as unknown as Sent
    expect(rest).toEqual({ chat_id: telegramId, link_preview_options: { is_disabled: true } })
    expect(text).toMatch(/^visa ••••1234: 1 \w+ to \d+ \w+\n\n/)
    // After the table comes what its mark means, and then the total with the days that it counts.
    const [mark, below] = text.split('\n\n').slice(-2)
    expect(mark).toBe(BY_HAND_NOTE)
    expect(below.split('\n')).toEqual([
      expect.stringMatching(/^Total: SGD 12\.50 in 1 purchase, resets 1 \w+$/),
      expect.stringMatching(COUNTS),
    ])
    // The table is a block of letters of one width, with the name cut to what a row has room for.
    expect(entities.map((entity) => entity.type)).toEqual(['pre'])
    const rows = text.slice(entities[0].offset, entities[0].offset + entities[0].length).split('\n')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatch(/^ID +Date +SGD  Merchant$/)
    expect(rows[1]).toMatch(new RegExp(`^ *${id}\\* +\\d+ \\w+  12\\.50  Lunch /start.*…$`))
    expect(rows[2]).toMatch(/^ +Total +12\.50$/)
    // The request that Telegram refused is logged by its method and by the status of the answer, and the update
    // as one that was replied to all the same. Nothing of what the answer said is logged, or of the command.
    expect(logged.events()).toEqual([
      refusedCall('sendRichMessage', 400),
      { event: 'update', kind: 'command', command: 'spend', outcome: 'replied', ms: took },
    ])
    for (const text of ['Lunch', 'attacker', 'parse', 'visa', '12.50']) expect(logged.text()).not.toContain(text)
  })
})

describe('POST /telegram with a question', () => {
  /** The request that Telegram posts the Worker when a user sends the text in their private chat with the bot. */
  function update(telegramId: number, text: string) {
    const [chat, from] = [{ id: telegramId, type: 'private' }, { id: telegramId }]
    const message = { message_id: ++lastMessage, date: 1, text, chat, from }
    return new IncomingRequest('https://spend-tracker.test/telegram', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify({ update_id: 1, message }),
    })
  }

  /**
   * Posts the Worker a message, and waits for what it leaves to be done once Telegram has been answered. The Worker
   * is called with an execution context of the test's own, which is what can be waited on, and with the settings
   * of the service, or with others that a test gives it.
   */
  async function tell(telegramId: number, text: string, settings: Env = env): Promise<Response> {
    const ctx = createExecutionContext()
    const response = await worker.fetch(update(telegramId, text), settings, ctx)
    await waitOnExecutionContext(ctx)
    return response
  }

  /** The rich message that an answer is sent as: a paragraph to each of the lines. */
  function richAnswer(telegramId: number, ...lines: string[]) {
    const blocks = lines.map((text) => ({ type: 'paragraph', text }))
    return ['sendRichMessage', { chat_id: telegramId, rich_message: { skip_entity_detection: true, blocks } }]
  }

  /** The placeholder that a question is answered with at once: a message of plain text. */
  function placeholder(telegramId: number) {
    return ['sendMessage', { chat_id: telegramId, text: WORKING, link_preview_options: { is_disabled: true } }]
  }

  /** The showing of the chat that the bot is writing. */
  function typing(telegramId: number) {
    return ['sendChatAction', { chat_id: telegramId, action: 'typing' }]
  }

  /** What is said in the place of a placeholder: the message with its id is edited to say it. It has no buttons. */
  function inPlaceOf(telegramId: number, messageId: number, text: string) {
    return [
      'editMessageText',
      {
        chat_id: telegramId,
        message_id: messageId,
        text,
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      },
    ]
  }

  it('answers 200 at once, and has the placeholder and the answer sent in what it leaves for after that', async () => {
    const telegramId = newTelegramId()
    // The model's answer comes when the test lets it.
    let answer = (_: Response) => {}
    provider.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)))
    const ctx = createExecutionContext()
    const waitUntil = vi.spyOn(ctx, 'waitUntil')

    const response = await worker.fetch(update(telegramId, 'How much have I spent?'), env, ctx)

    // Telegram is answered while the model has still to be heard from: the answering is left to the context.
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok\n')
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    // Until the model answers, the chat has the placeholder, and is shown that the bot is writing.
    expect(asked()).toEqual([placeholder(telegramId), typing(telegramId)])

    answer(Response.json(saying('You have spent nothing yet.')))
    await waitOnExecutionContext(ctx)

    // The answer is a message of its own. The placeholder, which is the first message that Telegram sent here, is
    // deleted once the answer is there.
    expect(asked()).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      richAnswer(telegramId, 'You have spent nothing yet.'),
      ['deleteMessage', { chat_id: telegramId, message_id: 1 }],
    ])
    // The provider was asked once, with the key of the service, and with a time in which it has to answer.
    const [[url, init], ...more] = provider.mock.calls
    expect(more).toEqual([])
    expect(url).toBe(AI_URL)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-ai-key')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: DEFAULT_MODEL,
      messages: [{ role: 'system' }, { role: 'user', content: 'How much have I spent?' }],
      // The two tools that read, and the four by which the model says what it was asked to have done: the one that
      // shows what was spent is the first of the six.
      tools: [
        { function: { name: 'show_spending' } },
        { function: { name: 'find_purchases' } },
        { function: { name: 'card_rules' } },
        { function: { name: 'add_purchases' } },
        { function: { name: 'set_category' } },
        { function: { name: 'run_command' } },
      ],
      tool_choice: 'auto',
    })
  })

  it('says that the assistant has reached its limit when the provider answers 429, and logs only that status', async () => {
    const logged = catchConsole()
    const telegramId = newTelegramId()
    provider.mockImplementation(async () => refusing(429, 'Rate limit reached for: What did I buy?')())

    const response = await tell(telegramId, 'What did I buy?')

    expect(response.status).toBe(200)
    expect(provider).toHaveBeenCalledTimes(1)
    // It is said in the place of the placeholder, which is the first message that Telegram sent here.
    expect(asked()).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      inPlaceOf(telegramId, 1, busyReply(undefined)),
    ])
    const refused = { error: 'Error', reason: 'http_error', status: 429 }
    expect(logged.events('question')).toMatchObject([{ outcome: 'busy', sent: 'edit', requests: 1, ...refused }])
    // Both the request and the question are failures, and neither line has what the provider said of the request.
    expect(logged.failures().map((event) => event.event)).toEqual(['ai_call', 'question'])
    for (const text of ['What did I buy', 'Rate limit']) expect(logged.text()).not.toContain(text)
  })

  it('says when to try again when the 429 says how long to wait, and still logs only that status', async () => {
    const logged = catchConsole()
    const telegramId = newTelegramId()
    // The header is in seconds: these are twelve minutes.
    const refusal = refusing(429, 'Rate limit reached for: What did I buy?', { 'retry-after': '720' })
    provider.mockImplementation(async () => refusal())

    const response = await tell(telegramId, 'What did I buy?')

    expect(response.status).toBe(200)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(asked()).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      inPlaceOf(telegramId, 1, busyReply(720)),
    ])
    // How long the provider said to wait is in the line of the request to it, and not in the line of the question.
    expect(logged.events('ai_call')).toMatchObject([{ status: 429, retry_after: 720 }])
    expect(logged.events('question')).toMatchObject([{ outcome: 'busy', error: 'Error', status: 429 }])
    expect(logged.events('question')[0]).not.toHaveProperty('retry_after')
  })

  it('leaves nothing for after its answer of a command, which is answered before it', async () => {
    const telegramId = newTelegramId()
    const ctx = createExecutionContext()
    const waitUntil = vi.spyOn(ctx, 'waitUntil')

    const response = await worker.fetch(update(telegramId, '/start'), env, ctx)

    expect(response.status).toBe(200)
    expect(waitUntil).not.toHaveBeenCalled()
    const [[method, body], ...more] = asked()
    expect(more).toEqual([])
    expect(method).toBe('sendMessage')
    // The welcome says that a question can be asked, and what becomes of one.
    expect(body.text).toContain(ASK)
    expect(provider).not.toHaveBeenCalled()
  })
})

describe('POST /telegram with a message that the bot does not read', () => {
  /** Posts the Worker an update with a message of a user's, in their private chat with the bot. */
  function post(telegramId: number, kind: string, content: object) {
    const [chat, from] = [{ id: telegramId, type: 'private' }, { id: telegramId, is_bot: false, first_name: 'Jane' }]
    const message = { message_id: ++lastMessage, date: 1, chat, from, ...content }
    return request('POST', '/telegram', { secret: SECRET, body: JSON.stringify({ update_id: 3, [kind]: message }) })
  }

  it('answers an edited message with what the bot does not read of it, and asks the model nothing', async () => {
    const telegramId = newTelegramId()
    const logged = catchConsole()

    // A message of text as it stands after it was edited, which is no `message` of the update.
    const response = await post(telegramId, 'edited_message', { edit_date: 2, text: 'How much have I spent?' })

    expect(response.status).toBe(200)
    expect(asked()).toEqual([
      ['sendMessage', { chat_id: telegramId, text: EDITED, link_preview_options: { is_disabled: true } }],
    ])
    // Its words are no question, and no command: nobody is asked, and nothing is stored.
    expect(provider).not.toHaveBeenCalled()
    expect(await userCount(telegramId)).toBe(0)
    // The log has that it came, what it was and that it was replied to, and nothing of the words.
    expect(logged.events()).toEqual([{ event: 'update', kind: 'edited', outcome: 'replied', ms: took }])
    expect(logged.text()).not.toContain('How much')
  })
})

describe('other requests', () => {
  it('answers GET / with the homepage, which names the operator', async () => {
    const response = await request('GET', '/')

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('text/html; charset=utf-8')
    expect(response.text).toContain('<h1>Spend Tracker</h1>')
    expect(response.text).toContain(`run by ${env.OPERATOR_NAME}. Contact: ${env.OPERATOR_CONTACT}`)
  })

  it('answers GET /privacy with the privacy policy, which names the operator', async () => {
    const response = await request('GET', '/privacy')

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('text/html; charset=utf-8')
    expect(response.text).toContain('<h1>Privacy policy</h1>')
    expect(response.text).toContain(`by ${env.OPERATOR_NAME}.`)
    expect(response.text).toContain(`contact: ${env.OPERATOR_CONTACT}`)
  })

  it('says in the privacy policy what becomes of a question, on a service that has an assistant and on no other', async () => {
    const page = (settings: Env) =>
      worker.fetch(new IncomingRequest('https://spend-tracker.test/privacy'), settings, createExecutionContext())

    const [withOne, withNone] = [await page(env), await page({ ...env, AI_API_KEY: '' })]

    expect(await withOne.text()).toContain('<h2>Questions that you ask the bot</h2>')
    expect(await withNone.text()).not.toContain('Questions that you ask the bot')
  })

  it.each([
    ['GET', '/telegram'],
    ['GET', '/nowhere'],
    ['POST', '/'],
    ['POST', '/telegram/'],
    ['POST', '/privacy'],
    ['GET', '/privacy/'],
    ['POST', '/oauth/start'],
    ['POST', '/oauth/callback'],
    ['GET', '/oauth'],
  ])('answers 404 to %s %s', async (method, path) => {
    expect((await request(method, path)).status).toBe(404)
  })
})
