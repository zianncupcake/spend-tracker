import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { bestFor } from '../src/domain/best'
import { storeFor } from '../src/store'
import { BEST_USAGE } from '../src/telegram/texts'
import { NOW, openChat, outside } from './connect-helpers'
import { buy } from './helpers'

// Which card to pay with at a merchant: /best. The chats, the clock and the stand-in for the lookup of a merchant's
// code are those of ./connect-helpers. The lookup gives SAMPLE EATERY the code 5812, which the HSBC Revolution puts
// in its capped Eligible Transactions, the OCBC Rewards in its Other Spend with no cap, and the DBS Woman's World
// in nothing. The UOB EVOL goes by no codes.

const HSBC = 'hsbc 4321 calendar hsbc-revolution'
const OCBC = 'ocbc 1111 calendar ocbc-rewards'
const DBS = 'dbs 2222 calendar dbs-womans-world'
const EVOL = 'evol 5678 calendar uob-evol'

type Chat = ReturnType<typeof openChat>

async function chatWith(...cards: string[]): Promise<Chat> {
  const chat = openChat()
  for (const card of cards) await chat.say(`/addcard ${card}`)
  outside.stores = [{ Store: 'Sample Eatery', MCC: '5812' }]
  return chat
}

async function bestAt(chat: Chat) {
  const store = storeFor(env.DB, await chat.userId())
  const [cards, patterns] = await Promise.all([store.listCards(), store.listPatterns()])
  return bestFor(store, cards, patterns, 'SAMPLE EATERY', NOW, 'Asia/Singapore')
}

const nicknames = (options: Awaited<ReturnType<typeof bestAt>>) => options.map(({ card }) => card.nickname)

describe('the cards to pay with at a merchant', () => {
  it('has first the card that earns its bonus there, with what is left of its cap', async () => {
    const chat = await chatWith(OCBC, HSBC)

    const [first, second] = await bestAt(chat)

    expect(first).toMatchObject({ card: { nickname: 'hsbc' }, bonus: 'yes', leftMinor: 100000 })
    expect(second).toMatchObject({ card: { nickname: 'ocbc' }, bonus: 'no' })
  })

  it.each<[what: string, useUp: (chat: Chat) => Promise<unknown>]>([
    ['purchases', async (chat) => buy(await chat.userId(), { cardLast4: '4321', amountMinor: 100000 })],
    ['a pattern', (chat) => chat.say('/pattern hsbc 1000.00 SAMPLE GYM')],
  ])('has a card whose cap is used up by %s after one that is not sure, and before no bonus', async (_, useUp) => {
    const chat = await chatWith(OCBC, HSBC, EVOL)
    await useUp(chat)

    expect(nicknames(await bestAt(chat))).toEqual(['evol', 'hsbc', 'ocbc'])
  })

  it('has the cards that nothing places as not sure, after a card that is sure', async () => {
    const chat = await chatWith(DBS, EVOL, HSBC)

    const options = await bestAt(chat)

    expect(options.map(({ card, bonus }) => [card.nickname, bonus])).toEqual([
      ['hsbc', 'yes'],
      ['dbs', 'depends'],
      ['evol', 'depends'],
    ])
  })

  it('asks each service for the merchant once, however many cards go by its code', async () => {
    const chat = await chatWith(HSBC, OCBC, DBS)

    await bestAt(chat)

    expect(outside.searches).toEqual(['sample', 'sample'])
  })

  it('leaves out a card that is linked to no product', async () => {
    const chat = await chatWith('visa 9999 calendar', HSBC)

    expect(nicknames(await bestAt(chat))).toEqual(['hsbc'])
  })

  it('says what is still needed of a minimum spend that the window has not reached', async () => {
    const chat = await chatWith(EVOL)
    await buy(await chat.userId(), { cardLast4: '5678', amountMinor: 1240 })

    const [evol] = await bestAt(chat)

    expect(evol.neededMinor).toBe(80000 - 1240)
  })

  it('is answered with its usage when no merchant is given', async () => {
    expect(await openChat().say('/best')).toBe(BEST_USAGE)
  })
})
