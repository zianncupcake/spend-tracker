import { env } from 'cloudflare:workers'
import { afterAll, beforeAll } from 'vitest'
import { products } from '../src/catalogue'
import type { Product } from '../src/catalogue/types'
import { uobEvol } from '../src/catalogue/uob-evol'
import type { AlertEmail } from '../src/parsers/types'
import { storeFor, type NewTransaction } from '../src/store'
import type { RichBlock, RichMessage, TableCell } from '../src/telegram/api'

// Every person, card, merchant and message in the tests is made up.

/**
 * A made-up product whose terms count a purchase by the day that it was made: a window of its cards counts the
 * purchases of its own days, and no others. In all else it is the UOB EVOL Card. The catalogue has no product like
 * it with that card's groups, so a test file that needs one puts it there: see `inCatalogue`.
 */
export const BY_PURCHASE_DAY: Product = {
  ...uobEvol,
  key: 'made-up-card',
  name: 'Made-up Card',
  daysCountedInNext: 0,
}

/** Has the catalogue hold a made-up product while the tests of a file run. */
export function inCatalogue(product: Product): void {
  beforeAll(() => {
    products.push(product)
  })
  afterAll(() => {
    products.splice(products.indexOf(product), 1)
  })
}

/** The line that the bot's message about purchases has when any of them is counted in the window after its own. */
const CARRIED = new RegExp(
  '^(This purchase was|These purchases were|\\d+ of these purchases (was|were)) made in the last .* ' +
    'The bank counts a purchase by the day it is posted\\.$',
)

/**
 * What the Worker posted to Telegram, without the line that says of a purchase that it is counted in the next
 * window. A purchase of the last two days of a window has that line. So a test that goes by the real clock, and
 * whose purchases are made today, has it on two days of a month and on no others: with the line taken out, such a
 * test says the same on every day. test/add.test.ts and test/checker.test.ts are about the line, by a clock of their
 * own.
 */
export function withoutCarried<Body extends Record<string, unknown>>(body: Body): Body {
  const { text, rich_message: rich } = body as { text?: unknown; rich_message?: { blocks?: RichBlock[] } }
  if (typeof text === 'string') {
    const lines = text.split('\n').filter((line) => !CARRIED.test(line))
    // In a reply that is sent as text in the place of a rich one, the line is a part of its own, under an empty
    // line that goes with it.
    while (lines.at(-1) === '') lines.pop()
    return { ...body, text: lines.join('\n') }
  }
  if (!Array.isArray(rich?.blocks)) return body
  const carried = ({ type, text }: RichBlock & { text?: unknown }) =>
    type === 'paragraph' && typeof text === 'string' && CARRIED.test(text)
  return { ...body, rich_message: { ...rich, blocks: rich.blocks.filter((block) => !carried(block)) } }
}

/**
 * The ids go up from a number that nothing else in a line of the log could be. Many tests say that no line holds the
 * Telegram id of their user, and some of them go by the real clock: a count or a duration can be any small number.
 */
let lastTelegramId = 7_200_000_000

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

/** UOB's alert of a card's bill paid from a UOB account, for the card ending 4321. Its values are made up. */
export const UOB_PAYMENT =
  'You made/scheduled a bill payment(s) of SGD 88.20 to SAMPLE PAYEE on your a/c ending 1111 at 4:58PM SGT, 25 Oct ' +
  '26. Bill ref: ending 4321. If unauthorised, call UOB 24/7 Fraud Hotline.'

export function alertEmail(overrides: Partial<AlertEmail> = {}): AlertEmail {
  return {
    sourceId: 'msg-1',
    from: 'alerts@examplebank.test',
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

/** The categories that the buttons under a message move its purchase to, in their order. */
export function marksOf(message: { buttons?: { data: string }[][] }): string[] | undefined {
  return message.buttons?.flat().map((button) => button.data.split(':')[1])
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

// The rows that name the columns of two of the bot's tables, as `linesOf` has a row: the first line of the reply to
// /cards, and of the reply to /spend with no card named. A test says what such a reply holds with these.

export const CARDS_HEADER = 'Nickname | Card | Window | Product | Reminder | Paid'
export const SPEND_HEADER = 'Nickname | Spent | Purchases | Counted | Resets'

/** What /spend with no card named says last under its table: that totals are estimates. */
export const ESTIMATED = 'Totals are estimated from bank alerts.'

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
