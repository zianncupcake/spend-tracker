import { answerQuestion } from '../ai/assistant'
import { categoryOf, choicesOf, productOf, products } from '../catalogue'
import type { Product } from '../catalogue/types'
import { ATTEMPT_MINUTES, confirmCode, disconnect, startConnect } from '../connect'
import type { Deps } from '../deps'
import { breakDown, perCurrency } from '../domain/breakdown'
import { sortByRules, startingCategoryOn, WINDOW_LIMIT } from '../domain/sorting'
import { cardTotals, type CardTotals } from '../domain/totals'
import { currentWindow, dayOf, startOfDay } from '../domain/window'
import { issueToken } from '../mcp/tokens'
import { hundredths } from '../parsers/shared'
import {
  deleteUser,
  findOrCreateUser,
  findUser,
  MANUAL,
  MAX_BY_HAND_PER_DAY,
  MAX_CARDS,
  setTimezone,
  storeFor,
  type Card,
  type Store,
  type Transaction,
} from '../store'
import { connectStoreFor, type Connection } from '../store-connect'
import { mailStoreFor, type MailSummary } from '../store-mail'
import { mcpStoreFor } from '../store-mcp'
import {
  TelegramError,
  type MessageEntity,
  type Messenger,
  type Outgoing,
  type RichBlock,
  type RichMessage,
  type RichText,
} from './api'
import { describeTotals, describeWindow, formatShortDate, formatShortDateTime, maskLast4, shortDateIn } from './format'
import {
  BY_HAND_NOTE,
  breakdownLines,
  inMessages,
  MAX_LENGTH,
  purchaseBlocks,
  purchaseLine,
  purchaseTables,
  readPress,
  sectionsOf,
  sortEnd,
  whereSorted,
  type Line,
  type Section,
  type Table,
} from './purchases'

/** The parts of a Telegram update this bot reads. All optional, because it arrives as unchecked JSON. */
export interface Update {
  message?: {
    /** Telegram's id of the message, which no other message in its chat has. A delivery that is repeated has it too. */
    message_id?: number
    text?: string
    chat?: { id?: number; type?: string }
    from?: { id?: number }
  }
  /** The press of a button under one of the bot's messages. */
  callback_query?: Press
}

interface Press {
  id?: string
  from?: { id?: number }
  /** What the button was made to send back. A client can send anything in its place. */
  data?: string
  /** The message that the button is under, as it stands. */
  message?: {
    message_id?: number
    chat?: { id?: number; type?: string }
    text?: string
    entities?: { type?: string; offset?: number; length?: number }[]
  }
}

/** What /add is told of a purchase, after the card that it was made with. */
interface Entry {
  amountMinor: number
  currency: string
  merchant: string
  /** Unix seconds. */
  occurredAt: number
}

/**
 * A reply that is sent as one rich message: one that has tables in it, in which a table is drawn as one, or an
 * answer of the assistant's. Rich messages are new to Telegram, so when it answers this one with an error, the
 * reply is sent as text instead: `asText` makes the messages of that, when they are needed.
 */
interface Tabled {
  rich: RichMessage
  asText: () => Outgoing[]
}

/**
 * What a message is answered with: plain text, or messages with a name marked in them or buttons under them, or a
 * reply that is sent as a rich message.
 */
type Reply = string | Outgoing[] | Tabled

/**
 * A reply that is still to be made: the answer to a question. A model takes seconds over an answer, and Telegram
 * posts an update again when it has waited too long to hear that the update was taken. So an answer is made, and
 * sent, once Telegram has heard that.
 */
type Deferred = () => Promise<Reply>

/**
 * What is left to be done about an update once Telegram has been told that the update was taken: see Deferred.
 * Whoever calls it has its failing to see to.
 */
export type Later = () => Promise<void>

const NICKNAME = /^[A-Za-z0-9_-]{1,20}$/
const LAST4 = /^\d{4}$/
const DAY = /^\d{1,2}$/
const CODE = /^\d{6}$/
const PRODUCT_KEY = /^[A-Za-z0-9-]{1,30}$/
/** A purchase's id as its user gives it: the number that it is shown as, with or without a # before it. */
const PURCHASE_ID = /^#?(\d{1,15})$/
const CURRENCY = /^[A-Za-z]{3}$/
/** An amount as the parsers of the banks' alerts read one, with or without the code of its currency before it. */
const AMOUNT = /^([A-Za-z]{3})?(\d{1,3}(?:,\d\d\d){0,3}|\d{1,12})(\.\d{1,2}|)$/
const ISO_DATE = /^(\d{4})-(\d\d)-(\d\d)$/
/** Day and month, and after them the year or the last two digits of it. */
const SHORT_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d\d|\d{4}))?$/

/** How far back /status counts. */
const STATUS_DAYS = 30

/** The currency of an amount that is given without one, on a card whose product does not say. */
const DEFAULT_CURRENCY = 'SGD'

/** As long as the name that a parser reads from an alert may be. */
const MAX_MERCHANT_LENGTH = 80

/**
 * As long as a question for the assistant may be. A question is in every request that the model is sent over it,
 * and the provider takes only so many tokens in a minute, from all the users of the service together.
 */
const MAX_QUESTION_LENGTH = 500

/** The most blocks that Telegram takes in a rich message: see RichMessage. An answer has one to each of its lines. */
const MAX_PARAGRAPHS = 500

export const ADD_CARD_USAGE = `/addcard <nickname> <last4> statement <day>
/addcard <nickname> <last4> calendar`

const ADD_USAGE = `Usage:
/add <nickname> <amount> <merchant>
/add <nickname> <amount> <date> <merchant>
The amount can have a currency before it, as in USD 12.50. The date is written YYYY-MM-DD.
A day of the card's current window, up to today, can be written D/M or D/M/YY too.
Any other D/M is read as part of the merchant.`

const SORT_USAGE = 'Usage:\n/sort <nickname>\n/sort <purchase id>'

const PRODUCT_USAGE = 'Usage:\n/product <nickname> <product key>\n/product <nickname> none'

const COMMANDS = `Commands:
/addcard <nickname> <last4> statement <day> - track a card by statement cycle; <day> is the day of the month it closes
/addcard <nickname> <last4> calendar - track a card by calendar month
/cards - list your cards
/removecard <nickname> - stop tracking a card
/spend - what you have spent on each card in its current window
/spend <nickname> - every purchase on one card in its current window
/add <nickname> <amount> <merchant> - add a purchase by hand; its date can go before the merchant
/remove <purchase id> - take a purchase out
/products - list the card products whose reward rules are known
/product <nickname> <product key> - link a card to a product, or to none
/sort <nickname> - how a card's purchases are sorted into the reward categories of its product
/sort <purchase id> - move one purchase to another category
/timezone - show the time zone that your cards' windows are counted in
/timezone <name> - change it, for example /timezone Asia/Tokyo
/connect - connect your Gmail, so that your bank's alerts can be read
/status - whether your Gmail is connected, and what has been read from it
/disconnect - disconnect your Gmail
/mcp - let an AI assistant, such as Claude Code, read your card totals and purchases
/mcp revoke - take that access away again
/delete - delete everything stored about you`

const CONNECT_HEADS_UP = `Connecting gives Spend Tracker read-only access to your Gmail. Before you open the link:

1. Google will warn that it has not verified this app. To continue, choose "Advanced", then "Go to ... (unsafe)".
2. If the page says that sign-in is not allowed in this browser, open the link in Safari or Chrome instead.
3. After you approve, the page shows a 6-digit code. Send that code here to finish.

The link works for ${ATTEMPT_MINUTES} minutes:`

const WELCOME =
  'Welcome to Spend Tracker. It keeps a running total of what you spend on each credit card, ' +
  'for the current statement cycle or calendar month. Cycles and months begin and end by Singapore time ' +
  '(Asia/Singapore), unless you set another time zone with /timezone.'

// What the bot says of its assistant, where it has one. Nobody is asked before a question of theirs is sent to the
// AI provider, so the bot says what is sent: in its welcome, and under the list of its commands when the list is
// sent without the welcome.

const ASK =
  'You can also just ask a question in your own words, and it is answered by an AI service, which is sent your ' +
  'question and the card and purchase details needed to answer it.'

const ASK_TOO =
  'Any other message is read as a question, and is answered by an AI service, which is sent your question and the ' +
  'card and purchase details needed to answer it.'

const NO_ASSISTANT =
  'The assistant, which answers questions asked in your own words, is not available on this service. ' +
  'Send /start for the list of commands.'

const QUESTION_TOO_LONG = `A question can be ${MAX_QUESTION_LENGTH} characters at most.`

const NOT_ANSWERED = 'That question could not be answered. Try again later, or ask it another way.'

const NO_CARDS = `You have no cards yet. Add one with:\n${ADD_CARD_USAGE}`

const TOO_MANY_CARDS =
  `You have ${MAX_CARDS} cards, which is as many as can be tracked. To add another, first remove one with ` +
  '/removecard <nickname>.'

const TOO_MANY_BY_HAND =
  `You have added ${MAX_BY_HAND_PER_DAY} purchases by hand in the last 24 hours, which is as many as can be added ` +
  'in that time. Try again later.'

const TIMEZONE_USAGE = '/timezone <IANA name>, for example /timezone Asia/Tokyo'

const NO_SIGN_IN =
  'No sign-in is waiting for a code. It may have expired, or had too many wrong codes. Send /connect to start again.'

/**
 * Answers a text message that a user sent in their private chat with the bot, or their press of a button under one
 * of the bot's messages there. Every other update is ignored.
 *
 * Everything is done by the time this returns but the answering of a question, which is returned to be done once
 * Telegram has been told that the update was taken: see Later.
 */
export async function handleUpdate(deps: Deps, update: Update): Promise<Later | void> {
  if (update.callback_query) return press(deps, update.callback_query)

  const { message_id: messageId, text, chat, from } = update.message ?? {}
  if (chat?.type !== 'private' || typeof chat.id !== 'number') return
  if (typeof from?.id !== 'number' || typeof text !== 'string' || typeof messageId !== 'number') return
  // The user is known by who sent the message, and the reply goes to the chat it was sent in. A user's private
  // chat with the bot has the user's own id, so the two are the same, and an update in which they differ is not
  // one to answer.
  if (from.id !== chat.id) return
  const chatId = chat.id

  const answer = await reply(deps, from.id, messageId, text)
  if (typeof answer !== 'function') return sendReply(deps.messenger, chatId, answer)
  return async () => sendReply(deps.messenger, chatId, await answer())
}

async function sendReply(messenger: Messenger, chatId: number, answer: Reply): Promise<void> {
  const messages: Outgoing[] =
    typeof answer === 'string'
      ? [{ text: answer }]
      : 'rich' in answer
        ? await sendTabled(messenger, chatId, answer)
        : answer
  for (const message of messages) await messenger.send(chatId, message.text, message.entities, message.buttons)
}

/**
 * Sends the rich message of a reply that is sent as one. Returns what is then still to be sent: nothing or, when
 * Telegram answered the rich message with an error, the reply as text.
 */
async function sendTabled(messenger: Messenger, chatId: number, { rich, asText }: Tabled): Promise<Outgoing[]> {
  try {
    await messenger.sendRich(chatId, rich)
    return []
  } catch (error) {
    // A chat that is to be sent nothing would take the text no more than it took this. That error goes on as it is,
    // and so does one that is not an answer of Telegram's at all.
    if (!(error instanceof TelegramError)) throw error
    // Only the status is logged, and nothing of the message, which holds the names of merchants.
    console.error('rich message failed, sent as text:', error.status)
    return asText()
  }
}

/** The reply to a message or, to a question for the assistant, the reply that is still to be made. */
async function reply(deps: Deps, telegramId: number, messageId: number, text: string): Promise<Reply | Deferred> {
  const { db, now } = deps
  const [first = '', ...args] = text.trim().split(/\s+/)
  const command = first.split('@')[0].toLowerCase() // "/spend@SomeBot" is "/spend"
  // A user row is only created by the commands that need one.
  const user = () => findOrCreateUser(db, telegramId)

  switch (command) {
    case '/start':
      await user()
      return `${deps.ai ? `${WELCOME} ${ASK}` : WELCOME}\n\n${COMMANDS}`

    case '/addcard': {
      const card = parseCard(args)
      if (typeof card === 'string') return card
      const { id, timezone } = await user()
      const store = storeFor(db, id)
      if (await store.addCard(card)) {
        // Purchases on the card may have been stored before it was added, and so before it had a product.
        const product = productOf(card.product)
        if (product) await sortByRules(store, card, product, now(), timezone)
        return `Added ${describeCard(card)}.`
      }
      // The store adds no card past the limit and none that the user already has. Which of the two it was is
      // looked up only now that one of them has happened.
      return (await store.listCards()).length < MAX_CARDS
        ? 'You already have a card with that nickname or those last four digits.'
        : TOO_MANY_CARDS
    }

    case '/cards': {
      const cards = await storeFor(db, (await user()).id).listCards()
      if (cards.length === 0) return NO_CARDS
      return cards.map(describeCard).join('\n')
    }

    case '/products':
      return [
        'The card products whose reward rules are known:',
        ...products.map((product) => `${product.key} - ${product.name}`),
        '',
        'To link a card to one, send /product <nickname> <product key>. Or add the key to the end of /addcard.',
      ].join('\n')

    case '/product': {
      const [nickname = '', key = ''] = args
      if (args.length !== 2 || !NICKNAME.test(nickname) || !PRODUCT_KEY.test(key)) return PRODUCT_USAGE
      const product = productOf(key.toLowerCase())
      if (!product && key.toLowerCase() !== 'none') return noSuchProduct(key)
      const { id, timezone } = await user()
      const store = storeFor(db, id)
      const card = (await store.listCards()).find((each) => each.nickname === nickname)
      if (!card) return `You have no card called ${nickname}.`
      await store.setProduct(nickname, product?.key ?? null)
      if (!product) return `${label(card)} is linked to no product now.`
      // The purchases on the card until now were stored with no product to sort them by.
      await sortByRules(store, card, product, now(), timezone)
      return `Linked ${label(card)} to ${product.name}. For how its purchases are sorted, send /sort ${nickname}.`
    }

    case '/removecard': {
      const [nickname = ''] = args
      if (args.length !== 1 || !NICKNAME.test(nickname)) return 'Usage: /removecard <nickname>'
      const removed = await storeFor(db, (await user()).id).removeCard(nickname)
      return removed ? `Removed ${nickname}.` : `You have no card called ${nickname}.`
    }

    case '/spend': {
      const [nickname = ''] = args
      if (args.length > 1 || (args.length === 1 && !NICKNAME.test(nickname))) return 'Usage:\n/spend\n/spend <nickname>'
      const { id, timezone } = await user()
      const store = storeFor(db, id)
      const cards = await store.listCards()
      if (cards.length === 0) return NO_CARDS
      if (args.length === 1) {
        const card = cards.find((each) => each.nickname === nickname)
        return card ? spendDetail(store, card, now(), timezone) : `You have no card called ${nickname}.`
      }
      const totals = await cardTotals(store, cards, now(), timezone)
      const lines = totals.map((each) => spendLine(each, timezone))
      return [...lines, '', 'Totals are estimated from bank alerts.'].join('\n')
    }

    case '/add': {
      const [nickname = '', ...rest] = args
      // After the card, an amount and a merchant at the least.
      if (!NICKNAME.test(nickname) || rest.length < 2) return ADD_USAGE
      const { id, timezone } = await user()
      const store = storeFor(db, id)
      const card = (await store.listCards()).find((each) => each.nickname === nickname)
      if (!card) return `You have no card called ${nickname}.`
      const currency = productOf(card.product)?.homeCurrency ?? DEFAULT_CURRENCY
      const entry = parseEntry(rest, card, currency, now(), timezone)
      return typeof entry === 'string' ? entry : addPurchase(store, card, entry, messageId, now(), timezone)
    }

    case '/remove': {
      const [, purchaseId] = PURCHASE_ID.exec(args[0] ?? '') ?? []
      if (args.length !== 1 || purchaseId === undefined) return 'Usage: /remove <purchase id>'
      const { id, timezone } = await user()
      const removed = await storeFor(db, id).removeTransaction(Number(purchaseId))
      if (!removed) return `You have no purchase with ID ${Number(purchaseId)}.`
      const date = formatShortDate(new Date(removed.occurredAt * 1000), timezone)
      return inMessages([{ text: `Removed from ${maskLast4(removed.cardLast4)}:` }, purchaseLine(removed, date)])
    }

    case '/sort': {
      const [target = ''] = args
      const [, purchaseId] = PURCHASE_ID.exec(target) ?? []
      if (args.length !== 1 || (!NICKNAME.test(target) && purchaseId === undefined)) return SORT_USAGE
      const { id, timezone } = await user()
      const store = storeFor(db, id)
      const cards = await store.listCards()
      // A nickname can be a number too. The card goes first: a purchase can always be given with the # before its id.
      const card = cards.find((each) => each.nickname === target)
      if (card) {
        const product = productOf(card.product)
        // Nothing on the card waits to be sorted: a purchase is where its product puts it, until its user moves it.
        if (product) {
          const note = product.sortingNote ? `${product.sortingNote} ` : ''
          return (
            `Every purchase on ${label(card)} counts as ${whereSorted(product, null)} unless it is marked ` +
            `otherwise. ${note}To mark one, send /sort <purchase id>. /spend ${card.nickname} shows the ids.`
          )
        }
        return (
          `${label(card)} is linked to no product, so its purchases are not sorted. ` +
          `To link it to one, send /product ${card.nickname} <product key>.`
        )
      }
      if (purchaseId === undefined) return `You have no card called ${target}.`
      const purchase = await store.findTransaction(Number(purchaseId))
      if (!purchase) return `You have no purchase with ID ${Number(purchaseId)}.`
      const product = productOf(cards.find((each) => each.last4 === purchase.cardLast4)?.product)
      if (product) return [sortPrompt(product, purchase, timezone)]
      return `ID ${purchase.id} is on a card that is linked to no product, so there is nothing to sort it into.`
    }

    case '/timezone': {
      const { id, timezone } = await user()
      if (args.length === 0) return `Your time zone is ${timezone}. To change it, send ${TIMEZONE_USAGE}.`
      if (args.length !== 1) return `Usage: ${TIMEZONE_USAGE}`
      const zone = timeZoneNamed(args[0])
      if (!zone) return 'That is not a time zone the bot knows. Use an IANA name, such as Asia/Tokyo or Europe/London.'
      await setTimezone(db, id, zone)
      return `Your time zone is now ${zone}. Your cards' cycles and months begin and end by it.`
    }

    case '/connect': {
      const { id } = await user()
      const connection = await connectStoreFor(db, id).findConnection()
      if (connection?.status === 'active') {
        return `Your Gmail ${connection.email} is already connected. Send /disconnect to remove it.`
      }
      return `${CONNECT_HEADS_UP}\n${await startConnect(deps, id)}`
    }

    case '/code': {
      const [code = ''] = args
      if (args.length !== 1 || !CODE.test(code)) return 'Usage: /code <6-digit code>'
      return confirmReply(deps, (await user()).id, code)
    }

    case '/status': {
      const { id, timezone } = await user()
      const connection = await connectStoreFor(db, id).findConnection()
      const since = Math.floor(now().getTime() / 1000) - STATUS_DAYS * 86_400
      return statusReply(connection, await mailStoreFor(db, id).summary(since), timezone)
    }

    case '/disconnect': {
      const email = await disconnect(deps, (await user()).id)
      if (!email) return 'Your Gmail is not connected.'
      return `Disconnected ${email}. Its mail is no longer read for this chat.`
    }

    case '/mcp': {
      if (args.length === 0) {
        const token = await issueToken(db, (await user()).id)
        return tokenReply(`${deps.baseUrl}/mcp`, token)
      }
      if (args.length !== 1 || args[0].toLowerCase() !== 'revoke') return 'Usage:\n/mcp\n/mcp revoke'
      const removed = await mcpStoreFor(db, (await user()).id).removeToken()
      return removed
        ? 'Your assistant access token has been removed. An assistant that used it can no longer read your data.'
        : 'You have no assistant access token.'
    }

    case '/delete': {
      if (args[0]?.toLowerCase() !== 'confirm') {
        return (
          'This deletes your cards and every purchase stored for you, and cannot be undone. ' +
          'Send /delete confirm to go ahead.'
        )
      }
      const { id } = await user()
      // Google is told first, while the tokens to revoke are still here.
      await disconnect(deps, id)
      await deleteUser(db, id)
      return 'Everything stored about you has been deleted. Send /start to begin again.'
    }

    default:
      // The code from the sign-in page, sent as a message of its own.
      if (args.length === 0 && CODE.test(first)) return confirmReply(deps, (await user()).id, first)
      // A command that there is not, or a message with nothing in it: the list of the commands and, where the bot
      // has an assistant, what becomes of a message that is none of them.
      if (first === '' || first.startsWith('/')) return deps.ai ? `${COMMANDS}\n\n${ASK_TOO}` : COMMANDS
      // Whatever else a message says, it is a question for the assistant.
      return ask(deps, telegramId, text.trim())
  }
}

/**
 * The reply to a question for the assistant. Where the bot has one, it is a reply that is still to be made: the
 * chat is first shown that the bot is writing, and the answer then takes the seconds that a model takes over it.
 */
function ask(deps: Deps, telegramId: number, question: string): Reply | Deferred {
  const { ai, db, messenger } = deps
  if (!ai) return NO_ASSISTANT
  if (question.length > MAX_QUESTION_LENGTH) return QUESTION_TOO_LONG

  return async () => {
    try {
      await messenger.typing(telegramId)
    } catch (error) {
      // The question is answered all the same.
      console.error('typing action failed:', error instanceof Error ? error.name : typeof error)
    }
    // A question needs a user as a command does: its answer is read from their store.
    const result = await answerQuestion(deps, ai, await findOrCreateUser(db, telegramId), question)
    switch (result.status) {
      case 'answered':
        return answered(result.text)
      case 'busy':
        return busyReply(result.retryAfter)
      case 'failed':
        return NOT_ANSWERED
    }
  }
}

/**
 * An answer of the assistant's as a reply. It is a model's text, which can repeat the name of a merchant, and
 * Telegram makes a command or a link of whatever looks like one. So it is sent as a rich message, with a paragraph
 * to each line of the answer and every text plain, in which Telegram is told to make nothing of any text: see
 * RichMessage. As the text that is sent when Telegram does not take that, the whole of it is marked as code, in
 * which nothing can be tapped either.
 */
function answered(answer: string): Tabled {
  const text = cutToFit(answer)
  const paragraph = (line: string): RichBlock => ({ type: 'paragraph', text: line })
  return {
    rich: { blocks: text.split('\n').map(paragraph), skip_entity_detection: true },
    asText: () => [{ text, entities: [{ type: 'code', offset: 0, length: text.length }] }],
  }
}

/**
 * An answer as Telegram takes it either way, as a rich message or as text: its lines, with no empty one among them,
 * that are no more than a rich message has blocks and no longer in all than a message of text. Where any of it is
 * cut off, it ends with an ellipsis.
 */
function cutToFit(answer: string): string {
  const lines = answer
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const text = lines.slice(0, MAX_PARAGRAPHS).join('\n')
  if (lines.length <= MAX_PARAGRAPHS && text.length <= MAX_LENGTH) return text
  const kept = text.slice(0, MAX_LENGTH - 1)
  // A character that a string holds as two code units is not left cut in half.
  return `${(kept.isWellFormed() ? kept : kept.slice(0, -1)).trimEnd()}…`
}

/**
 * What a question is answered with when the AI provider has had as many requests as it takes for now. It says when
 * to try again: after the wait that the provider gave, which is `retryAfter` in seconds, or else "later".
 */
function busyReply(retryAfter: number | undefined): string {
  const when = retryAfter === undefined ? 'later' : `in about ${describeWait(retryAfter)}`
  return `The assistant has reached its limit for now. Try again ${when}.`
}

/**
 * A wait of so many seconds in the unit that a person would say it in, rounded up: "a minute" for less than a
 * minute, minutes for less than an hour, as in "12 minutes", and hours from then on, as in "2 hours".
 */
function describeWait(seconds: number): string {
  if (seconds < 60) return 'a minute'
  const minutes = Math.ceil(seconds / 60)
  if (seconds < 3600) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.ceil(seconds / 3600)
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

/**
 * Answers the press of a button. The bot's buttons move a purchase to a category, so that is what a press does:
 * for the user who made it, and in their own private chat with the bot.
 */
async function press(deps: Deps, { id, from, data, message }: Press): Promise<void> {
  const { db, messenger } = deps
  if (typeof id !== 'string' || typeof from?.id !== 'number') return
  // As with a message: an update whose chat is not the private chat of the user it is from is not one to answer.
  if (message?.chat?.type !== 'private' || message.chat.id !== from.id) return
  const chatId = from.id

  // A client can send what no button of the bot's holds. So every part of it is looked up before anything is
  // changed, and the purchase through the store of the user who pressed, which finds no purchase of anyone else's.
  const refuse = () => messenger.answer(id, 'That button no longer works.')
  const pressed = readPress(typeof data === 'string' ? data : '')
  const user = pressed && (await findUser(db, chatId))
  if (!pressed || !user) return refuse()
  const store = storeFor(db, user.id)
  const purchase = await store.findTransaction(pressed.purchaseId)
  if (!purchase) return refuse()
  const card = (await store.listCards()).find((each) => each.last4 === purchase.cardLast4)
  const product = productOf(card?.product)
  const category = product && choicesOf(product).find((choice) => choice.key === pressed.category)
  if (!product || !category) return refuse()

  // Nothing moves a purchase to where it is already. With no category stored for it, that is the default of its
  // product, which the store would take for a move. This one purchase is all that a press moves, and nothing is
  // kept of it for any other: a later purchase at the same merchant starts where the product puts it.
  if (categoryOf(product, purchase.category) !== category.key) await store.setCategory(purchase.id, category.key)
  // A press for the category that the purchase is in already moves nothing, and is answered and carried through
  // like any other. It is what comes after Telegram failed to take the answer or the edit of an earlier press: the
  // purchase was moved then, and its message still says where it was. So this press brings the message up to date.
  const { line, buttons } = sortEnd(product, { id: purchase.id, category: category.key })
  await messenger.answer(id, line)

  // The message ends with the line that said where the purchase was. That line is replaced, and so are the buttons:
  // by those for where the purchase is now.
  if (typeof message.message_id === 'number' && typeof message.text === 'string') {
    const kept = message.text.slice(0, message.text.lastIndexOf('\n') + 1)
    const marked = codeWithin(message.entities ?? [], kept.length)
    await messenger.edit(chatId, message.message_id, kept + line, marked.length > 0 ? marked : undefined, buttons)
  }
}

async function confirmReply(deps: Deps, userId: number, code: string): Promise<string> {
  const result = await confirmCode(deps, userId, code)
  switch (result.status) {
    case 'connected':
      return `Connected ${result.email}. Your bank alerts will start being read within a few minutes.`
    case 'wrong':
      return `That code is not right. You have ${result.triesLeft} ${result.triesLeft === 1 ? 'try' : 'tries'} left.`
    case 'none':
      return NO_SIGN_IN
  }
}

/** What /mcp answers with: the one showing of a new token, and how to give it to an assistant. */
function tokenReply(endpoint: string, token: string): string {
  return [
    'Your assistant access token:',
    token,
    '',
    'It is shown only this once. Anyone who has it can read your card totals and purchases, so you may want to ' +
      'delete this message once you have copied the token. Sending /mcp again replaces it, and /mcp revoke removes it.',
    '',
    'To connect Claude Code, run:',
    `claude mcp add --transport http spend-tracker ${endpoint} --header "Authorization: Bearer ${token}"`,
    '',
    `For another assistant, the MCP endpoint is ${endpoint} and the token goes in the header ` +
      '"Authorization: Bearer <token>".',
  ].join('\n')
}

/** The time zone of the name, spelt as Intl spells it. Null when Intl knows no time zone of that name. */
function timeZoneNamed(name: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** The card that /addcard's arguments describe, or a message saying what is wrong with them. */
function parseCard(args: string[]): Card | string {
  const usage = `Usage:\n${ADD_CARD_USAGE}`
  const [nickname = '', last4 = '', type = '', day = ''] = args
  if (args.length < 3) return usage
  if (!NICKNAME.test(nickname)) return 'The nickname must be 1 to 20 characters: letters, digits, _ or -.'
  if (!LAST4.test(last4)) return 'The last four digits must be exactly four digits, like 1234.'

  // The key of a product can come as one more word, after all that says what the card's window is.
  const words = type.toLowerCase() === 'statement' ? 4 : 3
  const key = args[words]
  if (args.length > words + 1 || (key !== undefined && !PRODUCT_KEY.test(key))) return usage
  const product = productOf(key?.toLowerCase())
  if (key !== undefined && !product) return noSuchProduct(key)
  const linked = product ? { product: product.key } : {}

  if (type.toLowerCase() === 'calendar') return { nickname, last4, windowType: 'calendar', ...linked }
  if (type.toLowerCase() === 'statement' && args.length >= 4) {
    const statementDay = DAY.test(day) ? Number(day) : 0
    if (statementDay < 1 || statementDay > 31) return 'The statement day must be a number from 1 to 31.'
    return { nickname, last4, windowType: 'statement', statementDay, ...linked }
  }
  return usage
}

function noSuchProduct(key: string): string {
  return `There is no product called ${key}. Send /products for the ones there are.`
}

/**
 * The purchase that /add's arguments after the card describe, or a message saying what is wrong with them: an
 * amount, then a date or none, then the merchant in as many words as it takes. `homeCurrency` is the currency of
 * an amount that comes without one, and `card` is the card that the purchase was made with.
 */
function parseEntry(args: string[], card: Card, homeCurrency: string, now: Date, timeZone: string): Entry | string {
  // A currency can stand apart from its amount, as in "USD 12.50".
  const apart = CURRENCY.test(args[0])
  const [, currency = homeCurrency, whole, decimals] = AMOUNT.exec(apart ? args[0] + args[1] : args[0]) ?? []
  if (whole === undefined) return ADD_USAGE
  const amountMinor = hundredths(whole, decimals)
  if (amountMinor === 0) return 'The amount must be more than zero.'

  const rest = args.slice(apart ? 2 : 1)
  const dated = timeNamed(rest[0] ?? '', card, now, timeZone)
  // What is taken for a date is no word of the merchant, so a merchant has to follow it.
  const merchant = rest.slice(dated === null ? 0 : 1).join(' ')
  if (merchant === '') return ADD_USAGE
  if (merchant.length > MAX_MERCHANT_LENGTH) return `The merchant can be ${MAX_MERCHANT_LENGTH} characters at most.`
  if (typeof dated === 'string') return dated
  const occurredAt = dated ?? Math.floor(now.getTime() / 1000)
  return { amountMinor, currency: currency.toUpperCase(), merchant, occurredAt }
}

/**
 * When a purchase with the date that is given to /add was made, in unix seconds, or a message saying what is wrong
 * with the date. Null for text that is not taken for a date, which is then the first word of the merchant.
 *
 * Text written YYYY-MM-DD is always a date. Text written D/M, or D/M and then a year or its last two digits, can as
 * well begin the name of a merchant, as "24/7" and "7/11" do. It is taken for a date when the day it names is one of
 * the card's current window and is not after today, and for a word of the merchant when it is not. With no year, it
 * names the latest day so written that is not after today: on 2 January, "30/12" is the 30th of the December before.
 */
function timeNamed(text: string, card: Card, now: Date, timeZone: string): number | string | null {
  const at = Math.floor(now.getTime() / 1000)
  // No time comes with a date, so noon stands in for it: or the time that it is now, on a day that has not got to
  // its noon yet.
  const noonOf = (start: number) => Math.min(start + 12 * 3600, at)

  const iso = ISO_DATE.exec(text)
  if (iso) {
    const start = dayStart(Number(iso[1]), Number(iso[2]), Number(iso[3]), timeZone)
    if (start === null) return 'There is no such date.'
    return start > at ? 'That date is still to come.' : noonOf(start)
  }

  const [, day, month, year] = SHORT_DATE.exec(text) ?? []
  if (day === undefined) return null
  const today = dayOf(now, timeZone)
  const toCome = Number(month) > today.month || (Number(month) === today.month && Number(day) > today.day)
  // Two digits of a year are of this century. With no year, it is this year's day, or last year's when this year's
  // is still to come.
  const fullYear = year === undefined ? today.year - (toCome ? 1 : 0) : Number(year) + (year.length === 2 ? 2000 : 0)
  const start = dayStart(fullYear, Number(month), Number(day), timeZone)
  const windowStart = currentWindow(card, now, timeZone).start.getTime() / 1000
  return start !== null && start >= windowStart && start <= at ? noonOf(start) : null
}

/** Unix seconds of the instant at which a day begins in the time zone. Null for a day that no calendar has. */
function dayStart(year: number, month: number, day: number, timeZone: string): number | null {
  // A date that no calendar has rolls over into one that a calendar has, and then does not read back as it was given.
  const given = new Date(Date.UTC(year, month - 1, day))
  const exists = given.getUTCFullYear() === year && given.getUTCMonth() === month - 1 && given.getUTCDate() === day
  return exists ? startOfDay(year, month, day, timeZone).getTime() / 1000 : null
}

/**
 * Stores a purchase that its user described, and tells of it: the purchase, and where it leaves its card. On a card
 * with a product the message ends as the one for a purchase from an alert does, with where the purchase is sorted
 * and with the buttons that move it. `messageId` is Telegram's id of the message that described the purchase.
 */
async function addPurchase(
  store: Store,
  card: Card,
  entry: Entry,
  messageId: number,
  now: Date,
  timeZone: string,
): Promise<string | Outgoing[]> {
  const described = { ...entry, cardLast4: card.last4, parser: MANUAL }
  const category = startingCategoryOn(card, described)
  // No alert gives this purchase an id to be known by, so it is known by the message that described it. Telegram
  // delivers a message again when it has not heard that the message was taken, and that is then no second purchase.
  const sourceId = `${MANUAL}:${messageId}`
  const id = await store.insertTransaction({ ...described, sourceId, category })
  // The store adds no purchase past the limit, and none for a message that it has one for already. Which of the two
  // it was is looked up only now that one of them has happened. A message that comes again is answered with its
  // purchase as it stands, which is what the first delivery was answered with.
  const purchase = id === null ? await store.findBySourceId(sourceId) : { ...described, id, category, removedAt: null }
  if (!purchase) return TOO_MANY_BY_HAND
  if (purchase.removedAt !== null) return `ID ${purchase.id} has been taken out, and is not added again.`

  const [totals] = await cardTotals(store, [card], now, timeZone)
  const date = formatShortDate(new Date(purchase.occurredAt * 1000), timeZone)
  const lines = [purchaseLine(purchase, date), { text: spendLine(totals, timeZone) }]
  const product = productOf(card.product)
  if (!product) return inMessages(lines)
  const { line, buttons } = sortEnd(product, purchase)
  const [message] = inMessages([...lines, { text: line }])
  return [{ ...message, buttons }]
}

/** A purchase, with where it is sorted and the buttons that move it. */
function sortPrompt(product: Product, purchase: Transaction, timeZone: string): Outgoing {
  const { line, buttons } = sortEnd(product, purchase)
  const date = formatShortDate(new Date(purchase.occurredAt * 1000), timeZone)
  const [message] = inMessages([purchaseLine(purchase, date), { text: line }])
  return { ...message, buttons }
}

/** Those of a message's stretches of code that end within its first `end` code units, as they came with it. */
function codeWithin(entities: { type?: string; offset?: number; length?: number }[], end: number): MessageEntity[] {
  return entities.flatMap(({ type, offset, length }) =>
    type === 'code' && typeof offset === 'number' && typeof length === 'number' && offset + length <= end
      ? [{ type, offset, length }]
      : [],
  )
}

function label(card: Card): string {
  return `${card.nickname} ${maskLast4(card.last4)}`
}

/** A card as /cards lists it: with its window and, when it is linked to one, the name of its product. */
function describeCard(card: Card): string {
  const product = productOf(card.product)
  return `${label(card)}: ${describeWindow(card)}${product ? `, ${product.name}` : ''}`
}

function spendLine(each: CardTotals, timeZone: string): string {
  return `${label(each.card)}: ${describeTotals(each, timeZone)}`
}

/**
 * A card's current window in full: its purchases from the earliest on, in tables that end with what they come to,
 * and after the tables what the whole window comes to. A card with a product has a table for each group of the
 * product, which ends with the group's limit where it has one, and then how far the spend is towards the product's
 * minimum. A card with no product has one table, of all its purchases. It is one rich message. As text, it can come
 * to more than one message takes.
 */
async function spendDetail(store: Store, card: Card, now: Date, timeZone: string): Promise<Tabled> {
  const window = currentWindow(card, now, timeZone)
  const [start, end] = [window.start.getTime() / 1000, window.end.getTime() / 1000]
  // Two queries, however many purchases there are: the sums, which take in all of them, and the latest to list.
  const [sums, latest] = await Promise.all([
    store.sumByCategory(card.last4, start, end),
    store.listTransactions(card.last4, start, end, WINDOW_LIMIT),
  ])
  const product = productOf(card.product)
  const breakdown = product && breakDown(product, sums)
  const count = sums.reduce((total, sum) => total + sum.count, 0)
  // One formatter for all the dates: see shortDateIn.
  const shortDate = shortDateIn(timeZone)
  const listed = latest.reverse().map((purchase) => ({
    ...purchase,
    date: shortDate(new Date(purchase.occurredAt * 1000)),
  }))
  // A card with a product has a table for each group of the product. A card with none has one table, of all that
  // is listed, when anything is.
  const whole: Section[] = listed.length > 0 ? [{ purchases: listed, spent: perCurrency(sums) }] : []
  const sections = product && breakdown ? sectionsOf(product, breakdown, listed) : whole
  const homeCurrency = product?.homeCurrency ?? DEFAULT_CURRENCY

  // What is said around the tables: a heading, and the lines above the tables and below them, a part at a time.
  const heading = `${label(card)}: ${shortDate(window.start)} to ${shortDate(new Date(window.end.getTime() - 1))}`
  const above = count > listed.length ? [`The latest ${listed.length} of ${count} purchases:`] : []
  const below = [
    listed.some((purchase) => purchase.parser === MANUAL) ? [BY_HAND_NOTE] : [],
    [`Total: ${describeTotals({ card, window, totals: perCurrency(sums), count }, timeZone)}`],
    product && breakdown ? breakdownLines(product, breakdown) : [],
  ]

  const paragraph = (text: RichText): RichBlock => ({ type: 'paragraph', text })
  const lines = (texts: string[]): Line[] => texts.map((text) => ({ text }))
  return {
    // A paragraph to each line, with the heading in bold, as the names of the tables are.
    rich: {
      blocks: [
        paragraph({ type: 'bold', text: heading }),
        ...above.map(paragraph),
        ...purchaseBlocks(sections, homeCurrency),
        ...below.flat().map(paragraph),
      ],
      skip_entity_detection: true,
    },
    asText() {
      const parts: (Line | Table)[][] = [
        lines([heading]),
        lines(above),
        ...purchaseTables(sections, homeCurrency).map((table) => [table]),
        ...below.map(lines),
      ]
      // An empty line before each part that holds anything. A message does not begin with one.
      return inMessages(parts.filter((part) => part.length > 0).flatMap((part) => [{ text: '' }, ...part]))
    },
  }
}

function statusReply(connection: Connection | null, summary: MailSummary, timeZone: string): string {
  const { lastCheckedAt, purchases, unparsed } = summary
  const checked = lastCheckedAt === null ? 'not yet' : formatShortDateTime(new Date(lastCheckedAt * 1000), timeZone)
  return [
    gmailStatus(connection),
    `Alerts last fully checked: ${checked}`,
    `Last ${STATUS_DAYS} days: ${purchases} ${purchases === 1 ? 'purchase' : 'purchases'} recorded, ` +
      `${unparsed} ${unparsed === 1 ? 'alert' : 'alerts'} could not be read`,
  ].join('\n')
}

function gmailStatus(connection: Connection | null): string {
  if (!connection) return 'Your Gmail is not connected. Send /connect to connect it.'
  const gmail = `Your Gmail ${connection.email}`
  return connection.status === 'active'
    ? `${gmail} is connected.`
    : `${gmail} needs reconnecting. Send /connect to reconnect it.`
}
