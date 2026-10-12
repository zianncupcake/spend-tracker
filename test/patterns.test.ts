import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import * as assistant from '../src/ai/assistant'
import type { Action } from '../src/ai/assistant'
import { hsbcRevolution } from '../src/catalogue/hsbc-revolution'
import { namedIn } from '../src/catalogue/merchants'
import { uobEvol } from '../src/catalogue/uob-evol'
import { heldBack, toComeByGroup } from '../src/domain/patterns'
import { currentWindow } from '../src/domain/window'
import { MAX_CARDS, MAX_PATTERN_SKIPS, MAX_PATTERNS, storeFor, type Pattern } from '../src/store'
import { parsePattern } from '../src/telegram/arguments'
import { formatAmount, formatMoney } from '../src/telegram/format'
import { TO_COME, TO_COME_NOTE } from '../src/telegram/purchases'
import { HOLDS_NOTHING, NO_MORE, NO_PATTERNS, PATTERN_USAGE, TOO_MANY_PATTERNS } from '../src/telegram/texts'
import { NOW, openChat, sentRich } from './connect-helpers'
import { bareRow, buy, headerRow, linesOf, plain, purchaseRow, sumRow, tableOf } from './helpers'

// A user's monthly patterns: what one holds back, the command that keeps them, and what /spend with a card then
// shows. The chats, the clock and the service are those of ./connect-helpers: it is 12:00 on 9 October 2026 in
// Singapore.

const ZONE = 'Asia/Singapore'

/** October 2026 on a card that is tracked by the calendar month: it counts the purchases of 29 Sep to 29 Oct. */
const OCTOBER = currentWindow({ windowType: 'calendar' }, NOW, ZONE)

const GYM: Pattern = { cardLast4: '1234', merchant: 'sample gym', amountMinor: 6000, skips: [] }

type Chat = ReturnType<typeof openChat>

/** A chat whose user has a card that is linked to the UOB EVOL Card, with the calendar month for its window. */
async function chatWithCard(): Promise<Chat> {
  const chat = openChat()
  await chat.say('/addcard evol 1234 calendar uob-evol')
  return chat
}

/** What the user's patterns are listed as: the rows of the table of /patterns, under the row that names its columns. */
async function listed(chat: Chat): Promise<string[]> {
  return (await chat.lines('/patterns')).slice(1)
}

function patternCount(userId: number): Promise<number | null> {
  return env.DB.prepare('SELECT COUNT(*) AS n FROM patterns WHERE owner_id = ?').bind(userId).first<number>('n')
}

describe('what a pattern holds back in a window', () => {
  const at = (merchant: string | null, amountMinor: number, currency = 'SGD') => ({ merchant, amountMinor, currency })

  it.each([
    ['all of its amount, with nothing spent', [], [], 6000],
    ['what two purchases at its merchant leave of it', [at('SAMPLE GYM', 2000), at('Sample-Gym*2', 1000)], [], 3000],
    ['nothing, with more than it spent there', [at('SAMPLE GYM', 9500)], [], 0],
    ['all of it, whatever is spent elsewhere', [at('COFFEE PLACE', 400)], [], 6000],
    ['all of it, whatever is spent there in another currency', [at('SAMPLE GYM', 500, 'USD')], [], 6000],
    ['all of it, beside a purchase with no merchant', [at(null, 500)], [], 6000],
    ['nothing, when its skipped day is the first that the window counts', [], ['2026-09-29'], 0],
    ['nothing, when its skipped day is the last that the window counts', [], ['2026-10-29'], 0],
    ['all of it, when its skipped day is the first that the next window counts', [], ['2026-10-30'], 6000],
    // The window begins at 16:00 on 28 September by UTC, which is no day of its user's that it counts.
    ['all of it, when its skipped day is the one on which the window begins by UTC', [], ['2026-09-28'], 6000],
  ])('is %s', (_, purchases, skips, held) => {
    expect(heldBack([{ ...GYM, skips }], purchases, 'SGD', OCTOBER, ZONE)).toEqual([held])
  })

  it('counts a purchase for one pattern only: of those whose names it holds, the one with the longest name', () => {
    const patterns = [{ ...GYM, merchant: 'gym', amountMinor: 5000 }, GYM]
    const purchases = [at('SAMPLE GYM PTE LTD', 3000), at('GYM SHOP', 1000)]

    expect(heldBack(patterns, purchases, 'SGD', OCTOBER, ZONE)).toEqual([4000, 3000])
  })

  it('is held back of no group when a purchase at its merchant starts in one that has no cap', () => {
    // A travel agency, which the HSBC product starts in its Other Transactions.
    const patterns = [{ ...GYM, merchant: 'agoda' }]

    expect(toComeByGroup(hsbcRevolution, patterns, [], OCTOBER, ZONE)).toEqual([0, 0])
  })

  it('is of a name that is not empty: no merchant holds an empty one', () => {
    expect(namedIn('SAMPLE GYM')('')).toBe(false)
  })
})

describe('/spend with a card that has patterns', () => {
  it('shows what is held back of a cap, less each purchase at the merchant, and takes it off the rest', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    const first = await buy(userId, { amountMinor: 2000, merchant: 'SAMPLE GYM PTE LTD' })
    const second = await buy(userId, { at: '2026-10-06T09:30:00+08:00', amountMinor: 500, merchant: 'SAMPLE GYM 2' })
    await chat.say('/pattern evol 60 sample gym')

    const { blocks } = await chat.rich('/spend evol')

    expect(blocks).toContainEqual(
      tableOf(
        headerRow('SGD'),
        purchaseRow(first, '5 Oct', '20.00', 'SAMPLE GYM PTE LTD'),
        purchaseRow(second, '6 Oct', '5.00', 'SAMPLE GYM 2'),
        sumRow('Total', '25.00'),
        sumRow('Cap', '300.00'),
        sumRow(TO_COME, '35.00'),
        sumRow('Left', '240.00'),
      ),
    )
    // A group that nothing is held back of is as it was.
    const untouched = tableOf(bareRow('Total', '0.00'), bareRow('Cap', '200.00'), bareRow('Left', '200.00'))
    expect(blocks).toContainEqual(untouched)
    expect(blocks).toContainEqual(plain(TO_COME_NOTE))
  })

  it('says how far over the cap a group is, when more is held back than is left of it', async () => {
    const chat = await chatWithCard()
    // Two patterns of the one group, which a purchase at a streaming service starts in.
    await chat.say('/pattern evol 150 netflix')
    await chat.say('/pattern evol 100 spotify')

    const { blocks } = await chat.rich('/spend evol')

    expect(blocks).toContainEqual(
      tableOf(bareRow('Total', '0.00'), bareRow('Cap', '200.00'), bareRow(TO_COME, '250.00'), bareRow('Over', '50.00')),
    )
  })

  it('holds nothing back of a cap for a merchant that a rule of the product places by its name as typed', async () => {
    const chat = openChat()
    await chat.say('/addcard hsbc 1234 calendar hsbc-revolution')
    // A travel agency, which the HSBC product starts in its group with no cap: by "Trip.com", with its full stop.
    await chat.say('/pattern hsbc 60 trip.com')
    const { limitMinor = 0 } = hsbcRevolution.groups[0]

    const lines = await chat.lines('/spend hsbc')

    expect(lines.filter((line) => line.startsWith(TO_COME))).toEqual([])
    expect(lines).toContain(`Left | ${formatAmount(limitMinor)}`)
  })

  it('holds a pattern against its own card, and not against another card of its user’s', async () => {
    const chat = await chatWithCard()
    await chat.say('/addcard spare 5678 calendar uob-evol')
    await chat.say('/pattern evol 60 sample gym')
    await chat.say('/pattern spare 40 sample gym')
    const toCome = async (nickname: string) =>
      (await chat.lines(`/spend ${nickname}`)).filter((line) => line.startsWith(`${TO_COME} |`))

    expect(await toCome('evol')).toEqual([`${TO_COME} | 60.00`])
    expect(await toCome('spare')).toEqual([`${TO_COME} | 40.00`])
  })
})

describe('what /pattern is asked for', () => {
  const read = (line: string) => parsePattern(line.split(/\s+/))
  const saving = (merchant: string, amountMinor: number, skips: string[] = []) => ({
    nickname: 'evol',
    merchant,
    save: { amountMinor, skips },
  })
  const removing = (merchant: string) => ({ nickname: 'evol', merchant })
  const days = (count: number) => Array.from({ length: count }, (_, day) => `2026-11-${10 + day}`)

  it.each([
    ['an amount and a merchant', 'evol 1,095.50 sample gym', saving('sample gym', 109550)],
    ['a merchant as it was typed, in lower case', 'evol 20 7-Eleven', saving('7-eleven', 2000)],
    ['a merchant of 40 characters', `evol 60 ${'g'.repeat(40)}`, saving('g'.repeat(40), 6000)],
    [
      'the days after "except", each once and in the order of the calendar',
      'evol 60 sample gym except 2027-02-15 2026-11-15 2027-02-15',
      saving('sample gym', 6000, ['2026-11-15', '2027-02-15']),
    ],
    ['"EXCEPT" in capitals', 'evol 60 sample gym EXCEPT 2026-11-15', saving('sample gym', 6000, ['2026-11-15'])],
    ['a removal, of a merchant that begins with a number', 'evol 247 gym none', removing('247 gym')],
    ['"NONE" in capitals', 'evol sample gym NONE', removing('sample gym')],
  ])('is %s', (_, line, asked) => {
    expect(read(line)).toEqual(asked)
  })

  it.each([
    ['a nickname that is none', 'my!card 60 sample gym'],
    ['an amount that is no number', 'evol lots sample gym'],
    ['an amount of nothing', 'evol 0 sample gym'],
    ['an amount with a currency', 'evol USD60 sample gym'],
    ['a merchant of 41 characters', `evol 60 ${'g'.repeat(41)}`],
    ['a merchant of two letters', 'evol 60 sp'],
    ['a merchant with a character that no alert is written with', 'evol 60 café bar'],
    ['a day that no calendar has', 'evol 60 sample gym except 2026-11-15 2026-02-30'],
    ['"except" with no day after it', 'evol 60 sample gym except'],
    [`${MAX_PATTERN_SKIPS + 1} skipped days`, `evol 60 sample gym except ${days(MAX_PATTERN_SKIPS + 1).join(' ')}`],
  ])('is nothing, with %s', (_, line) => {
    expect(read(line)).toBeNull()
  })
})

describe('/pattern', () => {
  it('saves a pattern, and /patterns lists it', async () => {
    const chat = await chatWithCard()

    await chat.say('/pattern evol 60 Sample GYM')

    expect(await listed(chat)).toEqual(['evol ••••1234 | sample gym | SGD 60.00 | -'])
  })

  it('replaces the pattern that the card has for the merchant: its amount, and its skipped days', async () => {
    const chat = await chatWithCard()
    await chat.say('/pattern evol 60 sample gym except 2026-11-15')

    await chat.say('/pattern evol 95.50 SAMPLE GYM except 2027-02-15')

    expect(await listed(chat)).toEqual(['evol ••••1234 | sample gym | SGD 95.50 | 2027-02-15'])
  })

  it('goes by the letters and digits of a name: another spelling replaces a pattern, and any removes it', async () => {
    const chat = await chatWithCard()
    await chat.say('/pattern evol 45 7 eleven')

    await chat.say('/pattern evol 30 7eleven')

    expect(await listed(chat)).toEqual(['evol ••••1234 | 7eleven | SGD 30.00 | -'])
    await chat.say('/pattern evol 7-Eleven none')
    expect(await chat.say('/patterns')).toBe(NO_PATTERNS)
  })

  it('removes one pattern, and leaves the card’s others, another card’s of that name and another user’s', async () => {
    const [chat, other] = [await chatWithCard(), await chatWithCard()]
    await chat.say('/addcard spare 5678 calendar uob-evol')
    await chat.say('/pattern evol 60 sample gym')
    await chat.say('/pattern evol 30 bus fare')
    await chat.say('/pattern spare 40 sample gym')
    await other.say('/pattern evol 60 sample gym')
    const kept = ['evol ••••1234 | bus fare | SGD 30.00 | -', 'spare ••••5678 | sample gym | SGD 40.00 | -']
    // Each is listed under its own card.
    expect(await listed(chat)).toEqual([kept[0], 'evol ••••1234 | sample gym | SGD 60.00 | -', kept[1]])

    await chat.say('/pattern evol sample gym none')

    expect(await listed(chat)).toEqual(kept)
    expect(await patternCount(await other.userId())).toBe(1)
  })

  it('answers what it cannot read with the usage, and saves nothing', async () => {
    const chat = await chatWithCard()

    expect(await chat.say('/pattern evol 0 sample gym')).toBe(PATTERN_USAGE)

    expect(await patternCount(await chat.userId())).toBe(0)
  })

  it('saves nothing for a card that the user has not got, and says which', async () => {
    const chat = await chatWithCard()

    expect(await chat.say('/pattern visa 60 sample gym')).toContain('visa')

    expect(await patternCount(await chat.userId())).toBe(0)
  })

  // The group of the UOB product for the gyms that the bank names, and the Other Transactions of the HSBC product.
  const [CAPPED, NO_CAP] = [uobEvol.groups[1], hsbcRevolution.groups[1]]

  it.each([
    ['the group that it is held against, and its cap', 'uob-evol', 'anytime fitness', CAPPED, false],
    // A travel agency, which a rule of the HSBC product places by its name with the full stop in it.
    ['that it holds nothing back, in a group with no cap', 'hsbc-revolution', 'trip.com', NO_CAP, true],
    ['that it holds nothing back, on a card with no product', '', 'sample gym', undefined, true],
  ])('says of a pattern that it saves %s', async (_, product, merchant, group, nothing) => {
    const chat = openChat()
    await chat.say(`/addcard card 1234 calendar ${product}`)

    const reply = await chat.say(`/pattern card 60 ${merchant}`)

    expect(reply.includes(HOLDS_NOTHING)).toBe(nothing)
    if (group) expect(reply).toContain(group.name)
    if (group?.limitMinor !== undefined) expect(reply).toContain(formatMoney(group.limitMinor, 'SGD'))
  })

  it(`saves ${MAX_PATTERNS} for a user at most: one that replaces adds none, one on another card does`, async () => {
    const chat = await chatWithCard()
    await chat.say('/addcard spare 5678 calendar')
    const userId = await chat.userId()
    const store = storeFor(env.DB, userId)
    for (let n = 0; n < MAX_PATTERNS; n++) await store.setPattern({ ...GYM, merchant: `merchant ${n}` })

    expect(await chat.say('/pattern evol 60 one more')).toBe(TOO_MANY_PATTERNS)
    expect(await chat.say('/pattern spare 95 merchant 0')).toBe(TOO_MANY_PATTERNS)
    expect(await chat.say('/pattern evol 95 merchant 0')).not.toBe(TOO_MANY_PATTERNS)

    expect(await patternCount(userId)).toBe(MAX_PATTERNS)
    expect(await listed(chat)).toContain('evol ••••1234 | merchant 0 | SGD 95.00 | -')
  })

  it(`counts nobody else’s patterns towards a user’s ${MAX_PATTERNS}`, async () => {
    const [chat, other] = [await chatWithCard(), await chatWithCard()]
    const store = storeFor(env.DB, await other.userId())
    for (let n = 0; n < MAX_PATTERNS; n++) await store.setPattern({ ...GYM, merchant: `merchant ${n}` })

    await chat.say('/pattern evol 60 sample gym')

    expect(await patternCount(await chat.userId())).toBe(1)
  })
})

describe('a pattern, with somebody else’s card ending in the same four digits', () => {
  it('is neither listed for them nor held against their card', async () => {
    const [mine, theirs] = [await chatWithCard(), await chatWithCard()]

    await mine.say('/pattern evol 60 sample gym')

    expect(await theirs.say('/patterns')).toBe(NO_PATTERNS)
    expect(await theirs.lines('/spend evol')).not.toContain(TO_COME_NOTE)
    expect(await mine.lines('/spend evol')).toContain(TO_COME_NOTE)
  })
})

describe('the patterns that are stored', () => {
  it('are for a card of their user’s: none is saved for digits that only somebody else has a card with', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    await openChat().say('/addcard theirs 9999 calendar')

    expect(await storeFor(env.DB, userId).setPattern({ ...GYM, cardLast4: '9999' })).toBe(false)

    expect(await patternCount(userId)).toBe(0)
  })

  it('go with their card when it is removed, which says how many they were, and no others do', async () => {
    const [chat, other] = [await chatWithCard(), await chatWithCard()]
    await chat.say('/addcard visa 5678 calendar')
    await chat.say('/pattern evol 60 sample gym')
    await chat.say('/pattern evol 60 bus fare')
    await chat.say('/pattern visa 30 train fare')
    await other.say('/pattern evol 60 sample gym')

    expect(await chat.say('/removecard evol')).toContain('2')

    expect(await listed(chat)).toEqual(['visa ••••5678 | train fare | SGD 30.00 | -'])
    expect(await patternCount(await chat.userId())).toBe(1)
    expect(await patternCount(await other.userId())).toBe(1)
  })

  it('go with their user on /delete confirm', async () => {
    const chat = await chatWithCard()
    const userId = await chat.userId()
    await chat.say('/pattern evol 60 sample gym')

    await chat.say('/delete confirm')

    expect(await patternCount(userId)).toBe(0)
  })
})

describe('what the assistant is asked to do with patterns', () => {
  /** Has the assistant make these actions of the message that follows. It is stood in for: see test/actions.test.ts. */
  function acting(...actions: Action[]): void {
    const answer = { status: 'acting' as const, actions, afterReading: false, dropped: 0, more: false }
    vi.spyOn(assistant, 'answerQuestion').mockResolvedValue(answer)
  }
  const command = (line: string): Action => ({ kind: 'command', line })

  /** Sends the bot a message, and returns what it has left in the chat for it: its rich messages and its texts. */
  async function told(chat: Chat) {
    const beforeRich = sentRich.length
    const texts = await chat.ask('made-up words')
    return { rich: sentRich.splice(beforeRich).map(({ message }) => message), texts }
  }

  it('asks before it saves one, with its card, its merchant and its amount, and saves it on "Do it"', async () => {
    const chat = await chatWithCard()
    acting(command('/pattern evol 60 Sample Gym except 2027-02-15 2026-11-15'))

    const [asking] = (await told(chat)).texts

    for (const named of ['evol ••••1234', 'sample gym', 'SGD 60.00']) expect(asking.text).toContain(named)
    expect(await patternCount(await chat.userId())).toBe(0)

    await chat.press(asking, 'Do it')

    expect(await listed(chat)).toEqual(['evol ••••1234 | sample gym | SGD 60.00 | 2026-11-15, 2027-02-15'])
  })

  it('asks before it removes one, and removes it on "Do it"', async () => {
    const chat = await chatWithCard()
    await chat.say('/pattern evol 60 sample gym')
    acting(command('/pattern evol Sample Gym none'))

    const [asking] = (await told(chat)).texts

    expect(await patternCount(await chat.userId())).toBe(1)

    await chat.press(asking, 'Do it')

    expect(await patternCount(await chat.userId())).toBe(0)
  })

  it('asks about one for a single query of the room, which showing 20 cards and unlinking one leaves', async () => {
    const chat = openChat()
    for (let card = 1; card <= MAX_CARDS; card++) await chat.say(`/addcard card-${card} ${1000 + card} calendar`)
    acting({ kind: 'show' }, command('/product card-4 none'), command('/pattern card-1 60 sample gym'))

    const { texts } = await told(chat)

    expect(texts.map((message) => message.text)).not.toContain(NO_MORE)
    expect(texts.at(-1)?.buttons).toBeDefined()
  })

  it('lists them with no question asked', async () => {
    const chat = await chatWithCard()
    await chat.say('/pattern evol 60 sample gym')
    acting(command('/patterns'))

    const { rich, texts } = await told(chat)

    expect(texts).toEqual([])
    expect(rich.map((message) => linesOf(message).slice(1))).toEqual([['evol ••••1234 | sample gym | SGD 60.00 | -']])
  })

  it('shows five cards with what is held back, from one reading, which leaves room for three commands', async () => {
    const chat = openChat()
    for (let card = 1; card <= 5; card++) await chat.say(`/addcard card-${card} 100${card} calendar uob-evol`)
    await chat.say('/pattern card-1 60 sample gym')
    acting({ kind: 'show' }, command('/cards'), command('/products'), command('/status'))
    const queried = vi.spyOn(env.DB, 'prepare')

    const { rich, texts } = await told(chat)

    // Each card in a message of its own, and then the three tables of the commands.
    expect(rich).toHaveLength(5 + 3)
    expect(linesOf(rich[0])).toContain(`${TO_COME} | 60.00`)
    expect(texts.map((message) => message.text)).not.toContain(NO_MORE)
    expect(queried.mock.calls.filter(([query]) => query.includes('FROM patterns'))).toHaveLength(1)
  })
})
