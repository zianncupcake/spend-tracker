// SQL for Google sign-in: a user's Gmail connection and their sign-in in
// progress. As in store.ts, whatever concerns a known user goes through a
// store bound to that user.

export interface Connection {
  email: string
  status: 'active' | 'needs_reconnect'
}

/** A sign-in whose link still works. */
export interface OpenAttempt {
  ownerId: number
  codeVerifier: string
}

/** What Google's redirect back leaves on an attempt, which then waits for its confirmation code. */
export interface PendingSignIn {
  email: string
  refreshTokenEnc: string
  confirmCodeHash: string
  /** Unix seconds. */
  expiresAt: number
}

/** A mailbox with the encrypted token that reads it: what a connection holds, and a sign-in that waits for its code. */
export interface HeldMailbox {
  email: string
  refreshTokenEnc: string
}

/**
 * The attempt that a link's state belongs to, while the link still works: it
 * has not expired and Google has not redirected back with its state yet. This
 * and the two functions after it are the lookups that cannot be bound to a
 * user. A state is all that a browser brings, and a mailbox can be held for
 * more than one user.
 */
export async function findAttemptByState(db: D1Database, stateHash: string, now: number): Promise<OpenAttempt | null> {
  return db
    .prepare(
      `SELECT owner_id AS ownerId, code_verifier AS codeVerifier
       FROM connect_attempts
       WHERE state_hash = ? AND expires_at > ? AND claimed = 0`,
    )
    .bind(stateHash, now)
    .first<OpenAttempt>()
}

/**
 * Claims the attempt that a link's state belongs to, for the one redirect back
 * from Google that gets to use it. Null when the link no longer works, and it
 * does not once its attempt is claimed. So however many redirects bring the
 * same state, only the first of them has an attempt to act on.
 */
export async function claimAttempt(db: D1Database, stateHash: string, now: number): Promise<OpenAttempt | null> {
  return db
    .prepare(
      `UPDATE connect_attempts
       SET claimed = 1
       WHERE state_hash = ? AND expires_at > ? AND claimed = 0
       RETURNING owner_id AS ownerId, code_verifier AS codeVerifier`,
    )
    .bind(stateHash, now)
    .first<OpenAttempt>()
}

/**
 * Whether the mailbox is held for anybody at all: by a connection that Google
 * still honours, or by a sign-in that waits for its code.
 */
export async function isMailboxHeld(db: D1Database, email: string): Promise<boolean> {
  const held = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM google_connections WHERE email = ?1 AND status = 'active')
         OR EXISTS (SELECT 1 FROM connect_attempts WHERE email = ?1) AS held`,
    )
    .bind(email)
    .first<number>('held')
  return held === 1
}

/**
 * Whether a row of connect_attempts holds a mailbox. The schema has it hold an
 * address and a token together, or neither.
 */
export function holdsMailbox(attempt: { email: string | null } | null): attempt is HeldMailbox {
  return attempt !== null && attempt.email !== null
}

/** Data access for one user's Gmail connection and sign-in. Every statement is bound to `ownerId`. */
export function connectStoreFor(db: D1Database, ownerId: number) {
  return {
    async findConnection(): Promise<Connection | null> {
      return db
        .prepare('SELECT email, status FROM google_connections WHERE owner_id = ?')
        .bind(ownerId)
        .first<Connection>()
    },

    /**
     * Makes the mailbox the user's connection, in place of any earlier one, and ends their attempt. `now` is when
     * that is, in unix seconds.
     */
    async saveConnection(email: string, refreshTokenEnc: string, now: number): Promise<void> {
      await db.batch([
        db
          .prepare(
            `INSERT OR REPLACE INTO google_connections (owner_id, email, refresh_token_enc, connected_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(ownerId, email, refreshTokenEnc, now),
        db.prepare('DELETE FROM connect_attempts WHERE owner_id = ?').bind(ownerId),
      ])
    },

    /** Deletes the connection and returns what it held, or null when the user has none. */
    async removeConnection(): Promise<HeldMailbox | null> {
      return db
        .prepare(
          'DELETE FROM google_connections WHERE owner_id = ? RETURNING email, refresh_token_enc AS refreshTokenEnc',
        )
        .bind(ownerId)
        .first<HeldMailbox>()
    },

    /** Starts an attempt, in place of any the user already has. */
    async startAttempt(stateHash: string, codeVerifier: string, expiresAt: number): Promise<void> {
      await db
        .prepare(
          `INSERT OR REPLACE INTO connect_attempts (owner_id, state_hash, code_verifier, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(ownerId, stateHash, codeVerifier, expiresAt)
        .run()
    },

    /**
     * Leaves the attempt waiting for its confirmation code. False, with nothing
     * changed, when the state does not belong to an attempt that has been
     * claimed and holds no mailbox yet: the attempt was replaced while its
     * owner was at Google.
     */
    async holdForCode(stateHash: string, pending: PendingSignIn): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE connect_attempts
           SET email = ?, refresh_token_enc = ?, confirm_code_hash = ?, expires_at = ?
           WHERE owner_id = ? AND state_hash = ? AND claimed = 1 AND confirm_code_hash IS NULL`,
        )
        .bind(pending.email, pending.refreshTokenEnc, pending.confirmCodeHash, pending.expiresAt, ownerId, stateHash)
        .run()
      return result.meta.changes > 0
    },

    /**
     * Counts one try against the attempt that is waiting for its code, and
     * returns that attempt with the count. Null when no attempt is waiting, or
     * it has had `maxTries` already.
     */
    async countTry(maxTries: number): Promise<(PendingSignIn & { confirmTries: number }) | null> {
      return db
        .prepare(
          `UPDATE connect_attempts
           SET confirm_tries = confirm_tries + 1
           WHERE owner_id = ? AND confirm_code_hash IS NOT NULL AND confirm_tries < ?
           RETURNING email, refresh_token_enc AS refreshTokenEnc, confirm_code_hash AS confirmCodeHash,
             expires_at AS expiresAt, confirm_tries AS confirmTries`,
        )
        .bind(ownerId, maxTries)
        .first<PendingSignIn & { confirmTries: number }>()
    },

    /** Deletes the attempt and returns the mailbox it held, or null when there was no attempt or it held none. */
    async removeAttempt(): Promise<HeldMailbox | null> {
      const attempt = await db
        .prepare(
          'DELETE FROM connect_attempts WHERE owner_id = ? RETURNING email, refresh_token_enc AS refreshTokenEnc',
        )
        .bind(ownerId)
        .first<{ email: string | null; refreshTokenEnc: string | null }>()
      return holdsMailbox(attempt) ? attempt : null
    },
  }
}
