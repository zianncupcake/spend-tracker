import { hundredths, MAX_FROM_EMAIL, merchantIn, singaporeTime, singleSpaced } from './shared'
import type { ParsedTransaction, Parser } from './types'

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

// UOB also tells of a bill paid from one of its bank accounts, as in this made-up sentence:
//
//   You made/scheduled a bill payment(s) of SGD 88.20 to SAMPLE PAYEE on your a/c ending 1111 at 4:58PM SGT, 25 Oct
//   26. Bill ref: ending 4321. If unauthorised, call UOB 24/7 Fraud Hotline.
//
// The bill ref is the last four digits of the card that was paid. Bounded as TRANSACTION is, with up to 160
// characters let through for the payee, the account and the time, none of which is kept. The groups are: currency,
// whole amount, decimals and the card's last four digits.
const PAYMENT =
  /\bbill payment\(s\) of ([A-Z]{3}) ?(\d{1,3}(?:,\d\d\d){0,3}|\d{1,12}|(?=\.\d))(\.\d{1,2}|) to .{0,160}?\. Bill ref: ending (\d{4})\b/

// When a scheduled payment goes through, the bank tells of it in another sentence, as in this made-up one:
//
//   Your scheduled bill payment of SGD 52.30 to SAMPLE PAYEE on your a/c ending 1111 at 8:05AM SGT, 3 Nov 26, bill
//   ref: ending 4321, was successful. If unauthorised, call UOB 24/7 Fraud Hotline.
//
// Bounded as PAYMENT is, with the same groups.
const MADE =
  /\bbill payment of ([A-Z]{3}) ?(\d{1,3}(?:,\d\d\d){0,3}|\d{1,12}|(?=\.\d))(\.\d{1,2}|) to .{0,160}?, bill ref: ending (\d{4}), was successful\b/

// When a payment was made, as both sentences above state it: "at 4:58PM SGT, 25 Oct 26". It is looked for only in
// the matched sentence. The groups are: hour, minute, AM or PM, day, month and year.
const PAID_AT = / at (\d{1,2}):(\d\d) ?([AP]M) SGT, (\d{1,2}) ([A-Z][a-z]{2}) (\d\d)\b/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// A tap of the card itself on public transport is billed later, with others, as in this made-up sentence:
//
//   Your accumulated transit transactions of SGD 8.10 has been billed to your UOB card ending 4321 on 09/10/26.
//
// It names no merchant, so all of these go by one name. Bounded as TRANSACTION is, with the same groups.
const TRANSIT =
  /\baccumulated transit transactions of ([A-Z]{3}) ?(\d{1,3}(?:,\d\d\d){0,3}|\d{1,12}|(?=\.\d))(\.\d{1,2}|) has been billed to your UOB .{0,40}?ending (\d{4}) on (\d\d)\/(\d\d)\/(\d\d)\b/

export const TRANSIT_MERCHANT = 'Accumulated transit'

const DAY = 24 * 3600

export const uob: Parser = {
  name: 'uob',
  senders: ['unialerts@uobgroup.com'],

  parse(email) {
    const text = singleSpaced(email.text)
    const match = TRANSACTION.exec(text)
    if (!match) return transitIn(text, email.receivedAt)
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

  payment(email) {
    const text = singleSpaced(email.text)
    const scheduled = PAYMENT.exec(text)
    const match = scheduled ?? MADE.exec(text)
    if (!match) return null
    const [sentence, currency, whole, decimals, cardLast4] = match
    return {
      cardLast4,
      amountMinor: hundredths(whole, decimals),
      currency,
      made: !scheduled,
      paidAt: paymentTime(sentence, email.receivedAt),
    }
  },
}

/**
 * When the payment was made, as the sentence states it. When it states no time that can be read, or one that is
 * more than two days from when the email came, the payment is dated by the email, as a purchase is.
 */
function paymentTime(sentence: string, receivedAt: number): number {
  const match = PAID_AT.exec(sentence)
  if (!match) return receivedAt
  const [, hour, minute, half, day, month, year] = match
  const hours = (Number(hour) % 12) + (half === 'PM' ? 12 : 0)
  // An unknown month is -1, which singaporeTime finds does not exist.
  const at = singaporeTime(2000 + Number(year), MONTHS.indexOf(month), Number(day), hours, Number(minute))
  return at === null || Math.abs(at - receivedAt) > MAX_FROM_EMAIL ? receivedAt : at
}

function transitIn(text: string, receivedAt: number): ParsedTransaction | null {
  const match = TRANSIT.exec(text)
  if (!match) return null
  const [, currency, whole, decimals, cardLast4, day, month, year] = match
  const dayStart = singaporeTime(2000 + Number(year), Number(month) - 1, Number(day))
  return {
    cardLast4,
    amountMinor: hundredths(whole, decimals),
    currency,
    merchant: TRANSIT_MERCHANT,
    occurredAt: purchaseTime(dayStart, receivedAt),
  }
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
