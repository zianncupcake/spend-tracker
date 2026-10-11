import { describe, expect, it } from 'vitest'
import { alertSenders, parseAlert, parserOf } from '../src/parsers'
import { exampleBank } from '../src/parsers/example-bank'
import { alertEmail, alertText } from './helpers'

const parse = (text: string) => parseAlert(alertEmail({ text }))

describe('Example Bank alerts', () => {
  it('reads a normal alert', () => {
    const email = alertEmail({
      receivedAt: 1_800_000_000,
      text: 'A transaction of SGD 12.40 was made with your Example Bank card ending 1234 at COFFEE PLACE.',
    })

    expect(parseAlert(email)).toEqual({
      cardLast4: '1234',
      amountMinor: 1240,
      currency: 'SGD',
      merchant: 'COFFEE PLACE',
      occurredAt: 1_800_000_000,
      parser: 'example-bank',
    })
  })

  it('finds the alert line among the others in an email', () => {
    const text = `Dear customer,\r\n\r\n${alertText('USD 8.00', '0005', 'BOOK SHOP')}\r\n\r\nThank you for banking with us.`

    expect(parse(text)).toMatchObject({
      cardLast4: '0005',
      amountMinor: 800,
      currency: 'USD',
      merchant: 'BOOK SHOP',
    })
  })

  it.each([
    ['SGD 1,234.56', 123456],
    ['SGD 1,234,567.89', 123456789],
    ['SGD 999,999,999,999.99', 99999999999999],
    ['SGD 1234.56', 123456],
    ['SGD 0.05', 5],
    ['SGD 7', 700],
    ['SGD 7.5', 750],
  ])('reads %s as %i hundredths', (amount, amountMinor) => {
    expect(parse(alertText(amount, '1234'))?.amountMinor).toBe(amountMinor)
  })

  it('keeps full stops that belong to the merchant name', () => {
    expect(parse(alertText('SGD 3.00', '1234', 'ST. EXAMPLE BAKERY CO.'))?.merchant).toBe('ST. EXAMPLE BAKERY CO.')
  })

  it.each([
    ['a malformed thousands separator', alertText('SGD 1,23.45', '1234')],
    ['three decimals', alertText('SGD 1.234', '1234')],
    ['a lower-case currency', alertText('sgd 12.40', '1234')],
    ['a card ending with three digits', alertText('SGD 12.40', '123')],
    ['a card ending with five digits', alertText('SGD 12.40', '12345')],
    ['no closing full stop', alertText('SGD 12.40', '1234').slice(0, -1)],
    ['text before the alert on its line', `Note: ${alertText('SGD 12.40', '1234')}`],
    ['unrelated text', 'Your statement is ready.'],
    ['no text', ''],
  ])('returns null for %s', (_, text) => {
    expect(parse(text)).toBeNull()
  })

  it('only reads alerts from the bank itself', () => {
    expect(parseAlert(alertEmail({ from: 'alerts@otherbank.test' }))).toBeNull()
    expect(parseAlert(alertEmail({ from: 'alerts@examplebank.test.attacker.test' }))).toBeNull()
    expect(parseAlert(alertEmail({ from: 'offers@examplebank.test' }))).toBeNull()
    expect(parseAlert(alertEmail({ from: 'Alerts@ExampleBank.test' }))).not.toBeNull()
  })

  it('is the bank whose parser an email from its address goes to, whether or not that parser can read it', () => {
    const unreadable = alertEmail({ from: ' Alerts@ExampleBank.test ', text: 'Your statement is ready.' })

    expect(parserOf(alertEmail())?.name).toBe('example-bank')
    expect(parserOf(unreadable)).toBe(exampleBank)
    expect(parserOf(alertEmail({ from: 'alerts@otherbank.test' }))).toBeUndefined()
    expect(parserOf(alertEmail({ from: 'offers@examplebank.test' }))).toBeUndefined()
  })

  it("sends its alerts from one address, and mail is looked for from the banks' senders and from no other", () => {
    expect(exampleBank.senders).toEqual(['alerts@examplebank.test'])
    expect(alertSenders()).toEqual([
      'alerts@examplebank.test',
      'noreply@notify.ocbc.com',
      'unialerts@uobgroup.com',
      'hsbc.bank.singapore.limited@notification.hsbc.com.hk',
    ])
  })

  it('only reads the first 20,000 characters', () => {
    const alert = alertText('SGD 12.40', '1234')

    expect(parse(`${'x'.repeat(19_000)}\n${alert}`)).not.toBeNull()
    expect(parse(`${'x'.repeat(20_000)}\n${alert}`)).toBeNull()
  })

  it('returns quickly on very long hostile strings', () => {
    // A line that matches everything but the closing full stop is the most work one attempt can cost.
    const nearMiss = `${alertText('SGD 999,999,999,999.99', '1234', 'x'.repeat(80)).slice(0, -1)}\n`
    const hostile = [
      nearMiss.repeat(20_000),
      nearMiss.replaceAll('\n', ' ').repeat(20_000),
      `A transaction of SGD ${'999,'.repeat(500_000)}`,
      'A transaction of '.repeat(100_000),
      '1,'.repeat(1_000_000),
      '\n'.repeat(2_000_000),
    ]

    const started = performance.now()
    for (const text of hostile) {
      expect(parse(text)).toBeNull()
      // The pattern on its own, without the cap on length that parseAlert applies.
      expect(exampleBank.parse(alertEmail({ text }))).toBeNull()
    }

    // Measured at about 20 ms. Heavy backtracking over megabytes would take far longer.
    expect(performance.now() - started).toBeLessThan(500)
  })
})
