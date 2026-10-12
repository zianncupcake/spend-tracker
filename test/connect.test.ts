import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { CONNECT_HEADS_UP, NO_SIGN_IN } from '../src/telegram/texts'
import {
  approve,
  attemptOf,
  clock,
  codeOn,
  connectedChat,
  connectionOf,
  linkIn,
  MINUTE,
  NOW,
  open,
  openChat,
  otherThan,
  outside,
  sha256,
  signIn,
  tokenIn,
} from './connect-helpers'
import { newTelegramId } from './helpers'
import { catchConsole } from './log-helpers'

describe('/connect', () => {
  it("replies with a heads-up and then a link, and keeps only a hash of the link's state", async () => {
    const chat = openChat()

    const reply = await chat.say('/connect')

    expect(reply).toContain(CONNECT_HEADS_UP)
    const link = linkIn(reply)
    expect(reply.endsWith(`\n${link.href}`)).toBe(true)
    expect(link.origin + link.pathname).toBe('https://spend-tracker.test/oauth/start')
    const state = link.searchParams.get('state') ?? ''
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes in base64url

    const userId = await chat.userId()
    expect(await attemptOf(userId)).toEqual({
      owner_id: userId,
      state_hash: (await sha256(state)).toHex(),
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expires_at: NOW.getTime() / 1000 + 600,
      claimed: 0,
      email: null,
      refresh_token_enc: null,
      confirm_code_hash: null,
      confirm_tries: 0,
    })
    expect(outside.exchanges).toEqual([])
  })

  it('gives a new link in place of the old one', async () => {
    const chat = openChat()
    const first = linkIn(await chat.say('/connect'))

    const second = linkIn(await chat.say('/connect'))

    expect(second.href).not.toBe(first.href)
    expect((await open(first)).status).toBe(400)
    expect((await approve(first, 'jane@example.test')).status).toBe(400)
    expect(outside.exchanges).toEqual([])
    expect((await open(second)).status).toBe(302)
  })

  it('gives up the mailbox of a sign-in that a new link replaces', async () => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')

    await chat.say('/connect')

    expect(outside.revoked).toEqual([outside.issued[0]])
    expect(await attemptOf(await chat.userId())).toMatchObject({ email: null, refresh_token_enc: null })
    expect(await chat.say(code)).toBe(NO_SIGN_IN)
  })

  it('says so when Gmail is already connected, and starts nothing', async () => {
    const chat = await connectedChat('jane@example.test')

    const reply = await chat.say('/connect')

    expect(reply).toBe('Your Gmail jane@example.test is already connected. Send /disconnect to remove it.')
    expect(await attemptOf(await chat.userId())).toBeNull()
  })

  it('connects again when the connection needs it, without revoking what the new sign-in depends on', async () => {
    const chat = await connectedChat('jane@example.test')
    const userId = await chat.userId()
    await env.DB.prepare("UPDATE google_connections SET status = 'needs_reconnect' WHERE owner_id = ?")
      .bind(userId)
      .run()

    expect(await chat.say(await signIn(chat, 'jane@example.test'))).toContain('Connected jane@example.test')

    const connection = await connectionOf(userId)
    expect(connection).toMatchObject({ email: 'jane@example.test', status: 'active' })
    expect(await tokenIn(connection)).toBe(outside.issued[1])
    // Revoking the old token would end the grant that the new one belongs to.
    expect(outside.revoked).toEqual([])
  })
})

describe('what the log has of a sign-in', () => {
  /** The line of a message that the bot replied to: a command, by its name, or the six digits of a code. */
  const came = (what: object) => ({ event: 'update', ...what, outcome: 'replied', ms: 0 })
  const CONNECT = came({ kind: 'command', command: 'connect' })

  it('is that a link was given, and to which user: nothing of the link', async () => {
    const chat = openChat()
    const userId = await chat.userId()
    const logged = catchConsole()

    const link = linkIn(await chat.say('/connect'))

    // And after it, that the command which asked for the link was replied to.
    expect(logged.events()).toEqual([{ event: 'connect_link', user: userId }, CONNECT])
    expect(logged.text()).not.toContain(link.searchParams.get('state'))
  })

  it('is that a token was revoked, when a new link takes the place of a sign-in that held a mailbox', async () => {
    const chat = openChat()
    await signIn(chat, 'jane@example.test')
    const logged = catchConsole()

    await chat.say('/connect')

    expect(logged.events()).toEqual([
      { event: 'token_revoke', outcome: 'revoked' },
      { event: 'connect_link', user: await chat.userId() },
      CONNECT,
    ])
  })

  it('is nothing for a link that is only opened, however often', async () => {
    const link = linkIn(await openChat().say('/connect'))
    const logged = catchConsole()

    await open(link)
    await open(new URL('https://spend-tracker.test/oauth/start?state=made-up-state'))

    expect(logged.events()).toEqual([])
  })

  it('is every step from the link to the disconnection, and nothing that lets anyone in or names a mailbox', async () => {
    const logged = catchConsole()
    const chat = openChat()
    const userId = await chat.userId()
    const link = linkIn(await chat.say('/connect'))
    const state = link.searchParams.get('state') ?? ''
    const verifier = (await attemptOf(userId))?.code_verifier ?? ''

    await open(link)
    const code = await codeOn(await approve(link, 'jane@example.test'))
    await chat.say(otherThan(code))
    await chat.say(code)
    await chat.say('/disconnect')

    // Each message that was sent to the bot on the way has its line too, after the lines of what it did.
    expect(logged.events()).toEqual([
      { event: 'connect_link', user: userId },
      CONNECT,
      { event: 'connect_callback', outcome: 'code_shown', user: userId },
      { event: 'connect_code', user: userId, outcome: 'wrong', tries_left: 4 },
      came({ kind: 'code' }),
      { event: 'connect_code', user: userId, outcome: 'connected' },
      came({ kind: 'code' }),
      { event: 'token_revoke', outcome: 'revoked' },
      { event: 'disconnect', user: userId, outcome: 'disconnected' },
      came({ kind: 'command', command: 'disconnect' }),
    ])
    const never = [state, verifier, code, 'code-for-', 'jane', 'example.test', 'refresh-token', 'access-token']
    for (const text of [...never, outside.issued[0], String(chat.telegramId), env.GOOGLE_CLIENT_SECRET]) {
      expect(logged.text()).not.toContain(text)
    }
  })
})

describe('GET /oauth/start', () => {
  it("redirects to Google with the link's state and the challenge of the stored verifier", async () => {
    const chat = openChat()
    const link = linkIn(await chat.say('/connect'))
    const verifier = (await attemptOf(await chat.userId()))?.code_verifier ?? ''

    const response = await open(link)

    expect(response.status).toBe(302)
    const google = new URL(response.headers.get('location') ?? '')
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(google.searchParams)).toEqual({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: 'https://spend-tracker.test/oauth/callback',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: link.searchParams.get('state'),
      code_challenge: (await sha256(verifier)).toBase64({ alphabet: 'base64url', omitPadding: true }),
      code_challenge_method: 'S256',
    })
  })

  it('answers the same however often the link is fetched, and changes nothing', async () => {
    const chat = openChat()
    const link = linkIn(await chat.say('/connect'))
    const before = await attemptOf(await chat.userId())

    const responses = [await open(link), await open(link), await open(link)]

    expect(responses.map((response) => response.status)).toEqual([302, 302, 302])
    expect(new Set(responses.map((response) => response.headers.get('location'))).size).toBe(1)
    expect(await attemptOf(await chat.userId())).toEqual(before)
    // Fetching the link is not signing in: the sign-in still goes through afterwards.
    expect((await approve(link, 'jane@example.test')).status).toBe(200)
  })

  it.each([
    ['a state it does not know', '?state=made-up-state'],
    ['an empty state', '?state='],
    ['no state', ''],
  ])('shows the expired page for %s', async (_, query) => {
    const response = await open(new URL(`https://spend-tracker.test/oauth/start${query}`))

    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
    const html = await response.text()
    expect(html).toContain('This link has expired')
    expect(html).toContain('Send /connect to the bot for a new one.')
  })

  it('works up to ten minutes after the link was made, and not from then on', async () => {
    const link = linkIn(await openChat().say('/connect'))

    clock.now = new Date(NOW.getTime() + 10 * MINUTE - 1000)
    expect((await open(link)).status).toBe(302)

    clock.now = new Date(NOW.getTime() + 10 * MINUTE)
    const response = await open(link)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('This link has expired')
  })

  it('shows the expired page once Google has redirected back from the link', async () => {
    const link = linkIn(await openChat().say('/connect'))
    await approve(link, 'jane@example.test')

    const response = await open(link)

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('This link has expired')
  })
})

describe('through the Worker', () => {
  /** Posts a message to the webhook as Telegram would, and returns what the bot then sent to Telegram. */
  async function tell(telegramId: number, text: string): Promise<string> {
    const message = { message_id: 1, text, chat: { id: telegramId, type: 'private' }, from: { id: telegramId } }
    const response = await exports.default.fetch('https://spend-tracker.test/telegram', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify({ update_id: 1, message }),
    })
    expect(response.status).toBe(200)
    return outside.telegrams.at(-1)?.text ?? ''
  }

  it('connects a mailbox, from /connect to the code', async () => {
    const telegramId = newTelegramId()

    const link = linkIn(await tell(telegramId, '/connect'))
    const started = await exports.default.fetch(link.href, { redirect: 'manual' })
    expect(started.status).toBe(302)
    const google = new URL(started.headers.get('location') ?? '')
    expect(google.searchParams.get('redirect_uri')).toBe('https://spend-tracker.test/oauth/callback')

    const state = google.searchParams.get('state') ?? ''
    const sentBack = new URLSearchParams({ state, code: 'code-for-jane@example.test' })
    const page = await exports.default.fetch(`https://spend-tracker.test/oauth/callback?${sentBack}`)
    expect(page.status).toBe(200)
    expect(outside.telegrams.at(-1)).toEqual({
      chat_id: telegramId,
      text: expect.stringContaining('Google sign-in has finished'),
      link_preview_options: { is_disabled: true },
    })

    expect(await tell(telegramId, await codeOn(page))).toContain('Connected jane@example.test')
    expect(await tell(telegramId, '/disconnect')).toContain('Disconnected jane@example.test')
    expect(outside.revoked).toEqual([outside.issued[0]])
  })

  it('answers each of the two sign-in addresses with its own page', async () => {
    const link = linkIn(await tell(newTelegramId(), '/connect'))
    const denied = new URLSearchParams({ state: link.searchParams.get('state') ?? '', error: 'access_denied' })

    const start = await exports.default.fetch('https://spend-tracker.test/oauth/start?state=made-up-state')
    const callback = await exports.default.fetch(`https://spend-tracker.test/oauth/callback?${denied}`)

    expect(start.status).toBe(400)
    expect(await start.text()).toContain('This link has expired')
    expect(callback.status).toBe(400)
    expect(await callback.text()).toContain('Sign-in was not completed')
  })
})
