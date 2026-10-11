import { hundredths, MAX_FROM_EMAIL, MAX_MERCHANT_LENGTH, MONTHS, singaporeTime, singleSpaced } from './shared'
import type { Parser } from './types'

// HSBC (Singapore) tells of a purchase made with one of its credit cards in a sentence of an email and a table under
// it. The table has a row to each thing that the bank says of the purchase: what the thing is called in one cell,
// and the thing in the cell beside it. The values in this one are made up:
//
//   Please note there was a transaction made on your HSBC credit card.
//
//   Card Number          XXXX-XXXX-XXXX-1234
//   Transaction Date     09/OCT/2026
//   Transaction Time     20:01:02
//   Transaction Amount   SGD12.34
//   Description          SOME MERCHANT PTE. LTD.
//
// The date and the time are Singapore's. The paragraph after the table begins "You can also log on".
//
// The table does not say what came of a transaction, so it is the sentence that makes an email a purchase, as the
// verb of their one sentence does for the alerts of the other banks. An email that has the table under other words
// gives no purchase: should the bank tell of a transaction that it declined, or of a refund, with the same table,
// that is an alert that could not be read, and is not stored as a purchase.
//
// The email is HTML and nothing else, so what is read here is the text that ../google/gmail makes of the HTML. That
// has each cell on a line of its own, and empty lines between the cells: as many as the HTML has line ends there.

// Email text can be hostile. Every quantifier below is bounded and none sits inside another repetition, so a match
// cannot backtrack heavily. The pattern is matched against the lines of the email that hold anything: see `lined`.
// So what parts a cell from the next is one line end or, should the two come on one line, one space. The pattern
// begins at the first cell and ends where the merchant's name begins, or with the text. Its groups are: last four
// digits, day, month, year, hour, minute, second, currency, whole amount (with or without thousands separators) and
// decimals (may be empty).
const TRANSACTION =
  /\bCard Number[ \n]X{4}-X{4}-X{4}-(\d{4})[ \n]Transaction Date[ \n](\d\d)\/([A-Za-z]{3})\/(\d{4})[ \n]Transaction Time[ \n](\d\d):(\d\d):(\d\d)[ \n]Transaction Amount[ \n]([A-Z]{3}) ?(\d{1,3}(?:,\d\d\d){0,3}|\d{1,12})(\.\d{1,2}|)[ \n]Description(?:[ \n]|$)/

// What ends a line. A carriage return and a line feed together are two of these, and the empty line between the two
// is dropped with the others.
const LINE_END = /[\r\n]/

// What the bank says before the table of a purchase, which is what makes the email one: see above.
const PRECEDING = 'there was a transaction made on your HSBC credit card'

// What the bank puts after the table. A merchant's name ends where its line does, so these words tell two other
// things: that the cell of the name was empty, when they are the next line that holds anything, and where the name
// ends in a text that came with no line ends at all.
const FOLLOWING = 'You can also log on'

export const hsbc: Parser = {
  name: 'hsbc',
  senders: ['hsbc.bank.singapore.limited@notification.hsbc.com.hk'],

  parse(email) {
    const text = lined(email.text)
    const match = TRANSACTION.exec(text)
    // The bank's sentence has to come before the table. It is looked for as a reader would see it, so it can come
    // wrapped across lines.
    if (!match || !singleSpaced(text.slice(0, match.index)).includes(PRECEDING)) return null
    const [upToMerchant, cardLast4, day, month, year, hour, minute, second, currency, whole, decimals] = match
    // A month by a name that is not known counts as month -1, and there is no such month.
    const monthIndex = MONTHS.indexOf(month.toLowerCase())
    const stated = singaporeTime(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second))

    return {
      cardLast4,
      amountMinor: hundredths(whole, decimals),
      currency,
      merchant: merchantOn(text.slice(match.index + upToMerchant.length)),
      // When the alert states a date or a time that does not exist, or one that is more than two days from when the
      // email came, the purchase is dated by the email instead.
      occurredAt: stated !== null && Math.abs(stated - email.receivedAt) <= MAX_FROM_EMAIL ? stated : email.receivedAt,
    }
  },
}

/**
 * The lines of the text that hold anything, each as a reader would see it: with every run of blanks in it as one
 * space, and with none at either end. A line end comes between two of them. How many empty lines part two cells of
 * the table is the doing of the HTML, and a reader sees none of them.
 */
function lined(text: string): string {
  return text
    .split(LINE_END)
    .map((line) => singleSpaced(line).trim())
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * The merchant's name, which `rest` begins with: the lines of an alert, from where the cell under "Description"
 * starts. The name is the whole of its line, with whatever full stops it holds, and nothing of the lines after it.
 * It ends before the words that the bank puts after the table, when they are on that line. Null when no name comes
 * before them, as when the cell was empty and the line is theirs, and when the text ends with the table.
 */
function merchantOn(rest: string): string | null {
  const lineEnd = rest.indexOf('\n')
  const line = lineEnd < 0 ? rest : rest.slice(0, lineEnd)
  const next = line.indexOf(FOLLOWING)
  const name = next < 0 ? line : line.slice(0, next)
  return name.trim().slice(0, MAX_MERCHANT_LENGTH).trimEnd() || null
}
