import { describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../src/ai/provider'
import { GrantLostError } from '../src/google/gmail'
import { GoogleError } from '../src/google/oauth'
import { Failure, log, logFailure } from '../src/log'
import { ChatBlockedError, TelegramError } from '../src/telegram/api'
import { catchConsole } from './log-helpers'

// The service's log: what a line of it is, and how much of an error goes into one. Every value here is made up.

/** What a merchant, a mailbox, a question and a token would look like, were any of them ever to reach a line. */
const PRIVATE = ['COFFEE PLACE', 'jane@example.test', 'How much did I spend?', 'made-up-refresh-token']

/** An error that is not this codebase's own, and that says which HTTP status it was thrown for. */
class Refused extends Error {
  constructor(readonly status: number) {
    super(`A made-up refusal that quotes its request: ${PRIVATE[0]}`)
  }
}

describe('a line of the log', () => {
  it('is one line of JSON, written once with console.log: the name of its event, and then its fields', () => {
    const written = vi.spyOn(console, 'log').mockImplementation(() => {})
    const asError = vi.spyOn(console, 'error').mockImplementation(() => {})

    log('connect_code', { user: 7, outcome: 'wrong', tries_left: 3 })

    expect(written.mock.calls).toEqual([['{"event":"connect_code","user":7,"outcome":"wrong","tries_left":3}']])
    // It is the line of no failure, so nothing is written at the level of an error.
    expect(asError).not.toHaveBeenCalled()
  })

  it('leaves out a field that is undefined, and keeps one that is null, false or nothing', () => {
    const logged = catchConsole()

    log('connect_callback', { outcome: 'expired', user: undefined })
    log('check_failed', { stage: 'take', user: null })
    log('access_lost', { user: 7, told: false })
    log('ai_call', { ms: 0, finish: null, tool_calls: 0 })

    expect(logged.text().split('\n')).toEqual([
      '{"event":"connect_callback","outcome":"expired"}',
      '{"event":"check_failed","stage":"take","user":null}',
      '{"event":"access_lost","user":7,"told":false}',
      '{"event":"ai_call","ms":0,"finish":null,"tool_calls":0}',
    ])
  })
})

describe('the line of a failure', () => {
  it('is one line of JSON too, written once with console.error: the class name of the error comes after its fields', () => {
    const written = vi.spyOn(console, 'error').mockImplementation(() => {})
    const asLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    logFailure('check_failed', new TypeError('A made-up failure of the network'), { stage: 'list', user: 7 })

    // Written so, Cloudflare has the line at the level of an error, and has it once.
    expect(written.mock.calls).toEqual([['{"event":"check_failed","stage":"list","user":7,"error":"TypeError"}']])
    expect(asLog).not.toHaveBeenCalled()
  })

  it('is told from every other line by its level, whatever the event and whatever came of it', () => {
    const logged = catchConsole()

    log('token_revoke', { outcome: 'revoked' })
    logFailure('token_revoke', new Error('made up'), { outcome: 'failed' })
    // What an event says came of it does not make its line that of a failure: an error does.
    log('mcp_tool', { user: 7, tool: 'list_transactions', outcome: 'invalid', ms: 3 })
    logFailure('mcp_tool', new Error('made up'), { user: 7, tool: 'list_transactions', outcome: 'failed', ms: 3 })

    expect(logged.events().map((event) => event.outcome)).toEqual(['revoked', 'failed', 'invalid', 'failed'])
    expect(logged.failures()).toEqual([
      { event: 'token_revoke', outcome: 'failed', error: 'Error' },
      { event: 'mcp_tool', user: 7, tool: 'list_transactions', outcome: 'failed', ms: 3, error: 'Error' },
    ])
  })

  it('has nothing else of an error from outside: not its message, its stack, its cause or what it holds', () => {
    const logged = catchConsole()
    const error = Object.assign(new RangeError(`A made-up error that quotes its input: ${PRIVATE.join(', ')}`), {
      cause: new Error(PRIVATE[0]),
      reason: PRIVATE[1],
      status: PRIVATE[2],
      code: PRIVATE[3],
    })

    logFailure('token_revoke', error, { outcome: 'failed' })

    expect(logged.events()).toEqual([{ event: 'token_revoke', outcome: 'failed', error: 'RangeError' }])
    for (const text of PRIVATE) expect(logged.text()).not.toContain(text)
  })

  it('has the reason of an error that this codebase threw, and still not its message', () => {
    const logged = catchConsole()

    logFailure('check_failed', new Failure('no_date', `Made up, about ${PRIVATE[0]}`), { stage: 'read', user: 7 })
    logFailure('check_failed', new GrantLostError(), { stage: 'token', user: 7 })
    logFailure('check_failed', new ChatBlockedError(), { stage: 'notify', user: 7 })

    expect(logged.events()).toEqual([
      { event: 'check_failed', stage: 'read', user: 7, error: 'Error', reason: 'no_date' },
      { event: 'check_failed', stage: 'token', user: 7, error: 'GrantLostError', reason: 'grant_lost' },
      { event: 'check_failed', stage: 'notify', user: 7, error: 'ChatBlockedError', reason: 'chat_blocked' },
    ])
    expect(logged.text()).not.toContain(PRIVATE[0])
  })

  it.each<[whose: string, error: Error, reason: object]>([
    ["Google's", new GoogleError('Gmail list request', 503), { reason: 'http_error' }],
    ["the AI provider's", new ProviderError(503, 30), { reason: 'http_error' }],
    ["Telegram's", new TelegramError('sendMessage', 503), { reason: 'http_error' }],
    // An error of somebody else's has its status logged too, when that is the status of an HTTP answer: see the
    // test after this one for what is not. It has no reason, as it is none of this codebase's.
    ["somebody else's", new Refused(503), {}],
  ])('has the HTTP status that the error holds, when it is %s for an answer that was an error', (_, error, reason) => {
    const logged = catchConsole()

    logFailure('check_failed', error, { stage: 'notify', user: 7 })

    expect(logged.events()).toEqual([
      { event: 'check_failed', stage: 'notify', user: 7, error: 'Error', ...reason, status: 503 },
    ])
    expect(logged.text()).not.toContain(PRIVATE[0])
  })

  it.each([100, 200, 404, 599])('has the status %i of an error, which is one that an HTTP answer has', (status) => {
    const logged = catchConsole()

    logFailure('token_revoke', new Refused(status), { outcome: 'failed' })

    expect(logged.events()).toEqual([{ event: 'token_revoke', outcome: 'failed', error: 'Error', status }])
  })

  it.each<[what: string, status: unknown]>([
    ['a number as long as an id of Telegram’s', 6591234567],
    ['the sixteen digits of a card', 4242424242424242],
    ['a number below 100', 99],
    ['a number above 599', 600],
    ['zero', 0],
    ['a status with a minus before it', -503],
    ['a status and a half', 503.5],
    ['what is not a number', Number.NaN],
    ['a number without end', Number.POSITIVE_INFINITY],
    ['a status as text', '503'],
    ['a status as a big integer', 503n],
    ['a status inside an object', { valueOf: () => 503, merchant: PRIVATE[0] }],
    ['a status inside a list', [503]],
    ['true', true],
    ['null', null],
  ])('has no status of an error that holds %s for one: only a whole number from 100 to 599 is one', (_, status) => {
    const logged = catchConsole()

    logFailure('token_revoke', Object.assign(new Error('made up'), { status }), { outcome: 'failed' })

    // The line is whole, and as it is written it has nothing of what the error held.
    expect(logged.text()).toBe('{"event":"token_revoke","outcome":"failed","error":"Error"}')
  })

  it('has the status that its event was given, when the error holds none, or holds what is none', () => {
    const logged = catchConsole()

    logFailure('ai_call', new SyntaxError('Unexpected token'), { ms: 12, status: 200 })
    logFailure('ai_call', new ProviderError(429), { ms: 12, status: 429 })
    logFailure('ai_call', new Refused(6591234567), { ms: 12, status: 200 })

    expect(logged.text().split('\n')).toEqual([
      '{"event":"ai_call","ms":12,"status":200,"error":"SyntaxError"}',
      '{"event":"ai_call","ms":12,"status":429,"error":"Error","reason":"http_error"}',
      '{"event":"ai_call","ms":12,"status":200,"error":"Error"}',
    ])
  })

  it.each<[what: string, thrown: unknown, name: string]>([
    ['text', PRIVATE[0], 'string'],
    ['a number', 4242, 'number'],
    ['nothing', undefined, 'undefined'],
    ['null', null, 'object'],
    ['an object that is no error', { name: PRIVATE[0], message: PRIVATE[1], reason: 'no_date' }, 'object'],
  ])('names what was thrown by its type, and writes nothing of it, when it is %s', (_, thrown, name) => {
    const logged = catchConsole()

    logFailure('token_revoke', thrown, { outcome: 'failed' })

    expect(logged.events()).toEqual([{ event: 'token_revoke', outcome: 'failed', error: name }])
  })

  it.each([PRIVATE[0], PRIVATE[1], 'Error: made up', '4242424242424242', '', 'x'.repeat(41)])(
    'takes no name for a class name that is not letters alone: "%s" is logged as Error',
    (name) => {
      const logged = catchConsole()

      logFailure('token_revoke', Object.assign(new Error('made up'), { name }), { outcome: 'failed' })

      expect(logged.events()).toEqual([{ event: 'token_revoke', outcome: 'failed', error: 'Error' }])
    },
  )

  it.each<[what: string, name: unknown]>([
    // Each of the first four reads as letters alone when it is made into text, which is what a pattern does to it.
    ['an object that reads as a word', { toString: () => 'Letters', merchant: PRIVATE[0] }],
    ['an object that says what it is written as', { toString: () => 'Letters', toJSON: () => PRIVATE[0] }],
    ['a list of one word', ['Letters']],
    ['a word that is an object', new String('Letters')],
    ['nothing', undefined],
    ['null', null],
    ['a number', 4242],
    ['a function', () => 'Letters'],
    // And a symbol is made into no text at all: to try is to throw.
    ['a symbol', Symbol('Letters')],
  ])('takes no name that is not text: an error whose name is %s is logged as Error, and nothing fails', (_, name) => {
    const logged = catchConsole()
    const error = Object.assign(new Error('made up'), { name })

    // It is called where an error was caught, and is not to throw another from there.
    expect(() => logFailure('token_revoke', error, { outcome: 'failed' })).not.toThrow()

    // The line is whole, and as it is written it has nothing of what the name held.
    expect(logged.text()).toBe('{"event":"token_revoke","outcome":"failed","error":"Error"}')
  })
})

describe('what the compiler takes for a line', () => {
  it('is an event that there is, with the fields of that event and no others, each with a word of its own', () => {
    /** Never called. Each line of it is one that the compiler refuses, which `npm run typecheck` checks. */
    function refused(merchant: string, chatId: number, purchase: { merchant: string; amountMinor: number }): void {
      // @ts-expect-error: there is no such event
      log('message', { text: merchant })
      // @ts-expect-error: text from outside is none of the words that an outcome can be
      log('alert', { outcome: merchant, parser: null })
      // @ts-expect-error: nor is it the name of a parser
      log('alert', { outcome: 'stored', parser: merchant })
      // @ts-expect-error: a word of another field is no word of this one
      log('alert', { outcome: 'ocbc', parser: null })
      // @ts-expect-error: a field that takes a number takes no text
      log('connect_link', { user: merchant })
      // @ts-expect-error: a field that an event has is not left out
      log('access_lost', { user: 7 })
      // @ts-expect-error: an event has the fields that are listed for it, and a merchant is none of them
      log('alert', { outcome: 'stored', parser: 'ocbc', merchant })
      // @ts-expect-error: neither is a chat, though its id is a number
      log('connect_link', { user: 7, chat: chatId })
      // @ts-expect-error: nor do the fields of something else come in with those of the event
      log('alert', { outcome: 'stored', parser: 'ocbc', ...purchase })
      const together = { outcome: 'stored' as const, parser: null, ...purchase }
      // @ts-expect-error: not when they were put together beforehand, either
      log('alert', together)
      // @ts-expect-error: the line of a failure is held to the same words
      logFailure('token_revoke', new Error(), { outcome: merchant })
      // @ts-expect-error: and to the same fields
      logFailure('token_revoke', new Error(), { outcome: 'failed', ...purchase })
      // @ts-expect-error: and the reason of an error is one of the reasons that there are
      new Failure(merchant)
      // @ts-expect-error: a command is one of the names that the bot knows its commands by, and never what was sent
      log('update', { kind: 'command', command: merchant, outcome: 'replied', ms: 1 })
      // @ts-expect-error: an update has no field for the chat that it came from
      log('update', { kind: 'press', outcome: 'replied', ms: 1, chat: chatId })
      // @ts-expect-error: a request to Telegram is known by one of the methods that the bot calls
      log('telegram_failed', { method: merchant })
      // @ts-expect-error: and a tool by one of the names that the bot has for its tools, whatever a model calls it
      log('assistant_tool', { user: 7, tool: merchant, outcome: 'invalid', ms: 1 })
    }

    expect(refused).toBeTypeOf('function')
  })
})
