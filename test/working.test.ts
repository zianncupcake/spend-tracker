import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { depsFor } from '../src/deps'
import { findUser } from '../src/store'
import { handleUpdate } from '../src/telegram/handler'
import { FAILED, NOT_ANSWERED, TOOK_TOO_LONG, WORKING } from '../src/telegram/texts'
import { AI_URL, refusing, saying } from './ai-helpers'
import { newTelegramId, plain, userCount } from './helpers'
import { catchConsole } from './log-helpers'

// What the user of a question is shown while it is answered, what they are told when it is not, and what the log
// has of both. The bot posts to Telegram here as the service does, and a stand-in for Telegram keeps what it is
// posted, in order, and answers as a test has it answer. A stand-in for the AI provider answers when a test lets it.
// The clock is a fake one that a test moves, so nothing here waits the four seconds between two showings that the
// bot is writing, the 5 that a request to Telegram is given, or the 27 that a question is given.

const API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/`

/** The service as it is set up, with the messenger that posts to Telegram. Its clock is the fake one. */
const deps = depsFor(env)

/** A request to Telegram: the method of its API that was asked for, and what the request held. */
type Asked = [method: string, body: Record<string, unknown>]

/** The stand-in for Telegram. A test has it refuse a request, or take its time over one, with an implementation. */
const telegram = vi.fn<(...asked: Asked) => Response | Promise<Response>>()

/** The stand-in for the AI provider, which a test has answer. */
const provider = vi.fn<() => Response | Promise<Response>>()

/**
 * The signal that the request now being answered came with, which is what ends a request that is never answered.
 * A stand-in is called with what a request holds. This is what the request came with besides.
 */
let signal: AbortSignal | null | undefined

/** The signals that the requests to Telegram came with, in the order of the requests. */
const signals: (AbortSignal | null | undefined)[] = []

/** The id of the last message that the stand-in for Telegram sent. Each message has the next one. */
let lastId = 0

/** The id of the first message that Telegram sends in a test, which is the placeholder of the test's question. */
const PLACEHOLDER = 501

/**
 * Telegram's answer to a request that it takes, as far as the bot reads one: to a request that sends a message, the
 * message with the id that Telegram gave it.
 */
function taken(method: string): Response {
  const sends = method === 'sendMessage' || method === 'sendRichMessage'
  return Response.json({ ok: true, result: sends ? { message_id: ++lastId, date: 1 } : true })
}

/** Telegram's answer to a request that it does not take. With 403, it will have the chat sent nothing. */
function refused(status: number): Response {
  return Response.json({ ok: false, error_code: status, description: 'A made-up error.' }, { status })
}

/**
 * What a stand-in does with a request that it never answers. The request ends only when its signal does, as fetch
 * has it end: it fails with why the signal ended. A request that came with no signal would never end.
 */
function unanswered(): Promise<Response> {
  const ending = signal
  return new Promise((_, reject) => ending?.addEventListener('abort', () => reject(ending.reason)))
}

/**
 * Has Telegram never answer the requests for one method of its API, and take every other. Returns what is done
 * once the first such request has been made: a test waits for that before it moves the clock, so that the time
 * which the request is given is counted from where the test takes it to be.
 */
function stalling(method: string): Promise<void> {
  const made = Promise.withResolvers<void>()
  telegram.mockImplementation((asked) => {
    if (asked !== method) return taken(asked)
    made.resolve()
    return unanswered()
  })
  return made.promise
}

/**
 * Has the time that a request is given run by the fake clock. Fake timers do not move AbortSignal.timeout, which is
 * the runtime's own, so this stands in for it: with a signal that ends as that one does, with a TimeoutError for
 * why. Returns the stand-in, which keeps the times that requests were given.
 */
function timeoutsByFakeClock() {
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController()
    const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    setTimeout(() => controller.abort(reason), milliseconds)
    return controller.signal
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  lastId = PLACEHOLDER - 1
  signals.length = 0
  telegram.mockReset()
  telegram.mockImplementation(taken)
  provider.mockReset()
  provider.mockImplementation(() => {
    throw new Error('A test made a request it should not have')
  })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    signal = init.signal
    if (url === AI_URL) return provider()
    if (!url.startsWith(API)) throw new Error('A test made a request it should not have')
    signals.push(init.signal)
    return telegram(url.slice(API.length), JSON.parse(String(init.body)))
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

let lastMessage = 0

/**
 * A new user sends the bot a question in their private chat with it, and Telegram is told that the update was
 * taken. Returns what the bot has left for after that, which a test has it do by calling `later`.
 */
async function question(text = 'How much have I spent?') {
  const telegramId = newTelegramId()
  const [chat, from] = [{ id: telegramId, type: 'private' }, { id: telegramId }]
  const later = await handleUpdate(deps, { message: { message_id: ++lastMessage, text, chat, from } })
  if (!later) throw new Error('A question was answered at once, with nothing left for later')
  // Nothing is sent, read or asked until then.
  expect(telegram).not.toHaveBeenCalled()
  return { telegramId, later }
}

/** What the provider answers a request with when the model says the text. */
function saidByModel(text = 'An answer.'): Response {
  return Response.json(saying(text))
}

/**
 * A model that answers when a test lets it. `asked` is done once the bot has asked it, and `answer` has the
 * provider answer that request with a response, such as `saidByModel` makes.
 */
function slowModel() {
  const asked = Promise.withResolvers<void>()
  const answered = Promise.withResolvers<Response>()
  provider.mockImplementationOnce(() => {
    asked.resolve()
    return answered.promise
  })
  return { asked: asked.promise, answer: answered.resolve }
}

/** A model that answers a question at once with the text. */
function quickModel(text?: string) {
  provider.mockImplementationOnce(() => saidByModel(text))
}

/** The methods that Telegram was asked for, in order. */
function methods(): string[] {
  return telegram.mock.calls.map(([method]) => method)
}

// The requests that the bot is to post to Telegram, each of them whole.

function placeholder(chatId: number): Asked {
  return said(chatId, WORKING)
}

/** A message of plain text, with nothing marked in it and no link previewed. */
function said(chatId: number, text: string): Asked {
  return ['sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }]
}

function typing(chatId: number): Asked {
  return ['sendChatAction', { chat_id: chatId, action: 'typing' }]
}

/** An answer as a rich message: a paragraph to each of the lines, in which Telegram is to detect nothing. */
function rich(chatId: number, ...lines: string[]): Asked {
  const blocks = lines.map(plain)
  return ['sendRichMessage', { chat_id: chatId, rich_message: { skip_entity_detection: true, blocks } }]
}

/** An answer as text, all of it marked as code. */
function asCode(chatId: number, text: string): Asked {
  const entities = [{ type: 'code', offset: 0, length: text.length }]
  return ['sendMessage', { chat_id: chatId, text, entities, link_preview_options: { is_disabled: true } }]
}

/** The text put in the place of the placeholder's, which is named by the id that Telegram gave it. */
function edited(chatId: number, text: string): Asked {
  return [
    'editMessageText',
    {
      chat_id: chatId,
      message_id: PLACEHOLDER,
      text,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    },
  ]
}

/** The placeholder deleted, by the id that Telegram gave it. */
function deleted(chatId: number): Asked {
  return ['deleteMessage', { chat_id: chatId, message_id: PLACEHOLDER }]
}

// The lines that the log is to have, each of them whole.

/** The line of a request that Telegram answered with an error: its method, and the status of the answer. */
function refusedCall(method: string, status: number) {
  return { event: 'telegram_failed', method, status, error: 'Error', reason: 'http_error' }
}

/** The line of a request that Telegram answered with that the chat is to be sent nothing. */
function blockedCall(method: string) {
  return { event: 'telegram_failed', method, status: 403, error: 'ChatBlockedError', reason: 'chat_blocked' }
}

/**
 * The line of a question that the model answered at once, with its answer sent as a rich message and its
 * placeholder gone, in no time by the fake clock. A test says what its question's line has otherwise. `telegramId`
 * is of the user who asked: the line has the service's own id of them.
 */
async function answeredLine(telegramId: number) {
  const user = (await findUser(env.DB, telegramId))?.id
  expect(user).toBeTypeOf('number')
  return {
    event: 'question',
    user,
    outcome: 'answered',
    sent: 'rich',
    placeholder: true,
    requests: 1,
    tool_calls: 0,
    ms: 0,
  }
}

/** What the line of a question has besides, when the provider answered a request with the status. */
function providerRefused(status: number) {
  return { error: 'Error', reason: 'http_error', status }
}

describe('a question, while it is answered', () => {
  it('is answered with a placeholder first, before anything is read and before the model is asked', async () => {
    const queried = vi.spyOn(env.DB, 'prepare')
    const model = slowModel()
    const { telegramId, later } = await question()

    const done = later()
    await model.asked

    // The model has still to answer, and the chat has the placeholder and is shown that the bot is writing.
    expect(telegram.mock.calls).toEqual([placeholder(telegramId), typing(telegramId)])
    const [first, second] = telegram.mock.invocationCallOrder
    expect(first).toBeLessThan(second)
    expect(second).toBeLessThan(queried.mock.invocationCallOrder[0])
    expect(queried.mock.invocationCallOrder[0]).toBeLessThan(provider.mock.invocationCallOrder[0])

    model.answer(saidByModel())
    await done
  })

  it('has its placeholder deleted, by the id that Telegram gave it, once the answer is in the chat', async () => {
    quickModel('You spent SGD 12.40.\n\nAll of it at COFFEE PLACE.')
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      rich(telegramId, 'You spent SGD 12.40.', 'All of it at COFFEE PLACE.'),
      deleted(telegramId),
    ])
  })

  it('has its placeholder deleted in the same way when the answer had to be sent as text', async () => {
    const logged = catchConsole()
    telegram.mockImplementation((method) => (method === 'sendRichMessage' ? refused(400) : taken(method)))
    quickModel('You spent SGD 12.40.\n\nAll of it at COFFEE PLACE.')
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      rich(telegramId, 'You spent SGD 12.40.', 'All of it at COFFEE PLACE.'),
      asCode(telegramId, 'You spent SGD 12.40.\nAll of it at COFFEE PLACE.'),
      deleted(telegramId),
    ])
    // The request that Telegram refused is logged with its status, and the question as one that was answered in text.
    expect(logged.events('telegram_failed')).toEqual([refusedCall('sendRichMessage', 400)])
    expect(logged.events('question')).toEqual([{ ...(await answeredLine(telegramId)), sent: 'text' }])
  })

  it('has the chat shown that the bot is writing every four seconds until the answer is ready, and not after', async () => {
    const model = slowModel()
    const { telegramId, later } = await question()
    const done = later()
    await model.asked
    const shown = () => methods().filter((method) => method === 'sendChatAction').length

    expect(shown()).toBe(1)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(shown()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(shown()).toBe(2)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(shown()).toBe(4)

    model.answer(saidByModel())
    await done

    // Neither clock of the question runs on: the one that shows the bot to be writing, or the one that ends the wait.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      ...Array.from({ length: 4 }, () => typing(telegramId)),
      rich(telegramId, 'An answer.'),
      deleted(telegramId),
    ])
  })

  it('is answered all the same when Telegram will not show that the bot is writing, however often it is asked to', async () => {
    const logged = catchConsole()
    telegram.mockImplementation((method) => (method === 'sendChatAction' ? refused(400) : taken(method)))
    const model = slowModel()
    const { telegramId, later } = await question()
    const done = later()
    await model.asked

    await vi.advanceTimersByTimeAsync(4_000)
    model.answer(saidByModel())
    await done

    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      typing(telegramId),
      rich(telegramId, 'An answer.'),
      deleted(telegramId),
    ])
    // Each showing that Telegram refused has its line, and the question is one that was answered, after four seconds.
    expect(logged.events('telegram_failed')).toEqual([
      refusedCall('sendChatAction', 400),
      refusedCall('sendChatAction', 400),
    ])
    expect(logged.events('question')).toEqual([{ ...(await answeredLine(telegramId)), ms: 4_000 }])
  })

  it('is answered all the same when the placeholder could not be sent, and there is then none to delete', async () => {
    const logged = catchConsole()
    telegram.mockImplementationOnce(() => refused(500))
    quickModel()
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([placeholder(telegramId), typing(telegramId), rich(telegramId, 'An answer.')])
    expect(logged.events('telegram_failed')).toEqual([refusedCall('sendMessage', 500)])
    expect(logged.events('question')).toEqual([{ ...(await answeredLine(telegramId)), placeholder: false }])
  })

  it('is answered all the same when Telegram took the placeholder and did not say which message it is', async () => {
    const logged = catchConsole()
    // An answer that holds no id: there is then nothing to delete the placeholder by, or to edit it by.
    telegram.mockImplementationOnce(() => Response.json({ ok: true, result: {} }))
    quickModel()
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([placeholder(telegramId), typing(telegramId), rich(telegramId, 'An answer.')])
    // The request was answered 200, and failed for what its answer did not hold.
    expect(logged.events('telegram_failed')).toEqual([
      { event: 'telegram_failed', method: 'sendMessage', status: 200, error: 'Error', reason: 'no_message_id' },
    ])
    expect(logged.events('question')).toEqual([{ ...(await answeredLine(telegramId)), placeholder: false }])
  })

  it('keeps its answer when the placeholder cannot be deleted, which is left above it', async () => {
    const logged = catchConsole()
    telegram.mockImplementation((method) => (method === 'deleteMessage' ? refused(400) : taken(method)))
    quickModel()
    const { telegramId, later } = await question()

    await later()

    // Nothing is said in the place of a placeholder that has its answer under it.
    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      rich(telegramId, 'An answer.'),
      deleted(telegramId),
    ])
    expect(logged.events('telegram_failed')).toEqual([refusedCall('deleteMessage', 400)])
    expect(logged.events('question')).toEqual([await answeredLine(telegramId)])
  })
})

describe('a question that cannot be answered', () => {
  /** The whole of what Telegram is asked when the placeholder is edited to say that there is no answer. */
  function toldSo(telegramId: number): Asked[] {
    return [placeholder(telegramId), typing(telegramId), edited(telegramId, NOT_ANSWERED)]
  }

  /**
   * The line of a question that the model was asked once and that was not answered, with its user told so in the
   * place of the placeholder. A test says what its question's line has otherwise, and what it has of the failure.
   */
  async function failedLine(telegramId: number) {
    return { ...(await answeredLine(telegramId)), outcome: 'failed', sent: 'edit' }
  }

  it("has its user told so in the place of the placeholder when the user's row cannot be read", async () => {
    const logged = catchConsole()
    const prepare = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('users')) throw new Error('a made-up failure that quotes a question: How much have I spent?')
      return prepare(query)
    })
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual(toldSo(telegramId))
    expect(provider).not.toHaveBeenCalled()
    // The line names no user, as none was read, and counts nothing. Only the name of the error is logged.
    expect(logged.events('question')).toEqual([
      {
        event: 'question',
        user: null,
        outcome: 'failed',
        sent: 'edit',
        placeholder: true,
        requests: 0,
        tool_calls: 0,
        ms: 0,
        error: 'Error',
      },
    ])
    expect(logged.text()).not.toContain('How much have I spent?')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('has its user told so in the place of the placeholder when Telegram takes the answer neither way', async () => {
    const logged = catchConsole()
    // Neither as a rich message nor as text that is marked as code, which only the answer is.
    telegram.mockImplementation((method, body) =>
      method === 'sendRichMessage' || body.entities ? refused(400) : taken(method),
    )
    quickModel()
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      rich(telegramId, 'An answer.'),
      asCode(telegramId, 'An answer.'),
      edited(telegramId, NOT_ANSWERED),
    ])
    // Both requests have their lines, and the question's line has what the second of them failed with.
    expect(logged.events('telegram_failed')).toEqual([
      refusedCall('sendRichMessage', 400),
      refusedCall('sendMessage', 400),
    ])
    expect(logged.events('question')).toEqual([
      { ...(await failedLine(telegramId)), error: 'Error', reason: 'http_error', status: 400 },
    ])
  })

  it('has its user told so when the answer cannot be sent for a reason that is no answer of Telegram’s', async () => {
    const logged = catchConsole()
    telegram.mockImplementation((method) => {
      if (method === 'sendRichMessage') throw new TypeError('A made-up failure of the network')
      return taken(method)
    })
    quickModel()
    const { telegramId, later } = await question()

    await later()

    // Such a failure is not one that sending the answer as text would get around, so that is not tried.
    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      rich(telegramId, 'An answer.'),
      edited(telegramId, NOT_ANSWERED),
    ])
    // A request that got no answer has no status to log.
    expect(logged.events('telegram_failed')).toEqual([
      { event: 'telegram_failed', method: 'sendRichMessage', error: 'TypeError' },
    ])
    expect(logged.events('question')).toEqual([{ ...(await failedLine(telegramId)), error: 'TypeError' }])
  })

  it('has its user told so in a message of its own when there is no placeholder to say it in', async () => {
    const logged = catchConsole()
    telegram.mockImplementationOnce(() => refused(500))
    provider.mockImplementationOnce(refusing(500))
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([placeholder(telegramId), typing(telegramId), said(telegramId, NOT_ANSWERED)])
    expect(logged.events('telegram_failed')).toEqual([refusedCall('sendMessage', 500)])
    expect(logged.events('question')).toEqual([
      { ...(await failedLine(telegramId)), sent: 'message', placeholder: false, ...providerRefused(500) },
    ])
  })

  it('has its user told so in a message of its own when Telegram will not have the placeholder edited', async () => {
    const logged = catchConsole()
    // As it will not when its user has deleted it in the meantime.
    telegram.mockImplementation((method) => (method === 'editMessageText' ? refused(400) : taken(method)))
    provider.mockImplementationOnce(refusing(500))
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([...toldSo(telegramId), said(telegramId, NOT_ANSWERED)])
    expect(logged.events('telegram_failed')).toEqual([refusedCall('editMessageText', 400)])
    expect(logged.events('question')).toEqual([
      { ...(await failedLine(telegramId)), sent: 'message', ...providerRefused(500) },
    ])
  })

  it('has its user told nothing when Telegram takes it neither way, which is logged, and does not fail for that', async () => {
    const logged = catchConsole()
    // Telegram takes the placeholder, and from then on shows the bot to be writing and takes nothing else.
    telegram.mockImplementation((method) => (method === 'sendChatAction' ? taken(method) : refused(502)))
    telegram.mockImplementationOnce(taken)
    provider.mockImplementationOnce(refusing(500))
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([...toldSo(telegramId), said(telegramId, NOT_ANSWERED)])
    expect(logged.events('telegram_failed')).toEqual([
      refusedCall('editMessageText', 502),
      refusedCall('sendMessage', 502),
    ])
    // The question is logged with what went wrong with it, which is what its user was to be told of.
    expect(logged.events('question')).toEqual([
      { ...(await failedLine(telegramId)), sent: 'none', ...providerRefused(500) },
    ])
  })
})

describe('a question that takes too long', () => {
  it('is waited for 27 seconds, and its user is then told so in the place of the placeholder', async () => {
    const logged = catchConsole()
    const model = slowModel()
    const { telegramId, later } = await question()
    const done = later()
    await model.asked

    // Until then the bot is shown to be writing: at once, and seven times in all.
    await vi.advanceTimersByTimeAsync(26_999)
    const waiting = [placeholder(telegramId), ...Array.from({ length: 7 }, () => typing(telegramId))]
    expect(telegram.mock.calls).toEqual(waiting)
    expect(logged.events('question')).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await done

    expect(telegram.mock.calls).toEqual([...waiting, edited(telegramId, TOOK_TOO_LONG)])
    expect(vi.getTimerCount()).toBe(0)
    // Its line is that of a failure: it took too long, after the one request that the model has still to answer.
    const line = { ...(await answeredLine(telegramId)), outcome: 'timeout', sent: 'edit', ms: 27_000 }
    expect(logged.events('question')).toEqual([{ ...line, error: 'Error', reason: 'took_too_long' }])
    expect(logged.failures()).toEqual(logged.events('question'))
  })

  it('is not answered after that: an answer that comes late is sent to nobody', async () => {
    const logged = catchConsole()
    const model = slowModel()
    const { later } = await question()
    const done = later()
    await model.asked
    await vi.advanceTimersByTimeAsync(27_000)
    await done
    const told = telegram.mock.calls.length

    // The model answers after all, and the bot reads the whole of what it says.
    const late = saidByModel('A late answer.')
    const read = vi.spyOn(late, 'json')
    model.answer(late)
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    await read.mock.results[0].value
    await vi.advanceTimersByTimeAsync(60_000)

    expect(methods().at(-1)).toBe('editMessageText')
    expect(telegram.mock.calls).toHaveLength(told)
    // The question was logged once, as one that took too long, and is not logged again as one that was answered.
    expect(logged.events('question')).toMatchObject([{ outcome: 'timeout', sent: 'edit' }])
  })

  it('counts the time that the placeholder took to send: the wait is so much shorter', async () => {
    const model = slowModel()
    // Telegram takes four seconds over the placeholder.
    const placed = Promise.withResolvers<Response>()
    telegram.mockImplementationOnce(() => placed.promise)
    const { telegramId, later } = await question()
    const done = later()
    await vi.advanceTimersByTimeAsync(4_000)
    placed.resolve(taken('sendMessage'))
    await model.asked

    await vi.advanceTimersByTimeAsync(22_999)
    expect(methods()).not.toContain('editMessageText')
    await vi.advanceTimersByTimeAsync(1)
    await done

    expect(telegram.mock.calls.at(-1)).toEqual(edited(telegramId, TOOK_TOO_LONG))
  })
})

describe('a chat that Telegram will send nothing to', () => {
  /** What the line of a question has of the failure, when Telegram will send its chat nothing. */
  const BLOCKED = { outcome: 'blocked', sent: 'none', error: 'ChatBlockedError', reason: 'chat_blocked' }

  it('is sent the placeholder and no more: the model is asked nothing, and nothing is stored', async () => {
    const logged = catchConsole()
    telegram.mockImplementation(() => refused(403))
    const { telegramId, later } = await question()

    // It does not fail for that: what came of the question is logged.
    await later()

    expect(telegram.mock.calls).toEqual([placeholder(telegramId)])
    expect(provider).not.toHaveBeenCalled()
    expect(await userCount(telegramId)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(logged.events('telegram_failed')).toEqual([blockedCall('sendMessage')])
    // The line names no user: nobody is looked up only to be named in it.
    expect(logged.events('question')).toEqual([
      { event: 'question', user: null, placeholder: false, requests: 0, tool_calls: 0, ms: 0, ...BLOCKED },
    ])
  })

  it('is sent neither the answer as text nor anything in its place, when it is the answer that Telegram will not send', async () => {
    const logged = catchConsole()
    // Its user blocks the bot once the placeholder is there.
    telegram.mockImplementation(() => refused(403)).mockImplementationOnce(taken)
    quickModel()
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([placeholder(telegramId), typing(telegramId), rich(telegramId, 'An answer.')])
    expect(logged.events('telegram_failed')).toEqual([blockedCall('sendChatAction'), blockedCall('sendRichMessage')])
    expect(logged.events('question')).toEqual([{ ...(await answeredLine(telegramId)), ...BLOCKED }])
  })

  it('is not sent in a message of its own what Telegram will not have said in the place of the placeholder', async () => {
    const logged = catchConsole()
    telegram.mockImplementation(() => refused(403)).mockImplementationOnce(taken)
    provider.mockImplementationOnce(refusing(500))
    const { telegramId, later } = await question()

    await later()

    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      edited(telegramId, NOT_ANSWERED),
    ])
    expect(logged.events('telegram_failed')).toEqual([blockedCall('sendChatAction'), blockedCall('editMessageText')])
    // That the chat is to be sent nothing is what came of the question, whatever went wrong with it before.
    expect(logged.events('question')).toEqual([{ ...(await answeredLine(telegramId)), ...BLOCKED }])
  })
})

describe('what the log has of a question', () => {
  it('has nothing of the question, of its answer, of the chat or of what Telegram said of a request', async () => {
    const logged = catchConsole()
    const answer = 'You spent SGD 12.40 at COFFEE PLACE.'
    // Telegram refuses the rich message with words that quote it, as an answer of its can.
    telegram.mockImplementation((method) => {
      const description = `Bad Request: can't parse ${answer}`
      const refusal = Response.json({ ok: false, error_code: 400, description }, { status: 400 })
      return method === 'sendRichMessage' ? refusal : taken(method)
    })
    quickModel(answer)
    const { telegramId, later } = await question('How much did I spend at COFFEE PLACE?')

    await later()

    expect(logged.events().map((event) => event.event)).toEqual(['update', 'ai_call', 'telegram_failed', 'question'])
    const never = ['COFFEE', '12.40', 'How much', 'Bad Request', 'parse', 'Working on it', 'test-ai-key']
    for (const text of [...never, String(telegramId), String(PLACEHOLDER), env.TELEGRAM_BOT_TOKEN]) {
      expect(logged.text()).not.toContain(text)
    }
  })

  it('has nothing of what a request to Telegram failed with, when that quotes its address and so the token of the bot', async () => {
    const logged = catchConsole()
    // Telegram cannot be reached at all, and what fetch says of that names where the request was going.
    telegram.mockImplementation((method) => {
      throw new TypeError(`fetch failed: POST ${API}${method} could not be reached`)
    })
    quickModel()
    const { telegramId, later } = await question()

    await later()

    // The placeholder, the showing that the bot is writing, the answer, and that there was none: each failed so.
    expect(methods()).toEqual(['sendMessage', 'sendChatAction', 'sendRichMessage', 'sendMessage'])
    expect(logged.events('telegram_failed')).toEqual(
      methods().map((method) => ({ event: 'telegram_failed', method, error: 'TypeError' })),
    )
    const line = { ...(await answeredLine(telegramId)), outcome: 'failed', sent: 'none', placeholder: false }
    expect(logged.events('question')).toEqual([{ ...line, error: 'TypeError' }])
    // The name of the error is all that a line has of it: not its words, the address or the token.
    const never = [env.TELEGRAM_BOT_TOKEN, 'api.telegram.org', '/bot', 'https:', 'fetch failed', 'could not be reached']
    for (const text of never) expect(logged.text()).not.toContain(text)
  })
})

describe('a request that Telegram does not answer', () => {
  /** The line of a request that was given up on. It got no answer, so it has no status. */
  function givenUp(method: string) {
    return { event: 'telegram_failed', method, error: 'TimeoutError' }
  }

  it('is given 5 seconds, as each request to Telegram is, and comes with the signal that ends it then', async () => {
    const timeouts = timeoutsByFakeClock()
    quickModel()
    const { later } = await question()

    await later()

    // The placeholder and the showing that the bot is writing, each with its 5 seconds. Then the request to the
    // model, which has 20 of its own. Then the answer and the deleting of the placeholder, with 5 each.
    expect(methods()).toEqual(['sendMessage', 'sendChatAction', 'sendRichMessage', 'deleteMessage'])
    expect(timeouts.mock.calls).toEqual([[5_000], [5_000], [20_000], [5_000], [5_000]])
    // Each request to Telegram came with the signal that was made for it, and with no other.
    const made = timeouts.mock.results.map((result) => result.value)
    expect(signals.map((each) => made.indexOf(each))).toEqual([0, 1, 3, 4])
  })

  it('is given up on when it is the notice in the place of the placeholder, which is then sent as a message', async () => {
    timeoutsByFakeClock()
    const logged = catchConsole()
    const made = stalling('editMessageText')
    provider.mockImplementationOnce(refusing(500))
    const { telegramId, later } = await question()
    const done = later()

    await made
    await vi.advanceTimersByTimeAsync(4_999)
    expect(methods().at(-1)).toBe('editMessageText')
    await vi.advanceTimersByTimeAsync(1)
    await done

    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      edited(telegramId, NOT_ANSWERED),
      said(telegramId, NOT_ANSWERED),
    ])
    expect(logged.events('telegram_failed')).toEqual([givenUp('editMessageText')])
    const line = { ...(await answeredLine(telegramId)), outcome: 'failed', sent: 'message', ms: 5_000 }
    expect(logged.events('question')).toEqual([{ ...line, ...providerRefused(500) }])
  })

  it('is not waited for when it is the showing that the bot is writing: the question is answered meanwhile', async () => {
    timeoutsByFakeClock()
    const logged = catchConsole()
    telegram.mockImplementation((method) => (method === 'sendChatAction' ? unanswered() : taken(method)))
    quickModel()
    const { telegramId, later } = await question()

    // With no time gone by, and the request for the showing still to be answered.
    await later()

    expect(telegram.mock.calls).toEqual([
      placeholder(telegramId),
      typing(telegramId),
      rich(telegramId, 'An answer.'),
      deleted(telegramId),
    ])
    expect(logged.events('question')).toEqual([await answeredLine(telegramId)])
    expect(logged.events('telegram_failed')).toEqual([])

    // The request is given up on when its 5 seconds are over, and is logged then.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(logged.events('telegram_failed')).toEqual([givenUp('sendChatAction')])
  })

  it('is given up on when it is the reply to a command, and the chat is told that something went wrong', async () => {
    timeoutsByFakeClock()
    const logged = catchConsole()
    // Telegram does not answer the reply, which is the table of /products, and takes what comes after it.
    const made = Promise.withResolvers<void>()
    telegram.mockImplementationOnce(() => {
      made.resolve()
      return unanswered()
    })
    const telegramId = newTelegramId()
    const [chat, from] = [{ id: telegramId, type: 'private' }, { id: telegramId }]

    const done = handleUpdate(deps, { message: { message_id: ++lastMessage, text: '/products', chat, from } })
    // The 5 seconds of the reply start when the request for it is made, so that is waited for first.
    await made.promise
    await vi.advanceTimersByTimeAsync(5_000)

    // Telegram is told that the update was taken once the reply has been given up on, and not before.
    expect(await done).toBeUndefined()
    // A rich message that Telegram did not answer is not sent again as text, as one that it refuses is: whether it
    // took the first is not known.
    const reply = expect.objectContaining({ chat_id: telegramId, rich_message: expect.anything() })
    expect(telegram.mock.calls).toEqual([['sendRichMessage', reply], said(telegramId, FAILED)])
    // The reply had been made, so the command had been handled: it is the sending that was given up on.
    const line = { event: 'update', kind: 'command', command: 'products', outcome: 'failed', handled: true }
    expect(logged.events()).toEqual([
      givenUp('sendRichMessage'),
      { ...line, told: true, ms: 5_000, error: 'TimeoutError' },
    ])
  })
})
