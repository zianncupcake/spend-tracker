// What the MCP tools answer with: one user's card totals and purchases, as
// plain data. Both tools only read, and only through that user's own store.

import { categoryOf, productOf } from '../catalogue'
import { cardTotals } from '../domain/totals'
import { startOfDay } from '../domain/window'
import type { Card, Store } from '../store'

/** How far back a listing goes when it is not told where to start. */
export const DEFAULT_DAYS = 30

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const DAY = 86_400

const DATE = /^\d{4}-\d{2}-\d{2}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** Something wrong with what a tool was asked for. Its message is written for the assistant that asked. */
export class ToolError extends Error {}

/** What list_transactions can be asked for. */
export interface ListArguments {
  card?: string
  from?: string
  to?: string
  limit?: number
}

/** What the user has spent on each of their cards in the card's current window. */
export async function spendingSummary(store: Store, now: Date, timeZone: string) {
  const cards = await cardTotals(store, await store.listCards(), now, timeZone)
  return {
    timeZone,
    cards: cards.map(({ card, window, totals, count }) => ({
      nickname: card.nickname,
      last4: card.last4,
      windowType: card.windowType,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      totals: totals.map(({ currency, amountMinor }) => ({ currency, amount: decimal(amountMinor), amountMinor })),
      purchaseCount: count,
    })),
    note: 'Totals are estimated from bank alert emails.',
  }
}

/** The user's purchases over a stretch of time, newest first: those of one card, or of every card. */
export async function listTransactions(store: Store, args: ListArguments, now: Date, timeZone: string) {
  const { card, from, to, limit = DEFAULT_LIMIT } = args
  // Without a `to`, up to now: the second that is passing counts too.
  const end = to === undefined ? Math.floor(now.getTime() / 1000) + 1 : boundary('to', to, timeZone)
  const start = from === undefined ? end - DEFAULT_DAYS * DAY : boundary('from', from, timeZone)
  if (start >= end) throw new ToolError('`from` must be earlier than `to`, or than now when no `to` is given.')

  const cards = await store.listCards()
  const transactions = await store.listTransactions(last4Of(cards, card), start, end, limit)
  const products = new Map(cards.map((each) => [each.last4, productOf(each.product)]))
  return {
    timeZone,
    transactions: transactions.map(({ id, occurredAt, cardLast4, amountMinor, currency, merchant, category }) => {
      // The category that a purchase is in is what its card's product makes of the one that is stored for it.
      const product = products.get(cardLast4)
      return {
        id,
        time: new Date(occurredAt * 1000).toISOString(),
        cardLast4,
        amount: decimal(amountMinor),
        amountMinor,
        currency,
        merchant,
        category: product ? categoryOf(product, category) : category,
      }
    }),
  }
}

/**
 * The unix seconds that a `from` or a `to` stands for. A date is a day on the
 * user's calendar: a `from` begins with that day, and a `to` ends with it.
 */
function boundary(name: 'from' | 'to', value: string, timeZone: string): number {
  // Not a number for what no calendar or clock has, such as a month 13 or an hour 25.
  const parsed = Date.parse(value)
  if (INSTANT.test(value) && !Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  // A day that its month does not have, such as 30 February, is parsed as a day of the month after. Written
  // out again, that is not the date that was given.
  if (DATE.test(value) && !Number.isNaN(parsed) && new Date(parsed).toISOString().startsWith(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return startOfDay(year, month, name === 'to' ? day + 1 : day, timeZone).getTime() / 1000
  }
  throw new ToolError(`\`${name}\` must be a date such as 2026-10-01, or an instant such as 2026-10-01T09:30:00+08:00.`)
}

/** The last four digits of the one of the user's `cards` with the nickname. Null when no card was asked for. */
function last4Of(cards: Card[], nickname: string | undefined): string | null {
  if (nickname === undefined) return null
  const card = cards.find((each) => each.nickname === nickname)
  if (card) return card.last4
  const nicknames = cards.map((each) => each.nickname).join(', ')
  throw new ToolError(
    nicknames
      ? `No card has that nickname. The user's cards are: ${nicknames}.`
      : 'No card has that nickname: the user has no cards.',
  )
}

/** Hundredths as a decimal number in a string: 123456 is "1234.56". */
function decimal(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : ''
  const amount = Math.abs(amountMinor)
  return `${sign}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`
}
