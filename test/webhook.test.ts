import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newTelegramId, userCount } from './helpers'

const SECRET = env.TELEGRAM_WEBHOOK_SECRET

// The Worker sends its replies with the global fetch. It is replaced here, so
// these tests see what would be sent to Telegram without sending anything.
const telegramApi = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()

beforeEach(() => {
  telegramApi.mockReset()
  telegramApi.mockImplementation(async () => Response.json({ ok: true }))
  vi.stubGlobal('fetch', telegramApi)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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
  const message = { text: '/start', chat: { id: telegramId, type: 'private' }, from: { id: telegramId } }
  return JSON.stringify({ update_id: 1, message })
}

/** Posts the Worker a message that a user sent in their private chat with the bot, as Telegram does. */
function say(telegramId: number, text: string) {
  const message = { message_id: 1, date: 1, text, chat: { id: telegramId, type: 'private' }, from: { id: telegramId } }
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
   * A user with a card that is linked to a product, and the bot's message about a purchase on it that is still to
   * be sorted. With the message comes the id of the purchase, which the message begins with.
   */
  async function unsortedPurchase() {
    const telegramId = newTelegramId()
    await say(telegramId, '/addcard evol 1234 calendar uob-evol')
    const message = await replyTo(telegramId, `/add evol 12.50 ${MERCHANT}`)
    const [, id] = /^#(\d+) /.exec(message.text) ?? []
    return { telegramId, message, id }
  }

  it('sends a message with its buttons as an inline keyboard, and what each holds for the bot', async () => {
    const { telegramId, message, id } = await unsortedPurchase()

    const [purchased, total, sorted] = message.text.split('\n')
    expect(purchased).toMatch(new RegExp(`^#${id} \\d+ \\w+ · SGD 12\\.50 · ${MERCHANT} · by hand$`))
    expect(total).toMatch(/^evol ••••1234: SGD 12\.50 in 1 purchase, resets 1 \w+$/)
    expect(sorted).toBe(`#${id}: not sorted. Which was it?`)
    expect(message).toEqual({
      chat_id: telegramId,
      text: message.text,
      // The merchant's name is marked as code, so that nothing in it can be tapped.
      entities: [{ type: 'code', offset: message.text.indexOf(MERCHANT), length: MERCHANT.length }],
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Online', callback_data: `${id}:online` }],
          [{ text: 'Phone tap', callback_data: `${id}:mobile` }],
          [{ text: 'Physical card or other', callback_data: `${id}:other` }],
          [{ text: "Doesn't count", callback_data: `${id}:excluded` }],
        ],
      },
    })
  })

  it('answers a press and edits the message it was made under, in one request each', async () => {
    const { telegramId, message, id } = await unsortedPurchase()
    const [purchased, total] = message.text.split('\n')

    const response = await press(telegramId, message, `${id}:mobile`)

    expect(response.status).toBe(200)
    expect(asked()).toEqual([
      ['answerCallbackQuery', { callback_query_id: 'press-1', text: `#${id}: Phone tap` }],
      [
        'editMessageText',
        {
          chat_id: telegramId,
          message_id: 77,
          text: `${purchased}\n${total}\n#${id}: Phone tap`,
          entities: message.entities,
          link_preview_options: { is_disabled: true },
          // A keyboard with no rows: the buttons are taken away.
          reply_markup: { inline_keyboard: [] },
        },
      ],
    ])
  })

  it('answers a press, edits the message and sends the next purchase to sort, which is three requests', async () => {
    const telegramId = newTelegramId()
    await say(telegramId, '/addcard evol 1234 calendar uob-evol')
    await say(telegramId, '/add evol 12.50 Lunch')
    await say(telegramId, '/add evol 3.00 Tea')
    const prompt = await replyTo(telegramId, '/sort evol')
    const data = prompt.reply_markup?.inline_keyboard[0][0].callback_data
    expect(data).toMatch(/^\d+:online:next$/)

    await press(telegramId, prompt, data)

    expect(asked().map(([method]) => method)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage'])
    const [, , [, next]] = asked()
    expect(next.text).toMatch(/^#\d+ \d+ \w+ · SGD 3\.00 · Tea · by hand\n#\d+: not sorted\. Which was it\?$/)
    expect(next.reply_markup).toMatchObject({ inline_keyboard: [[{ text: 'Online' }], [{}], [{}], [{}]] })
  })

  it.each([
    ['what no button holds', 'DROP TABLE transactions'],
    ['a purchase that there is not', '999999999:online'],
    ['something that is not text', { purchase: 1 }],
    ['nothing', undefined],
  ])('answers a press that brings %s, and does nothing else', async (_, data) => {
    const { telegramId, message } = await unsortedPurchase()

    const response = await press(telegramId, message, data)

    expect(response.status).toBe(200)
    expect(asked()).toEqual([
      ['answerCallbackQuery', { callback_query_id: 'press-1', text: 'That button no longer works.' }],
    ])
  })

  it('still answers 200 when Telegram will not take the answer to a press, and logs nothing of the press', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { telegramId, message, id } = await unsortedPurchase()
    telegramApi.mockImplementation(async () => Response.json({ ok: false, error_code: 400 }, { status: 400 }))

    const response = await press(telegramId, message, `${id}:online`)

    expect(response.status).toBe(200)
    expect(logged.mock.calls).toEqual([['telegram update failed:', 'Error']])
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
