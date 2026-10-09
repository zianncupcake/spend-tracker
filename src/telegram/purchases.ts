// What the bot says of purchases one by one: the line that a purchase is shown on, the buttons that sort it into
// a category of its card's product, and the table of what the product's rules make of a window.
//
// A merchant's name is text from an email, or text that a user typed. Telegram makes a command or a link of
// whatever looks like one, so wherever a name is shown it is marked as code: see MessageEntity.

import { categoryName, choicesOf } from '../catalogue'
import type { Product } from '../catalogue/types'
import type { Amount, Breakdown } from '../domain/breakdown'
import { MANUAL, type Transaction } from '../store'
import type { Button, MessageEntity, Outgoing } from './api'
import { formatMoney, formatSpend } from './format'

/**
 * The most text that Telegram takes in one message. It is counted here in UTF-16 code units, of which a text has
 * at least as many as it has characters.
 */
const MAX_LENGTH = 4096

/**
 * How many marked stretches of one message Telegram goes by. It makes nothing of those that come after, which would
 * leave a name as text that can be tapped. The limit is not in Telegram's documentation: it is the one that its
 * clients are known to apply.
 */
const MAX_MARKED = 100

const SEPARATOR = ' · '

/** What a button sends back: the id of a purchase, the key of a category and, at times, word that more is to follow. */
const PRESS = /^(\d{1,15}):([a-z0-9-]{1,40})(:next)?$/

/** A line of a message, with the stretch of it that is to be marked as code. */
export interface Line {
  text: string
  marked?: { offset: number; length: number }
}

/**
 * A purchase on one line, such as "#57 5 Oct · SGD 12.40 · COFFEE PLACE · Online · by hand": its id, the day it was
 * made, its amount, its merchant when it has one, the name of its category when one is given, and a note of its
 * having been added by hand.
 */
export function purchaseLine(purchase: Transaction, date: string, category?: string): Line {
  const { id, amountMinor, currency, merchant, parser } = purchase
  const start = `#${id} ${date}${SEPARATOR}${formatMoney(amountMinor, currency)}`
  const notes = [category, parser === MANUAL ? 'by hand' : undefined].filter((note) => note !== undefined)
  if (!merchant) return { text: [start, ...notes].join(SEPARATOR) }
  return {
    text: [start, merchant, ...notes].join(SEPARATOR),
    marked: { offset: start.length + SEPARATOR.length, length: merchant.length },
  }
}

/**
 * The lines as messages, in their order and in as few messages as Telegram takes them in. A message ends where one
 * more line would take it past the text, or past the marked stretches, that Telegram allows. None begins or ends
 * with an empty line.
 */
export function inMessages(lines: Line[]): Outgoing[] {
  const messages: Outgoing[] = []
  let held: Line[] = []
  let length = 0
  let marked = 0
  const close = () => {
    const kept = held.slice(0, held.findLastIndex((line) => line.text !== '') + 1)
    if (kept.length > 0) messages.push(asMessage(kept))
    held = []
    length = 0
    marked = 0
  }

  for (const line of lines) {
    if (length + line.text.length > MAX_LENGTH || (line.marked && marked === MAX_MARKED)) close()
    if (line.text === '' && held.length === 0) continue
    held.push(line)
    // With the line end that comes before the next line.
    length += line.text.length + 1
    if (line.marked) marked++
  }
  close()
  return messages
}

function asMessage(lines: Line[]): Outgoing {
  const entities: MessageEntity[] = []
  let offset = 0
  for (const { text, marked } of lines) {
    if (marked) entities.push({ type: 'code', offset: offset + marked.offset, length: marked.length })
    offset += text.length + 1
  }
  const text = lines.map((line) => line.text).join('\n')
  return entities.length > 0 ? { text, entities } : { text }
}

/** What a purchase with the category is sorted into, as its user is shown it: the category's name, or "not sorted". */
export function whereSorted(product: Product, category: string | null): string {
  return categoryName(product, category) ?? 'not sorted'
}

/** Where a purchase is sorted, as the last line of a message about it: "#57: Online", or "#57: not sorted". */
export function sortedLine(product: Product, purchase: { id: number; category: string | null }): string {
  return `#${purchase.id}: ${whereSorted(product, purchase.category)}`
}

/**
 * The end of a message about one purchase on a card with a product: the line that says where the purchase is
 * sorted, and the buttons that sort it. The buttons come when they are `asked` for and, asked for or not, with a
 * purchase that is not sorted yet. With `next`, a press is to be followed by the card's next unsorted purchase.
 */
export function sortEnd(
  product: Product,
  purchase: { id: number; category: string | null },
  asked = false,
  next = false,
): { line: string; buttons?: Button[][] } {
  const line = sortedLine(product, purchase)
  if (!asked && categoryName(product, purchase.category) !== undefined) return { line }
  // A row to each button, so that no label is cut short on a phone. The one for where the purchase is now is ticked.
  const buttons = choicesOf(product).map(({ key, label }) => [
    { text: key === purchase.category ? `✓ ${label}` : label, data: `${purchase.id}:${key}${next ? ':next' : ''}` },
  ])
  return { line: `${line}. Which was it?`, buttons }
}

/** What a button of `sortEnd` sent back, read again. Null for anything else: a client can send what no button holds. */
export function readPress(data: string): { purchaseId: number; category: string; next: boolean } | null {
  const [, purchaseId, category, next] = PRESS.exec(data) ?? []
  return purchaseId === undefined ? null : { purchaseId: Number(purchaseId), category, next: next !== undefined }
}

/**
 * The table of what a product's rules make of a window: a row for each group with what was spent in it and, where
 * the group has a limit, the limit. Then what is not sorted and what does not count, when there is any. Then how
 * far the spend is towards the minimum, and whose terms all of this is from.
 */
export function breakdownLines(product: Product, breakdown: Breakdown): string[] {
  const { name, homeCurrency, minimumSpendMinor, termsAsOf, excluded } = product
  const spend = (amounts: Amount[]) => formatSpend(amounts, homeCurrency)
  const rows = breakdown.groups.map((group) => {
    const limit = group.limitMinor === undefined ? '' : ` of ${formatMoney(group.limitMinor, homeCurrency)}`
    return `${group.name}: ${spend(group.spent)}${limit}`
  })
  if (breakdown.unsorted.length > 0) rows.push(`Not sorted: ${spend(breakdown.unsorted)}`)
  if (breakdown.excluded.length > 0) rows.push(`${excluded.label}: ${spend(breakdown.excluded)}`)

  const counted = formatMoney(breakdown.countedMinor, homeCurrency)
  const minimum = `Minimum spend: ${counted} of ${formatMoney(minimumSpendMinor, homeCurrency)}`
  return [
    ...rows,
    // What a purchase in another currency comes to in the product's own is not known here.
    breakdown.foreignLeftOut ? `${minimum}, not counting purchases in other currencies` : minimum,
    `Limits are from the bank's terms for the ${name}, as of ${termsAsOf}.`,
  ]
}
