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
 * The most tokens that the model may write in one message, with those of its reasoning counted among them. A
 * message is the call of a tool or a brief answer. An answer of more would not fit a message of Telegram's anyway.
 */
const MAX_COMPLETION_TOKENS = 1024

/** The AI provider that the assistant's answers are asked of, as the service is set up with it. */
export interface AiProvider {
  apiKey: string
  /** Where its API is reached, with no trailing slash: what /chat/completions comes after. */
  baseUrl: string
  model: string
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
 * A message of a conversation, as the API has it. The model's own message is one that calls tools, as that is the
 * only kind that is ever sent back to it. What each tool answered follows it, under the id of its call.
 */
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
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
  // By the Worker's own clock, which moves on while the provider is waited for.
  const began = Date.now()
  // Filled in as the request goes on, so that one that fails is logged with as much as was learnt before it did.
  const seen: Seen = {}
  try {
    const reply = await ask(provider, messages, tools, timeout, seen)
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
  messages: ChatMessage[],
  tools: Tool[],
  timeout: number,
  seen: Seen,
): Promise<ModelReply> {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: provider.model,
      messages,
      tools,
      tool_choice: 'auto',
      max_completion_tokens: MAX_COMPLETION_TOKENS,
    }),
    signal: AbortSignal.timeout(timeout),
  })
  seen.status = response.status
  // The request holds the key and a user's question, and the response can quote the question, so neither goes into
  // an error: only the status of the response does, and how long it says to wait, which is a number.
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
