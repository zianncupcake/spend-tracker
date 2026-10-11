import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { oauthCallback, oauthStart } from '../src/connect'
import { depsFor, type Deps } from '../src/deps'
import { decryptToken } from '../src/google/crypto'
import { GMAIL_READONLY } from '../src/google/oauth'
import { findOrCreateUser } from '../src/store'
import type { MessageEntity, Outgoing, RichMessage } from '../src/telegram/api'
import { handleUpdate } from '../src/telegram/handler'
import { AI_URL, type Completion } from './ai-helpers'
import { headersOf, type Message } from './gmail-helpers'
import { newTelegramId } from './helpers'

// What the tests of Google sign-in and of the mail checker share: a stand-in
// for Google, Telegram and the AI provider, a clock, an outbox, chats with the
// bot and a browser. There is one of each for everybody in a test, as the real
// service has, and a test file that imports this gets them made new before
// each of its tests, with the users of the test before deleted.

export const NOW = new Date('2026-10-09T12:00:00+08:00')
export const MINUTE = 60_000

export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
export const MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const TELEGRAM_URL = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`

/** What the stand-in for Google and Telegram has been sent, and how it is to answer. */
interface Outside {
  /** The forms posted to Google's token endpoint to exchange a code. */
  exchanges: Record<string, string>[]
  /** The refresh tokens Google has issued, oldest first. */
  issued: string[]
  /** The tokens Google has been asked to revoke. */
  revoked: string[]
  /**
   * The refresh tokens Google no longer honours. Revoking one ends the whole grant of its account, as it does at
   * Google: every token issued for that mailbox until then is ended with it.
   */
  ended: Set<string>
  /** The messages that Telegram took. */
  telegrams: {
    chat_id: number
    text: string
    entities?: MessageEntity[]
    link_preview_options?: { is_disabled?: boolean }
  }[]
  /** The chats whose users have blocked the bot. Telegram takes no message for them, and answers 403. */
  blocked: Set<number>
  /** Laid over Google's token response. A test changes a field with it or, with undefined, leaves one out. */
  grant: Record<string, unknown>
  /** The endpoints that answer with an error. */
  failing: Set<string>
  /** The endpoints that never answer. A request to one ends only when its signal does, as fetch has it end. */
  stalled: Set<string>
  /** Runs once while a code is being exchanged: something else happening in the meantime. */
  meanwhile: (() => Promise<unknown>) | undefined
  /** What each mailbox holds, by its address and newest first. Gmail lists all of it, whatever the search asks for. */
  mailboxes: Record<string, Message[]>
  /** How many ids Gmail puts on one page of a listing. */
  pageSize: number
  /** The listings asked of Gmail: of whose mailbox, and with what parameters. */
  listings: Record<string, string>[]
  /** The ids of the messages that Gmail was asked for the headers of, and for no more. */
  fetchedHeaders: string[]
  /** The ids of the messages fetched whole from Gmail. */
  fetched: string[]
  /** What the AI provider was posted, oldest first: the body of each request, with the key that came with it. */
  completions: { key: string | null; body: Completion }[]
  /**
   * How the AI provider answers the requests that come next, the first of them first: with a body of its own, such
   * as `saying` and `calling` make, or with whatever a function returns or throws. A test puts these here before a
   * question is asked. With none left, a request to the provider is one that a test should not have made.
   */
  model: (object | (() => Response | Promise<Response>))[]
}

function newOutside(): Outside {
  return {
    exchanges: [],
    issued: [],
    revoked: [],
    ended: new Set(),
    telegrams: [],
    blocked: new Set(),
    grant: {},
    failing: new Set(),
    stalled: new Set(),
    meanwhile: undefined,
    mailboxes: {},
    pageSize: 100,
    listings: [],
    fetchedHeaders: [],
    fetched: [],
    completions: [],
    model: [],
  }
}

export const outside = newOutside()

/** The service's clock. A test moves it by setting `now`. */
export const clock = { now: NOW }

/** What the bot has sent that was not the reply to a message: `say` takes each reply out. */
export const sent: { chatId: number; text: string }[] = []

/** A message of the bot's as it stands in a chat, with the id that Telegram gave it. */
export type Posted = Outgoing & { id: number; chatId: number }

/**
 * Every message of text that the bot has sent, whole: with what is marked in it and the buttons under it. An edit
 * changes the message here, and a delete takes it out, as they do in the chat.
 */
export const posted: Posted[] = []

/** The id of the last message that was put in `posted`. Telegram gives every message an id that no other has. */
let lastPosted = 0

/** The rich messages that the bot has sent, whole: `rich` takes each reply out. */
export const sentRich: { chatId: number; message: RichMessage }[] = []

/** What each press of a button was answered with, which Telegram shows to whoever pressed. */
export const answered: { pressId: string; text: string }[] = []

export const deps: Deps = {
  ...depsFor(env),
  now: () => clock.now,
  messenger: {
    async send(chatId, text, entities, buttons) {
      sent.push({ chatId, text })
      posted.push({ id: ++lastPosted, chatId, text, entities, buttons })
    },
    // What is sent so is the placeholder of a question, which is no reply: it is in the chat, and not in `sent`.
    async post(chatId, text) {
      posted.push({ id: ++lastPosted, chatId, text })
      return lastPosted
    },
    async sendRich(chatId, message) {
      sentRich.push({ chatId, message })
    },
    async answer(pressId, text) {
      answered.push({ pressId, text })
    },
    async edit(chatId, messageId, text, entities, buttons) {
      const message = posted.find((each) => each.chatId === chatId && each.id === messageId)
      if (!message) throw new Error('A test edited a message that was never sent')
      Object.assign(message, { text, entities, buttons })
    },
    async delete(chatId, messageId) {
      const at = posted.findIndex((each) => each.chatId === chatId && each.id === messageId)
      if (at < 0) throw new Error('A test deleted a message that was never sent')
      posted.splice(at, 1)
    },
    // Nothing is kept of this. A test that is about it watches for it.
    async typing() {},
  },
}

/** The AI provider that the service is set up with. A test takes it away by setting `deps.ai` to nothing. */
const { ai } = deps

beforeEach(async () => {
  Object.assign(outside, newOutside())
  clock.now = NOW
  deps.ai = ai
  sent.length = 0
  posted.length = 0
  sentRich.length = 0
  answered.length = 0
  vi.stubGlobal('fetch', fakeFetch)
  // The service looks across all users for the mailbox whose turn it is, and for who else holds a mailbox. What
  // an earlier test left connected is of a Google that is no more, so every test starts with no users.
  await env.DB.prepare('DELETE FROM users').run()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Google, Telegram and the AI provider are reached with the global fetch. This
 * takes its place, so no test signs in to anything real, or asks a real model
 * anything. Its Google has an account for every authorisation code:
 * "code-for-jane@example.test" is exchanged for tokens of the mailbox
 * jane@example.test, and each token names the mailbox it is for. As at Google,
 * revoking one token of an account ends them all. Its AI provider says what a
 * test has it say: see `Outside`.
 */
async function fakeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const { origin, pathname, searchParams } = new URL(url)
  const endpoint = origin + pathname
  if (outside.failing.has(endpoint)) return Response.json({ error: 'made_up_error' }, { status: 400 })
  if (outside.stalled.has(endpoint)) {
    const { signal } = init
    return new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
  }
  const form: Record<string, string> = Object.fromEntries(init.body instanceof URLSearchParams ? init.body : [])
  const mailbox = (new Headers(init.headers).get('authorization') ?? '').replace('Bearer access-token-of-', '')

  if (endpoint.startsWith(`${MESSAGES_URL}/`)) {
    const id = decodeURIComponent(endpoint.slice(MESSAGES_URL.length + 1))
    const headersOnly = searchParams.get('format') === 'metadata'
    const asked = headersOnly ? outside.fetchedHeaders : outside.fetched
    asked.push(id)
    const message = outside.mailboxes[mailbox]?.find((each) => each.id === id)
    if (!message) return Response.json({ error: { code: 404 } }, { status: 404 })
    return Response.json(headersOnly ? headersOf(message, searchParams.getAll('metadataHeaders')) : message)
  }

  switch (endpoint) {
    case TOKEN_URL: {
      if (form.grant_type === 'refresh_token') {
        const honoured = outside.issued.includes(form.refresh_token) && !outside.ended.has(form.refresh_token)
        if (!honoured) return Response.json({ error: 'invalid_grant' }, { status: 400 })
        return Response.json({
          access_token: `access-token-of-${mailboxOf(form.refresh_token)}`,
          expires_in: 3599,
          scope: GMAIL_READONLY,
          token_type: 'Bearer',
        })
      }
      outside.exchanges.push(form)
      const meanwhile = outside.meanwhile
      outside.meanwhile = undefined
      await meanwhile?.()
      const email = form.code.replace('code-for-', '')
      const refreshToken = `refresh-token-${outside.issued.length + 1}-of-${email}`
      outside.issued.push(refreshToken)
      return Response.json({
        access_token: `access-token-of-${email}`,
        expires_in: 3599,
        refresh_token: refreshToken,
        scope: GMAIL_READONLY,
        token_type: 'Bearer',
        ...outside.grant,
      })
    }
    case PROFILE_URL:
      return Response.json({ emailAddress: mailbox, messagesTotal: 12 })
    case MESSAGES_URL: {
      outside.listings.push({ mailbox, ...Object.fromEntries(searchParams) })
      const messages = outside.mailboxes[mailbox] ?? []
      const pageToken = searchParams.get('pageToken') ?? 'page-from-0'
      // Gmail takes no page token but one of its own making.
      if (!/^page-from-\d+$/.test(pageToken)) {
        return Response.json({ error: { code: 400, message: 'Invalid pageToken' } }, { status: 400 })
      }
      const start = Number(pageToken.replace('page-from-', ''))
      const end = start + outside.pageSize
      const page = messages.slice(start, end).map(({ id }) => ({ id, threadId: id }))
      return Response.json({
        // Gmail leaves both of these out when there is nothing to put in them.
        messages: page.length > 0 ? page : undefined,
        nextPageToken: end < messages.length ? `page-from-${end}` : undefined,
        resultSizeEstimate: messages.length,
      })
    }
    case REVOKE_URL:
      outside.revoked.push(form.token)
      for (const token of outside.issued) {
        if (mailboxOf(token) === mailboxOf(form.token)) outside.ended.add(token)
      }
      return Response.json({})
    case TELEGRAM_URL: {
      const message = JSON.parse(String(init.body))
      if (outside.blocked.has(message.chat_id)) {
        const description = 'Forbidden: bot was blocked by the user'
        return Response.json({ ok: false, error_code: 403, description }, { status: 403 })
      }
      outside.telegrams.push(message)
      return Response.json({ ok: true })
    }
    case AI_URL: {
      const key = new Headers(init.headers).get('authorization')
      outside.completions.push({ key, body: JSON.parse(String(init.body)) })
      const reply = outside.model.shift()
      if (reply === undefined) throw new Error('A test made a request it should not have')
      const { signal } = init
      // As fetch does: a request whose time runs out before it is answered fails with why it was ended.
      const ended = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
      return Promise.race([typeof reply === 'function' ? reply() : Response.json(reply), ended])
    }
    default:
      throw new Error('A test made a request it should not have')
  }
}

/** The mailbox that a refresh token of the stand-in's Google is for. */
function mailboxOf(refreshToken: string): string {
  return refreshToken.replace(/^refresh-token-\d+-of-/, '')
}

type Chat = ReturnType<typeof openChat>

let lastMessage = 0
let lastPress = 0

/** A new user's private chat with the bot. */
export function openChat() {
  const telegramId = newTelegramId()
  /**
   * Sends the bot a message. Its reply is left in `sent`. Telegram gives every message an id that no other has, and
   * so does this, unless it is told the id: a message sent with the id of an earlier one is that message, delivered
   * a second time. What the bot leaves for when Telegram has been answered, which is the answering of a question,
   * is done here at once.
   */
  const send = async (text: string, messageId = ++lastMessage) => {
    const later = await handleUpdate(deps, {
      message: { message_id: messageId, text, chat: { id: telegramId, type: 'private' }, from: { id: telegramId } },
    })
    if (later) await later()
  }

  /**
   * Tells the bot of the press of a button under a message, as Telegram does: with what the button holds, and with
   * the message as it stands. Returns what the press was answered with, and the messages that the bot sent after it.
   */
  async function pressWith(message: Posted, data: string): Promise<{ answer: string | undefined; sent: Posted[] }> {
    const pressId = `press-${++lastPress}`
    const [before, beforePosted] = [sent.length, posted.length]
    const { id: message_id, text, entities } = message
    const under = { message_id, chat: { id: telegramId, type: 'private' }, text, entities }
    await handleUpdate(deps, { callback_query: { id: pressId, from: { id: telegramId }, data, message: under } })
    sent.splice(before)
    return { answer: answered.find((each) => each.pressId === pressId)?.text, sent: posted.slice(beforePosted) }
  }

  return {
    telegramId,
    send,
    /**
     * Sends the bot a message and returns its one reply, which is taken out of `sent`. The reply is the one message
     * of text that the bot has left in the chat when it is done: for a question, that is what stands in the place
     * of the placeholder, and a placeholder that is left beside it would be a second.
     */
    async say(text: string): Promise<string> {
      const [before, beforePosted] = [sent.length, posted.length]
      await send(text)
      sent.splice(before)
      const replies = posted.slice(beforePosted)
      expect(replies).toHaveLength(1)
      expect(replies[0].chatId).toBe(telegramId)
      return replies[0].text
    },
    /**
     * Sends the bot a message and returns its replies whole, however many there are. They are taken out of `sent`.
     * With `messageId`, the message has that id, as for `send`.
     */
    async ask(text: string, messageId?: number): Promise<Posted[]> {
      const [before, beforePosted] = [sent.length, posted.length]
      await send(text, messageId)
      sent.splice(before)
      const replies = posted.slice(beforePosted)
      for (const reply of replies) expect(reply.chatId).toBe(telegramId)
      return replies
    },
    /**
     * Sends the bot a message and returns the rich message that is its one reply, which is taken out of `sentRich`.
     * The bot is to send no message of text with it, and to leave none in the chat: the placeholder of a question
     * is gone by the time its answer is there.
     */
    async rich(text: string): Promise<RichMessage> {
      const [before, beforePosted, beforeRich] = [sent.length, posted.length, sentRich.length]
      await send(text)
      expect(sent).toHaveLength(before)
      expect(posted).toHaveLength(beforePosted)
      expect(sentRich).toHaveLength(beforeRich + 1)
      const [reply] = sentRich.splice(beforeRich)
      expect(reply.chatId).toBe(telegramId)
      return reply.message
    },
    pressWith,
    /** Presses the button with the label under a message. */
    press(message: Posted, label: string) {
      const button = message.buttons?.flat().find((each) => each.text === label)
      if (!button) throw new Error(`A test pressed a button that the message does not have: ${label}`)
      return pressWith(message, button.data)
    },
    async userId(): Promise<number> {
      return (await findOrCreateUser(env.DB, telegramId)).id
    },
  }
}

/** The connect link in one of the bot's replies. */
export function linkIn(reply: string): URL {
  return new URL(/https:\/\/\S+/.exec(reply)?.[0] ?? '')
}

/** A browser opening a connect link. A link preview does the same. */
export function open(link: URL): Promise<Response> {
  return oauthStart(deps, link.searchParams)
}

/** Google sending a browser back to the service, after the owner of `email` opened the link and approved. */
export function approve(link: URL, email: string): Promise<Response> {
  const state = link.searchParams.get('state') ?? ''
  return oauthCallback(deps, new URLSearchParams({ state, code: `code-for-${email}` }))
}

/** The code that a page shows. */
export async function codeOn(page: Response): Promise<string> {
  const code = /<p class="code">(\d{6})<\/p>/.exec(await page.text())?.[1] ?? ''
  expect(code).toHaveLength(6)
  return code
}

/** /connect, then signing in at Google as `email`. Returns the code the browser ends up showing. */
export async function signIn(chat: Chat, email: string): Promise<string> {
  const code = await codeOn(await approve(linkIn(await chat.say('/connect')), email))
  sent.length = 0 // the message that told the chat about it
  return code
}

/** A chat whose user has connected the mailbox. */
export async function connectedChat(email: string): Promise<Chat> {
  const chat = openChat()
  expect(await chat.say(await signIn(chat, email))).toContain('Connected')
  return chat
}

/** A six-digit code that is not the given one. */
export function otherThan(code: string): string {
  return code === '000000' ? '111111' : '000000'
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

// The two functions below read the tables directly, as the counts in helpers.ts do.

interface AttemptRow {
  owner_id: number
  state_hash: string
  code_verifier: string
  expires_at: number
  claimed: number
  email: string | null
  refresh_token_enc: string | null
  confirm_code_hash: string | null
  confirm_tries: number
}

interface ConnectionRow {
  owner_id: number
  email: string
  refresh_token_enc: string
  status: string
  last_checked_at: number | null
  backlog_page_token: string | null
  connected_at: number
  last_run_at: number | null
}

export function attemptOf(userId: number): Promise<AttemptRow | null> {
  return env.DB.prepare('SELECT * FROM connect_attempts WHERE owner_id = ?').bind(userId).first<AttemptRow>()
}

export function connectionOf(userId: number): Promise<ConnectionRow | null> {
  return env.DB.prepare('SELECT * FROM google_connections WHERE owner_id = ?').bind(userId).first<ConnectionRow>()
}

/** The refresh token that a row holds, decrypted. */
export function tokenIn(row: { refresh_token_enc: string | null } | null): Promise<string> {
  return decryptToken(env.TOKEN_ENCRYPTION_KEY, row?.refresh_token_enc ?? '')
}
