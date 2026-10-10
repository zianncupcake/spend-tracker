import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { AI_URL, calling, refusing, saying } from './ai-helpers'
import { newTelegramId, userCount } from './helpers'

const SECRET = env.TELEGRAM_WEBHOOK_SECRET

// The Worker sends its replies with the global fetch. It is replaced here, so
// these tests see what would be sent to Telegram without sending anything.
const telegramApi = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()

// The Worker asks the AI provider with the global fetch too. What it posts there comes to this, and is no call of
// `telegramApi`. A test that has a question answered says what the provider answers with.
const provider = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()

beforeEach(() => {
  telegramApi.mockReset()
  telegramApi.mockImplementation(async () => Response.json({ ok: true }))
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
 * what it was sent.
 */
function asked(): [method: string, body: Record<string, unknown>][] {
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/`
  return telegramApi.mock.calls.map(([url, init]) => {
    expect(url.startsWith(api)).toBe(true)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    return [url.slice(api.length), JSON.parse(init.body as string)]
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
    ['no secret', undefined],
    ['an empty secret', ''],
    ['a wrong secret', 'not-the-secret'],
    ['a wrong secret of the right length', SECRET.replace(/.$/, '!')],
    ['the start of the secret', SECRET.slice(0, -1)],
    ['the secret with more after it', `${SECRET}!`],
  ])('answers 401 to %s and handles nothing', async (_, secret) => {
    const telegramId = newTelegramId()

    const response = await request('POST', '/telegram', { secret, body: startMessage(telegramId) })

    expect(response.status).toBe(401)
    expect(telegramApi).not.toHaveBeenCalled()
    expect(await userCount(telegramId)).toBe(0)
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
      text: expect.stringContaining('Welcome to Spend Tracker'),
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

  it('still answers 200 when handling fails, and logs no message content', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    telegramApi.mockImplementation(async () => new Response('Internal Server Error', { status: 500 }))

    const response = await request('POST', '/telegram', { secret: SECRET, body: startMessage(newTelegramId()) })

    expect(response.status).toBe(200)
    expect(logged.mock.calls).toEqual([['telegram update failed:', 'Error']])
  })

  it('still answers 200 to a body that is not JSON, and logs none of it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await request('POST', '/telegram', { secret: SECRET, body: 'private words that are not JSON' })

    expect(response.status).toBe(200)
    expect(telegramApi).not.toHaveBeenCalled()
    expect(logged.mock.calls).toEqual([['telegram update failed:', 'SyntaxError']])
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

  it('sends the buttons of a purchase that a rule placed a row to each', async () => {
    const telegramId = newTelegramId()
    await say(telegramId, '/addcard evol 1234 calendar uob-evol')

    const message = await replyTo(telegramId, '/add evol USD 12.50 Lunch')

    const [, id] = /^ID (\d+) /.exec(message.text) ?? []
    expect(message.text.split('\n')[2]).toBe(`ID ${id}: Overseas Foreign Currency Spend`)
    expect(message.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Mark as Online / Mobile Contactless Spend', callback_data: `${id}:online` }],
        [{ text: 'Mark as Other Spend', callback_data: `${id}:other` }],
      ],
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
    ['what no button holds', 'DROP TABLE transactions'],
    ['a purchase that there is not', '999999999:other'],
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

  it('still answers 200 when Telegram will not take the answer to a press, and logs nothing of the press', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { telegramId, message, id } = await onlinePurchase()
    telegramApi.mockImplementation(async () => Response.json({ ok: false, error_code: 400 }, { status: 400 }))

    const response = await press(telegramId, message, `${id}:other`)

    expect(response.status).toBe(200)
    expect(logged.mock.calls).toEqual([['telegram update failed:', 'Error']])
  })
})

describe('POST /telegram with /spend and a card', () => {
  /** A name with what Telegram would make a command, a link and a mention of, and with the markup of a tag. */
  const MERCHANT = 'Lunch /start https://attacker.test/x <b>@someone</b>'

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
              { type: 'paragraph', text: '* = added by hand' },
              { type: 'paragraph', text: expect.stringMatching(/^Total: SGD 12\.50 in 1 purchase, resets 1 \w+$/) },
            ],
          },
        },
      ],
    ])
  })

  it('sends text instead when Telegram answers the rich message with an error, and logs only the status', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { telegramId, id } = await purchaseOnCard()
    // An answer can quote what it was sent.
    const refusal = { ok: false, error_code: 400, description: `Bad Request: can't parse ${MERCHANT}` }
    telegramApi.mockImplementation(async (url) =>
      url.endsWith('/sendRichMessage') ? Response.json(refusal, { status: 400 }) : Response.json({ ok: true }),
    )

    const response = await say(telegramId, '/spend visa')

    expect(response.status).toBe(200)
    const [[first], [second, body], ...more] = asked()
    expect([first, second]).toEqual(['sendRichMessage', 'sendMessage'])
    expect(more).toEqual([])
    const { text, entities = [], ...rest } = body as unknown as Sent
    expect(rest).toEqual({ chat_id: telegramId, link_preview_options: { is_disabled: true } })
    expect(text).toMatch(/^visa ••••1234: 1 \w+ to \d+ \w+\n\n/)
    expect(text).toMatch(/\n\n\* = added by hand\n\nTotal: SGD 12\.50 in 1 purchase, resets 1 \w+$/)
    // The table is a block of letters of one width, with the name cut to what a row has room for.
    expect(entities.map((entity) => entity.type)).toEqual(['pre'])
    const rows = text.slice(entities[0].offset, entities[0].offset + entities[0].length).split('\n')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatch(/^ID +Date +SGD  Merchant$/)
    expect(rows[1]).toMatch(new RegExp(`^${id}\\* +\\d+ \\w+  12\\.50  Lunch /start.*…$`))
    expect(rows[2]).toMatch(/^ +Total +12\.50$/)
    expect(logged.mock.calls).toEqual([['rich message failed, sent as text:', 400]])
  })

  it('sends nothing more to a chat that Telegram will send nothing to, as with any other message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { telegramId } = await purchaseOnCard()
    const refusal = { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }
    telegramApi.mockImplementation(async () => Response.json(refusal, { status: 403 }))

    const response = await say(telegramId, '/spend visa')

    expect(response.status).toBe(200)
    expect(asked().map(([method]) => method)).toEqual(['sendRichMessage'])
    expect(logged.mock.calls).toEqual([['telegram update failed:', 'ChatBlockedError']])
  })
})

describe('POST /telegram with a question', () => {
  /** A name with what Telegram would make a command, a link and a mention of, and with the markup of a tag. */
  const MERCHANT = 'Lunch /start https://attacker.test/x <b>@someone</b>'

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

  it('answers 200 at once, and has the model asked and the answer sent in what it leaves for after that', async () => {
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
    const typing = ['sendChatAction', { chat_id: telegramId, action: 'typing' }]
    expect(asked()).toEqual([typing])

    answer(Response.json(saying('You have spent nothing yet.')))
    await waitOnExecutionContext(ctx)

    expect(asked()).toEqual([typing, richAnswer(telegramId, 'You have spent nothing yet.')])
    // The provider was asked once, with the key of the service, and with a time in which it has to answer.
    const [[url, init], ...more] = provider.mock.calls
    expect(more).toEqual([])
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-ai-key')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'system' }, { role: 'user', content: 'How much have I spent?' }],
      tools: [{ function: { name: 'get_spending_summary' } }, { function: { name: 'list_transactions' } }],
      tool_choice: 'auto',
    })
  })

  it("reads the user's own purchases for the model, which a tool is called for, and sends what the model says", async () => {
    const telegramId = newTelegramId()
    await say(telegramId, '/addcard visa 1234 calendar')
    await say(telegramId, `/add visa 12.50 ${MERCHANT}`)
    telegramApi.mockClear()
    provider
      .mockImplementationOnce(async () => Response.json(calling(['call_1', 'list_transactions', { card: 'visa' }])))
      .mockImplementationOnce(async () => Response.json(saying(`You spent SGD 12.50 at ${MERCHANT}`)))

    const response = await tell(telegramId, 'What did I buy?')

    expect(response.status).toBe(200)
    // The second request holds what the tool came to, under the id of its call.
    const [, [, init]] = provider.mock.calls
    const { messages } = JSON.parse(init.body as string)
    expect(messages.slice(2)).toMatchObject([
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'list_transactions' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'list_transactions' },
    ])
    expect(JSON.parse(messages[3].content).transactions).toMatchObject([
      { cardLast4: '1234', amount: '12.50', currency: 'SGD', merchant: MERCHANT },
    ])
    // The name comes back as a string, which is plain text, in a message in which Telegram is to detect nothing.
    expect(asked()).toEqual([
      ['sendChatAction', { chat_id: telegramId, action: 'typing' }],
      richAnswer(telegramId, `You spent SGD 12.50 at ${MERCHANT}`),
    ])
  })

  it('sends the answer as text, all of it marked as code, when Telegram answers the rich message with an error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const telegramId = newTelegramId()
    const answer = `You spent SGD 12.50 at ${MERCHANT}\n\nNothing else.`
    provider.mockImplementation(async () => Response.json(saying(answer)))
    // An answer can quote what it was sent.
    const refusal = { ok: false, error_code: 400, description: `Bad Request: can't parse ${MERCHANT}` }
    telegramApi.mockImplementation(async (url) =>
      url.endsWith('/sendRichMessage') ? Response.json(refusal, { status: 400 }) : Response.json({ ok: true }),
    )

    const response = await tell(telegramId, 'What did I buy?')

    expect(response.status).toBe(200)
    const text = `You spent SGD 12.50 at ${MERCHANT}\nNothing else.`
    // Three requests, which is the most that a question comes to at Telegram.
    expect(asked()).toEqual([
      ['sendChatAction', { chat_id: telegramId, action: 'typing' }],
      richAnswer(telegramId, `You spent SGD 12.50 at ${MERCHANT}`, 'Nothing else.'),
      [
        'sendMessage',
        {
          chat_id: telegramId,
          text,
          // The whole of it is one stretch of code, in which nothing can be tapped.
          entities: [{ type: 'code', offset: 0, length: text.length }],
          link_preview_options: { is_disabled: true },
        },
      ],
    ])
    expect(logged.mock.calls).toEqual([['rich message failed, sent as text:', 400]])
  })

  it('sends nothing more to a chat that Telegram will send nothing to, and logs only the names of the errors', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const telegramId = newTelegramId()
    provider.mockImplementation(async () => Response.json(saying(`You spent SGD 12.50 at ${MERCHANT}`)))
    const refusal = { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }
    telegramApi.mockImplementation(async () => Response.json(refusal, { status: 403 }))

    const response = await tell(telegramId, 'What did I buy?')

    expect(response.status).toBe(200)
    expect(asked().map(([method]) => method)).toEqual(['sendChatAction', 'sendRichMessage'])
    expect(logged.mock.calls).toEqual([
      ['typing action failed:', 'ChatBlockedError'],
      ['telegram update failed:', 'ChatBlockedError'],
    ])
  })

  it('says that the assistant has reached its limit when the provider answers 429, and logs only that status', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const telegramId = newTelegramId()
    provider.mockImplementation(async () => refusing(429, 'Rate limit reached for: What did I buy?')())

    const response = await tell(telegramId, 'What did I buy?')

    expect(response.status).toBe(200)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(asked()).toEqual([
      ['sendChatAction', { chat_id: telegramId, action: 'typing' }],
      [
        'sendMessage',
        {
          chat_id: telegramId,
          text: 'The assistant has reached its limit for now. Try again later.',
          link_preview_options: { is_disabled: true },
        },
      ],
    ])
    expect(logged.mock.calls).toEqual([['assistant failed:', 429]])
  })

  it('says when to try again when the 429 says how long to wait, and still logs only that status', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const telegramId = newTelegramId()
    // The header is in seconds: these are twelve minutes.
    const refusal = refusing(429, 'Rate limit reached for: What did I buy?', { 'retry-after': '720' })
    provider.mockImplementation(async () => refusal())

    const response = await tell(telegramId, 'What did I buy?')

    expect(response.status).toBe(200)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(asked()).toEqual([
      ['sendChatAction', { chat_id: telegramId, action: 'typing' }],
      [
        'sendMessage',
        {
          chat_id: telegramId,
          text: 'The assistant has reached its limit for now. Try again in about 12 minutes.',
          link_preview_options: { is_disabled: true },
        },
      ],
    ])
    expect(logged.mock.calls).toEqual([['assistant failed:', 429]])
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
    expect(body.text).toContain(
      'You can also just ask a question in your own words, and it is answered by an AI service, which is sent your ' +
        'question and the card and purchase details needed to answer it.',
    )
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([undefined, ''])(
    'says that there is no assistant, at once and asking nobody, when the key of the service is %j',
    async (key) => {
      const telegramId = newTelegramId()
      const ctx = createExecutionContext()
      const waitUntil = vi.spyOn(ctx, 'waitUntil')

      const settings = { ...env, AI_API_KEY: key }

      const response = await worker.fetch(update(telegramId, 'How much have I spent?'), settings, ctx)

      expect(response.status).toBe(200)
      expect(waitUntil).not.toHaveBeenCalled()
      expect(asked()).toEqual([
        [
          'sendMessage',
          {
            chat_id: telegramId,
            text:
              'The assistant, which answers questions asked in your own words, is not available on this service. ' +
              'Send /start for the list of commands.',
            link_preview_options: { is_disabled: true },
          },
        ],
      ])
      expect(provider).not.toHaveBeenCalled()
      expect(await userCount(telegramId)).toBe(0)
    },
  )
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
