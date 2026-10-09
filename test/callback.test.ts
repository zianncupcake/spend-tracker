import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { oauthCallback } from '../src/connect'
import { GMAIL_READONLY } from '../src/google/oauth'
import {
  approve,
  attemptOf,
  clock,
  codeOn,
  connectionOf,
  deps,
  linkIn,
  MINUTE,
  NOW,
  open,
  openChat,
  outside,
  PROFILE_URL,
  sent,
  sha256,
  signIn,
  TOKEN_URL,
  tokenIn,
} from './connect-helpers'

// GET /oauth/callback: where Google sends the browser back to.

it('holds the mailbox for its code: stores it encrypted, tells the chat and shows the code', async () => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  const userId = await chat.userId()
  const verifier = (await attemptOf(userId))?.code_verifier
  clock.now = new Date(NOW.getTime() + 4 * MINUTE)

  const page = await approve(link, 'jane@example.test')

  // The browser is shown the code, on a page that is not to be kept.
  expect(page.status).toBe(200)
  expect(page.headers.get('cache-control')).toBe('no-store')
  expect(page.headers.get('referrer-policy')).toBe('no-referrer')
  const code = await codeOn(page)

  // Google's code was exchanged with the verifier that was kept for this link.
  expect(outside.exchanges).toEqual([
    {
      grant_type: 'authorization_code',
      code: 'code-for-jane@example.test',
      code_verifier: verifier,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'https://spend-tracker.test/oauth/callback',
    },
  ])

  // The attempt now holds the mailbox with its token encrypted, a hash of the code, and ten more minutes.
  const attempt = await attemptOf(userId)
  expect(attempt).toMatchObject({
    email: 'jane@example.test',
    confirm_code_hash: (await sha256(code)).toHex(),
    confirm_tries: 0,
    expires_at: clock.now.getTime() / 1000 + 600,
  })
  expect(attempt?.refresh_token_enc).not.toContain(outside.issued[0])
  expect(await tokenIn(attempt)).toBe(outside.issued[0])

  // Nothing is connected until the code comes back.
  expect(await connectionOf(userId)).toBeNull()

  // The chat is told, with neither the address nor the code.
  expect(sent).toHaveLength(1)
  expect(sent[0].chatId).toBe(chat.telegramId)
  expect(sent[0].text).toBe(
    'Google sign-in has finished. To connect your Gmail, send here the 6-digit code that your browser is showing, ' +
      'within 10 minutes. If that was not you, ignore this message: nothing is connected without the code.',
  )
  expect(sent[0].text).not.toContain(code)
})

it('tells the chat nothing of the address that was signed in with, which may be that of somebody else', async () => {
  const attacker = openChat()
  const link = linkIn(await attacker.say('/connect'))

  // The link is opened by somebody else, who signs in with a mailbox of their own.
  await approve(link, 'victim@example.test')

  expect(sent).toHaveLength(1)
  expect(sent[0].chatId).toBe(attacker.telegramId)
  // Not its name, not its domain, and no sign of an address with a part of it hidden.
  const text = sent[0].text.toLowerCase()
  for (const part of ['victim', 'example', 'test', '@', '•']) expect(text).not.toContain(part)
})

it('shows a code of its own for every sign-in', async () => {
  const codes = new Set<string>()
  for (let signIns = 1; signIns <= 5; signIns++) codes.add(await signIn(openChat(), 'jane@example.test'))

  // Five codes that are all the same would be a chance of one in 10^24.
  expect(codes.size).toBeGreaterThan(1)
})

it.each<[what: string, sentBack: Record<string, string>]>([
  ['an error', { error: 'access_denied' }],
  ['an error and a code', { error: 'access_denied', code: 'code-for-jane@example.test' }],
  ['neither a code nor an error', {}],
])('shows that sign-in was not completed when Google sends %s, and leaves the link working', async (_, sentBack) => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  const state = link.searchParams.get('state') ?? ''

  const page = await oauthCallback(deps, new URLSearchParams({ state, ...sentBack }))

  expect(page.status).toBe(400)
  expect(await page.text()).toContain('Sign-in was not completed')
  expect(outside.exchanges).toEqual([])
  expect(sent).toEqual([])
  expect(await attemptOf(await chat.userId())).toMatchObject({ email: null, confirm_code_hash: null })
  expect((await open(link)).status).toBe(302)
})

it('connects nothing when Google gives no refresh token', async () => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  outside.grant = { refresh_token: undefined }

  const page = await approve(link, 'jane@example.test')

  expect(page.status).toBe(400)
  expect(await page.text()).toContain('Google gave no lasting access')
  expect(sent).toEqual([])
  expect(await attemptOf(await chat.userId())).toMatchObject({ email: null, refresh_token_enc: null })
  expect(await connectionOf(await chat.userId())).toBeNull()
})

it.each([
  ['no scope', undefined],
  ['only another scope', 'openid'],
  ['a scope that only starts like the Gmail one', `${GMAIL_READONLY}.metadata`],
])('connects nothing when Google grants %s', async (_, scope) => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  outside.grant = { scope }

  const page = await approve(link, 'jane@example.test')

  expect(page.status).toBe(400)
  expect(await page.text()).toContain('Gmail access was not given')
  expect(sent).toEqual([])
  expect(await attemptOf(await chat.userId())).toMatchObject({ email: null, refresh_token_enc: null })
  expect(await connectionOf(await chat.userId())).toBeNull()
})

it('accepts the Gmail scope among others', async () => {
  const link = linkIn(await openChat().say('/connect'))
  outside.grant = { scope: `openid ${GMAIL_READONLY}` }

  expect((await approve(link, 'jane@example.test')).status).toBe(200)
})

it('rejects a state that has been used, whoever brings it back', async () => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  const shown = await approve(link, 'jane@example.test')
  const held = await attemptOf(await chat.userId())
  sent.length = 0

  const replay = await approve(link, 'sam@example.test')

  expect(replay.status).toBe(400)
  const html = await replay.text()
  expect(html).toContain('This link has expired')
  expect(html).not.toContain('class="code"')
  expect(outside.exchanges).toHaveLength(1) // the second code never reached Google
  expect(sent).toEqual([])
  expect(await attemptOf(await chat.userId())).toEqual(held)
  // The code that was shown the first time is still the one that connects.
  expect(await chat.say(await codeOn(shown))).toContain('Connected jane@example.test')
})

it('lets only the first of two redirects that arrive together take its code to Google', async () => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  let second: Response | undefined
  // While the first redirect's code is with Google, a second redirect for the same link runs to its end.
  outside.meanwhile = async () => {
    second = await approve(link, 'sam@example.test')
  }

  const first = await approve(link, 'jane@example.test')

  expect(first.status).toBe(200)
  expect(second?.status).toBe(400)
  expect(await second?.text()).toContain('This link has expired')
  expect(outside.exchanges.map((form) => form.code)).toEqual(['code-for-jane@example.test'])
  expect(sent).toHaveLength(1)
  expect(await attemptOf(await chat.userId())).toMatchObject({ email: 'jane@example.test' })
})

it('takes a state to Google once and no more, though Google refused the code that came with it', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const asked = vi.spyOn(globalThis, 'fetch')
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  outside.failing.add(TOKEN_URL)
  expect((await approve(link, 'made-up@example.test')).status).toBe(500)
  outside.failing.clear()

  // The link's state again, as often as anyone cares to send it, and each time with another code to try.
  const again = [await approve(link, 'jane@example.test'), await approve(link, 'sam@example.test')]

  for (const page of again) {
    expect(page.status).toBe(400)
    expect(await page.text()).toContain('This link has expired')
  }
  expect(asked.mock.calls.filter(([url]) => url === TOKEN_URL)).toHaveLength(1)
  expect((await open(link)).status).toBe(400)
  expect(await attemptOf(await chat.userId())).toMatchObject({ claimed: 1, email: null, refresh_token_enc: null })

  // The user starts again with /connect.
  const newLink = linkIn(await chat.say('/connect'))
  expect(await chat.say(await codeOn(await approve(newLink, 'jane@example.test')))).toContain('Connected')
})

it('holds nothing for a link that was replaced while its owner was at Google', async () => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  let newLink = link
  outside.meanwhile = async () => {
    newLink = linkIn(await chat.say('/connect'))
  }

  const page = await approve(link, 'jane@example.test')

  expect(page.status).toBe(400)
  expect(await page.text()).toContain('This link has expired')
  expect(sent).toEqual([])
  expect(newLink.href).not.toBe(link.href)
  expect(await attemptOf(await chat.userId())).toMatchObject({ email: null, confirm_code_hash: null })
  expect((await open(newLink)).status).toBe(302)
})

it.each<[what: string, sentBack: Record<string, string>]>([
  ['a state it does not know', { state: 'made-up-state' }],
  ['no state', {}],
])('shows the expired page for %s, and asks Google nothing', async (_, sentBack) => {
  const page = await oauthCallback(deps, new URLSearchParams({ ...sentBack, code: 'code-for-jane@example.test' }))

  expect(page.status).toBe(400)
  expect(await page.text()).toContain('This link has expired')
  expect(outside.exchanges).toEqual([])
})

it('shows the expired page for a link that is ten minutes old, and asks Google nothing', async () => {
  const link = linkIn(await openChat().say('/connect'))
  clock.now = new Date(NOW.getTime() + 10 * MINUTE)

  const page = await approve(link, 'jane@example.test')

  expect(page.status).toBe(400)
  expect(await page.text()).toContain('This link has expired')
  expect(outside.exchanges).toEqual([])
  expect(sent).toEqual([])
})

it.each([
  ['refuses the code', TOKEN_URL],
  ['will not give the address', PROFILE_URL],
])('shows a failure page when Google %s, stores nothing and logs only that it failed', async (_, endpoint) => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  outside.failing.add(endpoint)

  const page = await approve(link, 'jane@example.test')

  expect(page.status).toBe(500)
  expect(await page.text()).toContain('Sign-in could not be completed')
  expect(logged.mock.calls).toEqual([['google sign-in failed:', 'Error']])
  expect(sent).toEqual([])
  expect(await attemptOf(await chat.userId())).toMatchObject({ email: null, refresh_token_enc: null })
})
