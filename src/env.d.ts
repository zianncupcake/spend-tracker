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
  }
  interface GlobalProps {
    mainModule: typeof import('./index')
  }
}

interface Env extends Cloudflare.Env {}
