import { env } from 'cloudflare:workers'
import type { AlertEmail } from '../src/parsers/types'
import { storeFor, type NewTransaction } from '../src/store'
import type { RichBlock, RichMessage, TableCell } from '../src/telegram/api'

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

// The blocks of a rich message as the bot is to send them, for a test to say what it expects in fewer lines. Each
// is written out in full, as Telegram is posted it, in the first test of test/detail-rich.test.ts.

/** A paragraph in bold: the heading of a message, or the name of a table. */
export function bold(text: string): RichBlock {
  return { type: 'paragraph', text: { type: 'bold', text } }
}

/** A paragraph of plain text. */
export function plain(text: string): RichBlock {
  return { type: 'paragraph', text }
}

/** A table that is drawn with lines, of the rows. */
export function tableOf(...cells: TableCell[][]): RichBlock {
  return { type: 'table', is_bordered: true, cells }
}

/** The header of a table that lists purchases, with what its column of amounts is headed with. */
export function headerRow(amounts: string): TableCell[] {
  return [
    { text: 'ID', is_header: true },
    { text: 'Date', is_header: true },
    { text: amounts, is_header: true, align: 'right' },
    { text: 'Merchant', is_header: true },
  ]
}

/** The row of a purchase. Its id is a number, or text when a mark comes after the number. */
export function purchaseRow(id: number | string, date: string, amount: string, merchant: string): TableCell[] {
  return [{ text: String(id), align: 'right' }, { text: date }, { text: amount, align: 'right' }, { text: merchant }]
}

/** A row that sums up a table that lists purchases: what the amount is called, across two columns, and the amount. */
export function sumRow(label: string, amount: string): TableCell[] {
  return [{ text: label, colspan: 2 }, { text: amount, align: 'right' }, { text: '' }]
}

/** A row of a table that lists no purchases: what the amount is called, and the amount. */
export function bareRow(label: string, amount: string): TableCell[] {
  return [{ text: label }, { text: amount, align: 'right' }]
}

/**
 * What a rich message says, a line at a time: the text of each paragraph, and each row of a table with " | " between
 * its cells. A cell with nothing in it is left out.
 */
export function linesOf({ blocks }: RichMessage): string[] {
  return blocks.flatMap((block) => {
    if (block.type === 'paragraph') return [typeof block.text === 'string' ? block.text : block.text.text]
    return block.cells.map((cells) => cells.flatMap(({ text }) => (text === '' ? [] : [text])).join(' | '))
  })
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
