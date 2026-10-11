import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as photo from '../src/ai/photo'
import type { PhotoReading, ReadPurchase } from '../src/ai/photo'
import worker from '../src/index'
import { findUser } from '../src/store'
import * as api from '../src/telegram/api'
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

const READING =
  'Reading your photo… If this message is still here in half a minute, something went wrong. Check /spend before ' +
  'you send the photo again.'
const STORED_NO_REPLY =
  "The purchases in your photo were read, but the bot could not finish its reply. Check /spend and the bot's " +
  'other messages before you send the photo again.'
const NOT_TEXT =
  'The bot only reads text messages. It cannot read an attachment, such as a photo, a file or a voice message, or ' +
  'the caption under one. Please send your question or command as text.'

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

/**
 * The id of the last message that a test's user sent. The ids go up from a number that nothing else in a line of
 * the log could be: a test says that no line holds the id of a message, and the Worker goes by the real clock, so a
 * count or a duration could be any small number, and was one of these ids once in six runs.
 */
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
 * called with the settings of the service, or with others that a test gives it. Returns whether it left anything.
 */
async function post(content: object, settings: Env = env): Promise<{ response: Response; deferred: boolean }> {
  const ctx = createExecutionContext()
  const waitUntil = vi.spyOn(ctx, 'waitUntil')
  const response = await worker.fetch(update(content), settings, ctx)
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

/** What is said in the place of a placeholder: the message with its id is edited to say it, and has no buttons. */
function inPlaceOf(chatId: number, messageId: number, text: string) {
  const [preview, markup] = [{ is_disabled: true }, { inline_keyboard: [] }]
  const edit = { chat_id: chatId, message_id: messageId, text, link_preview_options: preview, reply_markup: markup }
  return ['editMessageText', edit]
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
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
      visionModel: 'qwen/qwen3.8-27b',
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
              { type: 'paragraph', text: '* = added by hand' },
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

  it('sends the purchases that it asks about with their buttons as an inline keyboard, and answers the press of one', async () => {
    const telegramId = await userWith('visa', 'evol')
    const user = (await findUser(env.DB, telegramId))?.id
    reader.mockResolvedValue(read([bought(300, 'TEA HOUSE', { unsure: true })]))
    const sent = message(telegramId, { photo: PHOTO })
    const photoId = sent.message.message_id

    const { response, deferred } = await post(sent)

    expect([response.status, deferred]).toEqual([200, true])
    // The placeholder, the showing that the bot is writing, the message that asks, and the placeholder deleted.
    const [, , [method, asking], removed, ...more] = asked()
    expect(more).toEqual([])
    expect(removed).toEqual(['deleteMessage', { chat_id: telegramId, message_id: 3 }])
    expect(method).toBe('sendMessage')
    const text = String(asking.text)
    expect(text.split('\n')).toEqual([
      'Which card was this purchase made with? The bot could not tell.',
      expect.stringMatching(/^\d+ \w+ · SGD 3\.00 · TEA HOUSE · not sure$/),
      'Check the amount and the date of each one that is marked "not sure".',
    ])
    expect(asking).toEqual({
      chat_id: telegramId,
      text,
      // The merchant's name is marked as code, so that nothing in it can be tapped.
      entities: [{ type: 'code', offset: text.indexOf('TEA HOUSE'), length: 'TEA HOUSE'.length }],
      link_preview_options: { is_disabled: true },
      // A row to each button, and what each holds for the bot: the id of the photo's message, and the choice.
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Add to visa', callback_data: `held:${photoId}:1234` }],
          [{ text: 'Add to evol', callback_data: `held:${photoId}:5678` }],
          [{ text: 'Skip', callback_data: `held:${photoId}:skip` }],
        ],
      },
    })

    // The press of a button, as Telegram posts it: with what the button holds, and with the message as it stands.
    telegramApi.mockClear()
    const under = { message_id: 4, date: 1, chat: { id: telegramId, type: 'private' }, text, entities: asking.entities }
    const press = { id: 'press-1', from: { id: telegramId }, chat_instance: 'made-up', data: `held:${photoId}:5678` }
    const logged = catchConsole()

    const pressed = await post({ callback_query: { ...press, message: under } })

    // A press is answered before the response, and leaves nothing for after it.
    expect([pressed.response.status, pressed.deferred]).toEqual([200, false])
    const [answer, [edit, edited], ...rest] = asked()
    expect(rest).toEqual([])
    expect(answer).toEqual(['answerCallbackQuery', { callback_query_id: 'press-1', text: 'Added 1 purchase.' }])
    expect(edit).toBe('editMessageText')
    const added = String(edited.text)
    expect(added.split('\n')).toEqual([
      'Added to evol ••••5678 as Online / Mobile Contactless Spend:',
      expect.stringMatching(/^ID \d+ · \d+ \w+ · SGD 3\.00 · TEA HOUSE · by hand$/),
    ])
    expect(edited).toEqual({
      chat_id: telegramId,
      message_id: 4,
      text: added,
      entities: [{ type: 'code', offset: added.indexOf('TEA HOUSE'), length: 'TEA HOUSE'.length }],
      link_preview_options: { is_disabled: true },
      // A keyboard with no rows takes the buttons away.
      reply_markup: { inline_keyboard: [] },
    })
    expect(logged.events()).toEqual([
      { event: 'held_press', user, outcome: 'added', held: 1, stored: 1 },
      { event: 'update', kind: 'press', outcome: 'replied', ms: took },
    ])
    for (const text of ['press-1', 'held:', 'TEA', '5678', String(photoId), String(telegramId)]) {
      expect(logged.text()).not.toContain(text)
    }

    // The second press of the same button finds nothing to add.
    telegramApi.mockClear()
    await post({ callback_query: { ...press, message: under } })
    expect(asked()).toEqual([
      ['answerCallbackQuery', { callback_query_id: 'press-1', text: 'That button no longer works.' }],
    ])
  })

  it('sends the table as text when Telegram answers the rich message with an error, and logs only the status', async () => {
    const telegramId = await userWith('evol')
    reader.mockResolvedValue(read([bought(1240, 'COFFEE PLACE')]))
    // An answer can quote what it was sent.
    const refusal = { ok: false, error_code: 400, description: "Bad Request: can't parse COFFEE PLACE" }
    telegramApi.mockImplementation(async (url) =>
      url.endsWith('/sendRichMessage') ? Response.json(refusal, { status: 400 }) : taken(url),
    )
    const logged = catchConsole()

    await post(message(telegramId, { photo: PHOTO }))

    const [, , [rich], [method, body], removed, ...more] = asked()
    expect([rich, method, more]).toEqual(['sendRichMessage', 'sendMessage', []])
    expect(removed).toEqual(['deleteMessage', { chat_id: telegramId, message_id: 2 }])
    expect(String(body.text).split('\n')).toEqual([
      'Added to evol ••••5678 as Online / Mobile Contactless Spend:',
      expect.stringMatching(/^ID +Date +SGD  Merchant$/),
      expect.stringMatching(/^ *\d+\* +\d+ \w+  12\.40  COFFEE PLACE$/),
      expect.stringMatching(/^ +Total +12\.40$/),
      '',
      '* = added by hand',
      '',
      expect.stringMatching(/^evol ••••5678: SGD 12\.40 in 1 purchase, resets 1 \w+$/),
    ])
    // The table is a block of letters of one width, and nothing else is marked.
    expect((body.entities as { type: string }[]).map((entity) => entity.type)).toEqual(['pre'])
    expect(logged.events().slice(1)).toEqual([
      { event: 'telegram_failed', method: 'sendRichMessage', status: 400, error: 'Error', reason: 'http_error' },
      expect.objectContaining({ event: 'photo', outcome: 'read', sent: 'text', stored: 1 }),
    ])
    for (const text of ['COFFEE', 'parse', '12.40']) expect(logged.text()).not.toContain(text)
  })

  it('says that the purchases were stored when Telegram then takes nothing of the reply, and does not say to send the photo again', async () => {
    const telegramId = await userWith('evol')
    reader.mockResolvedValue(read([bought(1240, 'COFFEE PLACE')]))
    // Telegram takes the placeholder, which is the first message that it is asked to send here, and shows the bot to
    // be writing. Then it refuses the table both ways: as a rich message, and as a message of text.
    let messages = 0
    telegramApi.mockImplementation(async (url) => {
      const refused = url.endsWith('/sendRichMessage') || (url.endsWith('/sendMessage') && ++messages > 1)
      return refused ? new Response('Bad Gateway', { status: 502 }) : taken(url)
    })
    const logged = catchConsole()

    const { response } = await post(message(telegramId, { photo: PHOTO }))

    expect(response.status).toBe(200)
    expect(asked().map(([method]) => method)).toEqual([
      'sendMessage',
      'sendChatAction',
      'sendRichMessage',
      'sendMessage',
      'editMessageText',
    ])
    // It is said in the place of the placeholder, which is the second message that Telegram sent here, after the
    // reply to the command that added the card.
    expect(asked().at(-1)).toEqual(inPlaceOf(telegramId, 2, STORED_NO_REPLY))
    const failure = { error: 'Error', reason: 'http_error', status: 502 }
    expect(logged.events('photo')).toEqual([
      expect.objectContaining({ outcome: 'failed', sent: 'edit', read: 1, stored: 1, ...failure }),
    ])
  })

  it('sends nothing more to a chat that Telegram will send nothing to, and has no photo fetched or read for it', async () => {
    const telegramId = await userWith('evol')
    const refusal = { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }
    telegramApi.mockImplementation(async () => Response.json(refusal, { status: 403 }))
    const logged = catchConsole()

    const { response } = await post(message(telegramId, { photo: PHOTO, caption: 'evol' }))

    expect(response.status).toBe(200)
    expect(asked()).toEqual([said(telegramId, READING)])
    expect([file, reader].map((spy) => spy.mock.calls.length)).toEqual([0, 0])
    const blocked = { error: 'ChatBlockedError', reason: 'chat_blocked' }
    const nothingSaid = { user: null, outcome: 'blocked', sent: 'none', placeholder: false }
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'photo', outcome: 'deferred', ms: took },
      { event: 'telegram_failed', method: 'sendMessage', status: 403, ...blocked },
      expect.objectContaining({ event: 'photo', ...nothingSaid, ...blocked }),
    ])
  })

  it('says what came of a photo that nothing was added from in the place of the placeholder', async () => {
    const telegramId = await userWith('evol')
    reader.mockResolvedValue({ status: 'nothing' })

    await post(message(telegramId, { photo: PHOTO, caption: 'my cat' }))

    expect(asked()).toEqual([
      said(telegramId, READING),
      typing(telegramId),
      inPlaceOf(telegramId, 2, 'No purchases to add were found in that photo.'),
    ])
  })

  it('ignores a photo in a group, as it does a message of text there', async () => {
    const telegramId = await userWith('evol')
    const [chat, from] = [{ id: -5001, type: 'group', title: 'A made-up chat' }, { id: telegramId }]
    const logged = catchConsole()

    const { deferred } = await post({ message: { message_id: ++lastMessage, date: 1, chat, from, photo: PHOTO } })

    expect(deferred).toBe(false)
    expect(telegramApi).not.toHaveBeenCalled()
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'message', outcome: 'ignored', why: 'not_private', ms: took },
    ])
  })
})

describe('POST /telegram with a photo, on a service that reads none', () => {
  /** The settings of a service that names a provider of its own, and no model of that provider's that reads photos. */
  const ownProvider = { ...env, AI_BASE_URL: 'https://ai.example.test/v1', AI_MODEL: 'made-up-model' }

  it.each<[what: string, settings: Env]>([
    ['that names its own provider, and no model for photos', ownProvider],
    ['that names its own provider, and leaves the model for photos empty', { ...ownProvider, AI_VISION_MODEL: '' }],
    ['that has no AI provider', { ...env, AI_API_KEY: '' }],
    [
      'that has no AI provider, though a model for photos is named',
      { ...env, AI_API_KEY: undefined, AI_VISION_MODEL: 'made-up-vision-model' },
    ],
  ])('answers a photo at once with that the bot only reads text, on a service %s', async (_, settings) => {
    const telegramId = await userWith('evol')
    const logged = catchConsole()

    const sent = message(telegramId, { photo: PHOTO, caption: 'add these to evol' })
    const { response, deferred } = await post(sent, settings)

    // Nothing is left for after the response: no placeholder, no file and no reading.
    expect([response.status, deferred]).toEqual([200, false])
    expect(asked()).toEqual([said(telegramId, NOT_TEXT)])
    expect([file, reader].map((spy) => spy.mock.calls.length)).toEqual([0, 0])
    expect(logged.events()).toEqual([{ event: 'update', kind: 'not_text', outcome: 'replied', ms: took }])
  })

  it('says nothing of photos in its welcome, where a service that reads them does', async () => {
    const [here, there] = [newTelegramId(), newTelegramId()]

    await post(message(here, { text: '/start' }), ownProvider)
    await post(message(there, { text: '/start' }))

    const [[, without], [, withPhotos]] = asked()
    expect(without.text).toContain('You can also just ask a question in your own words')
    expect(without.text).not.toMatch(/photo/i)
    expect(withPhotos.text).toContain('You can send a photo of your card transactions too')
  })

  it('reads photos with the model that is named for them at a provider of its own', async () => {
    const telegramId = await userWith('evol')
    reader.mockResolvedValue({ status: 'nothing' })
    const settings = { ...ownProvider, AI_VISION_MODEL: 'made-up-vision-model' }

    const { deferred } = await post(message(telegramId, { photo: PHOTO }), settings)

    expect(deferred).toBe(true)
    expect(reader.mock.calls[0][1]).toEqual({
      apiKey: 'test-ai-key',
      baseUrl: 'https://ai.example.test/v1',
      model: 'made-up-model',
      visionModel: 'made-up-vision-model',
    })
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
