// The bot's commands: what each of them does and replies, and the running of one as if its user had sent it. A
// question for the assistant is not answered here: see handle in ./handler.

import { productOf } from '../catalogue'
import { confirmCode, disconnect, startConnect } from '../connect'
import type { Deps } from '../deps'
import { bestFor } from '../domain/best'
import { nextReminder, reminderIn } from '../domain/reminder'
import { sortByRules } from '../domain/sorting'
import { cardTotals } from '../domain/totals'
import { currentWindow } from '../domain/window'
import { COMMAND_NAMES } from '../log'
import { issueToken } from '../mcp/tokens'
import { deleteUser, findOrCreateUser, MAX_CARDS, setTimezone, storeFor } from '../store'
import { connectStoreFor } from '../store-connect'
import { mailStoreFor } from '../store-mail'
import { mcpStoreFor } from '../store-mcp'
import { reminderStoreFor } from '../store-reminders'
import { addPurchase } from './adding'
import {
  CODE,
  NICKNAME,
  noSuchProduct,
  parseCard,
  parseCycle,
  parseEntry,
  parsePattern,
  parseReminder,
  PRODUCT_KEY,
  PURCHASE_ID,
  timeZoneNamed,
} from './arguments'
import { describeWindow, formatShortDate, formatShortDateTime, maskLast4, shortDateIn } from './format'
import { inMessages, purchaseLine, sortPrompt, whereSorted } from './purchases'
import {
  bestReply,
  cardsReply,
  describeCard,
  heldAgainst,
  label,
  patternLine,
  patternsReply,
  productsReply,
  spendDetails,
  spendReply,
  statusReply,
} from './replies'
import type { Reply, Sent } from './sending'
import { DEFAULT_CURRENCY, type Seen } from './shared'
import {
  ADD_USAGE,
  ASK,
  ASK_TOO,
  BEST_USAGE,
  COMMANDS,
  CONNECT_HEADS_UP,
  DO,
  NO_CARDS,
  NO_PATTERNS,
  NONE_LINKED,
  NO_SIGN_IN,
  NO_SUCH_PATTERN,
  PATTERN_REMOVED,
  PATTERN_SAVED,
  PATTERN_USAGE,
  PHOTO,
  PRODUCT_USAGE,
  REMIND_USAGE,
  reminderRemoved,
  reminderSet,
  RENAME_CARD_USAGE,
  SORT_USAGE,
  SORTED_AGAIN,
  STATUS_DAYS,
  TIMEZONE_USAGE,
  TOO_MANY_CARDS,
  TOO_MANY_PATTERNS,
  WELCOME,
} from './texts'

/**
 * The reply to a message, or nothing for a question for the assistant, which is its caller's to ask. What the message
 * is found to be is noted in `seen`, and `stored` is what an /add calls once a purchase for the message is stored.
 */
export async function reply(
  deps: Deps,
  telegramId: number,
  messageId: number,
  text: string,
  seen: Seen,
  stored: () => void,
): Promise<Reply | undefined> {
  const { db, now } = deps
  const [first = '', ...args] = text.trim().split(/\s+/)
  const command = first.split('@')[0].toLowerCase() // "/spend@SomeBot" is "/spend"
  // What the log has of a command is the name that it is known by here, and never what was sent. A message that is
  // none of the commands is noted for what it is where that is found out, at the end of the switch.
  seen.kind = 'command'
  seen.command = COMMAND_NAMES.find((name) => command === `/${name}`)
  // A user row is only created by the commands that need one.
  const user = () => findOrCreateUser(db, telegramId)

  switch (command) {
    case '/start':
      await user()
      return `${[WELCOME, ...whatIsSent(deps, ASK)].join(' ')}\n\n${COMMANDS}`

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
      return cardsReply(cards)
    }

    case '/products':
      return productsReply()

    case '/product': {
      const [nickname = '', key = ''] = args
      if (args.length !== 2 || !NICKNAME.test(nickname) || !PRODUCT_KEY.test(key)) return PRODUCT_USAGE
      const product = productOf(key.toLowerCase())
      if (!product && key.toLowerCase() !== 'none') return noSuchProduct(key)
      const { id, timezone } = await user()
      const store = storeFor(db, id)
      const card = (await store.listCards()).find((each) => each.nickname === nickname)
      if (!card) return `You have no card called ${nickname}.`
      const relinked = card.product !== undefined && card.product !== product?.key
      await store.setProduct(nickname, product?.key ?? null, relinked)
      if (!product) return `${label(card)} is linked to no product now.`
      await sortByRules(store, card, product, now(), timezone)
      return (
        `Linked ${label(card)} to ${product.name}.${relinked ? ` ${SORTED_AGAIN}` : ''} ` +
        `For how its purchases are sorted, send /sort ${nickname}.`
      )
    }

    case '/removecard': {
      const [nickname = ''] = args
      if (args.length !== 1 || !NICKNAME.test(nickname)) return 'Usage: /removecard <nickname>'
      const store = storeFor(db, (await user()).id)
      // A card's reminder is in its row, and goes with it: so whether it has one is read before it is removed.
      const card = (await store.listCards()).find((each) => each.nickname === nickname)
      const patterns = await store.removeCard(nickname)
      if (patterns === null) return `You have no card called ${nickname}.`
      const went = [
        ...(patterns > 0 ? [`the ${patterns} ${patterns === 1 ? 'pattern' : 'patterns'}`] : []),
        ...(card?.remindDay === undefined ? [] : ['the reminder']),
      ]
      return went.length > 0 ? `Removed ${nickname}, and ${went.join(' and ')} that it had.` : `Removed ${nickname}.`
    }

    case '/renamecard': {
      const [nickname = '', renamed = ''] = args
      if (args.length !== 2 || !NICKNAME.test(nickname) || !NICKNAME.test(renamed)) return RENAME_CARD_USAGE
      const store = storeFor(db, (await user()).id)
      const card = (await store.listCards()).find((each) => each.nickname === nickname)
      if (!card) return `You have no card called ${nickname}.`
      // The store gives no card a nickname that a card of its user's has already, which the card's own is too. The
      // card's digits, its window and its product stay as they are, and its purchases go by its digits.
      const done = await store.renameCard(nickname, renamed)
      return done ? `Renamed ${label(card)} to ${renamed}.` : `You already have a card called ${renamed}.`
    }

    case '/cycle': {
      const asked = parseCycle(args)
      if (typeof asked === 'string') return asked
      const { id, timezone } = await user()
      const store = storeFor(db, id)
      const card = (await store.listCards()).find((each) => each.nickname === asked.nickname)
      if (!card) return `You have no card called ${asked.nickname}.`
      // The purchases stay as they are, and are counted by the new window from now on.
      await store.setWindow(asked.nickname, asked)
      const window = currentWindow({ ...asked, product: card.product }, now(), timezone)
      const shortDate = shortDateIn(timezone)
      return (
        `Changed ${label(card)}: ${describeWindow(asked)}. ` +
        `Its current window runs from ${shortDate(window.start)} and resets ${shortDate(window.end)}.`
      )
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
        if (!card) return `You have no card called ${nickname}.`
        const [detail] = await spendDetails(store, [card], await store.listPatterns(), now(), timezone)
        return detail
      }
      return spendReply(await cardTotals(store, cards, now(), timezone), timezone)
    }

    case '/best': {
      const merchant = args.join(' ')
      if (merchant === '') return BEST_USAGE
      const { id, timezone } = await user()
      const store = storeFor(db, id)
      const [cards, patterns] = await Promise.all([store.listCards(), store.listPatterns()])
      if (cards.length === 0) return NO_CARDS
      const options = await bestFor(store, cards, patterns, merchant, now(), timezone)
      return options.length > 0 ? bestReply(options) : NONE_LINKED
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
      return typeof entry === 'string' ? entry : addPurchase(store, card, entry, messageId, now(), timezone, stored)
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

    case '/patterns': {
      const store = storeFor(db, (await user()).id)
      const [cards, patterns] = await Promise.all([store.listCards(), store.listPatterns()])
      return patterns.length > 0 ? patternsReply(cards, patterns) : NO_PATTERNS
    }

    case '/pattern': {
      const asked = parsePattern(args)
      if (!asked) return PATTERN_USAGE
      const { nickname, merchant, save } = asked
      const store = storeFor(db, (await user()).id)
      const card = (await store.listCards()).find((each) => each.nickname === nickname)
      if (!card) return `You have no card called ${nickname}.`
      if (save) {
        if (!(await store.setPattern({ cardLast4: card.last4, merchant, ...save }))) {
          // The store saves no pattern past the limit and none for a card that was removed in the meantime. Which
          // of the two it was is looked up only now that one of them has happened.
          const there = (await store.listCards()).some((each) => each.last4 === card.last4)
          return there ? TOO_MANY_PATTERNS : `You have no card called ${nickname}.`
        }
        const held = { text: heldAgainst(card, merchant) }
        return inMessages([{ text: PATTERN_SAVED }, patternLine(card, merchant, save), held])
      }
      if (!(await store.removePattern(card.last4, merchant))) return NO_SUCH_PATTERN
      return inMessages([{ text: PATTERN_REMOVED }, patternLine(card, merchant)])
    }

    case '/remind': {
      const asked = parseReminder(args)
      if (!asked) return REMIND_USAGE
      const { nickname, day } = asked
      const { id, timezone } = await user()
      const card = (await storeFor(db, id).listCards()).find((each) => each.nickname === nickname)
      if (!card) return `You have no card called ${nickname}.`
      const reminders = reminderStoreFor(db, id)
      if (day === null) {
        await reminders.remove(nickname)
        return reminderRemoved(label(card))
      }
      const at = await reminders.set(nickname, day, nextReminder(day, timezone, now()))
      // The store sets nothing for a card that was removed in the meantime.
      if (at === null) return `You have no card called ${nickname}.`
      return reminderSet(label(card), day, formatShortDateTime(new Date(at * 1000), timezone), timezone)
    }

    case '/timezone': {
      const { id, timezone } = await user()
      if (args.length === 0) return `Your time zone is ${timezone}. To change it, send ${TIMEZONE_USAGE}.`
      if (args.length !== 1) return `Usage: ${TIMEZONE_USAGE}`
      const zone = timeZoneNamed(args[0])
      if (!zone) return 'That is not a time zone the bot knows. Use an IANA name, such as Asia/Tokyo or Europe/London.'
      await setTimezone(db, id, zone)
      // A reminder is due by its user's clock, so each is moved to that hour of its day by the new one.
      const reminders = reminderStoreFor(db, id)
      const moved = (await reminders.list()).map(({ day, at }) => ({ day, from: at, to: reminderIn(day, zone, at) }))
      if (moved.length > 0) await reminders.moveAll(moved)
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
      if (args.length === 0 && CODE.test(first)) {
        seen.kind = 'code'
        return confirmReply(deps, (await user()).id, first)
      }
      // A command that there is not, or a message with nothing in it: the list of the commands and, where the bot
      // has an assistant, what becomes of a message that is none of them.
      if (first === '' || first.startsWith('/')) {
        seen.command = 'unknown'
        const sent = whatIsSent(deps, ASK_TOO)
        return sent.length > 0 ? `${COMMANDS}\n\n${sent.join(' ')}` : COMMANDS
      }
      // Whatever else a message says, it is a question for the assistant, or something for it to have done.
      seen.kind = 'question'
      return undefined
  }
}

/**
 * What the bot says of what is sent to the AI provider, on the service as it is set up: of a question, in the words
 * given, where it has an assistant, then that it can be told what to do in the same way, and after that of a photo,
 * where it reads photos. Nothing where it has neither.
 */
function whatIsSent({ ai }: Deps, ofQuestion: string): string[] {
  if (!ai) return []
  return ai.visionModel === undefined ? [ofQuestion, DO] : [ofQuestion, DO, PHOTO]
}

/**
 * The command that a line is of, by its name in the bot's own list, and the words after it: as `reply` takes a
 * message apart. It has no name when the line is of none of the bot's commands, or is no command at all.
 */
export function commandIn(line: string): { name?: (typeof COMMAND_NAMES)[number]; args: string[] } {
  const [first = '', ...args] = line.trim().split(/\s+/)
  const command = first.split('@')[0].toLowerCase()
  return { name: COMMAND_NAMES.find((name) => command === `/${name}`), args }
}

/**
 * Runs a command as if its user had sent the line, and returns its reply as it is sent. Nothing for a line whose
 * reply is one that is still to be made, which only a question's is: no command's is, and no line that is run here
 * is anything but a command.
 */
export async function ran(deps: Deps, telegramId: number, messageId: number, line: string): Promise<Sent | undefined> {
  const said = await reply(deps, telegramId, messageId, line, { kind: 'other' }, () => {})
  if (typeof said === 'string') return [{ text: said }]
  return said
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
