import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authorizationUrl,
  exchangeCode,
  fetchEmailAddress,
  GMAIL_READONLY,
  revokeToken,
  type GoogleClient,
} from '../src/google/oauth'

const client: GoogleClient = {
  clientId: 'made-up-client-id',
  clientSecret: 'made-up-client-secret',
  redirectUri: 'https://spend-tracker.test/oauth/callback',
}

// Google is reached with the global fetch. It is replaced here, as
// test/webhook.test.ts does for Telegram, so nothing is sent to Google.
const google = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  google.mockReset()
  vi.stubGlobal('fetch', google)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The form that the one request to Google posted. */
function postedForm(): Record<string, string> {
  expect(google).toHaveBeenCalledTimes(1)
  const [, init] = google.mock.calls[0]
  expect(init?.method).toBe('POST')
  return Object.fromEntries(init?.body as URLSearchParams)
}

describe('the authorisation URL', () => {
  // The verifier and its S256 challenge are the example in RFC 7636, appendix B.
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

  it('asks Google for lasting, read-only Gmail access, with the state and a PKCE challenge', async () => {
    const url = new URL(await authorizationUrl(client, 'made-up-state', VERIFIER))

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'made-up-client-id',
      redirect_uri: 'https://spend-tracker.test/oauth/callback',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: 'made-up-state',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    })
  })

  it('holds neither the verifier nor the client secret, and asks Google for nothing', async () => {
    const url = await authorizationUrl(client, 'made-up-state', VERIFIER)

    expect(url).not.toContain(VERIFIER)
    expect(url).not.toContain(client.clientSecret)
    expect(google).not.toHaveBeenCalled()
  })
})

describe('exchanging a code', () => {
  it('posts the code and the verifier to the token endpoint, and returns what Google granted', async () => {
    google.mockResolvedValue(
      Response.json({
        access_token: 'made-up-access-token',
        expires_in: 3599,
        refresh_token: 'made-up-refresh-token',
        scope: `openid ${GMAIL_READONLY}`,
        token_type: 'Bearer',
      }),
    )

    const tokens = await exchangeCode(client, 'made-up-code', 'made-up-verifier')

    expect(tokens).toEqual({
      accessToken: 'made-up-access-token',
      refreshToken: 'made-up-refresh-token',
      scopes: ['openid', GMAIL_READONLY],
    })
    expect(google.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token')
    expect(postedForm()).toEqual({
      grant_type: 'authorization_code',
      code: 'made-up-code',
      code_verifier: 'made-up-verifier',
      client_id: 'made-up-client-id',
      client_secret: 'made-up-client-secret',
      redirect_uri: 'https://spend-tracker.test/oauth/callback',
    })
  })

  it('reports a refresh token and a scope that Google left out as missing', async () => {
    google.mockResolvedValue(Response.json({ access_token: 'made-up-access-token', token_type: 'Bearer' }))

    const tokens = await exchangeCode(client, 'made-up-code', 'made-up-verifier')

    expect(tokens).toEqual({ accessToken: 'made-up-access-token', refreshToken: undefined, scopes: [] })
  })

  it('throws when Google refuses, with nothing of the request or the response in the error', async () => {
    google.mockResolvedValue(Response.json({ error: 'invalid_grant', error_description: 'Bad code' }, { status: 400 }))

    const failure = await exchangeCode(client, 'made-up-code', 'made-up-verifier').catch((error: Error) => error)

    expect(failure).toEqual(new Error('Google token exchange failed with status 400'))
  })

  it('throws when the response holds no access token', async () => {
    google.mockResolvedValue(Response.json({ refresh_token: 'made-up-refresh-token' }))

    await expect(exchangeCode(client, 'made-up-code', 'made-up-verifier')).rejects.toThrow('no access token')
  })
})

describe('the mailbox address', () => {
  it('is read from the Gmail profile with the access token', async () => {
    google.mockResolvedValue(Response.json({ emailAddress: 'jane@example.test', messagesTotal: 12 }))

    expect(await fetchEmailAddress('made-up-access-token')).toBe('jane@example.test')

    expect(google).toHaveBeenCalledTimes(1)
    const [url, init] = google.mock.calls[0]
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile')
    expect(init?.method).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer made-up-access-token')
  })

  it('throws when Google refuses, or sends no address', async () => {
    google.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
    google.mockResolvedValueOnce(Response.json({ messagesTotal: 12 }))

    await expect(fetchEmailAddress('made-up-access-token')).rejects.toThrow(
      'Gmail profile request failed with status 403',
    )
    await expect(fetchEmailAddress('made-up-access-token')).rejects.toThrow('Gmail profile held no address')
  })
})

describe('revoking a token', () => {
  it('posts the token in the body, and keeps it out of the URL', async () => {
    google.mockResolvedValue(Response.json({}))

    await revokeToken('made-up-refresh-token')

    expect(google.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/revoke')
    expect(postedForm()).toEqual({ token: 'made-up-refresh-token' })
  })

  it('throws when Google refuses, without the token in the error', async () => {
    google.mockResolvedValue(Response.json({ error: 'invalid_token' }, { status: 400 }))

    const failure = await revokeToken('made-up-refresh-token').catch((error: Error) => error)

    expect(failure).toEqual(new Error('Google token revocation failed with status 400'))
  })
})
