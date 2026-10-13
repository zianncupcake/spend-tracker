import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../src/checker'
import { codesAmong } from '../src/mcc-lookup'
import { connectedChat, deps, openChat, outside } from './connect-helpers'
import { gmailMessage, textPart } from './gmail-helpers'
import { alertText } from './helpers'
import { catchConsole } from './log-helpers'
import { bought, read, reading, rowsOf } from './photo-helpers'

// The category code of a merchant that no rule and no name of the bot's own list places, asked of check-mcc.sg as a
// purchase is added. ./connect-helpers has the stand-in for the service: every store here is made up.

const store = (Store: string, MCC: string) => ({ Store, MCC })

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
    ['one whose name the text holds gives its code', [store('Sample Eatery', '5812')], [5812]],
    ['one that only contains the word that was asked is not taken', [store('Sample Mart', '5411')], []],
    ['a name that ends inside a word of the text is not taken', [store('Sample Eat', '5499')], []],
    ['the longest name wins', [store('Sample', '5411'), store('Sample Eatery', '5812')], [5812]],
    ['a name under three letters is not taken', [store('Sa', '5812')], []],
  ])('%s', (_, stores, codes) => {
    expect(codesAmong('SAMPLE EATERY SINGAPORE SG', stores)).toEqual(codes)
  })
})

describe('a purchase that nothing placed', () => {
  it.each([
    ['of its code, when that is one of the eligible codes', [store('Sample Eatery', '5812')], 'eligible'],
    ['that takes the unlisted, when its code is none of them', [store('Sample Eatery', '5411')], 'other'],
    [
      'of none, when the stores of the longest name differ in theirs',
      [store('Sample Eatery', '5812'), store('SAMPLE EATERY', '5411')],
      null,
    ],
  ])('is stored with the category %s', async (_, stores, category) => {
    outside.stores = stores

    expect(await added(HSBC, 'hsbc 12.40 SAMPLE EATERY')).toEqual([category])
  })

  it.each<[what: string, arrange: () => void]>([
    ['the service answers 429', () => (outside.stores = () => new Response(null, { status: 429 }))],
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

  it('is asked about once for its merchant, when several at that merchant are added at once', async () => {
    const chat = openChat()
    await chat.say(`/addcard ${HSBC}`)
    outside.stores = [store('Sample Mart', '5411')]
    reading(read([bought(900, 'GRAB*A-123'), bought(1240, 'SAMPLE MART'), bought(700, 'SAMPLE MART 2')]))

    await chat.photo()

    expect(outside.searches).toEqual(['sample'])
    const rows = await rowsOf(await chat.userId())
    expect(rows.map((row) => row.category)).toEqual(['eligible', 'other', 'other'])
  })

  it('is logged as a lookup with what came of it, and with nothing of its merchant', async () => {
    const logged = catchConsole()
    outside.stores = [store('Sample Eatery', '5812')]

    await added(HSBC, 'hsbc 12.40 SAMPLE EATERY')

    expect(logged.events('mcc_lookup')).toEqual([{ event: 'mcc_lookup', outcome: 'found' }])
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
