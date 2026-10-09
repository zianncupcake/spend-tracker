import { env, exports } from 'cloudflare:workers'
import { expect } from 'vitest'
import { storeFor } from '../src/store'
import { seconds } from './helpers'

// What the tests of the MCP endpoint share: messages as an assistant sends
// them, the reading of what comes back, and purchases to ask about.

const ENDPOINT = 'https://spend-tracker.test/mcp'

/** The token in the bot's reply to /mcp. */
export function tokenFrom(reply: string): string {
  const [token = ''] = /^stmcp_[A-Za-z0-9_-]{43}$/m.exec(reply) ?? []
  expect(token).not.toBe('')
  return token
}

/** A request that brings the MCP endpoint a JSON-RPC message, with the headers the protocol asks of a client. */
export function mcpRequest(message: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(message),
  })
}

/** Sends the Worker a JSON-RPC message with a token, as an assistant would. */
export function post(token: string, message: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(mcpRequest(message, { Authorization: `Bearer ${token}`, ...headers }))
}

/** The JSON-RPC message that a response carries: as its JSON body, or as the one event of its stream. */
export async function messageIn(response: Response) {
  const body = await response.text()
  const isStream = response.headers.get('Content-Type') === 'text/event-stream'
  return JSON.parse(isStream ? (/^data: (.+)$/m.exec(body)?.[1] ?? '') : body)
}

/** The message that calls a tool, as the revisions of the protocol before 2026-07-28 have it. */
export function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
}

/** Calls a tool through the Worker with a token, and returns what the tool answered. */
export async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await post(token, toolCall(name, args))
  expect(response.status).toBe(200)
  return (await messageIn(response)).result
}

/** What a tool answers with: text, with structured content beside it unless the text says what went wrong. */
interface ToolResult {
  content: { type: string; text: string }[]
  structuredContent?: unknown
  isError?: boolean
}

/** The data in a tool's answer. It comes twice, as JSON text and as structured content, and the two are the same. */
export function dataIn(result: ToolResult) {
  expect(result.isError).toBeUndefined()
  expect(result.content).toHaveLength(1)
  expect(result.content[0].type).toBe('text')
  const data = JSON.parse(result.content[0].text)
  expect(result.structuredContent).toEqual(data)
  return data
}

/** A purchase: when (an ISO date-time, or unix seconds), how much, on which card and, unless left out, where. */
export type Purchase = [
  at: string | number,
  amountMinor: number,
  currency: string,
  cardLast4: string,
  merchant?: string | null,
]

let lastMessage = 0

/** Stores purchases for a user. One that is given no merchant gets a made-up one, and null stores it with none. */
export async function record(userId: number, purchases: Purchase[]): Promise<void> {
  for (const [at, amountMinor, currency, cardLast4, merchant = 'COFFEE PLACE'] of purchases) {
    const stored = await storeFor(env.DB, userId).insertTransaction({
      sourceId: `msg-${++lastMessage}`,
      cardLast4,
      amountMinor,
      currency,
      merchant,
      occurredAt: typeof at === 'number' ? at : seconds(at),
      parser: 'example-bank',
    })
    expect(stored).not.toBeNull()
  }
}
