// Asking a model for the next message of a conversation, through a chat completions API of the kind that OpenAI
// has. Any provider with such an API will do. Groq's is the one that this was written against:
// https://console.groq.com/docs/api-reference#chat-create
// https://console.groq.com/docs/tool-use
// https://console.groq.com/docs/rate-limits

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
}

/**
 * The provider answered a request with an error: `status` is the HTTP status of its answer. 429 is what it answers
 * when it has had as many requests, or as many tokens, as it takes for now. `retryAfter` is how long its answer
 * said to wait before it is asked again, in seconds and more than zero, when it said. It has the name of a plain
 * Error.
 */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(`AI provider request failed with status ${status}`)
  }
}

/**
 * Asks the model for the next message of the conversation, with the tools it may call. Throws a ProviderError when
 * the provider answers with an error, and what fetch throws when it has not answered within `timeout` milliseconds.
 */
export async function complete(
  provider: AiProvider,
  messages: ChatMessage[],
  tools: Tool[],
  timeout: number,
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
  // The request holds the key and a user's question, and the response can quote the question, so neither goes into
  // an error: only the status of the response does, and how long it says to wait, which is a number.
  if (!response.ok) throw new ProviderError(response.status, retryAfterOf(response))
  const { choices } = await response.json<CompletionResponse>()
  const { message, finish_reason } = choices?.[0] ?? {}
  if (!message) throw new Error('AI provider returned no message')
  return {
    // Whatever else comes with the message, such as the model's reasoning, is left where it is.
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.map(readToolCall) : [],
    cutShort: finish_reason === 'length',
  }
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
    throw new Error('AI provider returned a tool call that cannot be read')
  }
  return { id, type: 'function', function: { name: called.name, arguments: called.arguments } }
}
