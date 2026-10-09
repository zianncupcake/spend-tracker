import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { deleteUser, findOrCreateUser } from '../src/store'
import {
  claimAttempt,
  connectStoreFor,
  findAttemptByState,
  isMailboxHeld,
  type PendingSignIn,
} from '../src/store-connect'
import { newTelegramId } from './helpers'

const db = env.DB
const NOW = 1_800_000_000
const LATER = NOW + 600

/** A new user with their store. State hashes are unique in the table, so each user's is named after them. */
async function newUser() {
  const { id } = await findOrCreateUser(db, newTelegramId())
  return { id, store: connectStoreFor(db, id), stateHash: `made-up-state-hash-of-${id}` }
}

function pending(overrides: Partial<PendingSignIn> = {}): PendingSignIn {
  return {
    email: 'jane@example.test',
    refreshTokenEnc: 'made-up-encrypted-token',
    confirmCodeHash: 'made-up-code-hash',
    expiresAt: LATER,
    ...overrides,
  }
}

// Reads the tables directly, so it also sees rows that a per-user store would never return.
function rowsOwnedBy(userId: number) {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM google_connections WHERE owner_id = ?1) AS connections,
         (SELECT COUNT(*) FROM connect_attempts WHERE owner_id = ?1) AS attempts`,
    )
    .bind(userId)
    .first<{ connections: number; attempts: number }>()
}

describe('a connection', () => {
  it('belongs to one user, who alone can find it and remove it', async () => {
    const first = await newUser()
    const second = await newUser()

    await first.store.saveConnection('jane@example.test', 'made-up-encrypted-token', NOW)

    expect(await first.store.findConnection()).toEqual({ email: 'jane@example.test', status: 'active' })
    expect(await second.store.findConnection()).toBeNull()
    expect(await second.store.removeConnection()).toBeNull()
    expect(await first.store.removeConnection()).toEqual({
      email: 'jane@example.test',
      refreshTokenEnc: 'made-up-encrypted-token',
    })
    expect(await first.store.findConnection()).toBeNull()
  })

  it('is replaced by a later one, which is active whatever the earlier one was', async () => {
    const { id, store } = await newUser()
    await store.saveConnection('jane@example.test', 'made-up-encrypted-token', NOW)
    await db.prepare("UPDATE google_connections SET status = 'needs_reconnect' WHERE owner_id = ?").bind(id).run()
    expect(await store.findConnection()).toEqual({ email: 'jane@example.test', status: 'needs_reconnect' })

    await store.saveConnection('sam@example.test', 'another-made-up-encrypted-token', LATER)

    expect(await store.findConnection()).toEqual({ email: 'sam@example.test', status: 'active' })
    expect(await rowsOwnedBy(id)).toEqual({ connections: 1, attempts: 0 })
  })

  it('is as new when it is made again: connected then, with no run or check behind it and no page kept', async () => {
    const { id, store } = await newUser()
    const progress = () =>
      db
        .prepare(
          `SELECT connected_at, last_run_at, last_checked_at, backlog_page_token
           FROM google_connections WHERE owner_id = ?`,
        )
        .bind(id)
        .first()
    await store.saveConnection('jane@example.test', 'made-up-encrypted-token', NOW)
    // As the mail checker leaves a connection that it has been through.
    await db
      .prepare(
        `UPDATE google_connections
         SET last_run_at = ?1, last_checked_at = ?1, backlog_page_token = 'made-up-page-token'
         WHERE owner_id = ?2`,
      )
      .bind(NOW + 60, id)
      .run()
    expect(await progress()).toMatchObject({ connected_at: NOW, last_run_at: NOW + 60 })

    await store.saveConnection('jane@example.test', 'another-made-up-encrypted-token', LATER)

    expect(await progress()).toEqual({
      connected_at: LATER,
      last_run_at: null,
      last_checked_at: null,
      backlog_page_token: null,
    })
  })

  it('cannot have a status other than active and needs_reconnect', async () => {
    const { id, store } = await newUser()
    await store.saveConnection('jane@example.test', 'made-up-encrypted-token', NOW)

    const update = db.prepare("UPDATE google_connections SET status = 'paused' WHERE owner_id = ?").bind(id)

    await expect(update.run()).rejects.toThrow()
    expect(await store.findConnection()).toEqual({ email: 'jane@example.test', status: 'active' })
  })
})

describe('an attempt', () => {
  it('is found by its state while its link works: before it expires and before it is claimed', async () => {
    const { id, store, stateHash } = await newUser()
    await store.startAttempt(stateHash, 'made-up-verifier', LATER)

    expect(await findAttemptByState(db, stateHash, NOW)).toEqual({ ownerId: id, codeVerifier: 'made-up-verifier' })
    expect(await findAttemptByState(db, stateHash, LATER - 1)).not.toBeNull()
    expect(await findAttemptByState(db, stateHash, LATER)).toBeNull()
    expect(await findAttemptByState(db, 'made-up-state-hash-of-nobody', NOW)).toBeNull()
    // Finding it changes nothing, however often.
    expect(await findAttemptByState(db, stateHash, NOW)).not.toBeNull()

    expect(await claimAttempt(db, stateHash, NOW)).not.toBeNull()
    expect(await findAttemptByState(db, stateHash, NOW)).toBeNull()
  })

  it('is claimed once: by its state, while its link works, and by one of those that come for it together', async () => {
    const { id, store, stateHash } = await newUser()
    await store.startAttempt(stateHash, 'made-up-verifier', LATER)

    expect(await claimAttempt(db, 'made-up-state-hash-of-nobody', NOW)).toBeNull()
    expect(await claimAttempt(db, stateHash, LATER)).toBeNull()

    const together = [1, 2, 3].map(() => claimAttempt(db, stateHash, NOW))
    const claims = (await Promise.all(together)).filter((claim) => claim !== null)

    expect(claims).toEqual([{ ownerId: id, codeVerifier: 'made-up-verifier' }])
    expect(await claimAttempt(db, stateHash, NOW)).toBeNull()
  })

  it('is the only one its user has: a new one takes its place', async () => {
    const { id, store, stateHash } = await newUser()
    await store.startAttempt(stateHash, 'made-up-verifier', LATER)
    await claimAttempt(db, stateHash, NOW)
    await store.holdForCode(stateHash, pending())

    await store.startAttempt(`${stateHash}-again`, 'another-made-up-verifier', LATER)

    expect(await rowsOwnedBy(id)).toEqual({ connections: 0, attempts: 1 })
    expect(await findAttemptByState(db, stateHash, NOW)).toBeNull()
    expect(await findAttemptByState(db, `${stateHash}-again`, NOW)).toEqual({
      ownerId: id,
      codeVerifier: 'another-made-up-verifier',
    })
    // The new attempt holds nothing of the old one.
    expect(await store.countTry(5)).toBeNull()
    expect(await store.removeAttempt()).toBeNull()
  })

  it('is held for a code once it is claimed, once, and only through the state it was started with', async () => {
    const { store, stateHash } = await newUser()
    await store.startAttempt(stateHash, 'made-up-verifier', LATER)

    expect(await store.holdForCode(stateHash, pending())).toBe(false)
    await claimAttempt(db, stateHash, NOW)
    expect(await store.holdForCode('made-up-state-hash-of-nobody', pending())).toBe(false)
    expect(await store.holdForCode(stateHash, pending({ email: 'jane@example.test' }))).toBe(true)
    expect(await store.holdForCode(stateHash, pending({ email: 'sam@example.test' }))).toBe(false)

    expect(await store.countTry(5)).toMatchObject({ email: 'jane@example.test' })
  })

  it('counts each try, and has no more once it has had as many as are allowed', async () => {
    const { store, stateHash } = await newUser()
    await store.startAttempt(stateHash, 'made-up-verifier', LATER)
    await claimAttempt(db, stateHash, NOW)
    expect(await store.countTry(3)).toBeNull() // not yet held for a code
    await store.holdForCode(stateHash, pending())

    expect(await store.countTry(3)).toEqual({ ...pending(), confirmTries: 1 })
    expect(await store.countTry(3)).toEqual({ ...pending(), confirmTries: 2 })
    expect(await store.countTry(3)).toEqual({ ...pending(), confirmTries: 3 })
    expect(await store.countTry(3)).toBeNull()
  })

  it('belongs to one user, who alone can hold it, try it and remove it', async () => {
    const first = await newUser()
    const second = await newUser()
    await first.store.startAttempt(first.stateHash, 'made-up-verifier', LATER)
    await second.store.startAttempt(second.stateHash, 'another-made-up-verifier', LATER)
    await claimAttempt(db, first.stateHash, NOW)
    await claimAttempt(db, second.stateHash, NOW)

    // Knowing the first user's state does not let the second user's store touch their attempt.
    expect(await second.store.holdForCode(first.stateHash, pending())).toBe(false)
    expect(await first.store.holdForCode(first.stateHash, pending())).toBe(true)

    expect(await second.store.countTry(5)).toBeNull()
    expect(await second.store.removeAttempt()).toBeNull()
    expect(await rowsOwnedBy(first.id)).toEqual({ connections: 0, attempts: 1 })
    expect(await first.store.countTry(5)).toMatchObject({ confirmTries: 1 })
    expect(await first.store.removeAttempt()).toEqual({
      email: 'jane@example.test',
      refreshTokenEnc: 'made-up-encrypted-token',
    })
    expect(await rowsOwnedBy(first.id)).toEqual({ connections: 0, attempts: 0 })
  })

  it('ends when it becomes the connection', async () => {
    const { id, store, stateHash } = await newUser()
    await store.startAttempt(stateHash, 'made-up-verifier', LATER)
    await claimAttempt(db, stateHash, NOW)
    await store.holdForCode(stateHash, pending())

    await store.saveConnection('jane@example.test', 'made-up-encrypted-token', NOW)

    expect(await rowsOwnedBy(id)).toEqual({ connections: 1, attempts: 0 })
  })

  it('cannot hold a mailbox without a code, or a code without a mailbox', async () => {
    const { id, store, stateHash } = await newUser()
    await store.startAttempt(stateHash, 'made-up-verifier', LATER)

    for (const column of ['email', 'refresh_token_enc', 'confirm_code_hash']) {
      const update = db.prepare(`UPDATE connect_attempts SET ${column} = 'made-up' WHERE owner_id = ?`).bind(id)
      await expect(update.run()).rejects.toThrow()
    }
  })
})

describe('a mailbox', () => {
  /** A new user, with a mailbox that no other test has anyone hold. */
  async function newHolder() {
    const user = await newUser()
    return { ...user, email: `shared-by-${user.id}@example.test` }
  }

  it('is held by a connection for as long as Google honours it, whoever asks', async () => {
    const { id, store, email } = await newHolder()
    expect(await isMailboxHeld(db, email)).toBe(false)

    await store.saveConnection(email, 'made-up-encrypted-token', NOW)
    expect(await isMailboxHeld(db, email)).toBe(true)
    expect(await isMailboxHeld(db, `not-${email}`)).toBe(false)

    // A connection that needs reconnecting has a token that Google has ended, and holds nothing.
    await db.prepare("UPDATE google_connections SET status = 'needs_reconnect' WHERE owner_id = ?").bind(id).run()
    expect(await isMailboxHeld(db, email)).toBe(false)
  })

  it('is held by a sign-in from when Google brings it until the sign-in ends', async () => {
    const { store, stateHash, email } = await newHolder()
    await store.startAttempt(stateHash, 'made-up-verifier', LATER)
    await claimAttempt(db, stateHash, NOW)
    expect(await isMailboxHeld(db, email)).toBe(false)

    await store.holdForCode(stateHash, pending({ email }))
    expect(await isMailboxHeld(db, email)).toBe(true)

    await store.removeAttempt()
    expect(await isMailboxHeld(db, email)).toBe(false)
  })

  it('is held until the last of those who have it lets go', async () => {
    const first = await newHolder()
    const second = await newUser()
    await first.store.saveConnection(first.email, 'made-up-encrypted-token', NOW)
    await second.store.saveConnection(first.email, 'another-made-up-encrypted-token', NOW)

    await first.store.removeConnection()
    expect(await isMailboxHeld(db, first.email)).toBe(true)

    await second.store.removeConnection()
    expect(await isMailboxHeld(db, first.email)).toBe(false)
  })
})

describe('deleting a user', () => {
  it("deletes their connection and their attempt, and nobody else's", async () => {
    const leaving = await newUser()
    const staying = await newUser()
    for (const { store, stateHash } of [leaving, staying]) {
      await store.saveConnection('jane@example.test', 'made-up-encrypted-token', NOW)
      await store.startAttempt(stateHash, 'made-up-verifier', LATER)
    }

    await deleteUser(db, leaving.id)

    expect(await rowsOwnedBy(leaving.id)).toEqual({ connections: 0, attempts: 0 })
    expect(await rowsOwnedBy(staying.id)).toEqual({ connections: 1, attempts: 1 })
  })
})
