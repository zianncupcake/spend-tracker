import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteUser, findOrCreateUser, storeFor } from '../src/store'
import { claimAttempt, connectStoreFor } from '../src/store-connect'
import { heldStoreFor } from '../src/store-held'
import { mailStoreFor, removeExpiredAttempts, removeExpiredBatches, takeNextMailbox } from '../src/store-mail'
import { newTelegramId } from './helpers'

const db = env.DB
const NOW = 1_800_000_000
/** When the connections in these tests are made, unless a test says otherwise. */
const CONNECTED = NOW - 3600

// Whose turn it is, which sign-ins have expired, and which held purchases nobody answered for, are looked up across
// all users. So every test starts with none.
beforeEach(async () => {
  await db.prepare('DELETE FROM users').run()
})

/** A new user with their stores, and with a connection when an address is given. */
async function newUser(email?: string, connectedAt = CONNECTED) {
  const telegramId = newTelegramId()
  const { id } = await findOrCreateUser(db, telegramId)
  const connect = connectStoreFor(db, id)
  if (email) await connect.saveConnection(email, `made-up-encrypted-token-of-${email}`, connectedAt)
  return { id, telegramId, connect, mail: mailStoreFor(db, id), store: storeFor(db, id) }
}

/** Gives a user a sign-in that runs out at `expiresAt`, holding a mailbox if a token is given. */
async function startAttempt(user: Awaited<ReturnType<typeof newUser>>, expiresAt: number, refreshTokenEnc?: string) {
  const stateHash = `made-up-state-hash-of-${user.id}`
  await user.connect.startAttempt(stateHash, 'made-up-verifier', expiresAt)
  if (refreshTokenEnc) {
    const pending = { email: 'jane@example.test', refreshTokenEnc, confirmCodeHash: 'made-up-code-hash', expiresAt }
    expect(await claimAttempt(db, stateHash, expiresAt - 1)).not.toBeNull()
    expect(await user.connect.holdForCode(stateHash, pending)).toBe(true)
  }
}

function purchase(sourceId: string) {
  return {
    sourceId,
    cardLast4: '1234',
    amountMinor: 1000,
    currency: 'SGD',
    merchant: 'COFFEE PLACE',
    occurredAt: NOW,
    parser: 'example-bank',
  }
}

// The functions below read and write the tables directly, as the counts in helpers.ts do.

async function ownersOf(table: 'connect_attempts' | 'seen_alerts' | 'held_batches'): Promise<number[]> {
  const { results } = await db.prepare(`SELECT owner_id FROM ${table} ORDER BY owner_id`).all<{ owner_id: number }>()
  return results.map((row) => row.owner_id)
}

function connectionOf(userId: number) {
  return db
    .prepare(
      'SELECT status, last_run_at, last_checked_at, backlog_page_token FROM google_connections WHERE owner_id = ?',
    )
    .bind(userId)
    .first()
}

function setLastRun(userId: number, lastRunAt: number | null) {
  return db.prepare('UPDATE google_connections SET last_run_at = ? WHERE owner_id = ?').bind(lastRunAt, userId).run()
}

describe('sign-ins that have expired', () => {
  it('are deleted, and the mailbox that each held is returned, or null for one that held none', async () => {
    const [approved, opened, justExpired, inTime] = [await newUser(), await newUser(), await newUser(), await newUser()]
    await startAttempt(approved, NOW - 60, 'made-up-encrypted-token-1')
    await startAttempt(opened, NOW - 60)
    await startAttempt(justExpired, NOW, 'made-up-encrypted-token-2')
    await startAttempt(inTime, NOW + 1, 'made-up-encrypted-token-3')

    const deleted = await removeExpiredAttempts(db, NOW, 5)

    // The sign-in that Google had brought no mailbox is deleted with the others, and has none to return.
    expect(deleted).toHaveLength(3)
    expect(deleted).toContainEqual({ email: 'jane@example.test', refreshTokenEnc: 'made-up-encrypted-token-1' })
    expect(deleted).toContainEqual({ email: 'jane@example.test', refreshTokenEnc: 'made-up-encrypted-token-2' })
    expect(deleted).toContain(null)
    expect(await ownersOf('connect_attempts')).toEqual([inTime.id])
    expect(await removeExpiredAttempts(db, NOW, 5)).toEqual([])
  })

  it('are deleted no more than so many at a time', async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      await startAttempt(await newUser(), NOW - 60, `made-up-encrypted-token-${attempt}`)
    }

    const first = await removeExpiredAttempts(db, NOW, 3)
    const second = await removeExpiredAttempts(db, NOW, 3)

    expect(first).toHaveLength(3)
    expect(second).toHaveLength(1)
    expect(new Set([...first, ...second].map((held) => held?.refreshTokenEnc)).size).toBe(4)
    expect(await ownersOf('connect_attempts')).toEqual([])
  })
})

describe('held purchases that nobody answered for', () => {
  const DAY = 24 * 3600

  /** Holds a batch of one purchase for a user, for the message with the id, from a time on. */
  function hold(userId: number, messageId: number, from: number) {
    const read = { occurredAt: NOW, amountMinor: 1000, currency: 'SGD', merchant: 'COFFEE PLACE' }
    const batch = { messageId, cardLast4: '1234', category: null, purchases: [{ place: 0, ...read, unsure: true }] }
    return heldStoreFor(db, userId).hold(batch, from)
  }

  it('are deleted once the day that they are held is up, whoever they are held for, and are counted', async () => {
    const [first, second, third] = [await newUser(), await newUser(), await newUser()]
    await hold(first.id, 71, NOW - DAY - 60)
    await hold(first.id, 72, NOW - DAY)
    await hold(second.id, 71, NOW - 2 * DAY)
    // A second short of a day, and held just now.
    await hold(second.id, 73, NOW - DAY + 1)
    await hold(third.id, 71, NOW)

    expect(await removeExpiredBatches(db, NOW)).toBe(3)

    expect(await ownersOf('held_batches')).toEqual([second.id, third.id])
    expect(await heldStoreFor(db, second.id).find(73, NOW)).toMatchObject({ messageId: 73 })
    // There is nothing left for the next run to delete.
    expect(await removeExpiredBatches(db, NOW)).toBe(0)
  })

  it('are deleted in one statement, however many there are', async () => {
    const user = await newUser()
    for (let messageId = 1; messageId <= 30; messageId++) await hold(user.id, messageId, NOW - DAY)
    const queried = vi.spyOn(db, 'prepare')

    expect(await removeExpiredBatches(db, NOW)).toBe(30)

    expect(queried).toHaveBeenCalledTimes(1)
    queried.mockRestore()
    expect(await ownersOf('held_batches')).toEqual([])
  })

  it('are looked for by when their time is up, so that a run does not read through all that is still held', async () => {
    const user = await newUser()
    for (let messageId = 1; messageId <= 30; messageId++) await hold(user.id, messageId, NOW)

    // The statement of the sweep, as the database plans it and as it then counts the rows that it read.
    const sweep = 'DELETE FROM held_batches WHERE expires_at <= ?'
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sweep}`).bind(NOW).all<{ detail: string }>()
    const swept = await db.prepare(sweep).bind(NOW).run()

    expect(plan.results.map((step) => step.detail).join('\n')).toContain('USING COVERING INDEX held_batches_expires_at')
    // One row at the most, where the index ends for it, and not the 30.
    expect(swept.meta.changes).toBe(0)
    expect(swept.meta.rows_read).toBeLessThanOrEqual(1)
    expect(await ownersOf('held_batches')).toHaveLength(30)
  })
})

describe('the mailbox whose turn it is', () => {
  it('comes with what it takes to check it and to tell its user, and has its turn recorded', async () => {
    const user = await newUser('jane@example.test')
    await user.mail.markChecked(NOW - 3600)

    const mailbox = await takeNextMailbox(db, NOW)

    expect(mailbox).toEqual({
      ownerId: user.id,
      email: 'jane@example.test',
      refreshTokenEnc: 'made-up-encrypted-token-of-jane@example.test',
      connectedAt: CONNECTED,
      lastCheckedAt: NOW - 3600,
      backlogPageToken: null,
      chatId: user.telegramId,
      timezone: 'Asia/Singapore',
    })
    expect(await connectionOf(user.id)).toEqual({
      status: 'active',
      last_run_at: NOW,
      last_checked_at: NOW - 3600,
      backlog_page_token: null,
    })
  })

  it('comes with the page that the runs before it had got to', async () => {
    const user = await newUser('jane@example.test')
    await user.mail.setBacklogPageToken('made-up-page-token')

    expect(await takeNextMailbox(db, NOW)).toMatchObject({ backlogPageToken: 'made-up-page-token' })
  })

  it('is the one that has waited longest: since its last turn or, if it has had none, since it was made', async () => {
    const first = await newUser('jane@example.test')
    await newUser('sam@example.test', NOW - 300)
    const third = await newUser('tom@example.test')
    await setLastRun(first.id, NOW - 100)
    await setLastRun(third.id, NOW - 500)

    const taken = []
    for (let turn = 0; turn < 7; turn++) taken.push((await takeNextMailbox(db, NOW + turn))?.email)

    expect(taken).toEqual([
      'tom@example.test',
      'sam@example.test',
      'jane@example.test',
      'tom@example.test',
      'sam@example.test',
      'jane@example.test',
      'tom@example.test',
    ])
  })

  it('is not one that has just been connected again, while another has waited longer', async () => {
    const waiting = await newUser('jane@example.test')
    const again = await newUser('sam@example.test')
    await setLastRun(waiting.id, NOW - 600)
    await setLastRun(again.id, NOW - 60)

    // Connecting again leaves a connection with no turn behind it. That is not a place at the front.
    await again.connect.saveConnection('sam@example.test', 'another-made-up-encrypted-token', NOW)
    expect(await connectionOf(again.id)).toMatchObject({ last_run_at: null })

    expect((await takeNextMailbox(db, NOW))?.email).toBe('jane@example.test')
    expect((await takeNextMailbox(db, NOW + 60))?.email).toBe('sam@example.test')
  })

  it('is the one connected first, of those that have never had a turn', async () => {
    await newUser('sam@example.test', CONNECTED + 60)
    await newUser('jane@example.test', CONNECTED)
    await newUser('tom@example.test', CONNECTED)

    // Of the two connected in the same second, the one whose user came first.
    expect((await takeNextMailbox(db, NOW))?.email).toBe('jane@example.test')
    expect((await takeNextMailbox(db, NOW))?.email).toBe('tom@example.test')
    expect((await takeNextMailbox(db, NOW))?.email).toBe('sam@example.test')
  })

  it('is one that has had no turn, of two that have waited as long', async () => {
    const ran = await newUser('jane@example.test')
    await newUser('sam@example.test', NOW - 60)
    await setLastRun(ran.id, NOW - 60)

    expect((await takeNextMailbox(db, NOW))?.email).toBe('sam@example.test')
  })

  it('is never one that needs to be reconnected, and is none when nobody is connected', async () => {
    expect(await takeNextMailbox(db, NOW)).toBeNull()

    const lost = await newUser('jane@example.test')
    const active = await newUser('sam@example.test')
    await newUser()
    await lost.mail.markNeedsReconnect()

    expect((await takeNextMailbox(db, NOW))?.ownerId).toBe(active.id)
    expect((await takeNextMailbox(db, NOW + 60))?.ownerId).toBe(active.id)
    expect(await connectionOf(lost.id)).toMatchObject({ status: 'needs_reconnect', last_run_at: null })

    await active.mail.markNeedsReconnect()
    expect(await takeNextMailbox(db, NOW + 120)).toBeNull()
  })
})

describe('a mail store', () => {
  it('tells which ids its user does not know yet, in the order they were given', async () => {
    const user = await newUser()
    const other = await newUser()
    await user.store.insertTransaction(purchase('stored-1'))
    await user.mail.markSeen('unparsed-1', 'unparsed')
    await user.mail.markSeen('rejected-1', 'rejected')
    // What another user knows makes no difference.
    await other.store.insertTransaction(purchase('new-1'))
    await other.mail.markSeen('new-2', 'unparsed')

    const ids = ['new-3', 'stored-1', 'new-1', 'unparsed-1', 'rejected-1', 'new-2']

    expect(await user.mail.unknownIds(ids)).toEqual(['new-3', 'new-1', 'new-2'])
    expect(await other.mail.unknownIds(ids)).toEqual(['new-3', 'stored-1', 'unparsed-1', 'rejected-1'])
    expect(await user.mail.unknownIds([])).toEqual([])
  })

  it('takes more ids at once than a statement takes bound values', async () => {
    const { mail } = await newUser()
    const ids = Array.from({ length: 500 }, (_, index) => `msg-${index}`)
    for (const id of ['msg-0', 'msg-250', 'msg-499']) await mail.markSeen(id, 'unparsed')

    const unknown = await mail.unknownIds(ids)

    expect(unknown).toEqual(ids.filter((id) => !['msg-0', 'msg-250', 'msg-499'].includes(id)))
  })

  it('notes an alert once, for its own user', async () => {
    const user = await newUser()
    const other = await newUser()

    await user.mail.markSeen('msg-1', 'unparsed')
    await user.mail.markSeen('msg-1', 'rejected')
    await other.mail.markSeen('msg-1', 'rejected')

    const { results } = await db.prepare('SELECT owner_id, source_id, status FROM seen_alerts ORDER BY owner_id').all()
    expect(results).toEqual([
      { owner_id: user.id, source_id: 'msg-1', status: 'unparsed' },
      { owner_id: other.id, source_id: 'msg-1', status: 'rejected' },
    ])
  })

  it('cannot note an alert as anything but unparsed or rejected', async () => {
    const { id } = await newUser()

    const insert = db.prepare("INSERT INTO seen_alerts (owner_id, source_id, status) VALUES (?, 'msg-1', 'ignored')")

    await expect(insert.bind(id).run()).rejects.toThrow()
  })

  it('marks the connection of its own user as needing to be reconnected, and nobody else’s', async () => {
    const user = await newUser('jane@example.test')
    const other = await newUser('sam@example.test')

    await user.mail.markNeedsReconnect()

    expect(await user.connect.findConnection()).toEqual({ email: 'jane@example.test', status: 'needs_reconnect' })
    expect(await other.connect.findConnection()).toEqual({ email: 'sam@example.test', status: 'active' })
  })

  it('keeps the page that the runs have got to, for its own user and until the mailbox is fully checked', async () => {
    const user = await newUser('jane@example.test')
    const other = await newUser('sam@example.test')

    await user.mail.setBacklogPageToken('made-up-page-token')
    await other.mail.setBacklogPageToken('another-made-up-page-token')
    await user.mail.setBacklogPageToken('a-later-made-up-page-token')
    expect(await connectionOf(user.id)).toMatchObject({ backlog_page_token: 'a-later-made-up-page-token' })

    // The search that follows a full check is a new one, which that page is no part of.
    await user.mail.markChecked(NOW)
    expect(await connectionOf(user.id)).toMatchObject({ last_checked_at: NOW, backlog_page_token: null })
    expect(await connectionOf(other.id)).toMatchObject({
      last_checked_at: null,
      backlog_page_token: 'another-made-up-page-token',
    })

    await other.mail.setBacklogPageToken(null)
    expect(await connectionOf(other.id)).toMatchObject({ backlog_page_token: null })
  })

  it("sums up what has been read from its user's mailbox since a time", async () => {
    const user = await newUser('jane@example.test')
    const other = await newUser('sam@example.test')
    await user.mail.markChecked(NOW - 120)
    await other.mail.markChecked(NOW - 60)
    const rows: [ownerId: number, sourceId: string, at: number, status?: string][] = [
      [user.id, 'stored-before', NOW - 1001],
      [user.id, 'stored-at', NOW - 1000],
      [user.id, 'stored-after', NOW - 999],
      [other.id, 'stored-elsewhere', NOW - 999],
      [user.id, 'unparsed-before', NOW - 1001, 'unparsed'],
      [user.id, 'unparsed-at', NOW - 1000, 'unparsed'],
      [user.id, 'rejected-after', NOW - 999, 'rejected'],
      [other.id, 'unparsed-elsewhere', NOW - 999, 'unparsed'],
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

    expect(await user.mail.summary(NOW - 1000)).toEqual({ lastCheckedAt: NOW - 120, purchases: 2, unparsed: 1 })
    expect(await other.mail.summary(NOW - 1000)).toEqual({ lastCheckedAt: NOW - 60, purchases: 1, unparsed: 1 })
    expect(await user.mail.summary(0)).toEqual({ lastCheckedAt: NOW - 120, purchases: 3, unparsed: 2 })
  })

  it('counts no purchase that its user added by hand, and none that they took out', async () => {
    const user = await newUser('jane@example.test')
    await user.store.insertTransaction(purchase('read-and-kept'))
    await user.store.insertTransaction({ ...purchase('added-by-hand'), parser: 'manual' })
    const removed = await user.store.insertTransaction(purchase('read-and-taken-out'))
    await user.store.removeTransaction(removed ?? 0)

    expect(await user.mail.summary(0)).toMatchObject({ purchases: 1 })
    // The alert of the one that was taken out still counts as known, so it is not fetched again.
    expect(await user.mail.unknownIds(['read-and-kept', 'read-and-taken-out', 'new-1'])).toEqual(['new-1'])
  })

  it('sums up nothing for a user with no connection and no mail read', async () => {
    const { mail } = await newUser()

    expect(await mail.summary(0)).toEqual({ lastCheckedAt: null, purchases: 0, unparsed: 0 })
  })
})

describe('deleting a user', () => {
  it("deletes what was noted of their alerts, and nobody else's", async () => {
    const leaving = await newUser()
    const staying = await newUser()
    await leaving.mail.markSeen('msg-1', 'unparsed')
    await staying.mail.markSeen('msg-1', 'unparsed')

    await deleteUser(db, leaving.id)

    expect(await ownersOf('seen_alerts')).toEqual([staying.id])
  })
})
