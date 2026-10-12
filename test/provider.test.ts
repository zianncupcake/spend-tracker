import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { complete, completeJson, ProviderError, type AiProvider, type ChatMessage, type Tool } from '../src/ai/provider'
import { depsFor } from '../src/deps'
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
    // One of the four reasons that the log has a word for. The tests of this file have each of the other three.
    ['content_filter', 'content_filter'],
    // What the answer says is text from outside. Whatever is none of the four is logged as that it was another.
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

describe('what a question sends', () => {
  // Written out as it was sent before a request could hold a photo, so that a change to it shows here.
  const BODY =
    '{"model":"made-up-model","messages":[{"role":"system","content":"Made-up instructions for the model."},' +
    '{"role":"user","content":"How much did I spend at COFFEE PLACE?"},' +
    '{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":' +
    '{"name":"get_spending_summary","arguments":"{}"}}]},' +
    '{"role":"tool","tool_call_id":"call_1","name":"get_spending_summary","content":"{\\"cards\\":[]}"}],' +
    '"tools":[{"type":"function","function":{"name":"get_spending_summary","description":"Made up.",' +
    '"parameters":{"type":"object","properties":{}}}}],"tool_choice":"auto","max_completion_tokens":1024}'

  it('is byte for byte what it was, on a service that reads photos too', async () => {
    const called = { name: 'get_spending_summary', arguments: '{}' }
    const conversation: ChatMessage[] = [
      ...messages,
      // As the assistant sends back a message of the model's that had no text: with its content undefined.
      { role: 'assistant', content: undefined, tool_calls: [{ id: 'call_1', type: 'function', function: called }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_spending_summary', content: '{"cards":[]}' },
    ]
    answering(saying(ANSWER))
    catchConsole()

    await complete({ ...provider, visionModel: 'made-up-vision-model' }, conversation, tools, 20_000)

    expect(posted).toHaveBeenCalledTimes(1)
    const [url, init] = posted.mock.calls[0]
    expect(url).toBe('https://ai.example.test/v1/chat/completions')
    expect(init?.body).toBe(BODY)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ authorization: 'Bearer made-up-ai-key', 'content-type': 'application/json' })
    // The request is the address, and these four things: the last is what gives it up when its time is over.
    expect(Object.keys(init ?? {}).sort()).toEqual(['body', 'headers', 'method', 'signal'])
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('a request for JSON, which can hold an image', () => {
  const CAPTION = 'add these to evol as bus/mrt'
  /** The first ten bytes of a JPEG file, as the address of an image that holds them. */
  const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  const READING = '{"card": "evol", "purchases": [{"amount": "12.40", "merchant": "COFFEE PLACE"}]}'

  const reading: ChatMessage[] = [
    { role: 'system', content: 'Made-up instructions for the model.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: CAPTION },
        { type: 'image_url', image_url: { url: PHOTO } },
      ],
    },
  ]

  /** Asks the model that reads photos, and returns what came of it: its message, or what was thrown. */
  function askForJson(timeout = 20_000) {
    return completeJson(provider, 'made-up-vision-model', reading, 300, timeout, 0.5).catch((error: unknown) => error)
  }

  it('is posted with the model that is named, the image beside its text, and the most that may be written', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout')
    answering(saying(READING))
    catchConsole()

    expect(await askForJson(1234)).toEqual({ content: READING, toolCalls: [], cutShort: false })

    expect(posted).toHaveBeenCalledTimes(1)
    const [url, init] = posted.mock.calls[0]
    expect(url).toBe('https://ai.example.test/v1/chat/completions')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ authorization: 'Bearer made-up-ai-key', 'content-type': 'application/json' })
    // All of it: the answer is to be JSON, and no tools are offered, so nothing says how to choose among any.
    expect(init?.body).toBe(
      '{"model":"made-up-vision-model","messages":[{"role":"system","content":"Made-up instructions for the model."},' +
        '{"role":"user","content":[{"type":"text","text":"add these to evol as bus/mrt"},' +
        '{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,/9j/4AAQSkZJRg=="}}]}],' +
        '"response_format":{"type":"json_object"},"max_completion_tokens":300,"temperature":0.5}',
    )
    expect(timeouts.mock.calls).toEqual([[1234]])
    expect(init?.signal).toBe(timeouts.mock.results[0].value)
  })

  it('is logged as a request of the assistant is, however it ends, with nothing of the image or of the answer', async () => {
    answering(saying(READING), 900)
    // An answer that ran into the most that may be written, and so ends wherever that fell.
    answering(saying(READING.slice(0, 40), 'length'), 2100)
    posted.mockImplementationOnce(async () => {
      clock += 300
      return refusing(429, `Rate limit reached. Your request was: ${CAPTION} ${PHOTO}`, { 'retry-after': '7.66' })()
    })
    posted.mockImplementationOnce(refusing(413, `Request too large: ${PHOTO}`))
    posted.mockImplementationOnce(async () => {
      throw new TypeError(`A made-up failure of the network that quotes: ${CAPTION} ${PHOTO}`)
    })
    const logged = catchConsole()

    expect(await askForJson()).toEqual({ content: READING, toolCalls: [], cutShort: false })
    expect(await askForJson()).toEqual({ content: READING.slice(0, 40), toolCalls: [], cutShort: true })
    expect(await askForJson()).toEqual(new ProviderError(429, 7.66))
    expect(await askForJson()).toEqual(new ProviderError(413))
    expect(await askForJson()).toBeInstanceOf(TypeError)

    const counted = { tool_calls: 0, prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    expect(logged.events()).toEqual([
      { event: 'ai_call', ms: 900, status: 200, finish: 'stop', ...counted },
      { event: 'ai_call', ms: 2100, status: 200, finish: 'length', ...counted },
      { event: 'ai_call', ms: 300, status: 429, retry_after: 7.66, error: 'Error', reason: 'http_error' },
      { event: 'ai_call', ms: 0, status: 413, error: 'Error', reason: 'http_error' },
      { event: 'ai_call', ms: 0, error: 'TypeError' },
    ])
    const never = [CAPTION, 'bus/mrt', PHOTO, '/9j/', 'data:image', 'base64', READING, 'COFFEE', '12.40', 'evol']
    for (const text of [...never, provider.apiKey, 'made-up-vision-model', 'Rate limit', 'too large', 'instructions']) {
      expect(logged.text()).not.toContain(text)
    }
  })

  it('is given up on when the provider takes longer than it is given', async () => {
    // A provider that never answers. The request ends as it does for fetch: it fails with why it was ended.
    posted.mockImplementationOnce((_, init) => {
      const signal = init?.signal
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
    })
    const logged = catchConsole()

    expect(await askForJson(5)).toMatchObject({ name: 'TimeoutError' })

    expect(logged.events()).toEqual([{ event: 'ai_call', ms: 0, error: 'TimeoutError' }])
  })
})

describe('the model that reads photos, as the service is set up', () => {
  // The tests are set up with a key and nothing else: see vitest.config.ts.
  const GROQ = { apiKey: 'test-ai-key', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' }
  const OWN = { ...env, AI_BASE_URL: 'https://ai.example.test/v1', AI_MODEL: 'made-up-model' }

  it('is the default one, at the default address, when neither is set', () => {
    const reading = { ...GROQ, visionModel: 'qwen/qwen3.8-27b' }

    expect(depsFor(env).ai).toEqual(reading)
    // A setting that is left empty counts as one that is not set.
    expect(depsFor({ ...env, AI_BASE_URL: '', AI_VISION_MODEL: '' }).ai).toEqual(reading)
    // The model that answers questions is another setting, and changes nothing of this one.
    expect(depsFor({ ...env, AI_MODEL: 'made-up-model' }).ai?.visionModel).toBe('qwen/qwen3.8-27b')
  })

  it('is none at an address that the service names, where the name of the default one means nothing', () => {
    const { ai } = depsFor(OWN)

    expect(ai).toEqual({ apiKey: 'test-ai-key', baseUrl: 'https://ai.example.test/v1', model: 'made-up-model' })
    expect(ai?.visionModel).toBeUndefined()
    expect(depsFor({ ...OWN, AI_VISION_MODEL: '' }).ai?.visionModel).toBeUndefined()
    // The default address counts as one that the service names, when it is the service that names it.
    expect(depsFor({ ...env, AI_BASE_URL: GROQ.baseUrl }).ai?.visionModel).toBeUndefined()
  })

  it('is the one that is named, at either address', () => {
    const named = { AI_VISION_MODEL: 'made-up-vision-model' }

    expect(depsFor({ ...OWN, ...named }).ai).toEqual({
      apiKey: 'test-ai-key',
      baseUrl: 'https://ai.example.test/v1',
      model: 'made-up-model',
      visionModel: 'made-up-vision-model',
    })
    expect(depsFor({ ...env, ...named }).ai).toEqual({ ...GROQ, visionModel: 'made-up-vision-model' })
  })

  it.each([undefined, ''])('is none, as the provider is, when the key is %j', (key) => {
    expect(depsFor({ ...env, AI_API_KEY: key, AI_VISION_MODEL: 'made-up-vision-model' }).ai).toBeUndefined()
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
