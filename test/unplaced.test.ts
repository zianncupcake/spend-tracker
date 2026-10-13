import { describe, expect, it, vi } from 'vitest'
import type { Reading } from '../src/telegram/adding'
import { moreNotPlaced, NOT_PLACED } from '../src/telegram/texts'
import { deps, openChat } from './connect-helpers'
import { bought, labels, read, reading, rowsOf, unsure, type Chat } from './photo-helpers'

// The purchases that the bot asks about once it has added several at once, because nothing placed them: after a
// photo, and after the press that adds purchases that were held. The assistant's adding is that of a photo: see
// addRead. ./photo-helpers has the stand-in for the reading of a photo, and the clock.

/** A chat whose user has one card, which is linked to a product that goes by the codes of merchants. */
async function chatWithHsbc(): Promise<Chat> {
  const chat = openChat()
  await chat.say('/addcard hsbc 4321 calendar hsbc-revolution')
  return chat
}

/** What /sort with the id of a purchase shows: its line, what is marked in it, and its buttons. */
async function sortShows(chat: Chat, id: string | number | null) {
  const [{ text, entities, buttons }] = await chat.ask(`/sort ${id}`)
  return { text, entities, buttons }
}

describe('purchases that are added at once', () => {
  it('are asked about after the tables when nothing placed them: one that a code places is not', async () => {
    const chat = await chatWithHsbc()
    reading(read([bought(1240, 'SAMPLE EATERY'), bought(900, 'GRAB*A-123')]))
    const [sendRich, send] = [vi.spyOn(deps.messenger, 'sendRich'), vi.spyOn(deps.messenger, 'send')]

    const { texts } = await chat.photo()

    const [eatery, grab] = await rowsOf(await chat.userId())
    expect([eatery.category, grab.category]).toEqual([null, 'eligible'])
    expect(sendRich.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])
    // Under the line that says why, the purchase is as /sort shows it, with its button.
    const shown = await sortShows(chat, eatery.id)
    expect(shown.buttons).toHaveLength(1)
    expect(texts).toMatchObject([{ text: NOT_PLACED }, shown])
  })

  it('are asked about five at the most: a line counts the rest', async () => {
    const chat = await chatWithHsbc()
    reading(read(Array.from({ length: 6 }, (_, at) => bought(1000 + at, `SAMPLE SHOP ${at + 1}`))))

    const { texts } = await chat.photo()

    const ids = (await rowsOf(await chat.userId())).map((row) => row.id)
    // A question is told by what its button holds, and a line by what it says.
    expect(texts.map((message) => message.buttons?.[0][0].data ?? message.text)).toEqual([
      NOT_PLACED,
      ...ids.slice(0, 5).map((id) => `${id}:other`),
      moreNotPlaced(1),
    ])
  })

  it.each<[what: string, card: string, given: Reading]>([
    ['on a card whose product goes by no codes', 'evol 5678 calendar uob-evol', read([bought(1240, 'SAMPLE EATERY')])],
    ['on a card with no product', 'visa 1234 calendar', read([bought(1240, 'SAMPLE EATERY')])],
    [
      'in another currency',
      'hsbc 4321 calendar hsbc-revolution',
      read([bought(1240, 'SAMPLE EATERY', { currency: 'USD' })]),
    ],
    [
      'in a category that their user named',
      'hsbc 4321 calendar hsbc-revolution',
      read([bought(1240, 'SAMPLE EATERY')], { category: 'eligible' }),
    ],
  ])('are not asked about %s', async (_, card, given) => {
    const chat = openChat()
    await chat.say(`/addcard ${card}`)
    reading(given)

    const { rich, texts } = await chat.photo()

    expect(rich).toBeDefined()
    expect(texts).toEqual([])
  })

  it('are asked about when they were held, once the press of their button adds them', async () => {
    const chat = await chatWithHsbc()
    reading(read([unsure(1240, 'SAMPLE EATERY')]))
    const [asking, ...more] = (await chat.photo()).texts
    expect(more).toEqual([])
    const [add = ''] = labels(asking) ?? []

    const { sent } = await chat.press(asking, add)

    const [row] = await rowsOf(await chat.userId())
    expect(sent).toMatchObject([{ text: NOT_PLACED }, await sortShows(chat, row.id)])
  })
})
