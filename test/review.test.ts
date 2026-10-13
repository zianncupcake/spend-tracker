import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { namedIn } from '../src/catalogue/merchants'
import { monthlyAmong, monthsBefore } from '../src/domain/review'
import { dayOf, startOfDay } from '../src/domain/window'
import worker from '../src/index'
import { reviewDueUser } from '../src/review'
import { storeFor, type NewTransaction } from '../src/store'
import { offerStoreFor } from '../src/store-review'
import { formatAmount, formatMoney } from '../src/telegram/format'
import { TO_COME } from '../src/telegram/purchases'
import { REVIEW } from '../src/telegram/texts'
import { clock, connectedChat, deps, openChat, outside, posted, sent } from './connect-helpers'
import { buy, seconds } from './helpers'
import { catchConsole } from './log-helpers'

// The monthly review: the months that it looks at, what looks monthly in them, and the run that makes it. The chats,
// the clock and the service are those of ./connect-helpers.

type Chat = ReturnType<typeof openChat>

const ZONE = 'Asia/Singapore'

/** A day of each of the two months that the review of November 2026 looks at, and one of November. */
const [SEP, OCT, NOV] = ['2026-09-10T12:00:00+08:00', '2026-10-10T12:00:00+08:00', '2026-11-10T12:00:00+08:00']

/** When the reviews of November and of December are due in Singapore. */
const [NOV_1, DEC_1] = ['2026-11-01T09:00:00+08:00', '2026-12-01T09:00:00+08:00']

/** What is recorded of SAMPLE GYM when it is offered for the card `evol`. */
const GYM = { cardLast4: '1234', letters: 'samplegym' }

/** A chat whose user has the card `evol`, linked to the UOB EVOL Card: in the time zone, or else in Singapore's. */
async function chatWithCard(timeZone?: string): Promise<Chat> {
  const chat = openChat()
  if (timeZone) await chat.say(`/timezone ${timeZone}`)
  await chat.say('/addcard evol 1234 calendar uob-evol')
  return chat
}

/** Such a chat, whose user a run has seen in October: their first review is due on 1 November. */
async function dueChat(timeZone?: string): Promise<Chat> {
  const chat = await chatWithCard(timeZone)
  await reviewDueUser(deps)
  return chat
}

/** Has the user spend at the merchant with that card in September and in October: SGD 5.00, and then `later`. */
async function buyMonthly(userId: number, merchant = 'SAMPLE GYM', later = 700): Promise<void> {
  await buy(userId, { at: SEP, merchant, amountMinor: 500 })
  await buy(userId, { at: OCT, merchant, amountMinor: later })
}

/** When the user's next review is due, in unix seconds. It reads the table directly. */
async function dueAt(chat: Chat): Promise<number | null> {
  return env.DB.prepare('SELECT review_at FROM users WHERE id = ?').bind(await chat.userId()).first<number>('review_at')
}

/** What a scheduled run does about reviews, at the time. */
async function runAt(time: string): Promise<void> {
  clock.now = new Date(time)
  await reviewDueUser(deps)
}

/** What the questions in the chat say that ask whether to save a pattern: the messages with buttons under them. */
function offersIn(chat: Chat): string[] {
  return posted.flatMap(({ chatId, buttons, text }) => (chatId === chat.telegramId && buttons ? [text] : []))
}

describe('the two months that a review looks at', () => {
  // Kiritimati is fourteen hours ahead of UTC, where 09:00 on the 1st is still the month before. Honolulu is ten
  // behind it.
  it.each([
    ['of January, east of UTC', 'Pacific/Kiritimati', '+14:00', ['2026-11', '2026-12', '2027-01']],
    ['in a zone west of UTC', 'Pacific/Honolulu', '-10:00', ['2026-09', '2026-10', '2026-11']],
  ])('are the two calendar months before, for the review %s', (_, timeZone, offset, months) => {
    const [start, later, end] = months.map((month) => seconds(`${month}-01T00:00:00${offset}`))

    expect(monthsBefore(new Date(`${months[2]}-01T09:00:00${offset}`), timeZone)).toEqual({ start, later, end })
  })
})

describe('what looks monthly among the purchases of two months', () => {
  /** Where the later of the two months begins, and a purchase in each: just before it, and at it. */
  const LATER = seconds('2026-10-01T00:00:00+08:00')
  const earlier = (merchant: string | null, amountMinor = 500) => ({ merchant, amountMinor, occurredAt: LATER - 1 })
  const later = (merchant: string | null, amountMinor = 500) => ({ merchant, amountMinor, occurredAt: LATER })

  it('is a merchant with a purchase in both, with what the later month’s come to', () => {
    // A pattern goes by the letters of a name, so two names with the same letters are one merchant.
    const purchases = [earlier('SAMPLEGYM'), later('SAMPLE GYM', 700), later('SAMPLE GYM', 200)]

    const monthly = { name: 'sample gym', letters: 'samplegym', text: 'SAMPLE GYM', amountMinor: 900 }
    expect(monthlyAmong(purchases, LATER)).toEqual([monthly])
  })

  it('is no merchant with a purchase in one of the months only, and no purchase with no merchant', () => {
    const purchases = [earlier('SAMPLE GYM'), later('SAMPLE SHOP'), earlier(null), later(null)]

    expect(monthlyAmong(purchases, LATER)).toEqual([])
  })

  it.each([
    ['SAMPLE TRANSIT 4471', 'sample transit'],
    ['SAMPLE 4471 HUB', 'sample'],
    ['SAMPLE REF7A2 X', 'sample'],
    ['7 SAMPLE', '7 sample'],
  ])('knows %s by a name that the text holds: %s', (merchant, name) => {
    const [monthly] = monthlyAmong([earlier(merchant), later(merchant)], LATER)

    expect(monthly.name).toBe(name)
    expect(namedIn(merchant)(monthly.letters)).toBe(true)
  })
})

describe('a review that is due', () => {
  it('asks about each offer after a first message, and the next purchase pays off what "Do it" saves', async () => {
    const chat = await dueChat()
    const userId = await chat.userId()
    // AB is too short a name for /pattern, so it is no offer.
    for (const merchant of ['SAMPLE GYM', 'SAMPLE TRANSIT 4471', 'AB']) await buyMonthly(userId, merchant)
    const toCome = async () => (await chat.lines('/spend evol')).filter((line) => line.startsWith(`${TO_COME} |`))

    await runAt(NOV_1)

    expect(sent).toHaveLength(3)
    expect(sent[0]).toEqual({ chatId: chat.telegramId, text: REVIEW })
    const [asking] = posted.filter(({ buttons, text }) => buttons && text.includes('sample transit'))
    await chat.press(asking, 'Do it')
    expect(await toCome()).toEqual([`${TO_COME} | ${formatAmount(700)}`])
    await buy(userId, { at: NOV_1, merchant: 'SAMPLE TRANSIT 9903', amountMinor: 700 })
    expect(await toCome()).toEqual([])
  })

  it('offers the same amount, whatever was bought three months back and in the present month', async () => {
    const chat = await dueChat()
    const userId = await chat.userId()
    await buyMonthly(userId)
    // The last evening of August, and the morning of the review. At the gym in both, and at a merchant in each
    // that a purchase there would make monthly.
    const [AUG, TODAY] = ['2026-08-31T23:00:00+08:00', '2026-11-01T08:00:00+08:00']
    for (const at of [AUG, TODAY]) await buy(userId, { at, merchant: 'SAMPLE GYM', amountMinor: 900 })
    for (const at of [AUG, OCT]) await buy(userId, { at, merchant: 'SAMPLE SHOP' })
    for (const at of [SEP, TODAY]) await buy(userId, { at, merchant: 'SAMPLE CAFE' })

    await runAt(NOV_1)

    expect(offersIn(chat)).toEqual([expect.stringContaining(formatMoney(700, 'SGD'))])
  })

  it.each<[string, Partial<NewTransaction>, ((userId: number) => Promise<unknown>)?]>([
    [
      'that a pattern with a shorter name counts already',
      {},
      (userId) =>
        storeFor(env.DB, userId).setPattern({ cardLast4: '1234', merchant: 'gym', amountMinor: 2000, skips: [] }),
    ],
    ['that was offered before', {}, (userId) => offerStoreFor(env.DB, userId).record([GYM])],
    // Of the UOB EVOL Card: its Other Spend has no cap, and its second group has one.
    ['whose purchases are in a group with no cap', { category: 'other' }],
    ['whose purchases are in a capped group other than the one that its name starts in', { category: 'selected' }],
    // Of the HSBC Revolution Credit Card: a rule places a travel agency, by its text, in the group with no cap.
    [
      'whose purchases are stored unsorted, where a rule places their text in a group with no cap',
      { cardLast4: '5678', merchant: 'SAMPLE STAY AGODA' },
    ],
    ['whose purchases are in another currency', { currency: 'USD' }],
    ['on a card with no product', { cardLast4: '9999' }],
  ])('offers nothing of a merchant %s', async (_, purchase, before) => {
    const chat = await dueChat()
    await chat.say('/addcard hsbc 5678 calendar hsbc-revolution')
    await chat.say('/addcard bare 9999 calendar')
    const userId = await chat.userId()
    for (const at of [SEP, OCT]) await buy(userId, { at, merchant: 'SAMPLE GYM', ...purchase })
    await before?.(userId)

    await runAt(NOV_1)

    expect(sent).toEqual([])
  })

  it('offers five at the most, the largest first, and the sixth the month after', async () => {
    const chat = await dueChat()
    const userId = await chat.userId()
    // Six merchants, each in three months. What a month comes to at each is in no order.
    for (const [shop, amountMinor] of [300, 600, 100, 500, 200, 400].entries()) {
      for (const at of [SEP, OCT, NOV]) await buy(userId, { at, merchant: `SHOP${shop} SAMPLE`, amountMinor })
    }
    const asked = (...amounts: number[]) => amounts.map((minor) => expect.stringContaining(formatMoney(minor, 'SGD')))

    await runAt(NOV_1)
    expect(offersIn(chat)).toEqual(asked(600, 500, 400, 300, 200))
    await runAt(DEC_1)

    expect(offersIn(chat).slice(5)).toEqual(asked(100))
  })

  it('offers two users with the same card and merchant their own amounts, the one due longest first', async () => {
    const [here, tokyo] = [await dueChat(), await dueChat('Asia/Tokyo')]
    await buyMonthly(await here.userId(), 'SAMPLE GYM', 700)
    await buyMonthly(await tokyo.userId(), 'SAMPLE GYM', 900)

    // The user who was added last has been due longest: 09:00 comes to Tokyo an hour before it comes to Singapore.
    await runAt(NOV_1)
    expect(sent.map(({ chatId }) => chatId)).toEqual([tokyo.telegramId, tokyo.telegramId])
    await runAt('2026-11-01T09:01:00+08:00')

    expect(offersIn(tokyo)).toEqual([expect.stringContaining(formatMoney(900, 'SGD'))])
    expect(offersIn(here)).toEqual([expect.stringContaining(formatMoney(700, 'SGD'))])
  })

  it('sends nothing to a user whom a run sees for the first time, who is due on the next 1st', async () => {
    const chat = await chatWithCard()
    await buyMonthly(await chat.userId())

    await runAt('2026-11-15T12:00:00+08:00')

    expect(sent).toEqual([])
    expect(await dueAt(chat)).toBe(seconds(DEC_1))
  })

  it('is put off a day for a user whose time zone the Worker does not know', async () => {
    const chat = await dueChat()
    const userId = await chat.userId()
    // Written to the table directly: /timezone takes no such name.
    await env.DB.prepare('UPDATE users SET timezone = ? WHERE id = ?').bind('Nowhere/Made_Up', userId).run()
    const logged = catchConsole()

    await runAt(NOV_1)

    expect(await dueAt(chat)).toBe(seconds('2026-11-02T09:00:00+08:00'))
    expect(logged.failures()).toMatchObject([{ event: 'review', outcome: 'failed' }])
  })

  it('is due at 09:00 on the 1st by the new time zone, once its user has changed theirs', async () => {
    const chat = await dueChat()
    await chat.say('/timezone Asia/Tokyo')

    await runAt('2026-10-09T12:01:00+08:00')

    expect(await dueAt(chat)).toBe(seconds('2026-11-01T09:00:00+09:00'))
  })

  it('sends one set of messages when two runs come at once', async () => {
    await buyMonthly(await (await dueChat()).userId())
    clock.now = new Date(NOV_1)

    await Promise.all([reviewDueUser(deps), reviewDueUser(deps)])

    expect(sent).toHaveLength(2)
  })

  it('forgets what it offered for a card when the card is removed', async () => {
    const chat = await chatWithCard()
    const offers = offerStoreFor(env.DB, await chat.userId())
    await offers.record([GYM])

    await chat.say('/removecard evol')

    expect(await offers.list()).toEqual([])
  })
})

describe('a scheduled run of the Worker', () => {
  it('checks the mail when a review cannot be sent, and the review makes its offers again when next due', async () => {
    const chat = await connectedChat('jane@example.test')
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const userId = await chat.userId()
    // The Worker goes by the real clock: a purchase in the middle of each of the two months before this one, and a
    // review that is made due a minute ago, in the table directly.
    const { year, month } = dayOf(new Date(), ZONE)
    for (const back of [2, 1]) {
      const occurredAt = startOfDay(year, month - back, 15, ZONE).getTime() / 1000
      await buy(userId, { occurredAt, merchant: 'SAMPLE GYM' })
    }
    const run = async () => {
      const dueSince = Math.floor(Date.now() / 1000) - 60
      await env.DB.prepare('UPDATE users SET review_at = ? WHERE id = ?').bind(dueSince, userId).run()
      const context = createExecutionContext()
      await worker.scheduled(createScheduledController({ cron: '* * * * *' }), env, context)
      await waitOnExecutionContext(context)
    }
    const logged = catchConsole()

    // Telegram takes no message for a chat that has blocked the bot.
    outside.blocked.add(chat.telegramId)
    await run()
    expect(outside.listings).toHaveLength(1)
    outside.blocked.delete(chat.telegramId)
    await run()

    expect(outside.telegrams.map((message) => message.text)).toEqual([REVIEW, expect.any(String)])
    expect(logged.events('review')).toMatchObject([{ outcome: 'blocked' }, { outcome: 'offered' }])
  })
})
