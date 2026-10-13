import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { oauthCallback } from '../src/connect'
import { GMAIL_READONLY } from '../src/google/oauth'
import { TelegramError } from '../src/telegram/api'
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
import { catchConsole } from './log-helpers'

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

it('shows the expired page for a state it does not know, and asks Google nothing', async () => {
  const params = new URLSearchParams({ state: 'made-up-state', code: 'code-for-jane@example.test' })
  const page = await oauthCallback(deps, params)

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
  ['refuses the code', TOKEN_URL, 'exchange'],
  ['will not give the address', PROFILE_URL, 'profile'],
])('shows a failure page when Google %s, stores nothing and logs only where it failed', async (_, endpoint, stage) => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  const userId = await chat.userId()
  outside.failing.add(endpoint)
  const logged = catchConsole()

  const page = await approve(link, 'jane@example.test')

  expect(page.status).toBe(500)
  expect(await page.text()).toContain('Sign-in could not be completed')
  // What was being done, why it failed and the status of Google's answer: nothing of what the answer said.
  const failure = { error: 'Error', reason: 'http_error', status: 400 }
  expect(logged.events()).toEqual([{ event: 'connect_callback', outcome: 'failed', user: userId, stage, ...failure }])
  expect(logged.text()).not.toContain('made_up_error')
  expect(sent).toEqual([])
  expect(await attemptOf(userId)).toMatchObject({ email: null, refresh_token_enc: null })
})

it.each<[stage: string, when: string, statement: string, whose: 'known' | 'not known']>([
  ['claim', 'the sign-in cannot be claimed', 'SET claimed = 1', 'not known'],
  ['hold', 'the mailbox cannot be kept for its code', 'SET email = ?', 'known'],
])('shows a failure page and logs that it failed at "%s", when %s', async (stage, _, statement, whose) => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  const userId = await chat.userId()
  const prepare = env.DB.prepare.bind(env.DB)
  vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
    if (query.includes(statement)) throw new Error('A made-up failure of the database that quotes jane@example.test')
    return prepare(query)
  })
  const logged = catchConsole()

  const page = await approve(link, 'jane@example.test')

  expect(page.status).toBe(500)
  expect(await page.text()).toContain('Sign-in could not be completed')
  // Whose sign-in it was is known once the sign-in has been claimed, and not before.
  const user = whose === 'known' ? { user: userId } : {}
  expect(logged.events()).toEqual([{ event: 'connect_callback', outcome: 'failed', ...user, stage, error: 'Error' }])
  expect(logged.text()).not.toContain('jane')
  expect(sent).toEqual([])
})

it('logs a redirect that the chat could not be told of as one that failed, with where and the status', async () => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  vi.spyOn(deps.messenger, 'send').mockRejectedValue(new TelegramError('sendMessage', 502))
  const logged = catchConsole()

  const page = await approve(link, 'jane@example.test')

  expect(page.status).toBe(500)
  const failure = { stage: 'notify', error: 'Error', reason: 'http_error', status: 502 }
  expect(logged.events()).toEqual([
    { event: 'connect_callback', outcome: 'failed', user: await chat.userId(), ...failure },
  ])
})

type Chat = ReturnType<typeof openChat>

/** Google sending a browser back with something else than a code that it gave for the link. */
function sentBack(link: URL, params: Record<string, string>): Promise<Response> {
  return oauthCallback(deps, new URLSearchParams({ state: link.searchParams.get('state') ?? '', ...params }))
}

it.each<[outcome: string, when: string, whose: 'known' | 'unknown', redirect: (link: URL, chat: Chat) => unknown]>([
  [
    'no_gmail_access',
    'Google gave another permission',
    'known',
    (link) => {
      outside.grant = { scope: 'openid' }
      return approve(link, 'jane@example.test')
    },
  ],
  [
    'no_lasting_access',
    'Google gave no refresh token',
    'known',
    (link) => {
      outside.grant = { refresh_token: undefined }
      return approve(link, 'jane@example.test')
    },
  ],
  [
    'replaced',
    'the link was replaced while its owner was at Google',
    'known',
    (link, chat) => {
      outside.meanwhile = () => chat.say('/connect')
      return approve(link, 'jane@example.test')
    },
  ],
])('logs %s for a redirect when %s, with whose sign-in it was %s', async (outcome, _, whose, redirect) => {
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  const logged = catchConsole()

  await redirect(link, chat)

  // A sign-in is known by its state. A redirect that brings none that works is nobody's.
  const user = whose === 'known' ? { user: await chat.userId() } : {}
  expect(logged.events('connect_callback')).toEqual([{ event: 'connect_callback', outcome, ...user }])
})

it('logs nothing of a redirect that lets anyone in, or that says whose mailbox it was', async () => {
  const logged = catchConsole()
  const chat = openChat()
  const link = linkIn(await chat.say('/connect'))
  const state = link.searchParams.get('state') ?? ''
  const verifier = (await attemptOf(await chat.userId()))?.code_verifier ?? ''

  const code = await codeOn(await approve(link, 'jane@example.test'))
  await approve(link, 'sam@example.test')
  await sentBack(link, { error: 'access_denied', error_description: 'A made-up description' })

  expect(logged.events().map((event) => [event.event, event.outcome])).toEqual([
    ['connect_link', undefined],
    // The command that asked for the link.
    ['update', 'replied'],
    ['connect_callback', 'code_shown'],
    ['connect_callback', 'expired'],
    ['connect_callback', 'not_completed'],
  ])
  const never = [state, verifier, code, 'code-for-', 'jane', 'sam', 'example.test', 'access_denied', 'description']
  const secrets = [outside.issued[0], 'refresh-token', 'access-token', env.GOOGLE_CLIENT_SECRET]
  for (const text of [...never, ...secrets, String(chat.telegramId)]) expect(logged.text()).not.toContain(text)
})
