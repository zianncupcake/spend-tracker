import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { TelegramError } from '../src/telegram/api'
import { connectedChat, deps, NOW, openChat } from './connect-helpers'
import { tableOf } from './helpers'

const db = env.DB
const DAY = 86_400
/** The time of the service's clock in these tests, in unix seconds: 12:00 on 9 October in Singapore. */
const NOW_SECONDS = NOW.getTime() / 1000

// The rows of the table of /status, each as `linesOf` has a row: what a value is, and the value.

const NOT_YET = 'Alerts last fully checked | not yet'
const NOTHING_READ = ['Purchases recorded, last 30 days | 0', 'Alerts that could not be read, last 30 days | 0']

/** What /status says as text, of a mailbox from which nothing was read: its last two lines of three. */
const NOTHING_READ_AS_TEXT =
  'Alerts last fully checked: not yet\nLast 30 days: 0 purchases recorded, 0 alerts could not be read'

/**
 * The reply to /status as text, which is what is sent when Telegram does not take the table. It is what the reply
 * was before it had a table.
 */
function asText(chat: ReturnType<typeof openChat>): Promise<string> {
  vi.spyOn(deps.messenger, 'sendRich').mockRejectedValueOnce(new TelegramError('sendRichMessage', 400))
  return chat.say('/status')
}

// The checker is what changes a connection. These tests write to its row directly, as it would have.
function setConnection(userId: number, status: string, lastCheckedAt: number | null) {
  return db
    .prepare('UPDATE google_connections SET status = ?, last_checked_at = ? WHERE owner_id = ?')
    .bind(status, lastCheckedAt, userId)
    .run()
}

describe('/status', () => {
  it('says that Gmail is not connected, and under its table how to connect it', async () => {
    const chat = openChat()

    expect(await chat.lines('/status')).toEqual([
      'Gmail | not connected',
      NOT_YET,
      ...NOTHING_READ,
      'Send /connect to connect it.',
    ])
    expect(await asText(chat)).toBe(
      `Your Gmail is not connected. Send /connect to connect it.\n${NOTHING_READ_AS_TEXT}`,
    )
  })

  it('says that Gmail is connected, with its address, and that its alerts are yet to be checked', async () => {
    const chat = await connectedChat('jane@example.test')

    // As Telegram is posted it: one table with no row of headers, in which a row is what a value is and the value.
    // There is nothing to do about a Gmail that is connected, and nothing is said under the table.
    expect(await chat.rich('/status')).toEqual({
      skip_entity_detection: true,
      blocks: [
        tableOf(
          [{ text: 'Gmail' }, { text: 'jane@example.test' }],
          [{ text: 'Status' }, { text: 'connected' }],
          [{ text: 'Alerts last fully checked' }, { text: 'not yet' }],
          [{ text: 'Purchases recorded, last 30 days' }, { text: '0' }],
          [{ text: 'Alerts that could not be read, last 30 days' }, { text: '0' }],
        ),
      ],
    })
    expect(await asText(chat)).toBe(`Your Gmail jane@example.test is connected.\n${NOTHING_READ_AS_TEXT}`)
  })

  it("says when the alerts were last fully checked, in the user's time zone", async () => {
    const chat = await connectedChat('jane@example.test')
    const userId = await chat.userId()
    await setConnection(userId, 'active', NOW_SECONDS - 115 * 60)

    expect(await chat.lines('/status')).toEqual([
      'Gmail | jane@example.test',
      'Status | connected',
      'Alerts last fully checked | 9 Oct, 10:05',
      ...NOTHING_READ,
    ])

    await db.prepare("UPDATE users SET timezone = 'America/New_York' WHERE id = ?").bind(userId).run()
    expect(await chat.lines('/status')).toContain('Alerts last fully checked | 8 Oct, 22:05')
  })

  it('says that Gmail needs reconnecting, and under its table how to reconnect it', async () => {
    const chat = await connectedChat('jane@example.test')
    await setConnection(await chat.userId(), 'needs_reconnect', NOW_SECONDS - DAY)

    expect(await chat.lines('/status')).toEqual([
      'Gmail | jane@example.test',
      'Status | needs reconnecting',
      'Alerts last fully checked | 8 Oct, 12:00',
      ...NOTHING_READ,
      'Send /connect to reconnect it.',
    ])
    expect(await asText(chat)).toBe(
      [
        'Your Gmail jane@example.test needs reconnecting. Send /connect to reconnect it.',
        'Alerts last fully checked: 8 Oct, 12:00',
        'Last 30 days: 0 purchases recorded, 0 alerts could not be read',
      ].join('\n'),
    )
  })

  it('counts the purchases recorded and the alerts that could not be read in the last 30 days', async () => {
    const chat = await connectedChat('jane@example.test')
    const bystander = await connectedChat('sam@example.test')
    const [userId, otherId] = [await chat.userId(), await bystander.userId()]
    const monthAgo = NOW_SECONDS - 30 * DAY
    const rows: [ownerId: number, sourceId: string, at: number, status?: string][] = [
      [userId, 'stored-today', NOW_SECONDS - 3600],
      [userId, 'stored-30-days-ago', monthAgo],
      [userId, 'stored-before-that', monthAgo - 1],
      [otherId, 'stored-for-another', NOW_SECONDS - 3600],
      [userId, 'unparsed-today', NOW_SECONDS - 3600, 'unparsed'],
      [userId, 'unparsed-before-that', monthAgo - 1, 'unparsed'],
      [userId, 'rejected-today', NOW_SECONDS - 3600, 'rejected'],
    ]
    for (const [ownerId, sourceId, at, status] of rows) {
      const insert = status
        ? db
            .prepare('INSERT INTO seen_alerts (owner_id, source_id, seen_at, status) VALUES (?, ?, ?, ?)')
            .bind(ownerId, sourceId, at, status)
        : db
            .prepare(
              `INSERT INTO transactions
                 (owner_id, source_id, created_at, card_last4, amount_minor, currency, occurred_at, parser)
               VALUES (?, ?, ?, '1234', 1000, 'SGD', 0, 'example-bank')`,
            )
            .bind(ownerId, sourceId, at)
      await insert.run()
    }

    const [recorded, unread] = ['Purchases recorded, last 30 days', 'Alerts that could not be read, last 30 days']
    expect((await chat.lines('/status')).slice(-2)).toEqual([`${recorded} | 2`, `${unread} | 1`])
    expect((await bystander.lines('/status')).slice(-2)).toEqual([`${recorded} | 1`, `${unread} | 0`])
    // As text, the two counts are in one line, each with what it is a count of.
    expect(await asText(chat)).toContain('Last 30 days: 2 purchases recorded, 1 alert could not be read')
    expect(await asText(bystander)).toContain('Last 30 days: 1 purchase recorded, 0 alerts could not be read')
  })
})
