// SQL is run only here and in store-connect.ts, store-mail.ts and store-mcp.ts.

import type { WindowRule } from './domain/window'
import { Failure } from './log'
import type { ParsedTransaction } from './parsers/types'

export interface User {
  id: number
  timezone: string
}

/** `product` is the key of the catalogue product that the card is linked to. A card linked to none has no `product`. */
export type Card = { nickname: string; last4: string; product?: string } & WindowRule

export type NewTransaction = ParsedTransaction & { sourceId: string; parser: string; category?: string | null }

/** A transaction as it is stored. */
export interface Transaction extends ParsedTransaction {
  /** The id of its row, which is what its user knows the purchase by. */
  id: number
  parser: string
  /**
   * The key of a category of its card's product. Null when none is stored for the purchase, which is then in the
   * product's default category, if the product has one.
   */
  category: string | null
}

export interface CurrencyTotal {
  currency: string
  amountMinor: number
  count: number
}

export type CategoryTotal = CurrencyTotal & { category: string | null }

export type Store = ReturnType<typeof storeFor>

/**
 * How many cards a user may have. A request may run 50 queries, and both /spend and an assistant's summary run one
 * for every card.
 */
export const MAX_CARDS = 20

/** What a transaction has for its parser when no alert was parsed for it: its user added the purchase by hand. */
export const MANUAL = 'manual'

/**
 * How many purchases a user may add by hand in 24 hours. Each is a row written, and the database takes only so many
 * writes in a day, from all of its users together.
 */
export const MAX_BY_HAND_PER_DAY = 100

const DAY = 86_400

export async function findOrCreateUser(db: D1Database, telegramId: number): Promise<User> {
  const find = () => db.prepare('SELECT id, timezone FROM users WHERE telegram_id = ?').bind(telegramId).first<User>()
  const create = () =>
    db
      .prepare('INSERT INTO users (telegram_id) VALUES (?) ON CONFLICT (telegram_id) DO NOTHING RETURNING id, timezone')
      .bind(telegramId)
      .first<User>()

  // The insert returns no row when another request created the user first, so look again.
  const user = (await find()) ?? (await create()) ?? (await find())
  if (!user) throw new Failure('no_user_row', 'user row missing after insert')
  return user
}

/** The user with the Telegram id. Null for somebody who has no user row: nothing is stored about them. */
export async function findUser(db: D1Database, telegramId: number): Promise<User | null> {
  return db.prepare('SELECT id, timezone FROM users WHERE telegram_id = ?').bind(telegramId).first<User>()
}

/** The user's Telegram id, which is also the id of their private chat with the bot. Null when the user is gone. */
export async function telegramIdOf(db: D1Database, userId: number): Promise<number | null> {
  return db.prepare('SELECT telegram_id FROM users WHERE id = ?').bind(userId).first<number>('telegram_id')
}

/** Sets the time zone in which the user's days, and so their cards' windows, begin and end. */
export async function setTimezone(db: D1Database, userId: number, timezone: string): Promise<void> {
  await db.prepare('UPDATE users SET timezone = ? WHERE id = ?').bind(timezone, userId).run()
}

/** Deletes the user. Every row they own goes too, through ON DELETE CASCADE. */
export async function deleteUser(db: D1Database, userId: number): Promise<void> {
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()
}

/**
 * Data access for one user. Every statement is bound to `ownerId` here, so
 * nothing built on a store can read or change another user's rows.
 */
export function storeFor(db: D1Database, ownerId: number) {
  return {
    /**
     * False when the user already has a card with that nickname or those last four digits, and when they have as
     * many cards as a user may have.
     */
    async addCard(card: Card): Promise<boolean> {
      const statementDay = card.windowType === 'statement' ? card.statementDay : null
      // The count is part of the statement, so cards added at the same moment cannot go past the limit together.
      const result = await db
        .prepare(
          `INSERT INTO cards (owner_id, nickname, last4, window_type, statement_day, product)
           SELECT ?1, ?2, ?3, ?4, ?5, ?7
           WHERE (SELECT COUNT(*) FROM cards WHERE owner_id = ?1) < ?6
           ON CONFLICT DO NOTHING`,
        )
        .bind(ownerId, card.nickname, card.last4, card.windowType, statementDay, MAX_CARDS, card.product ?? null)
        .run()
      return result.meta.changes > 0
    },

    /** In the order the cards were added. */
    async listCards(): Promise<Card[]> {
      const { results } = await db
        .prepare(
          'SELECT nickname, last4, window_type, statement_day, product FROM cards WHERE owner_id = ? ORDER BY id',
        )
        .bind(ownerId)
        .all<CardRow>()
      return results.map(toCard)
    },

    /**
     * Links the card to a product of the catalogue, by the product's key, or to none. False when the user has no
     * card with that nickname.
     */
    async setProduct(nickname: string, product: string | null): Promise<boolean> {
      const result = await db
        .prepare('UPDATE cards SET product = ? WHERE owner_id = ? AND nickname = ?')
        .bind(product, ownerId, nickname)
        .run()
      return result.meta.changes > 0
    },

    /** False when the user has no card with that nickname. */
    async removeCard(nickname: string): Promise<boolean> {
      const result = await db
        .prepare('DELETE FROM cards WHERE owner_id = ? AND nickname = ?')
        .bind(ownerId, nickname)
        .run()
      return result.meta.changes > 0
    },

    /**
     * The id of the row that the transaction is stored in. Null, with nothing inserted, when the user already has
     * a transaction with that source id: one that they have taken out counts too, so it is never stored again.
     * Null as well for a purchase added by hand, when the user has added as many in the last 24 hours as a user
     * may. Those that they have taken out since count there too, as each of them was a row written.
     */
    async insertTransaction(transaction: NewTransaction): Promise<number | null> {
      const { sourceId, cardLast4, amountMinor, currency, merchant, occurredAt, parser, category = null } = transaction
      // Only what is added by hand has a limit. The count is part of the statement, so purchases added at the same
      // moment cannot go past the limit together.
      const limit = parser === MANUAL ? MAX_BY_HAND_PER_DAY : null
      return db
        .prepare(
          `INSERT INTO transactions
             (owner_id, source_id, card_last4, amount_minor, currency, merchant, occurred_at, parser, category)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
           WHERE ?10 IS NULL OR ?10 > (
             SELECT COUNT(*) FROM transactions
             WHERE owner_id = ?1 AND parser = ?8 AND created_at > unixepoch() - ?11
           )
           ON CONFLICT (owner_id, source_id) DO NOTHING
           RETURNING id`,
        )
        .bind(ownerId, sourceId, cardLast4, amountMinor, currency, merchant, occurredAt, parser, category, limit, DAY)
        .first<number>('id')
    },

    /** Total and purchase count per currency for one card, over `start <= occurred_at < end` in unix seconds. */
    async sumByCurrency(cardLast4: string, start: number, end: number): Promise<CurrencyTotal[]> {
      const { results } = await db
        .prepare(
          `SELECT currency, SUM(amount_minor) AS amountMinor, COUNT(*) AS count
           FROM transactions
           WHERE owner_id = ? AND card_last4 = ? AND occurred_at >= ? AND occurred_at < ? AND removed_at IS NULL
           GROUP BY currency
           ORDER BY currency`,
        )
        .bind(ownerId, cardLast4, start, end)
        .all<CurrencyTotal>()
      return results
    },

    /**
     * The same for one card, with each currency's purchases told apart by the category that is stored for them.
     * Those that none is stored for have null for it.
     */
    async sumByCategory(cardLast4: string, start: number, end: number): Promise<CategoryTotal[]> {
      const { results } = await db
        .prepare(
          `SELECT currency, category, SUM(amount_minor) AS amountMinor, COUNT(*) AS count
           FROM transactions
           WHERE owner_id = ? AND card_last4 = ? AND occurred_at >= ? AND occurred_at < ? AND removed_at IS NULL
           GROUP BY currency, category
           ORDER BY currency, category`,
        )
        .bind(ownerId, cardLast4, start, end)
        .all<CategoryTotal>()
      return results
    },

    /**
     * The user's purchases over `start <= occurred_at < end` in unix seconds,
     * newest first and no more than `limit` of them: those of one card, or of
     * every card when `cardLast4` is null.
     */
    async listTransactions(
      cardLast4: string | null,
      start: number,
      end: number,
      limit: number,
    ): Promise<Transaction[]> {
      const { results } = await db
        .prepare(
          `SELECT ${TRANSACTION}
           FROM transactions
           WHERE owner_id = ?1 AND (?2 IS NULL OR card_last4 = ?2) AND occurred_at >= ?3 AND occurred_at < ?4
             AND removed_at IS NULL
           ORDER BY occurred_at DESC, id DESC
           LIMIT ?5`,
        )
        .bind(ownerId, cardLast4, start, end, limit)
        .all<Transaction>()
      return results
    },

    /** The user's purchase with the id. Null when they have none with it, or have taken it out. */
    async findTransaction(id: number): Promise<Transaction | null> {
      return db
        .prepare(`SELECT ${TRANSACTION} FROM transactions WHERE owner_id = ? AND id = ? AND removed_at IS NULL`)
        .bind(ownerId, id)
        .first<Transaction>()
    },

    /**
     * The user's purchase that is stored under the source id, with when they took it out: null while they have
     * not. The whole is null when they have none under that id.
     */
    async findBySourceId(sourceId: string): Promise<(Transaction & { removedAt: number | null }) | null> {
      return db
        .prepare(
          `SELECT ${TRANSACTION}, removed_at AS removedAt FROM transactions WHERE owner_id = ? AND source_id = ?`,
        )
        .bind(ownerId, sourceId)
        .first<Transaction & { removedAt: number | null }>()
    },

    /**
     * Stores a category for a purchase. False, with nothing changed, when that category is stored for it already,
     * and when the user has no such purchase. So of two requests that move it the same way, one finds it done.
     */
    async setCategory(id: number, category: string): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE transactions SET category = ?1
           WHERE owner_id = ?2 AND id = ?3 AND removed_at IS NULL AND category IS NOT ?1`,
        )
        .bind(category, ownerId, id)
        .run()
      return result.meta.changes > 0
    },

    /** Stores a category for those of the purchases with the ids that none is stored for yet. */
    async sortUnsorted(ids: number[], category: string): Promise<void> {
      // The ids go in as one JSON array, as a statement takes 100 bound values at most.
      await db
        .prepare(
          `UPDATE transactions SET category = ?2
           WHERE owner_id = ?1 AND category IS NULL AND removed_at IS NULL
             AND id IN (SELECT value FROM json_each(?3))`,
        )
        .bind(ownerId, category, JSON.stringify(ids))
        .run()
    },

    /**
     * Takes a purchase out, and returns it as it was. Null when the user has no such purchase, or has taken it out
     * already. The row stays, marked: see the migration that added the mark.
     */
    async removeTransaction(id: number): Promise<Transaction | null> {
      return db
        .prepare(
          `UPDATE transactions SET removed_at = unixepoch()
           WHERE owner_id = ? AND id = ? AND removed_at IS NULL
           RETURNING ${TRANSACTION}`,
        )
        .bind(ownerId, id)
        .first<Transaction>()
    },
  }
}

/** The columns of a transaction, named as the fields of a `Transaction` are. */
const TRANSACTION =
  'id, card_last4 AS cardLast4, amount_minor AS amountMinor, currency, merchant, occurred_at AS occurredAt, ' +
  'parser, category'

interface CardRow {
  nickname: string
  last4: string
  window_type: 'statement' | 'calendar'
  statement_day: number | null
  product: string | null
}

function toCard({ nickname, last4, window_type, statement_day, product }: CardRow): Card {
  const card = { nickname, last4, ...(product !== null && { product }) }
  // The schema guarantees a statement card has a day. The null check is for the type checker.
  return window_type === 'statement' && statement_day !== null
    ? { ...card, windowType: 'statement', statementDay: statement_day }
    : { ...card, windowType: 'calendar' }
}
