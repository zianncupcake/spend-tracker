import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../src/checker'
import { codesAmong, storesNaming } from '../src/mcc-lookup'
import { connectedChat, deps, openChat, outside } from './connect-helpers'
import { gmailMessage, textPart } from './gmail-helpers'
import { alertText } from './helpers'
import { catchConsole } from './log-helpers'
import { bought, read, reading, rowsOf } from './photo-helpers'

// The category code of a merchant that no rule and no name of the bot's own list places, asked of check-mcc.sg and
// of heymax.ai as a purchase is added. ./connect-helpers has the stand-in for each: every store here is made up.

/** A store as check-mcc.sg lists it, as heymax.ai does, and as `codesAmong` takes one of either. */
const store = (Store: string, MCC: string) => ({ Store, MCC })
const second = (name: string, mcc_code: string) => ({ name, mcc_code })
const listed = (name: string, code: string) => ({ name, code })

/** Of the HSBC Revolution Credit Card, 5812 is a code of an Eligible Transaction, and 5411 is of none. */
const HSBC = 'hsbc 4321 calendar hsbc-revolution'

/** A chat whose user has the card, and the categories that are stored for what they then add with /add. */
async function added(card: string, purchase: string): Promise<(string | number | null)[]> {
  const chat = openChat()
  await chat.say(`/addcard ${card}`)
  await chat.ask(`/add ${purchase}`)
  return (await rowsOf(await chat.userId())).map((row) => row.category)
}

describe('the stores that count for a merchant', () => {
  it.each([
    ['one whose name the text holds gives its code', [listed('Sample Eatery', '5812')], [5812]],
    ['one that only contains the word that was asked is not taken', [listed('Sample Mart', '5411')], []],
    ['a name that ends inside a word of the text is not taken', [listed('Sample Eat', '5499')], []],
    ['the longest name wins', [listed('Sample', '5411'), listed('Sample Eatery', '5812')], [5812]],
    ['a name under three letters is not taken', [listed('Sa', '5812')], []],
  ])('%s', (_, stores, codes) => {
    expect(codesAmong('SAMPLE EATERY SINGAPORE SG', stores)).toEqual(codes)
  })

  it.each([
    ['include one whose name begins with the merchant', 'SAMPLE SOFT SG', [{ store: 'SAMPLE SOFT SG', mcc: 4816 }]],
    ['do not include one whose name holds the merchant later on', 'THE SAMPLE SOFT', []],
  ])('of a question %s', (_, name, reported) => {
    expect(storesNaming('sample soft', [listed(name, '4816')])).toEqual(reported)
  })
})

describe('a purchase that nothing placed', () => {
  it.each([
    ['of its code, when that is one of the eligible codes', [store('Sample Eatery', '5812')], [], 'eligible'],
    ['that takes the unlisted, when its code is none of them', [store('Sample Eatery', '5411')], [], 'other'],
    [
      'of none, when the stores of the longest name differ in theirs',
      [store('Sample Eatery', '5812'), store('SAMPLE EATERY', '5411')],
      [],
      null,
    ],
    [
      'of the code that the second service has, when the first has no store for it',
      [store('Sample Mart', '5411')],
      [second('Sample Eatery', '5812')],
      'eligible',
    ],
    [
      'of the code that the first service has, when both have a store for it',
      [store('Sample Eatery', '5411')],
      [second('Sample Eatery', '5812')],
      'other',
    ],
    ['of none, when the second service has no store that the text holds', [], [second('Sample Mart', '5812')], null],
    ['of none, when the only store has a name that holds the text', [store('SAMPLE EATERY SG', '5812')], [], null],
  ])('is stored with the category %s', async (_, stores, heymax, category) => {
    Object.assign(outside, { stores, heymax })

    expect(await added(HSBC, 'hsbc 12.40 SAMPLE EATERY')).toEqual([category])
  })

  it.each<[what: string, arrange: () => void]>([
    ['the service answers 429', () => (outside.stores = () => new Response(null, { status: 429 }))],
    ['the second service answers 500', () => (outside.heymax = () => new Response(null, { status: 500 }))],
    [
      'the request does not come back within 2 seconds',
      () => {
        outside.stores = () => new Promise<Response>(() => {})
        const over = AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        // A request that is given any other time is never ended here, and the test then is not either.
        const never = new AbortController().signal
        vi.spyOn(AbortSignal, 'timeout').mockImplementation((time) => (time === 2_000 ? over : never))
      },
    ],
  ])('is added with nothing stored for it when %s', async (_, arrange) => {
    arrange()

    expect(await added(HSBC, 'hsbc 12.40 SAMPLE EATERY')).toEqual([null])
  })

  it('is stored with the category of its code when it comes in an alert', async () => {
    const chat = await connectedChat('jane@example.test')
    await chat.say('/addcard hsbc 1234 calendar hsbc-revolution')
    outside.mailboxes['jane@example.test'] = [
      gmailMessage({ content: textPart(alertText('SGD 12.40', '1234', 'SAMPLE MART')) }),
    ]
    outside.stores = [store('Sample Mart', '5411')]

    await runCheck(deps)

    expect(await rowsOf(await chat.userId())).toMatchObject([{ category: 'other' }])
  })

  it('is asked about once of each service, when several at its merchant are added at once', async () => {
    const chat = openChat()
    await chat.say(`/addcard ${HSBC}`)
    outside.stores = [store('Sample Mart', '5411')]
    reading(read([bought(900, 'GRAB*A-123'), bought(1240, 'SAMPLE MART'), bought(700, 'SAMPLE MART 2')]))

    await chat.photo()

    expect(outside.searches).toEqual(['sample', 'sample'])
    const rows = await rowsOf(await chat.userId())
    expect(rows.map((row) => row.category)).toEqual(['eligible', 'other', 'other'])
  })

  it('is logged as a lookup of each service with what came of it, and with nothing of its merchant', async () => {
    const logged = catchConsole()
    outside.stores = [store('Sample Eatery', '5812')]

    await added(HSBC, 'hsbc 12.40 SAMPLE EATERY')

    expect(logged.events('mcc_lookup')).toEqual([
      { event: 'mcc_lookup', source: 'check-mcc.sg', outcome: 'found' },
      { event: 'mcc_lookup', source: 'heymax.ai', outcome: 'none' },
    ])
    expect(logged.text()).not.toMatch(/sample/i)
  })
})

describe('no store is asked for', () => {
  it.each([
    ["a merchant that the bot's own list knows", HSBC, 'hsbc 9.00 GRAB*A-123'],
    ['a purchase in another currency', HSBC, 'hsbc USD 9.00 SAMPLE EATERY'],
    ['a merchant whose first word has no letter', HSBC, 'hsbc 9.00 88 SAMPLE EATERY'],
    ['a card whose product lists no codes', 'evol 5678 calendar uob-evol', 'evol 9.00 SAMPLE EATERY'],
    ['a card with no product', 'visa 1234 calendar', 'visa 9.00 SAMPLE EATERY'],
  ])('for %s', async (_, card, purchase) => {
    expect(await added(card, purchase)).toHaveLength(1)

    expect(outside.searches).toEqual([])
  })
})
