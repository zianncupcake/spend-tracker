import { describe, expect, it } from 'vitest'
import { uobEvol } from '../src/catalogue/uob-evol'
import type { Transaction } from '../src/store'
import {
  inMessages,
  purchaseLine,
  readPress,
  sortedLine,
  sortEnd,
  whereSorted,
  type Line,
} from '../src/telegram/purchases'

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

/** The stretch of a line that is to be marked as code. */
function markedIn({ text, marked }: Line): string | undefined {
  return marked && text.slice(marked.offset, marked.offset + marked.length)
}

describe('the line of a purchase', () => {
  it('has its id, its day, its amount and its merchant, with the merchant to be marked as code', () => {
    const line = purchaseLine(purchase(), '5 Oct')

    expect(line.text).toBe('#57 5 Oct · SGD 12.40 · COFFEE PLACE')
    expect(markedIn(line)).toBe('COFFEE PLACE')
  })

  it('has the category after the merchant when one is given, and a note of a purchase added by hand', () => {
    const byHand = purchase({ parser: 'manual' })

    expect(purchaseLine(purchase(), '5 Oct', 'Online').text).toBe('#57 5 Oct · SGD 12.40 · COFFEE PLACE · Online')
    expect(purchaseLine(byHand, '5 Oct').text).toBe('#57 5 Oct · SGD 12.40 · COFFEE PLACE · by hand')

    const line = purchaseLine({ ...byHand, currency: 'USD' }, '5 Oct', 'Gym, telco and streaming')
    expect(line.text).toBe('#57 5 Oct · USD 12.40 · COFFEE PLACE · Gym, telco and streaming · by hand')
    expect(markedIn(line)).toBe('COFFEE PLACE')
  })

  it('has nothing where the merchant would be, and nothing to mark, for a purchase with no merchant', () => {
    const line = purchaseLine(purchase({ merchant: null, parser: 'manual' }), '5 Oct', 'not sorted')

    expect(line).toEqual({ text: '#57 5 Oct · SGD 12.40 · not sorted · by hand' })
  })

  it('marks all of a name that Telegram would make something to tap of, and no more than the name', () => {
    // In UTF-16 code units, as the offsets of a message's entities are: the 𝒳 is two of them.
    const merchant = '𝒳 /disconnect https://attacker.test/x @someone #tag'
    const line = purchaseLine(purchase({ id: 123456, amountMinor: 123456789, merchant }), '31 Oct', 'Online')

    expect(line.text).toBe(`#123456 31 Oct · SGD 1,234,567.89 · ${merchant} · Online`)
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

describe('where a purchase is sorted', () => {
  it('is the name of its category, or that it is not sorted', () => {
    expect(whereSorted(uobEvol, 'mobile')).toBe('Phone tap')
    expect(whereSorted(uobEvol, 'fx')).toBe('Foreign currency')
    expect(whereSorted(uobEvol, null)).toBe('not sorted')
    // The category of another product is none of this one's.
    expect(whereSorted(uobEvol, 'dining')).toBe('not sorted')
    expect(sortedLine(uobEvol, { id: 57, category: 'excluded' })).toBe("#57: Doesn't count")
    expect(sortedLine(uobEvol, { id: 57, category: null })).toBe('#57: not sorted')
  })

  it('ends a message with the buttons that sort the purchase, a row to each, while it is not sorted', () => {
    expect(sortEnd(uobEvol, { id: 57, category: null })).toEqual({
      line: '#57: not sorted. Which was it?',
      buttons: [
        [{ text: 'Online', data: '57:online' }],
        [{ text: 'Phone tap', data: '57:mobile' }],
        [{ text: 'Physical card or other', data: '57:other' }],
        [{ text: "Doesn't count", data: '57:excluded' }],
      ],
    })
  })

  it('ends a message with no buttons once the purchase is sorted, unless they are asked for', () => {
    expect(sortEnd(uobEvol, { id: 57, category: 'selected' })).toEqual({ line: '#57: Gym, telco and streaming' })
    expect(sortEnd(uobEvol, { id: 57, category: 'mobile' })).toEqual({ line: '#57: Phone tap' })

    // Asked for, they come with the one for where the purchase is now ticked.
    const asked = sortEnd(uobEvol, { id: 57, category: 'mobile' }, true)
    expect(asked.line).toBe('#57: Phone tap. Which was it?')
    expect(asked.buttons?.flat().map((button) => button.text)).toEqual([
      'Online',
      '✓ Phone tap',
      'Physical card or other',
      "Doesn't count",
    ])
    // A purchase that a rule sorted is in no category that has a button, so none is ticked.
    const ruled = sortEnd(uobEvol, { id: 57, category: 'fx' }, true)
    expect(ruled.buttons?.flat().map((button) => button.text)).not.toContainEqual(expect.stringContaining('✓'))
  })

  it('makes buttons that say when the next unsorted purchase is to follow the press', () => {
    const { buttons = [] } = sortEnd(uobEvol, { id: 57, category: null }, true, true)

    expect(buttons.flat().map((button) => button.data)).toEqual([
      '57:online:next',
      '57:mobile:next',
      '57:other:next',
      '57:excluded:next',
    ])
  })
})

describe('what a button sends back', () => {
  it('is read as the purchase, the category and whether more is to follow', () => {
    expect(readPress('57:online')).toEqual({ purchaseId: 57, category: 'online', next: false })
    expect(readPress('57:excluded:next')).toEqual({ purchaseId: 57, category: 'excluded', next: true })
    expect(readPress('999999999999999:made-up-2')).toEqual({
      purchaseId: 999_999_999_999_999,
      category: 'made-up-2',
      next: false,
    })
  })

  it.each([
    '',
    '57',
    '57:',
    ':online',
    '57:online:',
    '57:online:next:next',
    '57:online:later',
    '-57:online',
    '5.7:online',
    '57:Online',
    '57:online next',
    ' 57:online',
    '57:online\n58:online',
    '1234567890123456:online',
    '57:online; DROP TABLE transactions',
  ])('is not read when it is %j, which no button holds', (data) => {
    expect(readPress(data)).toBeNull()
  })
})
