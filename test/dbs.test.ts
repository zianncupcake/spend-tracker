import { describe, expect, it } from 'vitest'
import { parseAlert } from '../src/parsers'
import { alertEmail, seconds } from './helpers'

/** When the email of the alert came: two minutes after the purchase, at 20:01 on 9 October 2026 in Singapore. */
const RECEIVED = seconds('2026-10-09T20:03:00+08:00')

/** A DBS card alert as it reads: the lines of the purchase among the bank's words. The values are made up. */
function alertBody(parts: { when?: string; amount?: string; from?: string } = {}): string {
  const { when = '09 OCT 20:01', amount = 'SGD12.40', from = 'DBS/POSB card ending 4321' } = parts
  return [
    'Card Transaction Alert',
    'Transaction Ref: EX0000000000000000000001',
    'Dear Sir / Madam,',
    'We refer to your card transaction request dated 09/10/26. ' +
      'We are pleased to confirm that the transaction was completed.',
    `Date & Time: ${when} (SGT)\nAmount: ${amount}\nFrom: ${from}\nTo: SAMPLE SHOP SINGAPORE SGP`,
    'If unauthorised, please login to DBS digibank mobile to report fraud dispute immediately.',
  ].join('\n\n')
}

const parse = (text: string, receivedAt = RECEIVED) =>
  parseAlert(alertEmail({ from: 'ibanking.alert@dbs.com', receivedAt, text }))

describe('DBS card alerts', () => {
  it('reads a card transaction alert', () => {
    expect(parse(alertBody())).toEqual({
      cardLast4: '4321',
      amountMinor: 1240,
      currency: 'SGD',
      merchant: 'SAMPLE SHOP SINGAPORE SGP',
      occurredAt: seconds('2026-10-09T20:01:00+08:00'),
      parser: 'dbs',
    })
  })

  it('puts a purchase of 31 December, in an email of 2 January, in the year before', () => {
    // Years far from today's, so that the year can only have come from the email.
    const email = seconds('2041-01-02T09:00:00+08:00')

    expect(parse(alertBody({ when: '31 DEC 23:50' }), email)?.occurredAt).toBe(seconds('2040-12-31T23:50:00+08:00'))
  })

  it.each([
    ['SGD1,234.50', 'SGD', 123450],
    ['USD 9.99', 'USD', 999],
  ])('reads %s as %s and %i hundredths', (amount, currency, amountMinor) => {
    expect(parse(alertBody({ amount }))).toMatchObject({ currency, amountMinor })
  })

  it.each([
    ['a transfer from an account', alertBody({ from: 'My Account A/C ending 4321' })],
    ['a day that does not exist', alertBody({ when: '31 FEB 20:01' })],
  ])('returns null for %s', (_, text) => {
    expect(parse(text)).toBeNull()
  })
})
