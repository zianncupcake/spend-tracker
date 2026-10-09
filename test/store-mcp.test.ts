import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { deleteUser, findOrCreateUser } from '../src/store'
import { findUserByTokenHash, mcpStoreFor } from '../src/store-mcp'
import { newTelegramId } from './helpers'

const db = env.DB

/** A new user with their store. Token hashes are unique in the table, so each user's is named after them. */
async function newUser() {
  const user = await findOrCreateUser(db, newTelegramId())
  return { user, store: mcpStoreFor(db, user.id), hash: `made-up-token-hash-of-${user.id}` }
}

// Reads the table directly, so it also sees rows that a per-user store would never return.
async function tokenCount(userId: number): Promise<number> {
  const count = db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE owner_id = ?').bind(userId)
  return (await count.first<number>('n')) ?? 0
}

describe('a token', () => {
  it('leads to the user it belongs to, with their time zone, by its hash', async () => {
    const { user, store, hash } = await newUser()
    await db.prepare("UPDATE users SET timezone = 'America/New_York' WHERE id = ?").bind(user.id).run()

    expect(await findUserByTokenHash(db, hash)).toBeNull()

    await store.setToken(hash)

    expect(await findUserByTokenHash(db, hash)).toEqual({ id: user.id, timezone: 'America/New_York' })
    expect(await findUserByTokenHash(db, 'made-up-token-hash-of-nobody')).toBeNull()
    expect(await findUserByTokenHash(db, '')).toBeNull()
  })

  it('is the only one its user has: a new one takes its place', async () => {
    const { user, store, hash } = await newUser()
    await store.setToken(hash)

    await store.setToken(`${hash}-again`)

    expect(await tokenCount(user.id)).toBe(1)
    expect(await findUserByTokenHash(db, hash)).toBeNull()
    expect(await findUserByTokenHash(db, `${hash}-again`)).toMatchObject({ id: user.id })
  })

  it('is removed by its user, who is told whether there was one', async () => {
    const { store, hash } = await newUser()

    expect(await store.removeToken()).toBe(false)

    await store.setToken(hash)
    expect(await store.removeToken()).toBe(true)
    expect(await store.removeToken()).toBe(false)
    expect(await findUserByTokenHash(db, hash)).toBeNull()
  })

  it('belongs to one user, who alone can replace it and remove it', async () => {
    const first = await newUser()
    const second = await newUser()
    await first.store.setToken(first.hash)

    expect(await second.store.removeToken()).toBe(false)
    await second.store.setToken(second.hash)
    await second.store.setToken(`${second.hash}-again`)
    expect(await second.store.removeToken()).toBe(true)

    expect(await findUserByTokenHash(db, first.hash)).toMatchObject({ id: first.user.id })
  })

  it("cannot be given the hash of another user's token, which stays that user's", async () => {
    const first = await newUser()
    const second = await newUser()
    await first.store.setToken(first.hash)
    await second.store.setToken(second.hash)

    await expect(second.store.setToken(first.hash)).rejects.toThrow()

    expect(await findUserByTokenHash(db, first.hash)).toMatchObject({ id: first.user.id })
    expect(await findUserByTokenHash(db, second.hash)).toMatchObject({ id: second.user.id })
  })
})

describe('deleting a user', () => {
  it("deletes their token, and nobody else's", async () => {
    const leaving = await newUser()
    const staying = await newUser()
    for (const { store, hash } of [leaving, staying]) await store.setToken(hash)

    await deleteUser(db, leaving.user.id)

    expect(await tokenCount(leaving.user.id)).toBe(0)
    expect(await findUserByTokenHash(db, leaving.hash)).toBeNull()
    expect(await findUserByTokenHash(db, staying.hash)).toMatchObject({ id: staying.user.id })
  })
})
