import type { GoogleClient } from './google/oauth'
import { telegramMessenger, type Messenger } from './telegram/api'

/**
 * What the bot, the sign-in endpoints, the mail checker and the MCP endpoint work with. Tests put their own
 * messenger and clock in.
 */
export interface Deps {
  db: D1Database
  messenger: Messenger
  now: () => Date
  google: GoogleClient
  /** Base64 of the 32-byte key that stored refresh tokens are encrypted with. */
  tokenKey: string
  /** Where the service is reached, with no trailing slash. */
  baseUrl: string
}

export function depsFor(env: Env): Deps {
  return {
    db: env.DB,
    messenger: telegramMessenger(env.TELEGRAM_BOT_TOKEN),
    now: () => new Date(),
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: `${env.PUBLIC_BASE_URL}/oauth/callback`,
    },
    tokenKey: env.TOKEN_ENCRYPTION_KEY,
    baseUrl: env.PUBLIC_BASE_URL,
  }
}
