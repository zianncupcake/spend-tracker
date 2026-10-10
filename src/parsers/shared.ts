// What the parsers of the banks' alerts have in common: how the text of an alert is spaced, how an amount, a
// merchant's name and a time in Singapore are read from it, and how far the date that it states is gone by.
//
// Email text can be hostile. Of the two patterns here, one matches a run of blanks and nothing after it, and the
// other holds no repetition, so neither can backtrack.

const MAX_MERCHANT_LENGTH = 80

// A full stop that ends a sentence: a space comes after it, or nothing does.
const SENTENCE_END = /\.(?: |$)/

// Singapore is eight hours ahead of UTC all year round.
const SINGAPORE_OFFSET = 8 * 3600

/**
 * How far what an alert states of when its purchase was made may be from when its email came: two days, in seconds.
 * A bank sends an alert as the purchase is made, so a date further off than that, such as a day of another year, is
 * not gone by, and the purchase is dated by the email instead.
 */
export const MAX_FROM_EMAIL = 2 * 24 * 3600

/**
 * The text with every run of blanks as one space. The sentence of an alert can arrive wrapped across lines, or
 * spaced with tabs and no-break spaces, and it is matched as a reader would see it.
 */
export function singleSpaced(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/**
 * Hundredths of the unit in an amount, from the two parts that a parser's pattern reads it in: the whole part, with
 * or without thousands separators, and the decimals with the full stop before them, which are two at most and may
 * be missing. So "1,234" and ".5" make 123450, and "7" and "" make 700.
 */
export function hundredths(whole: string, decimals: string): number {
  return Number(whole.replaceAll(',', '')) * 100 + Number(decimals.slice(1).padEnd(2, '0'))
}

/**
 * The merchant's name, which `rest` begins with: the rest of an alert's text, single-spaced, from where the name
 * starts. The name runs to the full stop that closes its sentence, and can hold full stops of its own. So when
 * `following`, the words that the bank puts after the sentence, are there, the sentence's full stop is the last one
 * before them. When they are not, it is taken to be the first that a space or the end of the text comes after.
 * Null when no full stop closes the sentence, and when no name comes before the one that does.
 */
export function merchantIn(rest: string, following: string): string | null {
  const next = rest.indexOf(following)
  const end = next < 0 ? rest.search(SENTENCE_END) : rest.lastIndexOf('.', next)
  if (end < 0) return null
  return rest.slice(0, end).trim().slice(0, MAX_MERCHANT_LENGTH).trimEnd() || null
}

/**
 * Unix seconds of a time on a date in Singapore, with the month counted from 0. Null when there is no such date or
 * time: one that does not exist, such as 31 February or 24:00, rolls over into one that does, and then does not
 * read back as it was given.
 */
export function singaporeTime(year: number, month: number, day: number, hour = 0, minute = 0): number | null {
  // What a clock in Singapore shows, held as though it were a time in UTC.
  const shown = new Date(Date.UTC(year, month, day, hour, minute))
  const exists =
    shown.getUTCMonth() === month &&
    shown.getUTCDate() === day &&
    shown.getUTCHours() === hour &&
    shown.getUTCMinutes() === minute
  return exists ? shown.getTime() / 1000 - SINGAPORE_OFFSET : null
}
