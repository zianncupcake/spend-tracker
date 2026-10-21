import { hundredths, MAX_FROM_EMAIL, MAX_MERCHANT_LENGTH, MONTHS, singaporeTime, singleSpaced } from './shared'
import type { Parser } from './types'

// DBS Bank (Singapore) tells of a purchase made with one of its cards, or a POSB one, in a "Card Transaction Alert".
// The values in this one are made up:
//
//   Date & Time: 09 OCT 20:01 (SGT)
//   Amount: SGD12.34
//   From: DBS/POSB card ending 1234
//   To: SOME MERCHANT SINGAPORE SGP
//
//   If unauthorised, please login to DBS digibank mobile to report fraud dispute immediately.
//
// The time is Singapore's, and no year comes with it. The bank sends its alerts of transfers from the same address,
// and it is the "From:" line, which names a card, that makes an email one of a purchase.

// Email text can be hostile. Every quantifier below is bounded and none sits inside another repetition, so a match
// cannot backtrack heavily. The pattern begins at the time and ends where the merchant's name begins. Its groups are:
// day, month, hour, minute, currency, whole amount (with or without thousands separators), decimals (may be empty)
// and last four digits.
const TRANSACTION =
  /\bDate & Time: (\d{1,2}) ([A-Za-z]{3}) (\d\d):(\d\d) \(SGT\) Amount: ([A-Z]{3}) ?(\d{1,3}(?:,\d\d\d){0,3}|\d{1,12})(\.\d{1,2}|) From: DBS\/POSB card ending (\d{4}) To: /

// What the bank puts after the merchant's name, which has no full stop to end it. It is matched as far as the two
// spellings, "unauthorised" and "unauthorized", are the same.
const FOLLOWING = 'If unauthori'

export const dbs: Parser = {
  name: 'dbs',
  senders: ['ibanking.alert@dbs.com'],

  parse(email) {
    const text = singleSpaced(email.text)
    const match = TRANSACTION.exec(text)
    if (!match) return null
    const [upToMerchant, day, month, hour, minute, currency, whole, decimals, cardLast4] = match
    // A month by a name that is not known counts as month -1, and there is no such month.
    const monthIndex = MONTHS.indexOf(month.toLowerCase())
    // The year is the one, of the email's and the years either side of it, that puts the purchase nearest the email.
    const year = new Date(email.receivedAt * 1000).getUTCFullYear()
    const [stated] = [year - 1, year, year + 1]
      .map((candidate) => singaporeTime(candidate, monthIndex, Number(day), Number(hour), Number(minute)))
      .filter((time) => time !== null)
      .sort((a, b) => Math.abs(a - email.receivedAt) - Math.abs(b - email.receivedAt))
    if (stated === undefined) return null
    const rest = text.slice(match.index + upToMerchant.length)
    const end = rest.indexOf(FOLLOWING)

    return {
      cardLast4,
      amountMinor: hundredths(whole, decimals),
      currency,
      // Null when the words after the name are not there to tell where it ends.
      merchant: end < 0 ? null : rest.slice(0, end).trim().slice(0, MAX_MERCHANT_LENGTH).trimEnd() || null,
      // When the time is more than two days from when the email came, the purchase is dated by the email instead.
      occurredAt: Math.abs(stated - email.receivedAt) <= MAX_FROM_EMAIL ? stated : email.receivedAt,
    }
  },
}
