// What the tests of the bot's assistant share: where the AI provider is reached, what a request to it holds, and
// what a provider with a chat completions API answers with. Nothing here reaches a provider: the tests put a
// stand-in in its place, and these make what the stand-in is to say.

/** Where the bot asks the model when the service is set up with a key and nothing else. */
export const AI_URL = 'https://api.groq.com/openai/v1/chat/completions'

/**
 * What the model is told of showing a user what they have spent, word for word: one line of what it is told before a
 * question, which the tests that have all of that written out share.
 */
export const SHOWN_NOT_WRITTEN =
  'When the user asks what they have spent, or to see or list their purchases or transactions, or for a breakdown, a ' +
  'total or what is left of a limit, call show_spending and write nothing else: the bot then shows it in tables, for ' +
  "each card's current statement month or calendar month. Never write those out yourself. find_purchases is for " +
  'your own reading, to find the id of a purchase or to answer what the tables do not show, such as an earlier month ' +
  'or one merchant: the user is shown none of what it returns.'

/** A message of a conversation, as the bot posts it to the provider. */
export interface ChatMessage {
  role: string
  content?: string
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  name?: string
}

/** The body of a request to the provider, as the bot posts it. */
export interface Completion {
  model: string
  messages: ChatMessage[]
  tools: { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }[]
  tool_choice: string
  max_completion_tokens: number
}

/** What the provider answers a request with, around the one message that the model wrote. */
function completion(message: Record<string, unknown>, finishReason: string) {
  return {
    id: 'chatcmpl-made-up',
    object: 'chat.completion',
    created: 1_791_000_000,
    model: 'made-up-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, logprobs: null, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }
}

/** The provider's answer when the model gives its own: text, and no call of a tool. */
export function saying(content: string | null, finishReason = 'stop') {
  return completion({ content }, finishReason)
}

/**
 * The provider's answer when it takes no request: an error with the HTTP status, as a function for the stand-in to
 * call. `message` is what the error says, which a provider can make of what it was sent. `headers` are what the
 * answer has besides, such as the `retry-after` in which a provider says how many seconds to wait.
 */
export function refusing(status: number, message = 'A made-up error.', headers: Record<string, string> = {}) {
  return () => Response.json({ error: { message, type: 'made_up_error' } }, { status, headers })
}

/**
 * A call of a tool: its id, the name of its tool, and its arguments. Arguments that are given as text are the
 * model's own writing of them, as they are: for a model that writes what is not JSON.
 */
type Call = [id: string, name: string, args?: unknown]

function toolCalls(calls: Call[]) {
  return calls.map(([id, name, args = {}]) => ({
    id,
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  }))
}

/**
 * The provider's answer when the model calls tools. The message has the model's reasoning with it, as that of a
 * model that reasons has.
 */
export function calling(...calls: Call[]) {
  const reasoning = 'Made-up reasoning, which is not to be sent back.'
  return completion({ content: null, reasoning, tool_calls: toolCalls(calls) }, 'tool_calls')
}

/** What the bot posts back of a message that called tools: the calls, and nothing else that came with them. */
export function called(...calls: Call[]): ChatMessage {
  return { role: 'assistant', tool_calls: toolCalls(calls) }
}

/** What the bot posts back as the answer of a tool to the call with the id. */
export function toolResult(id: string, name: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, name, content }
}
