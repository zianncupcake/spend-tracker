import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { HEADER_CHECKS_PER_RUN, MESSAGES_PER_RUN, runCheck } from '../src/checker'
import { depsFor, type Deps } from '../src/deps'
import worker from '../src/index'
import { storeFor } from '../src/store'
import { heldStoreFor } from '../src/store-held'
import { mailStoreFor } from '../src/store-mail'
import { NO_SIGN_IN } from '../src/telegram/texts'
import {
  attemptOf,
  clock,
  connectedChat,
  connectionOf,
  deps,
  MESSAGES_URL,
  MINUTE,
  NOW,
  openChat,
  outside,
  posted,
  sent,
  signIn,
  TELEGRAM_URL,
  TOKEN_URL,
} from './connect-helpers'
import { gmailMessage, gmailResults, htmlPart, textPart, type Message, type MessageOptions } from './gmail-helpers'
import { alertText, seconds } from './helpers'
import { catchConsole } from './log-helpers'

const JANE = 'jane@example.test'
const SAM = 'sam@example.test'
const DAY = 86_400
/** The address that OCBC sends its card alerts from. A bank's domain is public. */
const OCBC = 'noreply@notify.ocbc.com'

const ADD_CARD_HINT = [
  'This card is not added yet. Add it with:',
  '/addcard <nickname> 1234 statement <day>',
  '/addcard <nickname> 1234 calendar',
].join('\n')

/**
 * What the line that a run logs of itself says of a run that did nothing, in no time: there was no mailbox to
 * check. A test says what a run did by what its line has besides.
 */
const NOTHING_DONE = {
  mailbox: false,
  user: null,
  listed: 0,
  unknown: 0,
  headers: 0,
  read: 0,
  stored: 0,
  unparsed: 0,
  rejected: 0,
  notified: 0,
  checked: false,
  swept: 0,
  batches: 0,
  ms: 0,
}

/**
 * The service with the messenger that posts to Telegram. The stand-in for Telegram keeps the whole of what it is
 * posted, and can refuse it, where the messenger of `deps` only notes the text.
 */
const posting: Deps = { ...depsFor(env), now: () => clock.now }

/** The service's clock, in unix seconds. */
function now(): number {
  return clock.now.getTime() / 1000
}

function later(minutes: number): Date {
  return new Date(clock.now.getTime() + minutes * MINUTE)
}

/** An alert that Gmail found to be from the invented Example Bank, received so many minutes ago. */
function alert(id: string, minutesAgo: number, text = alertText('SGD 12.40', '1234')): Message {
  return gmailMessage({ id, receivedAt: now() - minutesAgo * 60, content: textPart(text) })
}

/** Mail with the bank's address on it and an alert for its text, which Gmail did not find to be from the bank. */
function lookalike(id: string): Message {
  return gmailMessage({ id, receivedAt: now() - 60, results: [gmailResults('fail', 'examplebank.test')] })
}

/** Notes messages as seen already, as the runs before would have left them. It writes to the table directly. */
async function markKnown(userId: number, messages: Message[]): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO seen_alerts (owner_id, source_id, status) SELECT ?1, value, 'unparsed' FROM json_each(?2)",
  )
    .bind(userId, JSON.stringify(messages.map((message) => message.id)))
    .run()
}

// The three functions below read the tables directly, as the counts in helpers.ts do.

async function purchasesOf(userId: number) {
  const { results } = await env.DB.prepare(
    `SELECT source_id, card_last4, amount_minor, currency, merchant, occurred_at, parser
     FROM transactions WHERE owner_id = ? ORDER BY id`,
  )
    .bind(userId)
    .all()
  return results
}

/** The id and the category of each of a user's purchases, by the id of the alert it was read from. */
async function sortedOf(userId: number): Promise<Record<string, { id: number; category: string | null }>> {
  const { results } = await env.DB.prepare('SELECT id, source_id, category FROM transactions WHERE owner_id = ?')
    .bind(userId)
    .all<{ id: number; source_id: string; category: string | null }>()
  return Object.fromEntries(results.map(({ id, source_id, category }) => [source_id, { id, category }]))
}

async function seenOf(userId: number) {
  const { results } = await env.DB.prepare(
    'SELECT source_id, status FROM seen_alerts WHERE owner_id = ? ORDER BY source_id',
  )
    .bind(userId)
    .all()
  return results
}

async function attemptCount(): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM connect_attempts').first<number>('n')) ?? 0
}

describe('a new alert', () => {
  it('is stored as a purchase, and the user is told of it with the running total of its card', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    await chat.say('/addcard visa 1234 statement 15') // its window is 16 September to 16 October
    const earlier: [at: string, amountMinor: number, currency: string][] = [
      ['2026-09-10T10:00:00+08:00', 9900, 'SGD'], // before the window
      ['2026-09-20T10:00:00+08:00', 123456, 'SGD'],
      ['2026-10-06T10:00:00+08:00', 500, 'USD'],
    ]
    for (const [index, [at, amountMinor, currency]] of earlier.entries()) {
      await storeFor(env.DB, userId).insertTransaction({
        sourceId: `earlier-${index}`,
        cardLast4: '1234',
        amountMinor,
        currency,
        merchant: null,
        occurredAt: seconds(at),
        parser: 'example-bank',
      })
    }
    outside.mailboxes[JANE] = [alert('msg-1', 5)]

    await runCheck(deps)

    expect(sent).toEqual([
      {
        chatId: chat.telegramId,
        text:
          'visa ••••1234: SGD 12.40 at COFFEE PLACE\n' +
          'Running total: SGD 1,246.96 + USD 5.00 in 3 purchases, resets 16 Oct',
      },
    ])
    expect(await purchasesOf(userId)).toContainEqual({
      source_id: 'msg-1',
      card_last4: '1234',
      amount_minor: 1240,
      currency: 'SGD',
      merchant: 'COFFEE PLACE',
      occurred_at: now() - 5 * 60,
      parser: 'example-bank',
    })
    expect(await seenOf(userId)).toEqual([])
    // The second line is what /spend says of the card.
    expect(await chat.lines('/spend')).toContain('visa | SGD 1,246.96 + USD 5.00 | 3 | 14 Sep to 13 Oct | 16 Oct')
  })

  it('comes with how to add its card, when the user has not added that card', async () => {
    const chat = await connectedChat(JANE)
    await chat.say('/addcard other 9999 calendar')
    outside.mailboxes[JANE] = [alert('msg-1', 5)]

    await runCheck(deps)

    expect(sent).toEqual([
      { chatId: chat.telegramId, text: `Card ••••1234: SGD 12.40 at COFFEE PLACE\n${ADD_CARD_HINT}` },
    ])
    expect((await purchasesOf(await chat.userId())).map((purchase) => purchase.source_id)).toEqual(['msg-1'])
  })

  it("is read when Gmail authenticated the domain above the sender's, which is what it names for OCBC", async () => {
    const authenticated = 'ocbc.com'
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    // What Gmail records of an OCBC alert: the address is under notify.ocbc.com, and the DMARC result names the
    // domain that the policy is for. The alert is HTML only, with its sentence on one line between line breaks.
    const results = [
      'mx.google.com',
      'dkim=pass header.i=@notify.ocbc.com header.s=made-up header.b=AbCdEfGh',
      `spf=pass (google.com: domain of ${OCBC} designates 192.0.2.1 as permitted sender) smtp.mailfrom=${OCBC}`,
      `dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=${authenticated}`,
    ].join(';\r\n       ')
    const html =
      '<html><body>Dear Sir / Madam,<br/><br/>' +
      'We wish to inform you that SGD12.34 was charged at 11:55 on 09-Oct-26 to your card (-1234) at SOME MERCHANT.' +
      '<br/><br/>Did not make this transaction? Call the number on the back of your card.<br/></body></html>'
    const [from, content] = [`OCBC Alerts <${OCBC}>`, htmlPart(html)]
    outside.mailboxes[JANE] = [gmailMessage({ from, receivedAt: now() - 60, results: [results], content })]

    await runCheck(deps)

    expect(await purchasesOf(userId)).toEqual([
      {
        source_id: 'msg-1',
        card_last4: '1234',
        amount_minor: 1234,
        currency: 'SGD',
        merchant: 'SOME MERCHANT',
        occurred_at: now() - 5 * 60,
        parser: 'ocbc',
      },
    ])
    expect(await seenOf(userId)).toEqual([])
    expect(sent.map((message) => message.text)).toEqual([`Card ••••1234: SGD 12.34 at SOME MERCHANT\n${ADD_CARD_HINT}`])
  })

  it.each<[what: string, nickname: string | null, offset: number, rest: string]>([
    ['a card that is not added', null, 28, ADD_CARD_HINT],
    ['a card that is', 'everyday', 32, 'Running total: SGD 12.40 in 1 purchase, resets 1 Nov'],
  ])('is told of with the name of its merchant marked as code, on %s', async (_, nickname, offset, rest) => {
    const chat = await connectedChat(JANE)
    if (nickname) await chat.say(`/addcard ${nickname} 1234 calendar`)
    // What the sender of an email could put where the merchant's name goes. Telegram would make a command and a
    // link of these: each of them something to tap, in a message of the bot's.
    const merchant = '𝒳 /disconnect https://attacker.test/x'
    outside.mailboxes[JANE] = [alert('msg-1', 5, alertText('SGD 12.40', '1234', merchant))]

    await runCheck(posting)

    const text = `${nickname ?? 'Card'} ••••1234: SGD 12.40 at ${merchant}\n${rest}`
    expect(outside.telegrams).toEqual([
      {
        chat_id: chat.telegramId,
        text,
        // In UTF-16 code units, as the indices of a string are: the 𝒳 is two of the 38.
        entities: [{ type: 'code', offset, length: 38 }],
        link_preview_options: { is_disabled: true },
      },
    ])
    // The name is marked, and no more or less of the message than the name.
    expect(text.slice(offset, offset + 38)).toBe(merchant)
  })

  it('is told of with nothing marked when the alert names no merchant', async () => {
    await connectedChat(JANE)
    outside.mailboxes[JANE] = [alert('msg-1', 5, alertText('SGD 12.40', '1234', ' '))]

    await runCheck(posting)

    expect(outside.telegrams.map((message) => message.text)).toEqual([`Card ••••1234: SGD 12.40\n${ADD_CARD_HINT}`])
    expect(outside.telegrams[0]).not.toHaveProperty('entities')
  })

  it('is told of when its email has just come, though it dates its purchase more than six hours back', async () => {
    const chat = await connectedChat(JANE)
    // UOB states a day and no time. Ten minutes after midnight, an alert has just come for the day before, and its
    // purchase is dated at noon of that day.
    clock.now = new Date('2026-10-10T00:10:00+08:00')
    const sentence = 'A transaction of SGD 45.60 was made with your UOB Card ending 1234 on 09/10/26 at SAMPLE EATERY.'
    outside.mailboxes[JANE] = [
      gmailMessage({
        from: 'UOB <unialerts@uobgroup.com>',
        receivedAt: now() - 5 * 60,
        results: [gmailResults('pass', 'uobgroup.com')],
        content: textPart(`${sentence} If unauthorised, call 24/7 Fraud Hotline now`),
      }),
    ]

    await runCheck(deps)

    expect(await purchasesOf(await chat.userId())).toMatchObject([
      { source_id: 'msg-1', parser: 'uob', occurred_at: seconds('2026-10-09T12:00:00+08:00') },
    ])
    expect(sent.map((message) => message.text)).toEqual([`Card ••••1234: SGD 45.60 at SAMPLE EATERY\n${ADD_CARD_HINT}`])
  })

  it('is stored without a message when its email came six hours ago or longer', async () => {
    const chat = await connectedChat(JANE)
    outside.mailboxes[JANE] = [
      alert('msg-3', 6 * 60 - 1, alertText('SGD 3.00', '1234')),
      alert('msg-2', 6 * 60, alertText('SGD 2.00', '1234')),
      alert('msg-1', 34 * 24 * 60, alertText('SGD 1.00', '1234')),
    ]

    // A run reads one alert.
    for (let run = 1; run <= 3; run++) await runCheck(deps)

    expect(sent.map((message) => message.text)).toEqual([`Card ••••1234: SGD 3.00 at COFFEE PLACE\n${ADD_CARD_HINT}`])
    const stored = await purchasesOf(await chat.userId())
    expect(stored.map((purchase) => purchase.source_id)).toEqual(['msg-3', 'msg-2', 'msg-1'])
  })

  it('is stored once and told of once, when two runs come upon it together', async () => {
    const chat = await connectedChat(JANE)
    outside.mailboxes[JANE] = [alert('msg-1', 5)]

    await Promise.all([runCheck(deps), runCheck(deps)])

    expect(sent).toHaveLength(1)
    expect(await purchasesOf(await chat.userId())).toHaveLength(1)
  })
})

describe('a new alert for a card that is linked to a product', () => {
  /** A chat whose user has connected a mailbox, and has a card ending 1234 that is linked to the UOB EVOL Card. */
  async function chatWithProduct() {
    const chat = await connectedChat(JANE)
    await chat.say('/addcard evol 1234 calendar uob-evol')
    // What the bot has said until now is not what these tests are about.
    posted.length = 0
    return chat
  }

  it.each([
    ['in another currency', 'USD 5.00', 'COFFEE PLACE', 'fx', 'Overseas Foreign Currency Spend'],
    [
      'at a merchant that the product lists',
      'SGD 5.00',
      'NETFLIX.COM',
      'selected',
      'Selected Gym, Telco and Streaming Spend',
    ],
  ])('is told of with where a rule sorted it, when it is %s', async (_, amount, merchant, category, name) => {
    const chat = await chatWithProduct()
    outside.mailboxes[JANE] = [alert('msg-1', 5, alertText(amount, '1234', merchant))]

    await runCheck(deps)

    const stored = (await sortedOf(await chat.userId()))['msg-1']
    expect(stored.category).toBe(category)
    const [message, ...more] = posted
    expect(more).toEqual([])
    expect(message.text.split('\n')).toEqual([
      `evol ••••1234: ${amount} at ${merchant}`,
      `Running total: ${amount} in 1 purchase, resets 1 Nov`,
      `ID ${stored.id}: ${name}`,
    ])
    // It can be flagged, or put with the online purchases.
    expect(message.buttons).toEqual([
      [{ text: 'Mark as Online / Mobile Contactless Spend', data: `${stored.id}:online` }],
      [{ text: 'Mark as Other Spend', data: `${stored.id}:other` }],
    ])
  })

  it('is told of as online, with the one button that flags it, when no rule settles where it belongs', async () => {
    const chat = await chatWithProduct()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]

    await runCheck(deps)

    const { id, category } = (await sortedOf(await chat.userId()))['msg-1']
    expect(category).toBeNull()
    const [message] = posted
    expect(message.text).toBe(
      'evol ••••1234: SGD 12.40 at COFFEE PLACE\n' +
        'Running total: SGD 12.40 in 1 purchase, resets 1 Nov\n' +
        `ID ${id}: Online / Mobile Contactless Spend`,
    )
    expect(message.entities).toEqual([{ type: 'code', offset: 28, length: 12 }])
    expect(message.buttons).toEqual([[{ text: 'Mark as Other Spend', data: `${id}:other` }]])

    // A press flags it. The message keeps what it said of the purchase and of the card, its last line changes, and
    // its button becomes the one that takes the flag off.
    expect(await chat.press(message, 'Mark as Other Spend')).toEqual({ answer: `ID ${id}: Other Spend`, sent: [] })
    expect(message.text).toBe(
      'evol ••••1234: SGD 12.40 at COFFEE PLACE\n' +
        'Running total: SGD 12.40 in 1 purchase, resets 1 Nov\n' +
        `ID ${id}: Other Spend`,
    )
    expect(message.entities).toEqual([{ type: 'code', offset: 28, length: 12 }])
    expect(message.buttons).toEqual([[{ text: 'Mark as Online / Mobile Contactless Spend', data: `${id}:online` }]])
    expect((await sortedOf(await chat.userId()))['msg-1'].category).toBe('other')
  })

  it('is told of with the statement month that counts it, when it was made in the last two days', async () => {
    // The 4th of November, the day before the statement of a card that closes on the 5th does.
    clock.now = new Date('2026-11-04T12:00:00+08:00')
    const chat = await connectedChat(JANE)
    await chat.say('/addcard evol 1234 statement 5 uob-evol')
    posted.length = 0
    outside.mailboxes[JANE] = [alert('msg-1', 5)]

    await runCheck(deps)

    const { id } = (await sortedOf(await chat.userId()))['msg-1']
    const [message, ...more] = posted
    expect(more).toEqual([])
    const told = [
      'evol ••••1234: SGD 12.40 at COFFEE PLACE',
      // The card's total is that of the statement month to come, which is the one that counts the purchase.
      'Running total: SGD 12.40 in 1 purchase, resets 6 Dec',
      'This purchase was made in the last 2 days before the statement closes on 5 Nov, and so is counted in the ' +
        'statement month that begins on 6 Nov. The bank counts a purchase by the day it is posted.',
    ]
    expect(message.text.split('\n')).toEqual([...told, `ID ${id}: Online / Mobile Contactless Spend`])
    // A press changes the last line, which says where the purchase is, and leaves the note as it is.
    await chat.press(message, 'Mark as Other Spend')
    expect(message.text.split('\n')).toEqual([...told, `ID ${id}: Other Spend`])
  })

  it("is sorted by its own user's card, whatever product another user's card with the same digits has", async () => {
    const jane = await chatWithProduct()
    const sam = await connectedChat(SAM)
    await sam.say('/addcard plain 1234 calendar')
    posted.length = 0
    outside.mailboxes[JANE] = [alert('msg-1', 5, alertText('USD 5.00', '1234'))]
    outside.mailboxes[SAM] = [alert('msg-1', 5, alertText('USD 5.00', '1234'))]

    await runCheck(deps)
    await runCheck(deps)

    expect((await sortedOf(await jane.userId()))['msg-1'].category).toBe('fx')
    expect((await sortedOf(await sam.userId()))['msg-1'].category).toBeNull()
    // Only the message about the card with a product says where the purchase is, and has buttons.
    const told = posted.map(({ chatId, text, buttons }) => [chatId, text.split('\n').length, buttons?.length])
    expect(told).toEqual([
      [jane.telegramId, 3, 2],
      [sam.telegramId, 2, undefined],
    ])
  })
})

describe('an alert that is not stored', () => {
  const FAIL = gmailResults('fail', 'examplebank.test')

  it('is noted as unparsed when no parser can read it, and is not fetched again', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.mailboxes[JANE] = [alert('msg-1', 5, 'Your statement is ready.')]

    await runCheck(deps)

    expect(await seenOf(userId)).toEqual([{ source_id: 'msg-1', status: 'unparsed' }])
    expect(await purchasesOf(userId)).toEqual([])
    expect(sent).toEqual([])
    expect(outside.fetched).toEqual(['msg-1'])

    await runCheck(deps)

    expect(outside.listings).toHaveLength(2)
    expect(outside.fetchedHeaders).toEqual(['msg-1'])
    expect(outside.fetched).toEqual(['msg-1'])
    expect(await seenOf(userId)).toEqual([{ source_id: 'msg-1', status: 'unparsed' }])
  })

  it.each<[why: string, message: MessageOptions]>([
    ['it was authenticated for another domain', { results: [gmailResults('pass', 'attacker.test')] }],
    [
      "it was authenticated for a domain under the bank's",
      { results: [gmailResults('pass', 'mail.examplebank.test')] },
    ],
    [
      "it was authenticated for a domain that the one above the sender's only ends with",
      { from: OCBC, results: [gmailResults('pass', 'cbc.com')] },
    ],
    ['it was authenticated for a name with no dot in it', { from: OCBC, results: [gmailResults('pass', 'com')] }],
    ["it is from an address of the bank's that alerts do not come from", { from: 'offers@examplebank.test' }],
  ])('is rejected when %s: on its headers, fetched once, with the rest of it never fetched', async (_, message) => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    // Its text is an alert that would be stored, were the message believed.
    outside.mailboxes[JANE] = [gmailMessage({ id: 'msg-1', receivedAt: now() - 60, ...message })]

    await runCheck(deps)
    await runCheck(deps)

    expect(await seenOf(userId)).toEqual([{ source_id: 'msg-1', status: 'rejected' }])
    expect(await purchasesOf(userId)).toEqual([])
    expect(sent).toEqual([])
    expect(outside.fetchedHeaders).toEqual(['msg-1'])
    expect(outside.fetched).toEqual([])
  })

  it('is rejected on the headers that come with the whole message too, with its body left undecoded', async () => {
    const logged = catchConsole()
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    const unreadable = { mimeType: 'text/plain', body: { size: 11, data: 'not base64!' } }
    outside.mailboxes[JANE] = [gmailMessage({ receivedAt: now() - 60 })]
    // Gmail is not expected to say one thing of a message's headers and then another. Should it ever, what counts
    // is what it says with the text that would be read. Here the message changes once its headers have been fetched.
    const standIn = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const response = await standIn(url, init)
      if (url.includes('format=metadata')) {
        outside.mailboxes[JANE] = [gmailMessage({ receivedAt: now() - 60, results: [FAIL], content: unreadable })]
      }
      return response
    })

    await runCheck(deps)

    expect(outside.fetched).toEqual(['msg-1'])
    expect(await seenOf(userId)).toEqual([{ source_id: 'msg-1', status: 'rejected' }])
    expect(await purchasesOf(userId)).toEqual([])
    // Nothing failed, as nothing tried to decode the body: the run read one message, and turned that one away.
    expect(logged.events('check_failed')).toEqual([])
    expect(logged.events('check')).toMatchObject([{ headers: 1, read: 1, rejected: 1, stored: 0, unparsed: 0 }])
  })
})

describe('what a run asks of Gmail', () => {
  it('is mail from the banks: from 35 days before it was connected, then from a day before the last check', async () => {
    await connectedChat(JANE)
    // One more alert than a run reads, so the first full check takes two runs.
    outside.mailboxes[JANE] = Array.from({ length: MESSAGES_PER_RUN + 1 }, (_, index) => alert(`msg-${index}`, 400))

    for (let run = 1; run <= 3; run++) {
      await runCheck(deps)
      clock.now = later(90)
    }

    const connected = NOW.getTime() / 1000
    const fullyChecked = connected + 90 * 60
    const senders = [
      'alerts@examplebank.test',
      'noreply@notify.ocbc.com',
      'unialerts@uobgroup.com',
      'hsbc.bank.singapore.limited@notification.hsbc.com.hk',
    ].join(' OR ')
    const since = (time: number) => `from:(${senders}) after:${time} smaller:1M`
    // The second run makes the search that the first made, an hour and a half after it. Only a full check moves
    // the search on, and so the token of a page stays good from one run to the next.
    expect(outside.listings).toEqual([
      { mailbox: JANE, q: since(connected - 35 * DAY), maxResults: '100' },
      { mailbox: JANE, q: since(connected - 35 * DAY), maxResults: '100' },
      { mailbox: JANE, q: since(fullyChecked - DAY), maxResults: '100' },
    ])
  })

  it('is never a message of a megabyte or more, on any page of a listing', async () => {
    const chat = await connectedChat(JANE)
    outside.pageSize = 1
    outside.mailboxes[JANE] = [alert('msg-2', 400), alert('msg-1', 500)]
    await mailStoreFor(env.DB, await chat.userId()).markSeen('msg-2', 'unparsed')

    await runCheck(deps)

    // Gmail is the one to leave such a message out. Once fetched, it is parsed whole before any limit applies.
    expect(outside.listings).toHaveLength(2)
    for (const listing of outside.listings) expect(listing.q.split(' ')).toContain('smaller:1M')
  })

  it('is one alert in a run at most, with the rest left for the runs that follow', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    const ids = Array.from({ length: 2 * MESSAGES_PER_RUN + 1 }, (_, index) => `msg-${index}`)
    outside.mailboxes[JANE] = ids.map((id, index) => alert(id, 400 + index))

    const runs: { fetched: string[]; checked: number | null | undefined }[] = []
    for (let run = 1; run <= 3; run++) {
      await runCheck(deps)
      runs.push({ fetched: outside.fetched.splice(0), checked: (await connectionOf(userId))?.last_checked_at })
    }

    // In the order Gmail lists them. The mailbox counts as fully checked only when nothing is left to read.
    expect(runs).toEqual([
      { fetched: ids.slice(0, MESSAGES_PER_RUN), checked: null },
      { fetched: ids.slice(MESSAGES_PER_RUN, 2 * MESSAGES_PER_RUN), checked: null },
      { fetched: ids.slice(2 * MESSAGES_PER_RUN), checked: now() },
    ])
    expect(await purchasesOf(userId)).toHaveLength(ids.length)
  })

  it("fetches the headers of ten messages in a run at most, and is soon through mail that is not a bank's", async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    const lookalikes = Array.from({ length: HEADER_CHECKS_PER_RUN + 2 }, (_, index) => lookalike(`lookalike-${index}`))
    const alerts = Array.from({ length: MESSAGES_PER_RUN + 1 }, (_, index) => alert(`msg-${index}`, 400))
    outside.mailboxes[JANE] = [...lookalikes, ...alerts]

    const runs: { headers: number; whole: string[]; checked: number | null | undefined }[] = []
    for (let run = 1; run <= 3; run++) {
      await runCheck(deps)
      runs.push({
        headers: outside.fetchedHeaders.splice(0).length,
        whole: outside.fetched.splice(0),
        checked: (await connectionOf(userId))?.last_checked_at,
      })
    }

    expect(runs).toEqual([
      // Ten of the twelve are turned away: ten times what the run could have fetched whole.
      { headers: HEADER_CHECKS_PER_RUN, whole: [], checked: null },
      // The other two, and then as many alerts as a run reads.
      { headers: 2 + MESSAGES_PER_RUN, whole: ['msg-0'], checked: null },
      { headers: 1, whole: ['msg-1'], checked: now() },
    ])
    expect(await seenOf(userId)).toHaveLength(lookalikes.length)
    expect(await purchasesOf(userId)).toHaveLength(alerts.length)
  })

  it('counts a mailbox as fully checked in the run that reads the last of it, or finds nothing in it', async () => {
    const jane = await connectedChat(JANE)
    const sam = await connectedChat(SAM)
    outside.mailboxes[JANE] = Array.from({ length: MESSAGES_PER_RUN }, (_, index) => alert(`msg-${index}`, 400))

    await runCheck(deps)
    await runCheck(deps)

    expect(await connectionOf(await jane.userId())).toMatchObject({ last_checked_at: now() })
    expect(await connectionOf(await sam.userId())).toMatchObject({ last_checked_at: now() })
  })

  it('is five pages of a listing in a run at most, and the next run goes on from the page after them', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.pageSize = 1
    outside.mailboxes[JANE] = ['msg-6', 'msg-5', 'msg-4', 'msg-3', 'msg-2', 'msg-1'].map((id) => alert(id, 400))
    await markKnown(userId, outside.mailboxes[JANE])

    await runCheck(deps)

    // The sixth page was not reached, so the mailbox does not count as fully checked.
    expect(outside.listings).toHaveLength(5)
    expect(await connectionOf(userId)).toMatchObject({ last_checked_at: null, backlog_page_token: 'page-from-5' })

    await runCheck(deps)

    // The first page, where new mail would be listed, and then the sixth.
    expect(outside.listings.slice(5).map((listing) => listing.pageToken)).toEqual([undefined, 'page-from-5'])
    expect(await connectionOf(userId)).toMatchObject({ last_checked_at: now(), backlog_page_token: null })
    expect(outside.fetched).toEqual([])
  })

  it('reads the alerts that lie behind more known ones than a run has pages for', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    // 950 alerts that are known already and, older than all of them, two that are not: on the tenth page.
    const known = Array.from({ length: 950 }, (_, index) => alert(`known-${index}`, 400))
    const unread = ['msg-2', 'msg-1'].map((id) => alert(id, 500))
    outside.mailboxes[JANE] = [...known, ...unread]
    await markKnown(userId, known)

    const runs = []
    for (let run = 1; run <= 4; run++) {
      const listedBefore = outside.listings.length
      await runCheck(deps)
      const connection = await connectionOf(userId)
      runs.push({
        pages: outside.listings.slice(listedBefore).map((listing) => listing.pageToken),
        fetched: outside.fetched.splice(0),
        kept: connection?.backlog_page_token,
        checked: connection?.last_checked_at,
      })
    }

    const from = (...starts: number[]) => starts.map((start) => `page-from-${start}`)
    expect(runs).toEqual([
      // Five pages of known alerts. The run keeps the token of the page it did not get to.
      { pages: [undefined, ...from(100, 200, 300, 400)], fetched: [], kept: 'page-from-500', checked: null },
      // After the first page, where new mail would be listed, the next run goes on from there.
      { pages: [undefined, ...from(500, 600, 700, 800)], fetched: [], kept: 'page-from-900', checked: null },
      // The tenth page holds the two, and a run reads one. The token stays on a page that has more to read.
      { pages: [undefined, ...from(900)], fetched: ['msg-2'], kept: 'page-from-900', checked: null },
      // The listing ends with that page. With the last of it read, the mailbox is fully checked.
      { pages: [undefined, ...from(900)], fetched: ['msg-1'], kept: null, checked: now() },
    ])
    const read = (await purchasesOf(userId)).map((purchase) => purchase.source_id)
    expect(read).toEqual(['msg-2', 'msg-1'])
  })

  it('reads new mail before it goes on from the page it had got to', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.pageSize = 2
    const known = ['known-4', 'known-3', 'known-2', 'known-1'].map((id) => alert(id, 400))
    outside.mailboxes[JANE] = [...known, alert('old-2', 500), alert('old-1', 500)]
    await markKnown(userId, known)
    await mailStoreFor(env.DB, userId).setBacklogPageToken('page-from-4')
    outside.mailboxes[JANE].unshift(alert('new-1', 1))

    await runCheck(deps)
    await runCheck(deps)

    // The first run reads what is new, and leaves the token as it is. The second goes on from it. The new alert has
    // moved every older one along by one, so that page now begins with an alert that is known: mail that arrives
    // can only move an unknown alert further on, never back past the token.
    expect(outside.listings.map((listing) => listing.pageToken)).toEqual([undefined, undefined, 'page-from-4'])
    expect(outside.fetched).toEqual(['new-1', 'old-2'])
    expect(await connectionOf(userId)).toMatchObject({ last_checked_at: null, backlog_page_token: 'page-from-4' })
  })

  it('starts again from the first page when Gmail does not take the page token that was kept', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.pageSize = 1
    outside.mailboxes[JANE] = [alert('msg-2', 400), alert('msg-1', 500)]
    await markKnown(userId, [outside.mailboxes[JANE][0]])
    await mailStoreFor(env.DB, userId).setBacklogPageToken('made-up-page-token')
    const logged = catchConsole()

    await runCheck(deps)

    // The run ends there, with the token let go of. The failure is logged by where it came, its name and its reason.
    expect(outside.listings.map((listing) => listing.pageToken)).toEqual([undefined, 'made-up-page-token'])
    expect(logged.events('check_failed')).toEqual([
      { event: 'check_failed', stage: 'list', user: userId, error: 'PageTokenError', reason: 'page_token' },
    ])
    expect(logged.text()).not.toContain('made-up-page-token')
    expect(await connectionOf(userId)).toMatchObject({ last_checked_at: null, backlog_page_token: null })
    expect(outside.fetched).toEqual([])

    await runCheck(deps)

    expect(outside.listings.slice(2).map((listing) => listing.pageToken)).toEqual([undefined, 'page-from-1'])
    expect(outside.fetched).toEqual(['msg-1'])
    expect(await connectionOf(userId)).toMatchObject({ last_checked_at: now() })
  })
})

describe('a mailbox that Google no longer lets the service read', () => {
  it('is marked as needing to be reconnected, and its user is told how', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    outside.ended.add(outside.issued[0]) // as when the user removes the access in their Google Account

    await runCheck(deps)

    expect(await connectionOf(userId)).toMatchObject({ status: 'needs_reconnect', last_checked_at: null })
    expect(sent).toEqual([
      {
        chatId: chat.telegramId,
        text:
          'Spend Tracker has lost its access to your Gmail jane@example.test, and has stopped reading your bank ' +
          'alerts. This happens when you change your Google password, or remove the access in your Google Account. ' +
          'Send /connect to reconnect it.',
      },
    ])
    expect(outside.listings).toEqual([])
    expect(await purchasesOf(userId)).toEqual([])
  })

  it('is told of again on its next turn when the message could not be sent, and is not marked until it is', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.ended.add(outside.issued[0])
    outside.failing.add(TELEGRAM_URL)
    const logged = catchConsole()

    await runCheck(posting)

    // Marked now, it would have no more turns, and its user would never be told. The log has the request that
    // Telegram refused, that the access was found lost and its user not told, and that the run failed at the
    // telling, with the status of Telegram's answer.
    const refused = { error: 'Error', reason: 'http_error', status: 400 }
    expect(outside.telegrams).toEqual([])
    expect(logged.events()).toMatchObject([
      { event: 'telegram_failed', method: 'sendMessage', ...refused },
      { event: 'access_lost', user: userId, told: false },
      { event: 'check_failed', stage: 'notify', user: userId, ...refused },
      { event: 'check', user: userId, notified: 0 },
    ])
    expect(await connectionOf(userId)).toMatchObject({ status: 'active' })

    outside.failing.clear()
    clock.now = later(1)
    await runCheck(posting)

    const notice = expect.stringContaining('has lost its access to your Gmail jane@example.test')
    expect(outside.telegrams).toMatchObject([{ chat_id: chat.telegramId, text: notice }])
    expect(await connectionOf(userId)).toMatchObject({ status: 'needs_reconnect' })
    // The next turn finds the access lost again, and this time its user is told.
    expect(logged.events('access_lost')).toEqual([
      { event: 'access_lost', user: userId, told: false },
      { event: 'access_lost', user: userId, told: true },
    ])
  })

  it('is marked all the same when its user has blocked the bot, as no turn would get the message to them', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.ended.add(outside.issued[0])
    outside.blocked.add(chat.telegramId)
    const logged = catchConsole()

    await runCheck(posting)

    // The run did not fail. Its log says that Telegram will send the chat nothing, that the access is lost, and that
    // the user could not be told.
    expect(outside.telegrams).toEqual([])
    expect(logged.events().map((event) => event.event)).toEqual(['telegram_failed', 'access_lost', 'check'])
    const blocked = { error: 'ChatBlockedError', reason: 'chat_blocked' }
    expect(logged.events('telegram_failed')).toEqual([
      { event: 'telegram_failed', method: 'sendMessage', status: 403, ...blocked },
    ])
    expect(logged.events('access_lost')).toEqual([{ event: 'access_lost', user: userId, told: false }])
    expect(await connectionOf(userId)).toMatchObject({ status: 'needs_reconnect' })

    clock.now = later(1)
    await runCheck(posting)

    expect(await connectionOf(userId)).toMatchObject({ last_run_at: NOW.getTime() / 1000 })
  })
})

describe('taking turns', () => {
  /** The mailboxes that the next runs check, a minute apart. */
  async function turns(runs: number): Promise<string[]> {
    outside.listings.length = 0
    for (let run = 1; run <= runs; run++) {
      await runCheck(deps)
      clock.now = later(1)
    }
    return outside.listings.map((listing) => listing.mailbox)
  }

  it('gives each run to the mailbox that has waited longest: a new one, since it was connected', async () => {
    await connectedChat(JANE)
    await connectedChat(SAM)

    expect(await turns(4)).toEqual([JANE, SAM, JANE, SAM])

    await connectedChat('tom@example.test')
    expect(await turns(4)).toEqual([JANE, SAM, 'tom@example.test', JANE])
  })

  it('gives each user only the purchases from their own mailbox', async () => {
    const jane = await connectedChat(JANE)
    const sam = await connectedChat(SAM)
    await jane.say('/addcard visa 1234 calendar')
    await sam.say('/addcard amex 1234 calendar')
    // Both mailboxes hold a message with the id msg-1, about a card ending 1234.
    outside.mailboxes[JANE] = [alert('msg-1', 5, alertText('SGD 12.40', '1234'))]
    outside.mailboxes[SAM] = [alert('msg-1', 5, alertText('SGD 99.00', '1234', 'BOOK SHOP'))]

    await runCheck(deps)
    await runCheck(deps)

    expect(sent).toEqual([
      {
        chatId: jane.telegramId,
        text: 'visa ••••1234: SGD 12.40 at COFFEE PLACE\nRunning total: SGD 12.40 in 1 purchase, resets 1 Nov',
      },
      {
        chatId: sam.telegramId,
        text: 'amex ••••1234: SGD 99.00 at BOOK SHOP\nRunning total: SGD 99.00 in 1 purchase, resets 1 Nov',
      },
    ])
    expect(await purchasesOf(await jane.userId())).toMatchObject([{ source_id: 'msg-1', amount_minor: 1240 }])
    expect(await purchasesOf(await sam.userId())).toMatchObject([{ source_id: 'msg-1', amount_minor: 9900 }])
  })

  it('does nothing when no mailbox is connected, and logs that it did nothing', async () => {
    const logged = catchConsole()
    const asked = vi.spyOn(globalThis, 'fetch')

    await runCheck(deps)

    expect(asked).not.toHaveBeenCalled()
    expect(logged.events()).toEqual([{ event: 'check', ...NOTHING_DONE }])
    // The line as it is written: the fields of a run are always all there, and in this order.
    expect(logged.text()).toBe(
      '{"event":"check","mailbox":false,"user":null,"listed":0,"unknown":0,"headers":0,"read":0,"stored":0,' +
        '"unparsed":0,"rejected":0,"notified":0,"checked":false,"swept":0,"batches":0,"ms":0}',
    )
  })
})

describe('sign-ins that nobody came back to', () => {
  it('are deleted once they have expired, and the mailbox one held is let go at Google', async () => {
    const approved = openChat()
    const code = await signIn(approved, JANE)
    const opened = openChat()
    await opened.say('/connect')
    clock.now = later(5)
    const recent = openChat()
    const recentCode = await signIn(recent, SAM)
    clock.now = new Date(NOW.getTime() + 10 * MINUTE) // the first two have just run out

    await runCheck(deps)

    expect(await attemptOf(await approved.userId())).toBeNull()
    expect(await attemptOf(await opened.userId())).toBeNull()
    expect(outside.revoked).toEqual([outside.issued[0]])
    expect(await approved.say(code)).toBe(NO_SIGN_IN)
    // The one that still has time is left alone.
    expect(await recent.say(recentCode)).toContain('Connected sam@example.test')
  })

  it('are cleared away five in a run', async () => {
    for (let abandoned = 1; abandoned <= 7; abandoned++) await signIn(openChat(), `abandoned-${abandoned}@example.test`)
    clock.now = later(10)

    await runCheck(deps)
    expect(await attemptCount()).toBe(2)
    expect(outside.revoked).toHaveLength(5)

    await runCheck(deps)
    expect(await attemptCount()).toBe(0)
    expect([...outside.revoked].sort()).toEqual([...outside.issued].sort())
  })
})

describe('held purchases that nobody answered for', () => {
  const DAY_OF_MINUTES = 24 * 60

  /** Holds a purchase for a user, for the message with the id, from the time that it is now. */
  async function hold(userId: number, messageId: number): Promise<void> {
    const read = { occurredAt: now(), amountMinor: 300, currency: 'SGD', merchant: 'TEA HOUSE' }
    const batch = { messageId, cardLast4: '1234', category: null, purchases: [{ place: 0, ...read, unsure: true }] }
    await heldStoreFor(env.DB, userId).hold(batch, now())
  }

  /** Whose purchases are held, a user to each batch. It reads the table directly. */
  async function heldOwners(): Promise<number[]> {
    const { results } = await env.DB.prepare('SELECT owner_id FROM held_batches ORDER BY owner_id').all<{
      owner_id: number
    }>()
    return results.map((batch) => batch.owner_id)
  }

  it('are deleted by the run that comes once they have been held for a day, and by none before it', async () => {
    const [first, second] = [await openChat().userId(), await openChat().userId()]
    await hold(first, 71)
    clock.now = later(60)
    await hold(second, 72)

    // A second short of a day after the first was held.
    clock.now = new Date(NOW.getTime() + DAY_OF_MINUTES * MINUTE - 1000)
    await runCheck(deps)
    expect(await heldOwners()).toEqual([first, second])

    clock.now = new Date(NOW.getTime() + DAY_OF_MINUTES * MINUTE)
    const logged = catchConsole()
    await runCheck(deps)

    // The first is gone, and the second has an hour left. No mailbox is connected: the sweep is of every run.
    expect(await heldOwners()).toEqual([second])
    expect(await heldStoreFor(env.DB, second).find(72, now())).toMatchObject({ messageId: 72 })
    expect(logged.events()).toEqual([{ event: 'check', ...NOTHING_DONE, batches: 1 }])
  })

  it('are deleted by a run that fails before it gets to them, which is logged with what it had done by then', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    await hold(userId, 71)
    clock.now = later(DAY_OF_MINUTES)
    outside.failing.add(TOKEN_URL)
    const logged = catchConsole()

    await runCheck(deps)

    expect(await heldOwners()).toEqual([])
    expect(logged.events()).toMatchObject([
      { event: 'check_failed', stage: 'token', user: userId },
      { event: 'check', batches: 1, mailbox: true, user: userId },
    ])
  })

  it('keep no mailbox from being checked when they cannot be deleted, as in a service with no table for them yet', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    // What the database says of a table that there is not, which quotes the statement.
    const prepare = env.DB.prepare.bind(env.DB)
    const queried = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('held_batches')) throw new Error(`D1_ERROR: no such table: held_batches: ${query}`)
      return prepare(query)
    })
    const logged = catchConsole()

    await runCheck(deps)

    // The mailbox had its turn first, and its purchase is stored and told of.
    expect(queried.mock.calls.map(([query]) => query).findLast((query) => query.includes('held_batches'))).toBe(
      queried.mock.calls.at(-1)?.[0],
    )
    queried.mockRestore()
    expect(sent.map((message) => message.chatId)).toEqual([chat.telegramId])
    // The failure has a stage of its own and names no user: it is of no one user's purchases. The run ends as any
    // other does, with its own line, which says what it did.
    const found = { mailbox: true, user: userId, listed: 1, unknown: 1, headers: 1, read: 1 }
    expect(logged.events()).toEqual([
      { event: 'alert', outcome: 'stored', parser: 'example-bank' },
      { event: 'check_failed', stage: 'batches', user: null, error: 'Error' },
      { event: 'check', ...NOTHING_DONE, ...found, stored: 1, notified: 1, checked: true },
    ])
    expect(logged.text()).not.toContain('held_batches')
  })
})

describe('when Google fails for a while', () => {
  it.each([
    ['the token endpoint', TOKEN_URL, 'token'],
    ['the listing', MESSAGES_URL, 'list'],
    ['the message', `${MESSAGES_URL}/msg-1`, 'read'],
  ])('nothing changes when %s fails, and the next run reads the mail', async (_, endpoint, stage) => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    outside.failing.add(endpoint)
    const logged = catchConsole()

    await runCheck(deps)

    // Only the turn is used up. The failure is logged by where it came and by the status of Google's answer.
    expect(await connectionOf(userId)).toMatchObject({ status: 'active', last_checked_at: null, last_run_at: now() })
    expect(await purchasesOf(userId)).toEqual([])
    expect(await seenOf(userId)).toEqual([])
    expect(sent).toEqual([])
    expect(logged.events('check_failed')).toEqual([
      { event: 'check_failed', stage, user: userId, error: 'Error', reason: 'http_error', status: 400 },
    ])
    expect(logged.text()).not.toContain('made_up_error')

    outside.failing.clear()
    await runCheck(deps)

    expect(sent.map((message) => message.text)).toEqual([`Card ••••1234: SGD 12.40 at COFFEE PLACE\n${ADD_CARD_HINT}`])
    expect(await connectionOf(userId)).toMatchObject({ status: 'active', last_checked_at: now() })
  })

  it('keeps what a run had noted before the failure, and logs what it had done', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    // A run reads one alert. So what it has done before it fails on one is to turn other mail away.
    outside.mailboxes[JANE] = [lookalike('lookalike-1'), alert('msg-1', 500)]
    outside.failing.add(`${MESSAGES_URL}/msg-1`)
    const logged = catchConsole()

    await runCheck(deps)

    expect(await seenOf(userId)).toEqual([{ source_id: 'lookalike-1', status: 'rejected' }])
    expect(await purchasesOf(userId)).toEqual([])
    expect(await connectionOf(userId)).toMatchObject({ last_checked_at: null })
    // The line of the failure, and then the run's own line, which a run that fails has too.
    expect(logged.events()).toEqual([
      { event: 'check_failed', stage: 'read', user: userId, error: 'Error', reason: 'http_error', status: 400 },
      { event: 'check', ...NOTHING_DONE, mailbox: true, user: userId, listed: 2, unknown: 2, headers: 1, rejected: 1 },
    ])

    outside.failing.clear()
    outside.fetchedHeaders.length = 0
    await runCheck(deps)

    // The mail that was turned away is not looked at again.
    expect(outside.fetchedHeaders).toEqual(['msg-1'])
    expect(outside.fetched).toEqual(['msg-1'])
    expect(await connectionOf(userId)).toMatchObject({ last_checked_at: now() })
  })
})

describe('the cost of a run', () => {
  it('stays well inside the 50 requests and the 50 queries that a run may make, even at its most', async () => {
    // Five expired sign-ins to let go of at Google.
    for (let abandoned = 1; abandoned <= 5; abandoned++) await signIn(openChat(), `abandoned-${abandoned}@example.test`)
    clock.now = later(10)
    // A listing of five pages, with nothing new before the last of them.
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.pageSize = HEADER_CHECKS_PER_RUN
    const known = Array.from({ length: 4 * HEADER_CHECKS_PER_RUN }, (_, index) => alert(`known-${index}`, 400))
    await markKnown(userId, known)
    // On that page, as many messages as a run fetches the headers of. Those that it turns away come first, or it
    // would have read its fill before it came to them.
    const turnedAway = HEADER_CHECKS_PER_RUN - MESSAGES_PER_RUN
    const lookalikes = Array.from({ length: turnedAway }, (_, index) => lookalike(`lookalike-${index}`))
    // And then as many purchases as a run reads, each one to tell the user of with a card's total. The card is
    // linked to a product, whose rules sort a purchase with no query more.
    await chat.say('/addcard visa 1234 calendar uob-evol')
    const fresh = Array.from({ length: MESSAGES_PER_RUN }, (_, index) => alert(`fresh-${index}`, 5))
    outside.mailboxes[JANE] = [...known, ...lookalikes, ...fresh]
    const asked = vi.spyOn(globalThis, 'fetch')
    const queried = vi.spyOn(env.DB, 'prepare')

    // With the messenger that posts to Telegram, so that its requests are counted too.
    await runCheck(posting)
    const requests = asked.mock.calls.length
    const queries = queried.mock.calls.length

    expect(outside.revoked).toHaveLength(5)
    expect(outside.listings).toHaveLength(5)
    expect(outside.fetchedHeaders).toHaveLength(HEADER_CHECKS_PER_RUN)
    expect(outside.fetched).toHaveLength(MESSAGES_PER_RUN)
    expect(outside.telegrams).toHaveLength(MESSAGES_PER_RUN)
    expect(await connectionOf(userId)).toMatchObject({ last_checked_at: now() })
    // 5 revocations, 1 token, 5 pages, the headers of 10 messages, and a message and a Telegram post for each purchase.
    expect(requests).toBe(5 + 1 + 5 + HEADER_CHECKS_PER_RUN + 2 * MESSAGES_PER_RUN)
    expect(requests).toBe(23)
    // The sweep and a look for each of its 5 mailboxes, the sweep of the held purchases, the turn, 5 pages, the page
    // token, a note of each message turned away, 3 for each purchase (find its card, store it, total the card), and
    // the mark.
    expect(queries).toBe(1 + 5 + 1 + 1 + 5 + 1 + turnedAway + 3 * MESSAGES_PER_RUN + 1)
    expect(queries).toBe(27)
    expect(Math.max(requests, queries)).toBeLessThan(50)
  })
})

describe('the line that a run logs of itself', () => {
  it('counts the mail that was listed, looked at, read, stored, not understood, turned away and told of', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.mailboxes[JANE] = [
      lookalike('lookalike-2'),
      lookalike('lookalike-1'),
      alert('msg-3', 5, 'Your statement is ready.'),
      alert('msg-2', 7 * 60),
      alert('msg-1', 5),
    ]
    const logged = catchConsole()

    for (let run = 1; run <= 3; run++) await runCheck(deps)

    const found = { ...NOTHING_DONE, mailbox: true, user: userId, listed: 5 }
    expect(logged.events('check')).toEqual([
      // Two are turned away on their headers. The third is read, and is no alert that a parser can read.
      { event: 'check', ...found, unknown: 5, headers: 3, read: 1, rejected: 2, unparsed: 1 },
      // The next is stored, and came too long ago for its user to be told of it.
      { event: 'check', ...found, unknown: 2, headers: 1, read: 1, stored: 1 },
      // The last is stored and told of, and with it the mailbox is fully checked.
      { event: 'check', ...found, unknown: 1, headers: 1, read: 1, stored: 1, notified: 1, checked: true },
    ])
    expect(logged.events('alert').map((event) => event.outcome)).toEqual(['unparsed', 'stored', 'stored'])
  })

  it('says how long the run took, by the clock that the run goes by', async () => {
    await connectedChat(JANE)
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    // Google takes 30 milliseconds over each answer: a token, a listing, the headers of a message, and the message.
    const standIn = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      clock.now = new Date(clock.now.getTime() + 30)
      return standIn(url, init)
    })
    const logged = catchConsole()

    await runCheck(deps)

    expect(logged.events('check')).toMatchObject([{ stored: 1, ms: 120 }])
  })

  it('counts the expired sign-ins that the run cleared away, whether or not one held a mailbox', async () => {
    await signIn(openChat(), SAM)
    await openChat().say('/connect')
    clock.now = later(10)
    const logged = catchConsole()

    await runCheck(deps)

    expect(logged.events()).toEqual([
      { event: 'token_revoke', outcome: 'revoked' },
      { event: 'check', ...NOTHING_DONE, swept: 2 },
    ])
  })

  it.each<[stage: string, when: string, statement: string, whose: 'known' | 'not known']>([
    ['sweep', 'the expired sign-ins cannot be deleted', 'DELETE FROM connect_attempts', 'not known'],
    ['take', 'no mailbox can be given its turn', 'UPDATE google_connections', 'not known'],
    ['store', 'the purchase cannot be stored', 'INSERT INTO transactions', 'known'],
  ])('comes after one that says the run failed at "%s", when %s', async (stage, _, statement, whose) => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    const prepare = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes(statement)) throw new Error(`A made-up failure of the database that quotes ${JANE}`)
      return prepare(query)
    })
    const logged = catchConsole()

    await runCheck(deps)

    // The user is the one whose mailbox was being checked, once a mailbox has been given its turn.
    const user = whose === 'known' ? userId : null
    expect(logged.events()).toMatchObject([
      { event: 'check_failed', stage, user, error: 'Error' },
      { event: 'check', user, checked: false },
    ])
    // The failure has its stage, the name of its error and nothing that the error said.
    expect(Object.keys(logged.events('check_failed')[0])).toEqual(['event', 'stage', 'user', 'error'])
    expect(logged.text()).not.toContain(JANE)
  })

  // The other things that a run notes in the database, each of which it does at "store". With each is what is in
  // the mailbox, or what has become of its access, for the run to get there, and what the run logs on the way.
  it.each<[when: string, statement: string, arrange: () => unknown, before: string[]]>([
    [
      'a message that was turned away cannot be noted',
      'INSERT INTO seen_alerts',
      () => (outside.mailboxes[JANE] = [lookalike('lookalike-1')]),
      [],
    ],
    [
      'the mailbox cannot be marked as fully checked',
      'SET last_checked_at',
      () => (outside.mailboxes[JANE] = [alert('msg-1', 5)]),
      ['alert'],
    ],
    [
      'the connection cannot be marked as needing to be reconnected',
      "SET status = 'needs_reconnect'",
      () => outside.ended.add(outside.issued[0]),
      ['access_lost'],
    ],
  ])('comes after one that says the run failed at "store", when %s', async (_, statement, arrange, before) => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    arrange()
    const prepare = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query.includes(statement)) throw new Error(`A made-up failure of the database that quotes ${JANE}`)
      return prepare(query)
    })
    const logged = catchConsole()

    await runCheck(deps)

    expect(logged.events().map((event) => event.event)).toEqual([...before, 'check_failed', 'check'])
    expect(logged.events('check_failed')).toEqual([
      { event: 'check_failed', stage: 'store', user: userId, error: 'Error' },
    ])
    expect(logged.text()).not.toContain(JANE)
  })

  it('comes after one that says the run failed at "notify", when the user cannot be told of a purchase', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    outside.blocked.add(chat.telegramId)
    const logged = catchConsole()

    await runCheck(posting)

    // The purchase is stored all the same, and the run's line says that nobody was told of it. The request that
    // Telegram refused has its own line, before the line of the run that failed with it.
    const found = { mailbox: true, user: userId, listed: 1, unknown: 1, headers: 1, read: 1 }
    const blocked = { error: 'ChatBlockedError', reason: 'chat_blocked' }
    expect(logged.events()).toEqual([
      { event: 'alert', outcome: 'stored', parser: 'example-bank' },
      { event: 'telegram_failed', method: 'sendMessage', status: 403, ...blocked },
      { event: 'check_failed', stage: 'notify', user: userId, ...blocked },
      { event: 'check', ...NOTHING_DONE, ...found, stored: 1 },
    ])
    expect(await purchasesOf(userId)).toHaveLength(1)
  })

  it('has nothing of the mail or of its owner: no address, merchant, card, amount, token or Telegram id', async () => {
    const logged = catchConsole()
    const chat = await connectedChat(JANE)
    await chat.say('/addcard visa 4321 calendar uob-evol')
    const receivedAt = now() - 60
    const purchase = textPart(alertText('SGD 98.76', '4321', 'PRIVATE CLINIC'))
    outside.mailboxes[JANE] = [
      lookalike('made-up-id-3'),
      gmailMessage({ id: 'made-up-id-2', receivedAt, content: textPart('A made-up notice.') }),
      gmailMessage({ id: 'made-up-id-1', receivedAt, content: purchase }),
    ]

    await runCheck(posting)
    await runCheck(posting)

    // The user was told of the purchase, with its merchant and its card. The log was told that there was one.
    expect(outside.telegrams.map((message) => message.text.split('\n')[0])).toEqual([
      'visa ••••4321: SGD 98.76 at PRIVATE CLINIC',
    ])
    expect(logged.events('check')).toMatchObject([
      { rejected: 1, unparsed: 1 },
      { stored: 1, notified: 1 },
    ])
    const mail = [JANE, 'example.test', 'examplebank.test', 'made-up', 'notice', 'PRIVATE CLINIC', 'visa']
    const numbers = ['4321', '98.76', '9876', 'SGD', String(chat.telegramId)]
    const tokens = [outside.issued[0], 'refresh-token', 'access-token', env.TELEGRAM_BOT_TOKEN]
    for (const text of [...mail, ...numbers, ...tokens]) expect(logged.text()).not.toContain(text)
  })
})

describe('through the Worker', () => {
  it('runs the checker when the cron trigger fires', async () => {
    const chat = await connectedChat(JANE)
    // The Worker goes by the real clock.
    const receivedAt = Math.floor(Date.now() / 1000) - 60
    outside.mailboxes[JANE] = [gmailMessage({ receivedAt })]

    const context = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '* * * * *' }), env, context)
    await waitOnExecutionContext(context)

    // Posted as plain text, with no parse mode. Only the merchant's name is marked, as code, and no link is previewed.
    expect(outside.telegrams).toEqual([
      {
        chat_id: chat.telegramId,
        text: `Card ••••1234: SGD 12.40 at COFFEE PLACE\n${ADD_CARD_HINT}`,
        entities: [{ type: 'code', offset: 28, length: 12 }],
        link_preview_options: { is_disabled: true },
      },
    ])
    expect(await purchasesOf(await chat.userId())).toMatchObject([{ source_id: 'msg-1', occurred_at: receivedAt }])
    expect((await connectionOf(await chat.userId()))?.last_checked_at).toBeGreaterThanOrEqual(receivedAt)
  })
})
