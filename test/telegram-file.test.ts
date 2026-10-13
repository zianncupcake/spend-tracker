import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPhoto } from '../src/ai/photo'
import type { AiProvider } from '../src/ai/provider'
import { depsFor } from '../src/deps'
import { Failure } from '../src/log'
import { ChatBlockedError, TelegramError, telegramMessenger } from '../src/telegram/api'
import { saying } from './ai-helpers'
import { catchConsole } from './log-helpers'

// The fetching of a file that the bot was sent, which is two requests to Telegram: one for where the file is, and
// one for the file. The messenger posts to Telegram here as the service does, and a stand-in for Telegram keeps
// what it is asked and answers as a test has it answer. The clock is a fake one where a test waits out the 5 seconds
// that a request is given. The token, the id and the path of the file, and its bytes, are all made up.

const TOKEN = 'made-up-bot-token'
const API = `https://api.telegram.org/bot${TOKEN}/`
const DOWNLOADS = `https://api.telegram.org/file/bot${TOKEN}/`
const FILE_ID = 'made-up-file-id-AgADBAAD'
const FILE_PATH = 'photos/made-up_file_7.jpg'

const messenger = telegramMessenger(TOKEN)

/** The stand-in for Telegram. A test has it answer each request that is to be made, in their order. */
const telegram = vi.fn<(url: string, init?: RequestInit) => Response | Promise<Response>>()

beforeEach(() => {
  telegram.mockReset()
  telegram.mockImplementation(() => {
    throw new Error('A test made a request it should not have')
  })
  vi.stubGlobal('fetch', telegram)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** So many bytes, of every value that a byte has. */
function bytesOf(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, at) => (at * 7 + (at >> 8)) % 256)
}

/**
 * Telegram's answer to getFile: its File, with the size that Telegram says the file has, when it says one, and the
 * path that the file is downloaded by. A test lays `other` over it, to change the path or to leave it out.
 */
function located(size?: unknown, other: Record<string, unknown> = {}): Response {
  const file = { file_id: FILE_ID, file_unique_id: 'made-up-unique-id', file_size: size, file_path: FILE_PATH }
  return Response.json({ ok: true, result: { ...file, ...other } })
}

/** Telegram's answer to a request that it does not take, in words that quote what it was asked. */
function refused(status: number): Response {
  const description = `Bad Request: wrong file_id ${FILE_ID} at ${FILE_PATH}`
  return Response.json({ ok: false, error_code: status, description }, { status })
}

/**
 * A body that comes a stretch at a time, with what became of it: how many of its stretches were asked for, and
 * whether the reading of it was given up before its end. It is a stream of bytes, as the body of an answer is.
 */
function inStretches(stretches: Uint8Array[]) {
  const came = { asked: 0, givenUp: false }
  const body = new ReadableStream({
    type: 'bytes',
    pull(controller) {
      if (came.asked === stretches.length) return controller.close()
      // A stream of bytes takes the bytes that it is given for its own, so each stretch is given as a copy.
      controller.enqueue(stretches[came.asked++].slice())
    },
    cancel() {
      came.givenUp = true
    },
  })
  return { body, came }
}

/** Has Telegram say where the file is, with the size, and then send the bytes as the file. */
function holding(bytes: Uint8Array, size?: unknown): void {
  telegram.mockImplementationOnce(async () => located(size))
  telegram.mockImplementationOnce(async () => new Response(bytes))
}

/** What a request never answered does: it ends only when its signal does, as fetch has it end. */
function unanswered(_: string, init?: RequestInit): Promise<Response> {
  const signal = init?.signal
  return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
}

/**
 * Has the time that a request is given run by the fake clock: see test/working.test.ts. Returns the stand-in for
 * AbortSignal.timeout, which keeps the times that requests were given.
 */
function timeoutsByFakeClock() {
  vi.useFakeTimers()
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController()
    const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    setTimeout(() => controller.abort(reason), milliseconds)
    return controller.signal
  })
}

/** Fetches the file, and returns what came of it: its bytes, or what was thrown. */
function fetched(maxBytes = 400_000): Promise<unknown> {
  return messenger.file(FILE_ID, maxBytes).catch((error: unknown) => error)
}

/** The failure of a file that is too large, which says how many bytes a file may hold and nothing of the file. */
function tooLarge(maxBytes: number): Failure {
  return new Failure('file_too_large', `The file holds more than ${maxBytes} bytes`)
}

describe('a file that Telegram holds', () => {
  it('is fetched by asking where it is, and then for it: each request with its 5 seconds', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout')
    const logged = catchConsole()
    const bytes = bytesOf(70_000)
    holding(bytes, 70_000)

    const file = await messenger.file(FILE_ID, 400_000)

    // The bytes of the file, and no more of them than it holds, whatever a file may hold.
    expect(file).toBeInstanceOf(Uint8Array)
    expect(file).toHaveLength(70_000)
    expect(file).toEqual(bytes)
    expect(telegram).toHaveBeenCalledTimes(2)
    const [[asked, how], [download, downloadedHow]] = telegram.mock.calls
    // getFile is posted as every method of the API is, with the id of the file.
    expect(asked).toBe(`${API}getFile`)
    expect(how?.method).toBe('POST')
    expect(how?.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(how?.body))).toEqual({ file_id: FILE_ID })
    // The file is then had from the address that the path makes, with nothing sent but the request for it.
    expect(download).toBe(`${DOWNLOADS}${FILE_PATH}`)
    expect(Object.keys(downloadedHow ?? {})).toEqual(['signal'])
    // Each of the two came with the signal that was made for it, which ends it after 5 seconds.
    expect(timeouts.mock.calls).toEqual([[5_000], [5_000]])
    expect(how?.signal).toBe(timeouts.mock.results[0].value)
    expect(downloadedHow?.signal).toBe(timeouts.mock.results[1].value)
    // A request that Telegram takes is not logged.
    expect(logged.events()).toEqual([])
  })

  it('is put together in order, when it comes a stretch at a time', async () => {
    const bytes = bytesOf(10_000)
    const { body, came } = inStretches([bytes.subarray(0, 1), bytes.subarray(1, 4096), bytes.subarray(4096)])
    telegram.mockImplementationOnce(async () => located())
    telegram.mockImplementationOnce(async () => new Response(body))

    expect(await messenger.file(FILE_ID, 400_000)).toEqual(bytes)
    // All of it was read, to its end.
    expect(came).toEqual({ asked: 3, givenUp: false })
  })

  it('is its 0 bytes, each as it came', async () => {
    const bytes = bytesOf(0)
    holding(bytes, 0)

    const file = await messenger.file(FILE_ID, 400_000)

    expect(file).toHaveLength(0)
    expect(file).toEqual(bytes)
  })

  it('is read from the body of an answer that came through the runtime, as that of a download does', async () => {
    // No test may reach the network, so none can download anything. But the Worker itself can be asked through the
    // runtime, and what it answers comes back as the answer to any request does: with a body that the runtime made
    // of what was sent, and not one that a test made. Here it is the privacy page.
    const page = () => exports.default.fetch('https://spend-tracker.test/privacy')
    // Each page has something of its own in it, of the same length in every one. So the first page is read twice
    // over, once here in the usual way, and the second is too long for room of one byte less.
    const [first, second] = [await page(), await page()]
    const expected = new Uint8Array(await first.clone().arrayBuffer())
    expect(expected.length).toBeGreaterThan(1000)
    telegram.mockImplementationOnce(async () => located())
    telegram.mockImplementationOnce(async () => first)
    telegram.mockImplementationOnce(async () => located())
    telegram.mockImplementationOnce(async () => second)

    expect(await messenger.file(FILE_ID, 400_000)).toEqual(expected)
    expect(await fetched(expected.length - 1)).toEqual(tooLarge(expected.length - 1))
  })

  it('is no bytes, when the answer has no body at all', async () => {
    telegram.mockImplementationOnce(async () => located(0))
    telegram.mockImplementationOnce(async () => new Response(null))

    expect(await messenger.file(FILE_ID, 100)).toEqual(new Uint8Array(0))
  })
})

describe('a file of more than it may hold', () => {
  it('is refused before it is downloaded, when Telegram says its size', async () => {
    const logged = catchConsole()
    telegram.mockImplementationOnce(async () => located(400_001))

    expect(await fetched(400_000)).toEqual(tooLarge(400_000))

    // Only where the file is was asked: the file itself was not.
    expect(telegram.mock.calls.map(([url]) => url)).toEqual([`${API}getFile`])
    // A file that is too large is no request that failed, and has no line of one.
    expect(logged.events()).toEqual([])
  })

  it('is downloaded when it holds exactly as much as it may, by what Telegram says and by what comes', async () => {
    const bytes = bytesOf(4096)
    holding(bytes, 4096)

    expect(await messenger.file(FILE_ID, 4096)).toEqual(bytes)
  })

  it.each<[what: string, size: unknown]>([
    ['says nothing of its size', undefined],
    ['says that it is smaller than it is', 100],
  ])('is given up on as soon as more has come than it may hold, when Telegram %s', async (_, size) => {
    const logged = catchConsole()
    // Ten stretches of 100 bytes, of which a file may here hold 250.
    const { body, came } = inStretches(Array.from({ length: 10 }, () => bytesOf(100)))
    telegram.mockImplementationOnce(async () => located(size))
    telegram.mockImplementationOnce(async () => new Response(body))

    expect(await fetched(250)).toEqual(tooLarge(250))

    expect(telegram).toHaveBeenCalledTimes(2)
    // The reading stopped at the third stretch, with which there were more bytes than 250, and the rest was not
    // asked for.
    expect(came).toEqual({ asked: 3, givenUp: true })
    expect(logged.events()).toEqual([])
  })

  it('is given up on when it comes in one stretch that is one byte too many', async () => {
    const { body, came } = inStretches([bytesOf(251)])
    telegram.mockImplementationOnce(async () => located())
    telegram.mockImplementationOnce(async () => new Response(body))

    expect(await fetched(250)).toEqual(tooLarge(250))
    expect(came.givenUp).toBe(true)
  })
})

describe('a request for a file that Telegram refuses', () => {
  it('fails as any other request does when it is the asking where the file is, and the file is not asked for', async () => {
    const logged = catchConsole()
    telegram.mockImplementationOnce(async () => refused(400))
    telegram.mockImplementationOnce(async () => refused(403))

    expect(await fetched()).toEqual(new TelegramError('getFile', 400))
    expect(await fetched()).toEqual(new ChatBlockedError())

    expect(telegram.mock.calls.map(([url]) => url)).toEqual([`${API}getFile`, `${API}getFile`])
    expect(logged.failures()).toEqual([
      { event: 'telegram_failed', method: 'getFile', status: 400, error: 'Error', reason: 'http_error' },
      { event: 'telegram_failed', method: 'getFile', status: 403, error: 'ChatBlockedError', reason: 'chat_blocked' },
    ])
    expect(logged.events()).toHaveLength(2)
  })

  it('fails with the status of the answer when it is the download, which is logged as a method of its own', async () => {
    const logged = catchConsole()
    telegram.mockImplementationOnce(async () => located(4096))
    telegram.mockImplementationOnce(async () => new Response('Not Found', { status: 404 }))

    const error = await fetched()

    expect(error).toEqual(new TelegramError('downloadFile', 404))
    expect((error as Error).message).toBe('Telegram downloadFile failed with status 404')
    expect(logged.failures()).toEqual([
      { event: 'telegram_failed', method: 'downloadFile', status: 404, error: 'Error', reason: 'http_error' },
    ])
    expect(logged.events()).toHaveLength(1)
  })

  it.each<[what: string, answer: () => Response, line: object]>([
    ['holds a path that is not text', () => located(4096, { file_path: 7 }), { error: 'Error', reason: 'no_file_path' }],
    ['holds no file', () => Response.json({ ok: true }), { error: 'Error', reason: 'no_file_path' }],
    ['is not JSON', () => new Response(`<p>${FILE_ID}</p>`), { error: 'SyntaxError' }],
  ])('fails when what Telegram says of where the file is %s, and the file is not asked for', async (_, answer, line) => {
    const logged = catchConsole()
    telegram.mockImplementationOnce(async () => answer())

    const error = await fetched()

    expect(error).toBeInstanceOf(Error)
    expect(telegram).toHaveBeenCalledTimes(1)
    expect(logged.events()).toEqual([{ event: 'telegram_failed', method: 'getFile', status: 200, ...line }])
  })
})

describe('a request for a file that Telegram does not answer', () => {
  it('is given up on after 5 seconds of its own when it is the download', async () => {
    const timeouts = timeoutsByFakeClock()
    const logged = catchConsole()
    telegram.mockImplementationOnce(async () => located(4096))
    telegram.mockImplementationOnce(unanswered)
    const done = fetched()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(logged.events()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(await done).toMatchObject({ name: 'TimeoutError' })
    expect(timeouts.mock.calls).toEqual([[5_000], [5_000]])
    expect(logged.events()).toEqual([{ event: 'telegram_failed', method: 'downloadFile', error: 'TimeoutError' }])
  })

  /** The line of a download whose answer came, and whose body was given up on when the request's time was over. */
  const BODY_GIVEN_UP = { event: 'telegram_failed', method: 'downloadFile', status: 200, error: 'TimeoutError' }

  // The answer comes, and the first hundred bytes of the file, and then nothing. The 5 seconds are those of the
  // request, so they are over 5 seconds after the file was asked for, however much of it has come by then.

  it('is given up on after its 5 seconds when the file stops coming, as a body of a test stops', async () => {
    timeoutsByFakeClock()
    const logged = catchConsole()
    const came = { givenUp: false }
    // A body that knows nothing of the signal of its request, so nothing but the reading of it can end it.
    const body = new ReadableStream({
      type: 'bytes',
      start: (controller) => controller.enqueue(bytesOf(100)),
      cancel() {
        came.givenUp = true
      },
    })
    telegram.mockImplementationOnce(async () => located(4096))
    telegram.mockImplementationOnce(async () => new Response(body))
    const done = fetched()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(logged.events()).toEqual([])
    expect(came.givenUp).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(await done).toMatchObject({ name: 'TimeoutError' })
    expect(came.givenUp).toBe(true)
    expect(logged.events()).toEqual([BODY_GIVEN_UP])
  })

  it('is given up on after its 5 seconds when the file stops coming, as a body of the runtime stops', async () => {
    timeoutsByFakeClock()
    const logged = catchConsole()
    // A stream of the runtime's own, as the body of a real answer is: what is written at one end is read at the
    // other. A hundred bytes are written, and it is never closed.
    const { readable, writable } = new IdentityTransformStream()
    const writer = writable.getWriter()
    writer.write(bytesOf(100)).catch(() => {})
    telegram.mockImplementationOnce(async () => located(4096))
    telegram.mockImplementationOnce(async () => new Response(readable))
    const done = fetched()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(logged.events()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(await done).toMatchObject({ name: 'TimeoutError' })
    expect(logged.events()).toEqual([BODY_GIVEN_UP])
  })

  it('is given up on in the same way when it is the runtime that ends the body, as the Fetch standard has it', async () => {
    timeoutsByFakeClock()
    const logged = catchConsole()
    telegram.mockImplementationOnce(async () => located(4096))
    // The body fails with why the signal of its request ended. Whether the runtime ends one so is not what this
    // shows: no test may make a request that a runtime answers.
    telegram.mockImplementationOnce(async (_, init) => {
      const signal = init?.signal
      const body = new ReadableStream({
        type: 'bytes',
        start(controller) {
          controller.enqueue(bytesOf(100))
          signal?.addEventListener('abort', () => controller.error(signal.reason))
        },
      })
      return new Response(body)
    })
    const done = fetched()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(logged.events()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(await done).toMatchObject({ name: 'TimeoutError' })
    expect(logged.events()).toEqual([BODY_GIVEN_UP])
  })

  it('is not waited for at all, when the 5 seconds were over as the answer came', async () => {
    const logged = catchConsole()
    // A request whose time is over already: the stand-in answers it all the same, as an answer can come in the
    // moment that the time runs out.
    const over = AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(over)
    const came = { givenUp: false }
    const body = new ReadableStream({
      type: 'bytes',
      start: (controller) => controller.enqueue(bytesOf(100)),
      cancel() {
        came.givenUp = true
      },
    })
    telegram.mockImplementationOnce(async () => located(4096))
    telegram.mockImplementationOnce(async () => new Response(body))

    expect(await fetched()).toMatchObject({ name: 'TimeoutError' })
    expect(came.givenUp).toBe(true)
    expect(logged.events()).toEqual([BODY_GIVEN_UP])
  })

  it('is the file, and no failure, when its 5 seconds are over after all of it has come', async () => {
    timeoutsByFakeClock()
    const logged = catchConsole()
    const bytes = bytesOf(4096)
    holding(bytes, 4096)

    const file = await fetched()
    expect(file).toEqual(bytes)
    await vi.advanceTimersByTimeAsync(60_000)

    // Nothing is given up on then, and the bytes that were read are as they were.
    expect(file).toEqual(bytes)
    expect(logged.events()).toEqual([])
  })
})

describe('the address that a file is downloaded from, which holds the token of the bot', () => {
  const provider: AiProvider = {
    apiKey: 'made-up-ai-key',
    baseUrl: 'https://ai.example.test/v1',
    model: 'made-up-model',
    visionModel: 'made-up-vision-model',
  }
  const deps = { ...depsFor(env), messenger, now: () => new Date('2026-10-09T12:00:00+08:00') }
  const cards = [{ nickname: 'evol', categories: [] }]

  /** What is never to be seen outside a request to Telegram: the token, the address, and the file's id and path. */
  const never = [TOKEN, FILE_ID, FILE_PATH, 'made-up_file', 'api.telegram.org', 'file/bot', '/bot', 'photos/']

  it('is in nothing that the AI provider is sent with the photo, and in no line of the log', async () => {
    const logged = catchConsole()
    const bytes = bytesOf(3000)
    holding(bytes, 3000)
    const purchase = { date: '2026-10-08', amount: '12.40', currency: 'SGD', merchant: 'COFFEE PLACE', unsure: false }
    const answer = { card: null, category: null, purchases: [purchase], problem: null }
    telegram.mockImplementationOnce(async () => Response.json(saying(JSON.stringify(answer))))

    const image = await deps.messenger.file(FILE_ID, 400_000)
    const input = { image, mime: 'image/jpeg', caption: 'add these', cards, timeZone: 'Asia/Singapore' }
    const reading = await readPhoto(deps, provider, input, { requests: 0 })

    expect(reading).toMatchObject({ status: 'read', purchases: [{ amountMinor: 1240 }] })
    // The third request is the one to the provider. All that it was sent: where, with what key, and what.
    expect(telegram).toHaveBeenCalledTimes(3)
    const [url, init] = telegram.mock.calls[2]
    expect(url).toBe('https://ai.example.test/v1/chat/completions')
    const sent = [url, JSON.stringify(init?.headers), String(init?.body)].join('\n')
    // The photo that it was sent is the file, and no more of the room that the file was read into.
    expect(sent).toContain(`"data:image/jpeg;base64,${bytes.toBase64()}"`)
    for (const text of never) expect(sent).not.toContain(text)
    // One line, of the request to the provider: the two requests that Telegram took have none.
    expect(logged.events().map((event) => event.event)).toEqual(['ai_call'])
    for (const text of never) expect(logged.text()).not.toContain(text)
  })

  it('is in no line of the log when a request fails, whatever the failure says of it', async () => {
    const logged = catchConsole()
    // Telegram refuses both requests in words that quote them, and then cannot be reached for either: what fetch
    // says of that names where the request was going.
    const unreachable = (url: string) => {
      throw new TypeError(`fetch failed: ${url} could not be reached`)
    }
    telegram.mockImplementationOnce(async () => refused(400))
    telegram.mockImplementationOnce(async () => located(3000))
    telegram.mockImplementationOnce(async () => refused(404))
    telegram.mockImplementationOnce(unreachable)
    telegram.mockImplementationOnce(async () => located(3000))
    telegram.mockImplementationOnce(unreachable)
    telegram.mockImplementationOnce(async () => located(3001))
    telegram.mockImplementationOnce(async () => located(3000, { file_path: undefined }))

    const errors = []
    for (let time = 1; time <= 6; time++) errors.push(await fetched(3000))

    expect(telegram).toHaveBeenCalledTimes(8)
    expect(logged.events()).toEqual([
      { event: 'telegram_failed', method: 'getFile', status: 400, error: 'Error', reason: 'http_error' },
      { event: 'telegram_failed', method: 'downloadFile', status: 404, error: 'Error', reason: 'http_error' },
      { event: 'telegram_failed', method: 'getFile', error: 'TypeError' },
      { event: 'telegram_failed', method: 'downloadFile', error: 'TypeError' },
      { event: 'telegram_failed', method: 'getFile', status: 200, error: 'Error', reason: 'no_file_path' },
    ])
    for (const text of [...never, 'https:', 'fetch failed', 'Bad Request', 'wrong file_id']) {
      expect(logged.text()).not.toContain(text)
    }
    // Of what was thrown, the errors that are made here say nothing of the file or of where it is: its caller logs
    // them. Only what fetch itself threw quotes the address, and no line has the words of an error.
    const own = errors.filter((error) => error instanceof Failure)
    expect(own).toHaveLength(4)
    for (const error of own) for (const text of never) expect(error.message).not.toContain(text)
  })
})
