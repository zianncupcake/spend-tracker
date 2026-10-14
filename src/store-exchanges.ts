// SQL for a user's recent exchanges with the assistant: see the migration that added their table. As in store.ts,
// what concerns a known user goes through a store bound to that user. `removeOldExchanges` cannot: the scheduled run
// deletes the old rows of all users at once.

/** How long an exchange is kept, and sent with a later question, in seconds. */
export const EXCHANGE_SECONDS = 30 * 60

/** How many of a user's exchanges are kept: the latest. */
const KEPT = 3

/** How many characters of a reply are kept: the first. Each is sent with every request of a later question. */
const MAX_REPLY = 1000

/**
 * A question that the assistant answered, the text of the bot's reply to it, and whether the reply can hold text
 * that somebody else wrote: see the migration, and `afterReading` of `Answer` in ./ai/assistant.
 */
export interface Exchange {
  question: string
  reply: string
  read: boolean
}

/** Data access for one user's recent exchanges. Every statement is bound to `ownerId`. */
export function exchangeStoreFor(db: D1Database, ownerId: number) {
  return {
    /** The user's latest exchanges since `since`, in unix seconds, oldest first. One query. */
    async recent(since: number): Promise<Exchange[]> {
      const { results } = await db
        .prepare(
          `SELECT question, reply, read FROM recent_exchanges
           WHERE owner_id = ? AND at >= ?
           ORDER BY at DESC, id DESC
           LIMIT ?`,
        )
        .bind(ownerId, since, KEPT)
        .all<Omit<Exchange, 'read'> & { read: number }>()
      return results.reverse().map((row) => ({ ...row, read: row.read === 1 }))
    },

    /**
     * Keeps the exchange as of `at`, in unix seconds, with its reply cut to MAX_REPLY, and lets go of any of the
     * user's past the latest KEPT.
     */
    async keep({ question, reply, read }: Exchange, at: number): Promise<void> {
      await db.batch([
        db
          .prepare('INSERT INTO recent_exchanges (owner_id, at, question, reply, read) VALUES (?, ?, ?, ?, ?)')
          .bind(ownerId, at, question, reply.slice(0, MAX_REPLY), read ? 1 : 0),
        db
          .prepare(
            `DELETE FROM recent_exchanges WHERE owner_id = ?1 AND id NOT IN
               (SELECT id FROM recent_exchanges WHERE owner_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2)`,
          )
          .bind(ownerId, KEPT),
      ])
    },
  }
}

/** Deletes every exchange, whoever it is of, that is older than EXCHANGE_SECONDS at `now`, in unix seconds. */
export async function removeOldExchanges(db: D1Database, now: number): Promise<void> {
  await db.prepare('DELETE FROM recent_exchanges WHERE at < ?').bind(now - EXCHANGE_SECONDS).run()
}
