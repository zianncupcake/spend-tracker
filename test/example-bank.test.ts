import { describe, expect, it, vi } from 'vitest'
import { parseAlert, parserOf } from '../src/parsers'
import { exampleBank } from './example-bank'
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

  it("is not shipped: the service looks for mail from the four real banks' senders and from no other", async () => {
    // Loaded anew, the parsers are as they ship: the tests' set-up, which adds this bank, has not touched the copy.
    vi.resetModules()
    const shipped = await import('../src/parsers')

    expect(shipped.alertSenders()).toEqual([
      'noreply@notify.ocbc.com',
      'unialerts@uobgroup.com',
      'hsbc.bank.singapore.limited@notification.hsbc.com.hk',
      'ibanking.alert@dbs.com',
    ])
  })

  it('only reads the first 20,000 characters', () => {
    const alert = alertText('SGD 12.40', '1234')

    expect(parse(`${'x'.repeat(19_000)}\n${alert}`)).not.toBeNull()
    expect(parse(`${'x'.repeat(20_000)}\n${alert}`)).toBeNull()
  })
})
