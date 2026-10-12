import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { runCheck } from '../src/checker'
import { parseAlert } from '../src/parsers'
import { hsbc } from '../src/parsers/hsbc'
import { storeFor } from '../src/store'
import { clock, connectedChat, deps, outside } from './connect-helpers'
import { gmailMessage, gmailResults, htmlPart } from './gmail-helpers'
import { alertEmail, seconds } from './helpers'

/** The address that HSBC sends its card alerts from. A bank's address is public. */
const SENDER = 'hsbc.bank.singapore.limited@notification.hsbc.com.hk'

/** When the alert below says its purchase was made: 20:01:02 on 9 October 2026 in Singapore. */
const STATED = seconds('2026-10-09T12:01:02Z')
/** When the email of the alert came, which is two seconds later. */
const RECEIVED = seconds('2026-10-09T20:01:04+08:00')
const DAY = 86_400

/** The purchase that the alert below tells of. */
const PURCHASE = {
  cardLast4: '1234',
  amountMinor: 1234,
  currency: 'SGD',
  merchant: 'SOME MERCHANT PTE. LTD.',
  occurredAt: STATED,
}

/** What the bank says before the table of an alert, which is what makes the email a purchase. */
const SENTENCE = 'there was a transaction made on your HSBC credit card'

/** What the bank puts after the table of an alert. */
const ADVICE = 'You can also log on to the HSBC Singapore app to view your recent transactions.'

interface Cells {
  last4?: string
  date?: string
  time?: string
  amount?: string
  merchant?: string
}

/**
 * The table of an HSBC card alert, as the text of its email has it: what a thing is called on one line, and the
 * thing on a line under it. `beside` is what parts the two, and `below` what parts a row from the next. Left as they
 * are, they are the four line ends and the seven that the text made of the bank's HTML has there: the last test here
 * starts from that HTML.
 */
function table(cells: Cells = {}, beside = '\n'.repeat(4), below = '\n'.repeat(7)): string {
  const { last4 = '1234', date = '09/OCT/2026', time = '20:01:02', amount = 'SGD12.34' } = cells
  const rows = [
    ['Card Number', `XXXX-XXXX-XXXX-${last4}`],
    ['Transaction Date', date],
    ['Transaction Time', time],
    ['Transaction Amount', amount],
    ['Description', cells.merchant ?? PURCHASE.merchant],
  ]
  return rows.map((row) => row.join(beside)).join(below)
}

/**
 * An alert as it reads: the table, with the bank's greeting above it and its advice below. The line that it ends
 * with is made up.
 */
function alertBody(rows = table()): string {
  return [
    `Dear Customer\n\n\nPlease note ${SENTENCE}.`,
    rows,
    ADVICE,
    'This email was sent by a system that takes no replies.',
  ].join('\n'.repeat(13))
}

function hsbcEmail(text = alertBody(), receivedAt = RECEIVED) {
  return alertEmail({ from: SENDER, receivedAt, text })
}

const parse = (text: string) => parseAlert(hsbcEmail(text))

/** The style that the bank gives every cell of the table. */
const CELL = 'font-family: arial,sans-serif;font-size: 12px;line-height:300%;padding-left: 10px;'

/**
 * The alert of PURCHASE as the bank sends it: HTML, and nothing else. It is of the shape of a real one, line for
 * line, with every value made up and the addresses of its images too.
 */
const HTML = `<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title></title>
<style type="text/css">

table {
border-collapse: collapse;
table-layout: fixed;
}
</style>
<!-- -->
</head>
<body>
<center>
<table style="width:640px;font-family:arial,helvetica,sans-serif; font-size:14px;" border="0">
<tbody>
<tr>
<td><img id="colorDiv" src="https://images.examplebank.test/logo.jpg"></td>
</tr>
<tr>
<td>
<p>Dear Customer <br><br>
Please note there was a transaction made on your HSBC credit card. <br><br></p>
</td>
</tr>
<tr>
<td>
<table width="100%" cellspacing="0" border="1">
<tbody>
<tr>
<td width="50%">
<p style="${CELL}">Card Number</p>
</td>
<td width="50%">
<p style="${CELL}">XXXX-XXXX-XXXX-1234</p>
</td>
</tr>
<tr>
<td width="50%">
<p style="${CELL}">Transaction Date</p>
</td>
<td width="50%">
<p style="${CELL}">09/OCT/2026</p>
</td>
</tr>
<tr>
<td width="50%">
<p style="${CELL}">Transaction Time</p>
</td>
<td width="50%">
<p style="${CELL}">20:01:02</p>
</td>
</tr>
<tr>
<td width="50%">
<p style="${CELL}">Transaction Amount</p>
</td>
<td width="50%">
<p style="${CELL}">SGD12.34</p>
</td>
</tr>
<tr>
<td width="50%">
<p style="${CELL}">Description</p>
</td>
<td width="50%">
<p style="${CELL}">SOME MERCHANT PTE. LTD.</p>
</td>
</tr>
</tbody>
</table>
</td>
</tr>
<tr>
<td>
<p><br>
${ADVICE}<br><br><img src="http://images.examplebank.test/a.jpg"><br><br><img src="http://images.examplebank.test/b.png" style="width:580px;"><br><br><img src="http://images.examplebank.test/c.jpg"></p>
</td>
</tr>
</tbody>
</table>
</center>

<img src="https://track.examplebank.test/made-up" WIDTH="1" HEIGHT="1" alt="" />

<DIV>
<p></p><hr size="1"><p></p><BR>
<p><strong><BR>
*******************************************************************<BR>
This email was sent by a system that takes no replies.<BR>
*******************************************************************<br><BR>
</strong></p><BR>
</DIV></body>
</html>
`

describe('HSBC card alerts', () => {
  it('reads a purchase, to the second, from the table between the greeting and the advice', () => {
    expect(parse(alertBody())).toEqual({ ...PURCHASE, parser: 'hsbc' })
  })

  it.each([
    ['SGD1234.56', 'SGD', 123456],
    ['SGD1,234.56', 'SGD', 123456],
    ['SGD0.05', 'SGD', 5],
    ['USD8.00', 'USD', 800],
  ])('reads %s as %s and %i hundredths', (amount, currency, amountMinor) => {
    expect(parse(alertBody(table({ amount })))).toMatchObject({ currency, amountMinor })
  })

  it.each(['SOME MERCHANT PTE. LTD.', 'PAYPAL *SOMESHOP', 'Shop.com', 'COFFEE PLACE'])(
    'reads the merchant %s whole, and nothing of what comes after the table',
    (merchant) => {
      expect(parse(alertBody(table({ merchant })))?.merchant).toBe(merchant)
    },
  )

  it('ends the merchant where its line ends, whatever the bank puts after the table', () => {
    const reworded = alertBody().replace(ADVICE, 'Thank you for banking with us.')

    expect(parse(reworded)).toEqual({ ...PURCHASE, parser: 'hsbc' })
  })

  it('keeps no more than 80 characters of the merchant', () => {
    const merchantOf = (merchant: string) => parse(alertBody(table({ merchant })))?.merchant

    expect(merchantOf('M'.repeat(200))).toBe('M'.repeat(80))
    // The space that the cut would leave at the end is dropped too.
    expect(merchantOf(`${'M'.repeat(79)} AND MORE`)).toBe('M'.repeat(79))
  })

  it('keeps a purchase whose Description is empty, with no merchant', () => {
    const empty = table({ merchant: '' })

    // The next line that holds anything is the advice, which is no name.
    expect(parse(alertBody(empty))).toEqual({ ...PURCHASE, merchant: null, parser: 'hsbc' })
    // And when the text ends with the table, no line is.
    expect(parse(alertBody(empty).split(ADVICE)[0])).toEqual({ ...PURCHASE, merchant: null, parser: 'hsbc' })
  })

  it.each<[how: string, text: string]>([
    ['with a carriage return before each line end', alertBody().replaceAll('\n', '\r\n')],
    ['with no empty lines', alertBody().replaceAll(/\n+/g, '\n')],
    ['with each cell on the line of what it is called', alertBody(table({}, '   ', '\n'))],
    ['with tabs and no-break spaces among its spaces', alertBody().replaceAll(' ', ' \t\xa0 ')],
    ['with blanks at both ends of its lines', alertBody().replaceAll('\n', ' \n\t')],
    ['with its sentence wrapped across lines', alertBody().replace('made on your', 'made\non your')],
    ['with no line ends at all', alertBody().replaceAll(/\n+/g, ' ')],
  ])('reads an alert that comes %s', (_, text) => {
    expect(parse(text)).toEqual({ ...PURCHASE, parser: 'hsbc' })
  })

  it.each([
    ['two days after', 2 * DAY],
    ['two days before', -2 * DAY],
  ])('goes by the time that the alert states when the email came %s it', (_, later) => {
    expect(parseAlert(hsbcEmail(alertBody(), STATED + later))?.occurredAt).toBe(STATED)
  })

  it.each([
    ['a second more than two days after it', STATED + 2 * DAY + 1],
    ['a second more than two days before it', STATED - 2 * DAY - 1],
  ])('dates the purchase by the email when it came %s', (_, receivedAt) => {
    expect(parseAlert(hsbcEmail(alertBody(), receivedAt))?.occurredAt).toBe(receivedAt)
  })

  it.each<[what: string, cells: Cells]>([
    ['a day that its month does not have', { date: '31/FEB/2026' }],
    ['a month it does not know', { date: '09/OKT/2026' }],
    ['a second that a minute does not have', { time: '20:01:60' }],
  ])('dates the purchase by the email when the alert states %s', (_, cells) => {
    expect(parse(alertBody(table(cells)))).toEqual({ ...PURCHASE, occurredAt: RECEIVED, parser: 'hsbc' })
  })

  it.each([
    ['only the greeting and the advice', alertBody('')],
    // The bank's sentence is what makes the table a purchase. The other sentence here is made up.
    ['the table under another sentence', alertBody().replace('transaction made', 'transaction declined')],
    ['the table with the sentence after it', `${table()}\n\n${ADVICE}\n\nPlease note ${SENTENCE}.`],
    ['a table with no amount', alertBody(table().replace('SGD12.34', ''))],
    ['a table that is cut short', alertBody().split('Description')[0]],
    ['no text', ''],
  ])('returns null for %s', (_, text) => {
    expect(parse(text)).toBeNull()
  })

  it('returns quickly on very long hostile strings', () => {
    // A table that matches up to the last cell before the merchant's is the most work one attempt can cost.
    const nearMiss = table({ amount: 'SGD999,999,999,999.99' }, '\n', '\n').split('\nDescription')[0]
    // Each string is some 200,000 characters: more than is ever decoded of an email's body.
    const hostile = [
      `${nearMiss}\n`.repeat(1_600),
      `${nearMiss} `.replaceAll('\n', ' ').repeat(1_600),
      `${nearMiss.split('SGD')[0]}SGD${'999,'.repeat(50_000)}`,
      'Card Number\n'.repeat(17_000),
      'Card Number X'.repeat(15_000),
      'SGD'.repeat(70_000),
      '1,'.repeat(100_000),
      'a '.repeat(100_000),
      'a\n'.repeat(100_000),
      '\r\n'.repeat(100_000),
      ' \xa0\t'.repeat(70_000),
      // A table that does match, under words that never come to the bank's sentence: it is looked for in all of them.
      `${`${SENTENCE.slice(0, -1)} `.repeat(3_500)}\n${table()}`,
    ]
    // After a table that does match, the merchant is looked for in what follows it.
    const unended = alertBody().split(ADVICE)[0].trimEnd()
    const afterTable = [
      `${unended}${' x'.repeat(100_000)}`,
      `${unended}${'\nx'.repeat(100_000)}`,
      `${unended} ${`${ADVICE} `.repeat(2_500)}`,
    ]

    const started = performance.now()
    for (const text of hostile) {
      expect(parse(text)).toBeNull()
      // The parser on its own, without the cap on length that parseAlert applies.
      expect(hsbc.parse(hsbcEmail(text))).toBeNull()
    }
    for (const text of afterTable) {
      expect(parse(text)).toMatchObject({ amountMinor: 1234 })
      expect(hsbc.parse(hsbcEmail(text))).toMatchObject({ amountMinor: 1234 })
    }

    // Measured at about 60 ms. The bound is for a pattern that never ends, and is set well above a slow machine.
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('is read from the HTML that the bank sends, when a check comes upon it in a mailbox', async () => {
    const mailbox = 'jane@example.test'
    const chat = await connectedChat(mailbox)
    // A minute after the email came.
    clock.now = new Date((RECEIVED + 60) * 1000)
    outside.mailboxes[mailbox] = [
      gmailMessage({
        from: '"HSBC Singapore" <HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk>',
        receivedAt: RECEIVED,
        // What Gmail records of an HSBC alert: the address is under notification.hsbc.com.hk, and the DMARC result
        // names the domain that the policy is for.
        results: [gmailResults('pass', 'hsbc.com.hk')],
        // The one part of the message, so the text that the parser is given is what is made of the HTML.
        content: htmlPart(HTML),
      }),
    ]

    await runCheck(deps)

    const store = storeFor(env.DB, await chat.userId())
    expect(await store.listTransactions(null, 0, 4_000_000_000, 10)).toMatchObject([{ ...PURCHASE, parser: 'hsbc' }])
  })
})
