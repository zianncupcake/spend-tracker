import { describe, expect, it } from 'vitest'
import { codePage, homePage, privacyPage, problemPage } from '../src/pages'

const operator = { name: 'Example Operator', contact: 'privacy@spend-tracker.test' }

// Details that would be markup if they were put into a page as they are.
const hostile = { name: '<script>alert("name")</script>', contact: `"O'Neil & Co" <img src=x onerror=alert(1)>` }
const hostileNameEscaped = '&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;'
const hostileContactEscaped = '&quot;O&#39;Neil &amp; Co&quot; &lt;img src=x onerror=alert(1)&gt;'

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
  /**
   * The policy as a reader has it, to whom the line breaks in the page's source are only spaces. `photos` is whether
   * the bot reads photos, which it does with a model of the provider that answers its questions.
   */
  const policy = async (assistant: boolean, photos = false) =>
    (await privacyPage(operator, assistant, photos).text()).replace(/\s+/g, ' ')

  // What the policy says of the bot's assistant, which a service has when it is set up with an AI provider.
  const ASSISTANT = [
    '<h2>Questions that you ask the bot</h2>',
    'A text message that you send the bot is read as a question when it is not a command, and is not the 6-digit ' +
      'code of a sign-in.',
    'To answer it, your question is sent to an AI provider chosen by Example Operator, which produces the answer.',
    'Other details are sent only as the answering calls for them, and they are of your purchases: the id, the ' +
      'time, the last four digits of the card, the amount, the currency, the merchant and the reward category.',
    'Nothing is sent to the AI provider unless you ask a question.',
    'An AI provider chosen by Example Operator answers the questions that you ask the bot. It is sent each ' +
      'question and the card and purchase details needed to answer it, with your time zone and with the nicknames ' +
      'and category names of your cards, and nothing unless you ask a question.',
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

  it('says that the AI provider works out what the bot is asked to do, and that what removes or revokes waits for a confirmation', async () => {
    const said =
      'The AI provider also works out what you ask the bot to do in such a message, such as adding a purchase or ' +
      'changing your time zone, and the bot then does it. What removes or revokes something, such as taking a ' +
      'purchase out or disconnecting your Gmail, is done only after you confirm it.'

    for (const text of [await policy(true), await policy(true, true)]) {
      // It is said once, in a paragraph of its own: the one that follows what a question is sent with.
      expect(text.split(`<p>${said}</p>`)).toHaveLength(2)
      expect(text).toMatch(/Nothing is sent to the AI provider unless you ask a question[^.]*\.<\/p> <p>The AI provider also/)
      expect(text).toContain('Last updated: 11 October 2026')
    }
    // A service with no assistant has nobody to work anything out, and says none of it.
    expect(await policy(false)).not.toMatch(/what you ask the bot to do|only after you confirm/)
  })

  it('says what goes to the AI provider with every question, whether or not the question needs it', async () => {
    const said =
      'With every question go your time zone, the day and the time that it is there, the nicknames of your cards ' +
      'and the names of the reward categories that their purchases can be sorted into, whether or not the ' +
      'question needs them.'

    for (const text of [await policy(true), await policy(true, true)]) {
      // It is said once, between what a question is sent to and what else is sent only when it is called for.
      expect(text.split(said)).toHaveLength(2)
      expect(text).toContain(`which produces the answer. ${said} Other details are sent only as the answering calls`)
      // Nothing that is sent with every question is still said to be sent only when it is called for. And nothing
      // of a card's window or its totals is said to be sent: the bot shows those itself, and sends them to nobody.
      const [, asNeeded = ''] = /they are of your purchases: ([^.]*)\./.exec(text) ?? []
      expect(asNeeded).toMatch(/^the id, the time, the last four digits of the card/)
      expect(asNeeded).not.toMatch(/time zone|nickname|window|total/)
      expect(text).toContain('Last updated: 11 October 2026')
    }
    expect(await policy(false)).not.toContain('With every question')
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

  // What the policy says of photos, on a service that reads them. The first eight are said of nothing else.
  const PHOTOS = [
    '<h2>Photos that you send the bot</h2>',
    'A photo that you send the bot is sent to the same AI provider to be read, with its caption, with your time ' +
      'zone and with the nicknames and category names of your cards.',
    'The provider reads the purchases out of it, and the bot adds them.',
    'The photo is not stored.',
    'When the bot cannot tell which card the purchases were made with, or is not sure of an amount or a date, it ' +
      'asks you before it adds them.',
    '<li>The purchases read from a photo that you send the bot, which are stored as the purchases that you add by ' +
      'hand are. The photo itself is not stored.</li>',
    '<li>The purchases from a photo that the bot asks you about before it adds them. They wait for your answer for ' +
      'a day at the most, and are then deleted.</li>',
    'An AI provider chosen by Example Operator answers the questions that you ask the bot, and reads the photos that ' +
      'you send it. It is sent each question and the card and purchase details needed to answer it, and each photo ' +
      'with its caption, each of them with your time zone and with the nicknames and category names of your cards, ' +
      'and nothing unless you ask a question or send a photo.',
    'Nothing is sent to the AI provider unless you ask a question or send a photo.',
  ]

  it('says what becomes of a photo, where the bot reads photos: what is sent, to whom, and what is stored of it', async () => {
    const text = await policy(true, true)

    for (const words of PHOTOS) expect(text).toContain(words)
    // Each is said where it belongs: with what is stored, on its own after what is said of questions, and with who
    // else handles the data.
    const places = [
      '<h2>What is stored</h2>',
      '<li>The purchases that you add by hand:',
      PHOTOS[5],
      PHOTOS[6],
      '<li>The reward category that each purchase is sorted into.</li>',
      '<h2>Questions that you ask the bot</h2>',
      '<h2>Photos that you send the bot</h2>',
      '<h2>Who else handles your data</h2>',
      PHOTOS[7],
      '<h2>Data from Google</h2>',
    ].map((words) => text.indexOf(words))
    expect(places[0]).toBeGreaterThan(-1)
    expect(places).toEqual(places.toSorted((before, after) => before - after))
    // What a question is sent with is still said, and what is said of when nothing is sent is said of both.
    expect(text).toContain('To answer it, your question is sent to an AI provider chosen by Example Operator')
    expect(text).not.toContain('unless you ask a question.')
    // The page is dated as it was.
    expect(text).toContain('Last updated: 11 October 2026')
  })

  it.each([
    ['an assistant and no model that reads photos', true, false],
    ['no assistant', false, false],
    // A service reads photos with the model of the provider that answers its questions, so it reads none without one.
    ['no assistant, whatever is said of photos', false, true],
  ])('says nothing of photos where the bot reads none: with %s', async (_, assistant, photos) => {
    const text = await policy(assistant, photos)

    for (const words of [...PHOTOS.slice(0, 8), 'photo', 'Photo', 'caption']) expect(text).not.toContain(words)
    // What it says with an assistant is what it said before the bot read photos.
    if (assistant) expect(text).toContain('Nothing is sent to the AI provider unless you ask a question.</p>')
    expect(text).toContain('Last updated: 11 October 2026')
  })

  it.each([
    ['with an assistant', true, false],
    ['with an assistant that reads photos', true, true],
    ['with none', false, false],
  ])('says that a log is kept, what a line of it holds and what one never does, %s', async (_, assistant, photos) => {
    const text = await policy(assistant, photos)

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
    ['with an assistant', true, false],
    ['with an assistant that reads photos', true, true],
    ['with none', false, false],
  ])('says what Cloudflare keeps of each request besides, after what it says of the log, %s', async (_, assistant, photos) => {
    const text = await policy(assistant, photos)

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
    ['with an assistant', true, false],
    ['with an assistant that reads photos', true, true],
    ['with none', false, false],
  ])('says what is accessed, what is stored, who else handles it and how to remove it, %s', async (_, assistant, photos) => {
    const text = await policy(assistant, photos)

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

  it("escapes the operator's details in what it says of photos too", async () => {
    const html = (await privacyPage(hostile, true, true).text()).replace(/\s+/g, ' ')

    expect(html).toContain(
      `An AI provider chosen by ${hostileNameEscaped} answers the questions that you ask the bot, and reads the photos`,
    )
    expect(html).toContain(hostileContactEscaped)
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
  // Every page is sent with the same headers, and a sign-in page with two more. So a page of each kind is looked at.
  it.each<[name: string, page: () => Response]>([
    ['the homepage', () => homePage(operator)],
    ['the code page', () => codePage('123456')],
  ])('%s is HTML that browsers must not sniff', (_, page) => {
    const { headers } = page()

    expect(headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
  })

  // What a page holds is its own. The two here are those that no other test looks through for a script.
  it.each<[name: string, page: () => Response]>([
    ['the code page', () => codePage('123456')],
    ['the expired-link page', () => problemPage('expired')],
  ])('%s allows no scripts, and no styles but its own', async (_, page) => {
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
