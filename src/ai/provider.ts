// Asking a model for the next message of a conversation, through a chat completions API of the kind that OpenAI
// has. Any provider with such an API will do. Groq's is the one that this was written against:
// https://console.groq.com/docs/api-reference#chat-create
// https://console.groq.com/docs/tool-use
// https://console.groq.com/docs/rate-limits

import { Failure, log, logFailure, type Events } from '../log'

/** Where the provider is reached, and the model that is asked there, when the service is set up with neither. */
export const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1'
export const DEFAULT_MODEL = 'openai/gpt-oss-120b'

/**
 * The model that reads photos, when the service is set up with none and is left at the default address. Groq lists
 * it as a preview model, which is one that it may withdraw at short notice.
 */
export const DEFAULT_VISION_MODEL = 'qwen/qwen3.8-27b'

/**
 * The most tokens that the model may write in one message, with those of its reasoning counted among them. A
 * message is the call of a tool or a brief answer. An answer of more would not fit a message of Telegram's anyway.
 */
const MAX_COMPLETION_TOKENS = 1024

/** The AI provider that the assistant's answers are asked of, as the service is set up with it. */
export interface AiProvider {
  apiKey: string
  /** The key of a second account at the same provider, asked once more when the first's answers 429. */
  fallbackApiKey?: string
  /** Where its API is reached, with no trailing slash: what /chat/completions comes after. */
  baseUrl: string
  model: string
  /** The model that reads photos. Undefined on a service that reads none. */
  visionModel?: string
}

/**
 * A tool as the model is offered it: a function by its name, with what it does and the JSON Schema of what it
 * takes.
 */
export interface Tool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** The model's call of a tool. Its arguments are JSON in a string, as the model wrote it. */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * A part of a user's message that holds more than text: its text, or an image by its address. An address can be a
 * data URL, which holds the image itself.
 */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/**
 * A message of a conversation, as the API has it. The model's own message is sent back to it as one that calls
 * tools, or as the text of an earlier reply. What each tool answered follows its call, under the id of the call. A
 * user's message that holds an image is made of parts.
 */
export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'user'; content: ContentPart[] }
  | { role: 'assistant'; content?: string; tool_calls: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string }

/** What the model replied with: the tools that it wants called, or else its answer in `content`. */
export interface ModelReply {
  /** Empty when the model wrote no text. */
  content: string
  toolCalls: ToolCall[]
  /** Whether the message ran into the limit on its length, and so ends wherever that fell. */
  cutShort: boolean
}

/** The parts of the provider's response this service reads. All optional, because it arrives as unchecked JSON. */
interface CompletionResponse {
  choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown } }[]
  /** The provider's count of the tokens of the request, of the model's message, and of the two together. */
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
}

/** Why a model stopped writing, as the API says it. Anything else that an answer says of that is logged as `other`. */
const FINISHES = ['stop', 'length', 'tool_calls', 'content_filter'] as const

/** What the log has of one request to the provider, but for how long the request took. */
type Seen = Omit<Events['ai_call'], 'ms'>

/**
 * The provider answered a request with an error: `status` is the HTTP status of its answer. 429 is what it answers
 * when it has had as many requests, or as many tokens, as it takes for now. `retryAfter` is how long its answer
 * said to wait before it is asked again, in seconds and more than zero, when it said. It has the name of a plain
 * Error.
 */
export class ProviderError extends Failure {
  constructor(
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super('http_error', `AI provider request failed with status ${status}`)
  }
}

/**
 * Asks the model for the next message of the conversation, with the tools it may call. Throws a ProviderError when
 * the provider answers with an error, and what fetch throws when it has not answered within `timeout` milliseconds.
 * Every request is logged, however it ends: with how long it took and with what was learnt of the answer, and with
 * nothing of what was asked or of what the model wrote.
 */
export async function complete(
  provider: AiProvider,
  messages: ChatMessage[],
  tools: Tool[],
  timeout: number,
): Promise<ModelReply> {
  return request(
    provider,
    { model: provider.model, messages, tools, tool_choice: 'auto', max_completion_tokens: MAX_COMPLETION_TOKENS },
    timeout,
  )
}

/**
 * Asks `model` for one message that is JSON, and offers it no tools: the answer is the reply's `content`, which is
 * still to be parsed. `maxTokens` is the most tokens that the model may write. The messages can hold an image, for a
 * model that reads one. It throws what `complete` throws, and the request is logged as one of `complete`'s is.
 *
 * `temperature` is how freely the model is to choose among the words that it could write next: at 0, the same
 * request is to be answered the same each time.
 */
export async function completeJson(
  provider: AiProvider,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  timeout: number,
  temperature: number,
): Promise<ModelReply> {
  return request(
    provider,
    { model, messages, response_format: { type: 'json_object' }, max_completion_tokens: maxTokens, temperature },
    timeout,
  )
}

/**
 * Posts the provider a request with the body: see `complete`. When the first key's account has had as many requests
 * as it takes (429), the same request is sent once more with the fallback key, and logged as a request of its own.
 */
async function request(provider: AiProvider, body: Record<string, unknown>, timeout: number): Promise<ModelReply> {
  try {
    return await send(provider, provider.apiKey, body, timeout)
  } catch (error) {
    if (!(error instanceof ProviderError && error.status === 429 && provider.fallbackApiKey)) throw error
    return send(provider, provider.fallbackApiKey, body, timeout)
  }
}

/** Posts the provider the request with the key, and logs it, however it ends. */
async function send(
  provider: AiProvider,
  key: string,
  body: Record<string, unknown>,
  timeout: number,
): Promise<ModelReply> {
  // By the Worker's own clock, which moves on while the provider is waited for.
  const began = Date.now()
  // Filled in as the request goes on, so that one that fails is logged with as much as was learnt before it did.
  const seen: Seen = {}
  try {
    const reply = await ask(provider, key, body, timeout, seen)
    log('ai_call', { ms: Date.now() - began, ...seen })
    return reply
  } catch (error) {
    logFailure('ai_call', error, { ms: Date.now() - began, ...seen })
    throw error
  }
}

/** Posts the request and reads the model's message from the answer, noting in `seen` what the log is to have. */
async function ask(
  provider: AiProvider,
  key: string,
  body: Record<string, unknown>,
  timeout: number,
  seen: Seen,
): Promise<ModelReply> {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  seen.status = response.status
  // The request holds the key and a user's question or photo, and the response can quote what it was sent, so
  // neither goes into an error: only the status of the response does, and how long it says to wait, which is a number.
  if (!response.ok) {
    seen.retry_after = retryAfterOf(response)
    throw new ProviderError(response.status, seen.retry_after)
  }
  const { choices, usage } = await response.json<CompletionResponse>()
  const { message, finish_reason } = choices?.[0] ?? {}
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  seen.finish = finishOf(finish_reason)
  seen.tool_calls = calls.length
  seen.prompt_tokens = countOf(usage?.prompt_tokens)
  seen.completion_tokens = countOf(usage?.completion_tokens)
  seen.total_tokens = countOf(usage?.total_tokens)
  if (!message) throw new Failure('no_message', 'AI provider returned no message')
  return {
    // Whatever else comes with the message, such as the model's reasoning, is left where it is.
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: calls.map(readToolCall),
    cutShort: finish_reason === 'length',
  }
}

/** A count of tokens as the provider gave it. Undefined, and so not logged, for anything that is not a number. */
function countOf(given: unknown): number | undefined {
  return typeof given === 'number' ? given : undefined
}

/**
 * Why the model stopped writing, in one of the words that the log has for it. What the answer says of that is text
 * from outside, so it is logged only as the word that it is known to be. Null when the answer does not say.
 */
function finishOf(reason: unknown): Seen['finish'] {
  if (reason === undefined || reason === null) return null
  return FINISHES.find((known) => known === reason) ?? 'other'
}

/**
 * How long the provider's answer says to wait before it is asked again, in seconds: what its `retry-after` header
 * holds, which Groq sets on a 429 and on nothing else, to a whole number or a decimal. Undefined when the answer
 * has no such header, or has one that is not a number above zero.
 */
function retryAfterOf(response: Response): number | undefined {
  // With no header this is 0, and with one that is not a number it is NaN.
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

/** A call of a tool as the provider gave it, with what the API takes back of it and no more. */
function readToolCall(given: { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null): ToolCall {
  const { id, function: called } = given ?? {}
  if (typeof id !== 'string' || typeof called?.name !== 'string' || typeof called.arguments !== 'string') {
    throw new Failure('bad_tool_call', 'AI provider returned a tool call that cannot be read')
  }
  return { id, type: 'function', function: { name: called.name, arguments: called.arguments } }
}
