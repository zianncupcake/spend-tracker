import { runCheck } from './checker'
import { oauthCallback, oauthStart } from './connect'
import { depsFor } from './deps'
import { serveMcp } from './mcp/server'
import { userOfToken } from './mcp/tokens'
import { homePage, privacyPage } from './pages'
import { handleUpdate, type Update } from './telegram/handler'

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url)
    const operator = { name: env.OPERATOR_NAME, contact: env.OPERATOR_CONTACT }

    switch (`${request.method} ${pathname}`) {
      case 'POST /telegram':
        return telegramWebhook(request, env)
      case 'GET /':
        return homePage(operator)
      case 'GET /privacy':
        return privacyPage(operator)
      case 'GET /oauth/start':
        return oauthStart(depsFor(env), searchParams)
      case 'GET /oauth/callback':
        return oauthCallback(depsFor(env), searchParams)
      case 'POST /mcp':
        return mcpEndpoint(request, env)
      default:
        // MCP has a client ask with GET for a stream of what the server has to say, and end a session with
        // DELETE. This endpoint has neither a stream nor sessions, and 405 is how the protocol has it say so.
        if (pathname === '/mcp') {
          return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'POST' } })
        }
        return new Response('Not found\n', { status: 404 })
    }
  },

  /** The cron trigger: every run checks one connected mailbox for new bank alerts. */
  scheduled(_controller, env, ctx): void {
    ctx.waitUntil(runCheck(depsFor(env)))
  },
} satisfies ExportedHandler<Env>

async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (!(await secretsMatch(secret, env.TELEGRAM_WEBHOOK_SECRET))) {
    return new Response('Unauthorized\n', { status: 401 })
  }

  try {
    const update = await request.json<Update>()
    await handleUpdate(depsFor(env), update)
  } catch (error) {
    // Telegram resends an update until it gets a 200, so a failure is logged
    // and still acknowledged. Only the error's name is logged: an error
    // message can quote its input, and message text must never reach the logs.
    console.error('telegram update failed:', error instanceof Error ? error.name : typeof error)
  }
  return new Response('ok\n')
}

/** The MCP endpoint, where a user's AI assistant reads their card totals and purchases. Its token says whose. */
async function mcpEndpoint(request: Request, env: Env): Promise<Response> {
  // A browser says which site's page a request comes from, and an assistant says nothing of the kind. MCP has a
  // server refuse a request from an origin it does not expect, and no other site's page has any business here.
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== new URL(env.PUBLIC_BASE_URL).origin) {
    return new Response('Forbidden\n', { status: 403 })
  }

  const deps = depsFor(env)
  const token = /^Bearer (\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1]
  const user = token ? await userOfToken(deps.db, token) : null
  if (!user) return new Response('Unauthorized\n', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
  return serveMcp(deps, user, request)
}

/** Constant-time comparison. Hashing first gives both sides the same length. */
async function secretsMatch(provided: string | null, expected: string | undefined): Promise<boolean> {
  if (!provided || !expected) return false
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  return crypto.subtle.timingSafeEqual(a, b)
}
