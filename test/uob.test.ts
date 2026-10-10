import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ingestAlert } from '../src/ingest'
import { parseAlert } from '../src/parsers'
import { uob } from '../src/parsers/uob'
import { findOrCreateUser, storeFor } from '../src/store'
import { alertEmail, newTelegramId, seconds } from './helpers'

/** When the email of the alert below came: on the day that the alert states, which is 9 October 2026 in Singapore. */
const RECEIVED = seconds('2026-10-09T15:20:00+08:00')
/** Noon on that day in Singapore. */
const NOON = seconds('2026-10-09T04:00:00Z')

/** The purchase that the alert below tells of. The bank has cut the merchant's name short. */
const PURCHASE = {
  cardLast4: '4321',
  amountMinor: 4560,
  currency: 'SGD',
  merchant: 'SAMPLE EATERY PTE. LT',
  occurredAt: RECEIVED,
}

/** What the bank puts after the sentence of an alert. */
const WARNING = 'If unauthorised, call 24/7 Fraud Hotline now'

interface Parts {
  amount?: string
  card?: string
  last4?: string
  date?: string
  merchant?: string
}

/** The sentence of a UOB card alert. */
function transaction(parts: Parts = {}): string {
  const { amount = 'SGD 45.60', card = 'Card', last4 = '4321', date = '09/10/26', merchant = PURCHASE.merchant } = parts
  return `A transaction of ${amount} was made with your UOB ${card} ending ${last4} on ${date} at ${merchant}.`
}

/** An alert as it reads: the sentence and the warning, with the bank's disclaimer below. Its words are made up. */
function alertBody(sentence = transaction()): string {
  return [
    `${sentence} ${WARNING}`,
    'UOB EMAIL DISCLAIMER: This email is meant only for the person it was sent to. If that is not you, delete it ' +
      'and tell the bank. Email is not a safe way to send anything, and the bank does not answer for what happens ' +
      'to a message on its way. Nothing in this email is advice.',
  ].join('\n\n')
}

function uobEmail(text = alertBody(), receivedAt = RECEIVED) {
  return alertEmail({ from: 'unialerts@uobgroup.com', subject: 'Card transaction alert', receivedAt, text })
}

const parse = (text: string) => parseAlert(uobEmail(text))

describe('UOB card alerts', () => {
  it('reads a transaction that has the warning and the disclaimer after it', () => {
    expect(parse(alertBody())).toEqual({ ...PURCHASE, parser: 'uob' })
  })

  it.each([
    ['SGD 1,234.56', 'SGD', 123456],
    ['SGD 1,234,567.89', 'SGD', 123456789],
    ['SGD 999,999,999,999.99', 'SGD', 99999999999999],
    ['SGD 1234.56', 'SGD', 123456],
    ['SGD 0.05', 'SGD', 5],
    ['SGD 7', 'SGD', 700],
    ['SGD 7.5', 'SGD', 750],
    ['USD 8.00', 'USD', 800],
    ['JPY 1,500', 'JPY', 150000],
    ['SGD45.60', 'SGD', 4560],
  ])('reads %s as %s and %i hundredths', (amount, currency, amountMinor) => {
    expect(parse(alertBody(transaction({ amount })))).toMatchObject({ currency, amountMinor })
  })

  it.each([
    ['wrapped across lines', '\n'],
    ['wrapped across lines that end with a carriage return', '\r\n'],
    ['spaced with runs of spaces', '   '],
    ['spaced with no-break spaces', '\xa0'],
    ['spaced with tabs and no-break spaces among the spaces', ' \t\xa0 '],
  ])('reads a sentence that is %s', (_, blank) => {
    expect(parse(alertBody().replaceAll(' ', blank))).toEqual({ ...PURCHASE, parser: 'uob' })
  })

  it.each(['Debit Card', 'Example Rewards Credit Card', "Member's Card", 'Platinum'])(
    'reads the transaction of a card that the bank calls its %s',
    (card) => {
      expect(parse(alertBody(transaction({ card })))).toEqual({ ...PURCHASE, parser: 'uob' })
    },
  )

  it.each(['SAMPLE EATERY PTE. LT', 'SHOP.EXAMPLE SG', 'EXAMPLE TRADING PTE. LTD.'])(
    'keeps the full stops of the merchant %s, when the warning follows the sentence',
    (merchant) => {
      expect(parse(alertBody(transaction({ merchant })))?.merchant).toBe(merchant)
    },
  )

  it.each(['unauthorised', 'unauthorized'])('ends the merchant where the warning begins, spelt "%s"', (spelling) => {
    const spelt = (body: string) => body.replace('unauthorised', spelling)
    const unclosed = transaction({ merchant: 'SAMPLE EATERY' }).slice(0, -1)

    expect(spelt(alertBody())).toContain(`If ${spelling}, call`)
    // The name keeps its full stops. Were the warning not found, it would end at the first that closes a word.
    expect(parse(spelt(alertBody()))?.merchant).toBe('SAMPLE EATERY PTE. LT')
    // And the warning is no part of a name that no full stop closes. Not found, it would be read as the name went on.
    expect(parse(spelt(alertBody(unclosed)))?.merchant).toBeNull()
  })

  it('trims the merchant, and keeps no more than 80 characters of it', () => {
    const merchantOf = (merchant: string) => parse(alertBody(transaction({ merchant })))?.merchant

    expect(merchantOf('  SPACED OUT  ')).toBe('SPACED OUT')
    expect(merchantOf('M'.repeat(200))).toBe('M'.repeat(80))
    // The space that the cut would leave at the end is dropped too.
    expect(merchantOf(`${'M'.repeat(79)} AND MORE`)).toBe('M'.repeat(79))
  })

  it('ends the merchant at the first full stop that closes a word, when no warning follows the sentence', () => {
    const merchantOf = (text: string) => parse(text)?.merchant

    expect(merchantOf(transaction({ merchant: 'SAMPLE EATERY' }))).toBe('SAMPLE EATERY')
    expect(merchantOf(`${transaction({ merchant: 'SHOP.EXAMPLE SG' })}\n\nThank you for banking with us.`)).toBe(
      'SHOP.EXAMPLE SG',
    )
    // Without the warning to go by, a full stop that closes a word of the name is taken for the sentence's.
    expect(merchantOf(transaction())).toBe('SAMPLE EATERY PTE')
  })

  it('keeps a transaction whose merchant it cannot tell, with no merchant', () => {
    const unclosed = transaction({ merchant: 'SAMPLE EATERY' }).slice(0, -1)

    expect(parse(unclosed)).toEqual({ ...PURCHASE, merchant: null, parser: 'uob' })
    expect(parse(`${unclosed} ${WARNING}`)?.merchant).toBeNull()
    expect(parse(alertBody(transaction({ merchant: '' })))?.merchant).toBeNull()
  })

  it.each([
    ['in its first second', '2026-10-09T00:00:00+08:00'],
    ['in its last second', '2026-10-09T23:59:59+08:00'],
    ['when it is still the day before by UTC', '2026-10-08T16:00:00Z'],
  ])('takes the time the email came for the time of the purchase, on the day that the alert states: %s', (_, at) => {
    const receivedAt = seconds(at)

    expect(parseAlert(uobEmail(alertBody(), receivedAt))?.occurredAt).toBe(receivedAt)
  })

  it.each([
    ['the day after', '2026-10-10T00:00:00+08:00'],
    ['the day before', '2026-10-08T23:59:59+08:00'],
    ['at the end of the second day after', '2026-10-11T23:59:59+08:00'],
    ['at the start of the second day before', '2026-10-07T00:00:00+08:00'],
    ['the day after, though it is still the same day by UTC', '2026-10-09T16:00:00Z'],
  ])('takes noon in Singapore on the day that the alert states, when the email came %s', (_, at) => {
    expect(parseAlert(uobEmail(alertBody(), seconds(at)))?.occurredAt).toBe(NOON)
  })

  it.each([
    ['on the third day after', '2026-10-12T00:00:00+08:00'],
    ['on the third day before', '2026-10-06T23:59:59+08:00'],
    ['a week later', '2026-10-16T15:20:00+08:00'],
    ['a year later', '2027-10-09T15:20:00+08:00'],
  ])('dates the purchase by the email when that came more than two days from the stated day: %s', (_, at) => {
    expect(parseAlert(uobEmail(alertBody(), seconds(at)))?.occurredAt).toBe(seconds(at))
  })

  it.each([
    ['a far-off year', '09/10/99'],
    ['the year before', '09/10/25'],
    ['the month after', '09/11/26'],
  ])('stores no purchase on a day of %s that an alert states, and dates it by the email', (_, date) => {
    expect(parse(alertBody(transaction({ date })))).toEqual({ ...PURCHASE, occurredAt: RECEIVED, parser: 'uob' })
  })

  it.each([
    ['03/04/27', '2027-04-03T12:00:00+08:00'],
    ['01/01/27', '2027-01-01T12:00:00+08:00'],
    ['29/02/28', '2028-02-29T12:00:00+08:00'],
  ])('reads %s with the day first, as a day in Singapore', (date, noon) => {
    // The email came the morning after, so noon stands in for the time of the purchase.
    const receivedAt = seconds(noon) + 20 * 3600

    expect(parseAlert(uobEmail(alertBody(transaction({ date })), receivedAt))?.occurredAt).toBe(seconds(noon))
  })

  it.each([
    ['a day that its month does not have', '31/02/26'],
    ['a leap day in a year that has none', '29/02/27'],
    ['day 0', '00/10/26'],
    ['month 13', '09/13/26'],
    ['month 0', '09/00/26'],
  ])('dates the purchase by the email when the alert states %s', (_, date) => {
    const receivedAt = seconds('2026-11-20T08:00:00+08:00')

    expect(parseAlert(uobEmail(alertBody(transaction({ date })), receivedAt))).toEqual({
      ...PURCHASE,
      occurredAt: receivedAt,
      parser: 'uob',
    })
  })

  it.each([
    ['a notice of a statement', `Your UOB Card ending 4321 has a new statement, dated 09/10/26. ${WARNING}`],
    ['a notice of a login', 'You logged in to online banking on 09/10/26 at 20:01. If unauthorised, call us.'],
    ['marketing', 'Dine with your UOB Card on 09/10/26 at SAMPLE EATERY PTE. LT. and save SGD 45.60 or more.'],
    ['a transaction that was declined', alertBody(transaction().replace('was made', 'was declined'))],
    ['a refund to the card', alertBody(transaction().replace('made with', 'made to'))],
    ["another bank's card", alertBody(transaction().replace('UOB', 'Example Bank'))],
    ['a card described in more than 40 characters', alertBody(transaction({ card: `${'Very '.repeat(8)}Long Card` }))],
    ['a malformed thousands separator', alertBody(transaction({ amount: 'SGD 1,23.45' }))],
    ['three decimals', alertBody(transaction({ amount: 'SGD 1.234' }))],
    ['a lower-case currency', alertBody(transaction({ amount: 'sgd 45.60' }))],
    ['a currency of four letters', alertBody(transaction({ amount: 'SGDX 45.60' }))],
    ['no amount', alertBody(transaction({ amount: 'SGD' }))],
    ['a card ending with three digits', alertBody(transaction({ last4: '432' }))],
    ['a card ending with five digits', alertBody(transaction({ last4: '43210' }))],
    ['a date written another way', alertBody(transaction({ date: '9 October 2026' }))],
    ['a date with a year of four digits', alertBody(transaction({ date: '09/10/2026' }))],
    ['only the warning and the disclaimer', alertBody('')],
    ['no text', ''],
  ])('returns null for %s', (_, text) => {
    expect(parse(text)).toBeNull()
  })

  it('only reads alerts from the address that the bank sends them from', () => {
    const from = (address: string) => parseAlert({ ...uobEmail(), from: address })

    expect(from('unialerts@uobgroup.com')?.parser).toBe('uob')
    expect(from(' UniAlerts@UOBGroup.com ')?.parser).toBe('uob')
    expect(from('unialerts@uobgroup.com.attacker.test')).toBeNull()
    expect(from('offers@uobgroup.com')).toBeNull()
    expect(from('alerts@otherbank.test')).toBeNull()
    // In the mail of another bank the sentence is for that bank's parser to read, and it makes nothing of it.
    expect(from('alerts@examplebank.test')).toBeNull()
    expect(from('noreply@notify.ocbc.com')).toBeNull()
  })

  it('sends its alerts from one address', () => {
    expect(uob.senders).toEqual(['unialerts@uobgroup.com'])
  })

  it('returns quickly on very long hostile strings', () => {
    // A sentence that matches up to the last word before the merchant is the most work one attempt can cost.
    const nearMiss = transaction({ amount: 'SGD 999,999,999,999.99' }).split(' at SAMPLE')[0]
    // Each string is some 200,000 characters: more than is ever decoded of an email's body.
    const hostile = [
      `${nearMiss}\n`.repeat(2_000),
      `${nearMiss} `.repeat(2_000),
      'SGD 1 was made with your UOB '.repeat(7_000),
      `SGD 1 was made with your UOB ${'ending '.repeat(30_000)}`,
      'SGD 1 was made with your UOB Card ending 4321 on '.repeat(4_000),
      `SGD ${'999,'.repeat(50_000)}`,
      'SGD '.repeat(50_000),
      'SGD'.repeat(70_000),
      '1,'.repeat(100_000),
      'a '.repeat(100_000),
      '\n'.repeat(200_000),
      ' \xa0\t'.repeat(70_000),
    ]
    // After a sentence that does match, the merchant is looked for in all that follows it.
    const unclosed = transaction().slice(0, -1)
    const afterSentence = [
      `${unclosed}${'.x'.repeat(100_000)}`,
      `${unclosed}${' x'.repeat(100_000)}`,
      `${unclosed}${'. '.repeat(100_000)}If unauthorised`,
      `${unclosed}${' If unauthorised'.repeat(12_000)}`,
    ]

    const started = performance.now()
    for (const text of hostile) {
      expect(parse(text)).toBeNull()
      // The parser on its own, without the cap on length that parseAlert applies.
      expect(uob.parse(uobEmail(text))).toBeNull()
    }
    for (const text of afterSentence) {
      expect(parse(text)).toMatchObject({ amountMinor: 4560 })
      expect(uob.parse(uobEmail(text))).toMatchObject({ amountMinor: 4560 })
    }

    // Measured at about 45 ms. Heavy backtracking over text of this length would take far longer.
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('is stored as a purchase when its alert is ingested', async () => {
    const store = storeFor(env.DB, (await findOrCreateUser(env.DB, newTelegramId())).id)

    const result = await ingestAlert(store, uobEmail())

    expect(result).toMatchObject({ status: 'stored', transaction: { ...PURCHASE, parser: 'uob' } })
    expect(await store.listTransactions(null, 0, 4_000_000_000, 10)).toMatchObject([PURCHASE])
  })
})
