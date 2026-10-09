// The token that lets a user's AI assistant in. It is a bearer token: whoever
// holds it can read that user's card totals and purchases. So it is shown to
// its user once, and only its SHA-256 hash is stored.

import type { User } from '../store'
import { findUserByTokenHash, mcpStoreFor } from '../store-mcp'

/** Tells a person, or a scanner for leaked secrets, what a token is for. */
const PREFIX = 'stmcp_'

/** Makes a new token for the user, in place of any they had, and returns it. It cannot be read back later. */
export async function issueToken(db: D1Database, userId: number): Promise<string> {
  // 32 random bytes in base64url: 43 characters after the prefix.
  const secret = crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: 'base64url', omitPadding: true })
  const token = PREFIX + secret
  await mcpStoreFor(db, userId).setToken(await sha256(token))
  return token
}

/** The user that a token lets in, or null when it is nobody's. */
export async function userOfToken(db: D1Database, token: string): Promise<User | null> {
  return findUserByTokenHash(db, await sha256(token))
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return new Uint8Array(digest).toHex()
}
