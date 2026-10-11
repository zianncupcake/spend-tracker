import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { complete, ProviderError, type AiProvider, type ChatMessage, type Tool } from '../src/ai/provider'
import { Failure } from '../src/log'
import { calling, refusing, saying } from './ai-helpers'
import { catchConsole } from './log-helpers'

// What the log has of a request to the AI provider. How a question is answered with what the model writes is
// tested in test/assistant.test.ts. Every key, question, answer and merchant here is made up.

const provider: AiProvider = { apiKey: 'made-up-ai-key', baseUrl: 'https://ai.example.test/v1', model: 'made-up-model' }

const QUESTION = 'How much did I spend at COFFEE PLACE?'
const ANSWER = 'You spent SGD 12.40 at COFFEE PLACE.'

const messages: ChatMessage[] = [
  { role: 'system', content: 'Made-up instructions for the model.' },
  { role: 'user', content: QUESTION },
]

const tools: Tool[] = [
  {
    type: 'function',
    function: { name: 'get_spending_summary', description: 'Made up.', parameters: { type: 'object', properties: {} } },
  },
]

// The provider is reached with the global fetch. It is replaced here, as test/oauth.test.ts does for Google, so
// nothing is sent to a provider.
const posted = vi.fn<(url: string, init?: RequestInit) => Response | Promise<Response>>()

/** What the Worker's clock shows, in milliseconds. It moves on while the provider answers, and at no other time. */
let clock = 0

beforeEach(() => {
  posted.mockReset()
  vi.stubGlobal('fetch', posted)
  clock = Date.parse('2026-10-09T12:00:00+08:00')
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Has the provider answer the next request with the body, as JSON, after so many milliseconds. */
function answering(body: unknown, milliseconds = 0): void {
  posted.mockImplementationOnce(async () => {
    clock += milliseconds
    return Response.json(body)
  })
}

/** Asks the model, and returns what came of it: its message, or what was thrown. */
function ask(timeout = 20_000) {
  return complete(provider, messages, tools, timeout).catch((error: unknown) => error)
}

describe('a request that the model answers', () => {
  it('is logged with how long it took, its status, why the model stopped, and what the provider counted', async () => {
    answering(saying(ANSWER), 1250)
    const logged = catchConsole()

    expect(await ask()).toEqual({ content: ANSWER, toolCalls: [], cutShort: false })

    expect(logged.events()).toEqual([
      {
        event: 'ai_call',
        ms: 1250,
        status: 200,
        finish: 'stop',
        tool_calls: 0,
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      },
    ])
  })

  it('is logged with how many tools the model called, and with nothing of the calls', async () => {
    answering(calling(['call_1', 'get_spending_summary'], ['call_2', 'list_transactions', { card: 'evol' }]), 480)
    const logged = catchConsole()

    expect(await ask()).toMatchObject({ content: '', toolCalls: [{ id: 'call_1' }, { id: 'call_2' }] })

    expect(logged.events()).toMatchObject([{ event: 'ai_call', ms: 480, finish: 'tool_calls', tool_calls: 2 }])
    for (const text of ['call_1', 'list_transactions', 'evol']) expect(logged.text()).not.toContain(text)
  })

  it.each<[said: unknown, logged: string | null]>([
    ['stop', 'stop'],
    ['length', 'length'],
    ['tool_calls', 'tool_calls'],
    ['content_filter', 'content_filter'],
    // What the answer says is text from outside. Whatever is none of the four is logged as that it was another.
    ['function_call', 'other'],
    ['a made-up reason that quotes COFFEE PLACE', 'other'],
    [42, 'other'],
    [null, null],
    [undefined, null],
  ])('is logged with the reason %j for stopping as %j', async (said, finish) => {
    answering({ choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: said }] })
    const logged = catchConsole()

    await ask()

    expect(logged.events()).toEqual([{ event: 'ai_call', ms: 0, status: 200, finish, tool_calls: 0 }])
  })

  it.each<[what: string, usage: unknown, counted: object]>([
    ['is not there', undefined, {}],
    ['is null', null, {}],
    ['is text', 'COFFEE PLACE', {}],
    ['holds what is not a number', { prompt_tokens: '100', completion_tokens: null, total_tokens: 'COFFEE PLACE' }, {}],
    ['holds only the total', { total_tokens: 120, total_time: 0.5 }, { total_tokens: 120 }],
  ])('is logged with only the counts that are numbers, when the usage %s', async (_, usage, counted) => {
    answering({ ...saying(ANSWER), usage })
    const logged = catchConsole()

    await ask()

    const [event, ...more] = logged.events()
    expect(more).toEqual([])
    expect(event).toEqual({ event: 'ai_call', ms: 0, status: 200, finish: 'stop', tool_calls: 0, ...counted })
  })
})

describe('a request that fails', () => {
  it('is logged with the status of an answer that was an error, and with how long it said to wait', async () => {
    posted.mockImplementationOnce(async () => {
      clock += 300
      return refusing(429, QUESTION, { 'retry-after': '7.66' })()
    })
    posted.mockImplementationOnce(refusing(500, QUESTION))
    const logged = catchConsole()

    expect(await ask()).toEqual(new ProviderError(429, 7.66))
    expect(await ask()).toEqual(new ProviderError(500))

    expect(logged.events()).toEqual([
      { event: 'ai_call', ms: 300, status: 429, retry_after: 7.66, error: 'Error', reason: 'http_error' },
      { event: 'ai_call', ms: 0, status: 500, error: 'Error', reason: 'http_error' },
    ])
  })

  it('is logged with the name of what fetch threw, and with no status, when the provider did not answer', async () => {
    posted.mockImplementationOnce(async () => {
      clock += 40
      throw new TypeError(`A made-up failure of the network that quotes: ${QUESTION}`)
    })
    const logged = catchConsole()

    expect(await ask()).toBeInstanceOf(TypeError)

    expect(logged.events()).toEqual([{ event: 'ai_call', ms: 40, error: 'TypeError' }])
  })

  it('is logged as timed out when the provider takes longer than it is given', async () => {
    // A provider that never answers. The request ends as it does for fetch: it fails with why it was ended.
    posted.mockImplementationOnce(
      (_, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            clock += 20_000
            reject(init.signal?.reason)
          })
        }),
    )
    const logged = catchConsole()

    expect(await ask(5)).toMatchObject({ name: 'TimeoutError' })

    expect(logged.events()).toEqual([{ event: 'ai_call', ms: 20_000, error: 'TimeoutError' }])
  })

  it('is logged with its status and the name of the error, when the answer is not JSON', async () => {
    posted.mockImplementationOnce(async () => new Response(`<p>${QUESTION}</p>`))
    const logged = catchConsole()

    expect(await ask()).toBeInstanceOf(SyntaxError)

    expect(logged.events()).toEqual([{ event: 'ai_call', ms: 0, status: 200, error: 'SyntaxError' }])
  })

  it.each<[what: string, completion: object, seen: object, thrown: Failure]>([
    [
      'holds no message',
      { choices: [{ index: 0, finish_reason: 'stop' }], usage: { total_tokens: 120 } },
      { finish: 'stop', tool_calls: 0, total_tokens: 120, reason: 'no_message' },
      new Failure('no_message', 'AI provider returned no message'),
    ],
    [
      'holds no choice',
      { choices: [] },
      { finish: null, tool_calls: 0, reason: 'no_message' },
      new Failure('no_message', 'AI provider returned no message'),
    ],
    [
      'holds a call of a tool that cannot be read',
      { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [null, { id: 'call_2' }] } }] },
      { finish: 'tool_calls', tool_calls: 2, reason: 'bad_tool_call' },
      new Failure('bad_tool_call', 'AI provider returned a tool call that cannot be read'),
    ],
  ])('is logged with what was learnt of the answer, and with why, when it %s', async (_, body, seen, thrown) => {
    answering(body, 75)
    const logged = catchConsole()

    expect(await ask()).toEqual(thrown)

    expect(logged.events()).toEqual([{ event: 'ai_call', ms: 75, status: 200, ...seen, error: 'Error' }])
  })
})

describe('what is asked and what is answered', () => {
  it('is in no line: not the question, the answer, the key, or what an error says of them', async () => {
    const logged = catchConsole()
    answering(calling(['call_1', 'list_transactions', { card: 'evol', from: '2026-10-01' }]))
    answering(saying(ANSWER))
    posted.mockImplementationOnce(refusing(401, `Invalid API Key: ${provider.apiKey}`))
    posted.mockImplementationOnce(refusing(429, `Rate limit reached. Your request was: ${QUESTION}`))
    posted.mockImplementationOnce(async () => new Response(`${QUESTION} ${ANSWER}`))
    posted.mockImplementationOnce(async () => {
      throw new Error(`A made-up error that quotes its request: ${QUESTION} ${provider.apiKey}`)
    })

    for (let request = 1; request <= 6; request++) await ask()

    // The six requests were all posted with the question and the key, and each has its one line.
    expect(posted).toHaveBeenCalledTimes(6)
    for (const [, init] of posted.mock.calls) {
      expect(String(init?.body)).toContain(QUESTION)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${provider.apiKey}`)
    }
    expect(logged.events().map((event) => [event.event, event.status])).toEqual([
      ['ai_call', 200],
      ['ai_call', 200],
      ['ai_call', 401],
      ['ai_call', 429],
      ['ai_call', 200],
      ['ai_call', undefined],
    ])
    const never = [QUESTION, ANSWER, 'COFFEE PLACE', '12.40', provider.apiKey, 'instructions', 'evol', '2026-10-01']
    for (const text of [...never, provider.model, provider.baseUrl, 'Rate limit', 'Invalid API Key']) {
      expect(logged.text()).not.toContain(text)
    }
  })
})
