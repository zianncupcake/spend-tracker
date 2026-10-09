import { describe, expect, it } from 'vitest'
import { codePage, homePage, privacyPage, problemPage } from '../src/pages'

const operator = { name: 'Example Operator', contact: 'privacy@spend-tracker.test' }

// Details that would be markup if they were put into a page as they are.
const hostile = { name: '<script>alert("name")</script>', contact: `"O'Neil & Co" <img src=x onerror=alert(1)>` }
const hostileNameEscaped = '&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;'
const hostileContactEscaped = '&quot;O&#39;Neil &amp; Co&quot; &lt;img src=x onerror=alert(1)&gt;'

const everyPage: [name: string, page: () => Response][] = [
  ['the homepage', () => homePage(operator)],
  ['the privacy policy', () => privacyPage(operator)],
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
  it('names the operator and how to reach them, and when it was last updated', async () => {
    const response = privacyPage(operator)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<h1>Privacy policy</h1>')
    expect(html).toContain('Last updated: 10 October 2026')
    expect(html).toContain('Example Operator')
    expect(html).toContain('contact: privacy@spend-tracker.test')
  })

  it('says what is accessed, what is stored, who else handles it and how to remove it', async () => {
    // Line breaks in the page's source are only spaces to a reader.
    const text = (await privacyPage(operator).text()).replace(/\s+/g, ' ')

    for (const words of [
      'read-only access',
      'a fixed list of bank senders',
      'the amount, the currency, the merchant, the last four digits of the card and the time',
      'Your Telegram user id.',
      "Your time zone, which is Singapore's unless you set another.",
      'The card nicknames, last four digits and window settings that you enter.',
      'The card product that you link a card to.',
      'The purchases that you add by hand: the amount, currency, merchant and date that you give each one.',
      'The reward category that each purchase is sorted into, and the category that you last chose for a merchant, ' +
        'kept so that your later purchases there start in it.',
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
    const html = await privacyPage(hostile).text()

    expect(html).toContain(hostileNameEscaped)
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
