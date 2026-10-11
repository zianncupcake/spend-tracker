import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import type { PhotoReading } from '../src/ai/photo'
import { ProviderError } from '../src/ai/provider'
import { Failure } from '../src/log'
import { findUser } from '../src/store'
import { ChatBlockedError, TelegramError } from '../src/telegram/api'
import { handleUpdate } from '../src/telegram/handler'
import { clock, deps, openChat, PHOTO, posted, sent, sentRich } from './connect-helpers'
import { seconds } from './helpers'
import { catchConsole } from './log-helpers'
import {
  bought,
  BYTES,
  chatWithCard,
  chatWithCards,
  file,
  heldFor,
  leftSince,
  MESSAGE,
  NO_PURCHASES,
  NOT_READ,
  noticeFor,
  photoLine,
  read,
  reader,
  reading,
  READING,
  rowsOf,
  STORED_NO_REPLY,
  TOO_LARGE,
  TOOK_TOO_LONG,
  unsure,
  type Chat,
} from './photo-helpers'

// What comes of a photo besides the adding of its purchases: what its user is shown while it is read, what they are
// told when nothing is added from it or when something fails, what the log has of it, and what the bot does not
// read at all. test/photo.test.ts has what is added, test/photo-held.test.ts what the bot asks about first, and
// ./photo-helpers what the three share.

const NO_CARDS = [
  'You have no cards yet. Add one with:',
  '/addcard <nickname> <last4> statement <day>',
  '/addcard <nickname> <last4> calendar',
].join('\n')

describe('a photo that nothing is added from', () => {
  /** The line that the log has of a photo that was read with one request and that nothing came of, in no time. */
  function nothingLine(user: number, outcome: string) {
    return { ...photoLine(user, { read: 0, stored: 0 }), outcome, sent: 'edit' }
  }

  it('is answered with that no purchases were found in it, when the reading found none', async () => {
    const chat = await chatWithCard()
    reading({ status: 'nothing' })
    const logged = catchConsole()

    expect(await noticeFor(chat, 'my cat')).toBe(NO_PURCHASES)

    // That is no failure of the service's, and is logged as none.
    expect(logged.events('photo')).toEqual([nothingLine(await chat.userId(), 'nothing')])
    expect(logged.failures()).toEqual([])
  })

  it('is answered so too when a reading holds no purchase and counts none that it could not read', async () => {
    const chat = await chatWithCard()
    reading(read([]))

    expect(await noticeFor(chat)).toBe(NO_PURCHASES)
  })

  it.each<[when: string, retryAfter: number | undefined]>([
    ['in about 12 minutes', 720],
    ['later', undefined],
  ])('is answered as a question is, with to try again %s, when the provider has had too many requests', async (when, retryAfter) => {
    const chat = await chatWithCard()
    reading({ status: 'busy', retryAfter, error: new ProviderError(429, retryAfter) })
    const logged = catchConsole()

    expect(await noticeFor(chat)).toBe(`The assistant has reached its limit for now. Try again ${when}.`)

    const failure = { error: 'Error', reason: 'http_error', status: 429 }
    expect(logged.events('photo')).toEqual([{ ...nothingLine(await chat.userId(), 'busy'), ...failure }])
    expect(logged.failures()).toEqual(logged.events('photo'))
  })

  it('is answered with that it took too long, when the reading ran out of time', async () => {
    const chat = await chatWithCard()
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    reading({ status: 'timeout', error })
    const logged = catchConsole()

    expect(await noticeFor(chat)).toBe(TOOK_TOO_LONG)

    expect(logged.events('photo')).toEqual([{ ...nothingLine(await chat.userId(), 'timeout'), error: 'TimeoutError' }])
  })

  it('is answered with that it could not be read, and what to do then, when the reading failed', async () => {
    const chat = await chatWithCard()
    reading({ status: 'failed', error: new Failure('bad_reading', 'A made-up reading that quotes: COFFEE PLACE') })
    const logged = catchConsole()

    expect(await noticeFor(chat)).toBe(NOT_READ)

    const failure = { error: 'Error', reason: 'bad_reading' }
    expect(logged.events('photo')).toEqual([{ ...nothingLine(await chat.userId(), 'failed'), ...failure }])
    expect(logged.text()).not.toContain('COFFEE')
    expect(await rowsOf(await chat.userId())).toEqual([])
  })

  it('is answered so too when the reading throws what it was to catch', async () => {
    const chat = await chatWithCard()
    reader.mockRejectedValue(new TypeError('A made-up failure of the network'))
    const logged = catchConsole()

    expect(await noticeFor(chat)).toBe(NOT_READ)

    const line = { ...nothingLine(await chat.userId(), 'failed'), requests: 0 }
    expect(logged.events('photo')).toEqual([{ ...line, error: 'TypeError' }])
  })

  it('is answered with that it is too large, and to crop it, when its file has more bytes than are fetched', async () => {
    const chat = await chatWithCard()
    file.mockRejectedValue(new Failure('file_too_large', 'A made-up file of too many bytes'))
    const logged = catchConsole()

    expect(await noticeFor(chat)).toBe(TOO_LARGE)

    // The model is asked nothing. A photo that is too large is no failure of the service's.
    expect(reader).not.toHaveBeenCalled()
    const line = { ...nothingLine(await chat.userId(), 'too_large'), bytes: 0, requests: 0 }
    expect(logged.events('photo')).toEqual([line])
    expect(logged.failures()).toEqual([])
  })

  it('is answered with that it could not be read when Telegram does not give its file', async () => {
    const chat = await chatWithCard()
    file.mockRejectedValue(new TelegramError('getFile', 502))
    const logged = catchConsole()

    expect(await noticeFor(chat)).toBe(NOT_READ)

    expect(reader).not.toHaveBeenCalled()
    const line = { ...nothingLine(await chat.userId(), 'failed'), bytes: 0, requests: 0 }
    expect(logged.events('photo')).toEqual([{ ...line, error: 'Error', reason: 'http_error', status: 502 }])
  })

  it('is answered with how to add a card, for a user who has none: nothing is fetched, and nothing is read', async () => {
    const chat = openChat()
    const logged = catchConsole()

    expect(await noticeFor(chat, 'add these to evol')).toBe(NO_CARDS)

    expect(file).not.toHaveBeenCalled()
    expect(reader).not.toHaveBeenCalled()
    // A photo needs a user, as a command does.
    const user = (await findUser(env.DB, chat.telegramId))?.id ?? 0
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'photo', outcome: 'deferred', ms: 0 },
      { ...nothingLine(user, 'no_cards'), bytes: 0, requests: 0 },
    ])
  })

  it('is answered with that it could not be read when the user’s row cannot be read, and logged with no user', async () => {
    const chat = await chatWithCard()
    const prepare = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('users')) throw new Error('a made-up failure that quotes a caption: add these to evol')
      return prepare(query)
    })
    const logged = catchConsole()

    expect(await noticeFor(chat, 'add these to evol')).toBe(NOT_READ)

    expect(logged.events('photo')).toEqual([
      { ...nothingLine(0, 'failed'), user: null, bytes: 0, requests: 0, error: 'Error' },
    ])
    expect(logged.text()).not.toContain('add these')
  })
})

describe('the size of a photo that is fetched', () => {
  const size = (name: string, width: number, bytes?: number) => ({
    file_id: `made-up-file-id-${name}`,
    file_unique_id: `made-up-id-${name}`,
    width,
    height: Math.round(width * 0.75),
    file_size: bytes,
  })

  it.each<[what: string, sizes: unknown[], fetched: string]>([
    [
      'the largest that has no more than 400 KB, with a larger one left',
      [size('thumb', 90, 1_500), size('small', 320, 20_000), size('large', 1280, 180_000), size('huge', 2560, 620_000)],
      'large',
    ],
    ['one of exactly 400 KB', [size('small', 320, 20_000), size('large', 1280, 400_000)], 'large'],
    ['not one of a byte more', [size('small', 320, 20_000), size('large', 1280, 400_001)], 'small'],
    [
      'the largest by its width and height, in whatever order they come',
      [size('large', 1280, 180_000), size('thumb', 90, 1_500), size('small', 320, 20_000)],
      'large',
    ],
    [
      'one whose bytes Telegram does not give, which is fetched to find out',
      [size('small', 320, 20_000), size('large', 1280)],
      'large',
    ],
    [
      'only what has an id to be asked for by',
      [size('small', 320, 20_000), { width: 1280, height: 960, file_size: 180_000 }, 'made-up', null],
      'small',
    ],
  ])('is %s', async (_, sizes, fetched) => {
    const chat = await chatWithCard()
    reading({ status: 'nothing' })

    await chat.sendPhoto(undefined, undefined, sizes)

    expect(file.mock.calls).toEqual([[`made-up-file-id-${fetched}`, 400_000]])
  })

  it('is none when every size has more than 400 KB: the photo is said to be too large, and no file is asked for', async () => {
    const chat = await chatWithCard()
    const [before, beforePosted] = [sent.length, posted.length]

    await chat.sendPhoto(undefined, undefined, [size('large', 1280, 480_000), size('huge', 2560, 900_000)])

    expect(file).not.toHaveBeenCalled()
    expect(reader).not.toHaveBeenCalled()
    expect(leftSince(beforePosted)).toEqual([TOO_LARGE])
    expect(sent).toHaveLength(before)
  })
})

describe('a photo, while it is read', () => {
  it('is left for after the update is taken: nothing is read, fetched or sent before', async () => {
    const chat = await chatWithCard()
    reading(read([bought(1240, 'COFFEE PLACE')]))
    const queried = vi.spyOn(env.DB, 'prepare')
    const typing = vi.spyOn(deps.messenger, 'typing')
    const [from, private_] = [{ id: chat.telegramId }, { id: chat.telegramId, type: 'private' }]
    const [mark, logged] = [posted.length, catchConsole()]

    const later = await handleUpdate(deps, { message: { message_id: MESSAGE, photo: PHOTO, chat: private_, from } })

    // Not the placeholder either, which is the first thing that is sent.
    expect(later).toBeTypeOf('function')
    expect(queried).not.toHaveBeenCalled()
    expect([file, reader, typing].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0])
    expect([sent, leftSince(mark), sentRich]).toEqual([[], [], []])
    expect(logged.events()).toEqual([{ event: 'update', kind: 'photo', outcome: 'deferred', ms: 0 }])

    await later?.()

    // The table is all that the chat is left with.
    expect(sentRich).toHaveLength(1)
    expect([sent, leftSince(mark)]).toEqual([[], []])
  })

  it('has its placeholder first, and the chat is shown that the bot is writing, before its file is fetched', async () => {
    const chat = await chatWithCard()
    const order: string[] = []
    vi.spyOn(deps.messenger, 'post').mockImplementation(async (chatId, text) => {
      order.push(`"${text}" to ${chatId}`)
      return 77
    })
    vi.spyOn(deps.messenger, 'typing').mockImplementation(async (chatId) => {
      order.push(`typing in ${chatId}`)
    })
    file.mockImplementation(async () => {
      order.push('file fetched')
      return BYTES
    })
    reader.mockImplementation(async () => {
      order.push('photo read')
      return read([bought(1240, 'COFFEE PLACE')])
    })
    vi.spyOn(deps.messenger, 'sendRich').mockImplementation(async (chatId) => {
      order.push(`table to ${chatId}`)
    })
    vi.spyOn(deps.messenger, 'delete').mockImplementation(async (chatId, messageId) => {
      order.push(`message ${messageId} deleted in ${chatId}`)
    })

    await chat.sendPhoto()

    // And the placeholder goes, by the id that it was sent with, once the reply is there.
    expect(order).toEqual([
      `"${READING}" to ${chat.telegramId}`,
      `typing in ${chat.telegramId}`,
      'file fetched',
      'photo read',
      `table to ${chat.telegramId}`,
      `message 77 deleted in ${chat.telegramId}`,
    ])
  })

  it('is shown to be read every four seconds until it is, and not after', async () => {
    vi.useFakeTimers()
    const chat = await chatWithCard()
    const typing = vi.spyOn(deps.messenger, 'typing')
    const [asked, came] = [Promise.withResolvers<void>(), Promise.withResolvers<PhotoReading>()]
    reader.mockImplementation(() => {
      asked.resolve()
      return came.promise
    })
    const done = chat.sendPhoto()
    await asked.promise

    expect(typing).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(typing).toHaveBeenCalledTimes(3)

    came.resolve(read([bought(1240, 'COFFEE PLACE')]))
    await done

    // Neither clock of the photo runs on: the one that shows the bot to be writing, or the one that ends the wait.
    expect(vi.getTimerCount()).toBe(0)
    expect(sentRich).toHaveLength(1)
  })

  it('is sent nothing more when Telegram will send its chat nothing: the model is not asked, and nothing is stored', async () => {
    const chat = await chatWithCard()
    vi.spyOn(deps.messenger, 'post').mockRejectedValue(new ChatBlockedError())
    const [mark, logged] = [posted.length, catchConsole()]

    await chat.sendPhoto()

    expect([file, reader].map((spy) => spy.mock.calls.length)).toEqual([0, 0])
    expect([sent, leftSince(mark), sentRich]).toEqual([[], [], []])
    expect(logged.events('photo')).toEqual([
      {
        event: 'photo',
        user: null,
        outcome: 'blocked',
        sent: 'none',
        placeholder: false,
        bytes: 0,
        requests: 0,
        read: 0,
        unreadable: 0,
        stored: 0,
        held: 0,
        ms: 0,
        error: 'ChatBlockedError',
        reason: 'chat_blocked',
      },
    ])
  })

  it('is read all the same when its placeholder could not be sent, and what comes of it is then said in a message', async () => {
    const chat = await chatWithCard()
    vi.spyOn(deps.messenger, 'post').mockRejectedValue(new TelegramError('sendMessage', 500))
    reading({ status: 'nothing' })
    const logged = catchConsole()

    await chat.sendPhoto()

    expect(sent).toEqual([{ chatId: chat.telegramId, text: NO_PURCHASES }])
    expect(logged.events('photo')).toMatchObject([{ outcome: 'nothing', sent: 'message', placeholder: false }])
  })
})

describe('a photo that takes too long', () => {
  /** A reading that comes when a test lets it. `asked` is done once the bot has asked for it. */
  function slowReading() {
    const [asked, came] = [Promise.withResolvers<void>(), Promise.withResolvers<PhotoReading>()]
    reader.mockImplementation((_deps, _provider, _input, taken) => {
      taken.requests++
      asked.resolve()
      return came.promise
    })
    return { asked: asked.promise, come: came.resolve }
  }

  it('is waited for 27 seconds, and its user is then told so in the place of the placeholder', async () => {
    vi.useFakeTimers()
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const slow = slowReading()
    const [mark, logged] = [posted.length, catchConsole()]
    const done = chat.sendPhoto()
    await slow.asked

    await vi.advanceTimersByTimeAsync(26_999)
    expect(leftSince(mark)).toEqual([READING])
    expect(logged.events('photo')).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await done

    // Nothing of the photo is stored, so it can be sent again.
    expect(leftSince(mark)).toEqual([TOOK_TOO_LONG])
    expect(vi.getTimerCount()).toBe(0)
    const line = { ...photoLine(userId, { read: 0, stored: 0 }), outcome: 'timeout', sent: 'edit' }
    expect(logged.events('photo')).toEqual([{ ...line, error: 'Error', reason: 'took_too_long' }])
  })

  it('has nothing stored from a reading that comes after that: its user may have sent the photo again by then', async () => {
    vi.useFakeTimers()
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const slow = slowReading()
    const mark = posted.length
    const done = chat.sendPhoto()
    await slow.asked
    await vi.advanceTimersByTimeAsync(27_000)
    await done
    const queried = vi.spyOn(env.DB, 'prepare')

    // The reading comes after all: of a purchase that is clear, and one to hold.
    slow.come(read([bought(1240, 'COFFEE PLACE'), unsure(300, 'TEA HOUSE')]))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(queried).not.toHaveBeenCalled()
    queried.mockRestore()
    expect(await rowsOf(userId)).toEqual([])
    expect(await heldFor(userId)).toEqual([])
    // And nothing more is said.
    expect(leftSince(mark)).toEqual([TOOK_TOO_LONG])
    expect(sentRich).toEqual([])
  })

  it('is not said to be one to try again when its purchases are stored by then: its user is told to check them', async () => {
    vi.useFakeTimers()
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE')]))
    // The purchase goes in, and the database never answers the statement after that, which adds up the card.
    const prepare = env.DB.prepare.bind(env.DB)
    const stalled = Promise.withResolvers<void>()
    const never = { bind: () => ({ all: () => new Promise(() => {}) }) }
    const stalling = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (!query.includes('SUM(amount_minor)')) return prepare(query)
      stalled.resolve()
      return never as unknown as D1PreparedStatement
    })
    const [mark, logged] = [posted.length, catchConsole()]
    const done = chat.sendPhoto()
    await stalled.promise

    await vi.advanceTimersByTimeAsync(27_000)
    await done
    stalling.mockRestore()

    // What is said does not say to try again, or to send the photo again without a look at what is stored.
    expect(leftSince(mark)).toEqual([STORED_NO_REPLY])
    expect(await rowsOf(userId)).toHaveLength(1)
    const line = { ...photoLine(userId, { read: 1, stored: 1 }), outcome: 'timeout', sent: 'edit' }
    expect(logged.events('photo')).toEqual([{ ...line, error: 'Error', reason: 'took_too_long' }])
  })
})

describe('a photo whose purchases are stored, when something fails after that', () => {
  /** The line that the log has of a photo that failed once a purchase of it was stored, with its user told so. */
  function storedLine(user: number) {
    return { ...photoLine(user, { read: 1, stored: 1 }), outcome: 'failed', sent: 'edit' }
  }

  it('is told that they were stored, and not to send it again, when what its card comes to cannot be read', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE')]))
    const prepare = env.DB.prepare.bind(env.DB)
    const queried = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('SUM(amount_minor)')) throw new Error('a made-up failure that quotes: COFFEE PLACE')
      return prepare(query)
    })
    const logged = catchConsole()

    const notice = await noticeFor(chat)
    queried.mockRestore()

    expect(notice).toBe(STORED_NO_REPLY)
    expect(notice).not.toMatch(/try again|clearer/i)
    expect(await rowsOf(userId)).toHaveLength(1)
    // The log has that the photo failed with a purchase stored, and nothing of the purchase.
    expect(logged.events('photo')).toEqual([{ ...storedLine(userId), error: 'Error' }])
    expect(logged.text()).not.toContain('COFFEE')
  })

  it.each<[what: string, error: Error, failure: object]>([
    [
      'Telegram cannot be reached for the table',
      new TypeError('A made-up failure of the network'),
      { error: 'TypeError' },
    ],
    [
      'Telegram does not answer the table, and is given up on',
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      { error: 'TimeoutError' },
    ],
  ])('is told the same when %s', async (_, error, failure) => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE')]))
    vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(error)
    const logged = catchConsole()

    expect(await noticeFor(chat)).toBe(STORED_NO_REPLY)

    expect(await rowsOf(userId)).toHaveLength(1)
    expect(logged.events('photo')).toEqual([{ ...storedLine(userId), ...failure }])
  })

  it('is told the same when Telegram takes the table neither way', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE')]))
    vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new TelegramError('sendRichMessage', 400))
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TelegramError('sendMessage', 400))
    const logged = catchConsole()

    expect(await noticeFor(chat)).toBe(STORED_NO_REPLY)

    const failure = { error: 'Error', reason: 'http_error', status: 400 }
    expect(logged.events('photo')).toEqual([{ ...storedLine(userId), ...failure }])
  })

  it('is told the same when the purchases that were to be held cannot be: those that are clear are stored by then', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE'), unsure(300, 'TEA HOUSE')]))
    const prepare = env.DB.prepare.bind(env.DB)
    const queried = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('INSERT INTO held_batches')) throw new Error('a made-up failure that quotes: TEA HOUSE')
      return prepare(query)
    })
    const logged = catchConsole()

    const notice = await noticeFor(chat)
    queried.mockRestore()

    expect(notice).toBe(STORED_NO_REPLY)
    expect(await rowsOf(userId)).toMatchObject([{ merchant: 'COFFEE PLACE' }])
    expect(logged.events('photo')).toEqual([{ ...storedLine(userId), read: 2, error: 'Error' }])
  })

  it('is told the same when none is stored and some are held: the message that asks about them is in the chat, and the next one fails', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([unsure(300, 'TEA HOUSE')], { unreadable: 1 }))
    // Telegram takes the message that asks, with its buttons, and not the one that comes after it.
    const send = deps.messenger.send.bind(deps.messenger)
    const refused = new TelegramError('sendMessage', 502)
    vi.spyOn(deps.messenger, 'send').mockImplementationOnce(send).mockRejectedValueOnce(refused)
    const [mark, logged] = [posted.length, catchConsole()]

    await chat.sendPhoto()

    // A photo that is sent again would be asked about a second time, under buttons that add its purchases as these
    // do. So what is said in the place of the placeholder does not say to send a clearer photo.
    const [notice, asking] = posted.slice(mark)
    expect(notice.text).toBe(STORED_NO_REPLY)
    expect(notice.text).not.toMatch(/clearer|could not be read/i)
    expect(asking.buttons?.flat().map((button) => button.text)).toEqual(['Add this one', 'Skip'])
    expect(await rowsOf(userId)).toEqual([])
    expect(await heldFor(userId)).toHaveLength(1)
    const counts = photoLine(userId, { read: 1, stored: 0, held: 1, unreadable: 1 })
    const failure = { outcome: 'failed', sent: 'edit', error: 'Error', reason: 'http_error', status: 502 }
    expect(logged.events('photo')).toEqual([{ ...counts, ...failure }])
  })

  it('is sent nothing in its place when its chat is one that Telegram will send nothing to', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE')]))
    vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new ChatBlockedError())
    const [mark, logged] = [posted.length, catchConsole()]

    await chat.sendPhoto()

    // The placeholder is left as it was: it is neither edited nor deleted.
    expect(leftSince(mark)).toEqual([READING])
    expect(sent).toEqual([])
    const line = { ...photoLine(userId, { read: 1, stored: 1 }), outcome: 'blocked', sent: 'none' }
    expect(logged.events('photo')).toEqual([{ ...line, error: 'ChatBlockedError', reason: 'chat_blocked' }])
  })
})

describe('a photo that fails with nothing stored', () => {
  it.each<[what: string, statement: string]>([
    ['the cards cannot be read', 'FROM cards'],
    ['the purchases cannot be stored', 'INSERT INTO transactions'],
  ])('is told that it could not be read, which leaves it to be sent again, when %s', async (_, statement) => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE')]))
    const prepare = env.DB.prepare.bind(env.DB)
    const queried = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes(statement)) throw new Error('a made-up failure that quotes: COFFEE PLACE')
      return prepare(query)
    })
    const logged = catchConsole()

    const notice = await noticeFor(chat)
    queried.mockRestore()

    expect(notice).toBe(NOT_READ)
    expect(await rowsOf(userId)).toEqual([])
    expect(logged.events('photo')).toMatchObject([{ user: userId, outcome: 'failed', stored: 0, error: 'Error' }])
  })

  it('is not told so once all of it is held, though the message that asks cannot be sent: it is not to be sent again unseen', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([unsure(300, 'TEA HOUSE')]))
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TelegramError('sendMessage', 502))
    const logged = catchConsole()

    // Its purchases are held from before the message that asks is sent, and whether Telegram took that is not known.
    expect(await noticeFor(chat)).toBe(STORED_NO_REPLY)

    expect(await rowsOf(userId)).toEqual([])
    const line = { ...photoLine(userId, { read: 1, stored: 0, held: 1 }), outcome: 'failed', sent: 'edit' }
    expect(logged.events('photo')).toEqual([{ ...line, error: 'Error', reason: 'http_error', status: 502 }])
  })
})

describe('what the log has of a photo', () => {
  it('is the line of its update, and then one line when its reading ends: whose it was, and what came of it', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE'), unsure(300, 'TEA HOUSE')], { card: 'evol', unreadable: 2 }))
    const logged = catchConsole()

    await chat.sendPhoto('on evol')

    expect(logged.events()).toEqual([
      { event: 'update', kind: 'photo', outcome: 'deferred', ms: 0 },
      photoLine(userId, { read: 2, stored: 1, held: 1, unreadable: 2 }),
    ])
    // As it is written, the line of the photo is this.
    expect(logged.text().split('\n').at(-1)).toBe(
      `{"event":"photo","user":${userId},"outcome":"read","sent":"rich","placeholder":true,"bytes":8,"requests":1,` +
        '"read":2,"unreadable":2,"stored":1,"held":1,"ms":0}',
    )
    // A photo that was read is no failure, and nothing of it is written at the level of one.
    expect(logged.failures()).toEqual([])
  })

  it('counts the requests that its reading took, and how long it took in all, by the clock that the service goes by', async () => {
    const chat = await chatWithCard()
    reader.mockImplementation(async (_deps, _provider, _input, taken) => {
      // The model is asked twice, and takes a second and a half over each answer.
      taken.requests += 2
      clock.now = new Date(clock.now.getTime() + 3_000)
      return read([bought(1240, 'COFFEE PLACE')])
    })
    const logged = catchConsole()

    await chat.sendPhoto()

    expect(logged.events('photo')).toMatchObject([{ outcome: 'read', requests: 2, ms: 3_000 }])
  })

  it('has nothing of the photo, of its caption, of its file or of what was read from it', async () => {
    const logged = catchConsole()
    const chat = openChat()
    await chat.say('/addcard privatecard 4321 calendar uob-evol')
    await chat.say('/addcard sparecard 8765 calendar')
    const caption = 'these are from the PRIVATE CLINIC, on privatecard'
    const purchases = [
      bought(9876, 'PRIVATE CLINIC', { occurredAt: seconds('2026-10-07T00:00:00+08:00') }),
      unsure(54321, 'SECRET SHOP', { currency: 'JPY' }),
    ]
    reading(read(purchases, { card: 'privatecard', category: 'other', unreadable: 1 }))
    // Telegram refuses the table with words that quote it, as an answer of its can.
    vi.spyOn(deps.messenger, 'sendRich').mockRejectedValueOnce(new TelegramError('sendRichMessage', 400))

    const { texts } = await chat.photo(caption, 424242)
    await chat.press(texts[1], 'Add this one')
    // And a photo that fails, one that is too large, and one of which nothing is known.
    reading({ status: 'failed', error: new Error(`A made-up failure that quotes: ${caption}`) })
    await chat.photo(caption, 434343)
    file.mockRejectedValueOnce(new Failure('file_too_large', 'made-up-file-id-large is of 987654 bytes'))
    await chat.photo(caption)
    reading(read(purchases))
    await chat.photo(caption, 444444)

    expect(logged.events().map((event) => event.event)).toEqual([
      'update',
      'update',
      'update',
      'photo',
      'held_press',
      'update',
      'update',
      'photo',
      'update',
      'photo',
      'update',
      'photo',
    ])
    expect(logged.events('photo').map((event) => event.outcome)).toEqual(['read', 'failed', 'too_large', 'read'])
    const said = ['PRIVATE', 'CLINIC', 'SECRET', 'SHOP', 'privatecard', 'sparecard', 'these are', 'made-up']
    const numbers = ['4321', '8765', '98.76', '9876', '543', 'JPY', 'SGD', '424242', '434343', '444444', '987654']
    // The bytes of the photo, as they would be written out in any of the ways that bytes are.
    const bytes = ['255,216', '/9j/', 'ffd8', '\\u00ff', 'MADE', '77,65,68,69']
    const held = ['held:', ':add', 'Oct', String(seconds('2026-10-07T00:00:00+08:00'))]
    for (const text of [...said, ...numbers, ...bytes, ...held, String(chat.telegramId)]) {
      expect(logged.text()).not.toContain(text)
    }
  })
})

describe('a photo that the bot does not read', () => {
  it('is one whose message has no id: it is passed over, as a message of text with none is', async () => {
    const chat = await chatWithCard()
    const [from, private_] = [{ id: chat.telegramId }, { id: chat.telegramId, type: 'private' }]
    const [mark, logged] = [posted.length, catchConsole()]

    const later = await handleUpdate(deps, { message: { photo: PHOTO, caption: 'evol', chat: private_, from } })

    expect(later).toBeUndefined()
    expect([sent, leftSince(mark)]).toEqual([[], []])
    expect(logged.events()).toEqual([{ event: 'update', kind: 'photo', outcome: 'ignored', why: 'no_id', ms: 0 }])
  })

  it.each<[what: string, chat: (id: number) => object, why: string]>([
    ['a group', () => ({ id: -5001, type: 'group' }), 'not_private'],
    ["a private chat that is not its sender's own", (id) => ({ id: id + 1, type: 'private' }), 'not_own_chat'],
  ])('is one that is sent in %s: it is passed over, as a message of text there is', async (_, chatOf, why) => {
    const chat = await chatWithCard()
    const message = { message_id: MESSAGE, photo: PHOTO, chat: chatOf(chat.telegramId), from: { id: chat.telegramId } }
    const [mark, logged] = [posted.length, catchConsole()]

    const later = await handleUpdate(deps, { message })

    expect(later).toBeUndefined()
    expect([sent, leftSince(mark)]).toEqual([[], []])
    expect(logged.events()).toEqual([{ event: 'update', kind: 'message', outcome: 'ignored', why, ms: 0 }])
  })

  it('is one as it stands after its caption was edited: it was read when it came, and is not read again', async () => {
    const chat = await chatWithCard()
    reading(read([bought(1240, 'COFFEE PLACE')]))
    await chat.photo('evol', MESSAGE)
    const [from, private_] = [{ id: chat.telegramId }, { id: chat.telegramId, type: 'private' }]
    const edited = { message_id: MESSAGE, photo: PHOTO, caption: 'not evol after all', chat: private_, from }
    const logged = catchConsole()

    const later = await handleUpdate(deps, { edited_message: edited })

    expect(later).toBeUndefined()
    expect(reader).toHaveBeenCalledTimes(1)
    expect(logged.events()).toEqual([{ event: 'update', kind: 'edited', outcome: 'ignored', why: 'not_text', ms: 0 }])
  })
})

describe('a service that reads photos', () => {
  const ASK =
    'You can also just ask a question in your own words, and it is answered by an AI service, which is sent your ' +
    'question and the card and purchase details needed to answer it.'
  const ASK_TOO =
    'Any other message is read as a question, and is answered by an AI service, which is sent your question and the ' +
    'card and purchase details needed to answer it.'
  // What a service with an assistant says after either: that it can be told what to do in the same way.
  const DO =
    'You can say what you want done in your own words too, as in "add 5.20 lunch to evol as other spend" or "set my ' +
    'time zone to Tokyo": the same AI service works out what you asked for, and the bot does it.'
  const PHOTO_TOO =
    "You can send a photo of your card transactions too, such as a screenshot from your bank's app, and the " +
    'purchases in it are added. A caption can name the card and the category, as in "add these to evol as other ' +
    'spend". The photo is read by the same AI service, which is sent the photo, its caption, your time zone, and ' +
    'the nicknames and category names of your cards.'
  const NOT_READ_HERE =
    'The bot reads text messages and photos. It cannot read any other attachment, such as a file or a voice message, ' +
    'or the caption under one. Please send your question or command as text, and a picture of your card ' +
    'transactions as a photo and not as a file.'
  const NOT_TEXT =
    'The bot only reads text messages. It cannot read an attachment, such as a photo, a file or a voice message, or ' +
    'the caption under one. Please send your question or command as text.'

  /** A service that has an assistant, and no model that reads photos. */
  function noVision() {
    deps.ai = deps.ai && { ...deps.ai, visionModel: undefined }
  }

  /** A message of the user's that is neither text nor a photo, with words under it when it is a file. */
  function attachment(chat: Chat, content: object) {
    const [from, private_] = [{ id: chat.telegramId }, { id: chat.telegramId, type: 'private' }]
    const update: object = { message: { message_id: MESSAGE, date: 1, chat: private_, from, ...content } }
    return handleUpdate(deps, update)
  }

  it('says in its welcome that a photo can be sent, what a caption can name, and what the AI service is sent of it', async () => {
    const [welcome, commands, ...more] = (await openChat().say('/start')).split('\n\n')

    // After what it says of a question and of what it can be told to do, and before the list of the commands.
    expect(welcome.startsWith('Welcome to Spend Tracker. ')).toBe(true)
    expect(welcome.endsWith(` with /timezone. ${ASK} ${DO} ${PHOTO_TOO}`)).toBe(true)
    expect(commands).toMatch(/^Commands:\n\/addcard .*\n\/delete - delete everything stored about you$/s)
    expect(more).toEqual([])
  })

  it.each(['/help', '/', '/unknown'])('says the same under the list of its commands, sent for "%s"', async (text) => {
    const [commands, asking, ...more] = (await openChat().say(text)).split('\n\n')

    expect(commands).toMatch(/^Commands:\n\/addcard .*\n\/delete - delete everything stored about you$/s)
    expect(asking).toBe(`${ASK_TOO} ${DO} ${PHOTO_TOO}`)
    expect(more).toEqual([])
  })

  it('says none of it when it has an assistant and no model that reads photos', async () => {
    noVision()
    const chat = openChat()

    const [welcome, commands] = [await chat.say('/start'), await chat.say('/help')]

    expect(welcome.split('\n\n')[0].endsWith(` with /timezone. ${ASK} ${DO}`)).toBe(true)
    expect(commands.split('\n\n')[1]).toBe(`${ASK_TOO} ${DO}`)
    for (const reply of [welcome, commands]) expect(reply).not.toMatch(/photo|caption/i)
  })

  it.each<[what: string, content: object]>([
    ['a file with words under it', { document: { file_id: 'made-up-file-id' }, caption: 'add these to evol' }],
    ['a picture that is sent as a file', { document: { file_id: 'made-up-file-id', mime_type: 'image/png' } }],
    ['a voice message', { voice: { file_id: 'made-up-file-id', duration: 3 } }],
    ['a sticker', { sticker: { file_id: 'made-up-file-id', width: 512, height: 512 } }],
    ['a photo of which Telegram gives no size', { photo: [] }],
    ['what is called a photo and is none', { photo: 'made-up' }],
    ['a message with nothing in it', {}],
  ])('answers %s with what it reads, which is text and photos, and does nothing else about it', async (_, content) => {
    const chat = await chatWithCard()
    const logged = catchConsole()

    const later = await attachment(chat, content)

    expect(later).toBeUndefined()
    expect(sent).toEqual([{ chatId: chat.telegramId, text: NOT_READ_HERE }])
    expect([file, reader].map((spy) => spy.mock.calls.length)).toEqual([0, 0])
    expect(logged.events()).toEqual([{ event: 'update', kind: 'not_text', outcome: 'replied', ms: 0 }])
  })

  it('answers a photo as it answers any other attachment, when it has no model that reads photos: at once, with that the bot only reads text', async () => {
    noVision()
    const chat = await chatWithCard()
    const logged = catchConsole()

    const later = await attachment(chat, { photo: PHOTO, caption: 'add these to evol' })

    // Nothing is left for later: no placeholder, no file and no reading.
    expect(later).toBeUndefined()
    expect(sent).toEqual([{ chatId: chat.telegramId, text: NOT_TEXT }])
    expect([file, reader].map((spy) => spy.mock.calls.length)).toEqual([0, 0])
    expect(await rowsOf(await chat.userId())).toEqual([])
    expect(logged.events()).toEqual([{ event: 'update', kind: 'not_text', outcome: 'replied', ms: 0 }])
  })

  it('answers a photo so too when it has no AI provider at all', async () => {
    deps.ai = undefined
    const chat = await chatWithCard()

    expect(await attachment(chat, { photo: PHOTO })).toBeUndefined()

    expect(sent).toEqual([{ chatId: chat.telegramId, text: NOT_TEXT }])
    expect(reader).not.toHaveBeenCalled()
  })
})

