import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ingestAlert } from '../src/ingest'
import { findOrCreateUser, MANUAL, storeFor, type NewTransaction, type Store } from '../src/store'
import type { AlertEmail } from '../src/parsers/types'
import { alertEmail, alertText, newTelegramId, seconds, UOB_PAYMENT } from './helpers'
import { catchConsole } from './log-helpers'

const ANY_TIME = [0, 4_000_000_000] as const
const ZONE = 'Asia/Singapore'

async function newStore() {
  return storeFor(env.DB, (await findOrCreateUser(env.DB, newTelegramId())).id)
}

it('stores the purchase read from an alert, even before its card is registered', async () => {
  const store = await newStore()
  const receivedAt = seconds('2026-10-05T09:30:00+08:00')
  const email = alertEmail({ receivedAt, text: alertText('SGD 12.40', '1234', 'COFFEE PLACE') })

  const result = await ingestAlert(store, email, ZONE)

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
      scheduled: 0,
    },
    remembered: false,
    cleared: null,
  })
  expect(await store.listCards()).toEqual([])
  expect(await store.sumByCurrency('1234', ...ANY_TIME)).toEqual([{ currency: 'SGD', amountMinor: 1240, count: 1 }])
})

it('reports an alert it has already stored as a duplicate', async () => {
  const store = await newStore()
  const email = alertEmail({ sourceId: 'msg-7' })

  expect((await ingestAlert(store, email, ZONE)).status).toBe('stored')
  expect(await ingestAlert(store, email, ZONE)).toEqual({ status: 'duplicate' })

  expect(await store.sumByCurrency('1234', ...ANY_TIME)).toEqual([{ currency: 'SGD', amountMinor: 1240, count: 1 }])
})

it('stores the bill payment read from an alert, and reports the same email again as a duplicate', async () => {
  const store = await newStore()
  const receivedAt = seconds('2026-10-25T16:58:00+08:00')
  const email = alertEmail({ from: 'unialerts@uobgroup.com', receivedAt, text: UOB_PAYMENT })

  expect(await ingestAlert(store, email, ZONE)).toEqual({
    status: 'payment',
    payment: { cardLast4: '4321', amountMinor: 8820, currency: 'SGD' },
    card: undefined,
  })
  expect(await ingestAlert(store, email, ZONE)).toEqual({ status: 'duplicate' })

  expect(await store.paidSince(receivedAt)).toEqual(['4321'])
})

it('treats the same source id from two users as two purchases', async () => {
  const email = alertEmail({ sourceId: 'msg-7' })

  expect((await ingestAlert(await newStore(), email, ZONE)).status).toBe('stored')
  expect((await ingestAlert(await newStore(), email, ZONE)).status).toBe('stored')
})

it('reports an email no parser can read as unparsed, and stores nothing', async () => {
  const store = await newStore()

  expect(await ingestAlert(store, alertEmail({ from: 'news@shop.test' }), ZONE)).toEqual({ status: 'unparsed' })
  const notAlert = alertEmail({ text: 'Your statement is ready.' })
  expect(await ingestAlert(store, notAlert, ZONE)).toEqual({ status: 'unparsed' })

  expect(await store.sumByCurrency('1234', ...ANY_TIME)).toEqual([])
})

it('logs what came of each alert, with the parser of the bank that sent it', async () => {
  const store = await newStore()
  const logged = catchConsole()

  await ingestAlert(store, alertEmail({ sourceId: 'msg-7' }), ZONE)
  await ingestAlert(store, alertEmail({ sourceId: 'msg-7' }), ZONE)
  // An email that its bank's parser cannot read is named by that parser all the same.
  await ingestAlert(store, alertEmail({ sourceId: 'msg-8', text: 'Your statement is ready.' }), ZONE)
  await ingestAlert(store, alertEmail({ sourceId: 'msg-9', from: 'news@shop.test' }), ZONE)

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

  await ingestAlert(store, email, ZONE)
  await ingestAlert(store, email, ZONE)
  await ingestAlert(store, { ...email, sourceId: 'another-made-up-id', text: 'A notice for jane@example.test.' }, ZONE)

  expect(logged.events().map((event) => event.outcome)).toEqual(['stored', 'duplicate', 'unparsed'])
  const kept = ['made-up', 'Jane', 'jane@', 'examplebank.test', 'PRIVATE CLINIC', '4321', '98', 'SGD']
  for (const text of kept) expect(logged.text()).not.toContain(text)
})

describe('a scheduled entry and the alert of its charge', () => {
  /** A scheduled entry of SGD 10.00, on the card 1234, at noon on the 20th. */
  const ENTRY = {
    cardLast4: '1234',
    amountMinor: 1000,
    currency: 'SGD',
    merchant: 'SAMPLE SHOP',
    occurredAt: seconds('2026-10-20T12:00:00+08:00'),
    parser: MANUAL,
    scheduled: 1,
  }

  /** The alert of a matching charge, at another merchant, on the morning of that day. */
  const CHARGE = alertEmail({ receivedAt: seconds('2026-10-20T09:30:00+08:00'), text: alertText('SGD 10.00', '1234') })

  let entries = 0

  async function storedIn(store: Store, given: Partial<NewTransaction> = {}): Promise<number> {
    const id = await store.insertTransaction({ ...ENTRY, sourceId: `manual:${++entries}`, ...given })
    if (id === null) throw new Error('A test stored the same entry twice')
    return id
  }

  async function storeWithCards(): Promise<Store> {
    const store = await newStore()
    await store.addCard({ nickname: 'visa', last4: '1234', windowType: 'calendar' })
    await store.addCard({ nickname: 'evol', last4: '5678', windowType: 'calendar' })
    return store
  }

  it.each<[what: string, charge: Partial<AlertEmail>]>([
    ['of the same amount', {}],
    ['exactly 10% over it', { text: alertText('SGD 11.00', '1234') }],
    // 16:30 on the 19th by UTC, where the entry is on the 20th.
    ['in the first minutes of its day in the time zone', { receivedAt: seconds('2026-10-20T00:30:00+08:00') }],
  ])('is taken out by a charge %s, and the charge alone is counted', async (_, charge) => {
    const store = await storeWithCards()
    const id = await storedIn(store)

    const result = await ingestAlert(store, { ...CHARGE, ...charge }, ZONE)

    expect(result).toMatchObject({ status: 'stored', cleared: { id, amountMinor: 1000 } })
    expect(await store.findTransaction(id)).toBeNull()
    const [{ count }] = await store.sumByCurrency('1234', ...ANY_TIME)
    expect(count).toBe(1)
  })

  it.each<[what: string, charge: Partial<AlertEmail>, entry: Partial<NewTransaction>, owner?: 'another user']>([
    ['just over 10% away', { text: alertText('SGD 11.01', '1234') }, {}],
    ['on another card', { text: alertText('SGD 10.00', '5678') }, {}],
    ['in another currency', { text: alertText('USD 10.00', '1234') }, {}],
    ['the day after, in the same window', { receivedAt: seconds('2026-10-21T00:30:00+08:00') }, {}],
    ['the day before, in the same window', { receivedAt: seconds('2026-10-19T23:30:00+08:00') }, {}],
    ["for another user's entry", {}, {}, 'another user'],
    ['for an ordinary purchase by hand', {}, { scheduled: 0 }],
  ])('stays when the charge is %s', async (_, charge, entry, owner) => {
    const store = await storeWithCards()
    const holder = owner ? await storeWithCards() : store
    const id = await storedIn(holder, entry)

    const result = await ingestAlert(store, { ...CHARGE, ...charge }, ZONE)

    expect(result).toMatchObject({ status: 'stored', cleared: null })
    expect(await holder.findTransaction(id)).not.toBeNull()
  })

  it('is not taken out again once it is taken out', async () => {
    const store = await storeWithCards()
    await store.removeTransaction(await storedIn(store))

    expect(await ingestAlert(store, CHARGE, ZONE)).toMatchObject({ status: 'stored', cleared: null })
  })

  it('goes the closer of two to the charge, though the other came first', async () => {
    const store = await storeWithCards()
    const further = await storedIn(store, { amountMinor: 1050 })
    const closer = await storedIn(store, { amountMinor: 1010 })

    expect(await ingestAlert(store, CHARGE, ZONE)).toMatchObject({ cleared: { id: closer } })
    expect(await store.findTransaction(further)).not.toBeNull()
  })

  it('goes one at most for an alert that is delivered twice', async () => {
    const store = await storeWithCards()
    const ids = [await storedIn(store), await storedIn(store)]

    expect(await ingestAlert(store, CHARGE, ZONE)).toMatchObject({ cleared: { id: ids[0] } })
    expect(await ingestAlert(store, CHARGE, ZONE)).toEqual({ status: 'duplicate' })

    expect(await store.findTransaction(ids[1])).not.toBeNull()
  })
})
