import { env } from 'cloudflare:workers'
import type { AlertEmail } from '../src/parsers/types'
import { storeFor, type NewTransaction } from '../src/store'

// Every person, card, merchant and message in the tests is made up.

let lastTelegramId = 1000

/** Rows written by earlier tests in a file are still in the database, so every test uses its own users. */
export function newTelegramId(): number {
  return ++lastTelegramId
}

/** Unix seconds of an ISO date-time. */
export function seconds(iso: string): number {
  return Date.parse(iso) / 1000
}

/** The alert sentence of the invented Example Bank. */
export function alertText(amount: string, last4: string, merchant = 'COFFEE PLACE'): string {
  return `A transaction of ${amount} was made with your Example Bank card ending ${last4} at ${merchant}.`
}

export function alertEmail(overrides: Partial<AlertEmail> = {}): AlertEmail {
  return {
    sourceId: 'msg-1',
    from: 'alerts@examplebank.test',
    subject: 'Transaction alert',
    receivedAt: seconds('2026-10-05T09:30:00+08:00'),
    text: alertText('SGD 12.40', '1234'),
    ...overrides,
  }
}

let lastBought = 0

/**
 * Stores a purchase for a user and returns its id. What is not given is made up: SGD 12.40 at COFFEE PLACE on the
 * card ending 1234, at 09:30 on 5 October 2026 in Singapore, read from an alert of the invented Example Bank.
 */
export async function buy(userId: number, given: Partial<NewTransaction> & { at?: string } = {}): Promise<number> {
  const { at = '2026-10-05T09:30:00+08:00', ...purchase } = given
  const id = await storeFor(env.DB, userId).insertTransaction({
    sourceId: `bought-${++lastBought}`,
    cardLast4: '1234',
    amountMinor: 1240,
    currency: 'SGD',
    merchant: 'COFFEE PLACE',
    occurredAt: seconds(at),
    parser: 'example-bank',
    ...purchase,
  })
  if (id === null) throw new Error('A test stored the same purchase twice')
  return id
}

// The two counts below read the tables directly, so they also see rows that a
// per-user store would never return.

export async function userCount(telegramId: number): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export function rowsOwnedBy(userId: number) {
  return env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE id = ?1) AS users,
       (SELECT COUNT(*) FROM cards WHERE owner_id = ?1) AS cards,
       (SELECT COUNT(*) FROM transactions WHERE owner_id = ?1) AS transactions`,
  )
    .bind(userId)
    .first<{ users: number; cards: number; transactions: number }>()
}
