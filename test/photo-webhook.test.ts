import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as photo from '../src/ai/photo'
import type { PhotoReading, ReadPurchase } from '../src/ai/photo'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_VISION_MODEL } from '../src/ai/provider'
import worker from '../src/index'
import { findUser } from '../src/store'
import * as api from '../src/telegram/api'
import { BY_HAND_NOTE } from '../src/telegram/purchases'
import { READING } from '../src/telegram/texts'
import { newTelegramId, withoutCarried } from './helpers'
import { catchConsole } from './log-helpers'

// A photo through the Worker: from the update that Telegram posts to what the Worker posts back to Telegram. The
// reading of the photo and the fetching of its file are stood in for, as in test/photo.test.ts, which has all that
// the bot does with a reading. Everything else is the Worker's own: its settings, its messenger, and what it leaves
// for after its response. The Worker goes by the real clock, so a day or a month here is whatever it is today.
// And on the last two days of a month a purchase that is made today is counted in the next month, which the bot
// says of it in a line of its own: that line is taken out of what the tests look at, so that they say the same on
// every day. See `withoutCarried`.

const SECRET = env.TELEGRAM_WEBHOOK_SECRET
const API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/`

/** How long something took, which is whatever it took: the Worker goes by the real clock. */
const took = expect.any(Number)

/** A day as the bot shows one, whichever it is: "5 Oct". */
const someDay = expect.stringMatching(/^\d+ \w+$/)

/** What the stand-in for Telegram gives for the file of a photo: made-up bytes, which begin as those of a JPEG do. */
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x4d, 0x41, 0x44, 0x45])

/** A photo as Telegram posts one: the picture in each of the sizes that it is kept in, from the smallest up. */
const PHOTO = [
  { file_id: 'made-up-file-id-small', file_unique_id: 'made-up-id-1', width: 90, height: 75, file_size: 1_900 },
  { file_id: 'made-up-file-id-large', file_unique_id: 'made-up-id-2', width: 720, height: 600, file_size: 96_000 },
]

// The Worker posts to Telegram with the global fetch. It is replaced here, so these tests see what would be sent
// to Telegram without sending anything. Nothing else is to be fetched: the reading of a photo is stood in for.
const telegramApi = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()

/** The stand-in for the reading of a photo. With nothing said, a test is to have no photo read. */
let reader: MockInstance<typeof photo.readPhoto>

/** The stand-in for the fetching of a file from Telegram, which gives BYTES unless a test has it do otherwise. */
const file = vi.fn<api.Messenger['file']>()

/** How many messages the stand-in for Telegram has sent in a test. The number of a message is its id. */
let messagesSent = 0

/** Telegram's answer to a request that it takes: to one that sends a message, the message with the id it gave it. */
function taken(url: string): Response {
  const sends = url.endsWith('/sendMessage') || url.endsWith('/sendRichMessage')
  return Response.json({ ok: true, result: sends ? { message_id: ++messagesSent, date: 1 } : true })
}

beforeEach(() => {
  messagesSent = 0
  telegramApi.mockReset()
  telegramApi.mockImplementation(async (url) => taken(url))
  vi.stubGlobal('fetch', telegramApi)
  const unexpected = new Error('A test had a photo read that it should not have')
  reader = vi.spyOn(photo, 'readPhoto').mockRejectedValue(unexpected)
  file.mockReset()
  file.mockResolvedValue(BYTES)
  // The Worker makes its messenger from its settings, for every request. The one that it makes here posts to
  // Telegram as the Worker's does, but for the fetching of a file.
  const messenger = api.telegramMessenger
  vi.spyOn(api, 'telegramMessenger').mockImplementation((token) => ({ ...messenger(token), file }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A request as the Worker's own handler takes one, with which a test brings an execution context of its own. */
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>

/** The id of the last message that a test's user sent. */
let lastMessage = 7_100_000_000

/** The request that Telegram posts the Worker for an update that holds the message, or the press. */
function update(content: object): Request<unknown, IncomingRequestCfProperties> {
  return new IncomingRequest('https://spend-tracker.test/telegram', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    body: JSON.stringify({ update_id: 1, ...content }),
  })
}

/**
 * Posts the Worker an update, and waits for what it leaves to be done once Telegram has been answered. The Worker is
 * called with the settings of the service. Returns whether it left anything.
 */
async function post(content: object): Promise<{ response: Response; deferred: boolean }> {
  const ctx = createExecutionContext()
  const waitUntil = vi.spyOn(ctx, 'waitUntil')
  const response = await worker.fetch(update(content), env, ctx)
  await waitOnExecutionContext(ctx)
  return { response, deferred: waitUntil.mock.calls.length > 0 }
}

/** A message of a user's in their private chat with the bot, with an id that no message before it had. */
function message(telegramId: number, content: object) {
  const [chat, from] = [{ id: telegramId, type: 'private' }, { id: telegramId, is_bot: false, first_name: 'Jane' }]
  return { message: { message_id: ++lastMessage, date: 1, chat, from, ...content } }
}

/** A new user with the cards, each for the calendar month: `evol` is linked to the UOB EVOL Card. */
async function userWith(...cards: ('visa' | 'evol')[]): Promise<number> {
  const telegramId = newTelegramId()
  const commands = { visa: '/addcard visa 1234 calendar', evol: '/addcard evol 5678 calendar uob-evol' }
  for (const card of cards) await post(message(telegramId, { text: commands[card] }))
  telegramApi.mockClear()
  return telegramId
}

/** What the Worker has asked of Telegram since the calls were last cleared: each method, and what it was sent. */
function asked(): [method: string, body: Record<string, unknown>][] {
  return telegramApi.mock.calls.map(([url, init]) => {
    expect(url.startsWith(API)).toBe(true)
    return [url.slice(API.length), withoutCarried(JSON.parse(init.body as string))]
  })
}

/** A purchase as a reading gives one: one that the model was sure of, made today. */
function bought(amountMinor: number, merchant: string, given: Partial<ReadPurchase> = {}): ReadPurchase {
  const occurredAt = Math.floor(Date.now() / 1000)
  return { occurredAt, amountMinor, currency: 'SGD', merchant, unsure: false, ...given }
}

/** What a reading comes to when it found the purchases: with no card and no category named, unless said otherwise. */
function read(purchases: ReadPurchase[], named: { card?: string; category?: string } = {}): PhotoReading {
  const { card = null, category = null } = named
  return { status: 'read', card, unknownCard: false, category, purchases, unreadable: 0, more: false }
}

// The requests that the Worker is to post to Telegram, each of them whole.

function said(chatId: number, text: string) {
  return ['sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }]
}

function typing(chatId: number) {
  return ['sendChatAction', { chat_id: chatId, action: 'typing' }]
}

describe('POST /telegram with a photo', () => {
  it('answers 200 at once, and has the photo fetched, read and answered in what it leaves for after that', async () => {
    const telegramId = await userWith('visa', 'evol')
    const user = (await findUser(env.DB, telegramId))?.id
    // The reading comes when the test lets it.
    let come = (_: PhotoReading) => {}
    reader.mockImplementation((_deps, _provider, _input, counted) => {
      counted.requests++
      return new Promise<PhotoReading>((resolve) => (come = resolve))
    })
    const ctx = createExecutionContext()
    const waitUntil = vi.spyOn(ctx, 'waitUntil')
    const caption = 'add these to evol as bus/mrt physical card'
    const logged = catchConsole()

    const response = await worker.fetch(update(message(telegramId, { photo: PHOTO, caption })), env, ctx)

    // Telegram is answered while the photo has still to be read: the reading is left to the context.
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok\n')
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    // Until it is read, the chat has the placeholder, and is shown that the bot is writing.
    expect(asked()).toEqual([said(telegramId, READING), typing(telegramId)])
    // The file of the largest size was asked for, and no more of it than 400 KB.
    expect(file.mock.calls).toEqual([['made-up-file-id-large', 400_000]])
    // The reading has the provider that the service is set up with, which has a model for photos, and what the
    // model is to go by: the bytes, what they are, the caption, the cards, and the user's time zone.
    const [, provider, input] = reader.mock.calls[0]
    expect(provider).toEqual({
      apiKey: 'test-ai-key',
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      visionModel: DEFAULT_VISION_MODEL,
    })
    expect(input).toEqual({
      image: BYTES,
      mime: 'image/jpeg',
      caption,
      cards: [
        { nickname: 'visa', categories: [], note: undefined },
        {
          nickname: 'evol',
          categories: [
            { key: 'online', label: 'Online / Mobile Contactless Spend' },
            { key: 'other', label: 'Other Spend' },
          ],
          note: 'Other Spend is where a purchase made with the physical card goes.',
        },
      ],
      timeZone: 'Asia/Singapore',
    })

    const hostile = '/start https://attacker.test'
    come(read([bought(210, 'BUS/MRT 4471'), bought(1240, hostile)], { card: 'evol', category: 'other' }))
    await waitOnExecutionContext(ctx)

    // The table is a rich message of its own, in which Telegram is to detect nothing. The placeholder, which is the
    // third message that Telegram sent here, after the replies to the two commands, is deleted once it is there.
    const id = expect.stringMatching(/^\d+\*$/)
    expect(asked().slice(2)).toEqual([
      [
        'sendRichMessage',
        {
          chat_id: telegramId,
          rich_message: {
            skip_entity_detection: true,
            blocks: [
              { type: 'paragraph', text: { type: 'bold', text: 'Added to evol ••••5678 as Other Spend:' } },
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
                    { text: id, align: 'right' },
                    { text: someDay },
                    { text: '2.10', align: 'right' },
                    { text: 'BUS/MRT 4471' },
                  ],
                  [
                    { text: id, align: 'right' },
                    { text: someDay },
                    { text: '12.40', align: 'right' },
                    // The merchant's name as it was read, and as a string, which is plain text.
                    { text: hostile },
                  ],
                  [{ text: 'Total', colspan: 2 }, { text: '14.50', align: 'right' }, { text: '' }],
                ],
              },
              { type: 'paragraph', text: BY_HAND_NOTE },
              {
                type: 'paragraph',
                text: expect.stringMatching(/^evol ••••5678: SGD 14\.50 in 2 purchases, resets 1 \w+$/),
              },
            ],
          },
        },
      ],
      ['deleteMessage', { chat_id: telegramId, message_id: 3 }],
    ])
    // The log has the update as one that was left for later, and then the photo: whose it was, and what came of it.
    const counts = { bytes: 8, requests: 1, read: 2, unreadable: 0, stored: 2, held: 0 }
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'photo', outcome: 'deferred', ms: took },
      { event: 'photo', user, outcome: 'read', sent: 'rich', placeholder: true, ...counts, ms: took },
    ])
    // As it is written, the line of the photo is this.
    expect(logged.text().split('\n').at(-1)).toMatch(
      new RegExp(
        '^\\{"event":"photo","user":\\d+,"outcome":"read","sent":"rich","placeholder":true,"bytes":8,"requests":1,' +
          '"read":2,"unreadable":0,"stored":2,"held":0,"ms":\\d+\\}$',
      ),
    )
    expect(logged.failures()).toEqual([])
    // Nothing of the photo is in a line: not its caption, its file, a merchant, an amount or the chat.
    const never = ['bus/mrt', 'add these', 'made-up', 'BUS', 'attacker', '12.40', '1240', 'Jane', 'test-ai-key']
    for (const text of [...never, String(telegramId)]) expect(logged.text()).not.toContain(text)
  })
})

describe('GET /privacy', () => {
  const page = async (settings: Env) => {
    const request = new IncomingRequest('https://spend-tracker.test/privacy')
    return (await worker.fetch(request, settings, createExecutionContext())).text()
  }

  it('says what becomes of a photo on a service that reads photos, and on no other', async () => {
    const ownProvider = { ...env, AI_BASE_URL: 'https://ai.example.test/v1' }

    const [reads, questionsOnly, neither] = [
      await page(env),
      await page(ownProvider),
      await page({ ...env, AI_API_KEY: '' }),
    ]

    expect(reads).toContain('<h2>Photos that you send the bot</h2>')
    expect(reads).toContain('<h2>Questions that you ask the bot</h2>')
    // A service that answers questions and reads no photos says the one and not the other.
    expect(questionsOnly).toContain('<h2>Questions that you ask the bot</h2>')
    expect(questionsOnly).not.toMatch(/photo/i)
    expect(neither).not.toMatch(/photo|Questions that you ask/i)
  })
})
