import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { ingestAlert } from '../src/ingest'
import { findOrCreateUser, storeFor } from '../src/store'
import { alertEmail, alertText, newTelegramId, seconds } from './helpers'
import { catchConsole } from './log-helpers'

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

it('logs what came of each alert, with the parser of the bank that sent it', async () => {
  const store = await newStore()
  const logged = catchConsole()

  await ingestAlert(store, alertEmail({ sourceId: 'msg-7' }))
  await ingestAlert(store, alertEmail({ sourceId: 'msg-7' }))
  // An email that its bank's parser cannot read is named by that parser all the same.
  await ingestAlert(store, alertEmail({ sourceId: 'msg-8', text: 'Your statement is ready.' }))
  await ingestAlert(store, alertEmail({ sourceId: 'msg-9', from: 'news@shop.test' }))

  expect(logged.events()).toEqual([
    { event: 'alert', outcome: 'stored', parser: 'example-bank' },
    { event: 'alert', outcome: 'duplicate', parser: 'example-bank' },
    { event: 'alert', outcome: 'unparsed', parser: 'example-bank' },
    { event: 'alert', outcome: 'unparsed', parser: null },
  ])
})

it('logs nothing else of an alert: not its sender or its text, nor the purchase in it', async () => {
  const logged = catchConsole()
  const store = await newStore()
  const email = alertEmail({
    sourceId: 'made-up-message-id',
    text: `Dear Jane,\n${alertText('SGD 98.76', '4321', 'PRIVATE CLINIC')}`,
  })

  await ingestAlert(store, email)
  await ingestAlert(store, email)
  await ingestAlert(store, { ...email, sourceId: 'another-made-up-id', text: 'A notice for jane@example.test.' })

  expect(logged.events().map((event) => event.outcome)).toEqual(['stored', 'duplicate', 'unparsed'])
  const kept = ['made-up', 'Jane', 'jane@', 'examplebank.test', 'PRIVATE CLINIC', '4321', '98', 'SGD']
  for (const text of kept) expect(logged.text()).not.toContain(text)
})
