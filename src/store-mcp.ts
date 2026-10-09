// SQL for the MCP endpoint: the token that lets a user's AI assistant in. As
// in store.ts, whatever concerns a known user goes through a store bound to
// that user.

import type { User } from './store'

/**
 * The user that a token belongs to, found by the token's hash. This is the
 * one lookup that cannot be bound to a user, because the token is all that an
 * assistant brings.
 */
export async function findUserByTokenHash(db: D1Database, tokenHash: string): Promise<User | null> {
  return db
    .prepare(
      `SELECT users.id, users.timezone
       FROM mcp_tokens JOIN users ON users.id = mcp_tokens.owner_id
       WHERE mcp_tokens.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<User>()
}

/** Data access for one user's assistant token. Every statement is bound to `ownerId`. */
export function mcpStoreFor(db: D1Database, ownerId: number) {
  return {
    /** Makes the hash the user's token, in place of any they had. */
    async setToken(tokenHash: string): Promise<void> {
      // Not INSERT OR REPLACE: that would also delete a row of another user's that held the same hash.
      await db
        .prepare(
          `INSERT INTO mcp_tokens (owner_id, token_hash) VALUES (?, ?)
           ON CONFLICT (owner_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = unixepoch()`,
        )
        .bind(ownerId, tokenHash)
        .run()
    },

    /** False when the user had no token. */
    async removeToken(): Promise<boolean> {
      const result = await db.prepare('DELETE FROM mcp_tokens WHERE owner_id = ?').bind(ownerId).run()
      return result.meta.changes > 0
    },
  }
}
