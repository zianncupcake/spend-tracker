import { describe, expect, it } from 'vitest'
import type { Product } from '../src/catalogue/types'
import { uobEvol } from '../src/catalogue/uob-evol'
import { breakDown } from '../src/domain/breakdown'
import type { Card, CategoryTotal, Transaction } from '../src/store'
import type { HeldPurchase } from '../src/store-held'
import type { Outgoing } from '../src/telegram/api'
import {
  heldButtons,
  heldLine,
  inMessages,
  purchaseBlocks,
  purchaseLine,
  purchaseTables,
  readHeldPress,
  readPress,
  sectionsOf,
  sortEnd,
  UNSURE_NOTE,
  whereSorted,
  type Dated,
  type Line,
  type Section,
  type Table,
} from '../src/telegram/purchases'
import { bareRow, bold, headerRow, purchaseRow, sumRow, tableOf } from './helpers'

/** The same card, were it to take a purchase to be nowhere until something says where it is. */
const NO_DEFAULT: Product = { ...uobEvol, defaultCategory: undefined }

function purchase(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 57,
    cardLast4: '1234',
    amountMinor: 1240,
    currency: 'SGD',
    merchant: 'COFFEE PLACE',
    occurredAt: 1_800_000_000,
    parser: 'example-bank',
    category: null,
    ...overrides,
  }
}

/** A purchase to list in a table: its id, the day that it is shown with, its amount and its merchant. */
function listed(
  id: number,
  date: string,
  amountMinor: number,
  merchant: string | null,
  overrides: Partial<Transaction> = {},
): Dated {
  return { ...purchase({ id, amountMinor, merchant, ...overrides }), date }
}

/** So much of the card's own currency, as what a section's purchases come to. */
function sgd(amountMinor: number) {
  return [{ currency: 'SGD', amountMinor }]
}

/** The stretch of a line that is to be marked as code. */
function markedIn({ text, marked }: Line): string | undefined {
  return marked && text.slice(marked.offset, marked.offset + marked.length)
}

/** A table as it is read: its name, and under the name the rows of its block. */
function shown({ name, header, rows, end }: Table): string {
  return [name, header, ...rows, ...end].filter((line) => line !== undefined).join('\n')
}

describe('the line of a purchase', () => {
  it('has its id, its day, its amount and its merchant, with the merchant to be marked as code', () => {
    const line = purchaseLine(purchase(), '5 Oct')

    expect(line.text).toBe('ID 57 · 5 Oct · SGD 12.40 · COFFEE PLACE')
    expect(markedIn(line)).toBe('COFFEE PLACE')
  })

  it('has a note of a purchase added by hand after the merchant, which alone is to be marked', () => {
    const line = purchaseLine(purchase({ currency: 'USD', parser: 'manual' }), '5 Oct')

    expect(line.text).toBe('ID 57 · 5 Oct · USD 12.40 · COFFEE PLACE · by hand')
    expect(markedIn(line)).toBe('COFFEE PLACE')
  })

  it('has nothing where the merchant would be, and nothing to mark, for a purchase with no merchant', () => {
    expect(purchaseLine(purchase({ merchant: null }), '5 Oct')).toEqual({ text: 'ID 57 · 5 Oct · SGD 12.40' })
    expect(purchaseLine(purchase({ merchant: null, parser: 'manual' }), '5 Oct')).toEqual({
      text: 'ID 57 · 5 Oct · SGD 12.40 · by hand',
    })
  })

  it('marks all of a name that Telegram would make something to tap of, and no more than the name', () => {
    // In UTF-16 code units, as the offsets of a message's entities are: the 𝒳 is two of them.
    const merchant = '𝒳 /disconnect https://attacker.test/x @someone #tag'
    const line = purchaseLine(purchase({ id: 123456, amountMinor: 123456789, merchant, parser: 'manual' }), '31 Oct')

    expect(line.text).toBe(`ID 123456 · 31 Oct · SGD 1,234,567.89 · ${merchant} · by hand`)
    expect(markedIn(line)).toBe(merchant)
    expect(line.marked?.length).toBe(merchant.length)
  })
})

describe('lines as messages', () => {
  const marked = (text: string): Line => ({ text, marked: { offset: 2, length: text.length - 2 } })

  it('are one message when Telegram takes them in one, with each marked stretch where its line is', () => {
    const lines = [
      { text: 'A heading' },
      { text: '' },
      marked('1 COFFEE PLACE'),
      marked('2 𝒳 BOOK SHOP'),
      { text: 'The end' },
    ]

    const [message, ...more] = inMessages(lines)

    expect(more).toEqual([])
    expect(message.text).toBe('A heading\n\n1 COFFEE PLACE\n2 𝒳 BOOK SHOP\nThe end')
    expect(message.entities).toEqual([
      { type: 'code', offset: 13, length: 12 },
      { type: 'code', offset: 28, length: 12 },
    ])
    expect(message.entities?.map(({ offset, length }) => message.text.slice(offset, offset + length))).toEqual([
      'COFFEE PLACE',
      '𝒳 BOOK SHOP',
    ])
  })

  it('have no entities when nothing is marked, and are no message at all when there are no lines', () => {
    expect(inMessages([{ text: 'One line' }, { text: 'Another' }])).toEqual([{ text: 'One line\nAnother' }])
    expect(inMessages([])).toEqual([])
    expect(inMessages([{ text: '' }, { text: '' }])).toEqual([])
  })

  it('go into a second message where one more line would take the first past 4,096 characters', () => {
    // 40 lines of 99 characters come to 3,999 with the line ends between them. A 41st of 96 makes it 4,096.
    const full = Array.from({ length: 40 }, (_, index) => ({ text: String(index).padEnd(99, 'x') }))

    const fits = inMessages([...full, { text: 'y'.repeat(96) }])
    const over = inMessages([...full, { text: 'y'.repeat(97) }])

    expect(fits.map((message) => message.text.length)).toEqual([4096])
    expect(over.map((message) => message.text.length)).toEqual([3999, 97])
    expect(over[0].text.endsWith('x')).toBe(true)
    expect(over[1].text).toBe('y'.repeat(97))
  })

  it('count the marked stretches of each message from where that message begins', () => {
    const lines = Array.from({ length: 150 }, (_, index) => marked(`${index % 10} ${'MERCHANT'.repeat(8)}`))

    const messages = inMessages(lines)

    expect(messages.length).toBeGreaterThan(1)
    expect(messages.map((message) => message.text).join('\n')).toBe(lines.map((line) => line.text).join('\n'))
    for (const { text, entities = [] } of messages) {
      expect(text.length).toBeLessThanOrEqual(4096)
      expect(entities).toHaveLength(text.split('\n').length)
      for (const { offset, length } of entities) expect(text.slice(offset, offset + length)).toBe('MERCHANT'.repeat(8))
    }
  })

  it('hold 100 marked stretches each at most, as Telegram makes nothing of those that come after', () => {
    const lines = Array.from({ length: 250 }, (_, index) => marked(`${index % 10} AB`))

    const messages = inMessages([{ text: 'A heading' }, ...lines, { text: 'The end' }])

    expect(messages.map((message) => message.entities?.length)).toEqual([100, 100, 50])
    expect(messages[0].text.startsWith('A heading\n0 AB\n')).toBe(true)
    expect(messages[2].text.endsWith('\n9 AB\nThe end')).toBe(true)
  })

  it('neither begin nor end with an empty line, wherever a message ends', () => {
    const long = { text: 'x'.repeat(2000) }
    const empty = { text: '' }

    const messages = inMessages([empty, long, empty, long, empty, empty, long, empty])

    // The second of the long lines fits with the first, and the third does not. An empty line is only ever between
    // two lines of one message.
    expect(messages.map((message) => message.text)).toEqual([`${long.text}\n\n${long.text}`, long.text])
  })
})

describe('the tables of a window', () => {
  it('are one for each section, with columns that line up from one table to the next', () => {
    const sections: Section[] = [
      {
        name: 'Online and Mobile Contactless Spend',
        purchases: [
          listed(2, '9 Oct', 4560, 'SAMPLE EATERY HOLDINGS PTE. LT'),
          listed(1, '9 Oct', 3825, 'example-shop-sg'),
        ],
        spent: sgd(8385),
        limitMinor: 30000,
      },
      { name: 'Selected Gym, Telco and Streaming Spend', purchases: [], spent: [], limitMinor: 20000 },
      {
        name: 'Other Spend',
        purchases: [listed(3, '9 Oct', 210, 'TRAIN FARE'), listed(6, '10 Oct', 185, 'TRAIN FARE')],
        spent: sgd(395),
      },
      { name: 'Overseas Foreign Currency Spend', purchases: [], spent: [] },
    ]

    const tables = purchaseTables(sections, 'SGD')

    // A table with no purchases has no header, and its numbers are under those of the tables that have one. What
    // has a limit ends with the limit and with what is left of it.
    expect(tables.map(shown).join('\n\n')).toBe(
      [
        'Online and Mobile Contactless Spend',
        'ID  Date       SGD  Merchant',
        ' 2   9 Oct   45.60  SAMPLE EATERY H…',
        ' 1   9 Oct   38.25  example-shop-sg',
        '    Total    83.85',
        '    Cap     300.00',
        '    Left    216.15',
        '',
        'Selected Gym, Telco and Streaming Spend',
        '    Total     0.00',
        '    Cap     200.00',
        '    Left    200.00',
        '',
        'Other Spend',
        'ID  Date       SGD  Merchant',
        ' 3   9 Oct    2.10  TRAIN FARE',
        ' 6  10 Oct    1.85  TRAIN FARE',
        '    Total     3.95',
        '',
        'Overseas Foreign Currency Spend',
        '    Total     0.00',
      ].join('\n'),
    )
    expect(tables.map((table) => table.header)).toEqual([tables[0].header, undefined, tables[0].header, undefined])
    expect(tables.map((table) => table.end.length)).toEqual([3, 3, 1, 1])
  })

  it('mark a purchase that was added by hand after its id, and have a dash where a merchant is not known', () => {
    const purchases = [
      listed(98, '30 Sep', 800, 'HAWKER', { parser: 'manual' }),
      listed(99, '1 Oct', 300, null),
      listed(100, '2 Oct', 123456, null, { parser: 'manual' }),
    ]

    const [table] = purchaseTables([{ purchases, spent: sgd(124556) }], 'SGD')

    // The ids are set to the right, as numbers are, under a header that begins where the widest of them does.
    expect(shown(table)).toBe(
      [
        'ID   Date         SGD  Merchant',
        ' 98* 30 Sep      8.00  HAWKER',
        ' 99   1 Oct      3.00  -',
        '100*  2 Oct  1,234.56  -',
        '     Total   1,245.56',
      ].join('\n'),
    )
    expect(table.name).toBeUndefined()
  })

  it('say how far past its limit the spend is, in place of what is left, once nothing is', () => {
    const online = (amountMinor: number): Section => ({ purchases: [], spent: sgd(amountMinor), limitMinor: 30000 })

    const [under, at, over] = purchaseTables([online(29999), online(30000), online(36240)], 'SGD')

    expect(under.end).toEqual(['    Total  299.99', '    Cap    300.00', '    Left     0.01'])
    expect(at.end).toEqual(['    Total  300.00', '    Cap    300.00', '    Left     0.00'])
    expect(over.end).toEqual(['    Total  362.40', '    Cap    300.00', '    Over    62.40'])
  })

  it('have the code of its currency on every amount of a table that holds more than one, and total each', () => {
    const sections: Section[] = [
      {
        name: 'Online and Mobile Contactless Spend',
        purchases: [listed(7, '5 Oct', 1240, 'COFFEE PLACE'), listed(8, '6 Oct', 500, 'AIRLINE', { currency: 'USD' })],
        spent: [...sgd(1240), { currency: 'USD', amountMinor: 500 }],
        limitMinor: 30000,
      },
      { name: 'Other Spend', purchases: [listed(9, '7 Oct', 300, 'HAWKER')], spent: sgd(300) },
    ]

    // The limit is held against what was spent in the card's own currency, which is all that is known in it. A
    // table of one currency keeps its plain numbers, in a column as wide as the other table makes it.
    expect(purchaseTables(sections, 'SGD').map(shown).join('\n\n')).toBe(
      [
        'Online and Mobile Contactless Spend',
        'ID  Date       Amount  Merchant',
        ' 7  5 Oct   SGD 12.40  COFFEE PLACE',
        ' 8  6 Oct    USD 5.00  AIRLINE',
        '    Total   SGD 12.40',
        '    Total    USD 5.00',
        '    Cap    SGD 300.00',
        '    Left   SGD 287.60',
        '',
        'Other Spend',
        'ID  Date          SGD  Merchant',
        ' 9  7 Oct        3.00  HAWKER',
        '    Total        3.00',
      ].join('\n'),
    )
  })

  it('name the one currency of a table in its header, whether or not it is the currency of the card', () => {
    const abroad = { currency: 'USD', amountMinor: 1740 }
    const purchases = [
      listed(4, '1 Oct', 500, 'AIRLINE', { currency: 'USD' }),
      listed(5, '2 Oct', 1240, 'HOTEL', { currency: 'USD' }),
    ]

    const [listing, unlisted, limited] = purchaseTables(
      [
        { purchases, spent: [abroad] },
        // None of its purchases is among those that are listed, so it has no header to name their currency.
        { purchases: [], spent: [abroad] },
        // A limit is in the card's own currency, so this table holds two.
        { purchases, spent: [abroad], limitMinor: 30000 },
      ],
      'SGD',
    )

    expect(shown(listing)).toBe(
      [
        'ID  Date          USD  Merchant',
        ' 4  1 Oct        5.00  AIRLINE',
        ' 5  2 Oct       12.40  HOTEL',
        '    Total       17.40',
      ].join('\n'),
    )
    expect(shown(unlisted)).toBe('    Total   USD 17.40')
    expect(shown(limited)).toBe(
      [
        'ID  Date       Amount  Merchant',
        ' 4  1 Oct    USD 5.00  AIRLINE',
        ' 5  2 Oct   USD 12.40  HOTEL',
        '    Total   USD 17.40',
        '    Cap    SGD 300.00',
        '    Left   SGD 300.00',
      ].join('\n'),
    )
  })

  it('cut a merchant short to what the other columns leave, so that no row is longer than 36 characters', () => {
    const purchases = [
      listed(1, '5 Oct', 1240, 'EIGHTEEN LETTERS X'),
      listed(2, '5 Oct', 1240, 'SAMPLE EATERY HOLDINGS PTE. LT'),
      // The name is not left to end with a space before the ellipsis.
      listed(3, '5 Oct', 1240, 'SIXTEEN LETTERS! AND MORE'),
      // A character that is two code units in a string is one character of a row, and is not cut in half.
      listed(4, '5 Oct', 1240, '𝒳'.repeat(30)),
      listed(5, '5 Oct', 1240, `SEVENTEEN LETTERS${'𝒳'.repeat(5)}`),
    ]

    const [table] = purchaseTables([{ purchases, spent: sgd(6200) }], 'SGD')

    expect(table.rows).toEqual([
      ' 1  5 Oct  12.40  EIGHTEEN LETTERS X',
      ' 2  5 Oct  12.40  SAMPLE EATERY HOL…',
      ' 3  5 Oct  12.40  SIXTEEN LETTERS!…',
      ` 4  5 Oct  12.40  ${'𝒳'.repeat(17)}…`,
      ' 5  5 Oct  12.40  SEVENTEEN LETTERS…',
    ])
    for (const row of [table.header ?? '', ...table.rows, ...table.end]) expect([...row].length).toBeLessThanOrEqual(36)
    expect([...table.rows[0]]).toHaveLength(36)
    expect([...table.rows[3]]).toHaveLength(36)
  })

  it('give the merchant less room as the other columns grow, and leave it out where they leave it none', () => {
    const wide = listed(123456, '25 Dec', 123456789, 'COFFEE PLACE')
    const widest = listed(123456789012345, '25 Dec', 99999999999999, 'COFFEE PLACE', { currency: 'USD' })

    const [table] = purchaseTables([{ purchases: [wide], spent: sgd(123456789) }], 'SGD')
    const [mixed] = purchaseTables([{ purchases: [wide, widest], spent: [...sgd(123456789)] }], 'SGD')

    expect(shown(table)).toBe(
      [
        'ID      Date             SGD  Merch…',
        '123456  25 Dec  1,234,567.89  COFFE…',
        '        Total   1,234,567.89',
      ].join('\n'),
    )
    for (const row of [table.header ?? '', ...table.rows]) expect(row).toHaveLength(36)
    // The ids and the amounts are never cut. Where they leave no room at all, a row ends with its amount.
    expect(mixed.rows).toEqual([
      '         123456  25 Dec        SGD 1,234,567.89',
      '123456789012345  25 Dec  USD 999,999,999,999.99',
    ])
  })
})

describe('the tables of a window as the blocks of a rich message', () => {
  it('are a table with lines for each section, under its name in bold: a header, the purchases and the sums', () => {
    const sections: Section[] = [
      {
        name: 'Online and Mobile Contactless Spend',
        purchases: [
          listed(2, '9 Oct', 4560, 'SAMPLE EATERY HOLDINGS PTE. LT'),
          listed(1, '9 Oct', 3825, 'example-shop-sg'),
        ],
        spent: sgd(8385),
        limitMinor: 30000,
      },
      { name: 'Selected Gym, Telco and Streaming Spend', purchases: [], spent: [], limitMinor: 20000 },
      { name: 'Overseas Foreign Currency Spend', purchases: [], spent: [] },
    ]

    expect(purchaseBlocks(sections, 'SGD')).toEqual([
      { type: 'paragraph', text: { type: 'bold', text: 'Online and Mobile Contactless Spend' } },
      {
        type: 'table',
        is_bordered: true,
        cells: [
          // The cells of the header are header cells. The amounts are set to the right, and so is what heads them.
          [
            { text: 'ID', is_header: true },
            { text: 'Date', is_header: true },
            { text: 'SGD', is_header: true, align: 'right' },
            { text: 'Merchant', is_header: true },
          ],
          // An id is set to the right, as a number is. A name is whole, however long it is.
          [
            { text: '2', align: 'right' },
            { text: '9 Oct' },
            { text: '45.60', align: 'right' },
            { text: 'SAMPLE EATERY HOLDINGS PTE. LT' },
          ],
          [
            { text: '1', align: 'right' },
            { text: '9 Oct' },
            { text: '38.25', align: 'right' },
            { text: 'example-shop-sg' },
          ],
          // What sums the table up is named across the columns of the id and the day, with its amount under the
          // amounts and nothing under the merchants.
          [{ text: 'Total', colspan: 2 }, { text: '83.85', align: 'right' }, { text: '' }],
          [{ text: 'Cap', colspan: 2 }, { text: '300.00', align: 'right' }, { text: '' }],
          [{ text: 'Left', colspan: 2 }, { text: '216.15', align: 'right' }, { text: '' }],
        ],
      },
      { type: 'paragraph', text: { type: 'bold', text: 'Selected Gym, Telco and Streaming Spend' } },
      // A table with no purchases is what sums it up alone: what each amount is called, and the amount.
      {
        type: 'table',
        is_bordered: true,
        cells: [
          [{ text: 'Total' }, { text: '0.00', align: 'right' }],
          [{ text: 'Cap' }, { text: '200.00', align: 'right' }],
          [{ text: 'Left' }, { text: '200.00', align: 'right' }],
        ],
      },
      { type: 'paragraph', text: { type: 'bold', text: 'Overseas Foreign Currency Spend' } },
      { type: 'table', is_bordered: true, cells: [[{ text: 'Total' }, { text: '0.00', align: 'right' }]] },
    ])
  })

  it('mark a purchase that was added by hand after its id, and have a dash where a merchant is not known', () => {
    const purchases = [
      listed(98, '30 Sep', 800, 'HAWKER', { parser: 'manual' }),
      listed(99, '1 Oct', 300, null),
      listed(100, '2 Oct', 123456, '', { parser: 'manual' }),
    ]

    // The one table of a card with no product has no name, and so no paragraph above it.
    expect(purchaseBlocks([{ purchases, spent: sgd(124556) }], 'SGD')).toEqual([
      tableOf(
        headerRow('SGD'),
        purchaseRow('98*', '30 Sep', '8.00', 'HAWKER'),
        purchaseRow(99, '1 Oct', '3.00', '-'),
        purchaseRow('100*', '2 Oct', '1,234.56', '-'),
        sumRow('Total', '1,245.56'),
      ),
    ])
  })

  it('say how far past its limit the spend is, in place of what is left, once nothing is', () => {
    const online = (amountMinor: number): Section => ({ purchases: [], spent: sgd(amountMinor), limitMinor: 30000 })

    expect(purchaseBlocks([online(29999), online(30000), online(36240)], 'SGD')).toEqual([
      tableOf(bareRow('Total', '299.99'), bareRow('Cap', '300.00'), bareRow('Left', '0.01')),
      tableOf(bareRow('Total', '300.00'), bareRow('Cap', '300.00'), bareRow('Left', '0.00')),
      tableOf(bareRow('Total', '362.40'), bareRow('Cap', '300.00'), bareRow('Over', '62.40')),
    ])
  })

  it('have the code of its currency on every amount of a table that holds more than one, and total each', () => {
    const abroad = { currency: 'USD', amountMinor: 500 }
    const flight = listed(8, '6 Oct', 500, 'AIRLINE', { currency: 'USD' })
    const sections: Section[] = [
      {
        name: 'Online and Mobile Contactless Spend',
        purchases: [listed(7, '5 Oct', 1240, 'COFFEE PLACE'), flight],
        spent: [...sgd(1240), abroad],
        limitMinor: 30000,
      },
      // A table of one currency names it in its header, whether or not it is the currency of the card.
      { name: 'Overseas Foreign Currency Spend', purchases: [flight], spent: [abroad] },
      // None of its purchases is among those that are listed, so it has no header to name their currency.
      { name: 'Not sorted', purchases: [], spent: [abroad] },
    ]

    // The limit is held against what was spent in the card's own currency, which is all that is known in it.
    expect(purchaseBlocks(sections, 'SGD')).toEqual([
      bold('Online and Mobile Contactless Spend'),
      tableOf(
        headerRow('Amount'),
        purchaseRow(7, '5 Oct', 'SGD 12.40', 'COFFEE PLACE'),
        purchaseRow(8, '6 Oct', 'USD 5.00', 'AIRLINE'),
        sumRow('Total', 'SGD 12.40'),
        sumRow('Total', 'USD 5.00'),
        sumRow('Cap', 'SGD 300.00'),
        sumRow('Left', 'SGD 287.60'),
      ),
      bold('Overseas Foreign Currency Spend'),
      tableOf(headerRow('USD'), purchaseRow(8, '6 Oct', '5.00', 'AIRLINE'), sumRow('Total', '5.00')),
      bold('Not sorted'),
      tableOf(bareRow('Total', 'USD 5.00')),
    ])
  })

  it("have a merchant's name as plain text, whole and as it is written, whatever Telegram could make of it", () => {
    // A command, a mention, a link and a hashtag, what markup is written with, and a character of two code units.
    const hostile = '𝒳 /disconnect @someone https://attacker.test/x #tag <b>bold</b> **bold** `code` [x](tg://x)'
    const long = 'SAMPLE EATERY HOLDINGS PTE. LT '.repeat(3).trim()
    const purchases = [listed(1, '5 Oct', 1240, hostile), listed(2, '5 Oct', 1240, long)]

    const [block] = purchaseBlocks([{ purchases, spent: sgd(2480) }], 'SGD')

    expect(block).toEqual(
      tableOf(
        headerRow('SGD'),
        purchaseRow(1, '5 Oct', '12.40', hostile),
        purchaseRow(2, '5 Oct', '12.40', long),
        sumRow('Total', '24.80'),
      ),
    )
    // No text of a table is anything but a string, in which Telegram takes nothing for markup.
    const cells = block.type === 'table' ? block.cells.flat() : []
    expect(cells).toHaveLength(4 + 4 + 4 + 3)
    for (const cell of cells) expect(typeof cell.text).toBe('string')
  })
})

describe('the sections of a window', () => {
  /** What a window's purchases come to, as the store sums them: for a currency and a category at a time. */
  function sum(category: string | null, amountMinor: number, currency = 'SGD'): CategoryTotal {
    return { category, amountMinor, currency, count: 1 }
  }

  /** The sections with the ids of their purchases, which is how a test tells the purchases apart. */
  function told(sections: Section[]) {
    return sections.map(({ name, purchases, spent, limitMinor }) => ({
      name,
      ids: purchases.map((each) => each.id),
      spent,
      limitMinor,
    }))
  }

  const purchases = [
    listed(1, '1 Oct', 100, 'BOOK SHOP', { category: 'online' }),
    listed(2, '2 Oct', 200, 'COFFEE PLACE'),
    listed(3, '3 Oct', 300, 'HAWKER', { category: 'other' }),
    listed(4, '4 Oct', 400, 'NETFLIX.COM', { category: 'selected' }),
    listed(5, '5 Oct', 500, 'AIRLINE', { currency: 'USD', category: 'fx' }),
    // A category of a product that the card was linked to before is none of this product's.
    listed(6, '6 Oct', 600, 'CORNER CAFE', { category: 'dining' }),
  ]
  // With more spent on the physical card than the one purchase that is listed.
  const sums = [
    sum('dining', 600),
    sum('online', 100),
    sum('other', 10300),
    sum('selected', 400),
    sum(null, 200),
    sum('fx', 500, 'USD'),
  ]

  it('are one for each group of the product, in its order, with the purchases that are in the group', () => {
    const sections = sectionsOf(uobEvol, breakDown(uobEvol, sums), purchases)

    // What a section's purchases come to is what the breakdown says, which takes in those that are not listed.
    expect(told(sections)).toEqual([
      { name: 'Online and Mobile Contactless Spend', ids: [1, 2, 6], spent: sgd(900), limitMinor: 30000 },
      { name: 'Selected Gym, Telco and Streaming Spend', ids: [4], spent: sgd(400), limitMinor: 20000 },
      { name: 'Other Spend', ids: [3], spent: sgd(10300), limitMinor: undefined },
      {
        name: 'Overseas Foreign Currency Spend',
        ids: [5],
        spent: [{ currency: 'USD', amountMinor: 500 }],
        limitMinor: undefined,
      },
    ])
  })

  it('are there for every group when nothing was bought, so that each limit is seen', () => {
    expect(told(sectionsOf(uobEvol, breakDown(uobEvol, []), []))).toEqual([
      { name: 'Online and Mobile Contactless Spend', ids: [], spent: [], limitMinor: 30000 },
      { name: 'Selected Gym, Telco and Streaming Spend', ids: [], spent: [], limitMinor: 20000 },
      { name: 'Other Spend', ids: [], spent: [], limitMinor: undefined },
      { name: 'Overseas Foreign Currency Spend', ids: [], spent: [], limitMinor: undefined },
    ])
  })

  it('end with what is not sorted, on a product with no default category', () => {
    const sections = sectionsOf(NO_DEFAULT, breakDown(NO_DEFAULT, sums), purchases)

    expect(told(sections).map(({ name, ids }) => [name, ids])).toEqual([
      ['Online and Mobile Contactless Spend', [1]],
      ['Selected Gym, Telco and Streaming Spend', [4]],
      ['Other Spend', [3]],
      ['Overseas Foreign Currency Spend', [5]],
      ['Not sorted', [2, 6]],
    ])
    expect(told(sections)[4]).toEqual({ name: 'Not sorted', ids: [2, 6], spent: sgd(800), limitMinor: undefined })
    // With nothing left for its user to sort, such a product has no more sections than its groups.
    const sorted = sums.filter((each) => each.category !== null && each.category !== 'dining')
    expect(sectionsOf(NO_DEFAULT, breakDown(NO_DEFAULT, sorted), [])).toHaveLength(4)
  })
})

describe('tables as messages', () => {
  const HEADER = 'ID  Date     SGD  Merchant'

  /** A row of a table, of the 36 characters that a row can have. */
  const row = (index: number) => `ROW ${index} `.padEnd(36, '.')

  /** The blocks of a message: each stretch of its text that is set as the rows of a table. */
  const blocksIn = ({ text, entities = [] }: Outgoing) =>
    entities.map(({ type, offset, length }) => ({ type, rows: text.slice(offset, offset + length) }))

  it('are each a block of their own, of all their rows and of nothing else: not of the name above them', () => {
    const first: Table = { name: 'Online', header: HEADER, rows: [row(1), row(2)], end: ['Total', 'Cap', 'Left'] }
    const second: Table = { name: 'Gym', rows: [], end: ['Total'] }
    const gap = { text: '' }

    const [message, ...more] = inMessages([{ text: 'A heading' }, gap, first, gap, second, gap, { text: 'The end' }])

    const rows = [HEADER, row(1), row(2), 'Total', 'Cap', 'Left'].join('\n')
    expect(more).toEqual([])
    expect(message.text).toBe(`A heading\n\nOnline\n${rows}\n\nGym\nTotal\n\nThe end`)
    expect(blocksIn(message)).toEqual([
      { type: 'pre', rows },
      { type: 'pre', rows: 'Total' },
    ])
    // From the first character of a block's first row to the last of its last row, with no line end to either side.
    expect(message.entities).toEqual([
      { type: 'pre', offset: 'A heading\n\nOnline\n'.length, length: rows.length },
      { type: 'pre', offset: `A heading\n\nOnline\n${rows}\n\nGym\n`.length, length: 5 },
    ])
  })

  it('are counted from where they begin in UTF-16 code units, of which a character before them can be two', () => {
    const first: Table = { name: '𝒳 one', header: HEADER, rows: [`${row(1)} 𝒳𝒳`], end: ['Total'] }
    const second: Table = { name: 'Two', header: HEADER, rows: [row(2)], end: ['Total'] }

    const [message] = inMessages([first, { text: '' }, second])

    expect(blocksIn(message)).toEqual([
      { type: 'pre', rows: [HEADER, `${row(1)} 𝒳𝒳`, 'Total'].join('\n') },
      { type: 'pre', rows: [HEADER, row(2), 'Total'].join('\n') },
    ])
    // Each 𝒳 is two code units: the one in the name, and the two in the row.
    expect(message.entities?.[0]).toEqual({ type: 'pre', offset: 7, length: HEADER.length + 1 + 41 + 6 })
    expect(message.entities?.[1].offset).toBe(7 + HEADER.length + 1 + 41 + 6 + '\n\nTwo\n'.length)
  })

  it('go on in the next message under their header again, each message with a block for the rows it holds', () => {
    const rows = Array.from({ length: 250 }, (_, index) => row(index))
    const table: Table = { name: 'Online', header: HEADER, rows, end: ['Total', 'Cap', 'Left'] }

    const messages = inMessages([{ text: 'A heading' }, { text: '' }, table, { text: '' }, { text: 'The end' }])

    // 250 rows of 36 characters, with their line ends, are more than two messages take.
    expect(messages).toHaveLength(3)
    for (const message of messages) expect(message.text.length).toBeLessThanOrEqual(4096)
    const blocks = messages.map(blocksIn)
    expect(blocks.map((each) => each.map((block) => block.type))).toEqual([['pre'], ['pre'], ['pre']])
    // A block is all of its message but what is no row of the table.
    expect(messages[0].text).toBe(`A heading\n\nOnline\n${blocks[0][0].rows}`)
    expect(messages[1].text).toBe(blocks[1][0].rows)
    expect(messages[2].text).toBe(`${blocks[2][0].rows}\n\nThe end`)
    // Every block begins with the header. Without it, the blocks are the rows of the table, each of them once.
    const held = blocks.map(([block]) => block.rows.split('\n'))
    for (const each of held) expect(each[0]).toBe(HEADER)
    expect(held.flatMap((each) => each.slice(1))).toEqual([...rows, 'Total', 'Cap', 'Left'])
    expect(held[0].length).toBeGreaterThan(100)
  })

  it('begin in the next message when the name fits in this one and the first row under it does not', () => {
    // 40 lines of 99 characters and one of 60 come to 4,060 with the line ends between them. An empty line and the
    // name make it 4,068, and the header and one row would take it past 4,096.
    const full = Array.from({ length: 40 }, (_, index) => ({ text: String(index).padEnd(99, 'x') }))
    const table: Table = { name: 'Online', header: HEADER, rows: [row(1)], end: ['Total'] }

    const messages = inMessages([...full, { text: 'y'.repeat(60) }, { text: '' }, table])

    expect(messages.map((message) => message.text.length)).toEqual([4060, 6 + 1 + HEADER.length + 1 + 36 + 1 + 5])
    expect(messages[0].text.endsWith(`x\n${'y'.repeat(60)}`)).toBe(true)
    expect(messages[0].entities).toBeUndefined()
    expect(messages[1].text).toBe(['Online', HEADER, row(1), 'Total'].join('\n'))
    expect(blocksIn(messages[1])).toEqual([{ type: 'pre', rows: [HEADER, row(1), 'Total'].join('\n') }])
  })

  it('keep the rows that sum them up together, in the next message when this one has no room for them all', () => {
    // 40 lines of 99 characters and one of 20 come to 4,020. The header and a row make it 4,084, which leaves room
    // for the first of the three rows that sum the table up and not for all of them.
    const full = Array.from({ length: 40 }, (_, index) => ({ text: String(index).padEnd(99, 'x') }))
    const table: Table = { header: HEADER, rows: [row(1)], end: ['Total', 'Cap', 'Left'] }

    const messages = inMessages([...full, { text: 'y'.repeat(20) }, table, { text: 'The end' }])

    expect(messages.map((message) => message.text.length)).toEqual([4084, HEADER.length + 1 + 14 + 1 + 7])
    expect(blocksIn(messages[0])).toEqual([{ type: 'pre', rows: [HEADER, row(1)].join('\n') }])
    expect(messages[1].text).toBe([HEADER, 'Total', 'Cap', 'Left', 'The end'].join('\n'))
    expect(blocksIn(messages[1])).toEqual([{ type: 'pre', rows: [HEADER, 'Total', 'Cap', 'Left'].join('\n') }])
  })

  it('are a block each in a message that holds the end of one table and the whole of the next', () => {
    const rows = Array.from({ length: 120 }, (_, index) => row(index))
    const first: Table = { name: 'Online', header: HEADER, rows, end: ['Total'] }
    const second: Table = { name: 'Gym', rows: [], end: ['Total', 'Cap', 'Left'] }

    const [, last, ...more] = inMessages([first, { text: '' }, second, { text: '' }, { text: 'The end' }])

    expect(more).toEqual([])
    const [continued, whole] = blocksIn(last)
    expect(continued.rows.startsWith(`${HEADER}\nROW `)).toBe(true)
    expect(continued.rows.endsWith(`${row(119)}\nTotal`)).toBe(true)
    expect(whole).toEqual({ type: 'pre', rows: 'Total\nCap\nLeft' })
    expect(last.text).toBe(`${continued.rows}\n\nGym\n${whole.rows}\n\nThe end`)
  })
})

describe('where a purchase is sorted', () => {
  it('is the name of its category, which is online for one that nothing else is stored for', () => {
    expect(whereSorted(uobEvol, null)).toBe('Online / Mobile Contactless Spend')
    expect(whereSorted(uobEvol, 'online')).toBe('Online / Mobile Contactless Spend')
    expect(whereSorted(uobEvol, 'other')).toBe('Other Spend')
    expect(whereSorted(uobEvol, 'selected')).toBe('Selected Gym, Telco and Streaming Spend')
    expect(whereSorted(uobEvol, 'fx')).toBe('Overseas Foreign Currency Spend')
    // The category of another product is none of this one's, so it says nothing of where the purchase is.
    expect(whereSorted(uobEvol, 'dining')).toBe('Online / Mobile Contactless Spend')
  })

  it('is not sorted, on a product with no default, for a purchase that nothing is stored for', () => {
    expect(whereSorted(NO_DEFAULT, null)).toBe('not sorted')
    expect(whereSorted(NO_DEFAULT, 'dining')).toBe('not sorted')
    expect(whereSorted(NO_DEFAULT, 'other')).toBe('Other Spend')
  })

  it('ends a message with the one button that flags an online purchase as made with the physical card', () => {
    const online = {
      line: 'ID 57: Online / Mobile Contactless Spend',
      buttons: [[{ text: 'Mark as Other Spend', data: '57:other' }]],
    }

    expect(sortEnd(uobEvol, { id: 57, category: null })).toEqual(online)
    expect(sortEnd(uobEvol, { id: 57, category: 'online' })).toEqual(online)
    expect(sortEnd(uobEvol, { id: 57, category: 'dining' })).toEqual(online)
  })

  it('ends a message with the one button that takes the flag off a purchase that has it', () => {
    expect(sortEnd(uobEvol, { id: 57, category: 'other' })).toEqual({
      line: 'ID 57: Other Spend',
      buttons: [[{ text: 'Mark as Online / Mobile Contactless Spend', data: '57:online' }]],
    })
  })

  it('ends a message with both buttons, a row to each, for a purchase that a rule placed', () => {
    const both = [
      [{ text: 'Mark as Online / Mobile Contactless Spend', data: '57:online' }],
      [{ text: 'Mark as Other Spend', data: '57:other' }],
    ]

    expect(sortEnd(uobEvol, { id: 57, category: 'selected' })).toEqual({
      line: 'ID 57: Selected Gym, Telco and Streaming Spend',
      buttons: both,
    })
    expect(sortEnd(uobEvol, { id: 57, category: 'fx' })).toEqual({
      line: 'ID 57: Overseas Foreign Currency Spend',
      buttons: both,
    })
    // And for one that nothing has placed, on a product with no default.
    expect(sortEnd(NO_DEFAULT, { id: 57, category: null })).toEqual({ line: 'ID 57: not sorted', buttons: both })
  })
})

describe('what a button sends back', () => {
  it('is read as the purchase and the category', () => {
    expect(readPress('57:online')).toEqual({ purchaseId: 57, category: 'online' })
    expect(readPress('57:other')).toEqual({ purchaseId: 57, category: 'other' })
    expect(readPress('999999999999999:made-up-2')).toEqual({ purchaseId: 999_999_999_999_999, category: 'made-up-2' })
  })

  it.each([
    '57',
    '57:',
    ':online',
    // What a button held when a press could still be followed by the next purchase to sort.
    '57:online:next',
    '-57:online',
    '57:Online',
    ' 57:online',
    '57:online\n58:online',
    '1234567890123456:online',
  ])('is not read when it is %j, which no button holds', (data) => {
    expect(readPress(data)).toBeNull()
  })
})

describe('the line of a purchase that is held', () => {
  /** A purchase that is held: one that the model was not sure of, unless said otherwise. */
  function waiting(overrides: Partial<HeldPurchase> = {}): HeldPurchase {
    const read = { occurredAt: 1_800_000_000, amountMinor: 1240, currency: 'SGD', merchant: 'COFFEE PLACE' }
    return { place: 0, ...read, unsure: true, ...overrides }
  }

  it('has its day, its amount and its merchant, with the merchant to be marked as code, and no id', () => {
    const line = heldLine(waiting(), '5 Oct', false)

    expect(line.text).toBe('5 Oct · SGD 12.40 · COFFEE PLACE')
    expect(markedIn(line)).toBe('COFFEE PLACE')
  })

  it('says that the model was not sure of it, after the merchant, when it is to say so and the model was not', () => {
    const line = heldLine(waiting({ currency: 'USD' }), '5 Oct', true)

    expect(line.text).toBe('5 Oct · USD 12.40 · COFFEE PLACE · not sure')
    expect(markedIn(line)).toBe('COFFEE PLACE')
    // One that the model was sure of has no such note, whether or not the lines of its message are to have it.
    expect(heldLine(waiting({ unsure: false }), '5 Oct', true).text).toBe('5 Oct · SGD 12.40 · COFFEE PLACE')
  })

  it('has nothing where the merchant would be, and nothing to mark, for a purchase with no merchant', () => {
    expect(heldLine(waiting({ merchant: null }), '5 Oct', false)).toEqual({ text: '5 Oct · SGD 12.40' })
    expect(heldLine(waiting({ merchant: null }), '5 Oct', true)).toEqual({ text: '5 Oct · SGD 12.40 · not sure' })
  })

  it('marks all of a name that Telegram would make something to tap of, and no more than the name', () => {
    const merchant = '𝒳 /disconnect https://attacker.test/x @someone #tag'
    const line = heldLine(waiting({ amountMinor: 123456789, merchant }), '31 Oct', true)

    expect(line.text).toBe(`31 Oct · SGD 1,234,567.89 · ${merchant} · not sure`)
    expect(markedIn(line)).toBe(merchant)
    expect(line.marked?.length).toBe(merchant.length)
  })

  it('is what a message says to look for, in the words of its note', () => {
    expect(UNSURE_NOTE).toBe('Check the amount and the date of each one that is marked "not sure".')
  })
})

describe('the buttons under purchases that are held', () => {
  const cards: Card[] = [
    { nickname: 'visa', last4: '1234', windowType: 'calendar' },
    { nickname: 'my_evol-2', last4: '0005', windowType: 'statement', statementDay: 15, product: 'uob-evol' },
  ]

  it('are one that adds them and one that skips them, a row to each, when the card is known', () => {
    expect(heldButtons(7001, 3)).toEqual([
      [{ text: 'Add these 3', data: 'held:7001:add' }],
      [{ text: 'Skip', data: 'held:7001:skip' }],
    ])
    // In the words for one, of one.
    expect(heldButtons(7001, 1)[0]).toEqual([{ text: 'Add this one', data: 'held:7001:add' }])
  })

  it('are one for each card and one that skips, when the bot could not tell which card', () => {
    expect(heldButtons(7001, 3, cards)).toEqual([
      // What a button holds of a card is its last four digits.
      [{ text: 'Add to visa', data: 'held:7001:1234' }],
      [{ text: 'Add to my_evol-2', data: 'held:7001:0005' }],
      [{ text: 'Skip', data: 'held:7001:skip' }],
    ])
  })

  it('hold no more than the 64 bytes that Telegram takes, for the longest id that a message can have', () => {
    const buttons = heldButtons(999_999_999_999_999, 20, cards).flat()

    for (const { data } of buttons) expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64)
  })

  it('send back what is read as the message and the choice', () => {
    for (const { data } of heldButtons(7001, 3, cards).flat()) expect(readHeldPress(data)).not.toBeNull()

    expect(readHeldPress('held:7001:add')).toEqual({ messageId: 7001, choice: 'add' })
    expect(readHeldPress('held:7001:skip')).toEqual({ messageId: 7001, choice: 'skip' })
    expect(readHeldPress('held:7001:0005')).toEqual({ messageId: 7001, choice: '0005' })
    expect(readHeldPress('held:999999999999999:add')).toMatchObject({ messageId: 999_999_999_999_999 })
  })

  it.each([
    'held:7001:',
    'held::add',
    'held:7001:remove',
    'held:7001:123',
    'held:7001:12345',
    'held:7001:Add',
    'held:-7001:add',
    'held:1234567890123456:add',
    ' held:7001:add',
    'held:7001:add\nheld:7002:add',
    // Written as what a button that moves a purchase holds is: with no word before the id.
    '7001:add',
  ])('send back nothing that is read when it is %j, which none of them holds', (data) => {
    expect(readHeldPress(data)).toBeNull()
  })

  it('hold nothing that is read as what a button that moves a purchase holds, and the other way about', () => {
    for (const { data } of heldButtons(57, 3, cards).flat()) expect(readPress(data)).toBeNull()

    expect(readHeldPress('57:other')).toBeNull()
  })
})
