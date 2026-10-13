// SQL for the monthly review: see the migration that added its column and its table. As in store.ts, what concerns
// a known user goes through a store bound to that user. The first two functions cannot: the run that reviews looks
// across all users for the one that is due.

/** A user whose review is due, with where to send what it offers. */
export interface DueReview {
  id: number
  /** See `chatId` of `Mailbox` in ./store-mail. */
  chatId: number
  timezone: string
  /** Unix seconds of when it was due. */
  at: number
}

/** A merchant that was offered for a card as a pattern, by the letters of its name: see `lettersOf`. */
interface Offered {
  cardLast4: string
  letters: string
}

/** The user whose review has been due longest at `now`, in unix seconds. Null when none is due. */
export async function findDueReview(db: D1Database, now: number): Promise<DueReview | null> {
  return db
    .prepare(
      `SELECT id, telegram_id AS chatId, timezone, review_at AS at FROM users
       WHERE review_at <= ?
       ORDER BY review_at, id
       LIMIT 1`,
    )
    .bind(now)
    .first<DueReview>()
}

/**
 * Moves the next review of a user from one instant to another. False, with nothing moved, when their next one is
 * no longer at `from`: another run has moved it, or their time zone was changed in the meantime.
 */
export async function moveReview(db: D1Database, userId: number, from: number, to: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE users SET review_at = ? WHERE id = ? AND review_at = ?')
    .bind(to, userId, from)
    .run()
  return result.meta.changes > 0
}

/** Data access for what one user's reviews have offered. Every statement is bound to `ownerId`. */
export function offerStoreFor(db: D1Database, ownerId: number) {
  return {
    async list(): Promise<Offered[]> {
      const { results } = await db
        .prepare('SELECT card_last4 AS cardLast4, letters FROM pattern_offers WHERE owner_id = ?')
        .bind(ownerId)
        .all<Offered>()
      return results
    },

    /** Records the offers, none of which the user has been made before. */
    async record(offers: Offered[]): Promise<void> {
      // One statement, however many there are: a run may make 50 queries.
      await db
        .prepare(
          `INSERT INTO pattern_offers (owner_id, card_last4, letters)
           SELECT ?1, value ->> 'cardLast4', value ->> 'letters' FROM json_each(?2)`,
        )
        .bind(ownerId, JSON.stringify(offers))
        .run()
    },
  }
}
