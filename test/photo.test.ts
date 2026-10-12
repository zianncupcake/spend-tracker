import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import * as assistant from '../src/ai/assistant'
import type { ReadPurchase } from '../src/ai/photo'
import { DEFAULT_VISION_MODEL } from '../src/ai/provider'
import { findUser, storeFor } from '../src/store'
import { TelegramError } from '../src/telegram/api'
import { addRead, type Adding, type Reading } from '../src/telegram/adding'
import { BY_HAND_NOTE, UNSURE_NOTE } from '../src/telegram/purchases'
import { READ_ALREADY } from '../src/telegram/texts'
import { deps, NOW, openChat } from './connect-helpers'
import { bold, buy, headerRow, plain, purchaseRow, seconds, sumRow, tableOf } from './helpers'
import { catchConsole } from './log-helpers'
import {
  bought,
  BY_HAND,
  BYTES,
  chatWithCard,
  chatWithCards,
  file,
  heldFor,
  labels,
  lines,
  markedIn,
  MESSAGE,
  ONLINE,
  OTHER,
  photoLine,
  read,
  reader,
  reading,
  REFUSED,
  rowsOf,
  unsure,
  type Chat,
} from './photo-helpers'

// Purchases that are added from a photo: which card they are added to and how they are sorted, what their user is
// told of them, and what keeps them from being added twice or past the limit. test/photo-held.test.ts has the
// purchases that the bot asks about first, test/photo-outcomes.test.ts what comes of a photo besides, and
// ./photo-helpers what the three share: the stand-ins for the reading of a photo and for the fetching of its file.

describe('a photo with a caption that names the card', () => {
  const CAPTION = 'add these to evol as bus/mrt physical card'

  it('has its purchases added to that card at once, and is answered with them in a table and with where the card stands', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    reading(
      read([bought(210, 'BUS/MRT 4471'), bought(185, 'BUS/MRT 4502'), bought(1240, 'COFFEE PLACE')], {
        card: 'evol',
        category: 'other',
      }),
    )

    const { rich, texts } = await chat.photo(CAPTION, MESSAGE)

    // Each is stored as a purchase that was added by hand is, under the id of the message and its place in the photo.
    const rows = await rowsOf(userId)
    const stored = {
      card_last4: '5678',
      currency: 'SGD',
      // The start of its day in the user's time zone, as the reading gave it.
      occurred_at: seconds('2026-10-05T00:00:00+08:00'),
      parser: 'manual',
      category: 'other',
      removed_at: null,
    }
    expect(rows).toEqual([
      { ...stored, id: rows[0].id, source_id: 'manual:7001:0', amount_minor: 210, merchant: 'BUS/MRT 4471' },
      { ...stored, id: rows[1].id, source_id: 'manual:7001:1', amount_minor: 185, merchant: 'BUS/MRT 4502' },
      { ...stored, id: rows[2].id, source_id: 'manual:7001:2', amount_minor: 1240, merchant: 'COFFEE PLACE' },
    ])
    // As Telegram is posted it: this is all of the `rich_message` of the request. Every text is a plain string, a
    // merchant's name among them, and Telegram is told to make nothing of what a text looks like.
    expect(rich).toEqual({
      skip_entity_detection: true,
      blocks: [
        { type: 'paragraph', text: { type: 'bold', text: 'Added to evol ••••5678 as Other Spend:' } },
        {
          type: 'table',
          is_bordered: true,
          cells: [
            [
              { text: 'ID', is_header: true },
              { text: 'Date', is_header: true },
              { text: 'SGD', is_header: true, align: 'right' },
              { text: 'Merchant', is_header: true },
            ],
            // The id of a purchase has the mark of one that was added by hand, as every purchase of a photo is.
            [
              { text: `${rows[0].id}*`, align: 'right' },
              { text: '5 Oct' },
              { text: '2.10', align: 'right' },
              { text: 'BUS/MRT 4471' },
            ],
            [
              { text: `${rows[1].id}*`, align: 'right' },
              { text: '5 Oct' },
              { text: '1.85', align: 'right' },
              { text: 'BUS/MRT 4502' },
            ],
            [
              { text: `${rows[2].id}*`, align: 'right' },
              { text: '5 Oct' },
              { text: '12.40', align: 'right' },
              { text: 'COFFEE PLACE' },
            ],
            [{ text: 'Total', colspan: 2 }, { text: '16.35', align: 'right' }, { text: '' }],
          ],
        },
        { type: 'paragraph', text: BY_HAND_NOTE },
        // The line that the reply to /add has for where its card then stands.
        { type: 'paragraph', text: 'evol ••••5678: SGD 16.35 in 3 purchases, resets 1 Nov' },
      ],
    })
    // The table is all that the chat is left with: the placeholder is gone, and nothing is held or asked.
    expect(texts).toEqual([])
    expect(await heldFor(userId)).toEqual([])
    // The purchases are in every list from then on, each removable by its id.
    expect(await chat.lines('/spend')).toContain('evol | SGD 16.35 | 3 | 29 Sep to 29 Oct | 1 Nov')
    expect(await chat.say(`/remove ${rows[2].id}`)).toBe(
      `Removed from ••••5678:\nID ${rows[2].id} · 5 Oct · SGD 12.40 · COFFEE PLACE · by hand`,
    )
  })

  it('has the largest of its sizes fetched, and is read with its caption and with what the cards are called and sorted into', async () => {
    const chat = await chatWithCards()
    reading(read([bought(210, 'BUS/MRT 4471')], { card: 'evol', category: 'other' }))

    await chat.photo(CAPTION)

    // The file of one size is fetched: the largest, by the id that Telegram gave it, and no more of it than 400 KB.
    expect(file.mock.calls).toEqual([['made-up-file-id-large', 400_000]])
    // The reading is given the bytes that came, what they are, the caption, and each card: its nickname, the
    // categories that a purchase on it can be put in by hand, and what its product says of the sorting.
    expect(reader).toHaveBeenCalledTimes(1)
    const [given, provider, input] = reader.mock.calls[0]
    expect(given).toBe(deps)
    expect(provider).toBe(deps.ai)
    expect(provider.visionModel).toBe(DEFAULT_VISION_MODEL)
    expect(input).toEqual({
      image: BYTES,
      mime: 'image/jpeg',
      caption: CAPTION,
      cards: [
        { nickname: 'visa', categories: [], note: undefined },
        {
          nickname: 'evol',
          categories: [
            { key: 'online', label: ONLINE },
            { key: 'other', label: OTHER },
          ],
          note: 'Other Spend is where a purchase made with the physical card goes.',
        },
      ],
      timeZone: 'Asia/Singapore',
    })
  })

  it('is read by the time zone of its user, and tells of each purchase by the day that it was made there', async () => {
    const chat = await chatWithCard()
    await chat.say('/timezone America/New_York')
    // The start of 8 October in New York, where it is midnight at the start of the 9th.
    reading(read([bought(500, 'DINER', { occurredAt: seconds('2026-10-08T00:00:00-04:00') })]))

    const { rich } = await chat.photo()

    expect(reader.mock.calls[0][2].timeZone).toBe('America/New_York')
    expect(lines(rich)[2]).toMatch(/^\d+\* \| 8 Oct \| 5\.00 \| DINER$/)
  })

  it('is read with its caption as it came, however long: how much of one the model is sent is the reading’s to say', async () => {
    const chat = await chatWithCard()
    reading({ status: 'nothing' })
    const caption = `  add these to evol\n${'x'.repeat(1000)}`

    await chat.photo(caption)

    expect(reader.mock.calls[0][2].caption).toBe(caption)
  })

  it('puts every purchase in the category that the caption named, whatever a rule of the product would make of it', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    // One that a rule would place by its currency, and one by its merchant.
    const purchases = [bought(990, 'AIRLINE', { currency: 'USD' }), bought(1598, 'NETFLIX.COM')]
    reading(read(purchases, { card: 'evol', category: 'other' }))

    const { rich } = await chat.photo('evol, other spend')

    const rows = await rowsOf(userId)
    expect(rows.map((row) => row.category)).toEqual(['other', 'other'])
    // One table, in which each amount has the code of its currency, and a total for each currency.
    expect(rich?.blocks).toEqual([
      bold('Added to evol ••••5678 as Other Spend:'),
      tableOf(
        headerRow('Amount'),
        purchaseRow(`${rows[0].id}*`, '5 Oct', 'USD 9.90', 'AIRLINE'),
        purchaseRow(`${rows[1].id}*`, '5 Oct', 'SGD 15.98', 'NETFLIX.COM'),
        sumRow('Total', 'USD 9.90'),
        sumRow('Total', 'SGD 15.98'),
      ),
      BY_HAND,
      plain('evol ••••5678: SGD 15.98 + USD 9.90 in 2 purchases, resets 1 Nov'),
    ])
  })

  it('starts each purchase where /add would start it, when the caption names no category: a table to each category', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    reading(
      read(
        [
          bought(990, 'AIRLINE', { currency: 'USD' }),
          bought(1240, 'COFFEE PLACE'),
          bought(1598, 'NETFLIX.COM'),
          bought(300, null, { occurredAt: seconds('2026-10-06T00:00:00+08:00') }),
        ],
        { card: 'evol' },
      ),
    )

    const { rich, texts } = await chat.photo('these are on evol')

    // Nothing is stored for a purchase that no rule places: it is online, as any purchase is until something says
    // otherwise.
    const rows = await rowsOf(userId)
    expect(rows.map((row) => row.category)).toEqual(['fx', null, 'selected', null])
    const [abroad, coffee, netflix, unnamed] = rows.map((row) => `${row.id}*`)
    // The tables are in the order of the product's groups, and each has its purchases in the order of the photo.
    expect(rich?.blocks).toEqual([
      bold(`Added to evol ••••5678 as ${ONLINE}:`),
      tableOf(
        headerRow('SGD'),
        purchaseRow(coffee, '5 Oct', '12.40', 'COFFEE PLACE'),
        purchaseRow(unnamed, '6 Oct', '3.00', '-'),
        sumRow('Total', '15.40'),
      ),
      bold('Added to evol ••••5678 as Selected Gym, Telco and Streaming Spend:'),
      tableOf(headerRow('SGD'), purchaseRow(netflix, '5 Oct', '15.98', 'NETFLIX.COM'), sumRow('Total', '15.98')),
      bold('Added to evol ••••5678 as Overseas Foreign Currency Spend:'),
      tableOf(headerRow('USD'), purchaseRow(abroad, '5 Oct', '9.90', 'AIRLINE'), sumRow('Total', '9.90')),
      BY_HAND,
      plain('evol ••••5678: SGD 31.38 + USD 9.90 in 4 purchases, resets 1 Nov'),
    ])
    expect(texts).toEqual([])
  })

  it.each<[what: string, category: string]>([
    ['one that only a rule gives', 'fx'],
    ['one that the product has not got', 'dining'],
    ['one of another product', 'groceries'],
  ])('takes no category that is none of those a purchase on the card can be put in by hand: %s', async (_, category) => {
    const chat = await chatWithCard()
    reading(read([bought(1240, 'COFFEE PLACE')], { card: 'evol', category }))

    const { rich } = await chat.photo('evol')

    // The purchase starts where /add would start it.
    expect(await rowsOf(await chat.userId())).toMatchObject([{ category: null }])
    expect(rich?.blocks[0]).toEqual(bold(`Added to evol ••••5678 as ${ONLINE}:`))
  })

  it('names no category for a card that is linked to no product, on which no purchase is sorted', async () => {
    const chat = await chatWithCards()
    reading(read([bought(1240, 'COFFEE PLACE')], { card: 'visa', category: 'other' }))

    const { rich } = await chat.photo('visa')

    const [row] = await rowsOf(await chat.userId())
    expect(row).toMatchObject({ card_last4: '1234', category: null })
    expect(rich?.blocks).toEqual([
      bold('Added to visa ••••1234:'),
      tableOf(headerRow('SGD'), purchaseRow(`${row.id}*`, '5 Oct', '12.40', 'COFFEE PLACE'), sumRow('Total', '12.40')),
      BY_HAND,
      plain('visa ••••1234: SGD 12.40 in 1 purchase, resets 1 Nov'),
    ])
  })

  it("adds the purchases to the user's own card, and to nobody else's card of the same name", async () => {
    const [chat, bystander] = [await chatWithCards(), await chatWithCards()]
    reading(read([bought(1240, 'COFFEE PLACE')], { card: 'evol' }))

    await chat.photo('evol')

    expect(await rowsOf(await bystander.userId())).toEqual([])
    expect(await bystander.lines('/spend')).toContain('evol | SGD 0.00 | 0 | 29 Sep to 29 Oct | 1 Nov')
    expect(await rowsOf(await chat.userId())).toHaveLength(1)
  })

  it('leaves a purchase of an earlier window out of where the card stands, and adds it all the same', async () => {
    const chat = await chatWithCard()
    // The last day that October does not count: it counts the last two days of September.
    const september = seconds('2026-09-28T00:00:00+08:00')
    reading(read([bought(9900, 'LAST MONTH', { occurredAt: september }), bought(1000, 'THIS MONTH')]))

    const { rich } = await chat.photo()

    expect(await rowsOf(await chat.userId())).toHaveLength(2)
    expect(lines(rich).at(-1)).toBe(
      'evol ••••5678: SGD 10.00 in 1 purchase, resets 1 Nov',
    )
  })
})

describe('a photo as text, when Telegram does not take the rich message', () => {
  it('is answered with the same tables as blocks of text, in which nothing of a name can be tapped', async () => {
    vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new TelegramError('sendRichMessage', 400))
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const hostile = '/start https://attacker.test @someone'
    reading(read([bought(1240, hostile), bought(990, 'AIRLINE', { currency: 'USD' })], { card: 'evol' }))
    const logged = catchConsole()

    const { rich, texts } = await chat.photo('evol')

    expect(rich).toBeUndefined()
    const [first, second] = (await rowsOf(userId)).map((row) => String(row.id))
    // The ids of a table are as wide as the widest of them, which is at least as wide as the header of their column.
    // A row is 36 characters at the most, of which the name has what the other columns leave it: 20 less that width.
    const width = Math.max(2, first.length, second.length)
    const id = (text: string) => `${text.padStart(width)}*`
    const header = (amounts: string) => `${'ID'.padEnd(width + 1)} Date   ${amounts}  Merchant`
    const total = (amount: string) => `${' '.repeat(width + 1)} Total  ${amount}`
    expect(texts).toHaveLength(1)
    expect(texts[0].text).toBe(
      [
        `Added to evol ••••5678 as ${ONLINE}:`,
        header('  SGD'),
        // The name is cut to what its row has room for.
        `${id(first)} 5 Oct  12.40  ${hostile.slice(0, 19 - width)}…`,
        total('12.40'),
        '',
        'Added to evol ••••5678 as Overseas Foreign Currency Spend:',
        header('  USD'),
        `${id(second)} 5 Oct   9.90  AIRLINE`,
        total(' 9.90'),
        '',
        BY_HAND_NOTE,
        '',
        'evol ••••5678: SGD 12.40 + USD 9.90 in 2 purchases, resets 1 Nov',
      ].join('\n'),
    )
    // Each table is a block, and nothing else is marked: a name is nowhere but in a block.
    expect(texts[0].entities?.map((entity) => entity.type)).toEqual(['pre', 'pre'])
    expect(texts[0].buttons).toBeUndefined()
    // The log has the photo as one whose reply went as text.
    expect(logged.events('photo')).toEqual([{ ...photoLine(userId, { read: 2, stored: 2 }), sent: 'text' }])
  })
})

describe('a photo with no caption', () => {
  it('has its purchases added to the one card of a user who has one', async () => {
    const chat = openChat()
    await chat.say('/addcard visa 1234 calendar')
    reading(read([bought(1240, 'COFFEE PLACE'), bought(300, 'TEA HOUSE')]))

    const { rich, texts } = await chat.photo()

    // The reading is given the caption as text all the same: there is none.
    expect(reader.mock.calls[0][2].caption).toBe('')
    const rows = await rowsOf(await chat.userId())
    expect(rows).toMatchObject([
      { card_last4: '1234', merchant: 'COFFEE PLACE', category: null },
      { card_last4: '1234', merchant: 'TEA HOUSE', category: null },
    ])
    expect(rich?.blocks).toEqual([
      bold('Added to visa ••••1234:'),
      tableOf(
        headerRow('SGD'),
        purchaseRow(`${rows[0].id}*`, '5 Oct', '12.40', 'COFFEE PLACE'),
        purchaseRow(`${rows[1].id}*`, '5 Oct', '3.00', 'TEA HOUSE'),
        sumRow('Total', '15.40'),
      ),
      BY_HAND,
      plain('visa ••••1234: SGD 15.40 in 2 purchases, resets 1 Nov'),
    ])
    expect(texts).toEqual([])
  })

  it('puts the purchases of a user with one card in the category that the caption named with no card', async () => {
    const chat = await chatWithCard()
    reading(read([bought(1240, 'COFFEE PLACE')], { category: 'other' }))

    await chat.photo('other spend')

    expect(await rowsOf(await chat.userId())).toMatchObject([{ card_last4: '5678', category: 'other' }])
  })

  it('adds none of its purchases for a user with two cards, who is asked which card, with a button for each', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE'), unsure(300, 'TEA HOUSE'), bought(990, null)]))

    const { rich, texts } = await chat.photo(undefined, MESSAGE)

    expect(rich).toBeUndefined()
    expect(await rowsOf(userId)).toEqual([])
    const [asking, ...more] = texts
    expect(more).toEqual([])
    // All of them are shown, with the one that the model was not sure of marked, and with what to make of the mark.
    expect(asking.text).toBe(
      [
        'Which card were these 3 purchases made with? The bot could not tell.',
        '5 Oct · SGD 12.40 · COFFEE PLACE',
        '5 Oct · SGD 3.00 · TEA HOUSE · not sure',
        '5 Oct · SGD 9.90',
        UNSURE_NOTE,
      ].join('\n'),
    )
    expect(markedIn(asking)).toEqual(['COFFEE PLACE', 'TEA HOUSE'])
    // A row to each button: one for each of the user's cards, in the order of the cards, and one that skips.
    expect(asking.buttons).toEqual([
      [{ text: 'Add to visa', data: 'held:7001:1234' }],
      [{ text: 'Add to evol', data: 'held:7001:5678' }],
      [{ text: 'Skip', data: 'held:7001:skip' }],
    ])
    // They are held as one batch, for no card, until a day from now.
    expect(await heldFor(userId)).toEqual([
      {
        message_id: MESSAGE,
        card_last4: null,
        category: null,
        purchases: [
          { place: 0, ...bought(1240, 'COFFEE PLACE') },
          { place: 1, ...unsure(300, 'TEA HOUSE') },
          { place: 2, ...bought(990, null) },
        ],
        expires_at: NOW.getTime() / 1000 + 24 * 3600,
      },
    ])
  })

  it('asks which card with nothing to check, when the model was sure of every purchase', async () => {
    const chat = await chatWithCards()
    reading(read([bought(1240, 'COFFEE PLACE')]))

    const { texts } = await chat.photo()

    expect(texts.map((message) => message.text)).toEqual([
      'Which card was this purchase made with? The bot could not tell.\n5 Oct · SGD 12.40 · COFFEE PLACE',
    ])
    expect(labels(texts[0])).toEqual(['Add to visa', 'Add to evol', 'Skip'])
  })

  it('asks which card, of a user who has one card, when the caption named a card that they have not got', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    // The model gave a card that is none of the user's, which is not the same as naming none.
    reading(read([bought(1240, 'COFFEE PLACE')], { unknownCard: true }))

    const { rich, texts } = await chat.photo('add these to amex', MESSAGE)

    // The one card is not taken in its place: nothing is stored on it without a word.
    expect(rich).toBeUndefined()
    expect(await rowsOf(userId)).toEqual([])
    expect(texts.map((message) => [message.text, message.buttons])).toEqual([
      [
        'Which card was this purchase made with? The bot could not tell.\n5 Oct · SGD 12.40 · COFFEE PLACE',
        [[{ text: 'Add to evol', data: 'held:7001:5678' }], [{ text: 'Skip', data: 'held:7001:skip' }]],
      ],
    ])
    expect(await heldFor(userId)).toMatchObject([{ message_id: MESSAGE, card_last4: null }])
  })

  it('does not go by a card that the reading names and the user has not got', async () => {
    const chat = await chatWithCards()
    reading(read([bought(1240, 'COFFEE PLACE')], { card: 'amex', category: 'other' }))

    const { rich, texts } = await chat.photo('amex')

    expect(rich).toBeUndefined()
    expect(await rowsOf(await chat.userId())).toEqual([])
    expect(labels(texts[0])).toEqual(['Add to visa', 'Add to evol', 'Skip'])
  })
})

describe('a photo whose message Telegram delivers twice', () => {
  it('is read once: the second is not fetched or read, and is answered with one line, as a message of text is whose purchases were added', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE'), unsure(300, 'TEA HOUSE')], { card: 'evol', category: 'other' }))
    const logged = catchConsole()

    // Telegram delivers a message again, with the id it had, when it has not heard that the message was taken.
    const first = await chat.photo('evol, other spend', MESSAGE)
    const again = await chat.photo('evol, other spend', MESSAGE)

    expect(first.rich).toBeDefined()
    expect(again.rich).toBeUndefined()
    expect(again.texts.map((message) => message.text)).toEqual([READ_ALREADY])
    // A second reading could differ from the first, so there is none: one file was fetched, and one reading made.
    expect([file, reader].map((spy) => spy.mock.calls.length)).toEqual([1, 1])
    expect((await rowsOf(userId)).map((row) => row.source_id)).toEqual(['manual:7001:0'])
    expect(await heldFor(userId)).toHaveLength(1)
    // That is no failure of the service's. The log has the second as a photo that came again, and was not read.
    const repeated = { ...photoLine(userId, { read: 0, stored: 0 }), outcome: 'repeated', sent: 'edit' }
    expect(logged.events('photo')).toEqual([
      photoLine(userId, { read: 2, stored: 1, held: 1 }),
      { ...repeated, bytes: 0, requests: 0 },
    ])
    expect(logged.failures()).toEqual([])
    // It is still a message that was read once the purchase that was stored for it has been taken out.
    await chat.say(`/remove ${(await rowsOf(userId))[0].id}`)
    expect((await chat.photo(undefined, MESSAGE)).texts.map((message) => message.text)).toEqual([READ_ALREADY])

    // A message of text whose purchases the assistant gave to be added is added from once in the same way.
    const adding = { kind: 'add' as const, reading: read([bought(520, 'LUNCH')]) }
    const made = { status: 'acting' as const, actions: [adding], afterReading: false, dropped: 0, more: false }
    vi.spyOn(assistant, 'answerQuestion').mockResolvedValue(made)
    await chat.ask('add 5.20 lunch', 7002)
    expect((await chat.ask('add 5.20 lunch', 7002)).map((message) => message.text)).toEqual([READ_ALREADY])
    expect((await rowsOf(userId)).map((row) => row.source_id)).toEqual(['manual:7001:0', 'manual:7002:0'])

    // The same photo in a message of its own is read as another, and stores its purchases a second time: the bot
    // looks for no purchase that is like one that it has.
    await chat.photo('evol, other spend')
    expect(await rowsOf(userId)).toHaveLength(3)
  })
})

describe('a reading of a message that has purchases stored already', () => {
  // A message that was read is not read again. But two deliveries of one can be read at the same moment, each
  // before the other has stored anything for it to find, and the two readings need not be alike. These tests add a
  // second reading for the message as such a delivery does: with nothing looked for first.

  /** Adds a reading for the message with the id that the tests go by, and returns what its user would be told. */
  async function addedAgain(chat: Chat, came: Reading) {
    const user = await findUser(env.DB, chat.telegramId)
    if (!user) throw new Error('A test has no user')
    const cards = await storeFor(env.DB, user.id).listCards()
    return addRead(deps, user, cards, came, MESSAGE, { stored: 0, held: 0, kept: false, late: false })
  }

  it('tells of its purchases as they are by then, under the card that they are stored on: one that was taken out is left out', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    const purchases = [bought(1240, 'COFFEE PLACE'), bought(300, 'TEA HOUSE')]
    reading(read(purchases, { card: 'evol' }))
    await chat.photo('these are on evol', MESSAGE)
    const [coffee, tea] = await rowsOf(userId)
    await chat.say(`/remove ${coffee.id}`)

    // The second reading takes the purchases to be on the other card. They are on evol, and are told of so.
    const added = await addedAgain(chat, read(purchases, { card: 'visa' }))

    expect(added?.rich?.rich.blocks).toEqual([
      bold(`Added to evol ••••5678 as ${ONLINE}:`),
      tableOf(headerRow('SGD'), purchaseRow(`${tea.id}*`, '5 Oct', '3.00', 'TEA HOUSE'), sumRow('Total', '3.00')),
      BY_HAND,
      plain('evol ••••5678: SGD 3.00 in 1 purchase, resets 1 Nov'),
    ])
    expect(added?.text.map((message) => message.text)).toEqual([
      '1 of these purchases has been taken out, and is not added again.',
    ])
    expect(await rowsOf(userId)).toMatchObject([
      { id: coffee.id, card_last4: '5678', removed_at: expect.any(Number) },
      { id: tea.id, card_last4: '5678', removed_at: null },
    ])
  })

  it('says so, and no more, when every purchase of it has been taken out', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const came = read([bought(1240, 'COFFEE PLACE'), bought(300, 'TEA HOUSE')])
    reading(came)
    await chat.photo(undefined, MESSAGE)
    for (const { id } of await rowsOf(userId)) await chat.say(`/remove ${id}`)

    const added = await addedAgain(chat, came)

    expect(added?.rich).toBeUndefined()
    expect(added?.text.map((message) => message.text)).toEqual([
      '2 of these purchases have been taken out, and are not added again.',
    ])
  })

  it('has the purchases that are held for the message held once, and added once', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const came = read([bought(1240, 'COFFEE PLACE'), unsure(300, 'TEA HOUSE')])
    reading(came)
    const [first] = (await chat.photo(undefined, MESSAGE)).texts

    const added = await addedAgain(chat, came)

    // One batch for the message, under the same buttons, which the button of the message that is in the chat adds.
    expect(await heldFor(userId)).toHaveLength(1)
    expect(added?.text).toMatchObject([{ text: first.text, buttons: first.buttons }])
    const asItStood = { ...first }
    expect((await chat.press(asItStood, 'Add this one')).answer).toBe('Added 1 purchase.')
    expect(await chat.press(asItStood, 'Add this one')).toEqual({ answer: REFUSED, sent: [] })
    expect((await rowsOf(userId)).map((row) => row.source_id)).toEqual(['manual:7001:0', 'manual:7001:1'])
  })

  it('adds nothing twice when its purchases are held again after they were added', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const came = read([unsure(300, 'TEA HOUSE')])
    reading(came)
    const [asking] = (await chat.photo(undefined, MESSAGE)).texts
    await chat.press(asking, 'Add this one')

    // The purchase is held again, as the reading is unsure of it again, and a press finds it stored.
    await addedAgain(chat, came)
    expect((await chat.pressWith(asking, 'held:7001:add')).answer).toBe('Added 1 purchase.')

    const rows = await rowsOf(userId)
    expect(rows).toHaveLength(1)
    expect(asking.text).toBe(
      `Added to evol ••••5678 as ${ONLINE}:\nID ${rows[0].id} · 5 Oct · SGD 3.00 · TEA HOUSE · by hand`,
    )
    expect(await heldFor(userId)).toEqual([])
  })
})

describe('the hundred purchases that a user may add by hand in 24 hours', () => {
  const LEFT_OUT = (count: string, them: string) =>
    `${count} not added. You have added 100 purchases by hand in the last 24 hours, which is as many as can be ` +
    `added in that time. A purchase that the bot reads for you counts as one. Add ${them} with /add later.`

  it('have the purchases of a photo among them: the first of the photo are added, and it says how many were not', async () => {
    const [chat, bystander] = [await chatWithCard(), await chatWithCard()]
    const userId = await chat.userId()
    // 97 that were added by hand already, on another card.
    for (let added = 1; added <= 97; added++) await buy(userId, { parser: 'manual', cardLast4: '0005' })
    const five = [1, 2, 3, 4, 5].map((nth) => bought(100 * nth, `SHOP ${nth}`))
    reading(read(five))
    const logged = catchConsole()

    const { rich, texts } = await chat.photo(undefined, MESSAGE)

    // Three of the five, in the order of the photo.
    const rows = (await rowsOf(userId)).slice(97)
    expect(rows.map((row) => [row.source_id, row.merchant])).toEqual([
      ['manual:7001:0', 'SHOP 1'],
      ['manual:7001:1', 'SHOP 2'],
      ['manual:7001:2', 'SHOP 3'],
    ])
    expect(lines(rich)).toEqual([
      `Added to evol ••••5678 as ${ONLINE}:`,
      'ID | Date | SGD | Merchant',
      `${rows[0].id}* | 5 Oct | 1.00 | SHOP 1`,
      `${rows[1].id}* | 5 Oct | 2.00 | SHOP 2`,
      `${rows[2].id}* | 5 Oct | 3.00 | SHOP 3`,
      'Total | 6.00',
      BY_HAND_NOTE,
      'evol ••••5678: SGD 6.00 in 3 purchases, resets 1 Nov',
    ])
    expect(texts.map((message) => message.text)).toEqual([LEFT_OUT('2 purchases were', 'them')])
    // Nothing in what is said says to send the photo again, which would store the three a second time.
    expect(texts[0].text).not.toMatch(/again/i)
    expect(logged.events('photo')).toEqual([photoLine(userId, { read: 5, stored: 3 })])

    // The limit is each user's own.
    reading(read(five))
    await bystander.photo()
    expect(await rowsOf(await bystander.userId())).toHaveLength(5)
  })

  it('leave no room for any purchase of a photo once they are used up, which is said with nothing added', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const earliest = await buy(userId, { parser: 'manual', cardLast4: '0005' })
    for (let added = 2; added <= 100; added++) await buy(userId, { parser: 'manual', cardLast4: '0005' })
    reading(read([bought(100, 'SHOP 1')]))

    const { rich, texts } = await chat.photo()

    expect(rich).toBeUndefined()
    expect(texts.map((message) => message.text)).toEqual([LEFT_OUT('1 purchase was', 'it')])
    expect(await rowsOf(userId)).toHaveLength(100)

    // Once the earliest of them is 24 hours old, there is room for one more, and only for one.
    await env.DB.prepare('UPDATE transactions SET created_at = unixepoch() - 86400 WHERE id = ?').bind(earliest).run()
    reading(read([bought(100, 'SHOP 1'), bought(200, 'SHOP 2')]))
    expect((await chat.photo()).texts.map((message) => message.text)).toEqual([LEFT_OUT('1 purchase was', 'it')])
    expect(await rowsOf(userId)).toHaveLength(101)
  })

  it('count against purchases that are held when those are added, and the message says how many were not', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([unsure(100, 'SHOP 1'), unsure(200, 'SHOP 2'), unsure(300, 'SHOP 3')]))
    const [asking] = (await chat.photo(undefined, MESSAGE)).texts
    // Holding purchases uses up none of the hundred: they are added by hand in the meantime.
    for (let added = 1; added <= 99; added++) await buy(userId, { parser: 'manual', cardLast4: '0005' })

    const pressed = await chat.press(asking, 'Add these 3')

    expect(pressed).toEqual({ answer: 'Added 1 purchase.', sent: [] })
    const rows = await rowsOf(userId)
    expect(rows).toHaveLength(100)
    expect(asking.text).toBe(
      [
        `Added to evol ••••5678 as ${ONLINE}:`,
        `ID ${rows[99].id} · 5 Oct · SGD 1.00 · SHOP 1 · by hand`,
        LEFT_OUT('2 purchases were', 'them'),
      ].join('\n'),
    )
    // The purchases are held no longer, though two of them were not added.
    expect(await heldFor(userId)).toEqual([])
  })

  it('leave purchases that are held unadded once they are used up, and the press says so', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([unsure(100, 'SHOP 1')]))
    const [asking] = (await chat.photo()).texts
    for (let added = 1; added <= 100; added++) await buy(userId, { parser: 'manual', cardLast4: '0005' })

    expect(await chat.press(asking, 'Add this one')).toEqual({ answer: 'No purchases were added.', sent: [] })

    expect(asking.text).toBe(LEFT_OUT('1 purchase was', 'it'))
    expect(await rowsOf(userId)).toHaveLength(100)
  })
})

describe('a photo of twenty purchases', () => {
  const twenty = (given: Partial<ReadPurchase> = {}) =>
    Array.from({ length: 20 }, (_, index) => bought(100 + index, `SHOP ${index + 1}`, given))

  it('is stored in one statement, and takes six queries in all', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read(twenty()))
    const queried = vi.spyOn(env.DB, 'prepare')

    const { rich } = await chat.photo(undefined, MESSAGE)

    // The user, the cards, the two that look whether the message was read before, the twenty purchases, and what
    // the card then comes to.
    expect(queried).toHaveBeenCalledTimes(6)
    expect(queried.mock.calls.filter(([query]) => query.includes('INSERT INTO transactions'))).toHaveLength(1)
    queried.mockRestore()
    const rows = await rowsOf(userId)
    expect(rows.map((row) => row.source_id)).toEqual(Array.from({ length: 20 }, (_, place) => `manual:7001:${place}`))
    // The ids go up in the order of the photo, and the table has a row for each.
    expect(lines(rich)).toHaveLength(1 + 1 + 20 + 1 + 2)
  })

  it('takes eight queries at its most: with purchases to hold, and with some that the limit leaves out', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    for (let added = 1; added <= 90; added++) await buy(userId, { parser: 'manual', cardLast4: '0005' })
    reading(read([...twenty().slice(0, 15), ...twenty({ unsure: true }).slice(15)]))
    const queried = vi.spyOn(env.DB, 'prepare')
    const [post, typing, sendRich, send, remove] = [
      vi.spyOn(deps.messenger, 'post'),
      vi.spyOn(deps.messenger, 'typing'),
      vi.spyOn(deps.messenger, 'sendRich'),
      vi.spyOn(deps.messenger, 'send'),
      vi.spyOn(deps.messenger, 'delete'),
    ]

    const { texts } = await chat.photo()

    // The user, the cards, the two that look whether the message was read before, the storing, which of the
    // purchases the limit left out, the holding, and the card's total.
    expect(queried).toHaveBeenCalledTimes(8)
    queried.mockRestore()
    expect(await rowsOf(userId)).toHaveLength(100)
    expect((await heldFor(userId))[0].purchases).toHaveLength(5)
    expect(texts.map((message) => message.text.split('\n')[0])).toEqual([
      'Not sure about these 5 purchases. Check the amount and the date of each before you add them to evol ••••5678:',
      expect.stringMatching(/^5 purchases were not added\. /),
    ])
    // The placeholder, the showing that the bot is writing, the table, the two messages of text, and the placeholder
    // deleted. Each of these is one request to Telegram.
    expect([post, typing, sendRich, send, remove].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 2, 1])
  })

  it('is all that is taken from a photo: what a reading holds beyond them is left, and its user is told so', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([...twenty(), bought(9900, 'ONE TOO MANY')]))
    const logged = catchConsole()

    const { texts } = await chat.photo()

    expect(await rowsOf(userId)).toHaveLength(20)
    expect(texts.map((message) => message.text)).toEqual([
      'Only the first 20 purchases of a message are read. Send the rest on their own, or add them with /add.',
    ])
    expect(logged.events('photo')).toEqual([photoLine(userId, { read: 20, stored: 20 })])
  })

  it('is said to be all that is read when the reading says that the photo held more', async () => {
    const chat = await chatWithCard()
    reading(read(twenty(), { more: true, unreadable: 2 }))

    const { texts } = await chat.photo()

    // What there is to know besides is one message, a line to each thing.
    expect(texts.map((message) => message.text)).toEqual([
      '2 more purchases could not be read at all. Add them by hand with /add.\n' +
        'Only the first 20 purchases of a message are read. Send the rest on their own, or add them with /add.',
    ])
  })
})

describe('purchases that could not be read at all', () => {
  it('are counted for their user after what was added and what is held, with how to add them', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([bought(1240, 'COFFEE PLACE'), unsure(300, 'TEA HOUSE')], { unreadable: 1 }))
    const logged = catchConsole()

    const { rich, texts } = await chat.photo()

    // In that order: the table, the purchases that are held, and then what there is to know besides.
    expect(rich).toBeDefined()
    expect(texts.map((message) => message.text.split('\n')[0])).toEqual([
      'Not sure about this purchase. Check its amount and its date before you add it to evol ••••5678:',
      '1 more purchase could not be read at all. Add it by hand with /add.',
    ])
    expect(labels(texts[1])).toBeUndefined()
    expect(logged.events('photo')).toEqual([photoLine(userId, { read: 2, stored: 1, held: 1, unreadable: 1 })])
  })

  it('are all that is told of when nothing else was read', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    reading(read([], { unreadable: 3 }))
    const logged = catchConsole()

    const { rich, texts } = await chat.photo()

    expect(rich).toBeUndefined()
    expect(texts.map((message) => message.text)).toEqual([
      '3 purchases could not be read at all. Add them by hand with /add.',
    ])
    expect(logged.events('photo')).toEqual([
      { ...photoLine(userId, { read: 0, stored: 0, unreadable: 3 }), sent: 'text' },
    ])
  })
})

describe('a purchase that is dated in another year than it is now', () => {
  it('is shown with its year, in the table of what was added and on the line of one that is held', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    // A year too early, which is what a model can make of a day that a photo shows with no year.
    const lastYear = seconds('2025-10-05T12:00:00+08:00')
    reading(
      read([
        bought(1240, 'COFFEE PLACE', { occurredAt: lastYear }),
        bought(300, 'TEA HOUSE'),
        unsure(990, 'BOOKSHOP', { occurredAt: lastYear }),
        unsure(210, 'BUS/MRT 4471'),
      ]),
    )

    const { rich, texts } = await chat.photo(undefined, MESSAGE)

    // A day of this year is shown as it is everywhere else, with no year.
    const rows = await rowsOf(userId)
    expect(lines(rich).slice(1, 4)).toEqual([
      'ID | Date | SGD | Merchant',
      `${rows[0].id}* | 5 Oct 2025 | 12.40 | COFFEE PLACE`,
      `${rows[1].id}* | 5 Oct | 3.00 | TEA HOUSE`,
    ])
    const [asking] = texts
    expect(asking.text.split('\n').slice(1)).toEqual([
      '5 Oct 2025 · SGD 9.90 · BOOKSHOP',
      '5 Oct · SGD 2.10 · BUS/MRT 4471',
    ])
    // The purchase of last year is in no window that its card is shown for, which is why its year is to be seen.
    expect(lines(rich).at(-1)).toBe('evol ••••5678: SGD 3.00 in 1 purchase, resets 1 Nov')
    // The year is still on its line once the purchase has been added.
    await chat.press(asking, 'Add these 2')
    expect(asking.text.split('\n')[1]).toMatch(/^ID \d+ · 5 Oct 2025 · SGD 9\.90 · BOOKSHOP · by hand$/)
  })
})

describe('an album of photos', () => {
  it('is read a photo at a time: each of its messages on its own, of which one has the caption', async () => {
    const chat = await chatWithCards()
    const userId = await chat.userId()
    // Telegram posts an album as a message for each of its photos, and gives the caption to one of them.
    reading(read([bought(1240, 'COFFEE PLACE')], { card: 'evol' }))
    const first = await chat.photo('these are on evol')
    reading(read([bought(300, 'TEA HOUSE')]))
    const second = await chat.photo()

    expect(reader.mock.calls.map(([, , input]) => input.caption)).toEqual(['these are on evol', ''])
    // The photo with the caption is added, and the other is asked about: nothing of the first is kept for it.
    expect(first.rich).toBeDefined()
    expect(second.rich).toBeUndefined()
    expect(labels(second.texts[0])).toEqual(['Add to visa', 'Add to evol', 'Skip'])
    expect(await rowsOf(userId)).toMatchObject([{ merchant: 'COFFEE PLACE' }])
  })
})

describe('the adding of a reading', () => {
  /** How far an adding has got when it has done nothing yet, with whoever waits for it still waiting. */
  const begun = (): Adding => ({ stored: 0, held: 0, kept: false, late: false })

  it('knows nothing of photos: a reading that came from anything is added by it, under the id of its message', async () => {
    const chat = await chatWithCards()
    const user = await findUser(env.DB, chat.telegramId)
    if (!user) throw new Error('A test has no user')
    const cards = await storeFor(env.DB, user.id).listCards()
    const adding = begun()

    // No photo is fetched or read here, and nothing waits for a file: the reading is all that there is.
    const added = await addRead(
      deps,
      user,
      cards,
      read([bought(520, 'LUNCH'), unsure(300, 'TEA HOUSE')], { card: 'evol', category: 'other' }),
      8123,
      adding,
    )

    expect([file, reader].map((spy) => spy.mock.calls.length)).toEqual([0, 0])
    const rows = await rowsOf(user.id)
    expect(rows).toMatchObject([
      { source_id: 'manual:8123:0', card_last4: '5678', merchant: 'LUNCH', category: 'other' },
    ])
    // What was done is noted as it is done, and what to tell the user is what comes back.
    expect(adding).toEqual({ stored: 1, held: 1, kept: true, late: false })
    expect(added?.rich?.rich.blocks).toEqual([
      bold('Added to evol ••••5678 as Other Spend:'),
      tableOf(headerRow('SGD'), purchaseRow(`${rows[0].id}*`, '5 Oct', '5.20', 'LUNCH'), sumRow('Total', '5.20')),
      BY_HAND,
      plain('evol ••••5678: SGD 5.20 in 1 purchase, resets 1 Nov'),
    ])
    const [asking, ...more] = added?.text ?? []
    expect(more).toEqual([])
    expect(asking.text).toBe(
      'Not sure about this purchase. Check its amount and its date before you add it to evol ••••5678 as Other ' +
        'Spend:\n5 Oct · SGD 3.00 · TEA HOUSE',
    )
    expect(asking.buttons).toEqual([
      [{ text: 'Add this one', data: 'held:8123:add' }],
      [{ text: 'Skip', data: 'held:8123:skip' }],
    ])
    expect(await heldFor(user.id)).toMatchObject([{ message_id: 8123, card_last4: '5678', category: 'other' }])
    // Nothing that it says is said of a photo.
    expect(JSON.stringify(added)).not.toMatch(/photo/i)
  })

  it('stores nothing and holds nothing once whoever waits for it waits no longer', async () => {
    const chat = await chatWithCard()
    const user = await findUser(env.DB, chat.telegramId)
    if (!user) throw new Error('A test has no user')
    const cards = await storeFor(env.DB, user.id).listCards()
    const adding: Adding = { ...begun(), late: true }

    const added = await addRead(deps, user, cards, read([bought(520, 'LUNCH'), unsure(300, 'TEA HOUSE')]), 8124, adding)

    expect(added).toBeUndefined()
    expect(adding).toEqual({ stored: 0, held: 0, kept: false, late: true })
    expect(await rowsOf(user.id)).toEqual([])
    expect(await heldFor(user.id)).toEqual([])
  })
})
