import { hundredths, MAX_FROM_EMAIL, merchantIn, singaporeTime, singleSpaced } from './shared'
import type { Parser } from './types'

// UOB (Singapore) tells of a purchase made with one of its cards in one sentence of an email. The values in this
// one are made up:
//
//   A transaction of SGD 45.60 was made with your UOB Card ending 4321 on 09/10/26 at SAMPLE EATERY PTE. LT. If
//   unauthorised, call 24/7 Fraud Hotline now
//
// The date is Singapore's, with the day first, and no time comes with it. The bank cuts a long merchant's name
// short, so a name can end partway through a word.

// Email text can be hostile. Every quantifier below is bounded and none sits inside another repetition, so a match
// cannot backtrack heavily. The pattern begins at the currency code and ends where the merchant's name begins. The
// bank may call a card more than "Card", so up to 40 characters are let through between "UOB" and "ending". The
// groups are: currency, whole amount (with or without thousands separators, and empty when decimals follow), decimals
// (may be empty), last four digits, day, month and year.
const TRANSACTION =
  /\b([A-Z]{3}) ?(\d{1,3}(?:,\d\d\d){0,3}|\d{1,12}|(?=\.\d))(\.\d{1,2}|) was made with your UOB .{0,40}?ending (\d{4}) on (\d\d)\/(\d\d)\/(\d\d) at /

// What the bank puts after the sentence. It tells where the merchant's name ends. The word is spelt with an s or
// with a z, "unauthorised" or "unauthorized", so it is matched as far as the two spellings are the same.
const FOLLOWING = ' If unauthori'

const DAY = 24 * 3600

export const uob: Parser = {
  name: 'uob',
  senders: ['unialerts@uobgroup.com'],

  parse(email) {
    const text = singleSpaced(email.text)
    const match = TRANSACTION.exec(text)
    if (!match) return null
    const [upToMerchant, currency, whole, decimals, cardLast4, day, month, year] = match
    const dayStart = singaporeTime(2000 + Number(year), Number(month) - 1, Number(day))

    return {
      cardLast4,
      amountMinor: hundredths(whole, decimals),
      currency,
      merchant: merchantIn(text.slice(match.index + upToMerchant.length), FOLLOWING),
      occurredAt: purchaseTime(dayStart, email.receivedAt),
    }
  },
}

/**
 * When the purchase was made, from the start of the day that the alert states and the time the email came. An email
 * that came on that day in Singapore is taken to have come when the purchase was made. For one that came on another
 * day, noon stands in for the time. And when the alert states a date that does not exist, so that `dayStart` is
 * null, or a day that is more than two days from when the email came, the purchase is dated by the email.
 */
function purchaseTime(dayStart: number | null, receivedAt: number): number {
  if (dayStart === null) return receivedAt
  const cameThatDay = receivedAt >= dayStart && receivedAt < dayStart + DAY
  // To either side of the day: the email came more than two days before it began, or after it ended.
  const farOff = receivedAt < dayStart - MAX_FROM_EMAIL || receivedAt >= dayStart + DAY + MAX_FROM_EMAIL
  return cameThatDay || farOff ? receivedAt : dayStart + DAY / 2
}
