import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { HEADER_CHECKS_PER_RUN, MESSAGES_PER_RUN, runCheck } from '../src/checker'
import { depsFor, type Deps } from '../src/deps'
import worker from '../src/index'
import { storeFor } from '../src/store'
import { mailStoreFor } from '../src/store-mail'
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
  REVOKE_URL,
  sent,
  signIn,
  TELEGRAM_URL,
  TOKEN_URL,
} from './connect-helpers'
import { gmailMessage, gmailResults, htmlPart, textPart, type Message, type MessageOptions } from './gmail-helpers'
import { alertText, seconds } from './helpers'

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
    expect(await chat.say('/spend')).toContain('visa ••••1234: SGD 1,246.96 + USD 5.00 in 3 purchases, resets 16 Oct')
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

  it('is read from an email that is only HTML', async () => {
    await connectedChat(JANE)
    const html = [
      '<html>',
      '  <head><style>p { color: #333 }</style></head>',
      '  <body>',
      '    <p>Dear customer,</p>',
      `    <p>${alertText('SGD&nbsp;8.00', '1234', 'BOOK &amp; PEN SHOP')}</p>`,
      '  </body>',
      '</html>',
    ].join('\r\n')
    outside.mailboxes[JANE] = [gmailMessage({ receivedAt: now() - 60, content: htmlPart(html) })]

    await runCheck(deps)

    expect(sent.map((message) => message.text)).toEqual([
      `Card ••••1234: SGD 8.00 at BOOK & PEN SHOP\n${ADD_CARD_HINT}`,
    ])
  })

  it.each([
    ["the domain above the sender's, which is what it names for OCBC", 'ocbc.com'],
    ["the sender's own domain", 'notify.ocbc.com'],
  ])('is read when Gmail authenticated %s', async (_, authenticated) => {
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

  it('names no merchant when the alert names none', async () => {
    await connectedChat(JANE)
    outside.mailboxes[JANE] = [alert('msg-1', 5, alertText('SGD 12.40', '1234', ' '))]

    await runCheck(deps)

    expect(sent.map((message) => message.text)).toEqual([`Card ••••1234: SGD 12.40\n${ADD_CARD_HINT}`])
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

  it('is stored without a message when the purchase is six hours old or older', async () => {
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

  it('is not read or stored again once its user has taken the purchase out', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    await chat.say('/addcard visa 1234 calendar')
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    await runCheck(deps)
    const { id } = (await sortedOf(userId))['msg-1']
    await chat.say(`/remove ${id}`)
    sent.length = 0
    outside.fetchedHeaders.length = 0
    outside.fetched.length = 0

    // The mailbox still holds the alert, and every run lists it.
    clock.now = later(1)
    await runCheck(deps)

    expect(outside.listings).toHaveLength(2)
    expect(outside.fetchedHeaders).toEqual([])
    expect(outside.fetched).toEqual([])
    expect(sent).toEqual([])
    expect(await purchasesOf(userId)).toHaveLength(1)
    expect(await chat.say('/spend')).toContain('visa ••••1234: no purchases, resets 1 Nov')
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
    ['in another currency', 'USD 5.00', 'COFFEE PLACE', 'fx', 'Foreign currency'],
    ['at a merchant that the product lists', 'SGD 5.00', 'NETFLIX.COM', 'selected', 'Gym, telco and streaming'],
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
      `#${stored.id}: ${name}`,
    ])
    expect(message.buttons).toBeUndefined()
  })

  it('comes with the buttons that sort it, when no rule settles where it belongs', async () => {
    const chat = await chatWithProduct()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]

    await runCheck(deps)

    const { id, category } = (await sortedOf(await chat.userId()))['msg-1']
    expect(category).toBeNull()
    const [message] = posted
    expect(message.text).toBe(
      'evol ••••1234: SGD 12.40 at COFFEE PLACE\n' +
        'Running total: SGD 12.40 in 1 purchase, resets 1 Nov\n' +
        `#${id}: not sorted. Which was it?`,
    )
    expect(message.entities).toEqual([{ type: 'code', offset: 28, length: 12 }])
    expect(message.buttons).toEqual([
      [{ text: 'Online', data: `${id}:online` }],
      [{ text: 'Phone tap', data: `${id}:mobile` }],
      [{ text: 'Physical card or other', data: `${id}:other` }],
      [{ text: "Doesn't count", data: `${id}:excluded` }],
    ])

    // A press sorts it. The message keeps what it said of the purchase and of the card, and its last line changes.
    expect(await chat.press(message, 'Online')).toEqual({ answer: `#${id}: Online`, sent: [] })
    expect(message.text).toBe(
      'evol ••••1234: SGD 12.40 at COFFEE PLACE\n' +
        'Running total: SGD 12.40 in 1 purchase, resets 1 Nov\n' +
        `#${id}: Online`,
    )
    expect(message.entities).toEqual([{ type: 'code', offset: 28, length: 12 }])
    expect(message.buttons).toBeUndefined()
    expect((await sortedOf(await chat.userId()))['msg-1'].category).toBe('online')
  })

  it('starts where its user put the last purchase at the same merchant', async () => {
    const chat = await chatWithProduct()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    await runCheck(deps)
    await chat.press(posted[0], 'Phone tap')
    outside.mailboxes[JANE].unshift(alert('msg-2', 1), alert('msg-3', 2, alertText('SGD 9.00', '1234', 'BOOK SHOP')))

    await runCheck(deps)
    await runCheck(deps)

    const stored = await sortedOf(await chat.userId())
    expect(stored['msg-2'].category).toBe('mobile')
    expect(stored['msg-3'].category).toBeNull()
    const [, coffee, books] = posted
    expect(coffee.text.split('\n')[2]).toBe(`#${stored['msg-2'].id}: Phone tap`)
    expect(coffee.buttons).toBeUndefined()
    expect(books.text.split('\n')[2]).toBe(`#${stored['msg-3'].id}: not sorted. Which was it?`)
    expect(books.buttons).toHaveLength(4)
  })

  it('is sorted by the rules even when it is too old to be told of', async () => {
    const chat = await chatWithProduct()
    outside.mailboxes[JANE] = [alert('msg-1', 7 * 60, alertText('JPY 1,500', '1234'))]

    await runCheck(deps)

    expect(posted).toEqual([])
    expect((await sortedOf(await chat.userId()))['msg-1'].category).toBe('fx')
  })

  it('is posted to Telegram with its buttons as an inline keyboard, a row to each', async () => {
    const chat = await chatWithProduct()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]

    await runCheck(posting)

    const { id } = (await sortedOf(await chat.userId()))['msg-1']
    expect(outside.telegrams).toEqual([
      {
        chat_id: chat.telegramId,
        text: expect.stringMatching(/\n#\d+: not sorted\. Which was it\?$/),
        entities: [{ type: 'code', offset: 28, length: 12 }],
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Online', callback_data: `${id}:online` }],
            [{ text: 'Phone tap', callback_data: `${id}:mobile` }],
            [{ text: 'Physical card or other', callback_data: `${id}:other` }],
            [{ text: "Doesn't count", callback_data: `${id}:excluded` }],
          ],
        },
      },
    ])
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
    expect(posted.map((message) => [message.chatId, message.text.split('\n').length, message.buttons])).toEqual([
      [jane.telegramId, 3, undefined],
      [sam.telegramId, 2, undefined],
    ])
  })
})

describe('an alert that is not stored', () => {
  const PASS = gmailResults('pass', 'examplebank.test')
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
    ['Gmail found that DMARC failed', { results: [FAIL] }],
    ['Gmail recorded no results for it', { results: [] }],
    ['only a header that the sender added says DMARC passed', { results: [FAIL, PASS] }],
    ['it was authenticated for another domain', { results: [gmailResults('pass', 'attacker.test')] }],
    [
      "it was authenticated for a domain that the bank's only ends with",
      { results: [gmailResults('pass', 'bank.test')] },
    ],
    [
      "it was authenticated for a domain under the bank's",
      { results: [gmailResults('pass', 'mail.examplebank.test')] },
    ],
    [
      "it was authenticated for a domain under the sender's own",
      { from: OCBC, results: [gmailResults('pass', 'alerts.notify.ocbc.com')] },
    ],
    [
      "it was authenticated for a look-alike of the domain above the sender's",
      { from: OCBC, results: [gmailResults('pass', 'evil-ocbc.com')] },
    ],
    [
      "it was authenticated for a domain that the one above the sender's only ends with",
      { from: OCBC, results: [gmailResults('pass', 'cbc.com')] },
    ],
    [
      "it was authenticated for a domain that only begins as the one above the sender's does",
      { from: OCBC, results: [gmailResults('pass', 'ocbc.com.attacker.test')] },
    ],
    ['it was authenticated for a name with no dot in it', { from: OCBC, results: [gmailResults('pass', 'com')] }],
    ["it is from an address of the bank's that alerts do not come from", { from: 'offers@examplebank.test' }],
    [
      "it is from an address under the bank's domain that alerts do not come from",
      { from: 'alerts@mail.examplebank.test' },
    ],
    [
      "the bank's address is only the name that the sender goes by",
      { from: '"alerts@examplebank.test" <someone@attacker.test>', results: [gmailResults('pass', 'attacker.test')] },
    ],
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
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
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
    expect(logged).not.toHaveBeenCalled()
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
    const senders = 'alerts@examplebank.test OR noreply@notify.ocbc.com OR unialerts@uobgroup.com'
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

  it('does not include the alerts it already knows, stored or not', async () => {
    const chat = await connectedChat(JANE)
    outside.mailboxes[JANE] = [
      alert('msg-3', 400, 'Your statement is ready.'),
      alert('msg-2', 500),
      alert('msg-1', 600),
    ]
    for (let run = 1; run <= 3; run++) await runCheck(deps)
    expect(outside.fetched.splice(0)).toEqual(['msg-3', 'msg-2', 'msg-1'])
    outside.mailboxes[JANE].unshift(alert('msg-4', 1))

    await runCheck(deps)

    expect(outside.fetched).toEqual(['msg-4'])
    expect((await purchasesOf(await chat.userId())).map((purchase) => purchase.source_id)).toEqual([
      'msg-2',
      'msg-1',
      'msg-4',
    ])
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

  it('goes on to the next page of a listing when it knows all that is on a page', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.pageSize = 1
    outside.mailboxes[JANE] = ['msg-3', 'msg-2', 'msg-1'].map((id) => alert(id, 400))

    const checked: (number | null | undefined)[] = []
    for (let run = 1; run <= 3; run++) {
      await runCheck(deps)
      checked.push((await connectionOf(userId))?.last_checked_at)
    }

    // A run stops at the first page that holds something new. While pages follow that one, more may be left.
    expect(outside.listings.map((listing) => listing.pageToken)).toEqual([
      undefined,
      ...[undefined, 'page-from-1'],
      ...[undefined, 'page-from-1', 'page-from-2'],
    ])
    expect(outside.fetched).toEqual(['msg-3', 'msg-2', 'msg-1'])
    expect(checked).toEqual([null, null, now()])
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
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.pageSize = 1
    outside.mailboxes[JANE] = [alert('msg-2', 400), alert('msg-1', 500)]
    await markKnown(userId, [outside.mailboxes[JANE][0]])
    await mailStoreFor(env.DB, userId).setBacklogPageToken('made-up-page-token')

    await runCheck(deps)

    // The run ends there, with the token let go of. The failure is logged by its name alone.
    expect(outside.listings.map((listing) => listing.pageToken)).toEqual([undefined, 'made-up-page-token'])
    expect(logged.mock.calls).toEqual([['mail check failed:', 'PageTokenError']])
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

  it('has no more turns until its user connects it again', async () => {
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    outside.ended.add(outside.issued[0])
    await runCheck(deps)
    sent.length = 0

    clock.now = later(1)
    await runCheck(deps)

    expect(sent).toEqual([])
    expect(await connectionOf(userId)).toMatchObject({ status: 'needs_reconnect', last_run_at: NOW.getTime() / 1000 })

    expect(await chat.say(await signIn(chat, JANE))).toContain('Connected jane@example.test')
    await runCheck(deps)

    expect(await connectionOf(userId)).toMatchObject({ status: 'active', last_checked_at: now() })
    expect(sent.map((message) => message.text)).toEqual([`Card ••••1234: SGD 12.40 at COFFEE PLACE\n${ADD_CARD_HINT}`])
  })

  it('is told of again on its next turn when the message could not be sent, and is not marked until it is', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.ended.add(outside.issued[0])
    outside.failing.add(TELEGRAM_URL)

    await runCheck(posting)

    // Marked now, it would have no more turns, and its user would never be told.
    expect(outside.telegrams).toEqual([])
    expect(logged.mock.calls).toEqual([['mail check failed:', 'Error']])
    expect(await connectionOf(userId)).toMatchObject({ status: 'active' })

    outside.failing.clear()
    clock.now = later(1)
    await runCheck(posting)

    const notice = expect.stringContaining('has lost its access to your Gmail jane@example.test')
    expect(outside.telegrams).toMatchObject([{ chat_id: chat.telegramId, text: notice }])
    expect(await connectionOf(userId)).toMatchObject({ status: 'needs_reconnect' })
  })

  it('is marked all the same when its user has blocked the bot, as no turn would get the message to them', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.ended.add(outside.issued[0])
    outside.blocked.add(chat.telegramId)

    await runCheck(posting)

    expect(outside.telegrams).toEqual([])
    expect(logged).not.toHaveBeenCalled()
    expect(await connectionOf(userId)).toMatchObject({ status: 'needs_reconnect' })

    clock.now = later(1)
    await runCheck(posting)

    expect(await connectionOf(userId)).toMatchObject({ last_run_at: NOW.getTime() / 1000 })
  })

  it('is marked, with its user told, when two runs find it out together', async () => {
    const chat = await connectedChat(JANE)
    outside.ended.add(outside.issued[0])

    await Promise.all([runCheck(deps), runCheck(deps)])

    // The telling comes before the marking, so each of two runs that overlap may tell the user. That is the price
    // of never marking a connection whose user could not be told.
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(new Set(sent.map((message) => message.chatId))).toEqual(new Set([chat.telegramId]))
    expect(await connectionOf(await chat.userId())).toMatchObject({ status: 'needs_reconnect' })
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

  it('gives a mailbox that is connected again no turn ahead of those that were waiting', async () => {
    const jane = await connectedChat(JANE)
    await connectedChat(SAM)
    await connectedChat('tom@example.test')
    expect(await turns(3)).toEqual([JANE, SAM, 'tom@example.test'])

    // Jane has had her turn, and connects again to have another before the others.
    await jane.say('/disconnect')
    expect(await jane.say(await signIn(jane, JANE))).toContain('Connected jane@example.test')

    expect(await turns(3)).toEqual([SAM, 'tom@example.test', JANE])
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

  it('does nothing when no mailbox is connected', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const asked = vi.spyOn(globalThis, 'fetch')

    await runCheck(deps)

    expect(asked).not.toHaveBeenCalled()
    expect(logged).not.toHaveBeenCalled()
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
    expect(await approved.say(code)).toContain('No sign-in is waiting for a code')
    // The one that still has time is left alone.
    expect(await recent.say(recentCode)).toContain('Connected sam@example.test')
  })

  it('are deleted with nothing revoked, when the mailbox one held is still connected for somebody', async () => {
    const owner = await connectedChat(JANE)
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    // Somebody else's link, which the owner of the mailbox was got to open and to approve.
    const other = openChat()
    await signIn(other, JANE)
    clock.now = later(10)

    await runCheck(deps)

    expect(await attemptOf(await other.userId())).toBeNull()
    // Google ends every token of an account when it revokes one. The owner's connection would have gone too.
    expect(outside.revoked).toEqual([])
    expect(await connectionOf(await owner.userId())).toMatchObject({ status: 'active', last_checked_at: now() })
    expect(sent.map((message) => message.text)).toEqual([`Card ••••1234: SGD 12.40 at COFFEE PLACE\n${ADD_CARD_HINT}`])
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

  it('are deleted even when Google cannot be told, and the run goes on to check a mailbox', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const abandoned = openChat()
    await signIn(abandoned, SAM)
    clock.now = later(10)
    const chat = await connectedChat(JANE)
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    outside.failing.add(REVOKE_URL)

    await runCheck(deps)

    expect(await attemptOf(await abandoned.userId())).toBeNull()
    expect(logged.mock.calls).toEqual([['token revocation failed:', 'Error']])
    expect(sent.map((message) => message.chatId)).toEqual([chat.telegramId])
  })
})

describe('when Google fails for a while', () => {
  it.each([
    ['the token endpoint', TOKEN_URL],
    ['the listing', MESSAGES_URL],
    ['the message', `${MESSAGES_URL}/msg-1`],
  ])('nothing changes when %s fails, and the next run reads the mail', async (_, endpoint) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    outside.mailboxes[JANE] = [alert('msg-1', 5)]
    outside.failing.add(endpoint)

    await runCheck(deps)

    // Only the turn is used up. The failure is logged by its name alone.
    expect(await connectionOf(userId)).toMatchObject({ status: 'active', last_checked_at: null, last_run_at: now() })
    expect(await purchasesOf(userId)).toEqual([])
    expect(await seenOf(userId)).toEqual([])
    expect(sent).toEqual([])
    expect(logged.mock.calls).toEqual([['mail check failed:', 'Error']])

    outside.failing.clear()
    await runCheck(deps)

    expect(sent.map((message) => message.text)).toEqual([`Card ••••1234: SGD 12.40 at COFFEE PLACE\n${ADD_CARD_HINT}`])
    expect(await connectionOf(userId)).toMatchObject({ status: 'active', last_checked_at: now() })
  })

  it('keeps what a run had noted before the failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const chat = await connectedChat(JANE)
    const userId = await chat.userId()
    // A run reads one alert. So what it has done before it fails on one is to turn other mail away.
    outside.mailboxes[JANE] = [lookalike('lookalike-1'), alert('msg-1', 500)]
    outside.failing.add(`${MESSAGES_URL}/msg-1`)

    await runCheck(deps)

    expect(await seenOf(userId)).toEqual([{ source_id: 'lookalike-1', status: 'rejected' }])
    expect(await purchasesOf(userId)).toEqual([])
    expect(await connectionOf(userId)).toMatchObject({ last_checked_at: null })

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
    // linked to a product, which takes one query more: for what the user chose for the merchant before.
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
    // The sweep and a look for each of its 5 mailboxes, the turn, 5 pages, the page token, a note of each message
    // turned away, 4 for each purchase (find its card, look up its merchant, store it, total the card), and the mark.
    expect(queries).toBe(1 + 5 + 1 + 5 + 1 + turnedAway + 4 * MESSAGES_PER_RUN + 1)
    expect(queries).toBe(27)
    expect(Math.max(requests, queries)).toBeLessThan(50)
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
