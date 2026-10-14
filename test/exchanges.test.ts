import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { exchangeStoreFor } from '../src/store-exchanges'
import { calling, saying, type ChatMessage } from './ai-helpers'
import { clock, connectedChat, MINUTE, NOW, openChat, outside } from './connect-helpers'
import { rowsOwnedBy } from './helpers'

// The assistant's recent exchanges: a user's last questions, each with the text of its reply, which go before a new
// question for 30 minutes. The chats, the clock and the provider are those of ./connect-helpers.

const SYSTEM: ChatMessage = { role: 'system', content: expect.any(String) }

function user(content: string): ChatMessage {
  return { role: 'user', content }
}

function assistant(content: string): ChatMessage {
  return { role: 'assistant', content }
}

/** The messages of one of the requests that the provider was posted, which are counted from 1. */
function messagesOf(nth: number): ChatMessage[] {
  return outside.completions[nth - 1].body.messages
}

describe('a question that follows earlier ones', () => {
  it.each([
    [29, [user('Add a made-up pattern to evol.'), assistant('Which merchant?')]],
    [31, []],
  ])('after %i minutes, is sent with the earlier question and its reply before it, or not', async (minutes, before) => {
    const chat = openChat()
    outside.model = [saying('Which merchant?'), saying('A made-up answer.')]

    await chat.rich('Add a made-up pattern to evol.')
    clock.now = new Date(NOW.getTime() + minutes * MINUTE)
    await chat.rich('MADE-UP SHOP')

    expect(messagesOf(2)).toEqual([SYSTEM, ...before, user('MADE-UP SHOP')])
  })

  it('is sent with the latest 3 of them, oldest first', async () => {
    const chat = openChat()
    outside.model = [1, 2, 3, 4, 5].map((n) => saying(`Answer ${n}.`))

    for (const n of [1, 2, 3, 4, 5]) await chat.rich(`Question ${n}?`)

    const earlier = [2, 3, 4].flatMap((n) => [user(`Question ${n}?`), assistant(`Answer ${n}.`)])
    expect(messagesOf(5)).toEqual([SYSTEM, ...earlier, user('Question 5?')])
  })

  it("is sent with none of another user's", async () => {
    outside.model = [saying('An answer for one.'), saying('An answer for the other.')]

    await openChat().rich('A question of one user?')
    await openChat().rich('A question of another?')

    expect(messagesOf(2)).toEqual([SYSTEM, user('A question of another?')])
  })

  it('is sent with the first 1,000 characters of a longer reply', async () => {
    const chat = openChat()
    const long = 'A made-up answer that goes on. '.repeat(40)
    outside.model = [saying(long), saying('Another answer.')]

    await chat.rich('A question?')
    await chat.rich('And another?')

    expect(messagesOf(2)[2]).toEqual(assistant(long.trim().slice(0, 1000)))
  })
})

describe('a purchase that the assistant is asked to add after an earlier question', () => {
  const ANSWER = saying('A made-up answer.')

  it.each([
    ['waits for a press when that answering read purchases', [calling(['call_1', 'find_purchases']), ANSWER], 0],
    ['waits for a press when that reply was a table of spending', [calling(['call_1', 'show_spending'])], 0],
    ['is added at once when it read nothing', [ANSWER], 1],
  ])('%s', async (_, first, added) => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar uob-evol')
    const lunch = { date: '2026-10-09', amount: '5.20', currency: 'SGD', merchant: 'MADE-UP LUNCH', unsure: false }
    const adding = { card: 'evol', category: 'other', purchases: [lunch], more: false }
    outside.model = [...first, calling(['call_2', 'add_purchases', adding])]

    await chat.send('A question?')
    await chat.ask('Add 5.20 at made-up lunch to evol as other spend.')

    expect(await rowsOwnedBy(await chat.userId())).toMatchObject({ transactions: added })
  })
})

describe('a scheduled run of the Worker', () => {
  it.each([
    ['deletes the exchanges older than 30 minutes', false],
    ['checks the mail when they cannot be deleted', true],
  ])('%s', async (_, fails) => {
    const chat = await connectedChat('jane@example.test')
    const exchanges = exchangeStoreFor(env.DB, await chat.userId())
    // The Worker goes by the real clock.
    const now = Math.floor(Date.now() / 1000)
    const [old, recent] = [
      { question: 'Old?', reply: 'Old.', read: false },
      { question: 'Recent?', reply: 'Recent.', read: false },
    ]
    await exchanges.keep(old, now - 31 * 60)
    await exchanges.keep(recent, now - 29 * 60)
    const prepare = env.DB.prepare.bind(env.DB)
    if (fails) {
      vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
        if (query.includes('recent_exchanges WHERE at <')) throw new Error('A made-up failure of the database')
        return prepare(query)
      })
    }

    const context = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '* * * * *' }), env, context)
    await waitOnExecutionContext(context)

    vi.restoreAllMocks()
    expect(await exchanges.recent(0)).toEqual(fails ? [old, recent] : [recent])
    expect(outside.listings).toHaveLength(1)
  })
})
