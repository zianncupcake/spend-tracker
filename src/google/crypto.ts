// Encryption for the refresh tokens kept in the database: AES-256-GCM, under a
// key that only the Worker holds. The stored form is base64 of a random 12-byte
// IV followed by the ciphertext, which ends with the tag that GCM checks.

import { Failure } from '../log'

const IV_BYTES = 12

export async function encryptToken(keyBase64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return new Uint8Array([...iv, ...new Uint8Array(ciphertext)]).toBase64()
}

/** Throws when the data was not encrypted with this key, or has been changed since. */
export async function decryptToken(keyBase64: string, encoded: string): Promise<string> {
  const key = await importKey(keyBase64)
  const stored = Uint8Array.fromBase64(encoded)
  const iv = stored.subarray(0, IV_BYTES)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, stored.subarray(IV_BYTES))
  return new TextDecoder().decode(plaintext)
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.fromBase64(keyBase64)
  // A 16-byte key would be accepted too, and would quietly mean AES-128.
  if (raw.byteLength !== 32) throw new Failure('bad_key', 'TOKEN_ENCRYPTION_KEY must be base64 of 32 bytes')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
