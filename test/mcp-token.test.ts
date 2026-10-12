import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { openChat, sha256 } from './connect-helpers'
import { post, tokenFrom } from './mcp-helpers'

// The bot's side of the MCP endpoint: /mcp gives a user the token that lets
// their assistant in, and /mcp revoke takes it away.

const USAGE = 'Usage:\n/mcp\n/mcp revoke'

// Reads the table directly, so it also sees what a per-user store would never return.
function tokenRowOf(userId: number) {
  return env.DB.prepare('SELECT * FROM mcp_tokens WHERE owner_id = ?').bind(userId).first<Record<string, unknown>>()
}

/** Whether the endpoint lets an assistant with the token in. */
async function letsIn(token: string): Promise<boolean> {
  const response = await post(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  expect([200, 401]).toContain(response.status)
  return response.status === 200
}

describe('/mcp', () => {
  it('replies with a new token, where to use it and how to look after it', async () => {
    const reply = await openChat().say('/mcp')

    const token = tokenFrom(reply)
    expect(reply).toBe(
      [
        'Your assistant access token:',
        token,
        '',
        'It is shown only this once. Anyone who has it can read your card totals and purchases, so you may want to ' +
          'delete this message once you have copied the token. Sending /mcp again replaces it, and /mcp revoke ' +
          'removes it.',
        '',
        'To connect Claude Code, run:',
        'claude mcp add --transport http spend-tracker https://spend-tracker.test/mcp ' +
          `--header "Authorization: Bearer ${token}"`,
        '',
        'For another assistant, the MCP endpoint is https://spend-tracker.test/mcp and the token goes in the ' +
          'header "Authorization: Bearer <token>".',
      ].join('\n'),
    )
  })

  it('makes a token of 32 random bytes behind a prefix that says what it is, new every time', async () => {
    const tokens = new Set<string>()
    for (let chat = 1; chat <= 20; chat++) tokens.add(tokenFrom(await openChat().say('/mcp')))

    expect(tokens.size).toBe(20)
    for (const token of tokens) {
      expect(token.startsWith('stmcp_')).toBe(true)
      expect(Uint8Array.fromBase64(token.slice('stmcp_'.length), { alphabet: 'base64url' })).toHaveLength(32)
    }
  })

  it('stores the hash of the token, and not the token', async () => {
    const chat = openChat()

    const token = tokenFrom(await chat.say('/mcp'))

    expect(await tokenRowOf(await chat.userId())).toEqual({
      owner_id: await chat.userId(),
      token_hash: (await sha256(token)).toHex(),
      created_at: expect.any(Number),
    })
    // The token itself is in no table at all.
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'",
    ).all<{ name: string }>()
    expect(tables.results.map((table) => table.name)).toContain('mcp_tokens')
    for (const { name } of tables.results) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${name}`).all()
      expect(JSON.stringify(results)).not.toContain(token.slice('stmcp_'.length))
    }
  })

  it('lets an assistant with the token in at the endpoint', async () => {
    const token = tokenFrom(await openChat().say('/mcp'))

    expect(await letsIn(token)).toBe(true)
  })

  it('replaces the token when it is sent again, and the old one stops working', async () => {
    const chat = openChat()
    const bystander = openChat()
    const first = tokenFrom(await chat.say('/mcp'))
    const other = tokenFrom(await bystander.say('/mcp'))

    const second = tokenFrom(await chat.say('/mcp'))

    expect(second).not.toBe(first)
    expect(await letsIn(first)).toBe(false)
    expect(await letsIn(second)).toBe(true)
    expect(await tokenRowOf(await chat.userId())).toMatchObject({ token_hash: (await sha256(second)).toHex() })
    // Another user's token is as it was.
    expect(await letsIn(other)).toBe(true)
  })

  it.each(['/mcp now', '/mcp revok', '/mcp revoke now'])(
    'answers "%s" with the usage, and leaves the token as it was',
    async (message) => {
      const chat = openChat()
      const token = tokenFrom(await chat.say('/mcp'))

      expect(await chat.say(message)).toBe(USAGE)

      expect(await letsIn(token)).toBe(true)
    },
  )
})

describe('/mcp revoke', () => {
  it('removes the token, which stops working', async () => {
    const chat = openChat()
    const bystander = openChat()
    const token = tokenFrom(await chat.say('/mcp'))
    const other = tokenFrom(await bystander.say('/mcp'))

    const reply = await chat.say('/mcp revoke')

    expect(reply).toBe(
      'Your assistant access token has been removed. An assistant that used it can no longer read your data.',
    )
    expect(await tokenRowOf(await chat.userId())).toBeNull()
    expect(await letsIn(token)).toBe(false)
    expect(await letsIn(other)).toBe(true)
  })

  it('says so when there is no token to remove', async () => {
    const chat = openChat()

    expect(await chat.say('/mcp revoke')).toBe('You have no assistant access token.')

    await chat.say('/mcp')
    await chat.say('/MCP Revoke')
    expect(await chat.say('/mcp revoke')).toBe('You have no assistant access token.')
  })

  it('leaves the user free to make a new token', async () => {
    const chat = openChat()
    const first = tokenFrom(await chat.say('/mcp'))
    await chat.say('/mcp revoke')

    const second = tokenFrom(await chat.say('/mcp'))

    expect(await letsIn(first)).toBe(false)
    expect(await letsIn(second)).toBe(true)
  })
})

describe('/delete confirm', () => {
  it('removes the token with everything else, and it stops working', async () => {
    const leaving = openChat()
    const staying = openChat()
    const token = tokenFrom(await leaving.say('/mcp'))
    const other = tokenFrom(await staying.say('/mcp'))
    const userId = await leaving.userId()

    expect(await leaving.say('/delete confirm')).toContain('has been deleted')

    expect(await tokenRowOf(userId)).toBeNull()
    expect(await letsIn(token)).toBe(false)
    expect(await letsIn(other)).toBe(true)
  })
})
