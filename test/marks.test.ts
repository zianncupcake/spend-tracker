import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { storeFor } from '../src/store'
import { MARKED_BEFORE } from '../src/telegram/purchases'
import { openChat, outside } from './connect-helpers'
import { rowsOf } from './photo-helpers'

// What a user marks a purchase as, remembered for their later purchases at the merchant on the same product. The
// lookup of a merchant's code is the stand-in of ./connect-helpers, which lists no store unless a test gives it one.

const HSBC = 'hsbc 4321 calendar hsbc-revolution'
const TO_OTHER = 'Mark as Other Transactions'
const TO_ELIGIBLE = 'Mark as Eligible Transactions'

type Chat = ReturnType<typeof openChat>

/** A chat whose user has the HSBC card, added a purchase at SAMPLE EATERY ORCHARD, and marked it as Other. */
async function markedChat(): Promise<Chat> {
  const chat = openChat()
  await chat.say(`/addcard ${HSBC}`)
  const [added] = await chat.ask('/add hsbc 12.40 SAMPLE EATERY ORCHARD')
  await chat.press(added, TO_OTHER)
  return chat
}

/** Adds a purchase at another outlet of the merchant, and returns the reply and the category stored for it. */
async function addAgain(chat: Chat, outlet = 'JURONG', card = 'hsbc', merchant = 'SAMPLE EATERY') {
  const [reply] = await chat.ask(`/add ${card} 12.40 ${merchant} ${outlet}`)
  const rows = await rowsOf(await chat.userId())
  return { reply, category: rows[rows.length - 1].category }
}

describe('a mark of a purchase that nothing placed', () => {
  it('places the next purchase at the merchant, and the reply says so', async () => {
    const chat = await markedChat()

    const { reply, category } = await addAgain(chat)

    expect(category).toBe('other')
    expect(reply.text).toMatch(new RegExp(`: Other Transactions, ${MARKED_BEFORE}$`))
  })

  it('is used with no lookup of the merchant', async () => {
    const chat = await markedChat()
    outside.searches.length = 0

    await addAgain(chat)

    expect(outside.searches).toEqual([])
  })

  it.each<[what: string, add: (chat: Chat) => Promise<{ category: unknown }>]>([
    [
      'on a card of another product',
      async (chat) => {
        await chat.say('/addcard ocbc 1111 calendar ocbc-rewards')
        return addAgain(chat, 'JURONG', 'ocbc')
      },
    ],
    [
      'for another user',
      async () => {
        const other = openChat()
        await other.say(`/addcard ${HSBC}`)
        return addAgain(other)
      },
    ],
  ])('is not used %s', async (_, add) => {
    const chat = await markedChat()

    expect((await add(chat)).category).toBeNull()
  })

  it('is replaced when a purchase that it placed is marked again', async () => {
    const chat = await markedChat()
    const { reply } = await addAgain(chat)
    await chat.press(reply, TO_ELIGIBLE)

    expect((await addAgain(chat, 'TAMPINES')).category).toBe('eligible')
  })
})

describe('a mark of a purchase that something placed', () => {
  it.each([
    // 5812 is a code of an Eligible Transaction, so the mark places the next purchase with no lookup.
    ['the lookup', 'SAMPLE EATERY', TO_OTHER, 'other', 'other'],
    // The product's rule puts a travel agency in Other Transactions, and the rules come before a mark.
    ['a rule', 'TRIP.COM', TO_ELIGIBLE, 'eligible', 'other'],
  ])('that %s placed is remembered', async (_, merchant, button, remembered, next) => {
    const chat = openChat()
    await chat.say(`/addcard ${HSBC}`)
    outside.stores = [{ Store: 'Sample Eatery', MCC: '5812' }]
    const [added] = await chat.ask(`/add hsbc 12.40 ${merchant} ORCHARD`)
    await chat.press(added, button)
    outside.searches.length = 0

    const { category } = await addAgain(chat, 'JURONG', 'hsbc', merchant)

    expect(await storeFor(env.DB, await chat.userId()).listMarks()).toMatchObject([{ category: remembered }])
    expect({ category, searches: outside.searches }).toEqual({ category: next, searches: [] })
  })
})
