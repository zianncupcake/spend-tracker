// The service's few web pages. Each is a complete document with no scripts and
// nothing loaded from anywhere else. Whatever is not fixed text goes through
// escapeHtml on its way in.

/** Who runs the service, as the public pages name them. */
export interface Operator {
  name: string
  contact: string
}

const STYLE = `
:root { color-scheme: light dark }
body { font: 1rem/1.5 system-ui, sans-serif; max-width: 40rem; margin: 0 auto; padding: 2rem 1rem }
.code { font-size: 2.5rem; font-weight: bold; letter-spacing: 0.2em }
`

// The sign-in pages answer URLs that hold a state or a code, and one of them shows a code.
const SIGN_IN_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

const PROBLEMS = {
  expired: { status: 400, title: 'This link has expired', text: 'Send /connect to the bot for a new one.' },
  'not-completed': {
    status: 400,
    title: 'Sign-in was not completed',
    text: 'Nothing was connected. To try again, send /connect to the bot.',
  },
  'no-gmail-access': {
    status: 400,
    title: 'Gmail access was not given',
    text:
      'Google signed you in without the permission to read your email, so nothing was connected. ' +
      'To try again, send /connect to the bot and allow that permission when Google asks.',
  },
  'no-lasting-access': {
    status: 400,
    title: 'Google gave no lasting access',
    text:
      'Nothing was connected. Remove the access this service has in your Google Account, ' +
      'then send /connect to the bot to try again.',
  },
  failed: {
    status: 500,
    title: 'Sign-in could not be completed',
    text: 'Something went wrong, and nothing was connected. To try again, send /connect to the bot.',
  },
}

export function homePage(operator: Operator): Response {
  const name = escapeHtml(operator.name)
  const contact = escapeHtml(operator.contact)
  return page(
    'Spend Tracker',
    `<h1>Spend Tracker</h1>
<p>Spend Tracker is a Telegram bot that keeps a running total of what you spend on each credit card, for the
card's current statement cycle or calendar month.</p>
<p>It learns of a purchase from the transaction alert email that your bank sends you. For that, you connect your
Gmail through Google sign-in, which gives Spend Tracker read-only access. The access is used to learn the address
of the mailbox you connected, and after that only to find alerts from a fixed list of bank senders and to take the
amount, currency, merchant, last four card digits and time from each one. The text of an email is never stored.</p>
<p>From the bot you can disconnect your Gmail, or delete everything stored about you, at any time.</p>
<p><a href="/privacy">Privacy policy</a></p>
<p>Spend Tracker is run by ${name}. Contact: ${contact}</p>`,
  )
}

/**
 * Keep this in step with what the code does: it is a promise to the people who connect their mail. `assistant` is
 * whether the bot has one, which it has when the service is set up with an AI provider. What becomes of a question
 * is said only where a question is answered.
 */
export function privacyPage(operator: Operator, assistant: boolean): Response {
  const name = escapeHtml(operator.name)
  const contact = escapeHtml(operator.contact)
  // What the policy says of the assistant, each where it belongs: what is sent to the AI provider and when, and that
  // provider among those who handle a user's data.
  const questions = `
<h2>Questions that you ask the bot</h2>
<p>A text message that you send the bot is read as a question when it is not a command, and is not the 6-digit
code of a sign-in. To answer it, your question and the card and purchase details needed to answer it are sent to an
AI provider chosen by ${name}, which produces the answer. The details are those that the answering calls for, out
of these: your time zone, the nickname, last four digits, window, totals and number of purchases of each of your
cards and, of your purchases, the id, the time, the last four digits of the card, the amount, the currency, the
merchant and the reward category. Nothing is sent to the AI provider unless you ask a question.</p>
`
  const provider = `
<li>An AI provider chosen by ${name} answers the questions that you ask the bot. It is sent each question and the
card and purchase details needed to answer it, and nothing unless you ask a question.</li>`
  return page(
    'Privacy policy - Spend Tracker',
    `<h1>Privacy policy</h1>
<p>Last updated: 11 October 2026</p>
<p>Spend Tracker is a Telegram bot that keeps a running total of what you spend on each credit card. It is run
by ${name}. For any question about this policy or about your data, contact: ${contact}</p>

<h2>What is accessed</h2>
<p>When you connect your Gmail, Spend Tracker gets read-only access to it through Google sign-in. That access is
used to learn the address of the mailbox you connected, and after that only to find transaction alert emails from
a fixed list of bank senders and to take from each alert the amount, the currency, the merchant, the last four
digits of the card and the time.</p>

<h2>What is stored</h2>
<ul>
<li>Your Telegram user id.</li>
<li>Your time zone, which is Singapore's unless you set another.</li>
<li>The card nicknames, last four digits and window settings that you enter.</li>
<li>The card product that you link a card to.</li>
<li>The details taken from each alert: amount, currency, merchant, last four card digits and time, with the bank
that sent the alert and an id of the alert, so that it is not counted twice.</li>
<li>The purchases that you add by hand: the amount, currency, merchant and date that you give each one, with the
id of the Telegram message that added it, so that it is not counted twice.</li>
<li>The reward category that each purchase is sorted into.</li>
<li>A purchase that you take out, which stays stored and marked as taken out, so that its alert is not counted
again. It is left out of every total and list, and is deleted with everything else.</li>
<li>The id of any alert that was fetched but not recorded, and why it was not, kept so that it is not fetched
again.</li>
<li>Your Gmail address.</li>
<li>An encrypted key that lets the service read your mail until you disconnect.</li>
<li>A hash of your assistant access token, if you create one.</li>
</ul>
<p>The text of an email is never stored.</p>
${assistant ? questions : ''}
<h2>Who else handles your data</h2>
<ul>
<li>Cloudflare hosts the service and its database.</li>
<li>Telegram carries the bot's messages. Those messages contain details of your purchases, and Telegram keeps
them.</li>
<li>Google provides the sign-in.</li>
<li>An AI assistant that you connect with your assistant access token can read your card totals and purchases,
until you remove the token with <code>/mcp revoke</code>.</li>${assistant ? provider : ''}
</ul>
<p>Your data is not sold and is not used for advertising.</p>

<h2>Data from Google</h2>
<p>The use of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.</p>
<p>No person reads your email data unless you explicitly agree, it is needed for security, or the law requires
it. It is not used to train AI models.</p>

<h2>Your control</h2>
<ul>
<li>Send <code>/disconnect</code> to the bot to remove its access to your Gmail. The service then asks Google to
revoke that access too, except when the same mailbox is still connected, or is being connected, from another
chat.</li>
<li>Send <code>/delete confirm</code> to the bot to delete everything stored about you.</li>
</ul>
<p>Deleted data can remain in database backups for up to 30 days.</p>`,
  )
}

/** Shown once Google has redirected back: the code that makes the connection when it is sent to the bot. */
export function codePage(code: string): Response {
  return page(
    'Spend Tracker',
    `<h1>One more step</h1>
<p>To finish connecting your Gmail, send this code to the bot in Telegram:</p>
<p class="code">${escapeHtml(code)}</p>
<p>Send it only in your own chat with the bot. If someone else gave you the link that brought you here, do not
give them this code: with it, your bank alerts would go to them.</p>`,
    200,
    SIGN_IN_HEADERS,
  )
}

/** Shown when a sign-in link or Google's redirect back leads nowhere. */
export function problemPage(problem: keyof typeof PROBLEMS): Response {
  const { status, title, text } = PROBLEMS[problem]
  return page('Spend Tracker', `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(text)}</p>`, status, SIGN_IN_HEADERS)
}

function page(title: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  // The style block is let through by a nonce made for this response, so the policy has no 'unsafe-inline'.
  const nonce = crypto.randomUUID()
  const policy = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ]
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': policy.join('; '),
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })
}

function escapeHtml(text: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return text.replace(/[&<>"']/g, (character) => entities[character])
}
