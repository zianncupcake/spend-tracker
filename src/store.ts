// SQL is run only here and in store-connect.ts, store-held.ts, store-mail.ts, store-mcp.ts, store-reminders.ts and
// store-review.ts.

import { lettersOf } from './catalogue/merchants'
import type { WindowRule } from './domain/window'
import { Failure } from './log'
import type { ParsedTransaction } from './parsers/types'

export interface User {
  id: number
  timezone: string
}

/**
 * `product` is the key of the catalogue product that the card is linked to. A card linked to none has no `product`.
 * `remindDay` is the day of the month on which its user is reminded of its bill, and a card with no reminder has none.
 */
export type Card = { nickname: string; last4: string; product?: string; remindDay?: number } & WindowRule

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

/** A transaction with the source id that it is stored under, and with when its user took it out: null while not. */
export type Sourced = Transaction & { sourceId: string; removedAt: number | null }

export interface CurrencyTotal {
  currency: string
  amountMinor: number
  count: number
}

export type CategoryTotal = CurrencyTotal & { category: string | null }

/** A monthly pattern of a user's, as it is stored: see the migration that added the table for what each field is. */
export interface Pattern {
  cardLast4: string
  merchant: string
  amountMinor: number
  skips: string[]
}

/** What a user marked a purchase at a merchant as: see the migration that added the table. */
export interface Mark {
  product: string
  letters: string
  category: string
}

export type Store = ReturnType<typeof storeFor>

/**
 * How many cards a user may have. A request may run 50 queries, and both /spend and an assistant's summary run one
 * for every card.
 */
export const MAX_CARDS = 20

/** How many patterns a user may have. /spend with a card reads all of them, and has little CPU time. */
export const MAX_PATTERNS = 50

/** How many characters the merchant of a pattern may have. */
export const MAX_PATTERN_MERCHANT = 40

/**
 * How many letters and digits the merchant of a pattern has at the least. A shorter name is held by merchants that
 * it does not mean, as "sp" is by a streaming service and by a sports hall alike.
 */
export const MIN_PATTERN_LETTERS = 3

/** How many skipped days a pattern may have: a year of months. All of them are in one message when it is shown. */
export const MAX_PATTERN_SKIPS = 12

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

/**
 * Sets the time zone in which the user's days, and so their cards' windows, begin and end. Their next review was
 * due by the clock of the zone before, so none is set from here on: see reviewDueUser in ./review.
 */
export async function setTimezone(db: D1Database, userId: number, timezone: string): Promise<void> {
  await db.prepare('UPDATE users SET timezone = ?, review_at = 0 WHERE id = ?').bind(timezone, userId).run()
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
  /**
   * The statement that forgets the category of every purchase on the card with the nickname that its user has not
   * taken out, of whatever month. A category is a key of the card's product, and another product can have one of the
   * same key: so it goes when the card is given another product, and when the card is removed, as one that is added
   * for those digits later may have another product.
   */
  const forgetting = (nickname: string) =>
    db
      .prepare(
        `UPDATE transactions SET category = NULL
         WHERE owner_id = ?1 AND category IS NOT NULL AND removed_at IS NULL
           AND card_last4 = (SELECT last4 FROM cards WHERE owner_id = ?1 AND nickname = ?2)`,
      )
      .bind(ownerId, nickname)

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
          `SELECT nickname, last4, window_type, statement_day, product, remind_day FROM cards
           WHERE owner_id = ? ORDER BY id`,
        )
        .bind(ownerId)
        .all<CardRow>()
      return results.map(toCard)
    },

    /**
     * Links the card to a product of the catalogue, by the product's key, or to none. With `forget`, which is for a
     * card that had another product, the categories of its purchases are forgotten in the same batch.
     */
    async setProduct(nickname: string, product: string | null, forget = false): Promise<void> {
      const linking = db
        .prepare('UPDATE cards SET product = ? WHERE owner_id = ? AND nickname = ?')
        .bind(product, ownerId, nickname)
      await db.batch(forget ? [forgetting(nickname), linking] : [linking])
    },

    /**
     * Gives the card another nickname, and changes nothing else of it. False, with nothing changed, when the user
     * has no card with that nickname, and when a card of theirs has the new one already: which the card itself has
     * when the two are the same.
     */
    async renameCard(nickname: string, renamed: string): Promise<boolean> {
      // The table takes no nickname that another card of its user's has. With OR IGNORE that leaves the row as it
      // is, where it would fail the statement.
      const result = await db
        .prepare('UPDATE OR IGNORE cards SET nickname = ?1 WHERE owner_id = ?2 AND nickname = ?3 AND ?1 <> ?3')
        .bind(renamed, ownerId, nickname)
        .run()
      return result.meta.changes > 0
    },

    /**
     * Removes the card, and its patterns with it. Its purchases stay, with their categories forgotten. Returns how
     * many patterns there were, or null when the user has no card with that nickname.
     */
    async removeCard(nickname: string): Promise<number | null> {
      // The card goes last, while it is there to tell which patterns and purchases are its own.
      const [patterns, , card] = await db.batch([
        db
          .prepare(
            `DELETE FROM patterns
             WHERE owner_id = ?1 AND card_last4 = (SELECT last4 FROM cards WHERE owner_id = ?1 AND nickname = ?2)`,
          )
          .bind(ownerId, nickname),
        forgetting(nickname),
        db.prepare('DELETE FROM cards WHERE owner_id = ? AND nickname = ?').bind(ownerId, nickname),
      ])
      return card.meta.changes > 0 ? patterns.meta.changes : null
    },

    /**
     * Saves the pattern, in the place of the one that the card has for that merchant, however its name was spelt
     * there: a pattern goes by the letters and digits of its merchant's name. False, with nothing saved, when the
     * user has no card with those digits, and when it would be one more pattern than a user may have.
     */
    async setPattern({ cardLast4, merchant, amountMinor, skips }: Pattern): Promise<boolean> {
      // The card and the count are part of the statement. So a pattern that is saved as its card is removed is
      // not left for no card, and patterns saved at the same moment cannot go past the limit together. One that
      // takes the place of another adds none.
      const result = await db
        .prepare(
          `INSERT INTO patterns (owner_id, card_last4, letters, merchant, amount_minor, skips)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE EXISTS (SELECT 1 FROM cards WHERE owner_id = ?1 AND last4 = ?2)
             AND ((SELECT COUNT(*) FROM patterns WHERE owner_id = ?1) < ?7
               OR EXISTS (SELECT 1 FROM patterns WHERE owner_id = ?1 AND card_last4 = ?2 AND letters = ?3))
           ON CONFLICT (owner_id, card_last4, letters) DO UPDATE SET
             merchant = excluded.merchant, amount_minor = excluded.amount_minor, skips = excluded.skips`,
        )
        .bind(ownerId, cardLast4, lettersOf(merchant), merchant, amountMinor, JSON.stringify(skips), MAX_PATTERNS)
        .run()
      return result.meta.changes > 0
    },

    /** False when the card has no pattern for that merchant, however its name is spelt. */
    async removePattern(cardLast4: string, merchant: string): Promise<boolean> {
      const result = await db
        .prepare('DELETE FROM patterns WHERE owner_id = ? AND card_last4 = ? AND letters = ?')
        .bind(ownerId, cardLast4, lettersOf(merchant))
        .run()
      return result.meta.changes > 0
    },

    /** The user's patterns, on all their cards: those of a card by the letters of their merchants' names. */
    async listPatterns(): Promise<Pattern[]> {
      const { results } = await db
        .prepare(
          `SELECT card_last4 AS cardLast4, merchant, amount_minor AS amountMinor, skips FROM patterns
           WHERE owner_id = ? ORDER BY card_last4, letters`,
        )
        .bind(ownerId)
        .all<Omit<Pattern, 'skips'> & { skips: string }>()
      // The days are read back as `setPattern` wrote them, which is the only thing that writes them.
      return results.map((row) => ({ ...row, skips: JSON.parse(row.skips) }))
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

    /**
     * Stores several purchases that the user added by hand, as `insertTransaction` stores one: none under a source
     * id that the user has a transaction under already, and none past the most that a user may add by hand in 24
     * hours. They are taken in the order given, so the ones that the limit leaves out are the last of them. Returns
     * the id of the row of each one that was stored, with the source id that it is stored under.
     */
    async insertByHand(purchases: Omit<NewTransaction, 'parser'>[]): Promise<{ id: number; sourceId: string }[]> {
      // The purchases go in as one JSON array, and in one statement, however many there are: a request may run 50
      // queries, and has little CPU time. The count is part of the statement here too. It is held against what is
      // new: a purchase that is stored already takes up none of the room that is left.
      const { results } = await db
        .prepare(
          `INSERT INTO transactions
             (owner_id, source_id, card_last4, amount_minor, currency, merchant, occurred_at, parser, category)
           SELECT ?1, given.value ->> 'sourceId', given.value ->> 'cardLast4', given.value ->> 'amountMinor',
             given.value ->> 'currency', given.value ->> 'merchant', given.value ->> 'occurredAt', ?3,
             given.value ->> 'category'
           FROM json_each(?2) AS given
           WHERE NOT EXISTS (
             SELECT 1 FROM transactions WHERE owner_id = ?1 AND source_id = given.value ->> 'sourceId'
           )
           ORDER BY given.key
           LIMIT max(0, ?4 - (
             SELECT COUNT(*) FROM transactions
             WHERE owner_id = ?1 AND parser = ?3 AND created_at > unixepoch() - ?5
           ))
           ON CONFLICT (owner_id, source_id) DO NOTHING
           RETURNING id, source_id AS sourceId`,
        )
        .bind(ownerId, JSON.stringify(purchases), MANUAL, MAX_BY_HAND_PER_DAY, DAY)
        .all<{ id: number; sourceId: string }>()
      return results
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
     * Those of the user's purchases that are stored under the source ids, each with its source id and with when
     * its user took it out: null while they have not.
     */
    async findBySourceIds(sourceIds: string[]): Promise<Sourced[]> {
      // The ids go in as one JSON array, as a statement takes 100 bound values at most.
      const { results } = await db
        .prepare(
          `SELECT ${TRANSACTION}, source_id AS sourceId, removed_at AS removedAt FROM transactions
           WHERE owner_id = ?1 AND source_id IN (SELECT value FROM json_each(?2))`,
        )
        .bind(ownerId, JSON.stringify(sourceIds))
        .all<Sourced>()
      return results
    },

    /** Stores a category for a purchase that the user has, and has not taken out. */
    async setCategory(id: number, category: string): Promise<void> {
      await db
        .prepare('UPDATE transactions SET category = ? WHERE owner_id = ? AND id = ? AND removed_at IS NULL')
        .bind(category, ownerId, id)
        .run()
    },

    /** The user's marks of merchants, on every product. */
    async listMarks(): Promise<Mark[]> {
      const { results } = await db
        .prepare('SELECT product, letters, category FROM merchant_marks WHERE owner_id = ?')
        .bind(ownerId)
        .all<Mark>()
      return results
    },

    /** Remembers the category for the merchant's name on the product, in the place of what was remembered for it. */
    async remember(product: string, merchant: string, category: string): Promise<void> {
      await db
        .prepare(
          `INSERT INTO merchant_marks (owner_id, product, letters, merchant, category) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, product, letters) DO UPDATE SET
             merchant = excluded.merchant, category = excluded.category`,
        )
        .bind(ownerId, product, lettersOf(merchant), merchant, category)
        .run()
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
  remind_day: number | null
}

function toCard({ nickname, last4, window_type, statement_day, product, remind_day }: CardRow): Card {
  const card = {
    nickname,
    last4,
    ...(product !== null && { product }),
    ...(remind_day !== null && { remindDay: remind_day }),
  }
  // The schema guarantees a statement card has a day. The null check is for the type checker.
  return window_type === 'statement' && statement_day !== null
    ? { ...card, windowType: 'statement', statementDay: statement_day }
    : { ...card, windowType: 'calendar' }
}
