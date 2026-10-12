import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, vi, type MockInstance } from 'vitest'
import * as photo from '../src/ai/photo'
import type { PhotoReading, ReadPurchase } from '../src/ai/photo'
import type { RichMessage } from '../src/telegram/api'
import type { Reading } from '../src/telegram/adding'
import { BY_HAND_NOTE } from '../src/telegram/purchases'
import { deps, openChat, posted, type Posted } from './connect-helpers'
import { linesOf, plain, seconds } from './helpers'

// What the tests of purchases that are added from a photo share. The reading of a photo is the work of a model, and
// is stood in for: a test says what the reading comes to, and the tests are of what the bot then does with it. The
// fetching of the photo's file from Telegram is stood in for too. test/photo-read.test.ts and
// test/telegram-file.test.ts have the two as they are. A test file that imports this has both stand-ins made new
// before each of its tests. It shares the chats, the clock and the service of ./connect-helpers: the clock stands at
// 12:00 on 9 October 2026 in Singapore, and every card here is tracked by the calendar month.

/** What a press is answered with when its button is under nothing that can be added or skipped any more. */
export const REFUSED = 'That button no longer works.'

/** What the bank calls the two categories of the UOB EVOL Card that a purchase can be put in by hand. */
export const ONLINE = 'Online / Mobile Contactless Spend'
export const OTHER = 'Other Spend'

/** What a reply says under its tables: every purchase from a photo is one that was added by hand. */
export const BY_HAND = plain(BY_HAND_NOTE)

/** The id of the message that a test's photo comes in, where the test goes by it. Each test has a user of its own. */
export const MESSAGE = 7001

/** What the stand-in for Telegram gives for the file of a photo: made-up bytes, which begin as those of a JPEG do. */
export const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x4d, 0x41, 0x44, 0x45])

/** The stand-in for the reading of a photo: see `reading`. With nothing said, a test is to have no photo read. */
export let reader: MockInstance<typeof photo.readPhoto>

/** The stand-in for the fetching of a file from Telegram, which gives BYTES unless a test has it do otherwise. */
export let file: MockInstance<typeof deps.messenger.file>

beforeEach(() => {
  const unexpected = new Error('A test had a photo read that it should not have')
  reader = vi.spyOn(photo, 'readPhoto').mockRejectedValue(unexpected)
  file = vi.spyOn(deps.messenger, 'file').mockResolvedValue(BYTES)
})

// A test that is about how long a photo is waited for moves a fake clock of timers, which is given back here.
afterEach(() => {
  vi.useRealTimers()
})

/** Has the reading of every photo that follows come to this, after one request to the provider. */
export function reading(came: PhotoReading): void {
  reader.mockImplementation(async (_deps, _provider, _input, taken) => {
    taken.requests++
    return came
  })
}

/** A purchase as a reading gives one: one that the model was sure of, made on 5 October 2026 unless said otherwise. */
export function bought(amountMinor: number, merchant: string | null, given: Partial<ReadPurchase> = {}): ReadPurchase {
  const occurredAt = seconds('2026-10-05T00:00:00+08:00')
  return { occurredAt, amountMinor, currency: 'SGD', merchant, unsure: false, ...given }
}

/** A purchase that the model was not sure of. */
export function unsure(amountMinor: number, merchant: string | null, given: Partial<ReadPurchase> = {}): ReadPurchase {
  return bought(amountMinor, merchant, { unsure: true, ...given })
}

/** What a reading comes to when it found the purchases: with no card and no category named, unless said otherwise. */
export function read(purchases: ReadPurchase[], given: Partial<Reading> = {}): Reading {
  const named = { card: null, unknownCard: false, category: null }
  return { status: 'read', ...named, purchases, unreadable: 0, more: false, ...given }
}

export type Chat = ReturnType<typeof openChat>

/** A chat whose user has one card, which is linked to the UOB EVOL Card. */
export async function chatWithCard(): Promise<Chat> {
  const chat = openChat()
  await chat.say('/addcard evol 5678 calendar uob-evol')
  return chat
}

/** A chat whose user has two cards: one that is linked to no product, and one to the UOB EVOL Card. */
export async function chatWithCards(): Promise<Chat> {
  const chat = openChat()
  await chat.say('/addcard visa 1234 calendar')
  await chat.say('/addcard evol 5678 calendar uob-evol')
  return chat
}

/** Sends the bot a photo, and returns the one thing that it then says, which it says in the place of a placeholder. */
export async function noticeFor(chat: Chat, caption?: string): Promise<string> {
  const { rich, texts } = await chat.photo(caption)
  expect(rich).toBeUndefined()
  expect(texts).toHaveLength(1)
  expect(texts[0].buttons).toBeUndefined()
  return texts[0].text
}

/** What a rich message says, a line at a time: see `linesOf`. Nothing for a reply that had no rich message. */
export function lines(rich: RichMessage | undefined): string[] {
  return rich ? linesOf(rich) : []
}

/**
 * What the bot has left in the chats as text since it had left `mark` messages there: the text of each. A test
 * takes the count once its chats are set up, so that what the setting up left is not among them.
 */
export function leftSince(mark: number): string[] {
  return posted.slice(mark).map((message) => message.text)
}

/** What the buttons under a message say, in their order. */
export function labels(message: Posted): string[] | undefined {
  return message.buttons?.flat().map((button) => button.text)
}

/** The stretches of a message that are marked: the names of merchants, where it has any. */
export function markedIn({ text, entities = [] }: Posted): string[] {
  return entities.map(({ offset, length }) => text.slice(offset, offset + length))
}

// The two functions below read the tables directly, so they see what a store leaves out.

/** A user's transactions as they are stored. */
export async function rowsOf(userId: number) {
  const { results } = await env.DB.prepare(
    `SELECT id, source_id, card_last4, amount_minor, currency, merchant, occurred_at, parser, category, removed_at
     FROM transactions WHERE owner_id = ? ORDER BY id`,
  )
    .bind(userId)
    .all<Record<string, string | number | null>>()
  return results
}

/** The purchases that are held for a user, as they are stored: a batch to each message. */
export async function heldFor(userId: number) {
  type Batch = { message_id: number; card_last4: string | null; category: string | null; expires_at: number }
  const { results } = await env.DB.prepare(
    'SELECT message_id, card_last4, category, purchases, expires_at FROM held_batches WHERE owner_id = ?',
  )
    .bind(userId)
    .all<Batch & { purchases: string }>()
  return results.map((batch) => ({ ...batch, purchases: JSON.parse(batch.purchases) }))
}

/**
 * The line that the log has of a photo whose purchases were all added at once, after one request to the provider
 * and in no time by the clock of these tests. A test says what its photo's line has otherwise.
 */
export function photoLine(user: number, counts: { read: number; stored: number; held?: number; unreadable?: number }) {
  const { read, stored, held = 0, unreadable = 0 } = counts
  return {
    event: 'photo',
    user,
    outcome: 'read',
    sent: 'rich',
    placeholder: true,
    bytes: BYTES.byteLength,
    requests: 1,
    read,
    unreadable,
    stored,
    held,
    ms: 0,
  }
}
