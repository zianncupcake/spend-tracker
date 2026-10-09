import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { cardTotals } from '../src/domain/totals'
import { findOrCreateUser, storeFor, type Card } from '../src/store'
import { newTelegramId, seconds } from './helpers'

it('totals each card over its own window, per currency', async () => {
  const store = storeFor(env.DB, (await findOrCreateUser(env.DB, newTelegramId())).id)
  const visa: Card = { nickname: 'visa', last4: '1234', windowType: 'statement', statementDay: 15 }
  const amex: Card = { nickname: 'amex', last4: '0005', windowType: 'calendar' }
  const unused: Card = { nickname: 'unused', last4: '9999', windowType: 'calendar' }

  // On 9 October the visa window is 16 September to 16 October and the calendar window is October.
  const now = new Date('2026-10-09T12:00:00+08:00')
  const purchases: [at: string, amountMinor: number, currency: string, cardLast4: string][] = [
    ['2026-09-15T23:59:59+08:00', 1, 'SGD', '1234'], // the last second of the previous cycle
    ['2026-09-16T00:00:00+08:00', 20, 'SGD', '1234'], // the first second of this one
    ['2026-10-09T08:00:00+08:00', 300, 'SGD', '1234'],
    ['2026-10-09T08:00:00+08:00', 4000, 'USD', '1234'],
    ['2026-10-15T23:59:59+08:00', 50000, 'SGD', '1234'], // the close day still counts
    ['2026-10-16T00:00:00+08:00', 600000, 'SGD', '1234'], // the next cycle
    ['2026-09-30T23:59:59+08:00', 7, 'SGD', '0005'], // September
    ['2026-10-01T00:00:00+08:00', 80, 'SGD', '0005'],
  ]
  for (const [index, [at, amountMinor, currency, cardLast4]] of purchases.entries()) {
    await store.insertTransaction({
      sourceId: `msg-${index}`,
      cardLast4,
      amountMinor,
      currency,
      merchant: null,
      occurredAt: seconds(at),
      parser: 'example-bank',
    })
  }

  expect(await cardTotals(store, [visa, amex, unused], now, 'Asia/Singapore')).toEqual([
    {
      card: visa,
      window: { start: new Date('2026-09-16T00:00:00+08:00'), end: new Date('2026-10-16T00:00:00+08:00') },
      totals: [
        { currency: 'SGD', amountMinor: 50320 },
        { currency: 'USD', amountMinor: 4000 },
      ],
      count: 4,
    },
    {
      card: amex,
      window: { start: new Date('2026-10-01T00:00:00+08:00'), end: new Date('2026-11-01T00:00:00+08:00') },
      totals: [{ currency: 'SGD', amountMinor: 80 }],
      count: 1,
    },
    {
      card: unused,
      window: { start: new Date('2026-10-01T00:00:00+08:00'), end: new Date('2026-11-01T00:00:00+08:00') },
      totals: [],
      count: 0,
    },
  ])
})
