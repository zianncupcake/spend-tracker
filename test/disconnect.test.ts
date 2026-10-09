import { describe, expect, it, vi } from 'vitest'
import { refreshAccessToken } from '../src/google/gmail'
import {
  attemptOf,
  connectedChat,
  connectionOf,
  deps,
  openChat,
  outside,
  REVOKE_URL,
  signIn,
  tokenIn,
} from './connect-helpers'
import { rowsOwnedBy } from './helpers'

describe('/disconnect', () => {
  it('deletes the connection and revokes its token at Google', async () => {
    const chat = await connectedChat('jane@example.test')
    const userId = await chat.userId()

    const reply = await chat.say('/disconnect')

    expect(reply).toBe('Disconnected jane@example.test. Its mail is no longer read for this chat.')
    expect(await connectionOf(userId)).toBeNull()
    expect(outside.revoked).toEqual([outside.issued[0]])
    expect(await rowsOwnedBy(userId)).toMatchObject({ users: 1 })

    expect(await chat.say('/disconnect')).toBe('Your Gmail is not connected.')
    expect(outside.revoked).toHaveLength(1)
  })

  it('says so when Gmail is not connected', async () => {
    expect(await openChat().say('/disconnect')).toBe('Your Gmail is not connected.')
    expect(outside.revoked).toEqual([])
  })

  it('also gives up a sign-in that is waiting for its code', async () => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')

    expect(await chat.say('/disconnect')).toBe('Your Gmail is not connected.')

    expect(await attemptOf(await chat.userId())).toBeNull()
    expect(outside.revoked).toEqual([outside.issued[0]])
    expect(await chat.say(code)).toContain('No sign-in is waiting for a code')
  })

  it('still disconnects when Google cannot be told, and logs only that it failed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const chat = await connectedChat('jane@example.test')
    outside.failing.add(REVOKE_URL)

    const reply = await chat.say('/disconnect')

    expect(reply).toContain('Disconnected jane@example.test')
    expect(await connectionOf(await chat.userId())).toBeNull()
    expect(logged.mock.calls).toEqual([['token revocation failed:', 'Error']])
  })

  it('revokes nothing while the same mailbox is connected from another chat, and does when the last lets go', async () => {
    const first = await connectedChat('jane@example.test')
    const second = await connectedChat('jane@example.test')
    const secondsToken = await tokenIn(await connectionOf(await second.userId()))

    expect(await first.say('/disconnect')).toContain('Disconnected jane@example.test')

    // Google ends every token of an account when it revokes one of them. The other chat's would have gone too.
    expect(outside.revoked).toEqual([])
    expect(await connectionOf(await first.userId())).toBeNull()
    expect(await connectionOf(await second.userId())).toMatchObject({ email: 'jane@example.test', status: 'active' })
    expect(await refreshAccessToken(deps.google, secondsToken)).toBe('access-token-of-jane@example.test')

    expect(await second.say('/disconnect')).toContain('Disconnected jane@example.test')

    // That ends the whole grant, and with it the token that the first chat held.
    expect(outside.revoked).toEqual([secondsToken])
    expect(outside.ended).toEqual(new Set(outside.issued))
  })

  it("leaves another user's connection alone", async () => {
    const first = await connectedChat('jane@example.test')
    const second = await connectedChat('sam@example.test')
    const [firstId, secondId] = [await first.userId(), await second.userId()]
    expect(await first.say('/connect')).toContain('Your Gmail jane@example.test is already connected')
    expect(await second.say('/connect')).toContain('Your Gmail sam@example.test is already connected')

    expect(await first.say('/disconnect')).toContain('Disconnected jane@example.test')

    expect(outside.revoked).toEqual([outside.issued[0]])
    expect(await connectionOf(firstId)).toBeNull()
    expect(await connectionOf(secondId)).toMatchObject({ email: 'sam@example.test', status: 'active' })
    expect(await tokenIn(await connectionOf(secondId))).toBe(outside.issued[1])
    expect(await second.say('/connect')).toContain('Your Gmail sam@example.test is already connected')
  })
})

describe('/delete confirm', () => {
  it('revokes the connection at Google and deletes it with the user', async () => {
    const chat = await connectedChat('jane@example.test')
    const userId = await chat.userId()

    expect(await chat.say('/delete confirm')).toContain('has been deleted')

    expect(outside.revoked).toEqual([outside.issued[0]])
    expect(await rowsOwnedBy(userId)).toEqual({ users: 0, cards: 0, transactions: 0 })
    expect(await connectionOf(userId)).toBeNull()
  })

  it('revokes the token of a sign-in that is waiting for its code', async () => {
    const chat = openChat()
    await signIn(chat, 'jane@example.test')
    const userId = await chat.userId()

    expect(await chat.say('/delete confirm')).toContain('has been deleted')

    expect(outside.revoked).toEqual([outside.issued[0]])
    expect(await rowsOwnedBy(userId)).toMatchObject({ users: 0 })
    expect(await attemptOf(userId)).toBeNull()
  })

  it('asks for confirmation first, and revokes nothing until it has it', async () => {
    const chat = await connectedChat('jane@example.test')

    expect(await chat.say('/delete')).toContain('Send /delete confirm')

    expect(outside.revoked).toEqual([])
    expect(await connectionOf(await chat.userId())).toMatchObject({ status: 'active' })
  })

  it("leaves another user's connection alone", async () => {
    const leaving = await connectedChat('jane@example.test')
    const staying = await connectedChat('sam@example.test')

    await leaving.say('/delete confirm')

    expect(outside.revoked).toEqual([outside.issued[0]])
    expect(await connectionOf(await staying.userId())).toMatchObject({ email: 'sam@example.test', status: 'active' })
  })
})
