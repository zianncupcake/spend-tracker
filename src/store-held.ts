// SQL for the purchases that were read from a message, such as a photo, and wait for their user's answer: see the
// migration that added their table. As in store.ts, whatever concerns a known user goes through a store bound to
// that user. The one statement that is bound to none deletes the batches whose time is up, and is in store-mail.ts,
// with the others that the scheduled run makes across all users.

/** How long a batch waits for its user's answer, in hours. */
export const HELD_HOURS = 24

/** A purchase that was read from a message, and is not stored yet. */
export interface HeldPurchase {
  /** Its place among the purchases of its reading, counted from 0. It is stored under that place. */
  place: number
  /** Unix seconds. */
  occurredAt: number
  /** Hundredths of the currency unit. */
  amountMinor: number
  currency: string
  merchant: string | null
  /** Whether the model was not sure of its amount or of its date. */
  unsure: boolean
}

/** The purchases of one message that wait for their user's answer. */
export interface HeldBatch {
  /** Telegram's id of the message that they were read from. */
  messageId: number
  /** The last four digits of the card that the purchases are added to. Null when the bot could not tell which card. */
  cardLast4: string | null
  /** The key of the category that the message named for them. Null when it named none. */
  category: string | null
  purchases: HeldPurchase[]
}

/** Data access for one user's held purchases. Every statement is bound to `ownerId`. */
export function heldStoreFor(db: D1Database, ownerId: number) {
  return {
    /**
     * Holds the batch from `now`, in unix seconds, for as long as a batch is held. A message that Telegram delivers
     * again brings its purchases again: they take the place of the batch that is held for the message, if one is.
     */
    async hold(batch: HeldBatch, now: number): Promise<void> {
      const { messageId, cardLast4, category, purchases } = batch
      await db
        .prepare(
          `INSERT INTO held_batches (owner_id, message_id, card_last4, category, purchases, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, message_id) DO UPDATE SET
             card_last4 = excluded.card_last4, category = excluded.category, purchases = excluded.purchases,
             expires_at = excluded.expires_at`,
        )
        .bind(ownerId, messageId, cardLast4, category, JSON.stringify(purchases), now + HELD_HOURS * 3600)
        .run()
    },

    /**
     * The batch that is held for the message, while its time is not up at `now`, in unix seconds. Null when the
     * user has none for it: it was let go of, it is too old, or it is somebody else's.
     */
    async find(messageId: number, now: number): Promise<HeldBatch | null> {
      const row = await db
        .prepare(
          `SELECT message_id AS messageId, card_last4 AS cardLast4, category, purchases FROM held_batches
           WHERE owner_id = ? AND message_id = ? AND expires_at > ?`,
        )
        .bind(ownerId, messageId, now)
        .first<Omit<HeldBatch, 'purchases'> & { purchases: string }>()
      // The purchases are read back as they were written by `hold`, which is the only thing that writes them.
      return row && { ...row, purchases: JSON.parse(row.purchases) }
    },

    /** Lets go of the batch that is held for the message. False when none was held for it. */
    async remove(messageId: number): Promise<boolean> {
      const result = await db
        .prepare('DELETE FROM held_batches WHERE owner_id = ? AND message_id = ?')
        .bind(ownerId, messageId)
        .run()
      return result.meta.changes > 0
    },
  }
}
