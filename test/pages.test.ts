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

  // The sections that only some services have: one where the bot has an assistant, which it has when the service is
  // set up with an AI provider, and one more where the bot reads photos.
  const QUESTIONS = '<h2>Questions that you ask the bot</h2>'
  const PHOTOS = '<h2>Photos that you send the bot</h2>'

  it('says nothing of questions that are asked, or of an AI provider, where the bot has no assistant', async () => {
    const text = await policy(false)

    for (const words of [QUESTIONS, 'AI provider']) expect(text).not.toContain(words)
  })

  it('has a section on photos too, and lists their purchases as stored, where the bot reads photos', async () => {
    const text = await policy(true, true)

    for (const heading of [QUESTIONS, PHOTOS]) expect(text).toContain(heading)
    expect(text).toContain('The purchases read from a photo')
  })

  it.each([
    ['an assistant and no model that reads photos', true, false],
    // A service reads photos with the model of the provider that answers its questions, so it reads none without one.
    ['no assistant, whatever is said of photos', false, true],
  ])('says nothing of photos where the bot reads none: with %s', async (_, assistant, photos) => {
    const text = await policy(assistant, photos)

    for (const words of ['photo', 'Photo', 'caption']) expect(text).not.toContain(words)
  })

  it('names the service that is asked for the category code of a merchant', async () => {
    expect(await policy(false)).toContain('check-mcc.sg')
  })

  // The one sentence here whose wording is not the service's own: Google requires it of an app that reads Gmail.
  it('says of what it gets from Google what Google requires it to say', async () => {
    expect(await policy(true)).toContain(
      'The use of information received from Google APIs will adhere to the Google API Services User Data Policy, ' +
        'including the Limited Use requirements.',
    )
  })

  it("escapes the operator's details", async () => {
    const html = (await privacyPage(hostile, true, false).text()).replace(/\s+/g, ' ')

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
    ['expired', 400, 'This link has expired'],
    ['not-completed', 400, 'Sign-in was not completed'],
    ['no-gmail-access', 400, 'Gmail access was not given'],
    ['no-lasting-access', 400, 'Google gave no lasting access'],
    ['failed', 500, 'Sign-in could not be completed'],
  ] as const)('say what went wrong: %s', async (problem, status, title) => {
    const response = problemPage(problem)
    const html = await response.text()

    expect(response.status).toBe(status)
    expect(html).toContain(`<h1>${title}</h1>`)
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
