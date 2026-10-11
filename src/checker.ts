// The scheduled check of connected mailboxes for new bank alerts.
//
// On the free plan a run has about 10 ms of CPU time, 50 requests and 50
// database queries. So a run checks one mailbox, the one that has waited
// longest, and reads one alert from it at most. Whatever is left is read by
// the runs that follow.

import { productOf } from './catalogue'
import { revokeStored } from './connect'
import type { Deps } from './deps'
import { cardTotals } from './domain/totals'
import { decryptToken } from './google/crypto'
import {
  getMessage,
  getMessageHeaders,
  GrantLostError,
  listMessageIds,
  PageTokenError,
  refreshAccessToken,
  type MessageHeaders,
} from './google/gmail'
import { ingestAlert } from './ingest'
import { log, logFailure, type Events } from './log'
import { alertSenders } from './parsers'
import { storeFor, type Card, type Transaction } from './store'
import { mailStoreFor, removeExpiredAttempts, takeNextMailbox, type Mailbox } from './store-mail'
import { ChatBlockedError, type MessageEntity } from './telegram/api'
import { describeTotals, formatMoney, maskLast4 } from './telegram/format'
import { ADD_CARD_USAGE } from './telegram/handler'
import { sortEnd } from './telegram/purchases'

/**
 * How many alerts one run reads: the messages it fetches whole. A run that read three took 14 ms of CPU time, which
 * is more than a run has, so it reads one.
 */
export const MESSAGES_PER_RUN = 1

/**
 * How many messages one run fetches the headers of. The headers tell whether a message is a bank's alert at all,
 * and cost little beside a whole message. So a run can turn away more of the mail that only looks like an alert
 * than it could read.
 */
export const HEADER_CHECKS_PER_RUN = 10

/** How many pages of a listing one run asks for, looking for alerts it does not know. */
const PAGES_PER_RUN = 5

/** How many expired sign-ins one run clears away. */
const ATTEMPTS_PER_RUN = 5

/** How far back a newly connected mailbox is read. No card's current window began longer ago. */
const CATCH_UP_DAYS = 35

/**
 * An alert is a few kilobytes. A message is parsed whole before anything of it is looked at, and one of several
 * megabytes could take all the CPU time of every run that came upon it. So Gmail is asked for none that large.
 */
const MAX_MESSAGE_SIZE = '1M'

/**
 * A purchase whose alert came longer ago than this is stored without a message, so that catching up on history does
 * not flood the chat. It is the time the email came that counts, and not the time of the purchase: an alert can
 * state a day and no time, and its purchase is then dated at noon of that day, which is hours before an alert that
 * comes in the evening, or after midnight.
 */
const NEWS_HOURS = 6

const HOUR = 3600
const DAY = 24 * HOUR

/** The alerts that a run found to read, on one page of a listing. */
interface Unread {
  /** The ids on the page that are not known yet, in the order Gmail lists them. */
  unknown: string[]
  /** Whether the listing ends with the page. */
  last: boolean
}

/**
 * What a run has done so far, which is what its line in the log says when it ends, and the stage that it is at,
 * which is where it failed when it fails. The README says what each count is of.
 */
type Run = Omit<Events['check'], 'ms'> & Pick<Events['check_failed'], 'stage'>

/** One scheduled run. It does not throw: a failure is logged, and a later run tries again. */
export async function runCheck(deps: Deps): Promise<void> {
  const began = deps.now().getTime()
  const run: Run = {
    stage: 'sweep',
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
  }
  try {
    const now = Math.floor(began / 1000)
    // A sign-in is deleted when its user comes back to it. These are the ones that nobody came back to.
    const abandoned = await removeExpiredAttempts(deps.db, now, ATTEMPTS_PER_RUN)
    run.swept = abandoned.length
    for (const held of abandoned) await revokeStored(deps, held)

    run.stage = 'take'
    const mailbox = await takeNextMailbox(deps.db, now)
    if (mailbox) await checkMailbox(deps, mailbox, now, run)
  } catch (error) {
    // Nothing of the error's message is logged: it could quote what Google sent.
    logFailure('check_failed', error, { stage: run.stage, user: run.user })
  }
  // The run's own line, which a run that failed has too: it says what the run had done by then.
  const { stage, ...done } = run
  log('check', { ...done, ms: deps.now().getTime() - began })
}

async function checkMailbox(deps: Deps, mailbox: Mailbox, now: number, run: Run): Promise<void> {
  const mail = mailStoreFor(deps.db, mailbox.ownerId)
  run.mailbox = true
  run.user = mailbox.ownerId
  run.stage = 'token'
  const accessToken = await accessTokenFor(deps, mailbox, run)
  if (!accessToken) return

  // A new connection is read from 35 days before it was made, and a checked one from a day before its last full
  // check. The day of overlap is for mail that Gmail dates before the last check but only listed after it. Neither
  // time moves until the next full check, so every run until then makes the same search, and the token of a page
  // that one run was given is good in the next.
  const { connectedAt, lastCheckedAt } = mailbox
  const since = lastCheckedAt === null ? connectedAt - CATCH_UP_DAYS * DAY : lastCheckedAt - DAY
  const query = `from:(${alertSenders().join(' OR ')}) after:${since} smaller:${MAX_MESSAGE_SIZE}`

  run.stage = 'list'
  const { unknown, last } = await findUnread(deps, mailbox, accessToken, query, run)
  run.unknown = unknown.length

  let left = unknown.length
  for (const id of unknown.slice(0, HEADER_CHECKS_PER_RUN)) {
    if (run.read === MESSAGES_PER_RUN) break
    await readAlert(deps, mailbox, accessToken, id, now, run)
    left--
  }

  // Nothing is left when the listing ended with that page, and all that was unknown on it has now been looked at.
  if (last && left === 0) {
    run.stage = 'store'
    await mail.markChecked(now)
    run.checked = true
  }
}

/** An access token for the mailbox. Null, with its user told, when Google has ended the access. */
async function accessTokenFor(deps: Deps, mailbox: Mailbox, run: Run): Promise<string | null> {
  try {
    return await refreshAccessToken(deps.google, await decryptToken(deps.tokenKey, mailbox.refreshTokenEnc))
  } catch (error) {
    if (!(error instanceof GrantLostError)) throw error
    await tellOfLostAccess(deps, mailbox, run)
    return null
  }
}

/**
 * Tells the user that Google has ended the access, and then marks the connection as needing to be reconnected. In
 * that order: a marked connection has no more turns, so were it marked first and the message then failed, its user
 * would never be told. This way a message that fails is sent again on the mailbox's next turn.
 */
async function tellOfLostAccess(deps: Deps, mailbox: Mailbox, run: Run): Promise<void> {
  run.stage = 'notify'
  let told = false
  try {
    await deps.messenger.send(
      mailbox.chatId,
      `Spend Tracker has lost its access to your Gmail ${mailbox.email}, and has stopped reading your ` +
        'bank alerts. This happens when you change your Google password, or remove the access in your Google ' +
        'Account. Send /connect to reconnect it.',
    )
    told = true
  } catch (error) {
    // No turn would get the message to a user who has blocked the bot, so their connection is marked all the same.
    if (!(error instanceof ChatBlockedError)) throw error
  } finally {
    // Logged however the telling went. When it failed, the run fails with it, and the next turn finds the same.
    log('access_lost', { user: mailbox.ownerId, told })
  }
  run.stage = 'store'
  await mailStoreFor(deps.db, mailbox.ownerId).markNeedsReconnect()
}

/**
 * Finds the alerts to read next: those on the first page of the listing that holds any that are not known yet. It
 * finds none when the listing ends before such a page, and none when the run is out of pages before it.
 *
 * Every run begins with the first page, which is where new mail is listed. A run that knows all of that page goes
 * on through the older ones. It does not go through them from the second page every time: a mailbox can hold more
 * known alerts than a run has pages for, ahead of alerts that are still to be read. So the connection keeps the
 * token of the page that the runs have got to, and each run goes on from there.
 */
async function findUnread(deps: Deps, mailbox: Mailbox, accessToken: string, query: string, run: Run): Promise<Unread> {
  const mail = mailStoreFor(deps.db, mailbox.ownerId)
  let listed = await listMessageIds(accessToken, query)
  run.listed += listed.ids.length
  let unknown = await mail.unknownIds(listed.ids)
  if (unknown.length > 0 || !listed.nextPageToken) return { unknown, last: !listed.nextPageToken }

  let pageToken = mailbox.backlogPageToken ?? listed.nextPageToken
  try {
    for (let page = 2; page <= PAGES_PER_RUN; page++) {
      listed = await listMessageIds(accessToken, query, pageToken)
      run.listed += listed.ids.length
      unknown = await mail.unknownIds(listed.ids)
      if (unknown.length > 0 || !listed.nextPageToken) break
      pageToken = listed.nextPageToken
    }
  } catch (error) {
    // Gmail does not take the token that was kept. With none kept, the next run starts again from the first page.
    if (error instanceof PageTokenError) await mail.setBacklogPageToken(null)
    throw error
  }

  // The token now leads to the page that holds unknown alerts or, with the run out of pages, to the first page that
  // it did not get to. Either way, that is the page for the next run to go on from. When the listing has ended
  // with nothing unknown instead, the mailbox is about to be marked as checked, and that clears the token.
  const ended = unknown.length === 0 && !listed.nextPageToken
  if (!ended && pageToken !== mailbox.backlogPageToken) await mail.setBacklogPageToken(pageToken)
  return { unknown, last: !listed.nextPageToken }
}

/**
 * Looks at one message and, when it is a bank's alert, reads it: stores the purchase in it, or notes why none was
 * stored. What it does is counted in `run`: a message that it fetches whole is one that the run has read.
 */
async function readAlert(
  deps: Deps,
  mailbox: Mailbox,
  accessToken: string,
  id: string,
  now: number,
  run: Run,
): Promise<void> {
  const mail = mailStoreFor(deps.db, mailbox.ownerId)
  /** Notes the message as one that is not believed to be from a bank, so that it is not fetched again. */
  const reject = async () => {
    run.stage = 'store'
    await mail.markSeen(id, 'rejected')
    run.rejected++
  }

  run.stage = 'read'
  // Decided on the headers, which are fetched by themselves: mail from anyone else is never fetched whole.
  const headers = await getMessageHeaders(accessToken, id)
  run.headers++
  if (!isFromBank(headers)) return reject()

  const message = await getMessage(accessToken, id)
  run.read++
  // And decided again on the headers that came with the text, as it is this copy of the message that is read.
  if (!isFromBank(message)) return reject()

  run.stage = 'store'
  const { from, subject, receivedAt } = message
  const store = storeFor(deps.db, mailbox.ownerId)
  const result = await ingestAlert(store, { sourceId: id, from, subject, receivedAt, text: message.text() })
  if (result.status === 'unparsed') {
    await mail.markSeen(id, 'unparsed')
    run.unparsed++
  }
  if (result.status === 'stored') {
    run.stored++
    if (now - receivedAt < NEWS_HOURS * HOUR) {
      run.stage = 'notify'
      await tellOfPurchase(deps, mailbox, result.transaction, result.card)
      run.notified++
    }
  }
}

/**
 * Anyone can write a bank's address on the From line of an email. It is only
 * believed when Gmail authenticated the sender for the domain of that address,
 * or for a domain that the address's own is under: Gmail names the domain that
 * the sender's DMARC policy is for, which for noreply@notify.ocbc.com is
 * ocbc.com. A name with no dot in it is not taken for one, or it would cover
 * every address under a top-level name. And it has to be an address that a
 * bank sends alerts from, whatever else the search turned up.
 */
function isFromBank({ from, authenticatedDomain }: MessageHeaders): boolean {
  if (authenticatedDomain === null || !authenticatedDomain.includes('.')) return false
  const domain = from.slice(from.lastIndexOf('@') + 1)
  const authentic = domain === authenticatedDomain || domain.endsWith(`.${authenticatedDomain}`)
  return authentic && alertSenders().includes(from)
}

/**
 * Tells the user of a purchase that has just been stored, and of where it leaves the card it was made with. `card`
 * is that card, when the user has added it.
 */
async function tellOfPurchase(
  deps: Deps,
  mailbox: Mailbox,
  purchase: Transaction,
  card: Card | undefined,
): Promise<void> {
  const { cardLast4, amountMinor, currency, merchant } = purchase
  const store = storeFor(deps.db, mailbox.ownerId)
  const amount = `${card?.nickname ?? 'Card'} ${maskLast4(cardLast4)}: ${formatMoney(amountMinor, currency)}`
  const spent = merchant ? `${amount} at ${merchant}` : amount
  // The merchant's name comes from an email. The bot sends plain text, so nothing in a name is taken for markup.
  // But Telegram makes a command or a link of whatever looks like one in a message, and a name can be made to
  // look like either. So the name, which is the end of that line, is marked as code, where nothing can be tapped.
  const marked: MessageEntity[] | undefined = merchant
    ? [{ type: 'code', offset: spent.length - merchant.length, length: merchant.length }]
    : undefined

  if (!card) {
    const usage = ADD_CARD_USAGE.replaceAll('<last4>', cardLast4)
    const text = `${spent}\nThis card is not added yet. Add it with:\n${usage}`
    return deps.messenger.send(mailbox.chatId, text, marked)
  }
  const [totals] = await cardTotals(store, [card], deps.now(), mailbox.timezone)
  const text = `${spent}\nRunning total: ${describeTotals(totals, mailbox.timezone)}`
  const product = productOf(card.product)
  if (!product) return deps.messenger.send(mailbox.chatId, text, marked)
  // On a card with a product, the message ends with where the purchase is sorted, and has the buttons that move it.
  const { line, buttons } = sortEnd(product, purchase)
  return deps.messenger.send(mailbox.chatId, `${text}\n${line}`, marked, buttons)
}
