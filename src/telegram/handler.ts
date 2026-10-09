import { choicesOf, productOf, products } from '../catalogue'
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
import type { MessageEntity, Outgoing } from './api'
import { describeTotals, describeWindow, formatShortDate, formatShortDateTime, maskLast4, shortDateIn } from './format'
import {
  breakdownLines,
  inMessages,
  purchaseLine,
  readPress,
  sortedLine,
  sortEnd,
  whereSorted,
  type Line,
} from './purchases'

/** The parts of a Telegram update this bot reads. All optional, because it arrives as unchecked JSON. */
export interface Update {
  message?: {
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

const NICKNAME = /^[A-Za-z0-9_-]{1,20}$/
const LAST4 = /^\d{4}$/
const DAY = /^\d{1,2}$/
const CODE = /^\d{6}$/
const PRODUCT_KEY = /^[A-Za-z0-9-]{1,30}$/
/** A purchase's id, as it is shown, with or without the # before it. */
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

export const ADD_CARD_USAGE = `/addcard <nickname> <last4> statement <day>
/addcard <nickname> <last4> calendar`

const ADD_USAGE = `Usage:
/add <nickname> <amount> <merchant>
/add <nickname> <amount> <date> <merchant>
The amount can have a currency before it, as in USD 12.50. The date is written YYYY-MM-DD, D/M or D/M/YY.`

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
/sort <nickname> - sort a card's purchases into the reward categories of its product
/sort <purchase id> - sort one purchase, or sort it again
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

const NO_CARDS = `You have no cards yet. Add one with:\n${ADD_CARD_USAGE}`

const TOO_MANY_CARDS =
  `You have ${MAX_CARDS} cards, which is as many as can be tracked. To add another, first remove one with ` +
  '/removecard <nickname>.'

const TIMEZONE_USAGE = '/timezone <IANA name>, for example /timezone Asia/Tokyo'

const NO_SIGN_IN =
  'No sign-in is waiting for a code. It may have expired, or had too many wrong codes. Send /connect to start again.'

/**
 * Answers a text message that a user sent in their private chat with the bot, or their press of a button under one
 * of the bot's messages there. Every other update is ignored.
 */
export async function handleUpdate(deps: Deps, update: Update): Promise<void> {
  if (update.callback_query) return press(deps, update.callback_query)

  const { text, chat, from } = update.message ?? {}
  if (chat?.type !== 'private' || typeof chat.id !== 'number') return
  if (typeof from?.id !== 'number' || typeof text !== 'string') return
  // The user is known by who sent the message, and the reply goes to the chat it was sent in. A user's private
  // chat with the bot has the user's own id, so the two are the same, and an update in which they differ is not
  // one to answer.
  if (from.id !== chat.id) return

  const answer = await reply(deps, from.id, text)
  const messages: Outgoing[] = typeof answer === 'string' ? [{ text: answer }] : answer
  for (const message of messages) await deps.messenger.send(chat.id, message.text, message.entities, message.buttons)
}

/** The reply to a message: plain text, or messages with a merchant's name marked in them or buttons under them. */
async function reply(deps: Deps, telegramId: number, text: string): Promise<string | Outgoing[]> {
  const { db, now } = deps
  const [first = '', ...args] = text.trim().split(/\s+/)
  const command = first.split('@')[0].toLowerCase() // "/spend@SomeBot" is "/spend"
  // A user row is only created by the commands that need one.
  const user = () => findOrCreateUser(db, telegramId)

  switch (command) {
    case '/start':
      await user()
      return `${WELCOME}\n\n${COMMANDS}`

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
      return `Linked ${label(card)} to ${product.name}. To sort its purchases, send /sort ${nickname}.`
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
      const entry = parseEntry(rest, currency, now(), timezone)
      return typeof entry === 'string' ? entry : addPurchase(store, card, entry, now(), timezone)
    }

    case '/remove': {
      const [, purchaseId] = PURCHASE_ID.exec(args[0] ?? '') ?? []
      if (args.length !== 1 || purchaseId === undefined) return 'Usage: /remove <purchase id>'
      const { id, timezone } = await user()
      const removed = await storeFor(db, id).removeTransaction(Number(purchaseId))
      if (!removed) return `You have no purchase #${Number(purchaseId)}.`
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
        if (product) return [await nextToSort(store, card, product, now(), timezone)]
        return (
          `${label(card)} is linked to no product, so its purchases are not sorted. ` +
          `To link it to one, send /product ${card.nickname} <product key>.`
        )
      }
      if (purchaseId === undefined) return `You have no card called ${target}.`
      const purchase = await store.findTransaction(Number(purchaseId))
      if (!purchase) return `You have no purchase #${Number(purchaseId)}.`
      const product = productOf(cards.find((each) => each.last4 === purchase.cardLast4)?.product)
      if (product) return [sortPrompt(product, purchase, timezone)]
      return `#${purchase.id} is on a card that is linked to no product, so there is nothing to sort it into.`
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
      return COMMANDS
  }
}

/**
 * Answers the press of a button. The bot's buttons sort a purchase into a category, so that is what a press does:
 * for the user who made it, and in their own private chat with the bot.
 */
async function press(deps: Deps, { id, from, data, message }: Press): Promise<void> {
  const { db, messenger, now } = deps
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
  if (!card || !product || !category) return refuse()

  const where = sortedLine(product, { id: purchase.id, category: category.key })
  // A press that changes nothing is answered and no more. So of two presses of one button, the second neither
  // edits the message again nor sends what follows it a second time.
  if (!(await store.setCategory(purchase.id, category.key))) return messenger.answer(id, where)
  // Later purchases at the merchant start where this one was put.
  if (purchase.merchant) await store.rememberCategory(product.key, purchase.merchant, category.key)
  await messenger.answer(id, where)

  // The message ends with the line that said where the purchase was. That line is replaced, and the buttons go.
  if (typeof message.message_id === 'number' && typeof message.text === 'string') {
    const kept = message.text.slice(0, message.text.lastIndexOf('\n') + 1)
    const marked = codeWithin(message.entities ?? [], kept.length)
    await messenger.edit(chatId, message.message_id, kept + where, marked.length > 0 ? marked : undefined)
  }
  if (pressed.next) {
    const following = await nextToSort(store, card, product, now(), user.timezone)
    await messenger.send(chatId, following.text, following.entities, following.buttons)
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
 * an amount that comes without one.
 */
function parseEntry(args: string[], homeCurrency: string, now: Date, timeZone: string): Entry | string {
  // A currency can stand apart from its amount, as in "USD 12.50".
  const apart = CURRENCY.test(args[0])
  const [, currency = homeCurrency, whole, decimals] = AMOUNT.exec(apart ? args[0] + args[1] : args[0]) ?? []
  if (whole === undefined) return ADD_USAGE
  const amountMinor = hundredths(whole, decimals)
  if (amountMinor === 0) return 'The amount must be more than zero.'

  const rest = args.slice(apart ? 2 : 1)
  const today = dayOf(now, timeZone)
  const date = dayNamed(rest[0] ?? '', today.year)
  // What is written as a date is taken for one, so a merchant has to follow it.
  const merchant = rest.slice(date ? 1 : 0).join(' ')
  if (merchant === '') return ADD_USAGE
  if (merchant.length > MAX_MERCHANT_LENGTH) return `The merchant can be ${MAX_MERCHANT_LENGTH} characters at most.`
  const entry = { amountMinor, currency: currency.toUpperCase(), merchant }
  if (!date) return { ...entry, occurredAt: Math.floor(now.getTime() / 1000) }

  const { year, month, day } = date
  // A date that no calendar has rolls over into one that a calendar has, and then does not read back as it was given.
  const given = new Date(Date.UTC(year, month - 1, day))
  const exists = given.getUTCFullYear() === year && given.getUTCMonth() === month - 1 && given.getUTCDate() === day
  if (!exists) return 'There is no such date.'
  if (given.getTime() > Date.UTC(today.year, today.month - 1, today.day)) return 'That date is still to come.'
  // No time comes with the date, so noon stands in for it.
  return { ...entry, occurredAt: startOfDay(year, month, day, timeZone).getTime() / 1000 + 12 * 3600 }
}

/**
 * The day that a date given to /add names: written YYYY-MM-DD, or D/M for a day of `thisYear`, or D/M and then a
 * year or its last two digits. Null for text that is not written as a date.
 */
function dayNamed(text: string, thisYear: number): { year: number; month: number; day: number } | null {
  const iso = ISO_DATE.exec(text)
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
  const [, day, month, year] = SHORT_DATE.exec(text) ?? []
  if (day === undefined) return null
  // Two digits of a year are of this century.
  const fullYear = year === undefined ? thisYear : Number(year) + (year.length === 2 ? 2000 : 0)
  return { year: fullYear, month: Number(month), day: Number(day) }
}

/**
 * Stores a purchase that its user described, and tells of it: the purchase, and where it leaves its card. On a card
 * with a product the message ends as the one for a purchase from an alert does, with where the purchase is sorted or
 * with the buttons that sort it.
 */
async function addPurchase(
  store: Store,
  card: Card,
  entry: Entry,
  now: Date,
  timeZone: string,
): Promise<string | Outgoing[]> {
  const described = { ...entry, cardLast4: card.last4, parser: MANUAL }
  const category = await startingCategoryOn(store, card, described)
  // No alert gives this purchase an id to be known by, so it gets one that no other can have.
  const id = await store.insertTransaction({ ...described, sourceId: `${MANUAL}-${crypto.randomUUID()}`, category })
  if (id === null) return 'That purchase could not be added. Try again.'
  const purchase = { ...described, id, category }

  const [totals] = await cardTotals(store, [card], now, timeZone)
  const date = formatShortDate(new Date(purchase.occurredAt * 1000), timeZone)
  const lines = [purchaseLine(purchase, date), { text: spendLine(totals, timeZone) }]
  const product = productOf(card.product)
  if (!product) return inMessages(lines)
  const { line, buttons } = sortEnd(product, purchase)
  const [message] = inMessages([...lines, { text: line }])
  return [{ ...message, buttons }]
}

/** A purchase with the buttons that sort it. With `next`, a press is followed by the card's next unsorted purchase. */
function sortPrompt(product: Product, purchase: Transaction, timeZone: string, next = false): Outgoing {
  const { line, buttons } = sortEnd(product, purchase, true, next)
  const date = formatShortDate(new Date(purchase.occurredAt * 1000), timeZone)
  const [message] = inMessages([purchaseLine(purchase, date), { text: line }])
  return { ...message, buttons }
}

/**
 * The earliest purchase in the card's current window that is not sorted yet, with the buttons that sort it. When
 * there is none, word of that.
 */
async function nextToSort(store: Store, card: Card, product: Product, now: Date, timeZone: string): Promise<Outgoing> {
  const { start, end } = currentWindow(card, now, timeZone)
  const purchase = await store.oldestUnsorted(card.last4, start.getTime() / 1000, end.getTime() / 1000)
  if (purchase) return sortPrompt(product, purchase, timeZone, true)
  return { text: `Every purchase on ${label(card)} in its current window is sorted.` }
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
 * A card's current window in full: every purchase in it from the earliest on, then what they come to, and for a
 * card with a product the table of what its rules make of them. It can come to more than one message takes.
 */
async function spendDetail(store: Store, card: Card, now: Date, timeZone: string): Promise<Outgoing[]> {
  const window = currentWindow(card, now, timeZone)
  const [start, end] = [window.start.getTime() / 1000, window.end.getTime() / 1000]
  // Two queries, however many purchases there are: the sums, which take in all of them, and the latest to list.
  const [sums, latest] = await Promise.all([
    store.sumByCategory(card.last4, start, end),
    store.listTransactions(card.last4, start, end, WINDOW_LIMIT),
  ])
  const product = productOf(card.product)
  const count = sums.reduce((total, sum) => total + sum.count, 0)
  // One formatter for all the dates: see shortDateIn.
  const shortDate = shortDateIn(timeZone)
  const listed = latest.reverse().map((purchase) => {
    const date = shortDate(new Date(purchase.occurredAt * 1000))
    return purchaseLine(purchase, date, product && whereSorted(product, purchase.category))
  })
  const unlisted = count > listed.length ? [{ text: `The latest ${listed.length} of ${count} purchases:` }] : []

  const sections: Line[][] = [
    [{ text: `${label(card)}: ${shortDate(window.start)} to ${shortDate(new Date(window.end.getTime() - 1))}` }],
    [...unlisted, ...listed],
    [{ text: `Total: ${describeTotals({ card, window, totals: perCurrency(sums), count }, timeZone)}` }],
    product ? breakdownLines(product, breakDown(product, sums)).map((text) => ({ text })) : [],
  ]
  // An empty line before each section that holds anything. A message does not begin with one.
  return inMessages(sections.filter((section) => section.length > 0).flatMap((section) => [{ text: '' }, ...section]))
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
