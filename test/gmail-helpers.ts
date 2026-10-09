import { alertText, seconds } from './helpers'

// Messages as Gmail's API returns them, for the tests of reading mail. Like
// everything else in the tests, they are made up.

/** A part of a message: a body, or a container of other parts. */
export interface Part {
  mimeType: string
  body: { size: number; data?: string }
  parts?: Part[]
}

export type Message = ReturnType<typeof gmailMessage>

/** A body as Gmail gives it: the size in bytes, and the bytes in base64url. */
function body(text: string) {
  const bytes = new TextEncoder().encode(text)
  return { size: bytes.length, data: bytes.toBase64({ alphabet: 'base64url' }) }
}

export function textPart(text: string): Part {
  return { mimeType: 'text/plain', body: body(text) }
}

export function htmlPart(html: string): Part {
  return { mimeType: 'text/html', body: body(html) }
}

export function multipart(subtype: 'alternative' | 'mixed' | 'related', ...parts: Part[]): Part {
  return { mimeType: `multipart/${subtype}`, body: { size: 0 }, parts }
}

/** The header that Gmail adds to a message to say what it made of the sender, for a sender in `domain`. */
export function gmailResults(dmarc: 'pass' | 'fail', domain: string): string {
  return [
    'mx.google.com',
    `dkim=pass header.i=@${domain} header.s=made-up header.b=AbCdEfGh`,
    `spf=pass (google.com: domain of bounce@${domain} designates 192.0.2.1 as permitted sender) ` +
      `smtp.mailfrom=bounce@${domain}`,
    `dmarc=${dmarc} (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`,
  ].join(';\r\n       ')
}

export interface MessageOptions {
  id?: string
  from?: string
  subject?: string
  /** Unix seconds. */
  receivedAt?: number
  /** The values of the message's Authentication-Results headers, from the top down. */
  results?: string[]
  content?: Part
}

/**
 * A message as `GET .../messages/{id}?format=full` returns it. Left as it is,
 * it is an alert that Gmail found to be from the invented Example Bank.
 */
export function gmailMessage(options: MessageOptions = {}) {
  const {
    id = 'msg-1',
    from = 'Example Bank <alerts@examplebank.test>',
    subject = 'Transaction alert',
    receivedAt = seconds('2026-10-09T11:55:00+08:00'),
    results = [gmailResults('pass', 'examplebank.test')],
    content = textPart(alertText('SGD 12.40', '1234')),
  } = options

  return {
    id,
    threadId: id,
    labelIds: ['INBOX'],
    snippet: 'A short part of the message text',
    internalDate: String(receivedAt * 1000),
    sizeEstimate: 4096,
    payload: {
      partId: '',
      filename: '',
      headers: [
        { name: 'Delivered-To', value: 'jane@example.test' },
        { name: 'Received', value: 'by 2001:db8::1 with SMTP id made-up' },
        { name: 'Return-Path', value: '<bounce@examplebank.test>' },
        ...results.map((value) => ({ name: 'Authentication-Results', value })),
        { name: 'From', value: from },
        { name: 'To', value: 'jane@example.test' },
        { name: 'Subject', value: subject },
        { name: 'MIME-Version', value: '1.0' },
      ],
      ...content,
    },
  }
}

/**
 * A message as `GET .../messages/{id}?format=metadata` returns it: with those of its headers that were asked for by
 * name, in the order the message has them, and with nothing of its content.
 */
export function headersOf(message: Message, names: string[]) {
  const asked = names.map((name) => name.toLowerCase())
  const { mimeType, headers } = message.payload
  return {
    ...message,
    payload: { mimeType, headers: headers.filter(({ name }) => asked.includes(name.toLowerCase())) },
  }
}
