import { hundredths, merchantIn, singaporeTime, singleSpaced } from './shared'
import type { Parser } from './types'

// OCBC Bank (Singapore) tells of a purchase made with one of its cards in one sentence of an email. The values in
// this one are made up:
//
//   We wish to inform you that SGD12.34 was charged at 20:01 on 09-Oct-26 to your card (-1234) at SOME MERCHANT
//   SINGAPORE.
//
// The time is Singapore's. The paragraph after the sentence begins "Did not make this transaction?".

// Email text can be hostile. Every quantifier below is bounded and none sits inside another repetition, so a match
// cannot backtrack heavily. The pattern begins at the currency code and ends where the merchant's name begins. Its
// groups are: currency, whole amount (with or without thousands separators), decimals (may be empty), hour, minute,
// day, month, year and last four digits.
const CHARGE =
  /\b([A-Z]{3}) ?(\d{1,3}(?:,\d\d\d){0,3}|\d{1,12})(\.\d{1,2}|) was charged at (\d\d):(\d\d) on (\d\d)-([A-Za-z]{3})-(\d\d) to your card \(-(\d{4})\) at /

// What the bank puts after the sentence. It tells where the merchant's name ends.
const FOLLOWING = 'Did not make this transaction'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export const ocbc: Parser = {
  name: 'ocbc',
  senders: ['noreply@notify.ocbc.com'],

  parse(email) {
    const text = singleSpaced(email.text)
    const match = CHARGE.exec(text)
    if (!match) return null
    const [upToMerchant, currency, whole, decimals, hour, minute, day, month, year, cardLast4] = match
    // A month by a name that is not known counts as month -1, and there is no such month.
    const monthIndex = MONTHS.indexOf(month.toLowerCase())
    const stated = singaporeTime(2000 + Number(year), monthIndex, Number(day), Number(hour), Number(minute))

    return {
      cardLast4,
      amountMinor: hundredths(whole, decimals),
      currency,
      merchant: merchantIn(text.slice(match.index + upToMerchant.length), FOLLOWING),
      // When the alert states a date or a time that does not exist, the purchase is dated by the email instead.
      occurredAt: stated ?? email.receivedAt,
    }
  },
}
