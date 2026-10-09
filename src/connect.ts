// Connecting a user's Gmail through Google sign-in.
//
// A connect link is a bearer link: whoever opens it and approves at Google
// attaches THEIR mailbox to the chat that asked for the link. Someone could
// send their own link to another person, and then receive that person's bank
// alerts. So approving at Google connects nothing by itself. The browser is
// shown a code, and the connection is made only when that code is sent in the
// chat the link came from. The person who approved sees the code. The chat of
// whoever sent them the link does not.

import type { Deps } from './deps'
import { decryptToken, encryptToken } from './google/crypto'
import { authorizationUrl, exchangeCode, fetchEmailAddress, GMAIL_READONLY, revokeToken } from './google/oauth'
import { codePage, problemPage } from './pages'
import { telegramIdOf } from './store'
import { claimAttempt, connectStoreFor, findAttemptByState, isMailboxHeld, type HeldMailbox } from './store-connect'

/** How long a link works for, and then how long its code does. */
export const ATTEMPT_MINUTES = 10

const MAX_TRIES = 5

export type ConfirmResult =
  | { status: 'connected'; email: string }
  | { status: 'wrong'; triesLeft: number }
  | { status: 'none' }

/** Starts a sign-in for the user, in place of any they had in progress, and returns the link that opens it. */
export async function startConnect(deps: Deps, userId: number): Promise<string> {
  const store = connectStoreFor(deps.db, userId)
  // Done before the new link exists. Revoking ends a Google account's whole
  // grant, so a revocation that landed after the next sign-in would undo it.
  await revokeStored(deps, await store.removeAttempt())

  const state = randomToken()
  await store.startAttempt(await sha256(state), randomToken(), seconds(deps.now()) + ATTEMPT_MINUTES * 60)
  return `${deps.baseUrl}/oauth/start?state=${state}`
}

/**
 * GET /oauth/start: sends the browser on to Google. It changes nothing, so it
 * does not matter how often a link is fetched. Link previews fetch it too.
 */
export async function oauthStart(deps: Deps, params: URLSearchParams): Promise<Response> {
  const state = params.get('state') ?? ''
  const attempt = await findAttemptByState(deps.db, await sha256(state), seconds(deps.now()))
  if (!attempt) return problemPage('expired')
  return Response.redirect(await authorizationUrl(deps.google, state, attempt.codeVerifier), 302)
}

/** GET /oauth/callback: where Google sends the browser back to, with a code if the user approved. */
export async function oauthCallback(deps: Deps, params: URLSearchParams): Promise<Response> {
  const authCode = params.get('code')
  if (!authCode || params.has('error')) return problemPage('not-completed')

  try {
    const now = seconds(deps.now())
    const stateHash = await sha256(params.get('state') ?? '')
    // The attempt is claimed before Google is asked anything, so a state is taken to its token endpoint once at
    // most. Whatever comes of that, the link shows the expired page from here on.
    const attempt = await claimAttempt(deps.db, stateHash, now)
    if (!attempt) return problemPage('expired')

    const tokens = await exchangeCode(deps.google, authCode, attempt.codeVerifier)
    if (!tokens.scopes.includes(GMAIL_READONLY)) return problemPage('no-gmail-access')
    if (!tokens.refreshToken) return problemPage('no-lasting-access')

    const email = await fetchEmailAddress(tokens.accessToken)
    const confirmation = randomCode()
    // The state finds no attempt once it is claimed, so the code is shown this once and never again.
    const held = await connectStoreFor(deps.db, attempt.ownerId).holdForCode(stateHash, {
      email,
      refreshTokenEnc: await encryptToken(deps.tokenKey, tokens.refreshToken),
      confirmCodeHash: await sha256(confirmation),
      expiresAt: now + ATTEMPT_MINUTES * 60,
    })
    if (!held) return problemPage('expired')

    const chatId = await telegramIdOf(deps.db, attempt.ownerId)
    if (chatId !== null) {
      // This is the chat that asked for the link, and whoever opened the link and signed in may be somebody else.
      // So the message says nothing of the mailbox, not even a part of its address. The chat is first shown the
      // address once the code has been sent in it.
      await deps.messenger.send(
        chatId,
        'Google sign-in has finished. To connect your Gmail, send here the 6-digit code that your browser is ' +
          `showing, within ${ATTEMPT_MINUTES} minutes. If that was not you, ignore this message: nothing is ` +
          'connected without the code.',
      )
    }
    return codePage(confirmation)
  } catch (error) {
    // Only the error's name is logged: its message could quote what Google sent.
    console.error('google sign-in failed:', error instanceof Error ? error.name : typeof error)
    return problemPage('failed')
  }
}

/** Checks a confirmation code sent in the user's chat, and makes the connection if it is the right one. */
export async function confirmCode(deps: Deps, userId: number, code: string): Promise<ConfirmResult> {
  const store = connectStoreFor(deps.db, userId)
  // The try is counted before the code is looked at, so codes sent at the same moment share the limit too.
  const pending = await store.countTry(MAX_TRIES)
  if (!pending) return { status: 'none' }

  const now = seconds(deps.now())
  const expired = pending.expiresAt <= now
  if (!expired && sameHash(await sha256(code), pending.confirmCodeHash)) {
    // A connection this replaces is one that needed reconnecting. Its token is not
    // revoked: for the same Google account, that would end the grant just made.
    await store.saveConnection(pending.email, pending.refreshTokenEnc, now)
    return { status: 'connected', email: pending.email }
  }
  if (!expired && pending.confirmTries < MAX_TRIES) {
    return { status: 'wrong', triesLeft: MAX_TRIES - pending.confirmTries }
  }
  // Out of time or out of tries, so the mailbox is let go.
  await revokeStored(deps, await store.removeAttempt())
  return { status: 'none' }
}

/**
 * Gives up all the Gmail access held for the user: their connection, and any
 * sign-in in progress. Returns the address that was connected, or null.
 */
export async function disconnect(deps: Deps, userId: number): Promise<string | null> {
  const store = connectStoreFor(deps.db, userId)
  await revokeStored(deps, await store.removeAttempt())
  const connection = await store.removeConnection()
  await revokeStored(deps, connection)
  return connection?.email ?? null
}

/**
 * Lets go at Google of a mailbox whose token has just been deleted here. Revoking one token ends the whole grant
 * of its Google account, and with it every other token for the same mailbox. So nothing is revoked while the
 * mailbox is still held here, for this user or for another: a sign-in that came to nothing would otherwise cut off
 * a connection that works. Best effort: the token is gone from here whatever Google answers.
 */
export async function revokeStored(deps: Deps, discarded: HeldMailbox | null): Promise<void> {
  if (!discarded || (await isMailboxHeld(deps.db, discarded.email))) return
  try {
    await revokeToken(await decryptToken(deps.tokenKey, discarded.refreshTokenEnc))
  } catch (error) {
    console.error('token revocation failed:', error instanceof Error ? error.name : typeof error)
  }
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

/** 32 random bytes in base64url: 43 characters, which is also a valid PKCE verifier. */
function randomToken(): string {
  return crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: 'base64url', omitPadding: true })
}

/** Six digits, every code as likely as any other. */
function randomCode(): string {
  const [value] = crypto.getRandomValues(new Uint32Array(1))
  // 2^32 is not a whole number of millions. A value past the last whole million
  // is drawn again, or the codes it stands for would come up more often.
  if (value >= 4_294_000_000) return randomCode()
  return String(value % 1_000_000).padStart(6, '0')
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return new Uint8Array(digest).toHex()
}

/** Whether two SHA-256 hashes are equal, compared in constant time. */
function sameHash(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  return a.length === b.length && crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b))
}
