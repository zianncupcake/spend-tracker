// Bindings and secrets of the Worker. Keep in step with wrangler.example.jsonc
// and .dev.vars.example.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    TELEGRAM_BOT_TOKEN: string
    TELEGRAM_WEBHOOK_SECRET: string
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
    TOKEN_ENCRYPTION_KEY: string
    PUBLIC_BASE_URL: string
    OPERATOR_NAME: string
    OPERATOR_CONTACT: string
    // The three of the bot's assistant. With no key, the bot has no assistant. The other two have defaults.
    AI_API_KEY?: string
    AI_BASE_URL?: string
    AI_MODEL?: string
    // The model that reads photos, which is asked with the same key at the same address. It has a default only
    // when AI_BASE_URL is left out.
    AI_VISION_MODEL?: string
    // A second key, of another account at the same provider, asked when the first has had as many requests as it
    // takes (429).
    AI_FALLBACK_API_KEY?: string
  }
  interface GlobalProps {
    mainModule: typeof import('./index')
  }
}

interface Env extends Cloudflare.Env {}
