import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  deleteUser,
  findOrCreateUser,
  findUser,
  MAX_CARDS,
  setTimezone,
  storeFor,
  telegramIdOf,
  type Card,
  type NewTransaction,
} from '../src/store'
import { newTelegramId, rowsOwnedBy } from './helpers'

const db = env.DB
const ANY_TIME = [0, 4_000_000_000] as const

/** What `purchase()` reads back as, but for the id it was stored under, its parser and its category. */
const STORED = {
  cardLast4: '1234',
  amountMinor: 1000,
  currency: 'SGD',
  merchant: 'COFFEE PLACE',
  occurredAt: 1_800_000_000,
}

async function newStore() {
  return storeFor(db, (await findOrCreateUser(db, newTelegramId())).id)
}

/** A new user's store, and in it a purchase as it is given. Returns the id of the purchase with the store. */
async function storeWith(overrides: Partial<NewTransaction> = {}) {
  const store = await newStore()
  const id = await store.insertTransaction(purchase(overrides))
  if (id === null) throw new Error('A test stored the same purchase twice')
  return { store, id }
}

function purchase(overrides: Partial<NewTransaction> = {}): NewTransaction {
  return {
    sourceId: 'msg-1',
    cardLast4: '1234',
    amountMinor: 1000,
    currency: 'SGD',
    merchant: 'COFFEE PLACE',
    occurredAt: 1_800_000_000,
    parser: 'example-bank',
    ...overrides,
  }
}

describe('users', () => {
  it('creates a user once and finds them afterwards', async () => {
    const telegramId = newTelegramId()

    const created = await findOrCreateUser(db, telegramId)
    const found = await findOrCreateUser(db, telegramId)

    expect(created.timezone).toBe('Asia/Singapore')
    expect(found).toEqual(created)
    expect((await findOrCreateUser(db, newTelegramId())).id).not.toBe(created.id)
  })

  it('creates one user when their first two requests arrive together', async () => {
    const telegramId = newTelegramId()

    const [first, second] = await Promise.all([findOrCreateUser(db, telegramId), findOrCreateUser(db, telegramId)])

    expect(second).toEqual(first)
  })

  it('finds a user by their Telegram id, and creates none for somebody who is not one', async () => {
    const [telegramId, strangerId] = [newTelegramId(), newTelegramId()]
    const user = await findOrCreateUser(db, telegramId)

    expect(await findUser(db, telegramId)).toEqual(user)
    expect(await findUser(db, strangerId)).toBeNull()
    expect(await findUser(db, strangerId)).toBeNull()
  })

  it("sets a user's time zone, and nobody else's", async () => {
    const [telegramId, otherTelegramId] = [newTelegramId(), newTelegramId()]
    const user = await findOrCreateUser(db, telegramId)
    const other = await findOrCreateUser(db, otherTelegramId)

    await setTimezone(db, user.id, 'Asia/Tokyo')

    expect(await findOrCreateUser(db, telegramId)).toEqual({ id: user.id, timezone: 'Asia/Tokyo' })
    expect(await findOrCreateUser(db, otherTelegramId)).toEqual({ id: other.id, timezone: 'Asia/Singapore' })
  })

  it('finds the Telegram id of a user, and none for a user who is gone', async () => {
    const telegramId = newTelegramId()
    const user = await findOrCreateUser(db, telegramId)

    expect(await telegramIdOf(db, user.id)).toBe(telegramId)

    await deleteUser(db, user.id)
    expect(await telegramIdOf(db, user.id)).toBeNull()
  })

  it('deletes a user with their cards and transactions, and nobody else', async () => {
    const leaving = await findOrCreateUser(db, newTelegramId())
    const staying = await findOrCreateUser(db, newTelegramId())
    for (const user of [leaving, staying]) {
      const store = storeFor(db, user.id)
      await store.addCard({ nickname: 'main', last4: '1234', windowType: 'calendar' })
      await store.insertTransaction(purchase())
    }

    await deleteUser(db, leaving.id)

    expect(await rowsOwnedBy(leaving.id)).toEqual({ users: 0, cards: 0, transactions: 0 })
    expect(await rowsOwnedBy(staying.id)).toEqual({ users: 1, cards: 1, transactions: 1 })
  })
})

describe('a store', () => {
  it('shows a user only their own cards, transactions and sums', async () => {
    const first = await newStore()
    const second = await newStore()
    // Both users call a card ending 1234 "main", and both have an alert with the source id msg-1.
    const firstCard: Card = { nickname: 'main', last4: '1234', windowType: 'calendar' }
    const secondCard: Card = { nickname: 'main', last4: '1234', windowType: 'statement', statementDay: 15 }

    expect(await first.addCard(firstCard)).toBe(true)
    expect(await second.addCard(secondCard)).toBe(true)
    expect(await first.insertTransaction(purchase({ sourceId: 'msg-1', amountMinor: 1000 }))).not.toBeNull()
    expect(await first.insertTransaction(purchase({ sourceId: 'msg-2', amountMinor: 250 }))).not.toBeNull()
    expect(await second.insertTransaction(purchase({ sourceId: 'msg-1', amountMinor: 7000 }))).not.toBeNull()

    expect(await first.listCards()).toEqual([firstCard])
    expect(await second.listCards()).toEqual([secondCard])
    expect(await first.sumByCurrency('1234', ...ANY_TIME)).toEqual([{ currency: 'SGD', amountMinor: 1250, count: 2 }])
    expect(await second.sumByCurrency('1234', ...ANY_TIME)).toEqual([{ currency: 'SGD', amountMinor: 7000, count: 1 }])

    // Removing a card by a nickname both users have removes only the caller's.
    expect(await first.removeCard('main')).toBe(true)
    expect(await first.listCards()).toEqual([])
    expect(await second.listCards()).toEqual([secondCard])
  })

  it('refuses a second card with the same nickname or the same last four digits', async () => {
    const store = await newStore()
    const card: Card = { nickname: 'main', last4: '1234', windowType: 'calendar' }
    await store.addCard(card)

    expect(await store.addCard({ ...card, last4: '5678' })).toBe(false)
    expect(await store.addCard({ ...card, nickname: 'other' })).toBe(false)

    expect(await store.listCards()).toEqual([card])
  })

  it('adds no card beyond the most that a user may have, not even for two that come together', async () => {
    const store = await newStore()
    const other = await newStore()
    const card = (number: number): Card => ({
      nickname: `card-${number}`,
      last4: String(number).padStart(4, '0'),
      windowType: 'calendar',
    })
    for (let number = 1; number <= MAX_CARDS; number++) expect(await store.addCard(card(number))).toBe(true)

    expect(MAX_CARDS).toBe(20)
    expect(await store.addCard(card(MAX_CARDS + 1))).toBe(false)
    expect(await store.listCards()).toHaveLength(MAX_CARDS)
    // The limit is each user's own.
    expect(await other.addCard(card(1))).toBe(true)

    // Removing a card makes room for one, and only for one.
    expect(await store.removeCard('card-1')).toBe(true)
    const together = await Promise.all([store.addCard(card(MAX_CARDS + 1)), store.addCard(card(MAX_CARDS + 2))])
    expect(together.filter((added) => added)).toHaveLength(1)
    expect(await store.listCards()).toHaveLength(MAX_CARDS)
  })

  it('lists cards in the order they were added, and says whether a removal found one', async () => {
    const store = await newStore()
    await store.addCard({ nickname: 'zebra', last4: '0002', windowType: 'calendar' })
    await store.addCard({ nickname: 'apple', last4: '0001', windowType: 'statement', statementDay: 31 })

    expect((await store.listCards()).map((card) => card.nickname)).toEqual(['zebra', 'apple'])
    expect(await store.removeCard('zebra')).toBe(true)
    expect(await store.removeCard('zebra')).toBe(false)
    expect((await store.listCards()).map((card) => card.nickname)).toEqual(['apple'])
  })

  it('inserts nothing for a source id the user already has', async () => {
    const store = await newStore()

    expect(await store.insertTransaction(purchase({ sourceId: 'msg-1', amountMinor: 1000 }))).not.toBeNull()
    expect(await store.insertTransaction(purchase({ sourceId: 'msg-1', amountMinor: 9999 }))).toBeNull()

    expect(await store.sumByCurrency('1234', ...ANY_TIME)).toEqual([{ currency: 'SGD', amountMinor: 1000, count: 1 }])
  })

  it('sums one card per currency from start up to, but not including, end', async () => {
    const store = await newStore()
    const rows: [sourceId: string, occurredAt: number, amountMinor: number, currency: string, cardLast4: string][] = [
      ['before', 999, 1, 'SGD', '1234'],
      ['at-start', 1000, 20, 'SGD', '1234'],
      ['inside', 1500, 300, 'SGD', '1234'],
      ['inside-usd', 1500, 4000, 'USD', '1234'],
      ['last-second', 1999, 50000, 'SGD', '1234'],
      ['at-end', 2000, 600000, 'SGD', '1234'],
      ['other-card', 1500, 7000000, 'SGD', '5678'],
    ]
    for (const [sourceId, occurredAt, amountMinor, currency, cardLast4] of rows) {
      await store.insertTransaction(purchase({ sourceId, occurredAt, amountMinor, currency, cardLast4 }))
    }

    expect(await store.sumByCurrency('1234', 1000, 2000)).toEqual([
      { currency: 'SGD', amountMinor: 50320, count: 3 },
      { currency: 'USD', amountMinor: 4000, count: 1 },
    ])
    expect(await store.sumByCurrency('0000', 1000, 2000)).toEqual([])
  })

  it('stores a transaction without a merchant', async () => {
    const store = await newStore()

    expect(await store.insertTransaction(purchase({ merchant: null }))).not.toBeNull()
  })

  it('lists purchases from start up to, but not including, end: newest first, on one card or on all', async () => {
    const store = await newStore()
    const other = await newStore()
    // Every purchase has an amount of its own, to tell them apart by.
    const rows: [amountMinor: number, occurredAt: number, cardLast4: string, merchant: string | null][] = [
      [1, 999, '1234', 'COFFEE PLACE'],
      [2, 1000, '1234', 'COFFEE PLACE'],
      [3, 1500, '5678', null],
      [4, 1500, '1234', 'BOOK SHOP'],
      [5, 1999, '1234', 'COFFEE PLACE'],
      [6, 2000, '1234', 'COFFEE PLACE'],
    ]
    for (const [amountMinor, occurredAt, cardLast4, merchant] of rows) {
      const sourceId = `msg-${amountMinor}`
      await store.insertTransaction(purchase({ sourceId, amountMinor, occurredAt, cardLast4, merchant }))
    }
    await other.insertTransaction(purchase({ sourceId: 'msg-1', amountMinor: 7, occurredAt: 1500 }))
    const amounts = (listed: { amountMinor: number }[]) => listed.map((each) => each.amountMinor)

    // Of two purchases in the same second, the one stored later comes first.
    expect(await store.listTransactions(null, 1000, 2000, 10)).toMatchObject([
      { cardLast4: '1234', amountMinor: 5, currency: 'SGD', merchant: 'COFFEE PLACE', occurredAt: 1999 },
      { cardLast4: '1234', amountMinor: 4, currency: 'SGD', merchant: 'BOOK SHOP', occurredAt: 1500 },
      { cardLast4: '5678', amountMinor: 3, currency: 'SGD', merchant: null, occurredAt: 1500 },
      { cardLast4: '1234', amountMinor: 2, currency: 'SGD', merchant: 'COFFEE PLACE', occurredAt: 1000 },
    ])
    expect(amounts(await store.listTransactions('1234', 1000, 2000, 10))).toEqual([5, 4, 2])
    expect(amounts(await store.listTransactions('5678', ...ANY_TIME, 10))).toEqual([3])
    expect(amounts(await store.listTransactions('0000', ...ANY_TIME, 10))).toEqual([])
    expect(amounts(await store.listTransactions(null, ...ANY_TIME, 10))).toEqual([6, 5, 4, 3, 2, 1])
    // What another user has is not listed, whatever is asked for.
    expect(amounts(await other.listTransactions(null, ...ANY_TIME, 10))).toEqual([7])
    expect(amounts(await other.listTransactions('1234', ...ANY_TIME, 10))).toEqual([7])
  })

  it('lists no more purchases than the limit, and those are the newest', async () => {
    const store = await newStore()
    for (const occurredAt of [1000, 3000, 2000, 4000]) {
      await store.insertTransaction(purchase({ sourceId: `msg-${occurredAt}`, occurredAt }))
    }
    const times = (listed: { occurredAt: number }[]) => listed.map((each) => each.occurredAt)

    expect(times(await store.listTransactions(null, ...ANY_TIME, 3))).toEqual([4000, 3000, 2000])
    expect(times(await store.listTransactions('1234', ...ANY_TIME, 1))).toEqual([4000])
    expect(times(await store.listTransactions(null, ...ANY_TIME, 10))).toEqual([4000, 3000, 2000, 1000])
  })

  it('lists a purchase with the id it was stored under, its parser and its category', async () => {
    const store = await newStore()

    const sorted = await store.insertTransaction(purchase({ sourceId: 'msg-1', occurredAt: 1000, category: 'online' }))
    const unsorted = await store.insertTransaction(purchase({ sourceId: 'msg-2', occurredAt: 2000, parser: 'manual' }))

    expect(sorted).not.toBe(unsorted)
    expect(await store.listTransactions(null, ...ANY_TIME, 10)).toEqual([
      { ...STORED, id: unsorted, occurredAt: 2000, parser: 'manual', category: null },
      { ...STORED, id: sorted, occurredAt: 1000, parser: 'example-bank', category: 'online' },
    ])
  })
})

describe('a card and its product', () => {
  it('is stored with the product it is linked to, and is linked to another or to none', async () => {
    const store = await newStore()
    const other = await newStore()
    const linked: Card = { nickname: 'main', last4: '1234', windowType: 'calendar', product: 'uob-evol' }
    const plain: Card = { nickname: 'spare', last4: '9999', windowType: 'statement', statementDay: 5 }
    await store.addCard(linked)
    await store.addCard(plain)
    // Another user calls a card of theirs the same.
    await other.addCard({ nickname: 'spare', last4: '9999', windowType: 'calendar' })

    expect(await store.listCards()).toEqual([linked, plain])

    expect(await store.setProduct('spare', 'uob-evol')).toBe(true)
    expect(await store.setProduct('main', null)).toBe(true)
    expect(await store.setProduct('missing', 'uob-evol')).toBe(false)

    expect(await store.listCards()).toEqual([
      { nickname: 'main', last4: '1234', windowType: 'calendar' },
      { ...plain, product: 'uob-evol' },
    ])
    expect(await other.listCards()).toEqual([{ nickname: 'spare', last4: '9999', windowType: 'calendar' }])
  })
})

describe('the purchases of a store', () => {
  it('are summed per currency and category for one card, from start up to, but not including, end', async () => {
    const store = await newStore()
    const other = await newStore()
    const rows: [amountMinor: number, currency: string, category: string | null, at?: number, last4?: string][] = [
      [100, 'SGD', 'online'],
      [20, 'SGD', 'online'],
      [3, 'SGD', 'mobile'],
      [4000, 'SGD', null],
      [50000, 'USD', 'fx'],
      [600000, 'USD', null],
      [7000000, 'SGD', 'online', 999],
      [7000000, 'SGD', 'online', 2000],
      [7000000, 'SGD', 'online', 1500, '5678'],
    ]
    for (const [index, [amountMinor, currency, category, occurredAt = 1500, cardLast4 = '1234']] of rows.entries()) {
      const sourceId = `msg-${index}`
      await store.insertTransaction(purchase({ sourceId, amountMinor, currency, category, occurredAt, cardLast4 }))
    }
    await other.insertTransaction(purchase({ amountMinor: 7000000, occurredAt: 1500, category: 'online' }))

    // In each currency, those that are not sorted come first.
    expect(await store.sumByCategory('1234', 1000, 2000)).toEqual([
      { currency: 'SGD', category: null, amountMinor: 4000, count: 1 },
      { currency: 'SGD', category: 'mobile', amountMinor: 3, count: 1 },
      { currency: 'SGD', category: 'online', amountMinor: 120, count: 2 },
      { currency: 'USD', category: null, amountMinor: 600000, count: 1 },
      { currency: 'USD', category: 'fx', amountMinor: 50000, count: 1 },
    ])
    expect(await store.sumByCategory('0000', 1000, 2000)).toEqual([])
  })

  it('are found by their ids, each by its own user only', async () => {
    const { store, id } = await storeWith({ category: 'mobile' })
    const { store: other, id: theirs } = await storeWith({ amountMinor: 7 })

    expect(await store.findTransaction(id)).toEqual({ ...STORED, id, parser: 'example-bank', category: 'mobile' })
    expect(await store.findTransaction(theirs)).toBeNull()
    expect(await other.findTransaction(id)).toBeNull()
    expect(await store.findTransaction(999_999_999)).toBeNull()
  })

  it('are looked through for the earliest that is not sorted, on one card and in a stretch of time', async () => {
    const store = await newStore()
    const other = await newStore()
    const rows: [sourceId: string, occurredAt: number, category: string | null, cardLast4?: string][] = [
      ['before', 999, null],
      ['sorted', 1000, 'online'],
      ['later', 1800, null],
      ['earlier', 1500, null],
      ['same-second', 1500, null],
      ['other-card', 1200, null, '5678'],
      ['at-end', 2000, null],
    ]
    const ids: Record<string, number | null> = {}
    for (const [sourceId, occurredAt, category, cardLast4 = '1234'] of rows) {
      ids[sourceId] = await store.insertTransaction(purchase({ sourceId, occurredAt, category, cardLast4 }))
    }
    await other.insertTransaction(purchase({ occurredAt: 1100 }))

    // Of two in the same second, the one that was stored first.
    expect(await store.oldestUnsorted('1234', 1000, 2000)).toMatchObject({ id: ids.earlier, occurredAt: 1500 })
    expect(await store.oldestUnsorted('5678', 1000, 2000)).toMatchObject({ id: ids['other-card'] })
    expect(await store.oldestUnsorted('1234', 1600, 1800)).toBeNull()
    expect(await store.oldestUnsorted('0000', ...ANY_TIME)).toBeNull()
  })

  it('are sorted one at a time: once into a category, and by their own user only', async () => {
    const { store, id } = await storeWith()
    const { store: other, id: theirs } = await storeWith()

    expect(await store.setCategory(id, 'online')).toBe(true)
    // It is there already. So of two requests that sort it the same way, the second changes nothing.
    expect(await store.setCategory(id, 'online')).toBe(false)
    expect(await store.setCategory(id, 'mobile')).toBe(true)
    expect(await store.setCategory(theirs, 'online')).toBe(false)
    expect(await store.setCategory(999_999_999, 'online')).toBe(false)

    expect(await store.findTransaction(id)).toMatchObject({ category: 'mobile' })
    expect(await other.findTransaction(theirs)).toMatchObject({ category: null })
  })

  it("are sorted several at once: those of them that are not sorted yet, and are their user's own", async () => {
    const { store, id: first } = await storeWith({ sourceId: 'msg-1' })
    const { store: other, id: theirs } = await storeWith()
    const second = (await store.insertTransaction(purchase({ sourceId: 'msg-2' }))) ?? 0
    const sorted = (await store.insertTransaction(purchase({ sourceId: 'msg-3', category: 'online' }))) ?? 0
    const left = (await store.insertTransaction(purchase({ sourceId: 'msg-4' }))) ?? 0
    const removed = (await store.insertTransaction(purchase({ sourceId: 'msg-5' }))) ?? 0
    await store.removeTransaction(removed)

    await store.sortUnsorted([first, second, sorted, theirs, removed, 999_999_999], 'fx')
    await store.sortUnsorted([], 'selected')

    const listed = await store.listTransactions(null, ...ANY_TIME, 10)
    expect(Object.fromEntries(listed.map((each) => [each.id, each.category]))).toEqual({
      [first]: 'fx',
      [second]: 'fx',
      [sorted]: 'online',
      [left]: null,
    })
    expect(await other.findTransaction(theirs)).toMatchObject({ category: null })
  })

  it('are sorted several at once, however many more than a statement takes bound values', async () => {
    const store = await newStore()
    const ids: number[] = []
    for (let index = 0; index < 150; index++) {
      ids.push((await store.insertTransaction(purchase({ sourceId: `msg-${index}` }))) ?? 0)
    }

    await store.sortUnsorted(ids, 'selected')

    expect(await store.sumByCategory('1234', ...ANY_TIME)).toEqual([
      { currency: 'SGD', category: 'selected', amountMinor: 150 * 1000, count: 150 },
    ])
  })

  it('are taken out without being deleted, and are then in no sum and no list, and under no id', async () => {
    const { store, id: kept } = await storeWith({ sourceId: 'msg-1', amountMinor: 250 })
    const { store: other, id: theirs } = await storeWith({ sourceId: 'msg-2' })
    const removed = (await store.insertTransaction(purchase({ sourceId: 'msg-2', category: 'online' }))) ?? 0

    // What was taken out comes back as it was.
    expect(await store.removeTransaction(removed)).toEqual({
      ...STORED,
      id: removed,
      parser: 'example-bank',
      category: 'online',
    })
    expect(await store.removeTransaction(removed)).toBeNull()
    expect(await store.removeTransaction(theirs)).toBeNull()
    expect(await store.removeTransaction(999_999_999)).toBeNull()

    expect(await store.sumByCurrency('1234', ...ANY_TIME)).toEqual([{ currency: 'SGD', amountMinor: 250, count: 1 }])
    expect(await store.sumByCategory('1234', ...ANY_TIME)).toEqual([
      { currency: 'SGD', category: null, amountMinor: 250, count: 1 },
    ])
    expect((await store.listTransactions(null, ...ANY_TIME, 10)).map((each) => each.id)).toEqual([kept])
    expect(await store.findTransaction(removed)).toBeNull()
    expect(await store.oldestUnsorted('1234', ...ANY_TIME)).toMatchObject({ id: kept })
    expect(await store.setCategory(removed, 'mobile')).toBe(false)
    // The row is still there, so the alert that it was read from is not stored a second time.
    expect(await store.insertTransaction(purchase({ sourceId: 'msg-2' }))).toBeNull()
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE id = ?').bind(removed).first('n')
    expect(rows).toBe(1)
    expect(await other.findTransaction(theirs)).not.toBeNull()
  })
})

describe('what a user chose for a merchant', () => {
  it('is kept for each product, in place of what they chose before, and for their own purchases only', async () => {
    const store = await newStore()
    const other = await newStore()

    expect(await store.rememberedCategory('uob-evol', 'COFFEE PLACE')).toBeNull()

    await store.rememberCategory('uob-evol', 'COFFEE PLACE', 'online')
    await store.rememberCategory('uob-evol', 'COFFEE PLACE', 'mobile')
    await store.rememberCategory('uob-evol', 'BOOK SHOP', 'other')
    await store.rememberCategory('made-up-card', 'COFFEE PLACE', 'dining')
    await other.rememberCategory('uob-evol', 'COFFEE PLACE', 'excluded')

    expect(await store.rememberedCategory('uob-evol', 'COFFEE PLACE')).toBe('mobile')
    expect(await store.rememberedCategory('uob-evol', 'BOOK SHOP')).toBe('other')
    expect(await store.rememberedCategory('made-up-card', 'COFFEE PLACE')).toBe('dining')
    expect(await store.rememberedCategory('made-up-card', 'BOOK SHOP')).toBeNull()
    expect(await other.rememberedCategory('uob-evol', 'COFFEE PLACE')).toBe('excluded')
    expect(await other.rememberedCategory('uob-evol', 'BOOK SHOP')).toBeNull()
  })

  it('goes by the text of the merchant in any case, and by all of the text', async () => {
    const store = await newStore()
    await store.rememberCategory('uob-evol', 'Coffee Place', 'online')

    expect(await store.rememberedCategory('uob-evol', 'COFFEE PLACE')).toBe('online')
    expect(await store.rememberedCategory('uob-evol', 'coffee place')).toBe('online')
    expect(await store.rememberedCategory('uob-evol', 'COFFEE')).toBeNull()
    expect(await store.rememberedCategory('uob-evol', 'COFFEE PLACE 2')).toBeNull()
    expect(await store.rememberedCategory('uob-evol', 'COFFEE%')).toBeNull()

    // A choice for the same merchant in another case takes the place of the first.
    await store.rememberCategory('uob-evol', 'COFFEE PLACE', 'mobile')
    expect(await store.rememberedCategory('uob-evol', 'Coffee Place')).toBe('mobile')
  })

  it("is deleted with its user, and nobody else's is", async () => {
    const leaving = await findOrCreateUser(db, newTelegramId())
    const staying = await findOrCreateUser(db, newTelegramId())
    for (const user of [leaving, staying]) {
      await storeFor(db, user.id).rememberCategory('uob-evol', 'COFFEE PLACE', 'online')
    }

    await deleteUser(db, leaving.id)

    const { results } = await db
      .prepare('SELECT owner_id FROM merchant_categories WHERE owner_id IN (?, ?)')
      .bind(leaving.id, staying.id)
      .all()
    expect(results).toEqual([{ owner_id: staying.id }])
  })
})
