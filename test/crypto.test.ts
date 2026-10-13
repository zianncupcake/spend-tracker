import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { decryptToken, encryptToken } from '../src/google/crypto'
import { Failure } from '../src/log'

const KEY = env.TOKEN_ENCRYPTION_KEY
const OTHER_KEY = new Uint8Array(32).fill(7).toBase64()
const TOKEN = 'made-up-refresh-token'

it('decrypts what it encrypted', async () => {
  const encrypted = await encryptToken(KEY, TOKEN)

  expect(await decryptToken(KEY, encrypted)).toBe(TOKEN)
})

it.each(['', 'not only ASCII: ••• é 字'])('round-trips "%s"', async (text) => {
  expect(await decryptToken(KEY, await encryptToken(KEY, text))).toBe(text)
})

it('stores base64 of a 12-byte IV, the ciphertext and the 16-byte tag, with nothing readable in it', async () => {
  const encrypted = await encryptToken(KEY, TOKEN)

  const stored = Uint8Array.fromBase64(encrypted)
  expect(stored.byteLength).toBe(12 + TOKEN.length + 16)
  expect(encrypted).not.toContain(TOKEN)
  expect(new TextDecoder().decode(stored)).not.toContain(TOKEN)
})

it('uses a fresh IV every time, so the same token never encrypts to the same text', async () => {
  const encrypted = await Promise.all(Array.from({ length: 20 }, () => encryptToken(KEY, TOKEN)))

  const ivs = encrypted.map((each) => Uint8Array.fromBase64(each).subarray(0, 12).toHex())
  expect(new Set(encrypted).size).toBe(20)
  expect(new Set(ivs).size).toBe(20)
})

it('refuses data with one bit changed in the ciphertext', async () => {
  const stored = Uint8Array.fromBase64(await encryptToken(KEY, TOKEN))
  stored[12] ^= 1

  await expect(decryptToken(KEY, stored.toBase64())).rejects.toThrow()
})

it('refuses data cut down to nothing', async () => {
  await expect(decryptToken(KEY, new Uint8Array().toBase64())).rejects.toThrow()
})

it('refuses text that is not base64', async () => {
  await expect(decryptToken(KEY, 'not base64!')).rejects.toThrow()
})

it('refuses data encrypted under another key', async () => {
  const encrypted = await encryptToken(OTHER_KEY, TOKEN)

  await expect(decryptToken(KEY, encrypted)).rejects.toThrow()
  expect(await decryptToken(OTHER_KEY, encrypted)).toBe(TOKEN)
})

it.each([
  ['a 16-byte key', new Uint8Array(16).toBase64()],
  ['a 33-byte key', new Uint8Array(33).toBase64()],
])('refuses %s, to encrypt or to decrypt', async (_, key) => {
  const encrypted = await encryptToken(KEY, TOKEN)

  // The error says which setting is wrong, and gives the log its reason. Neither holds anything of the key.
  const badKey = new Failure('bad_key', 'TOKEN_ENCRYPTION_KEY must be base64 of 32 bytes')
  await expect(encryptToken(key, TOKEN)).rejects.toEqual(badKey)
  await expect(decryptToken(key, encrypted)).rejects.toEqual(badKey)
})
