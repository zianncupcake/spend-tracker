import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { WINDOW_LIMIT } from '../src/domain/sorting'
import { clock, openChat } from './connect-helpers'
import { bareRow, bold, buy, headerRow, linesOf, plain, purchaseRow, sumRow, tableOf } from './helpers'

// /spend with a card: the purchases of its current window as one rich message, with a table for each group of the
// card's product. test/detail.test.ts has the text that is sent in its place when Telegram does not take a rich
// message. The clock stands at 12:00 on 9 October 2026 in Singapore.

const TERMS = "Limits are from the bank's terms for the UOB EVOL Card, as of 10 June 2026."

/**
 * What is said under the total of a card for the calendar month, which is October: the last two days of a window
 * are counted in the next one.
 */
const OCTOBER_COUNTS =
  'The total counts purchases made from 29 Sep to 29 Oct. The bank counts a purchase by the day it is posted, so ' +
  'one made in the last 2 days of a month is counted in the next month.'

// What a message about the card of `chatWithCard` begins with, and the names over its tables.
const HEADING = bold('evol ••••1234: 1 Oct to 31 Oct')
const ONLINE = bold('Online and Mobile Contactless Spend')
const SELECTED = bold('Selected Gym, Telco and Streaming Spend')
const OTHER = bold('Other Spend')
const FOREIGN = bold('Overseas Foreign Currency Spend')

/** A chat whose user has a card that is linked to the UOB EVOL Card, with the calendar month for its window. */
async function chatWithCard() {
  const chat = openChat()
  await chat.say('/addcard evol 1234 calendar uob-evol')
  return chat
}

/** The table of a group in which nothing was spent: one with the limit, or one with no limit. */
function nothing(limit?: string) {
  const limited = limit === undefined ? [] : [bareRow('Cap', limit), bareRow('Left', limit)]
  return tableOf(bareRow('Total', '0.00'), ...limited)
}

describe('/spend with a card that is linked to a product', () => {
  it("is one rich message, with a table for each group: its purchases, their total and the group's limit", async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const shop = await buy(userId, { at: '2026-10-09T08:30:00+08:00', amountMinor: 3825, merchant: 'example-shop-sg' })
    // A name as a bank cuts it short. It is whole in its cell, which wraps what is too long for it.
    const eatery = { at: '2026-10-09T08:00:00+08:00', amountMinor: 4560, merchant: 'SAMPLE EATERY HOLDINGS PTE. LT' }
    const lunch = await buy(userId, eatery)
    const byCard = { amountMinor: 210, merchant: 'TRAIN FARE', category: 'other' }
    const there = await buy(userId, { ...byCard, at: '2026-10-09T09:00:00+08:00' })
    const back = await buy(userId, { ...byCard, at: '2026-10-10T09:00:00+08:00', amountMinor: 185 })
    clock.now = new Date('2026-10-10T12:00:00+08:00')

    // As Telegram is posted it: this is all of the `rich_message` of the request. Every text is a plain string, and
    // Telegram is told to make nothing of what a text looks like.
    expect(await chat.rich('/spend evol')).toEqual({
      skip_entity_detection: true,
      blocks: [
        { type: 'paragraph', text: { type: 'bold', text: 'evol ••••1234: 1 Oct to 31 Oct' } },
        { type: 'paragraph', text: { type: 'bold', text: 'Online and Mobile Contactless Spend' } },
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
            [
              { text: String(lunch), align: 'right' },
              { text: '9 Oct' },
              { text: '45.60', align: 'right' },
              { text: 'SAMPLE EATERY HOLDINGS PTE. LT' },
            ],
            [
              { text: String(shop), align: 'right' },
              { text: '9 Oct' },
              { text: '38.25', align: 'right' },
              { text: 'example-shop-sg' },
            ],
            // What sums the table up is named across the columns of the id and the day.
            [{ text: 'Total', colspan: 2 }, { text: '83.85', align: 'right' }, { text: '' }],
            [{ text: 'Cap', colspan: 2 }, { text: '300.00', align: 'right' }, { text: '' }],
            [{ text: 'Left', colspan: 2 }, { text: '216.15', align: 'right' }, { text: '' }],
          ],
        },
        { type: 'paragraph', text: { type: 'bold', text: 'Selected Gym, Telco and Streaming Spend' } },
        // A group with no purchases has a table of two columns: what each amount is called, and the amount.
        {
          type: 'table',
          is_bordered: true,
          cells: [
            [{ text: 'Total' }, { text: '0.00', align: 'right' }],
            [{ text: 'Cap' }, { text: '200.00', align: 'right' }],
            [{ text: 'Left' }, { text: '200.00', align: 'right' }],
          ],
        },
        { type: 'paragraph', text: { type: 'bold', text: 'Other Spend' } },
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
            [
              { text: String(there), align: 'right' },
              { text: '9 Oct' },
              { text: '2.10', align: 'right' },
              { text: 'TRAIN FARE' },
            ],
            [
              { text: String(back), align: 'right' },
              { text: '10 Oct' },
              { text: '1.85', align: 'right' },
              { text: 'TRAIN FARE' },
            ],
            [{ text: 'Total', colspan: 2 }, { text: '3.95', align: 'right' }, { text: '' }],
          ],
        },
        { type: 'paragraph', text: { type: 'bold', text: 'Overseas Foreign Currency Spend' } },
        { type: 'table', is_bordered: true, cells: [[{ text: 'Total' }, { text: '0.00', align: 'right' }]] },
        { type: 'paragraph', text: 'Total: SGD 87.80 in 4 purchases, resets 1 Nov' },
        { type: 'paragraph', text: OCTOBER_COUNTS },
        { type: 'paragraph', text: 'Minimum spend: SGD 87.80 of SGD 800.00' },
        { type: 'paragraph', text: TERMS },
      ],
    })
  })

  it('shows every group with nothing spent in it, and its limit, when the window holds no purchases', async () => {
    const chat = await chatWithCard()

    expect(await chat.rich('/spend evol')).toEqual({
      skip_entity_detection: true,
      blocks: [
        HEADING,
        ONLINE,
        nothing('300.00'),
        SELECTED,
        nothing('200.00'),
        OTHER,
        nothing(),
        FOREIGN,
        nothing(),
        plain('Total: no purchases, resets 1 Nov'),
        plain(OCTOBER_COUNTS),
        plain('Minimum spend: SGD 0.00 of SGD 800.00'),
        plain(TERMS),
      ],
    })
  })
})

describe('/spend with a card that is linked to no product', () => {
  it('has one table of all its purchases, with no name over it, which ends with what they come to', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 calendar')
    const userId = await chat.userId()
    const onAmex = { cardLast4: '0005' }
    const shop = { ...onAmex, at: '2026-10-08T09:00:00+08:00', amountMinor: 7700, merchant: 'SAMPLE SHOP' }
    const first = await buy(userId, shop)
    // What a purchase was sorted into is not shown on a card with no product.
    const sorted = await buy(userId, { ...onAmex, at: '2026-10-09T09:00:00+08:00', category: 'other' })
    await buy(userId, { merchant: 'ON ANOTHER CARD' })

    expect(await chat.rich('/spend amex')).toEqual({
      skip_entity_detection: true,
      blocks: [
        bold('amex ••••0005: 1 Oct to 31 Oct'),
        tableOf(
          headerRow('SGD'),
          purchaseRow(first, '8 Oct', '77.00', 'SAMPLE SHOP'),
          purchaseRow(sorted, '9 Oct', '12.40', 'COFFEE PLACE'),
          sumRow('Total', '89.40'),
        ),
        plain('Total: SGD 89.40 in 2 purchases, resets 1 Nov'),
        plain(OCTOBER_COUNTS),
      ],
    })
  })

  it('has no table when the window holds no purchases, and says so', async () => {
    const chat = openChat()
    await chat.say('/addcard amex 0005 statement 8') // The cycle that began on 9 October.

    expect(await chat.rich('/spend amex')).toEqual({
      skip_entity_detection: true,
      blocks: [
        bold('amex ••••0005: 9 Oct to 8 Nov'),
        plain('Total: no purchases, resets 9 Nov'),
        // The same of a statement cycle, in the words for one.
        plain(
          'The total counts purchases made from 7 Oct to 6 Nov. The bank counts a purchase by the day it is posted, ' +
            'so one made in the last 2 days before a statement closes is counted in the next statement month.',
        ),
      ],
    })
  })
})

describe('/spend with a card', () => {
  it("shows a user their own purchases, and never those on another user's card of the same name", async () => {
    const [first, second] = [await chatWithCard(), await chatWithCard()]
    const own = await buy(await first.userId(), { merchant: 'ONLY THE FIRST' })
    const other = { amountMinor: 100, merchant: 'ONLY THE SECOND', category: 'other' }
    const theirs = await buy(await second.userId(), other)

    // Each is sent to the chat that asked for it, which `rich` sees to.
    const [toFirst, toSecond] = [linesOf(await first.rich('/spend evol')), linesOf(await second.rich('/spend evol'))]

    expect(toFirst).toContain(`${own} | 5 Oct | 12.40 | ONLY THE FIRST`)
    expect(toFirst).toContain('Total: SGD 12.40 in 1 purchase, resets 1 Nov')
    expect(toFirst.join('\n')).not.toContain('ONLY THE SECOND')
    expect(toSecond).toContain(`${theirs} | 5 Oct | 1.00 | ONLY THE SECOND`)
    expect(toSecond).toContain('Total: SGD 1.00 in 1 purchase, resets 1 Nov')
    expect(toSecond.join('\n')).not.toContain('ONLY THE FIRST')
  })
})

describe('a window with many purchases', () => {
  /** A merchant's name of the 80 characters that a name can have. */
  const merchant = (index: number) => `MERCHANT ${String(index).padStart(3, '0')} `.padEnd(80, 'X')

  it(`lists the latest ${WINDOW_LIMIT} of them in one message, and totals them all, in five queries`, async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const ids: number[] = []
    for (let index = 0; index < WINDOW_LIMIT + 5; index++) {
      const at = new Date(Date.parse('2026-10-01T08:00:00+08:00') + index * 60_000).toISOString()
      ids.push(await buy(userId, { at, amountMinor: 100, merchant: merchant(index), category: 'other' }))
    }
    const queried = vi.spyOn(env.DB, 'prepare')

    const message = await chat.rich('/spend evol')

    // One for the user, one for the cards and one for the patterns, and then the two for the window.
    expect(queried).toHaveBeenCalledTimes(5)
    const lines = linesOf(message)
    expect(lines.slice(0, 3)).toEqual([
      'evol ••••1234: 1 Oct to 31 Oct',
      `The latest ${WINDOW_LIMIT} of ${WINDOW_LIMIT + 5} purchases:`,
      'Online and Mobile Contactless Spend',
    ])
    // A name is whole in its cell, however long it is.
    const listed = lines.filter((line) => line.includes('MERCHANT'))
    expect(listed).toHaveLength(WINDOW_LIMIT)
    expect(listed[0]).toBe(`${ids[5]} | 1 Oct | 1.00 | ${merchant(5)}`)
    expect(listed.at(-1)).toBe(`${ids.at(-1)} | 1 Oct | 1.00 | ${merchant(WINDOW_LIMIT + 4)}`)
    // What a table's purchases come to takes in those that are not listed.
    expect(lines).toContain('Total | 205.00')
    expect(lines).toContain(`Total: SGD 205.00 in ${WINDOW_LIMIT + 5} purchases, resets 1 Nov`)

    // Telegram takes 500 blocks in a rich message, with the rows of its tables counted among them, and 32,768
    // characters. As many purchases as are ever listed, with names as long as a name can be, are within both.
    const rows = message.blocks.flatMap((block) => (block.type === 'table' ? block.cells : []))
    expect(message.blocks.length + rows.length).toBeLessThan(500)
    expect(lines.join('\n').length).toBeLessThan(32768)
  })
})
