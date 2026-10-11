import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMessage,
  getMessageHeaders,
  GrantLostError,
  listMessageIds,
  PageTokenError,
  refreshAccessToken,
} from '../src/google/gmail'
import { GMAIL_READONLY, GoogleError, type GoogleClient } from '../src/google/oauth'
import { Failure } from '../src/log'
import { gmailMessage, gmailResults, headersOf, htmlPart, multipart, textPart, type Part } from './gmail-helpers'
import { alertText, seconds } from './helpers'

const client: GoogleClient = {
  clientId: 'made-up-client-id',
  clientSecret: 'made-up-client-secret',
  redirectUri: 'https://spend-tracker.test/oauth/callback',
}

const ALERT = alertText('SGD 12.40', '1234')

// Google is reached with the global fetch. It is replaced here, as
// test/oauth.test.ts does, so nothing is sent to Google.
const google = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  google.mockReset()
  vi.stubGlobal('fetch', google)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** What is read from a message that Gmail returns. */
function read(message: object) {
  google.mockResolvedValue(Response.json(message))
  return getMessage('made-up-access-token', 'msg-1')
}

/** The text read from a message with this content. */
async function textOf(content: Part): Promise<string> {
  return (await read(gmailMessage({ content }))).text()
}

/** The domain a message is found to be authentic for, given its Authentication-Results headers from the top down. */
async function authenticated(...results: string[]): Promise<string | null> {
  return (await read(gmailMessage({ results }))).authenticatedDomain
}

describe('refreshing an access token', () => {
  it('posts the refresh token to the token endpoint, and returns the access token', async () => {
    google.mockResolvedValue(
      Response.json({
        access_token: 'made-up-access-token',
        expires_in: 3599,
        scope: GMAIL_READONLY,
        token_type: 'Bearer',
      }),
    )

    expect(await refreshAccessToken(client, 'made-up-refresh-token')).toBe('made-up-access-token')

    expect(google).toHaveBeenCalledTimes(1)
    const [url, init] = google.mock.calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init?.method).toBe('POST')
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'made-up-refresh-token',
      client_id: 'made-up-client-id',
      client_secret: 'made-up-client-secret',
    })
  })

  it('says that the grant is gone when Google answers 400 with invalid_grant', async () => {
    google.mockResolvedValue(
      Response.json(
        { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        { status: 400 },
      ),
    )

    const failure = await refreshAccessToken(client, 'made-up-refresh-token').catch((error: Error) => error)

    expect(failure).toBeInstanceOf(GrantLostError)
    expect((failure as Error).name).toBe('GrantLostError')
    expect(failure).toMatchObject({ reason: 'grant_lost' })
  })

  it.each([
    ['a 500', () => new Response('Internal Server Error', { status: 500 }), 500],
    ['a 500 that says invalid_grant', () => Response.json({ error: 'invalid_grant' }, { status: 500 }), 500],
    ['a 400 with another error', () => Response.json({ error: 'invalid_request' }, { status: 400 }), 400],
    ['a 400 that is not JSON', () => new Response('Bad Request', { status: 400 }), 400],
    ['a 401', () => Response.json({ error: 'invalid_client' }, { status: 401 }), 401],
  ])('takes %s for a failure that may pass, with nothing of the request in the error', async (_, answer, status) => {
    google.mockResolvedValue(answer())

    const failure = await refreshAccessToken(client, 'made-up-refresh-token').catch((error: Error) => error)

    expect(failure).not.toBeInstanceOf(GrantLostError)
    // All that the error holds is the status, and why it was thrown. Its message names the request and the status.
    expect(failure).toEqual(new GoogleError('Google token refresh', status))
    expect((failure as Error).message).toBe(`Google token refresh failed with status ${status}`)
  })

  it('throws when the response holds no access token', async () => {
    google.mockResolvedValue(Response.json({ expires_in: 3599, token_type: 'Bearer' }))

    const failure = await refreshAccessToken(client, 'made-up-refresh-token').catch((error: Error) => error)

    expect(failure).toEqual(new Failure('no_access_token', 'Google token refresh returned no access token'))
  })
})

describe('listing messages', () => {
  const QUERY = 'from:(alerts@examplebank.test) after:1790000000'

  it('asks for a page of up to 100 ids that match the query, and returns them in the order Gmail does', async () => {
    google.mockResolvedValue(
      Response.json({
        messages: [
          { id: 'msg-3', threadId: 'thread-3' },
          { id: 'msg-1', threadId: 'thread-1' },
          { id: 'msg-2', threadId: 'thread-1' },
        ],
        resultSizeEstimate: 3,
      }),
    )

    const page = await listMessageIds('made-up-access-token', QUERY)

    expect(page).toEqual({ ids: ['msg-3', 'msg-1', 'msg-2'], nextPageToken: undefined })
    expect(google).toHaveBeenCalledTimes(1)
    const [url, init] = google.mock.calls[0]
    const asked = new URL(url)
    expect(asked.origin + asked.pathname).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    expect(Object.fromEntries(asked.searchParams)).toEqual({ q: QUERY, maxResults: '100' })
    expect(init?.method).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer made-up-access-token')
  })

  it('returns the token of the next page, and asks for that page when it is given the token', async () => {
    google.mockResolvedValueOnce(
      Response.json({ messages: [{ id: 'msg-2', threadId: 'thread-2' }], nextPageToken: 'made-up-page-token' }),
    )
    google.mockResolvedValueOnce(Response.json({ messages: [{ id: 'msg-1', threadId: 'thread-1' }] }))

    const first = await listMessageIds('made-up-access-token', QUERY)
    const second = await listMessageIds('made-up-access-token', QUERY, first.nextPageToken)

    expect(first).toEqual({ ids: ['msg-2'], nextPageToken: 'made-up-page-token' })
    expect(second).toEqual({ ids: ['msg-1'], nextPageToken: undefined })
    const asked = google.mock.calls.map(([url]) => Object.fromEntries(new URL(url).searchParams))
    expect(asked).toEqual([
      { q: QUERY, maxResults: '100' },
      { q: QUERY, maxResults: '100', pageToken: 'made-up-page-token' },
    ])
  })

  it('returns no ids when nothing matches', async () => {
    google.mockResolvedValue(Response.json({ resultSizeEstimate: 0 }))

    expect(await listMessageIds('made-up-access-token', QUERY)).toEqual({ ids: [], nextPageToken: undefined })
  })

  it('throws when Gmail refuses, with nothing of the request in the error', async () => {
    google.mockResolvedValue(Response.json({ error: { code: 500, message: 'Backend Error' } }, { status: 500 }))

    const failure = await listMessageIds('made-up-access-token', QUERY).catch((error: Error) => error)

    expect(failure).toEqual(new GoogleError('Gmail list request', 500))
    expect((failure as Error).message).toBe('Gmail list request failed with status 500')
  })

  it('says that Gmail did not take the page token when it answers 400 to a request that brought one', async () => {
    google.mockResolvedValue(Response.json({ error: { code: 400, message: 'Invalid pageToken' } }, { status: 400 }))

    const failure = await listMessageIds('made-up-access-token', QUERY, 'made-up-page-token').catch(
      (error: Error) => error,
    )

    expect(failure).toBeInstanceOf(PageTokenError)
    expect((failure as Error).name).toBe('PageTokenError')
    expect((failure as Error).message).toBe('')
    expect(failure).toMatchObject({ reason: 'page_token' })
  })

  it.each<[what: string, status: number, pageToken?: string]>([
    ['a 400 to a request for the first page', 400],
    ['a 500 to a request that brought a page token', 500, 'made-up-page-token'],
    ['a 401 to a request that brought a page token', 401, 'made-up-page-token'],
  ])('takes %s for a failure of another kind', async (_, status, pageToken) => {
    google.mockResolvedValue(Response.json({ error: { code: status, message: 'Made up' } }, { status }))

    const failure = await listMessageIds('made-up-access-token', QUERY, pageToken).catch((error: Error) => error)

    expect(failure).not.toBeInstanceOf(PageTokenError)
    expect(failure).toEqual(new GoogleError('Gmail list request', status))
  })
})

describe('reading the headers of a message', () => {
  const ASKED_FOR = ['From', 'Subject', 'Authentication-Results']

  /** What is read from the headers of a message, when Gmail returns those that were asked for and no more. */
  function readHeaders(message: ReturnType<typeof gmailMessage>) {
    google.mockResolvedValue(Response.json(headersOf(message, ASKED_FOR)))
    return getMessageHeaders('made-up-access-token', 'msg-1')
  }

  it('asks Gmail for three headers of the message, and for nothing else of it', async () => {
    await readHeaders(gmailMessage())

    expect(google).toHaveBeenCalledTimes(1)
    const [url, init] = google.mock.calls[0]
    expect(url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1' +
        '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Authentication-Results',
    )
    expect(init?.method).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer made-up-access-token')
  })

  it('reads the sender, the subject and the domain that the message is authentic for', async () => {
    const message = gmailMessage({ from: 'Example Bank <Alerts@ExampleBank.TEST>', subject: 'Transaction alert' })

    expect(await readHeaders(message)).toEqual({
      from: 'alerts@examplebank.test',
      subject: 'Transaction alert',
      authenticatedDomain: 'examplebank.test',
    })
  })

  it('goes by the topmost header that names Gmail, as it does for a whole message', async () => {
    const PASS = gmailResults('pass', 'examplebank.test')
    const FAIL = gmailResults('fail', 'examplebank.test')

    expect(await readHeaders(gmailMessage({ results: [FAIL, PASS] }))).toMatchObject({ authenticatedDomain: null })
    expect(await readHeaders(gmailMessage({ results: [PASS, FAIL] }))).toMatchObject({
      authenticatedDomain: 'examplebank.test',
    })
  })

  it('reads a message that comes with no headers as one from nobody', async () => {
    google.mockResolvedValue(Response.json({ id: 'msg-1', threadId: 'msg-1', labelIds: ['INBOX'] }))

    expect(await getMessageHeaders('made-up-access-token', 'msg-1')).toEqual({
      from: '',
      subject: '',
      authenticatedDomain: null,
    })
  })

  it('throws when Gmail refuses, with nothing of the request in the error', async () => {
    google.mockResolvedValue(Response.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 }))

    const failure = await getMessageHeaders('made-up-access-token', 'msg-1').catch((error: Error) => error)

    expect(failure).toEqual(new GoogleError('Gmail message request', 404))
    expect((failure as Error).message).toBe('Gmail message request failed with status 404')
  })
})

describe('reading a message', () => {
  it('asks Gmail for the full message by its id', async () => {
    await read(gmailMessage())

    expect(google).toHaveBeenCalledTimes(1)
    const [url, init] = google.mock.calls[0]
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1?format=full')
    expect(init?.method).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer made-up-access-token')
  })

  it('reads the sender, the subject, the time and the text of a plain-text message', async () => {
    const text = `Dear customer,\r\n\r\n${ALERT}\r\n\r\nThank you for banking with us.\r\n`
    const message = gmailMessage({
      from: 'alerts@examplebank.test',
      subject: 'Transaction alert',
      receivedAt: seconds('2026-10-09T11:55:00+08:00'),
      content: textPart(text),
    })

    const found = await read(message)

    expect(found).toEqual({
      from: 'alerts@examplebank.test',
      subject: 'Transaction alert',
      receivedAt: seconds('2026-10-09T11:55:00+08:00'),
      authenticatedDomain: 'examplebank.test',
      text: expect.any(Function),
    })
    expect(found.text()).toBe(text)
  })

  it('gives the time in whole seconds', async () => {
    const message = { ...gmailMessage(), internalDate: '1791518400999' }

    expect((await read(message)).receivedAt).toBe(1791518400)
  })

  it.each([
    ['a display name that holds another address', '"Other Bank <alerts@otherbank.test>" <alerts@examplebank.test>'],
    ['brackets and no display name', '<alerts@examplebank.test>'],
    ['capital letters', 'Example Bank <Alerts@ExampleBank.TEST>'],
    ['space around it', '  alerts@examplebank.test  '],
  ])('reads the bare address, in lower case, from a From header with %s', async (_, from) => {
    expect((await read(gmailMessage({ from }))).from).toBe('alerts@examplebank.test')
  })

  it('reads the address in the brackets, whatever the display name claims', async () => {
    const message = gmailMessage({ from: 'alerts@examplebank.test <someone@attacker.test>' })

    expect((await read(message)).from).toBe('someone@attacker.test')
  })

  it('reads header names whatever their case, and a missing header as empty', async () => {
    const message = gmailMessage()
    message.payload.headers = [
      { name: 'AUTHENTICATION-RESULTS', value: gmailResults('pass', 'examplebank.test') },
      { name: 'from', value: 'alerts@examplebank.test' },
    ]

    expect(await read(message)).toMatchObject({
      from: 'alerts@examplebank.test',
      subject: '',
      authenticatedDomain: 'examplebank.test',
    })
    const bare = await read({ internalDate: '1791518400000' })
    expect(bare).toMatchObject({ from: '', subject: '', receivedAt: 1791518400, authenticatedDomain: null })
    expect(bare.text()).toBe('')
  })

  it('throws when Gmail refuses, or sends a message without a time', async () => {
    google.mockResolvedValueOnce(Response.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 }))
    google.mockResolvedValueOnce(Response.json({ id: 'msg-1' }))

    await expect(getMessage('made-up-access-token', 'msg-1')).rejects.toEqual(
      new GoogleError('Gmail message request', 404),
    )
    await expect(getMessage('made-up-access-token', 'msg-1')).rejects.toEqual(
      new Failure('no_date', 'Gmail message held no date'),
    )
  })
})

describe('the text of a message', () => {
  it('is not decoded until it is asked for', async () => {
    const decoding = vi.spyOn(Uint8Array, 'fromBase64')

    const message = await read(gmailMessage({ content: htmlPart(`<p>${ALERT}</p>`) }))
    expect(decoding).not.toHaveBeenCalled()

    expect(message.text()).toBe(ALERT)
    expect(decoding).toHaveBeenCalledTimes(1)
  })

  it('is the plain-text part of a multipart/alternative message, wherever that part comes', async () => {
    const html = htmlPart(`<p>${ALERT} As HTML.</p>`)
    const plain = textPart(`${ALERT} As plain text.`)

    expect(await textOf(multipart('alternative', plain, html))).toBe(`${ALERT} As plain text.`)
    expect(await textOf(multipart('alternative', html, plain))).toBe(`${ALERT} As plain text.`)
    // The name of a type is the same in any case.
    expect(await textOf(multipart('alternative', html, { ...plain, mimeType: 'Text/Plain' }))).toBe(
      `${ALERT} As plain text.`,
    )
  })

  it('is found in parts that are nested in other parts', async () => {
    const attachment: Part = { mimeType: 'application/pdf', body: { size: 2048 } }
    const image: Part = { mimeType: 'image/png', body: { size: 1024 } }
    const plain = textPart(ALERT)
    const html = htmlPart(`<p>${ALERT}</p>`)

    const htmlOnly = multipart('mixed', attachment, multipart('related', multipart('alternative', html), image))

    expect(await textOf(multipart('mixed', multipart('alternative', plain, html), attachment))).toBe(ALERT)
    expect(await textOf(htmlOnly)).toBe(ALERT)
  })

  it('is empty for a message with no part that can be read', async () => {
    const attachment: Part = { mimeType: 'application/pdf', body: { size: 2048 } }
    const emptyPlain: Part = { mimeType: 'text/plain', body: { size: 0, data: '' } }

    expect(await textOf(multipart('mixed', attachment))).toBe('')
    expect(await textOf(emptyPlain)).toBe('')
    // An empty plain-text part does not hide the HTML part beside it.
    expect(await textOf(multipart('alternative', emptyPlain, htmlPart(`<p>${ALERT}</p>`)))).toBe(ALERT)
  })

  it('is not looked for deeper than real mail nests', async () => {
    const nested = (levels: number) =>
      Array.from({ length: levels }).reduce<Part>((inner) => multipart('mixed', inner), textPart(ALERT))

    expect(await textOf(nested(10))).toBe(ALERT)
    expect(await textOf(nested(11))).toBe('')
  })

  it('is decoded as UTF-8, from base64url with or without its padding', async () => {
    // The question marks and the tildes are encoded with _ and -, the two characters that only base64url has.
    const text = '??? ~~~ Paid SGD 3.50 at CAFÉ ÉTOILE — card ••••1234'
    const bytes = new TextEncoder().encode(text)
    const unpadded: Part = {
      mimeType: 'text/plain',
      body: { size: bytes.length, data: bytes.toBase64({ alphabet: 'base64url', omitPadding: true }) },
    }
    expect(unpadded.body.data).toMatch(/^Pz8_IH5-/)
    expect(textPart(text).body.data).toBe(`${unpadded.body.data}==`)

    expect(await textOf(textPart(text))).toBe(text)
    expect(await textOf(unpadded)).toBe(text)
  })

  it('is cut off after the first 150,000 bytes of a body', async () => {
    const within = `${'x'.repeat(149_000)}\n${ALERT}`
    const beyond = `${'x'.repeat(150_000)}\n${ALERT}`

    expect(await textOf(textPart(within))).toBe(within)
    expect(await textOf(textPart(beyond))).toBe('x'.repeat(150_000))
    expect(await textOf(htmlPart(`<p>${'x'.repeat(150_000)}</p><p>${ALERT}</p>`))).toBe('x'.repeat(149_997))
  })
})

describe('an HTML-only message', () => {
  it('is reduced to the text a reader would see', async () => {
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style type="text/css">
      p { color: #333 }
      td > b { font-weight: bold }
    </style>
    <script>document.title = '<p>Not text</p>'</script>
  </head>
  <body>
    <div class="banner"><img src="https://examplebank.test/logo.png" alt=""></div>
    <p>Dear customer,</p>
    <p>A transaction of <b>SGD&nbsp;12.40</b>   was made with your
       Example Bank card ending 1234 at COFFEE &amp; CAKE PLACE.</p>
    <table>
      <tr><td>Card ending <b>1234</b></td></tr>
      <TR><TD>Amount: SGD 12.40</TD></TR >
    </table>
    <ul><li>Was this not you?</li><li>Call us.</li></ul>
    Line one<br>line two<BR />line three<br clear="all">
    <div>Thank you for banking with us.</div>
  </body>
</html>`

    const text = await textOf(htmlPart(html))

    expect(text.split('\n').filter((line) => line !== '')).toEqual([
      'Dear customer,',
      'A transaction of SGD 12.40 was made with your',
      'Example Bank card ending 1234 at COFFEE & CAKE PLACE.',
      'Card ending 1234',
      'Amount: SGD 12.40',
      'Was this not you?',
      'Call us.',
      'Line one',
      'line two',
      'line three',
      'Thank you for banking with us.',
    ])
  })

  it('keeps an alert on a line of its own, with no space at either end', async () => {
    const html = `<html><body>\r\n\t<div>\r\n\t\t<p>   ${ALERT}\xa0 </p>\r\n\t</div>\r\n</body></html>`

    expect(await textOf(htmlPart(html))).toBe(ALERT)
  })

  it('decodes an entity once, after the tags have gone', async () => {
    const html = '<p>Use &lt;b&gt; &amp;amp; &quot;quotes&quot; &#39;here&#39;, not &copy; or &#169;</p>'

    expect(await textOf(htmlPart(html))).toBe(`Use <b> &amp; "quotes" 'here', not &copy; or &#169;`)
  })

  it('drops a style or script block that is never closed, with everything after it', async () => {
    expect(await textOf(htmlPart('<p>Before</p><style>p { color: red }<p>After</p>'))).toBe('Before')
    expect(await textOf(htmlPart('<p>Before</p><SCRIPT>alert(1)</style><p>After</p>'))).toBe('Before')
  })

  it('is reduced quickly however long and hostile it is', async () => {
    const hostile = [
      '<'.repeat(300_000),
      '<style>'.repeat(40_000),
      '<style'.repeat(50_000),
      `<style>${'</style '.repeat(40_000)}`,
      `<script>${'</script'.repeat(40_000)}`,
      `<style ${'x'.repeat(300_000)}`,
      '<br'.repeat(100_000),
      `</p${' '.repeat(300_000)}`,
      '</div '.repeat(50_000),
      '<a '.repeat(100_000),
      '<!--'.repeat(75_000),
      '&amp'.repeat(75_000),
      '&'.repeat(300_000),
      ' '.repeat(300_000),
      ' \n'.repeat(150_000),
      '\xa0\t\r'.repeat(100_000),
    ]
    const messages = hostile.map((html) => gmailMessage({ content: htmlPart(html) }))

    const started = performance.now()
    for (const message of messages) (await read(message)).text()

    // Measured at about 40 ms. One pattern that backtracked over a body would take seconds.
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('the domain a message is authentic for', () => {
  const PASS = gmailResults('pass', 'examplebank.test')
  const FAIL = gmailResults('fail', 'examplebank.test')

  it('is the header.from of the DMARC pass that Gmail recorded', async () => {
    expect(await authenticated(PASS)).toBe('examplebank.test')
    expect(await authenticated(gmailResults('pass', 'Mail.ExampleBank.TEST'))).toBe('mail.examplebank.test')
  })

  it('is none when DMARC did not pass', async () => {
    expect(await authenticated(FAIL)).toBeNull()
    expect(await authenticated('mx.google.com; spf=pass smtp.mailfrom=bounce@examplebank.test')).toBeNull()
    expect(await authenticated('mx.google.com; dmarc=passed header.from=examplebank.test')).toBeNull()
    expect(await authenticated('mx.google.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE)')).toBeNull()
  })

  it('is none when the message has no Authentication-Results header', async () => {
    expect(await authenticated()).toBeNull()
  })

  it("is what Gmail's own header says, whatever a header that the sender added below it says", async () => {
    expect(await authenticated(FAIL, PASS)).toBeNull()
    expect(await authenticated(PASS, FAIL)).toBe('examplebank.test')
  })

  it("is not taken from another server's header, wherever it is", async () => {
    const elsewhere = 'mail.attacker.test; dmarc=pass header.from=examplebank.test'
    const lookalike = 'mx.google.com.attacker.test; dmarc=pass header.from=examplebank.test'

    expect(await authenticated(elsewhere)).toBeNull()
    expect(await authenticated(lookalike)).toBeNull()
    expect(await authenticated(elsewhere, lookalike, FAIL)).toBeNull()
    expect(await authenticated(elsewhere, PASS)).toBe('examplebank.test')
  })

  it('is not taken from an ARC header', async () => {
    const message = gmailMessage({ results: [FAIL] })
    message.payload.headers.unshift({ name: 'ARC-Authentication-Results', value: `i=1; ${PASS}` })

    expect((await read(message)).authenticatedDomain).toBeNull()
  })

  it('is none when "dmarc=pass" is only something another result quotes', async () => {
    // The sender chose the address it sent from, and Gmail quotes it.
    const quotedAddress = [
      'mx.google.com',
      'spf=pass (google.com: domain of dmarc=pass@attacker.test designates 192.0.2.1 as permitted sender) ' +
        'smtp.mailfrom=dmarc=pass@attacker.test',
      'dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=examplebank.test',
    ].join('; ')
    // What an earlier server made of the message, as Gmail quotes it.
    const quotedChain = [
      'mx.google.com',
      'arc=pass (i=1 spf=pass spfdomain=attacker.test dkim=pass dkdomain=attacker.test dmarc=pass ' +
        'fromdomain=attacker.test)',
      'dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=examplebank.test',
    ].join('; ')

    expect(await authenticated(quotedAddress)).toBeNull()
    expect(await authenticated(quotedChain)).toBeNull()
  })

  it('is none when the header holds more than one DMARC result', async () => {
    const two = 'mx.google.com; dmarc=pass header.from=examplebank.test; dmarc=fail header.from=examplebank.test'

    expect(await authenticated(two)).toBeNull()
  })
})
