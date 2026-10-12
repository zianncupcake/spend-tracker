import { hundredths } from '../src/parsers/shared'
import type { Parser } from '../src/parsers/types'

// Example Bank is invented. The tests use it in place of a real bank, and it
// shows the shape of a parser. Its alert is one whole line of the email:
//
//   A transaction of SGD 1,234.56 was made with your Example Bank card ending 1234 at COFFEE PLACE.

// Email text can be hostile. Every quantifier below is bounded and none sits
// inside another repetition, so a match cannot backtrack heavily. The groups
// are: currency, whole amount (with or without thousands separators), decimals
// (may be empty), last four digits, and merchant (up to the line's last full stop).
const ALERT =
  /^A transaction of ([A-Z]{3}) (\d{1,3}(?:,\d\d\d){0,3}|\d{1,12})(\.\d{1,2}|) was made with your Example Bank card ending (\d{4}) at ([^\r\n]{1,80})\.$/m

export const exampleBank: Parser = {
  name: 'example-bank',
  senders: ['alerts@examplebank.test'],

  parse(email) {
    const match = ALERT.exec(email.text)
    if (!match) return null
    const [, currency, whole, decimals, cardLast4, merchant] = match

    return {
      cardLast4,
      amountMinor: hundredths(whole, decimals),
      currency,
      merchant: merchant.trim() || null,
      occurredAt: email.receivedAt,
    }
  },
}
