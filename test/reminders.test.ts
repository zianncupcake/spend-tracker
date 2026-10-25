import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import * as assistant from '../src/ai/assistant'
import { nextReminder } from '../src/domain/reminder'
import worker from '../src/index'
import { COMMAND_NAMES } from '../src/log'
import { sendDueReminder } from '../src/reminders'
import { ChatBlockedError, TelegramError } from '../src/telegram/api'
import { billDue, NOT_DONE, REMIND_USAGE } from '../src/telegram/texts'
import { saying } from './ai-helpers'
import { clock, connectedChat, deps, openChat, outside, sent } from './connect-helpers'
import { CARDS_HEADER, seconds } from './helpers'
import { catchConsole } from './log-helpers'

// The reminder that a card's bill is due: when it is due, the command that sets it, and the run that sends it. The
// chats, the clock and the service are those of ./connect-helpers: it is 12:00 on 9 October 2026 in Singapore.

type Chat = ReturnType<typeof openChat>

/**
 * A chat whose user has the card `evol`, and is reminded of its bill on the day of the month: by the clock of the
 * time zone, when one is given, and of Singapore's otherwise.
 */
async function remindedChat(day: number, timeZone?: string): Promise<Chat> {
  const chat = openChat()
  if (timeZone) await chat.say(`/timezone ${timeZone}`)
  await chat.say('/addcard evol 1234 calendar')
  await chat.say(`/remind evol ${day}`)
  return chat
}

/** When the next reminder of a user's card is due, in unix seconds. It reads the table directly. */
async function dueAt(chat: Chat, nickname = 'evol'): Promise<number | null> {
  return env.DB.prepare('SELECT remind_at FROM cards WHERE owner_id = ? AND nickname = ?')
    .bind(await chat.userId(), nickname)
    .first<number>('remind_at')
}

/** What a scheduled run does about reminders, at the time. */
async function runAt(time: string): Promise<void> {
  clock.now = new Date(time)
  await sendDueReminder(deps)
}

describe('when the next reminder of a day of the month is due', () => {
  // Kiritimati is fourteen hours ahead of UTC. In London the clocks go forward at 01:00 on 28 March 2027.
  const [SG, EAST, LONDON] = ['Asia/Singapore', 'Pacific/Kiritimati', 'Europe/London']

  it.each([
    ['at 09:00 that day, at 08:59 on its day', 12, SG, '2026-10-12T08:59:00+08:00', '2026-10-12T09:00:00+08:00'],
    ['a month later, at 09:00 on its day', 12, SG, '2026-10-12T09:00:00+08:00', '2026-11-12T09:00:00+08:00'],
    ['on the 30th for the 31st, in November', 31, SG, '2026-11-12T12:00:00+08:00', '2026-11-30T09:00:00+08:00'],
    ['on the 28th for the 30th, after January’s', 30, SG, '2027-01-30T09:01:00+08:00', '2027-02-28T09:00:00+08:00'],
    ['in January, after December’s', 28, SG, '2026-12-28T09:01:00+08:00', '2027-01-28T09:00:00+08:00'],
    // 10:00 on 1 November there, and still 31 October by UTC.
    ['a month later far east, after 09:00 there', 1, EAST, '2026-10-31T20:00:00Z', '2026-11-30T19:00:00Z'],
    ['at 09:00 by a clock that went forward that day', 28, LONDON, '2027-03-12T12:00:00Z', '2027-03-28T08:00:00Z'],
  ])('is %s', (_, day, timeZone, now, due) => {
    expect(nextReminder(day, timeZone, new Date(now))).toBe(seconds(due))
  })
})

describe('/remind', () => {
  it('sets the reminder of a card of its user’s, which /cards shows, and says when the next one comes', async () => {
    const [chat, bystander] = [openChat(), openChat()]
    await chat.say('/addcard evol 1234 calendar')
    await bystander.say('/addcard evol 1234 calendar')

    const reply = await chat.say('/remind evol 12')

    expect(reply).toContain('12 Oct, 09:00')
    expect(await chat.lines('/cards')).toEqual([
      CARDS_HEADER,
      'evol | ••••1234 | calendar month | - | day 12 | -',
    ])
    expect(await bystander.lines('/cards')).toEqual([
      CARDS_HEADER,
      'evol | ••••1234 | calendar month | - | - | -',
    ])
    // As text, which is what is sent when Telegram does not take the table.
    vi.spyOn(deps.messenger, 'sendRich').mockRejectedValue(new TelegramError('sendRichMessage', 400))
    expect(await chat.say('/cards')).toContain('day 12')
  })

  it('replaces the reminder that the card has, with a day up to the 31st', async () => {
    const chat = await remindedChat(12)

    await chat.say('/remind evol 31')

    expect(await chat.lines('/cards')).toEqual([
      CARDS_HEADER,
      'evol | ••••1234 | calendar month | - | day 31 | -',
    ])
    expect(await dueAt(chat)).toBe(seconds('2026-10-31T09:00:00+08:00'))
  })

  it('leaves a reminder that is due and waiting to be sent where it is, given the day that the card has', async () => {
    const chat = await remindedChat(12)
    clock.now = new Date('2026-10-12T09:01:00+08:00')

    expect(await chat.say('/remind evol 12')).toContain('12 Oct, 09:00')

    expect(await dueAt(chat)).toBe(seconds('2026-10-12T09:00:00+08:00'))
  })

  it('takes the reminder away with "none", however that is typed', async () => {
    const chat = await remindedChat(12)

    await chat.say('/remind evol NONE')

    expect(await chat.lines('/cards')).toEqual([CARDS_HEADER, 'evol | ••••1234 | calendar month | - | - | -'])
    expect(await dueAt(chat)).toBeNull()
  })

  it.each(['0', '32', '1e1', '12 13'])('answers "%s" for a day with the usage', async (day) => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar')

    expect(await chat.say(`/remind evol ${day}`)).toBe(REMIND_USAGE)

    expect(await dueAt(chat)).toBeNull()
  })

  it('sets nothing for a card that the user has not got, and says which', async () => {
    const chat = openChat()
    await chat.say('/addcard evol 1234 calendar')

    expect(await chat.say('/remind visa 12')).toContain('visa')

    expect(await dueAt(chat)).toBeNull()
  })
})

describe('the reminders of a user who changes their time zone', () => {
  it('are moved to 09:00 there, each by its own day, and nobody else’s are', async () => {
    const [chat, bystander] = [await remindedChat(12), await remindedChat(12)]
    await chat.say('/addcard spare 5678 calendar')
    await chat.say('/remind spare 28')

    await chat.say('/timezone Asia/Tokyo')

    expect(await dueAt(chat)).toBe(seconds('2026-10-12T09:00:00+09:00'))
    expect(await dueAt(chat, 'spare')).toBe(seconds('2026-10-28T09:00:00+09:00'))
    expect(await dueAt(bystander)).toBe(seconds('2026-10-12T09:00:00+08:00'))
  })

  const [SET, BEFORE, AFTER] = ['2026-10-09T12:00:00+08:00', '2026-10-12T08:59:00+08:00', '2026-10-12T09:01:00+08:00']

  // Honolulu is ten hours behind UTC and Kiritimati fourteen ahead of it: a whole day apart.
  const [HERE, WEST, EAST] = ['Asia/Singapore', 'Pacific/Honolulu', 'Pacific/Kiritimati']

  it.each([
    // 09:00 has passed in Tokyo, so it is due at once, and is not put off to November.
    ['east, a minute before it is due', SET, BEFORE, HERE, 'Asia/Tokyo', '2026-10-12T09:00:00+09:00'],
    // The same, where 09:00 passed a day ago: it is 08:59 on the 12th in Honolulu, and on the 13th in Kiritimati.
    ['a whole day east, before it is due', SET, '2026-10-12T08:59:00-10:00', WEST, EAST, '2026-10-12T09:00:00+14:00'],
    // It was due a minute ago, so its next is November's, and is not due again when 09:00 comes to Kolkata.
    ['west, a minute after it was due', AFTER, AFTER, HERE, 'Asia/Kolkata', '2026-11-12T09:00:00+05:30'],
    ['to their own zone, while one waits to be sent', SET, AFTER, HERE, HERE, '2026-10-12T09:00:00+08:00'],
  ])('stay on the day that each was on, when the change is %s', async (_, setAt, changedAt, from, to, due) => {
    clock.now = new Date(setAt)
    const chat = await remindedChat(12, from)
    clock.now = new Date(changedAt)

    await chat.say(`/timezone ${to}`)

    expect(await dueAt(chat)).toBe(seconds(due))
  })
})

describe('a reminder that is due', () => {
  it('is sent once, to the user of its card and naming the card, with its next one a month on by then', async () => {
    const chat = await remindedChat(12)
    let dueWhenSent: number | null = null
    const send = vi.spyOn(deps.messenger, 'send').mockImplementation(async () => {
      dueWhenSent = await dueAt(chat)
    })
    const queried = vi.spyOn(env.DB, 'prepare')

    await runAt('2026-10-12T08:59:00+08:00')
    // With none due, a run makes the one query that looks for one.
    expect(queried).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    await runAt('2026-10-12T09:00:00+08:00')
    expect(send.mock.calls).toEqual([[chat.telegramId, expect.stringContaining('evol ••••1234')]])
    await runAt('2026-10-12T09:01:00+08:00')

    expect(send).toHaveBeenCalledTimes(1)
    expect(dueWhenSent).toBe(seconds('2026-11-12T09:00:00+08:00'))
  })

  it('is due at 09:00 in the time zone of its user, which /remind names, and so is the one after it', async () => {
    const chat = openChat()
    await chat.say('/timezone Asia/Tokyo')
    await chat.say('/addcard evol 1234 calendar')

    expect(await chat.say('/remind evol 12')).toContain('Asia/Tokyo')

    expect(await dueAt(chat)).toBe(seconds('2026-10-12T09:00:00+09:00'))
    await runAt('2026-10-12T09:00:00+09:00')
    expect(await dueAt(chat)).toBe(seconds('2026-11-12T09:00:00+09:00'))
  })

  it('goes after one that has been due longer, a run to each, and each of two users’ to its own chat', async () => {
    const chat = await remindedChat(12)
    await chat.say('/addcard spare 5678 calendar')
    await chat.say('/remind spare 12')
    // Added last, and due an hour before the others: 09:00 comes to Tokyo first.
    const tokyo = await remindedChat(12)
    await tokyo.say('/timezone Asia/Tokyo')

    for (const minute of [0, 1, 2, 3]) await runAt(`2026-10-12T09:0${minute}:00+08:00`)

    expect(sent).toEqual([
      { chatId: tokyo.telegramId, text: billDue('evol ••••1234') },
      { chatId: chat.telegramId, text: billDue('evol ••••1234') },
      { chatId: chat.telegramId, text: billDue('spare ••••5678') },
    ])
  })

  it('is sent once after a long gap in the runs, and next on its day after that', async () => {
    const chat = await remindedChat(12)

    await runAt('2027-01-20T12:00:00+08:00')
    await runAt('2027-01-20T12:01:00+08:00')

    expect(sent).toHaveLength(1)
    expect(await dueAt(chat)).toBe(seconds('2027-02-12T09:00:00+08:00'))
  })

  it('is sent by one of two runs that come at once', async () => {
    const chat = await remindedChat(12)
    clock.now = new Date('2026-10-12T09:00:00+08:00')

    await Promise.all([sendDueReminder(deps), sendDueReminder(deps)])

    expect(sent).toEqual([{ chatId: chat.telegramId, text: billDue('evol ••••1234') }])
  })

  it('is passed over until the next month when its chat has blocked the bot, and the next one is sent', async () => {
    const [blocked, chat] = [await remindedChat(12), await remindedChat(12)]
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new ChatBlockedError())

    await runAt('2026-10-12T09:00:00+08:00')
    await runAt('2026-10-12T09:01:00+08:00')

    expect(sent).toEqual([{ chatId: chat.telegramId, text: billDue('evol ••••1234') }])
    expect(await dueAt(blocked)).toBe(seconds('2026-11-12T09:00:00+08:00'))
  })

  it.each([
    ['ten minutes later, while that is still its day', '2026-10-12T23:49:00+08:00', '2026-10-12T23:59:00+08:00'],
    ['a month later, when ten minutes later is the next day', '2026-10-12T23:50:00+08:00', '2026-11-12T09:00:00+08:00'],
  ])('is tried again %s, when it could not be sent', async (_, failedAt, next) => {
    const chat = await remindedChat(12)
    vi.spyOn(deps.messenger, 'send').mockRejectedValueOnce(new TelegramError('sendMessage', 500))

    await runAt(failedAt)

    expect(await dueAt(chat)).toBe(seconds(next))
    await runAt(next)
    expect(sent).toEqual([{ chatId: chat.telegramId, text: billDue('evol ••••1234') }])
  })

  it('does not undo a /remind that is made while it is being sent, when it then cannot be sent', async () => {
    const chat = await remindedChat(12)
    vi.spyOn(deps.messenger, 'send').mockImplementationOnce(async () => {
      await chat.say('/remind evol 28')
      throw new TelegramError('sendMessage', 500)
    })

    await runAt('2026-10-12T09:00:00+08:00')

    expect(await dueAt(chat)).toBe(seconds('2026-10-28T09:00:00+08:00'))
  })

  it('steps aside for a day when its next one cannot be worked out, and the one after it is sent', async () => {
    const [stuck, chat] = [await remindedChat(12), await remindedChat(12)]
    // A time zone that the runtime does not know, written to the table directly: /timezone takes no such name.
    const userId = await stuck.userId()
    await env.DB.prepare('UPDATE users SET timezone = ? WHERE id = ?').bind('Nowhere/Made_Up', userId).run()
    const logged = catchConsole()

    await runAt('2026-10-12T09:00:00+08:00')
    await runAt('2026-10-12T09:01:00+08:00')

    expect(sent).toEqual([{ chatId: chat.telegramId, text: billDue('evol ••••1234') }])
    expect(await dueAt(stuck)).toBe(seconds('2026-10-13T09:00:00+08:00'))
    expect(logged.failures()).toEqual([{ event: 'reminder', user: userId, outcome: 'failed', error: 'RangeError' }])
  })

  it('goes with its card when the card is removed, which /removecard says', async () => {
    const chat = await remindedChat(12)

    expect(await chat.say('/removecard evol')).toContain('reminder')

    await runAt('2026-10-12T09:00:00+08:00')
    expect(sent).toEqual([])
  })

  it('goes with its user when they delete everything', async () => {
    const chat = await remindedChat(12)
    await chat.say('/delete confirm')

    await runAt('2026-10-12T09:00:00+08:00')

    expect(sent).toEqual([])
  })

  const REFUSED = { error: 'Error', reason: 'http_error', status: 500 }

  it.each([
    ['sent', undefined, { outcome: 'sent' }],
    ['passed over', new ChatBlockedError(), { outcome: 'blocked' }],
    ['not sent', new TelegramError('sendMessage', 500), { outcome: 'failed', ...REFUSED }],
  ])('has one line in the log when it is %s: the number of its user and what came of it', async (_, error, came) => {
    const chat = await remindedChat(12)
    const userId = await chat.userId()
    if (error) vi.spyOn(deps.messenger, 'send').mockRejectedValue(error)
    const logged = catchConsole()

    await runAt('2026-10-12T09:00:00+08:00')

    expect(logged.events()).toEqual([{ event: 'reminder', user: userId, ...came }])
    for (const text of ['evol', '1234', String(chat.telegramId)]) expect(logged.text()).not.toContain(text)
  })
})

describe('a scheduled run of the Worker', () => {
  it.each([
    ['has sent a reminder that was due', false],
    ['could not look for one', true],
  ])('checks the mail when it %s', async (_, lookFails) => {
    const chat = await connectedChat('jane@example.test')
    await chat.say('/addcard evol 1234 calendar')
    await chat.say('/remind evol 12')
    // The Worker goes by the real clock, by which the reminder is made due a minute ago: in the table directly.
    const dueSince = Math.floor(Date.now() / 1000) - 60
    await env.DB.prepare('UPDATE cards SET remind_at = ? WHERE owner_id = ?').bind(dueSince, await chat.userId()).run()
    const prepare = env.DB.prepare.bind(env.DB)
    const failing = (query: string) => {
      if (query.includes('remind_at <=')) throw new Error('A made-up failure of the database')
      return prepare(query)
    }
    if (lookFails) vi.spyOn(env.DB, 'prepare').mockImplementation(failing)
    const logged = catchConsole()

    const context = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '* * * * *' }), env, context)
    await waitOnExecutionContext(context)

    expect(outside.telegrams.map((message) => message.chat_id)).toEqual(lookFails ? [] : [chat.telegramId])
    expect(outside.listings).toHaveLength(1)
    expect(logged.events('reminder')).toMatchObject([{ outcome: lookFails ? 'failed' : 'sent' }])
  })
})

describe('a reminder that the assistant is asked for', () => {
  /** Has the assistant make the running of a command of the message that follows: see test/actions.test.ts. */
  function acting(line: string): void {
    const answer = { status: 'acting' as const, afterReading: false, dropped: 0, more: false }
    vi.spyOn(assistant, 'answerQuestion').mockResolvedValue({ ...answer, actions: [{ kind: 'command', line }] })
  }

  it.each([
    ['set', 12, '/remind evol 28', true, seconds('2026-10-28T09:00:00+08:00')],
    ['taken away', 28, '/remind evol none', false, null],
  ])('is asked about first, and %s on "Do it"', async (_, had, line, namesDay, due) => {
    const chat = await remindedChat(had)
    const before = await dueAt(chat)
    acting(line)

    const [asking] = await chat.ask('made-up words')

    // The question names the card and, when a day is to be set, the day. No digit of the card is of the day.
    expect(asking.text).toContain('evol ••••1234')
    expect(asking.text.includes('28')).toBe(namesDay)
    expect(await dueAt(chat)).toBe(before)
    await chat.press(asking, 'Do it')
    expect(await dueAt(chat)).toBe(due)
  })

  it('is not asked about when its line is one that /remind would not take', async () => {
    const chat = await remindedChat(12)
    acting('/remind evol 32')

    const [said] = await chat.ask('made-up words')

    expect(said.text).toBe(NOT_DONE)
    expect(said.buttons).toBeUndefined()
  })

  it('is asked for with a command that the model is told of, as each is that it may give to be run', async () => {
    const chat = openChat()
    outside.model = [saying('A made-up answer.')]

    await chat.send('made-up words')

    // All the bot's commands but those that a tool of their own stands in for, and /start and /code.
    const told = outside.completions[0].body.messages[0].content
    const given = COMMAND_NAMES.filter((name) => !['start', 'spend', 'add', 'sort', 'code'].includes(name))
    for (const name of given) expect(told).toMatch(new RegExp(`/${name}\\b`))
  })
})
