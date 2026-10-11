import { describe, expect, it } from 'vitest'
import { codePage, homePage, privacyPage, problemPage } from '../src/pages'

const operator = { name: 'Example Operator', contact: 'privacy@spend-tracker.test' }

// Details that would be markup if they were put into a page as they are.
const hostile = { name: '<script>alert("name")</script>', contact: `"O'Neil & Co" <img src=x onerror=alert(1)>` }
const hostileNameEscaped = '&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;'
const hostileContactEscaped = '&quot;O&#39;Neil &amp; Co&quot; &lt;img src=x onerror=alert(1)&gt;'

const everyPage: [name: string, page: () => Response][] = [
  ['the homepage', () => homePage(operator)],
  ['the privacy policy', () => privacyPage(operator, true)],
  ['the code page', () => codePage('123456')],
  ['the expired-link page', () => problemPage('expired')],
  ['the failure page', () => problemPage('failed')],
]

describe('the homepage', () => {
  it('says what the service does and who runs it, and links to the privacy policy', async () => {
    const response = homePage(operator)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<h1>Spend Tracker</h1>')
    expect(html).toContain('read-only access')
    expect(html).toContain('<a href="/privacy">Privacy policy</a>')
    expect(html).toContain('Spend Tracker is run by Example Operator. Contact: privacy@spend-tracker.test')
  })

  it("escapes the operator's details", async () => {
    const html = await homePage(hostile).text()

    expect(html).toContain(`Spend Tracker is run by ${hostileNameEscaped}. Contact: ${hostileContactEscaped}`)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
  })
})

describe('the privacy policy', () => {
  /** The policy as a reader has it, to whom the line breaks in the page's source are only spaces. */
  const policy = async (assistant: boolean) => (await privacyPage(operator, assistant).text()).replace(/\s+/g, ' ')

  // What the policy says of the bot's assistant, which a service has when it is set up with an AI provider.
  const ASSISTANT = [
    '<h2>Questions that you ask the bot</h2>',
    'A text message that you send the bot is read as a question when it is not a command, and is not the 6-digit ' +
      'code of a sign-in.',
    'To answer it, your question and the card and purchase details needed to answer it are sent to an AI provider ' +
      'chosen by Example Operator, which produces the answer.',
    'The details are those that the answering calls for, out of these: your time zone, the nickname, last four ' +
      'digits, window, totals and number of purchases of each of your cards and, of your purchases, the id, the ' +
      'time, the last four digits of the card, the amount, the currency, the merchant and the reward category.',
    'Nothing is sent to the AI provider unless you ask a question.',
    'An AI provider chosen by Example Operator answers the questions that you ask the bot. It is sent each ' +
      'question and the card and purchase details needed to answer it, and nothing unless you ask a question.',
  ]

  it('names the operator and how to reach them, and when it was last updated', async () => {
    const response = privacyPage(operator, true)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<h1>Privacy policy</h1>')
    expect(html).toContain('Last updated: 11 October 2026')
    expect(html).toContain('Example Operator')
    expect(html).toContain('contact: privacy@spend-tracker.test')
  })

  it('says what becomes of a question, where the bot has an assistant: what is sent, to whom, and when', async () => {
    const text = await policy(true)

    for (const words of ASSISTANT) expect(text).toContain(words)
    // Nobody turns the assistant on, so nothing is said of turning it on or off.
    expect(text).not.toMatch(/turn(ed|s|ing)? (it|the assistant) (on|off)/i)
    // Each is said where it belongs: on its own after what is stored, and with who else handles the data.
    const [stored, questions, others, google] = [
      '<h2>What is stored</h2>',
      '<h2>Questions that you ask the bot</h2>',
      '<h2>Who else handles your data</h2>',
      '<h2>Data from Google</h2>',
    ].map((heading) => text.indexOf(heading))
    expect(stored).toBeGreaterThan(-1)
    expect(questions).toBeGreaterThan(stored)
    expect(questions).toBeLessThan(others)
    expect(text.indexOf('An AI provider chosen by Example Operator answers')).toBeGreaterThan(others)
    expect(text.indexOf('An AI provider chosen by Example Operator answers')).toBeLessThan(google)
    // Nothing is kept of a question. So all that is said of one with what is stored is that the log never holds it.
    expect(text.slice(stored, questions).match(/[^.]*question[^.]*\./gi)).toEqual([
      ' It never holds a message, a question, an answer, an email, a merchant, a card number, a Telegram id or a ' +
        'token.',
    ])
  })

  it('says nothing of questions that are asked, or of an AI provider, where the bot has no assistant', async () => {
    const text = await policy(false)

    for (const words of [...ASSISTANT, 'AI provider', 'question and', 'Questions']) {
      expect(text).not.toContain(words)
    }
    expect(text).toContain('Last updated: 11 October 2026')
    // The assistant that a user connects with a token of their own is another thing, and is still there.
    expect(text).toContain('An AI assistant that you connect with your assistant access token')
  })

  it.each([
    ['with an assistant', true],
    ['with none', false],
  ])('says that a log is kept, what a line of it holds and what one never does, %s', async (_, assistant) => {
    const text = await policy(assistant)

    const said =
      'The service also keeps a log of what it did, for finding faults. ' +
      "A line of the log holds the service's own number for a user, the kind of thing that happened, counts, " +
      'durations and error codes. ' +
      'It never holds a message, a question, an answer, an email, a merchant, a card number, a Telegram id or a ' +
      'token. ' +
      'Cloudflare keeps the log for a few days.'
    // It is said once, as a paragraph of its own, with what is stored: after the list, and before whatever follows.
    expect(text.split(`<p>${said}</p>`)).toHaveLength(2)
    const next = assistant ? '<h2>Questions that you ask the bot</h2>' : '<h2>Who else handles your data</h2>'
    expect(text.indexOf(said)).toBeGreaterThan(text.indexOf('<h2>What is stored</h2>'))
    expect(text.indexOf(said)).toBeGreaterThan(text.indexOf('The text of an email is never stored.'))
    expect(text.indexOf(next)).toBeGreaterThan(text.indexOf(said))
    // The page is dated as it was.
    expect(text).toContain('Last updated: 11 October 2026')
  })

  it.each([
    ['with an assistant', true],
    ['with none', false],
  ])('says what Cloudflare keeps of each request besides, after what it says of the log, %s', async (_, assistant) => {
    const text = await policy(assistant)

    const said =
      'Cloudflare also keeps, for the same few days, its own record of each request to the service. ' +
      'For a request that comes from you, which is a page that you open in a browser, such as the sign-in link, ' +
      'or a request from an AI assistant that you connect, that record holds the address that was asked for, ' +
      'your IP address, the rough location and the network that Cloudflare works out from it, ' +
      'and what your browser or assistant sends about itself.'
    // It is said once, in a paragraph of its own: the one that follows what is said of the log.
    expect(text.split(`<p>${said}</p>`)).toHaveLength(2)
    expect(text).toContain(`Cloudflare keeps the log for a few days.</p> <p>${said}</p>`)
    const next = assistant ? '<h2>Questions that you ask the bot</h2>' : '<h2>Who else handles your data</h2>'
    expect(text.indexOf(next)).toBeGreaterThan(text.indexOf(said))
  })

  it.each([
    ['with an assistant', true],
    ['with none', false],
  ])('says what is accessed, what is stored, who else handles it and how to remove it, %s', async (_, assistant) => {
    const text = await policy(assistant)

    for (const words of [
      'read-only access',
      'a fixed list of bank senders',
      'the amount, the currency, the merchant, the last four digits of the card and the time',
      'Your Telegram user id.',
      "Your time zone, which is Singapore's unless you set another.",
      'The card nicknames, last four digits and window settings that you enter.',
      'The card product that you link a card to.',
      'The purchases that you add by hand: the amount, currency, merchant and date that you give each one, with ' +
        'the id of the Telegram message that added it, so that it is not counted twice.',
      'The reward category that each purchase is sorted into.',
      'A purchase that you take out, which stays stored and marked as taken out, so that its alert is not counted ' +
        'again. It is left out of every total and list, and is deleted with everything else.',
      'The id of any alert that was fetched but not recorded, and why it was not, ' +
        'kept so that it is not fetched again.',
      'Your Gmail address.',
      'An encrypted key that lets the service read your mail until you disconnect.',
      'A hash of your assistant access token, if you create one.',
      'The text of an email is never stored.',
      'Cloudflare hosts the service and its database.',
      'Those messages contain details of your purchases, and Telegram keeps them.',
      'Google provides the sign-in.',
      'An AI assistant that you connect with your assistant access token can read your card totals and purchases, ' +
        'until you remove the token with <code>/mcp revoke</code>.',
      'Your data is not sold and is not used for advertising.',
      'The use of information received from Google APIs will adhere to the Google API Services User Data Policy, ' +
        'including the Limited Use requirements.',
      'No person reads your email data unless you explicitly agree, it is needed for security, or the law requires it.',
      'It is not used to train AI models.',
      'Send <code>/disconnect</code> to the bot to remove its access to your Gmail. The service then asks Google to ' +
        'revoke that access too, except when the same mailbox is still connected, or is being connected, from ' +
        'another chat.',
      '<code>/delete confirm</code>',
      'Deleted data can remain in database backups for up to 30 days.',
    ]) {
      expect(text).toContain(words)
    }
  })

  it("escapes the operator's details", async () => {
    const html = (await privacyPage(hostile, true).text()).replace(/\s+/g, ' ')

    expect(html).toContain(hostileNameEscaped)
    expect(html).toContain(hostileContactEscaped)
    // The name is in what is said of the assistant too, in two places.
    expect(html).toContain(`an AI provider chosen by ${hostileNameEscaped}, which produces the answer`)
    expect(html).toContain(`An AI provider chosen by ${hostileNameEscaped} answers the questions`)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
  })
})

describe('the sign-in pages', () => {
  it('show the code to send to the bot, escaped like anything else', async () => {
    const response = codePage('123456')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<p class="code">123456</p>')
    expect(html).toContain('send this code to the bot in Telegram')
    expect(await codePage('<b>&</b>').text()).toContain('<p class="code">&lt;b&gt;&amp;&lt;/b&gt;</p>')
  })

  it.each([
    ['expired', 400, 'This link has expired', 'Send /connect to the bot for a new one.'],
    ['not-completed', 400, 'Sign-in was not completed', 'Nothing was connected.'],
    ['no-gmail-access', 400, 'Gmail access was not given', 'allow that permission when Google asks'],
    ['no-lasting-access', 400, 'Google gave no lasting access', 'then send /connect to the bot to try again'],
    ['failed', 500, 'Sign-in could not be completed', 'To try again, send /connect to the bot.'],
  ] as const)('say what went wrong: %s', async (problem, status, title, advice) => {
    const response = problemPage(problem)
    const html = await response.text()

    expect(response.status).toBe(status)
    expect(html).toContain(`<h1>${title}</h1>`)
    expect(html).toContain(advice)
  })

  it.each([
    ['the code page', () => codePage('123456')],
    ['a problem page', () => problemPage('expired')],
  ])('keep %s out of caches and out of referrers', (_, page) => {
    const { headers } = page()

    expect(headers.get('cache-control')).toBe('no-store')
    expect(headers.get('referrer-policy')).toBe('no-referrer')
  })
})

describe('every page', () => {
  it.each(everyPage)('%s is HTML that browsers must not sniff', (_, page) => {
    const { headers } = page()

    expect(headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
  })

  it.each(everyPage)('%s allows no scripts, and no styles but its own', async (_, page) => {
    const response = page()
    const html = await response.text()

    const [, nonce] = /<style nonce="([^"]+)">/.exec(html) ?? []
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/)
    expect(response.headers.get('content-security-policy')).toBe(
      `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    )
    expect(html).not.toContain('<script')
  })

  it('makes a new nonce for every response', async () => {
    const nonces = await Promise.all(
      [homePage(operator), homePage(operator)].map(async (page) => /nonce="([^"]+)"/.exec(await page.text())?.[1]),
    )

    expect(nonces[0]).not.toBe(nonces[1])
  })
})
