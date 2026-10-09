import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ingestAlert } from '../src/ingest'
import { parseAlert } from '../src/parsers'
import { ocbc } from '../src/parsers/ocbc'
import { findOrCreateUser, storeFor } from '../src/store'
import { alertEmail, newTelegramId, seconds } from './helpers'

/** When the alert below says its purchase was made: 20:01 on 9 October 2026 in Singapore. */
const STATED = seconds('2026-10-09T12:01:00Z')
/** When the email of the alert came, which is a little later. */
const RECEIVED = seconds('2026-10-09T20:03:00+08:00')

/** The purchase that the alert below tells of. */
const PURCHASE = {
  cardLast4: '1234',
  amountMinor: 1234,
  currency: 'SGD',
  merchant: 'SOME MERCHANT SINGAPORE',
  occurredAt: STATED,
}

/** The sentence of an OCBC card alert. */
function charge(parts: { amount?: string; when?: string; last4?: string; merchant?: string } = {}): string {
  const { amount = 'SGD12.34', when = '20:01 on 09-Oct-26', last4 = '1234', merchant = PURCHASE.merchant } = parts
  return `We wish to inform you that ${amount} was charged at ${when} to your card (-${last4}) at ${merchant}.`
}

/** An alert as it reads: the sentence, with a greeting above it and the bank's advice below. The words are made up. */
function alertBody(sentence = charge()): string {
  return [
    'Dear Sir / Madam,',
    sentence,
    'Did not make this transaction? Call the number on the back of your card at once, and the card will be blocked.',
    'Never tell anyone your PIN or a one-time password. The bank will not ask you for either.',
    'This email was sent by a system that takes no replies.',
  ].join('\n\n')
}

function ocbcEmail(text = alertBody()) {
  return alertEmail({ from: 'noreply@notify.ocbc.com', subject: 'Card transaction alert', receivedAt: RECEIVED, text })
}

const parse = (text: string) => parseAlert(ocbcEmail(text))

describe('OCBC card alerts', () => {
  it('reads a charge from among the greeting above it and the advice below', () => {
    expect(parse(alertBody())).toEqual({ ...PURCHASE, parser: 'ocbc' })
  })

  it.each([
    ['SGD1,234.56', 'SGD', 123456],
    ['SGD1,234,567.89', 'SGD', 123456789],
    ['SGD999,999,999,999.99', 'SGD', 99999999999999],
    ['SGD1234.56', 'SGD', 123456],
    ['SGD0.05', 'SGD', 5],
    ['SGD7', 'SGD', 700],
    ['SGD7.5', 'SGD', 750],
    ['USD8.00', 'USD', 800],
    ['JPY1,500', 'JPY', 150000],
    ['SGD 12.34', 'SGD', 1234],
  ])('reads %s as %s and %i hundredths', (amount, currency, amountMinor) => {
    expect(parse(alertBody(charge({ amount })))).toMatchObject({ currency, amountMinor })
  })

  it.each([
    ['wrapped across lines', '\n'],
    ['wrapped across lines that end with a carriage return', '\r\n'],
    ['spaced with runs of spaces', '   '],
    ['spaced with no-break spaces', '\xa0'],
    ['spaced with tabs and no-break spaces among the spaces', ' \t\xa0 '],
  ])('reads a sentence that is %s', (_, blank) => {
    expect(parse(alertBody().replaceAll(' ', blank))).toEqual({ ...PURCHASE, parser: 'ocbc' })
  })

  it.each(['SHOP.EXAMPLE SG', 'EXAMPLE TRADING PTE. LTD.'])(
    'keeps the full stops of the merchant %s, when the advice follows the sentence',
    (merchant) => {
      expect(parse(alertBody(charge({ merchant })))?.merchant).toBe(merchant)
    },
  )

  it('trims the merchant, and keeps no more than 80 characters of it', () => {
    const merchantOf = (merchant: string) => parse(alertBody(charge({ merchant })))?.merchant

    expect(merchantOf('  SPACED OUT  ')).toBe('SPACED OUT')
    expect(merchantOf('M'.repeat(200))).toBe('M'.repeat(80))
    // The space that the cut would leave at the end is dropped too.
    expect(merchantOf(`${'M'.repeat(79)} AND MORE`)).toBe('M'.repeat(79))
  })

  it('ends the merchant at the first full stop that closes a word, when no advice follows the sentence', () => {
    const merchantOf = (text: string) => parse(text)?.merchant

    expect(merchantOf(`Dear Sir / Madam,\n\n${charge()}`)).toBe('SOME MERCHANT SINGAPORE')
    expect(merchantOf(`${charge({ merchant: 'SHOP.EXAMPLE SG' })}\n\nThank you for banking with us.`)).toBe(
      'SHOP.EXAMPLE SG',
    )
    // Without the advice to go by, a full stop that closes a word of the name is taken for the sentence's.
    expect(merchantOf(charge({ merchant: 'EXAMPLE TRADING PTE. LTD.' }))).toBe('EXAMPLE TRADING PTE')
  })

  it('keeps a charge whose merchant it cannot tell, with no merchant', () => {
    const unclosed = charge().slice(0, -1)

    expect(parse(unclosed)).toEqual({ ...PURCHASE, merchant: null, parser: 'ocbc' })
    expect(parse(`${unclosed}\n\nDid not make this transaction? Call us.`)?.merchant).toBeNull()
    expect(parse(alertBody(charge({ merchant: '' })))?.merchant).toBeNull()
  })

  it.each([
    ['00:00 on 01-Jan-27', '2026-12-31T16:00:00Z'],
    ['07:59 on 10-Oct-26', '2026-10-09T23:59:00Z'],
    ['23:59 on 29-Feb-28', '2028-02-29T15:59:00Z'],
    ['12:30 on 05-MAY-26', '2026-05-05T04:30:00Z'],
  ])('reads %s as a time in Singapore, eight hours ahead of UTC', (when, utc) => {
    expect(parse(alertBody(charge({ when })))?.occurredAt).toBe(seconds(utc))
  })

  it('knows every month by its three letters', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

    for (const [index, month] of months.entries()) {
      const noon = seconds(`2026-${String(index + 1).padStart(2, '0')}-15T12:00:00+08:00`)
      expect(parse(alertBody(charge({ when: `12:00 on 15-${month}-26` })))?.occurredAt).toBe(noon)
    }
  })

  it.each([
    ['a day that its month does not have', '20:01 on 31-Feb-26'],
    ['a leap day in a year that has none', '20:01 on 29-Feb-27'],
    ['day 0', '20:01 on 00-Oct-26'],
    ['a month it does not know', '20:01 on 09-Okt-26'],
    ['an hour that a day does not have', '24:00 on 09-Oct-26'],
    ['a minute that an hour does not have', '20:60 on 09-Oct-26'],
  ])('dates the purchase by the email when the alert states %s', (_, when) => {
    expect(parse(alertBody(charge({ when })))).toEqual({ ...PURCHASE, occurredAt: RECEIVED, parser: 'ocbc' })
  })

  it.each([
    ['a notice of a funds transfer', 'You transferred SGD50.00 from your account (-1234) at 20:01 on 09-Oct-26.'],
    ['a notice of a login', 'You logged in to online banking at 20:01 on 09-Oct-26. Did not make this login? Call us.'],
    ['marketing', 'Earn rebates when you use your card (-1234) at SOME MERCHANT SINGAPORE, from SGD12.34 a visit.'],
    ['a refund to the card', alertBody(charge().replace('was charged', 'was refunded'))],
    ['a charge to something other than a card', alertBody(charge().replace('your card', 'your account'))],
    ['a malformed thousands separator', alertBody(charge({ amount: 'SGD1,23.45' }))],
    ['three decimals', alertBody(charge({ amount: 'SGD1.234' }))],
    ['a lower-case currency', alertBody(charge({ amount: 'sgd12.34' }))],
    ['a currency of four letters', alertBody(charge({ amount: 'SGDX12.34' }))],
    ['no amount', alertBody(charge({ amount: 'SGD' }))],
    ['a card shown with three digits', alertBody(charge({ last4: '123' }))],
    ['a card shown with five digits', alertBody(charge({ last4: '12345' }))],
    ['a date written another way', alertBody(charge({ when: '20:01 on 9 October 2026' }))],
    ['no time', alertBody(charge({ when: '09-Oct-26' }))],
    ['only the greeting and the advice', alertBody('')],
    ['no text', ''],
  ])('returns null for %s', (_, text) => {
    expect(parse(text)).toBeNull()
  })

  it('only reads alerts from the address that the bank sends them from', () => {
    const from = (address: string) => parseAlert({ ...ocbcEmail(), from: address })

    expect(from('noreply@notify.ocbc.com')?.parser).toBe('ocbc')
    expect(from(' NoReply@Notify.OCBC.com ')?.parser).toBe('ocbc')
    expect(from('noreply@notify.ocbc.com.attacker.test')).toBeNull()
    expect(from('offers@notify.ocbc.com')).toBeNull()
    expect(from('alerts@otherbank.test')).toBeNull()
    // In the mail of another bank the sentence is for that bank's parser to read, and it makes nothing of it.
    expect(from('alerts@examplebank.test')).toBeNull()
    expect(from('unialerts@uobgroup.com')).toBeNull()
  })

  it('sends its alerts from one address', () => {
    expect(ocbc.senders).toEqual(['noreply@notify.ocbc.com'])
  })

  it('returns quickly on very long hostile strings', () => {
    // A sentence that matches up to the last word before the merchant is the most work one attempt can cost.
    const nearMiss = charge({ amount: 'SGD999,999,999,999.99' }).split(' at SOME')[0]
    // Each string is some 200,000 characters: more than is ever decoded of an email's body.
    const hostile = [
      `${nearMiss}\n`.repeat(2_000),
      `${nearMiss} `.repeat(2_000),
      `SGD${'999,'.repeat(50_000)}`,
      'SGD1 was charged at '.repeat(10_000),
      'SGD '.repeat(50_000),
      'SGD'.repeat(70_000),
      '1,'.repeat(100_000),
      'a '.repeat(100_000),
      '\n'.repeat(200_000),
      ' \xa0\t'.repeat(70_000),
    ]
    // After a sentence that does match, the merchant is looked for in all that follows it.
    const unclosed = charge().slice(0, -1)
    const afterSentence = [
      `${unclosed}${'.x'.repeat(100_000)}`,
      `${unclosed}${' x'.repeat(100_000)}`,
      `${unclosed}${'. '.repeat(100_000)}Did not make this transaction?`,
      `${unclosed}${'Did not make this transaction? '.repeat(6_000)}`,
    ]

    const started = performance.now()
    for (const text of hostile) {
      expect(parse(text)).toBeNull()
      // The parser on its own, without the cap on length that parseAlert applies.
      expect(ocbc.parse(ocbcEmail(text))).toBeNull()
    }
    for (const text of afterSentence) {
      expect(parse(text)).toMatchObject({ amountMinor: 1234 })
      expect(ocbc.parse(ocbcEmail(text))).toMatchObject({ amountMinor: 1234 })
    }

    // Measured at about 35 ms. Heavy backtracking over text of this length would take far longer.
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('is stored as a purchase when its alert is ingested', async () => {
    const store = storeFor(env.DB, (await findOrCreateUser(env.DB, newTelegramId())).id)

    const result = await ingestAlert(store, ocbcEmail())

    expect(result).toMatchObject({ status: 'stored', transaction: { ...PURCHASE, parser: 'ocbc' } })
    expect(await store.listTransactions(null, 0, 4_000_000_000, 10)).toMatchObject([PURCHASE])
  })
})
