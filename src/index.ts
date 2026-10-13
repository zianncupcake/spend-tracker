import { runCheck } from './checker'
import { oauthCallback, oauthStart } from './connect'
import { depsFor } from './deps'
import { log, logFailure } from './log'
import { serveMcp } from './mcp/server'
import { userOfToken } from './mcp/tokens'
import { homePage, privacyPage } from './pages'
import { sendDueReminder } from './reminders'
import { reviewDueUser } from './review'
import { handleUpdate, type Update } from './telegram/handler'

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url)
    const operator = { name: env.OPERATOR_NAME, contact: env.OPERATOR_CONTACT }

    switch (`${request.method} ${pathname}`) {
      case 'POST /telegram':
        return telegramWebhook(request, env, ctx)
      case 'GET /':
        return homePage(operator)
      case 'GET /privacy': {
        // The policy says what becomes of a question only when the bot has an assistant to answer one, and what
        // becomes of a photo only when the bot has a model that reads one.
        const { ai } = depsFor(env)
        return privacyPage(operator, ai !== undefined, ai?.visionModel !== undefined)
      }
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
          log('mcp_refused', { why: 'wrong_method' })
          return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'POST' } })
        }
        return new Response('Not found\n', { status: 404 })
    }
  },

  /**
   * The cron trigger: every run sends one reminder that is due, makes one user's monthly review that is due, and
   * then checks one connected mailbox for new bank alerts. None of the three throws, so nothing about the first two
   * keeps the mail from being checked.
   */
  scheduled(_controller, env, ctx): void {
    const deps = depsFor(env)
    ctx.waitUntil(
      sendDueReminder(deps)
        .then(() => reviewDueUser(deps))
        .then(() => runCheck(deps)),
    )
  },
} satisfies ExportedHandler<Env>

async function telegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (!(await secretsMatch(secret, env.TELEGRAM_WEBHOOK_SECRET))) {
    // Which of the two it was, and nothing of the secret that came.
    log('webhook_refused', { why: secret ? 'wrong_secret' : 'no_secret' })
    return new Response('Unauthorized\n', { status: 401 })
  }

  // By the Worker's own clock, for the one line that is written here: see below.
  const began = Date.now()
  try {
    const update = await request.json<Update>()
    const later = await handleUpdate(depsFor(env), update)
    // What is left is the answering of a question, which takes a model some seconds. Telegram resends an update
    // that it has waited too long to hear of, too. So that goes on after this response, for as long as a Worker is
    // given for it: 30 seconds.
    if (later) ctx.waitUntil(later())
  } catch (error) {
    // Telegram resends an update until it gets a 200, so a failure is logged and still acknowledged. What fails
    // here is the reading of a body that is not JSON: the handling of an update logs what came of it, and does not
    // throw. Only the error's name is logged: an error message can quote its input, and message text must never
    // reach the logs.
    const ms = Date.now() - began
    logFailure('update', error, { kind: 'unreadable', outcome: 'failed', handled: false, told: false, ms })
  }
  return new Response('ok\n')
}

/** The MCP endpoint, where a user's AI assistant reads their card totals and purchases. Its token says whose. */
async function mcpEndpoint(request: Request, env: Env): Promise<Response> {
  // A browser says which site's page a request comes from, and an assistant says nothing of the kind. MCP has a
  // server refuse a request from an origin it does not expect, and no other site's page has any business here.
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== new URL(env.PUBLIC_BASE_URL).origin) {
    log('mcp_refused', { why: 'wrong_origin' })
    return new Response('Forbidden\n', { status: 403 })
  }

  const deps = depsFor(env)
  const token = /^Bearer (\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1]
  const user = token ? await userOfToken(deps.db, token) : null
  if (!user) {
    // Whether a token came, and nothing of one that did.
    log('mcp_refused', { why: token ? 'unknown_token' : 'no_token' })
    return new Response('Unauthorized\n', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
  }
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
