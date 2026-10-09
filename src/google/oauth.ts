// Google sign-in as a web server, with PKCE:
// https://developers.google.com/identity/protocols/oauth2/web-server

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'

/** Read-only access to Gmail: the one permission this service asks for. */
export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'

/** The OAuth client that users sign in through, as registered with Google. */
export interface GoogleClient {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface GrantedTokens {
  accessToken: string
  /** Missing when Google gave no lasting access. */
  refreshToken?: string
  scopes: string[]
}

/** The parts of Google's token response this service reads. All optional, because it arrives as unchecked JSON. */
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  scope?: string
}

/** Where to send a browser for the user to sign in and approve. */
export async function authorizationUrl(client: GoogleClient, state: string, codeVerifier: string): Promise<string> {
  // PKCE: Google gets the hash of the verifier now, and must be shown the verifier itself to exchange the code.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: GMAIL_READONLY,
    // Together these two make Google issue a refresh token every time, not only the first time a user approves.
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: new Uint8Array(digest).toBase64({ alphabet: 'base64url', omitPadding: true }),
    code_challenge_method: 'S256',
  })
  return `${AUTHORIZATION_URL}?${params}`
}

/** Exchanges the code that Google redirected back with. */
export async function exchangeCode(client: GoogleClient, code: string, codeVerifier: string): Promise<GrantedTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
    }),
  })
  // The request holds the client secret and the response can hold tokens, so neither goes into an error.
  if (!response.ok) throw new Error(`Google token exchange failed with status ${response.status}`)
  const { access_token, refresh_token, scope } = await response.json<TokenResponse>()
  if (typeof access_token !== 'string') throw new Error('Google token exchange returned no access token')
  return {
    accessToken: access_token,
    refreshToken: typeof refresh_token === 'string' ? refresh_token : undefined,
    scopes: typeof scope === 'string' ? scope.split(' ') : [],
  }
}

/** The address of the mailbox that an access token is for. */
export async function fetchEmailAddress(accessToken: string): Promise<string> {
  const response = await fetch(PROFILE_URL, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw new Error(`Gmail profile request failed with status ${response.status}`)
  const { emailAddress } = await response.json<{ emailAddress?: string }>()
  if (typeof emailAddress !== 'string') throw new Error('Gmail profile held no address')
  return emailAddress
}

/**
 * Revokes a token. Google ends the user's whole grant to this service with
 * it, so every other token issued for the same Google account stops working too.
 */
export async function revokeToken(token: string): Promise<void> {
  // The token goes in the body. A URL can end up in logs.
  const response = await fetch(REVOKE_URL, { method: 'POST', body: new URLSearchParams({ token }) })
  if (!response.ok) throw new Error(`Google token revocation failed with status ${response.status}`)
}
