// What builds a reply from what it is given: the tables that /cards, /spend, /products and /status show, a card's
// window in full, the lines that name a card, and what is said when the AI provider is busy.

import { productOf, products } from '../catalogue'
import { breakDown, perCurrency } from '../domain/breakdown'
import { WINDOW_LIMIT } from '../domain/sorting'
import type { CardTotals } from '../domain/totals'
import { countedIn, currentWindow } from '../domain/window'
import { MANUAL, type Card, type Store } from '../store'
import type { Connection } from '../store-connect'
import type { MailSummary } from '../store-mail'
import type { RichBlock, RichText, TableCell } from './api'
import {
  COUNTED_BY_POSTING,
  countedDays,
  describeCounted,
  describeTotals,
  describeWindow,
  formatShortDateTime,
  formatTotals,
  maskLast4,
  shortDateIn,
} from './format'
import {
  BY_HAND_NOTE,
  breakdownLines,
  inMessages,
  purchaseBlocks,
  purchaseTables,
  sectionsOf,
  type Line,
  type Section,
  type Table,
} from './purchases'
import type { Tabled } from './sending'
import { DEFAULT_CURRENCY } from './shared'
import { STATUS_DAYS } from './texts'

/**
 * What a question is answered with when the AI provider has had as many requests as it takes for now. It says when
 * to try again: after the wait that the provider gave, which is `retryAfter` in seconds, or else "later".
 */
export function busyReply(retryAfter: number | undefined): string {
  const when = retryAfter === undefined ? 'later' : `in about ${describeWait(retryAfter)}`
  return `The assistant has reached its limit for now. Try again ${when}.`
}

/**
 * A wait of so many seconds in the unit that a person would say it in, rounded up: "a minute" for less than a
 * minute, minutes for less than an hour, as in "12 minutes", and hours from then on, as in "2 hours".
 */
function describeWait(seconds: number): string {
  if (seconds < 60) return 'a minute'
  const minutes = Math.ceil(seconds / 60)
  if (seconds < 3600) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.ceil(seconds / 3600)
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

export function label(card: Card): string {
  return `${card.nickname} ${maskLast4(card.last4)}`
}

/**
 * A card in one line, with its window and, when it is linked to one, the name of its product: as the bot says which
 * card it has added, and as /cards lists a card when its reply is sent as text.
 */
export function describeCard(card: Card): string {
  const product = productOf(card.product)
  return `${label(card)}: ${describeWindow(card)}${product ? `, ${product.name}` : ''}`
}

export function spendLine(each: CardTotals, timeZone: string): string {
  return `${label(each.card)}: ${describeTotals(each, timeZone)}`
}

// The replies that set values out in one table, so that each value is under a header, or beside a name, that says
// what it is: those to /cards, to /spend with no card named, to /products and to /status. Each is one rich message.
// As text, which is sent when Telegram does not take the rich message, each is the lines that the command replied
// with before it had a table.

/**
 * A table of a rich message, drawn with lines: the row that names its columns, when it has one, and its rows.
 * `right` are the columns whose cells are set to the right, as amounts and counts are in the tables of purchases.
 */
function tableOf(header: string[] | undefined, rows: string[][], right: number[] = []): RichBlock {
  const cell = (text: string, column: number): TableCell =>
    right.includes(column) ? { text, align: 'right' } : { text }
  const named = (header ?? []).map((text, column): TableCell => ({ ...cell(text, column), is_header: true }))
  const cells = [...(header ? [named] : []), ...rows.map((row) => row.map(cell))]
  return { type: 'table', cells, is_bordered: true }
}

/** A reply that is one rich message of the blocks. `text` makes the text that is sent in its place: see Tabled. */
function tabled(blocks: RichBlock[], text: () => string): Tabled {
  return { rich: { blocks, skip_entity_detection: true }, asText: () => [{ text: text() }] }
}

/** A line of a reply as a block of its rich message. */
function paragraphOf(text: string): RichBlock {
  return { type: 'paragraph', text }
}

/**
 * A user's cards, as /cards shows them: one table, with a row for each card. A card that is linked to no product
 * has a dash where the name of its product would be, as a purchase with no merchant has one for its merchant. As
 * text, it is a line for each card: see describeCard.
 */
export function cardsReply(cards: Card[]): Tabled {
  const rows = cards.map((card) => [
    card.nickname,
    maskLast4(card.last4),
    describeWindow(card),
    productOf(card.product)?.name ?? '-',
  ])
  return tabled([tableOf(['Nickname', 'Card', 'Window', 'Product'], rows)], () => cards.map(describeCard).join('\n'))
}

/**
 * What a user has spent on each of their cards in its current window, as /spend with no card named shows it: one
 * table, with a row for each card, and under it why some days are counted and that the totals are estimates.
 *
 * `Spent` is what the card's window comes to, a currency at a time. Nothing spent is none of the card's own
 * currency, as in the tables of /spend with a card. `Counted` is the days of the purchases that the total counts,
 * which are the window's own or some days earlier than those: see currentWindow. `Resets` is the day on which the
 * total starts again, which is the first day of the next window. Why the days are other than the window's own is
 * said once for all the cards, when it is so of any.
 *
 * As text, a card has a line, and under that which days its total counts, when they are not its window's own.
 */
export function spendReply(totals: CardTotals[], timeZone: string): Tabled {
  // One formatter writes all the dates: see shortDateIn.
  const shortDate = shortDateIn(timeZone)
  const why = totals.some(({ window }) => window.counts) ? [COUNTED_BY_POSTING] : []
  const below = [...why, 'Totals are estimated from bank alerts.']
  const rows = totals.map(({ card, window, totals: spent, count }) => {
    const nothing = [{ currency: productOf(card.product)?.homeCurrency ?? DEFAULT_CURRENCY, amountMinor: 0 }]
    const { start, end } = window.counts ?? window
    // The last day that is counted is the one before the end, which is the first that is not.
    const counted = `${shortDate(start)} to ${shortDate(new Date(end.getTime() - 1))}`
    const resets = shortDate(window.end)
    return [card.nickname, formatTotals(spent.length > 0 ? spent : nothing), String(count), counted, resets]
  })
  const table = tableOf(['Nickname', 'Spent', 'Purchases', 'Counted', 'Resets'], rows, [1, 2])
  return tabled([table, ...below.map(paragraphOf)], () => {
    const lines = totals.flatMap((each) => [spendLine(each, timeZone), ...countedDays(each.window, shortDate)])
    return [...lines, '', ...below].join('\n')
  })
}

/**
 * The card products whose reward rules are known, as /products shows them: a table of the key of each and its name,
 * under the line that says what they are and over the one that says how a card is linked to one. As text, a
 * product has a line.
 */
export function productsReply(): Tabled {
  const above = 'The card products whose reward rules are known:'
  const below = 'To link a card to one, send /product <nickname> <product key>. Or add the key to the end of /addcard.'
  const rows = products.map(({ key, name }) => [key, name])
  return tabled([paragraphOf(above), tableOf(['Key', 'Product'], rows), paragraphOf(below)], () =>
    [above, ...products.map(({ key, name }) => `${key} - ${name}`), '', below].join('\n'),
  )
}

/**
 * A card's current window in full: its purchases from the earliest on, in tables that end with what they come to,
 * and after the tables what the whole window comes to. A card with a product has a table for each group of the
 * product, which ends with the group's limit where it has one, and then how far the spend is towards the product's
 * minimum, when it has one. A card with no product has one table, of all its purchases. It is one rich message. As
 * text, it can come to more than one message takes.
 *
 * The purchases are those that the window counts, which begin some days before the window does: see currentWindow.
 * The heading has the window as its bank has it, each purchase has its own day, and the line under the total says
 * which days are counted, and why.
 */
export async function spendDetail(store: Store, card: Card, now: Date, timeZone: string): Promise<Tabled> {
  const window = currentWindow(card, now, timeZone)
  const { start, end } = countedIn(window)
  // Two queries, however many purchases there are: the sums, which take in all of them, and the latest to list.
  const [sums, latest] = await Promise.all([
    store.sumByCategory(card.last4, start, end),
    store.listTransactions(card.last4, start, end, WINDOW_LIMIT),
  ])
  const product = productOf(card.product)
  const breakdown = product && breakDown(product, sums)
  const count = sums.reduce((total, sum) => total + sum.count, 0)
  // One formatter for all the dates: see shortDateIn.
  const shortDate = shortDateIn(timeZone)
  const listed = latest.reverse().map((purchase) => ({
    ...purchase,
    date: shortDate(new Date(purchase.occurredAt * 1000)),
  }))
  // A card with a product has a table for each group of the product. A card with none has one table, of all that
  // is listed, when anything is.
  const whole: Section[] = listed.length > 0 ? [{ purchases: listed, spent: perCurrency(sums) }] : []
  const sections = product && breakdown ? sectionsOf(product, breakdown, listed) : whole
  const homeCurrency = product?.homeCurrency ?? DEFAULT_CURRENCY

  // What is said around the tables: a heading, and the lines above the tables and below them, a part at a time.
  const heading = `${label(card)}: ${shortDate(window.start)} to ${shortDate(new Date(window.end.getTime() - 1))}`
  const above = count > listed.length ? [`The latest ${listed.length} of ${count} purchases:`] : []
  const below = [
    listed.some((purchase) => purchase.parser === MANUAL) ? [BY_HAND_NOTE] : [],
    [
      `Total: ${describeTotals({ card, window, totals: perCurrency(sums), count }, timeZone)}`,
      ...describeCounted(card, window, shortDate),
    ],
    product && breakdown ? breakdownLines(product, breakdown) : [],
  ]

  const paragraph = (text: RichText): RichBlock => ({ type: 'paragraph', text })
  const lines = (texts: string[]): Line[] => texts.map((text) => ({ text }))
  return {
    // A paragraph to each line, with the heading in bold, as the names of the tables are.
    rich: {
      blocks: [
        paragraph({ type: 'bold', text: heading }),
        ...above.map(paragraph),
        ...purchaseBlocks(sections, homeCurrency),
        ...below.flat().map(paragraph),
      ],
      skip_entity_detection: true,
    },
    asText() {
      const parts: (Line | Table)[][] = [
        lines([heading]),
        lines(above),
        ...purchaseTables(sections, homeCurrency).map((table) => [table]),
        ...below.map(lines),
      ]
      // An empty line before each part that holds anything. A message does not begin with one.
      return inMessages(parts.filter((part) => part.length > 0).flatMap((part) => [{ text: '' }, ...part]))
    },
  }
}

/**
 * Whether a user's Gmail is connected and what has been read from it, as /status shows it: one table with no row of
 * headers, in which a row is what a value is and the value. Whose Gmail it is comes first, and how it stands when
 * there is one. Under the table is what there is to do about it, when there is anything: to connect it, or to
 * connect it again. As text, it is three lines.
 */
export function statusReply(connection: Connection | null, summary: MailSummary, timeZone: string): Tabled {
  const { lastCheckedAt, purchases, unparsed } = summary
  const checked = lastCheckedAt === null ? 'not yet' : formatShortDateTime(new Date(lastCheckedAt * 1000), timeZone)
  const active = connection?.status === 'active'
  const gmail = connection
    ? [
        ['Gmail', connection.email],
        ['Status', active ? 'connected' : 'needs reconnecting'],
      ]
    : [['Gmail', 'not connected']]
  const rows = [
    ...gmail,
    ['Alerts last fully checked', checked],
    [`Purchases recorded, last ${STATUS_DAYS} days`, String(purchases)],
    [`Alerts that could not be read, last ${STATUS_DAYS} days`, String(unparsed)],
  ]
  const toDo = active ? [] : [`Send /connect to ${connection ? 'reconnect' : 'connect'} it.`]
  return tabled([tableOf(undefined, rows), ...toDo.map(paragraphOf)], () =>
    [
      gmailStatus(connection),
      `Alerts last fully checked: ${checked}`,
      `Last ${STATUS_DAYS} days: ${purchases} ${purchases === 1 ? 'purchase' : 'purchases'} recorded, ` +
        `${unparsed} ${unparsed === 1 ? 'alert' : 'alerts'} could not be read`,
    ].join('\n'),
  )
}

function gmailStatus(connection: Connection | null): string {
  if (!connection) return 'Your Gmail is not connected. Send /connect to connect it.'
  const gmail = `Your Gmail ${connection.email}`
  return connection.status === 'active'
    ? `${gmail} is connected.`
    : `${gmail} needs reconnecting. Send /connect to reconnect it.`
}
