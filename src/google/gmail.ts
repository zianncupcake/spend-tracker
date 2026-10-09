// Reading a connected mailbox through the Gmail API:
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages

import type { GoogleClient } from './oauth'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

// The headers that tell an alert from other mail. They can be asked for by themselves.
const CHECKED_HEADERS = ['From', 'Subject', 'Authentication-Results']

// A huge email must not use up the CPU time of a run, so no more of a body
// than this is decoded: 150,000 bytes. The count is a multiple of four, which
// puts the cut between two groups of base64 characters and not inside one.
const MAX_BODY_BASE64 = 200_000

// Real mail nests its parts two or three deep. The limit is there for a
// message built to nest until the search for a part overflows the stack.
const MAX_PART_DEPTH = 10

/** Google no longer honours a refresh token: the user's grant is gone, and only signing in again brings it back. */
export class GrantLostError extends Error {
  name = 'GrantLostError'
}

/** Gmail does not take a page token: the listing it belongs to has to be asked for again, from its first page. */
export class PageTokenError extends Error {
  name = 'PageTokenError'
}

export interface MessagePage {
  /** In the order Gmail lists them, which is newest first. */
  ids: string[]
  /** Missing on the last page. */
  nextPageToken?: string
}

/** What the headers of a message say of where it is from. They are enough to tell an alert from other mail. */
export interface MessageHeaders {
  /** The sender's bare address, in lower case. */
  from: string
  subject: string
  /** The domain that Gmail found the sender's address to be authentic for, or null when it found none. */
  authenticatedDomain: string | null
}

/** What is read from one message. */
export interface GmailMessage extends MessageHeaders {
  /** Unix seconds. */
  receivedAt: number
  /**
   * The plain-text part or, in a message without one, the HTML part reduced
   * to text. It is worked out when it is asked for: a large body takes CPU
   * time, which is not to be spent on a message that will not be read.
   */
  text(): string
}

// The parts of Gmail's responses this service reads. All optional, because they arrive as unchecked JSON.

interface ListResponse {
  messages?: { id?: string }[]
  nextPageToken?: string
}

interface MessageResponse {
  /** Milliseconds, as a string. */
  internalDate?: string
  payload?: MessagePart
}

interface MessagePart {
  mimeType?: string
  headers?: Header[]
  /** The data is base64url. */
  body?: { data?: string }
  parts?: MessagePart[]
}

interface Header {
  name?: string
  value?: string
}

/** An access token for a mailbox, from its refresh token. Throws GrantLostError when the user's grant is gone. */
export async function refreshAccessToken(client: GoogleClient, refreshToken: string): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  })
  // The request holds the client secret and a token, and the response can hold a token, so neither goes into an error.
  if (!response.ok) {
    const refusal = await response.json<{ error?: string }>().catch(() => null)
    if (response.status === 400 && refusal?.error === 'invalid_grant') throw new GrantLostError()
    throw new Error(`Google token refresh failed with status ${response.status}`)
  }
  const { access_token } = await response.json<{ access_token?: string }>()
  if (typeof access_token !== 'string') throw new Error('Google token refresh returned no access token')
  return access_token
}

/** One page of the ids of the messages that match a Gmail search. */
export async function listMessageIds(accessToken: string, query: string, pageToken?: string): Promise<MessagePage> {
  const params = new URLSearchParams({ q: query, maxResults: '100' })
  if (pageToken) params.set('pageToken', pageToken)
  const response = await fetch(`${MESSAGES_URL}?${params}`, { headers: { authorization: `Bearer ${accessToken}` } })
  // 400 is what Gmail answers to a page token that it does not take. It is also what a search that Gmail cannot
  // make sense of gets, so this is only to be gone by once the first page of the same search has been listed.
  if (response.status === 400 && pageToken) throw new PageTokenError()
  if (!response.ok) throw new Error(`Gmail list request failed with status ${response.status}`)
  const { messages, nextPageToken } = await response.json<ListResponse>()
  return {
    ids: (messages ?? []).map(({ id }) => id).filter((id) => typeof id === 'string'),
    nextPageToken: typeof nextPageToken === 'string' ? nextPageToken : undefined,
  }
}

/** The headers of a message that tell an alert from other mail, fetched without the rest of it. */
export async function getMessageHeaders(accessToken: string, id: string): Promise<MessageHeaders> {
  const params = new URLSearchParams({ format: 'metadata' })
  for (const name of CHECKED_HEADERS) params.append('metadataHeaders', name)
  const { payload } = await fetchMessage(accessToken, id, params)
  return readHeaders(payload)
}

/** A whole message: its headers, when it came and its text. */
export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  const { internalDate, payload } = await fetchMessage(accessToken, id, new URLSearchParams({ format: 'full' }))
  const receivedAt = Math.floor(Number(internalDate) / 1000)
  if (!Number.isFinite(receivedAt)) throw new Error('Gmail message held no date')
  return { ...readHeaders(payload), receivedAt, text: () => readableText(payload) }
}

async function fetchMessage(accessToken: string, id: string, params: URLSearchParams): Promise<MessageResponse> {
  const response = await fetch(`${MESSAGES_URL}/${encodeURIComponent(id)}?${params}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error(`Gmail message request failed with status ${response.status}`)
  return response.json<MessageResponse>()
}

function readHeaders(payload: MessagePart | undefined): MessageHeaders {
  const headers = payload?.headers ?? []
  return {
    from: bareAddress(headerValue(headers, 'from')),
    subject: headerValue(headers, 'subject'),
    authenticatedDomain: authenticatedDomain(headers),
  }
}

/** The value of the first header with the name, which is given in lower case. Empty when there is none. */
function headerValue(headers: Header[], name: string): string {
  return headers.find((header) => header.name?.toLowerCase() === name)?.value ?? ''
}

/** The address in a From header: all of it, or what its last pair of angle brackets holds. */
function bareAddress(from: string): string {
  const open = from.lastIndexOf('<')
  const close = from.indexOf('>', open)
  const address = open >= 0 && close > open ? from.slice(open + 1, close) : from
  return address.trim().toLowerCase()
}

/**
 * The domain that Gmail found the sender's address to be authentic for: the
 * header.from of a DMARC pass in the results it recorded on the message.
 */
function authenticatedDomain(headers: Header[]): string | null {
  // A sender can put Authentication-Results headers of its own on a message,
  // and can name Gmail in them. Gmail adds its header above everything the
  // message arrived with, so only the topmost that names Gmail is read.
  const recorded = headers.find(
    ({ name, value }) =>
      name?.toLowerCase() === 'authentication-results' && value?.split(';', 1)[0].trim() === 'mx.google.com',
  )
  // The other results quote things the sender chose, such as the address it
  // sent from, and that address can hold the words "dmarc=pass". So DMARC only
  // counts as a result of its own, and only when the header has no second one.
  const dmarc = (recorded?.value ?? '')
    .split(';')
    .map((result) => result.trim())
    .filter((result) => result.startsWith('dmarc='))
  if (dmarc.length !== 1 || !/^dmarc=pass\s/.test(dmarc[0])) return null
  return /\sheader\.from=(\S+)/.exec(dmarc[0])?.[1].toLowerCase() ?? null
}

function readableText(payload: MessagePart | undefined): string {
  const plain = bodyOf(payload, 'text/plain')
  if (plain) return decodeBody(plain)
  const html = bodyOf(payload, 'text/html')
  return html ? htmlToText(decodeBody(html)) : ''
}

/** The encoded body of the first part of the type, looking through the parts inside parts in their order. */
function bodyOf(part: MessagePart | undefined, mimeType: string, depth = 0): string | undefined {
  if (!part || depth > MAX_PART_DEPTH) return undefined
  if (part.mimeType?.toLowerCase() === mimeType && part.body?.data) return part.body.data
  for (const child of part.parts ?? []) {
    const body = bodyOf(child, mimeType, depth + 1)
    if (body) return body
  }
  return undefined
}

/** The start of a body as text. It is taken to be UTF-8. */
function decodeBody(data: string): string {
  const bytes = Uint8Array.fromBase64(data.slice(0, MAX_BODY_BASE64), { alphabet: 'base64url' })
  return new TextDecoder().decode(bytes)
}

// Email is hostile input, so none of the patterns below can backtrack heavily.
// A tag is only ever matched up to the next < or >. A style or script block
// that is never closed runs to the end of the text, so the search does not
// start over from every opening tag that follows it.
const UNSEEN_BLOCK = /<(style|script)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi
const LINE_END = /<br\b[^<>]*>|<\/(?:p|div|tr|li)\s*>/gi
const TAG = /<[^<>]*>/g
const ENTITY = /&(?:amp|lt|gt|quot|#39|nbsp);/g
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

/** HTML as the text a reader would see, near enough for a parser to find an alert's sentence in it. */
function htmlToText(html: string): string {
  return (
    html
      .replace(UNSEEN_BLOCK, '')
      .replace(LINE_END, '\n')
      .replace(TAG, '')
      // After the tags have gone, so that an escaped < is text and not the start of a tag.
      .replace(ENTITY, (entity) => ENTITIES[entity])
      // The indentation of the HTML is not text. A run of blanks, or a blank
      // that is not a space, becomes one space. Then a line keeps none at either end.
      .replace(/[ \t\r\xa0]{2,}|[\t\r\xa0]/g, ' ')
      .replace(/ \n ?|\n /g, '\n')
      .trim()
  )
}
