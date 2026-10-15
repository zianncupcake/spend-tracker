// What the bot says of purchases one by one: the line that a purchase is shown on, the buttons that move it to
// another category of its card's product, the buttons under purchases that the bot asks about before it adds them,
// and the tables that the purchases of a card's window are listed in. A table is set out in two ways: in the cells
// of a rich message, which is how it is sent, and as text, which is sent in its place when Telegram does not take
// the rich message. The buttons under a message that asks before a command is run are here too, with the bot's
// other buttons: what each of them sends back is told from what the others send by how it begins.
//
// A merchant's name is text from an email, text that a user typed, or text that a model read from a photo. Telegram
// makes a command or a link of whatever looks like one. So wherever a name is shown as text it is marked as code,
// or is in the block of a table, and Telegram makes nothing of what is in either: see MessageEntity. In a rich
// message it is told to make nothing of any text: see RichMessage.

import { categoriesOf, categoryName, categoryOf } from '../catalogue'
import type { Product } from '../catalogue/types'
import { leftOf, perCurrency, type Amount, type Breakdown } from '../domain/breakdown'
import { MANUAL, type Card, type Transaction } from '../store'
import type { HeldPurchase } from '../store-held'
import type { Button, MessageEntity, Outgoing, RichBlock, TableCell } from './api'
import { formatAmount, formatMoney, formatShortDate } from './format'

/**
 * The most text that Telegram takes in one message. It is counted here in UTF-16 code units, of which a text has
 * at least as many as it has characters.
 */
export const MAX_LENGTH = 4096

/**
 * The most characters in a row of a table. A phone shows about that many across a block. It wraps a row that is
 * longer, and the columns of a wrapped row no longer line up.
 */
const MAX_ROW = 36

const SEPARATOR = ' · '

/** What comes after the id in the row of a purchase that its user added by hand. */
const BY_HAND = '*'

/** What a message says of that mark, under its tables, when a row in them has it. */
export const BY_HAND_NOTE = `${BY_HAND} = added by hand`

/** What the row of a table is called that has what the card's patterns hold back of the cap: see `sumsOf`. */
export const TO_COME = 'To come'

/** What a message says of that row, under its tables, when a table has it. */
export const TO_COME_NOTE = `${TO_COME} = what your /patterns still expect this month, taken off what is left of a cap`

/** What a button sends back: the id of a purchase and the key of a category. */
const PRESS = /^(\d{1,15}):([a-z0-9-]{1,40})$/

/**
 * What a button under purchases that are held sends back: Telegram's id of the message that they were read from,
 * and what the press chooses. That is to add them, to skip them, or the last four digits of the card to add them
 * to. No button that moves a purchase holds the like: what such a one sends back begins with a digit.
 */
const HELD_PRESS = /^held:(\d{1,15}):(add|skip|\d{4})$/

/**
 * What a button under a message that asks before a command is run sends back: whether to run it, and the line of
 * the command, as its user would send it. No other button of the bot's holds the like: none sends back what begins
 * so.
 */
const CONFIRM_PRESS = /^(do|no):(.+)$/s

/** The most bytes that Telegram takes of what a button sends back. */
const MAX_DATA_BYTES = 64

/** What comes after a purchase that is held, on its line, when the model was not sure of its amount or its date. */
const UNSURE = 'not sure'

/** What a message says of that note, under its purchases, when a line of them has it. */
export const UNSURE_NOTE = `Check the amount and the date of each one that is marked "${UNSURE}".`

/** What follows the category of a purchase that its user's mark of the merchant placed: see sortEnd. */
export const MARKED_BEFORE = 'as you marked this merchant before'

/** A line of a message, with the stretch of it that is to be marked as code. */
export interface Line {
  text: string
  marked?: { offset: number; length: number }
}

/**
 * A table as text in a message. Its rows are shown as a block in which every character is as wide as the next, so
 * that what is written in columns lines up.
 */
export interface Table {
  /** The line above the block that says what the table is of. It stays in one message with the table's first row. */
  name?: string
  /** The row that names the columns. Every message that holds rows of the table has it above them. */
  header?: string
  rows: string[]
  /** The rows that sum the table up. They stay in one message. */
  end: string[]
}

/** A purchase with the day that it was made, as its user is shown it: "5 Oct". */
export type Dated = Transaction & { date: string }

/** What one table of a card's window is of. */
export interface Section {
  /** The name of a group of the card's product. The one table of a card with no product has no name. */
  name?: string
  /** The purchases to list, from the earliest on. */
  purchases: Dated[]
  /** What the section's purchases come to, a currency at a time: those that are listed and those that are not. */
  spent: Amount[]
  /** The limit of the group, when it has one: see Group. It is in hundredths of the product's own currency. */
  limitMinor?: number
  /** What the card's patterns hold back of that limit, in the same: see `toComeByGroup` in ../domain/patterns. */
  toComeMinor?: number
}

/**
 * A purchase on one line, such as "ID 57 · 5 Oct · SGD 12.40 · COFFEE PLACE · by hand": its id, the day it was made,
 * its amount, its merchant when it has one, and a note of its having been added by hand.
 */
export function purchaseLine(purchase: Transaction, date: string): Line {
  const { id, amountMinor, currency, merchant, parser } = purchase
  const start = [`ID ${id}`, date, formatMoney(amountMinor, currency)]
  return lineOf(start, merchant, parser === MANUAL ? ['by hand'] : [])
}

/**
 * A purchase that is held, on one line, such as "5 Oct · SGD 12.40 · COFFEE PLACE · not sure": as `purchaseLine`
 * has a purchase, but for the id, which a purchase has once it is stored. `flagged` is whether the line is to say
 * that the model was not sure of the purchase, where it was not.
 */
export function heldLine(purchase: HeldPurchase, date: string, flagged: boolean): Line {
  const { amountMinor, currency, merchant, unsure } = purchase
  return lineOf([date, formatMoney(amountMinor, currency)], merchant, flagged && unsure ? [UNSURE] : [])
}

/** A line of what it starts with, the merchant's name when there is one, and the notes after that. */
export function lineOf(start: string[], merchant: string | null, notes: string[]): Line {
  const before = start.join(SEPARATOR)
  if (!merchant) return { text: [before, ...notes].join(SEPARATOR) }
  return {
    text: [before, merchant, ...notes].join(SEPARATOR),
    marked: { offset: before.length + SEPARATOR.length, length: merchant.length },
  }
}

/** A line as a message holds it. One that is a row of a table has the table with it. */
type Held = Line & { table?: Table }

/**
 * The lines and the tables as messages, in their order and in as few messages as Telegram takes them in. A message
 * ends where one more line would take it past the text that Telegram allows. None begins or ends with an empty line.
 *
 * A table is parted only between two of its rows. Its name stays with its first row, and the rows that sum it up
 * stay with one another. Where a table goes on in another message, its header is above its rows there too, and each
 * of the two messages has a block of its own for the rows that it holds.
 */
export function inMessages(parts: (Line | Table)[]): Outgoing[] {
  const messages: Outgoing[] = []
  let held: Held[] = []
  let length = 0
  const close = () => {
    const kept = held.slice(0, held.findLastIndex((line) => line.text !== '') + 1)
    if (kept.length > 0) messages.push(asMessage(kept))
    held = []
    length = 0
  }
  // Whether the open message takes the lines, with a line end before each of them but the first that it holds.
  const fits = (lines: Held[]) => length + lines.reduce((sum, line) => sum + line.text.length + 1, -1) <= MAX_LENGTH
  const hold = (lines: Held[]) => {
    for (const line of lines) {
      held.push(line)
      // With the line end that comes before the next line.
      length += line.text.length + 1
    }
  }

  for (const part of parts) {
    if ('rows' in part) {
      const { name, header, rows, end } = part
      const named: Held[] = name === undefined ? [] : [{ text: name }]
      const headed: Held[] = header === undefined ? [] : [{ text: header, table: part }]
      // The rows that sum the table up are held as one, so that no message ends between two of them.
      const units = end.length > 0 ? [...rows, end.join('\n')] : rows
      for (const [index, unit] of units.entries()) {
        const row: Held = { text: unit, table: part }
        // The table begins with its name and its header. Where it goes on in a new message, it has the header again.
        const lines = index === 0 ? [...named, ...headed, row] : [row]
        if (!fits(lines)) close()
        hold(index > 0 && held.length === 0 ? [...headed, row] : lines)
      }
      continue
    }
    if (!fits([part])) close()
    if (part.text === '' && held.length === 0) continue
    hold([part])
  }
  close()
  return messages
}

function asMessage(lines: Held[]): Outgoing {
  const entities: MessageEntity[] = []
  let offset = 0
  lines.forEach(({ text, marked, table }, index) => {
    if (marked) entities.push({ type: 'code', offset: offset + marked.offset, length: marked.length })
    // The rows of a table that follow one another are one block: it begins with the first and takes in each more.
    if (table && table === lines[index - 1]?.table) entities[entities.length - 1].length += 1 + text.length
    else if (table) entities.push({ type: 'pre', offset, length: text.length })
    offset += text.length + 1
  })
  const text = lines.map((line) => line.text).join('\n')
  return entities.length > 0 ? { text, entities } : { text }
}

/**
 * Where a purchase is, as its user is shown it: the name of the category that the product makes of the one that is
 * stored for the purchase, or "not sorted".
 */
export function whereSorted(product: Product, category: string | null): string {
  return categoryName(product, categoryOf(product, category)) ?? 'not sorted'
}

/**
 * The end of a message about one purchase on a card with a product: the line that says where the purchase is, such
 * as "ID 57: Other Spend", and the buttons that move it. There is a button for each category that a purchase can be
 * put in by hand, but for the one that this purchase is in. `remembered` is for a purchase that has just been added
 * where its user's mark of the merchant put it: see `startOf` in ../domain/sorting.
 */
export function sortEnd(
  product: Product,
  purchase: { id: number; category: string | null; remembered?: boolean },
): { line: string; buttons: Button[][] } {
  const current = categoryOf(product, purchase.category)
  // A row to each button, so that no label is cut short on a phone.
  const buttons = categoriesOf(product)
    .filter((choice) => choice.key !== current)
    .map(({ key, label }) => [{ text: `Mark as ${label}`, data: `${purchase.id}:${key}` }])
  const where = whereSorted(product, purchase.category)
  return { line: `ID ${purchase.id}: ${where}${purchase.remembered ? `, ${MARKED_BEFORE}` : ''}`, buttons }
}

/** A purchase, with where it is sorted and the buttons that move it. */
export function sortPrompt(product: Product, purchase: Transaction, timeZone: string): Outgoing {
  const { line, buttons } = sortEnd(product, purchase)
  const date = formatShortDate(new Date(purchase.occurredAt * 1000), timeZone)
  const [message] = inMessages([purchaseLine(purchase, date), { text: line }])
  return { ...message, buttons }
}

/** What a button of `sortEnd` sent back, read again. Null for anything else: a client can send what no button holds. */
export function readPress(data: string): { purchaseId: number; category: string } | null {
  const [, purchaseId, category] = PRESS.exec(data) ?? []
  return purchaseId === undefined ? null : { purchaseId: Number(purchaseId), category }
}

/**
 * The buttons under purchases that are held, which are those of the message with the id: one that adds them and
 * one that skips them. Where the bot could not tell which card they were made with, `cards` are the user's cards,
 * and there is a button for each in the place of the one that adds: it adds them to that card. `count` is how many
 * purchases are held.
 */
export function heldButtons(messageId: number, count: number, cards?: Card[]): Button[][] {
  const button = (text: string, choice: string): Button[] => [{ text, data: `held:${messageId}:${choice}` }]
  const adding = cards
    ? cards.map(({ nickname, last4 }) => button(`Add to ${nickname}`, last4))
    : [button(count === 1 ? 'Add this one' : `Add these ${count}`, 'add')]
  // A row to each button, as under a purchase.
  return [...adding, button('Skip', 'skip')]
}

/**
 * What a button of `heldButtons` sent back, read again: the id of the message, and `choice`, which is "add", "skip"
 * or the last four digits of a card. Null for anything else.
 */
export function readHeldPress(data: string): { messageId: number; choice: string } | null {
  const [, messageId, choice] = HELD_PRESS.exec(data) ?? []
  return messageId === undefined ? null : { messageId: Number(messageId), choice }
}

/**
 * The buttons under a message that asks before a command is run: one that runs it, and one that does not. `line` is
 * the command as its user would send it, and it rides in what each button sends back. Null when it does not fit
 * there: Telegram takes 64 bytes, and counts them as UTF-8.
 */
export function confirmButtons(line: string): Button[][] | null {
  const [run, leave] = [`do:${line}`, `no:${line}`]
  if (new TextEncoder().encode(run).byteLength > MAX_DATA_BYTES) return null
  // A row to each button, as under a purchase.
  return [[{ text: 'Do it', data: run }], [{ text: 'Cancel', data: leave }]]
}

/**
 * What a button of `confirmButtons` sent back, read again: whether it was the one that runs the command, and the
 * line. Null for anything else. The line is as a client sent it, which can be any text: whoever runs it checks it.
 */
export function readConfirmPress(data: string): { run: boolean; line: string } | null {
  const [, choice, line] = CONFIRM_PRESS.exec(data) ?? []
  return choice === undefined ? null : { run: choice === 'do', line }
}

/**
 * What the tables of a window are of, for a card with a product: a section for each group of the product, in the
 * product's order and whether or not anything was spent in it, so that every limit is seen. After them comes what
 * is not sorted, when there is any, which only a product with no default category leaves so. `purchases` are those
 * to list. What a section's purchases come to is the breakdown's, which counts those that are not listed too.
 * `toCome` is what the card's patterns hold back of each group, in the product's order.
 */
export function sectionsOf(product: Product, breakdown: Breakdown, purchases: Dated[], toCome: number[]): Section[] {
  // A purchase is told apart by what is stored for it. Where it is is what the product makes of that.
  const placed = purchases.map((purchase) => ({ purchase, category: categoryOf(product, purchase.category) }))
  const among = (keys: (string | null)[]) =>
    placed.filter(({ category }) => keys.includes(category)).map(({ purchase }) => purchase)

  const sections: Section[] = breakdown.groups.map(({ name, spent, limitMinor }, index) => ({
    name,
    // The breakdown has a group for each group of the product, in the product's order.
    purchases: among(product.groups[index].categories.map((category) => category.key)),
    spent,
    limitMinor,
    toComeMinor: toCome[index],
  }))
  if (breakdown.unsorted.length > 0) {
    sections.push({ name: 'Not sorted', purchases: among([null]), spent: breakdown.unsorted })
  }
  return sections
}

/**
 * A table for each section, as the blocks of a rich message: the name of the section in bold, when it has one, and
 * under it a table that is drawn with lines. A row of the table is the id of a purchase, its day, its amount and its
 * merchant, under a header that names the four. After them come the rows that sum the section up. A merchant's name
 * is whole, as a cell wraps what is too long for it. `homeCurrency` is the card's own currency, which a limit is in.
 */
export function purchaseBlocks(sections: Section[], homeCurrency: string): RichBlock[] {
  return sections.flatMap((section) => {
    const { name, heading, purchases, sums } = drafted(section, homeCurrency)
    const named: RichBlock[] = name === undefined ? [] : [{ type: 'paragraph', text: { type: 'bold', text: name } }]
    // A table that lists no purchase has no header. A row of it is what an amount is called, and the amount.
    const cells: TableCell[][] =
      heading === undefined
        ? sums.map(({ label, amount }) => [{ text: label }, { text: amount, align: 'right' }])
        : [
            [
              { text: 'ID', is_header: true },
              { text: 'Date', is_header: true },
              { text: heading, is_header: true, align: 'right' },
              { text: 'Merchant', is_header: true },
            ],
            ...purchases.map(({ id, parser, date, amount, merchant }): TableCell[] => [
              { text: `${id}${parser === MANUAL ? BY_HAND : ''}`, align: 'right' },
              { text: date },
              { text: amount, align: 'right' },
              { text: merchant || '-' },
            ]),
            // What sums a table up is named across the columns of the id and the day, and has no merchant.
            ...sums.map(({ label, amount }): TableCell[] => [
              { text: label, colspan: 2 },
              { text: amount, align: 'right' },
              { text: '' },
            ]),
          ]
    return [...named, { type: 'table', cells, is_bordered: true }]
  })
}

/**
 * A table for each section: the id of every purchase, its day, its amount and its merchant, and under them what the
 * section's purchases come to. The columns are as wide in one table as in the next, so that the tables of a message
 * line up with one another. No row is longer than a phone shows across: a merchant's name is cut short to what the
 * other columns leave it. `homeCurrency` is the card's own currency, which a limit is in.
 *
 * These are the tables as text, which is sent when Telegram does not take the rich message of `purchaseBlocks`.
 */
export function purchaseTables(sections: Section[], homeCurrency: string): Table[] {
  // What each table holds, before its columns are given their widths.
  const drafts = sections.map((section) => drafted(section, homeCurrency))

  const listed = drafts.flatMap((draft) => draft.purchases)
  const sums = drafts.flatMap((draft) => draft.sums)
  const idWidth = widthOf(['ID', ...listed.map(({ id }) => String(id))])
  const dayWidth = widthOf(['Date', ...listed.map(({ date }) => date), ...sums.map(({ label }) => label)])
  const amountWidth = widthOf([
    ...drafts.map(({ heading }) => heading ?? ''),
    ...[...listed, ...sums].map(({ amount }) => amount),
  ])
  // A row is an id with the mark that may come after it, a space, a day, two spaces, an amount, two spaces, and
  // then the merchant in whatever is left.
  const room = MAX_ROW - (idWidth + 1 + 1 + dayWidth + 2 + amountWidth + 2)
  const row = (id: string, day: string, amount: string, merchant: string) =>
    `${id} ${day}  ${amount.padStart(amountWidth)}  ${fitted(merchant, room)}`.trimEnd()

  return drafts.map(({ name, heading, purchases, sums }) => ({
    name,
    header:
      heading === undefined
        ? undefined
        : row('ID'.padEnd(idWidth + 1), 'Date'.padEnd(dayWidth), heading, 'Merchant'),
    rows: purchases.map(({ id, parser, date, amount, merchant }) => {
      const mark = parser === MANUAL ? BY_HAND : ' '
      return row(String(id).padStart(idWidth) + mark, date.padStart(dayWidth), amount, merchant || '-')
    }),
    // What sums a table up is named where a purchase has its day, with nothing where a purchase has its id.
    end: sums.map(({ label, amount }) => row(' '.repeat(idWidth + 1), label.padEnd(dayWidth), amount, '')),
  }))
}

/**
 * What the table of a section holds, in whichever of the two ways it is then set out: the purchases to list and
 * what sums the section up, each with its amount as the table writes it.
 */
function drafted(section: Section, homeCurrency: string) {
  const { name, purchases } = section
  const sums = sumsOf(section, homeCurrency)
  // An amount is a number alone where every amount of its table is in one currency, which the header names. A
  // table that lists no purchase has no header, so there that currency has to be the card's own. In any other
  // table each amount has the code of its currency.
  const currencies = new Set([...purchases, ...sums].map(({ currency }) => currency))
  if (purchases.length === 0) currencies.add(homeCurrency)
  const coded = currencies.size > 1
  const written = ({ currency, amountMinor }: Amount) =>
    coded ? formatMoney(amountMinor, currency) : formatAmount(amountMinor)
  return {
    name,
    // What the column of amounts is headed with. Nothing for a table that lists no purchase, which has no header.
    heading: purchases.length === 0 ? undefined : coded ? 'Amount' : purchases[0].currency,
    purchases: purchases.map((purchase) => ({ ...purchase, amount: written(purchase) })),
    sums: sums.map((sum) => ({ ...sum, amount: written(sum) })),
  }
}

/**
 * What a table ends with, each amount with what it is called there: what the section's purchases come to and, for a
 * section with a limit, the limit, what the card's patterns hold back of it, when that is anything, and what is
 * left of it once both are taken off.
 */
function sumsOf({ spent, limitMinor, toComeMinor = 0 }: Section, homeCurrency: string): (Amount & { label: string })[] {
  // Nothing spent is none of the card's own currency.
  const totals = spent.length > 0 ? spent : [{ currency: homeCurrency, amountMinor: 0 }]
  const sums = totals.map((total) => ({ ...total, label: 'Total' }))
  if (limitMinor === undefined) return sums
  // What a purchase in another currency comes to in the product's own is not known here.
  const left = leftOf(limitMinor, spent, homeCurrency, toComeMinor)
  return [
    ...sums,
    { currency: homeCurrency, amountMinor: limitMinor, label: 'Cap' },
    ...(toComeMinor > 0 ? [{ currency: homeCurrency, amountMinor: toComeMinor, label: TO_COME }] : []),
    // Past the limit, nothing is left of it, and the row says how far past it the spend is.
    { currency: homeCurrency, amountMinor: Math.abs(left), label: left < 0 ? 'Over' : 'Left' },
  ]
}

/** How many characters the longest of the cells of a column has. */
function widthOf(cells: string[]): number {
  return Math.max(...cells.map((cell) => cell.length))
}

/**
 * The text in so many characters at most: cut short when it is longer, with an ellipsis for the last of them. A
 * character that a string holds as two code units is one character here, and is never cut in half.
 */
function fitted(text: string, width: number): string {
  const characters = [...text]
  if (characters.length <= width) return text
  return width > 0 ? `${characters.slice(0, width - 1).join('').trimEnd()}…` : ''
}

/**
 * What comes after the tables of a card with a product: how far the spend of the window is towards the product's
 * minimum, when it has one, then what a group with a limit holds in other currencies, when one holds any, and last
 * whose terms the limits in the tables are from.
 */
export function breakdownLines(product: Product, breakdown: Breakdown): string[] {
  const { name, homeCurrency, minimumSpendMinor, termsAsOf } = product
  const others = otherCurrencyLines(breakdown, homeCurrency)
  const terms = `Limits are from the bank's terms for the ${name}, as of ${termsAsOf}.`
  if (minimumSpendMinor === undefined) return [...others, terms]
  const counted = formatMoney(breakdown.countedMinor, homeCurrency)
  const minimum = `Minimum spend: ${counted} of ${formatMoney(minimumSpendMinor, homeCurrency)}`
  return [
    // What a purchase in another currency comes to in the product's own is not known here.
    breakdown.foreignLeftOut ? `${minimum}, not counting purchases in other currencies` : minimum,
    ...others,
    terms,
  ]
}

/**
 * The line that says why a table has more than one `Total`, and why a purchase in another currency leaves its
 * `Left` as it was: a limit is held against what was spent in the card's own currency, as `sumsOf` has it. The line
 * names what the groups with a limit hold in other currencies, a total to each currency, joined as the total of a
 * card joins them. There is no line when no such group holds any: a purchase in a group without a limit has no
 * limit to come off, whatever its currency.
 */
function otherCurrencyLines(breakdown: Breakdown, homeCurrency: string): string[] {
  const limited = breakdown.groups.filter((group) => group.limitMinor !== undefined)
  const spent = limited.flatMap((group) => group.spent)
  const foreign = perCurrency(spent.filter(({ currency }) => currency !== homeCurrency))
  if (foreign.length === 0) return []
  const amounts = foreign.map(({ amountMinor, currency }) => formatMoney(amountMinor, currency)).join(' + ')
  return [
    `A table has a Total for each currency. A Cap counts ${homeCurrency} only, so ${amounts} is not taken off what ` +
      `is Left: an alert does not say what a purchase in another currency comes to in ${homeCurrency}.`,
  ]
}
