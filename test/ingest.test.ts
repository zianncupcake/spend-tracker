import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { ingestAlert } from '../src/ingest'
import { findOrCreateUser, storeFor } from '../src/store'
import { alertEmail, alertText, newTelegramId, seconds } from './helpers'

const ANY_TIME = [0, 4_000_000_000] as const

async function newStore() {
  return storeFor(env.DB, (await findOrCreateUser(env.DB, newTelegramId())).id)
}

it('stores the purchase read from an alert, even before its card is registered', async () => {
  const store = await newStore()
  const receivedAt = seconds('2026-10-05T09:30:00+08:00')
  const email = alertEmail({ receivedAt, text: alertText('SGD 12.40', '1234', 'COFFEE PLACE') })

  const result = await ingestAlert(store, email)

  expect(result).toEqual({
    status: 'stored',
    transaction: {
      id: expect.any(Number),
      cardLast4: '1234',
      amountMinor: 1240,
      currency: 'SGD',
      merchant: 'COFFEE PLACE',
      occurredAt: receivedAt,
      parser: 'example-bank',
      category: null,
    },
  })
  expect(await store.listCards()).toEqual([])
  expect(await store.sumByCurrency('1234', ...ANY_TIME)).toEqual([{ currency: 'SGD', amountMinor: 1240, count: 1 }])
})

it('reports an alert it has already stored as a duplicate', async () => {
  const store = await newStore()
  const email = alertEmail({ sourceId: 'msg-7' })

  expect((await ingestAlert(store, email)).status).toBe('stored')
  expect(await ingestAlert(store, email)).toEqual({ status: 'duplicate' })

  expect(await store.sumByCurrency('1234', ...ANY_TIME)).toEqual([{ currency: 'SGD', amountMinor: 1240, count: 1 }])
})

it('treats the same source id from two users as two purchases', async () => {
  const email = alertEmail({ sourceId: 'msg-7' })

  expect((await ingestAlert(await newStore(), email)).status).toBe('stored')
  expect((await ingestAlert(await newStore(), email)).status).toBe('stored')
})

it('reports an email no parser can read as unparsed, and stores nothing', async () => {
  const store = await newStore()

  expect(await ingestAlert(store, alertEmail({ from: 'news@shop.test' }))).toEqual({ status: 'unparsed' })
  expect(await ingestAlert(store, alertEmail({ text: 'Your statement is ready.' }))).toEqual({ status: 'unparsed' })

  expect(await store.sumByCurrency('1234', ...ANY_TIME)).toEqual([])
})
