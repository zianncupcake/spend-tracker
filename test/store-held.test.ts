import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { deleteUser, findOrCreateUser } from '../src/store'
import { HELD_HOURS, heldStoreFor, type HeldBatch, type HeldPurchase } from '../src/store-held'
import { newTelegramId } from './helpers'

// The purchases that wait for their user's answer, as they are stored: a batch to each message. Every value is made
// up. test/store-mail.test.ts has the deleting of those that nobody answered for.

const db = env.DB
const NOW = 1_800_000_000
const DAY = 24 * 3600

/** A new user, with their store of held purchases. */
async function newUser() {
  const { id } = await findOrCreateUser(db, newTelegramId())
  return { id, held: heldStoreFor(db, id) }
}

/** A purchase that is held: SGD 12.40 at COFFEE PLACE, of which the model was sure, unless said otherwise. */
function waiting(place: number, overrides: Partial<HeldPurchase> = {}): HeldPurchase {
  return {
    place,
    occurredAt: NOW - 3 * DAY,
    amountMinor: 1240,
    currency: 'SGD',
    merchant: 'COFFEE PLACE',
    unsure: false,
    ...overrides,
  }
}

/** A batch for the message: of one purchase, for the card ending 1234 and with no category, unless said otherwise. */
function batch(messageId: number, overrides: Partial<HeldBatch> = {}): HeldBatch {
  return { messageId, cardLast4: '1234', category: null, purchases: [waiting(0)], ...overrides }
}

/** How many batches are held for a user, whether or not their time is up. It reads the table directly. */
async function heldCount(userId: number): Promise<number> {
  const count = await db.prepare('SELECT COUNT(*) AS n FROM held_batches WHERE owner_id = ?').bind(userId).first('n')
  return Number(count)
}

describe('purchases that are held', () => {
  it('are held as one batch for their message, and are found as they were given', async () => {
    const { held } = await newUser()
    const first = batch(71, {
      category: 'other',
      purchases: [waiting(1, { unsure: true }), waiting(3, { amountMinor: 990, currency: 'USD', merchant: null })],
    })
    // With no card, when the bot could not tell which.
    const second = batch(72, { cardLast4: null })

    await held.hold(first, NOW)
    await held.hold(second, NOW)

    expect(await held.find(71, NOW)).toEqual(first)
    expect(await held.find(72, NOW)).toEqual(second)
    expect(await held.find(73, NOW)).toBeNull()
  })

  it('are found for a day from when they were held, and not after', async () => {
    const { id, held } = await newUser()
    await held.hold(batch(71), NOW)

    expect(HELD_HOURS).toBe(24)
    expect(await held.find(71, NOW + DAY - 1)).toEqual(batch(71))
    expect(await held.find(71, NOW + DAY)).toBeNull()
    expect(await held.find(71, NOW + 2 * DAY)).toBeNull()
    // They are not let go of for that: the scheduled run deletes them.
    expect(await heldCount(id)).toBe(1)
  })

  it('are found, and let go of, by their own user only', async () => {
    const [owner, other] = [await newUser(), await newUser()]
    await owner.held.hold(batch(71), NOW)

    expect(await other.held.find(71, NOW)).toBeNull()
    expect(await other.held.remove(71)).toBe(false)

    expect(await owner.held.find(71, NOW)).toEqual(batch(71))
    // Two users can each have purchases held for a message with the same id: an id is of one chat.
    await other.held.hold(batch(71, { cardLast4: '5678' }), NOW)
    expect(await owner.held.find(71, NOW)).toMatchObject({ cardLast4: '1234' })
    expect(await other.held.find(71, NOW)).toMatchObject({ cardLast4: '5678' })
  })

  it('take the place of those that are held for the same message, and are held for a day from then', async () => {
    const { id, held } = await newUser()
    await held.hold(batch(71), NOW)
    const again = batch(71, { cardLast4: null, category: 'other', purchases: [waiting(0), waiting(1)] })

    // The message was delivered again, half a day later.
    await held.hold(again, NOW + DAY / 2)

    expect(await heldCount(id)).toBe(1)
    expect(await held.find(71, NOW + DAY)).toEqual(again)
    expect(await held.find(71, NOW + DAY + DAY / 2)).toBeNull()
  })

  it('are let go of once', async () => {
    const { id, held } = await newUser()
    await held.hold(batch(71), NOW)
    await held.hold(batch(72), NOW)

    expect(await held.remove(71)).toBe(true)
    expect(await held.remove(71)).toBe(false)

    expect(await held.find(71, NOW)).toBeNull()
    expect(await held.find(72, NOW)).toEqual(batch(72))
    expect(await heldCount(id)).toBe(1)
  })

  it('are deleted with their user, and nobody else’s are', async () => {
    const [user, other] = [await newUser(), await newUser()]
    await user.held.hold(batch(71), NOW)
    await user.held.hold(batch(72), NOW)
    await other.held.hold(batch(71), NOW)

    await deleteUser(db, user.id)

    expect(await heldCount(user.id)).toBe(0)
    expect(await heldCount(other.id)).toBe(1)
  })
})
