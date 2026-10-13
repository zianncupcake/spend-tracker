// SQL for the reminders of cards' bills: see the migration that added their columns. As in store.ts, what a known
// user sets goes through a store bound to that user. The first two functions cannot: the run that sends reminders
// looks across all users for the one that is due.

/** A reminder that is due, with the card that it is of and where to send it. */
export interface DueReminder {
  cardId: number
  ownerId: number
  nickname: string
  last4: string
  /** The day of the month that the card's reminders are on. */
  day: number
  /** Unix seconds of when it was due. */
  at: number
  /** See `chatId` of `Mailbox` in ./store-mail. */
  chatId: number
  timezone: string
}

/** The reminder that has been due longest at `now`, in unix seconds. Null when none is due. */
export async function findDueReminder(db: D1Database, now: number): Promise<DueReminder | null> {
  return db
    .prepare(
      `SELECT cards.id AS cardId, owner_id AS ownerId, nickname, last4, remind_day AS day, remind_at AS at,
         telegram_id AS chatId, timezone
       FROM cards JOIN users ON users.id = owner_id
       WHERE remind_at <= ?
       ORDER BY remind_at, cards.id
       LIMIT 1`,
    )
    .bind(now)
    .first<DueReminder>()
}

/**
 * Moves the next reminder of a card from one instant to another. False, with nothing moved, when its next one is
 * no longer at `from`: its user has changed it or taken it away in the meantime, or another run has moved it.
 */
export async function moveReminder(db: D1Database, cardId: number, from: number, to: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE cards SET remind_at = ? WHERE id = ? AND remind_at = ?')
    .bind(to, cardId, from)
    .run()
  return result.meta.changes > 0
}

/** Data access for one user's reminders. Every statement is bound to `ownerId`. */
export function reminderStoreFor(db: D1Database, ownerId: number) {
  return {
    /**
     * Sets the day of the reminder of the card with the nickname, with `at` for when its next one is due. A card
     * that has that day already keeps the instant that it has: a reminder that is due, or is waiting to be tried
     * again, is not put off. Returns when its next one is then due, or null when the user has no such card.
     */
    async set(nickname: string, day: number, at: number): Promise<number | null> {
      return db
        .prepare(
          `UPDATE cards SET remind_at = CASE WHEN remind_day = ?1 THEN remind_at ELSE ?2 END, remind_day = ?1
           WHERE owner_id = ?3 AND nickname = ?4
           RETURNING remind_at AS at`,
        )
        .bind(day, at, ownerId, nickname)
        .first<number>('at')
    },

    /** Takes the reminder of the card with the nickname away. */
    async remove(nickname: string): Promise<void> {
      await db
        .prepare('UPDATE cards SET remind_day = NULL, remind_at = NULL WHERE owner_id = ? AND nickname = ?')
        .bind(ownerId, nickname)
        .run()
    },

    /** The user's reminders: the day of each, and when its next one is due. Those that are alike are one. */
    async list(): Promise<{ day: number; at: number }[]> {
      const { results } = await db
        .prepare(
          `SELECT DISTINCT remind_day AS day, remind_at AS at FROM cards
           WHERE owner_id = ? AND remind_at IS NOT NULL`,
        )
        .bind(ownerId)
        .all<{ day: number; at: number }>()
      return results
    },

    /** Moves the user's reminders: each that is on `day` and next due at `from` is next due at `to`. */
    async moveAll(moved: { day: number; from: number; to: number }[]): Promise<void> {
      // One statement, however many cards there are: a request may run 50 queries.
      await db
        .prepare(
          `UPDATE cards SET remind_at = moved.value ->> 'to'
           FROM json_each(?2) AS moved
           WHERE owner_id = ?1 AND remind_day = moved.value ->> 'day' AND remind_at = moved.value ->> 'from'`,
        )
        .bind(ownerId, JSON.stringify(moved))
        .run()
    },
  }
}
