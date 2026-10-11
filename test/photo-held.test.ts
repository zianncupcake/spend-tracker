import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { TelegramError } from '../src/telegram/api'
import type { Reading } from '../src/telegram/handler'
import { answered, clock, deps, NOW, openChat } from './connect-helpers'
import { bold, buy, headerRow, plain, purchaseRow, seconds, sumRow, tableOf, userCount } from './helpers'
import { catchConsole } from './log-helpers'
import {
  bought,
  BY_HAND,
  chatWithCard,
  chatWithCards,
  heldFor,
  labels,
  markedIn,
  MESSAGE,
  ONLINE,
  read,
  reading,
  REFUSED,
  rowsOf,
  unsure,
} from './photo-helpers'

// Purchases of a photo that are held: the ones that the bot asks about before it adds them, because the model was
// not sure of them or because the bot could not tell which card they were made with. And the buttons under them,
// which add them or skip them. test/photo.test.ts has what is added at once, test/photo-outcomes.test.ts what comes
// of a photo besides, and ./photo-helpers what the three share.

describe('purchases that the model was not sure of', () => {
  /** A user with a card, and a photo of four purchases on it, of two of which the model was not sure. */
  async function halfSure(given: Partial<Reading> = { card: 'evol', category: 'other' }) {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    reading(
      read(
        [
          bought(210, 'BUS/MRT 4471'),
          unsure(300, 'TEA HOUSE'),
          bought(1240, 'COFFEE PLACE'),
          unsure(990, null, { occurredAt: seconds('2026-10-06T00:00:00+08:00') }),
        ],
        given,
      ),
    )
    const { rich, texts } = await chat.photo('evol, bus and mrt', MESSAGE)
    return { chat, userId, rich, texts }
  }

  it('are held while the others are added at once, and are shown with the buttons that add them or skip them', async () => {
    const { userId, rich, texts } = await halfSure()

    // The two that are clear are stored, and told of in the table.
    const rows = await rowsOf(userId)
    expect(rows).toMatchObject([
      { source_id: 'manual:7001:0', merchant: 'BUS/MRT 4471', category: 'other' },
      { source_id: 'manual:7001:2', merchant: 'COFFEE PLACE', category: 'other' },
    ])
    expect(rich?.blocks).toEqual([
      bold('Added to evol ••••5678 as Other Spend:'),
      tableOf(
        headerRow('SGD'),
        purchaseRow(`${rows[0].id}*`, '5 Oct', '2.10', 'BUS/MRT 4471'),
        purchaseRow(`${rows[1].id}*`, '5 Oct', '12.40', 'COFFEE PLACE'),
        sumRow('Total', '14.50'),
      ),
      BY_HAND,
      plain('evol ••••5678: SGD 14.50 in 2 purchases, resets 1 Nov'),
    ])
    // The two that are not are in a message of their own, which says where they would go.
    const [asking, ...more] = texts
    expect(more).toEqual([])
    expect(asking.text).toBe(
      [
        'Not sure about these 2 purchases. Check the amount and the date of each before you add them to ' +
          'evol ••••5678 as Other Spend:',
        '5 Oct · SGD 3.00 · TEA HOUSE',
        '6 Oct · SGD 9.90',
      ].join('\n'),
    )
    expect(markedIn(asking)).toEqual(['TEA HOUSE'])
    expect(asking.buttons).toEqual([
      [{ text: 'Add these 2', data: 'held:7001:add' }],
      [{ text: 'Skip', data: 'held:7001:skip' }],
    ])
    // They are held with their places in the photo, for the card and the category that the caption named.
    expect(await heldFor(userId)).toMatchObject([
      {
        message_id: MESSAGE,
        card_last4: '5678',
        category: 'other',
        purchases: [
          { place: 1, amountMinor: 300, merchant: 'TEA HOUSE', unsure: true },
          { place: 3, amountMinor: 990, merchant: null, unsure: true },
        ],
      },
    ])
  })

  it('are added when the button that adds them is pressed, and the message then says so, with their ids', async () => {
    const { chat, userId, texts } = await halfSure()
    const [asking] = texts
    const logged = catchConsole()

    const pressed = await chat.press(asking, 'Add these 2')

    expect(pressed).toEqual({ answer: 'Added 2 purchases.', sent: [] })
    // They are stored under their own places in the photo, after the two that were stored at once.
    const rows = await rowsOf(userId)
    expect(rows.map((row) => row.source_id)).toEqual([
      'manual:7001:0',
      'manual:7001:2',
      'manual:7001:1',
      'manual:7001:3',
    ])
    expect(rows.slice(2)).toMatchObject([
      { card_last4: '5678', amount_minor: 300, merchant: 'TEA HOUSE', parser: 'manual', category: 'other' },
      { card_last4: '5678', amount_minor: 990, merchant: null, parser: 'manual', category: 'other' },
    ])
    expect(asking.text).toBe(
      [
        'Added to evol ••••5678 as Other Spend:',
        `ID ${rows[2].id} · 5 Oct · SGD 3.00 · TEA HOUSE · by hand`,
        `ID ${rows[3].id} · 6 Oct · SGD 9.90 · by hand`,
      ].join('\n'),
    )
    expect(markedIn(asking)).toEqual(['TEA HOUSE'])
    // The buttons are gone, and so is the batch.
    expect(asking.buttons).toBeUndefined()
    expect(await heldFor(userId)).toEqual([])
    expect(await chat.lines('/spend')).toContain('evol | SGD 27.40 | 4 | 29 Sep to 29 Oct | 1 Nov')
    // The log has the press as an update that was replied to, and what came of it: whose it was, and the counts.
    expect(logged.events().slice(0, 2)).toEqual([
      { event: 'held_press', user: userId, outcome: 'added', held: 2, stored: 2 },
      { event: 'update', kind: 'press', outcome: 'replied', ms: 0 },
    ])
  })

  it('are skipped when the button that skips them is pressed: nothing is stored, and the message says so', async () => {
    const { chat, userId, texts } = await halfSure()
    const [asking] = texts
    const logged = catchConsole()

    const pressed = await chat.press(asking, 'Skip')

    expect(pressed).toEqual({ answer: 'Skipped.', sent: [] })
    expect(asking.text).toBe(
      ['Skipped. These 2 purchases were not added:', '5 Oct · SGD 3.00 · TEA HOUSE', '6 Oct · SGD 9.90'].join('\n'),
    )
    expect(markedIn(asking)).toEqual(['TEA HOUSE'])
    expect(asking.buttons).toBeUndefined()
    // The two that were stored at once are all that there is, and the batch is gone.
    expect((await rowsOf(userId)).map((row) => row.merchant)).toEqual(['BUS/MRT 4471', 'COFFEE PLACE'])
    expect(await heldFor(userId)).toEqual([])
    expect(logged.events()).toEqual([
      { event: 'held_press', user: userId, outcome: 'skipped', held: 2, stored: 0 },
      { event: 'update', kind: 'press', outcome: 'replied', ms: 0 },
    ])
  })

  it('start where /add would start them when they are added, with no category named: a line for each category', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([unsure(1598, 'NETFLIX.COM'), unsure(1240, 'COFFEE PLACE')]))
    const { rich, texts } = await chat.photo()
    // Nothing was clear, so nothing was added, and the message names the card alone.
    expect(rich).toBeUndefined()
    expect(texts[0].text.split('\n')[0]).toBe(
      'Not sure about these 2 purchases. Check the amount and the date of each before you add them to evol ••••5678:',
    )

    await chat.press(texts[0], 'Add these 2')

    const rows = await rowsOf(userId)
    expect(rows.map((row) => row.category)).toEqual(['selected', null])
    expect(texts[0].text).toBe(
      [
        `Added to evol ••••5678 as ${ONLINE}:`,
        `ID ${rows[1].id} · 5 Oct · SGD 12.40 · COFFEE PLACE · by hand`,
        'Added to evol ••••5678 as Selected Gym, Telco and Streaming Spend:',
        `ID ${rows[0].id} · 5 Oct · SGD 15.98 · NETFLIX.COM · by hand`,
      ].join('\n'),
    )
  })

  it('are asked about one at a time in the words for one', async () => {
    const chat = await chatWithCard()
    reading(read([unsure(300, 'TEA HOUSE')]))
    const first = (await chat.photo()).texts[0]
    const second = (await chat.photo()).texts[0]

    expect(first.text).toBe(
      'Not sure about this purchase. Check its amount and its date before you add it to evol ••••5678:\n' +
        '5 Oct · SGD 3.00 · TEA HOUSE',
    )
    expect(labels(first)).toEqual(['Add this one', 'Skip'])

    expect((await chat.press(first, 'Add this one')).answer).toBe('Added 1 purchase.')
    expect((await chat.press(second, 'Skip')).answer).toBe('Skipped.')
    expect(second.text).toBe('Skipped. This purchase was not added:\n5 Oct · SGD 3.00 · TEA HOUSE')
  })

  it('have a name marked as code wherever it is shown as text, so that Telegram makes nothing to tap of it', async () => {
    const chat = await chatWithCard()
    const hostile = '𝒳 /start https://attacker.test @someone'
    reading(read([unsure(300, hostile)]))

    const [asking] = (await chat.photo()).texts
    expect(markedIn(asking)).toEqual([hostile])

    await chat.press(asking, 'Add this one')
    expect(markedIn(asking)).toEqual([hostile])
    expect(asking.text).toContain(`SGD 3.00 · ${hostile} · by hand`)
  })
})

describe('a card that is chosen by button', () => {
  /** A user with two cards, and a photo that names neither. A rule of one card's product places one purchase of it. */
  async function asked() {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE'), unsure(1598, 'NETFLIX.COM')]))
    const [asking] = (await chat.photo(undefined, MESSAGE)).texts
    return { chat, userId, asking }
  }

  it('is the card that the purchases are added to, each where /add would start it on that card', async () => {
    const { chat, userId, asking } = await asked()
    const logged = catchConsole()

    const pressed = await chat.press(asking, 'Add to evol')

    expect(pressed).toEqual({ answer: 'Added 2 purchases.', sent: [] })
    const rows = await rowsOf(userId)
    expect(rows).toMatchObject([
      { source_id: 'manual:7001:0', card_last4: '5678', merchant: 'COFFEE PLACE', category: null },
      { source_id: 'manual:7001:1', card_last4: '5678', merchant: 'NETFLIX.COM', category: 'selected' },
    ])
    expect(asking.text).toBe(
      [
        `Added to evol ••••5678 as ${ONLINE}:`,
        `ID ${rows[0].id} · 5 Oct · SGD 12.40 · COFFEE PLACE · by hand`,
        'Added to evol ••••5678 as Selected Gym, Telco and Streaming Spend:',
        `ID ${rows[1].id} · 5 Oct · SGD 15.98 · NETFLIX.COM · by hand`,
      ].join('\n'),
    )
    expect(asking.buttons).toBeUndefined()
    expect(await heldFor(userId)).toEqual([])
    expect(logged.events('held_press')).toEqual([
      { event: 'held_press', user: userId, outcome: 'added', held: 2, stored: 2 },
    ])
  })

  it('can be the card with no product, on which nothing is sorted', async () => {
    const { chat, userId, asking } = await asked()

    await chat.press(asking, 'Add to visa')

    const rows = await rowsOf(userId)
    expect(rows).toMatchObject([
      { card_last4: '1234', category: null },
      { card_last4: '1234', category: null },
    ])
    expect(asking.text).toBe(
      [
        'Added to visa ••••1234:',
        `ID ${rows[0].id} · 5 Oct · SGD 12.40 · COFFEE PLACE · by hand`,
        `ID ${rows[1].id} · 5 Oct · SGD 15.98 · NETFLIX.COM · by hand`,
      ].join('\n'),
    )
  })

  it('can be passed over: the button that skips adds the purchases to no card', async () => {
    const { chat, userId, asking } = await asked()

    expect(await chat.press(asking, 'Skip')).toEqual({ answer: 'Skipped.', sent: [] })

    expect(asking.text).toBe(
      'Skipped. These 2 purchases were not added:\n5 Oct · SGD 12.40 · COFFEE PLACE\n5 Oct · SGD 15.98 · NETFLIX.COM',
    )
    expect(await rowsOf(userId)).toEqual([])
    expect(await heldFor(userId)).toEqual([])
  })
})

describe('a press of a button under purchases that are held', () => {
  /** A user with one card, and the message that asks them about the two purchases of a photo. */
  async function asked() {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([unsure(300, 'TEA HOUSE'), unsure(990, 'PRIVATE CLINIC')]))
    const [asking] = (await chat.photo(undefined, MESSAGE)).texts
    return { chat, userId, asking }
  }

  it('by somebody else adds nothing and skips nothing: it is answered with that the button no longer works', async () => {
    const { userId, asking } = await asked()
    const before = { ...asking }
    // Somebody who has a card of the same name, who presses what the owner's buttons hold in a chat of their own.
    const other = await chatWithCard()
    const stranger = openChat()
    const logged = catchConsole()

    for (const data of ['held:7001:add', 'held:7001:skip', 'held:7001:5678']) {
      expect(await other.pressWith(asking, data)).toEqual({ answer: REFUSED, sent: [] })
      expect(await stranger.pressWith(asking, data)).toEqual({ answer: REFUSED, sent: [] })
    }

    expect(await rowsOf(userId)).toEqual([])
    expect(await rowsOf(await other.userId())).toEqual([])
    // The owner's purchases are still held, and their message is as it was.
    expect(await heldFor(userId)).toHaveLength(1)
    expect(asking).toEqual(before)
    // Nothing is stored about somebody who only pressed. The log has a line for each press of a user, and none for
    // one of somebody who is no user.
    expect(await userCount(stranger.telegramId)).toBe(0)
    const refused = { event: 'held_press', user: await other.userId(), outcome: 'refused', held: 0, stored: 0 }
    expect(logged.events('held_press')).toEqual([refused, refused, refused])
  })

  it('a second time adds nothing twice: the purchases are held no longer, and the button no longer works', async () => {
    const { chat, userId, asking } = await asked()
    // The message as it stood when both presses were made: Telegram tells of each with the buttons as they were.
    const asItStood = { ...asking }
    const logged = catchConsole()

    const once = await chat.press(asItStood, 'Add these 2')
    const twice = await chat.press(asItStood, 'Add these 2')
    const skipped = await chat.press(asItStood, 'Skip')

    expect(once).toEqual({ answer: 'Added 2 purchases.', sent: [] })
    expect([twice, skipped]).toEqual([
      { answer: REFUSED, sent: [] },
      { answer: REFUSED, sent: [] },
    ])
    expect(await rowsOf(userId)).toHaveLength(2)
    expect(asking.text).toMatch(/^Added to evol ••••5678 as /)
    expect(logged.events('held_press').map((event) => [event.outcome, event.stored])).toEqual([
      ['added', 2],
      ['refused', 0],
      ['refused', 0],
    ])
  })

  it('adds nothing twice when two presses come together, as when Telegram delivers one again at once', async () => {
    const { chat, userId, asking } = await asked()
    const asItStood = { ...asking }

    const both = await Promise.all([chat.press(asItStood, 'Add these 2'), chat.press(asItStood, 'Add these 2')])

    // Each found the purchases held, and the store took each purchase once: both say what was added.
    expect(both.map((pressed) => pressed.answer)).toEqual(['Added 2 purchases.', 'Added 2 purchases.'])
    const rows = await rowsOf(userId)
    expect(rows.map((row) => row.source_id)).toEqual(['manual:7001:0', 'manual:7001:1'])
    expect(asking.text).toBe(
      [
        `Added to evol ••••5678 as ${ONLINE}:`,
        `ID ${rows[0].id} · 5 Oct · SGD 3.00 · TEA HOUSE · by hand`,
        `ID ${rows[1].id} · 5 Oct · SGD 9.90 · PRIVATE CLINIC · by hand`,
      ].join('\n'),
    )
    expect(await heldFor(userId)).toEqual([])
  })

  it('adds nothing after a press that skipped them', async () => {
    const { chat, userId, asking } = await asked()
    const asItStood = { ...asking }

    await chat.press(asItStood, 'Skip')

    expect(await chat.press(asItStood, 'Add these 2')).toEqual({ answer: REFUSED, sent: [] })
    expect(await rowsOf(userId)).toEqual([])
    expect(asking.text).toMatch(/^Skipped\. /)
  })

  it('adds nothing once the purchases have been held for a day: they are too old to be acted on', async () => {
    const { chat, userId, asking } = await asked()
    const before = { ...asking }

    expect(await heldFor(userId)).toMatchObject([{ expires_at: NOW.getTime() / 1000 + 24 * 3600 }])
    clock.now = new Date(NOW.getTime() + 24 * 3600 * 1000)

    expect(await chat.press(asking, 'Add these 2')).toEqual({ answer: REFUSED, sent: [] })
    expect(await chat.press(asking, 'Skip')).toEqual({ answer: REFUSED, sent: [] })

    expect(await rowsOf(userId)).toEqual([])
    expect(asking).toEqual(before)
    // The batch is deleted by the scheduled run, and by nothing here: see test/checker.test.ts.
    expect(await heldFor(userId)).toHaveLength(1)
  })

  it('is acted on until the day is up', async () => {
    const { chat, userId, asking } = await asked()
    clock.now = new Date(NOW.getTime() + 24 * 3600 * 1000 - 1000)

    expect((await chat.press(asking, 'Add these 2')).answer).toBe('Added 2 purchases.')

    expect(await rowsOf(userId)).toHaveLength(2)
  })

  it.each<[what: string, data: string]>([
    ['a card, under purchases that are held for a card already', 'held:7001:5678'],
    ['a card that is none of the user’s', 'held:7001:4321'],
    ['the id of another message', 'held:7002:add'],
    ['nothing after the id', 'held:7001:'],
    ['what no button holds', 'held:7001:add:5678'],
    ['a choice that there is not', 'held:7001:remove'],
    ['the id of a message that is no number', 'held:evol:add'],
  ])('changes nothing when it brings %s', async (_, data) => {
    const { chat, userId, asking } = await asked()
    const before = { ...asking }

    expect(await chat.pressWith(asking, data)).toEqual({ answer: REFUSED, sent: [] })

    expect(await rowsOf(userId)).toEqual([])
    expect(await heldFor(userId)).toHaveLength(1)
    expect(asking).toEqual(before)
  })

  it('changes nothing when it brings no card for purchases that are held for none, or a card that was removed since', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    reading(read([bought(300, 'TEA HOUSE')]))
    const [asking] = (await chat.photo(undefined, MESSAGE)).texts

    // What the button under purchases that are held for a card holds.
    expect(await chat.pressWith(asking, 'held:7001:add')).toEqual({ answer: REFUSED, sent: [] })
    await chat.say('/removecard evol')
    expect(await chat.press(asking, 'Add to evol')).toEqual({ answer: REFUSED, sent: [] })

    expect(await rowsOf(userId)).toEqual([])
    // The purchases are still held, and the card that is left can still be chosen.
    expect((await chat.press(asking, 'Add to visa')).answer).toBe('Added 1 purchase.')
    expect(await rowsOf(userId)).toMatchObject([{ card_last4: '1234' }])
  })

  it('adds nothing when the card that the purchases are held for has been removed', async () => {
    const { chat, userId, asking } = await asked()
    await chat.say('/removecard evol')

    expect(await chat.press(asking, 'Add these 2')).toEqual({ answer: REFUSED, sent: [] })

    expect(await rowsOf(userId)).toEqual([])
  })

  it('brings the message up to date when Telegram failed the edit of its first, and adds nothing twice', async () => {
    const { chat, userId, asking } = await asked()
    // The purchases are stored, the press is answered, and then Telegram does not take the edit of the message.
    vi.spyOn(deps.messenger, 'edit').mockRejectedValueOnce(new TelegramError('editMessageText', 400))
    const logged = catchConsole()

    const failed = await chat.press(asking, 'Add these 2')

    expect(failed).toEqual({ answer: 'Added 2 purchases.', sent: [] })
    expect(answered).toHaveLength(1)
    expect(await rowsOf(userId)).toHaveLength(2)
    // The message still asks, with its buttons, so the purchases are held for it still.
    expect(labels(asking)).toEqual(['Add these 2', 'Skip'])
    expect(await heldFor(userId)).toHaveLength(1)
    const failure = { error: 'Error', reason: 'http_error', status: 400 }
    expect(logged.events()).toEqual([
      { event: 'held_press', user: userId, outcome: 'added', held: 2, stored: 2 },
      { event: 'update', kind: 'press', outcome: 'failed', handled: true, told: false, ms: 0, ...failure },
    ])

    // The same button is pressed again. Nothing is stored a second time, and the message says what was added.
    const again = await chat.press(asking, 'Add these 2')

    expect(again).toEqual({ answer: 'Added 2 purchases.', sent: [] })
    const rows = await rowsOf(userId)
    expect(rows).toHaveLength(2)
    expect(asking.text).toBe(
      [
        `Added to evol ••••5678 as ${ONLINE}:`,
        `ID ${rows[0].id} · 5 Oct · SGD 3.00 · TEA HOUSE · by hand`,
        `ID ${rows[1].id} · 5 Oct · SGD 9.90 · PRIVATE CLINIC · by hand`,
      ].join('\n'),
    )
    expect(asking.buttons).toBeUndefined()
    expect(await heldFor(userId)).toEqual([])
    expect(logged.events('held_press').at(-1)).toMatchObject({ outcome: 'added', held: 2, stored: 0 })
  })

  it('says what is stored, whichever button it is, when it comes after a press that added the purchases and whose edit failed', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    reading(read([bought(300, 'TEA HOUSE'), bought(990, 'BOOKSHOP')]))
    const [asking] = (await chat.photo(undefined, MESSAGE)).texts
    // The purchases are stored on evol, and Telegram does not take the edit: the three buttons stay.
    const edit = vi.spyOn(deps.messenger, 'edit').mockRejectedValueOnce(new TelegramError('editMessageText', 400))
    await chat.press(asking, 'Add to evol')
    expect(labels(asking)).toEqual(['Add to visa', 'Add to evol', 'Skip'])
    const logged = catchConsole()

    const other = await chat.press(asking, 'Add to visa')

    // Nothing goes to visa, and the lines are headed with the card that the purchases are on.
    expect(other).toEqual({ answer: 'Added 2 purchases.', sent: [] })
    const rows = await rowsOf(userId)
    expect(rows).toMatchObject([{ card_last4: '5678' }, { card_last4: '5678' }])
    expect(asking.text).toBe(
      [
        `Added to evol ••••5678 as ${ONLINE}:`,
        `ID ${rows[0].id} · 5 Oct · SGD 3.00 · TEA HOUSE · by hand`,
        `ID ${rows[1].id} · 5 Oct · SGD 9.90 · BOOKSHOP · by hand`,
      ].join('\n'),
    )
    expect(asking.buttons).toBeUndefined()
    expect(await heldFor(userId)).toEqual([])
    expect(logged.events('held_press')).toEqual([
      { event: 'held_press', user: userId, outcome: 'added', held: 2, stored: 0 },
    ])

    // And "Skip" after such a press skips nothing: the message says that the purchase was added, as it was.
    reading(read([bought(520, 'LUNCH')]))
    const [second] = (await chat.photo(undefined, 7002)).texts
    edit.mockRejectedValueOnce(new TelegramError('editMessageText', 400))
    await chat.press(second, 'Add to visa')

    expect(await chat.press(second, 'Skip')).toEqual({ answer: 'Added 1 purchase.', sent: [] })
    expect(second.text).toMatch(/^Added to visa ••••1234:\nID \d+ · 5 Oct · SGD 5\.20 · LUNCH · by hand$/)
    expect(await rowsOf(userId)).toHaveLength(3)
  })

  it('is answered with that something went wrong when the purchases cannot be stored, and can then be made again', async () => {
    const { chat, userId, asking } = await asked()
    const prepare = env.DB.prepare.bind(env.DB)
    const failing = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('INSERT INTO transactions')) throw new Error('a made-up failure that quotes: PRIVATE CLINIC')
      return prepare(query)
    })
    const logged = catchConsole()

    const pressed = await chat.press(asking, 'Add these 2')
    failing.mockRestore()

    expect(pressed).toEqual({ answer: 'Something went wrong. Please try again in a moment.', sent: [] })
    expect(await rowsOf(userId)).toEqual([])
    expect(labels(asking)).toEqual(['Add these 2', 'Skip'])
    // The log has that the press failed before what it asked for was done, and nothing of the purchases.
    expect(logged.events()).toEqual([
      { event: 'update', kind: 'press', outcome: 'failed', handled: false, told: true, ms: 0, error: 'Error' },
    ])
    for (const text of ['PRIVATE', 'CLINIC', 'held:', '7001']) expect(logged.text()).not.toContain(text)

    expect((await chat.press(asking, 'Add these 2')).answer).toBe('Added 2 purchases.')
    expect(await rowsOf(userId)).toHaveLength(2)
  })

  it('takes seven queries and two requests to Telegram at its most: when it adds purchases, of which the limit leaves some out', async () => {
    const { chat, userId, asking } = await asked()
    for (let added = 1; added <= 99; added++) await buy(userId, { parser: 'manual', cardLast4: '0005' })
    const queried = vi.spyOn(env.DB, 'prepare')
    const [answer, edit, send] = [
      vi.spyOn(deps.messenger, 'answer'),
      vi.spyOn(deps.messenger, 'edit'),
      vi.spyOn(deps.messenger, 'send'),
    ]

    await chat.press(asking, 'Add these 2')

    // The user, the purchases that are held, the look for those of them that are stored already, the cards, the
    // storing, which of them the limit left out, and the letting go of what was held.
    expect(queried).toHaveBeenCalledTimes(7)
    queried.mockRestore()
    // Each of these is one request: see the messenger's own test, in webhook.test.ts.
    expect([answer, edit, send].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 0])
    expect(await rowsOf(userId)).toHaveLength(100)
  })

  it('takes four queries when it skips them', async () => {
    const { chat, asking } = await asked()
    const queried = vi.spyOn(env.DB, 'prepare')

    await chat.press(asking, 'Skip')

    // The user, the purchases that are held, the look for those of them that are stored already, and the letting
    // go of them.
    expect(queried).toHaveBeenCalledTimes(4)
  })
})

describe('/delete confirm', () => {
  it('deletes the purchases that are held for a user with everything else of theirs, and nobody else’s', async () => {
    const [chat, bystander] = [await chatWithCard(), await chatWithCard()]
    const [userId, otherId] = [await chat.userId(), await bystander.userId()]
    reading(read([bought(1240, 'COFFEE PLACE'), unsure(300, 'TEA HOUSE')]))
    const [asking] = (await chat.photo(undefined, MESSAGE)).texts
    await bystander.photo(undefined, MESSAGE)
    expect([await heldFor(userId), await heldFor(otherId)].map((held) => held.length)).toEqual([1, 1])

    expect(await chat.say('/delete confirm')).toContain('has been deleted')

    expect(await heldFor(userId)).toEqual([])
    expect(await rowsOf(userId)).toEqual([])
    expect(await heldFor(otherId)).toHaveLength(1)
    // The button that was under them adds nothing for whoever starts again from the same chat.
    expect(await chat.press(asking, 'Add this one')).toEqual({ answer: REFUSED, sent: [] })
    await chat.say('/addcard evol 5678 calendar uob-evol')
    expect(await chat.press(asking, 'Add this one')).toEqual({ answer: REFUSED, sent: [] })
    expect(await rowsOf(await chat.userId())).toEqual([])
  })
})

