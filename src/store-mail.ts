// SQL for the mail checker: whose mailbox is read next, and which alerts it
// has already been through. As in store.ts, whatever concerns a known user goes
// through a store bound to that user. The first three functions cannot: each
// looks across all users for the work that is due.

import { MANUAL } from './store'
import { holdsMailbox, type HeldMailbox } from './store-connect'

/** A connection whose turn it is to be checked, with where to tell its user what is found. */
export interface Mailbox {
  ownerId: number
  email: string
  refreshTokenEnc: string
  /** Unix seconds. */
  connectedAt: number
  /** Unix seconds. Null until a run has found nothing left to read. */
  lastCheckedAt: number | null
  /** The token of the page of the search that this run is to go on from. Null when no run has left one. */
  backlogPageToken: string | null
  /** The user's Telegram id, which is also the id of their private chat with the bot. */
  chatId: number
  timezone: string
}

/** Why an alert that was fetched was not stored: no parser could read it, or it was not shown to be from the bank. */
export type SeenStatus = 'unparsed' | 'rejected'

export interface MailSummary {
  /** Unix seconds. Null when no run has yet found nothing left to read, and when there is no connection. */
  lastCheckedAt: number | null
  /** Purchases stored since the time asked about. */
  purchases: number
  /** Alerts that no parser could read, seen since then. */
  unparsed: number
}

/**
 * Deletes up to `limit` sign-ins that have run out of time. Returns, for each that it deleted, the mailbox that the
 * sign-in held, or null when it held none: Google had brought it no mailbox yet.
 */
export async function removeExpiredAttempts(
  db: D1Database,
  now: number,
  limit: number,
): Promise<(HeldMailbox | null)[]> {
  const { results } = await db
    .prepare(
      `DELETE FROM connect_attempts
       WHERE owner_id IN (SELECT owner_id FROM connect_attempts WHERE expires_at <= ? LIMIT ?)
       RETURNING email, refresh_token_enc AS refreshTokenEnc`,
    )
    .bind(now, limit)
    .all<{ email: string | null; refreshTokenEnc: string | null }>()
  return results.map((attempt) => (holdsMailbox(attempt) ? attempt : null))
}

/**
 * Deletes the held purchases that nobody answered for: every batch whose time was up at `now`, in unix seconds,
 * whoever it is held for. See store-held.ts for what a batch is. Returns how many batches it deleted.
 */
export async function removeExpiredBatches(db: D1Database, now: number): Promise<number> {
  const result = await db.prepare('DELETE FROM held_batches WHERE expires_at <= ?').bind(now).run()
  return result.meta.changes
}

/**
 * Gives the next turn to the active connection that has waited longest: since
 * its last run or, when it has had none, since it was made. So a connection
 * that is new, or has been made again, takes its place behind those that are
 * waiting already. Of two that have waited as long, one that has had no run
 * goes first. The turn is recorded as taken at once, so a run that fails does
 * not keep the others waiting. Null when no connection is active.
 */
export async function takeNextMailbox(db: D1Database, now: number): Promise<Mailbox | null> {
  return db
    .prepare(
      `UPDATE google_connections
       SET last_run_at = ?
       WHERE owner_id = (
         SELECT owner_id FROM google_connections
         WHERE status = 'active'
         ORDER BY COALESCE(last_run_at, connected_at), last_run_at NULLS FIRST, owner_id
         LIMIT 1
       )
       RETURNING owner_id AS ownerId, email, refresh_token_enc AS refreshTokenEnc, connected_at AS connectedAt,
         last_checked_at AS lastCheckedAt, backlog_page_token AS backlogPageToken,
         (SELECT telegram_id FROM users WHERE id = owner_id) AS chatId,
         (SELECT timezone FROM users WHERE id = owner_id) AS timezone`,
    )
    .bind(now)
    .first<Mailbox>()
}

/** Data access for the checking of one user's mailbox. Every statement is bound to `ownerId`. */
export function mailStoreFor(db: D1Database, ownerId: number) {
  return {
    /**
     * Those of the ids, in the order given, that the user has no transaction,
     * payment or note of having seen for.
     */
    async unknownIds(ids: string[]): Promise<string[]> {
      // The ids go in as one JSON array. A statement takes 100 bound values at
      // most, and a page of a listing holds 100 ids.
      const { results } = await db
        .prepare(
          `SELECT listed.value AS id
           FROM json_each(?2) AS listed
           WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE owner_id = ?1 AND source_id = listed.value)
             AND NOT EXISTS (SELECT 1 FROM payments WHERE owner_id = ?1 AND source_id = listed.value)
             AND NOT EXISTS (SELECT 1 FROM seen_alerts WHERE owner_id = ?1 AND source_id = listed.value)
           ORDER BY listed.key`,
        )
        .bind(ownerId, JSON.stringify(ids))
        .all<{ id: string }>()
      return results.map((listed) => listed.id)
    },

    /** Notes an alert that was fetched and not stored, so that it is not fetched again. */
    async markSeen(sourceId: string, status: SeenStatus): Promise<void> {
      await db
        .prepare('INSERT INTO seen_alerts (owner_id, source_id, status) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(ownerId, sourceId, status)
        .run()
    },

    /**
     * Marks the user's active connection as one that Google has ended the
     * access of. It has no more turns until the user connects again.
     */
    async markNeedsReconnect(): Promise<void> {
      await db
        .prepare("UPDATE google_connections SET status = 'needs_reconnect' WHERE owner_id = ? AND status = 'active'")
        .bind(ownerId)
        .run()
    },

    /**
     * Notes the page of the search that the next run is to go on from, by its token. With null, the next run
     * begins with the first page and goes on from there.
     */
    async setBacklogPageToken(pageToken: string | null): Promise<void> {
      await db
        .prepare('UPDATE google_connections SET backlog_page_token = ? WHERE owner_id = ?')
        .bind(pageToken, ownerId)
        .run()
    },

    /**
     * Records that a run found nothing left to read in the mailbox. The search that follows a full check is a new
     * one, so no page of the old one is kept.
     */
    async markChecked(now: number): Promise<void> {
      await db
        .prepare('UPDATE google_connections SET last_checked_at = ?, backlog_page_token = NULL WHERE owner_id = ?')
        .bind(now, ownerId)
        .run()
    },

    /**
     * How the checking of the user's mailbox has gone since `since`, in unix seconds. The purchases counted are
     * those read from alerts: not the ones that the user added by hand, and none that they have taken out.
     */
    async summary(since: number): Promise<MailSummary> {
      const { results } = await db
        .prepare(
          `SELECT
             (SELECT last_checked_at FROM google_connections WHERE owner_id = ?1) AS lastCheckedAt,
             (SELECT COUNT(*) FROM transactions
              WHERE owner_id = ?1 AND created_at >= ?2 AND removed_at IS NULL AND parser <> ?3) AS purchases,
             (SELECT COUNT(*) FROM seen_alerts
              WHERE owner_id = ?1 AND status = 'unparsed' AND seen_at >= ?2) AS unparsed`,
        )
        .bind(ownerId, since, MANUAL)
        .all<MailSummary>()
      return results[0]
    },
  }
}
