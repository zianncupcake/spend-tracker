import { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_VISION_MODEL, type AiProvider } from './ai/provider'
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
  /**
   * The AI provider that the bot's assistant asks for its answers. Missing when the service is set up with no key
   * for one: the bot then has no assistant, for anybody.
   */
  ai?: AiProvider
  /**
   * Cloudflare's id of the request that is being handled, which Workers Logs keeps as `$metadata.rayId` with each of
   * its lines. A reply that says something failed ends with it: see failureReply in ./telegram/texts. Missing outside
   * a request, and for a request that did not come through Cloudflare.
   */
  ray?: string
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
    // A setting that is left empty counts as one that is not set.
    ai: env.AI_API_KEY
      ? {
          apiKey: env.AI_API_KEY,
          fallbackApiKey: env.AI_FALLBACK_API_KEY || undefined,
          baseUrl: env.AI_BASE_URL || DEFAULT_BASE_URL,
          model: env.AI_MODEL || DEFAULT_MODEL,
          // The default is a model of the default provider's, and its name means nothing to another one. So a
          // service that names its own provider reads photos only when it names the model for that too.
          visionModel: env.AI_VISION_MODEL || (env.AI_BASE_URL ? undefined : DEFAULT_VISION_MODEL),
        }
      : undefined,
  }
}
