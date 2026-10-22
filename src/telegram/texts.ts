// What the bot says to a user: the texts of its replies and the usage of its commands, with two numbers that such
// texts are made from. What a model is told is not here: see toldOf in ./actions.

import type { Checked, Found, Reported } from '../ai/assistant'
import type { Bonus } from '../catalogue'
import { ATTEMPT_MINUTES } from '../connect'
import { REMINDER_HOUR } from '../domain/reminder'
import { isDatabaseError } from '../log'
import { SOURCES } from '../mcc-lookup'
import {
  MAX_BY_HAND_PER_DAY,
  MAX_CARDS,
  MAX_PATTERN_MERCHANT,
  MAX_PATTERN_SKIPS,
  MAX_PATTERNS,
  MIN_PATTERN_LETTERS,
} from '../store'

/** How far back /status counts. */
export const STATUS_DAYS = 30

/**
 * As long as a question for the assistant may be. A question is in every request that the model is sent over it,
 * and the provider takes only so many tokens in a minute, from all the users of the service together.
 */
export const MAX_QUESTION_LENGTH = 500

export const ADD_CARD_USAGE = `/addcard <nickname> <last4> statement <day>
/addcard <nickname> <last4> calendar`

/** What the bot says of a card that is not added, above the buttons that add it as `nickname`: see addCardEnd. */
export function tapToAddCard(nickname: string): string {
  return (
    `This card is not added yet. Tap below to add it as ${nickname}: by calendar month, or by the day its ` +
    'statement closes.'
  )
}

/** What the bot says under that, of the card that ends in `last4`, for a nickname of the user's own. */
export function addCardOtherwise(last4: string): string {
  return `Or send /addcard <nickname> ${last4} calendar (or statement <day>) to choose another nickname.`
}

/** What the bot says after a press that added a card, whose nickname the bot chose: see addCardEnd. */
export const RENAME_ADDED = 'To change its nickname, send /renamecard <nickname> <new nickname>.'

export const ADD_USAGE = `Usage:
/add <nickname> <amount> <merchant>
/add <nickname> <amount> <date> <merchant>
The amount can have a currency before it, as in USD 12.50. The date is written YYYY-MM-DD.
A day of the card's current window, up to today, can be written D/M or D/M/YY too.
Any other D/M is read as part of the merchant.`

export const BEST_USAGE = 'Usage: /best <merchant>'

export const SORT_USAGE = 'Usage:\n/sort <nickname>\n/sort <purchase id>'

export const PRODUCT_USAGE = 'Usage:\n/product <nickname> <product key>\n/product <nickname> none'

export const RENAME_CARD_USAGE = 'Usage: /renamecard <nickname> <new nickname>'

export const CYCLE_USAGE = 'Usage:\n/cycle <nickname> statement <day>\n/cycle <nickname> calendar'

export const PATTERN_USAGE = `Usage:
/pattern <nickname> <amount> <merchant>
/pattern <nickname> <amount> <merchant> except <YYYY-MM-DD> ...
/pattern <nickname> <merchant> none
The amount is what you spend at the merchant in a month, in the card's own currency.
The merchant has ${MIN_PATTERN_LETTERS} letters or digits or more, in ${MAX_PATTERN_MERCHANT} plain characters at most.
After "except" come the days on which no charge will come, ${MAX_PATTERN_SKIPS} of them at most.`

/** When a reminder comes on its day, as a clock shows it. */
const REMINDER_TIME = `${String(REMINDER_HOUR).padStart(2, '0')}:00`

export const REMIND_USAGE = `Usage:
/remind <nickname> <day>
/remind <nickname> none
The day is a day of the month, from 1 to 31. The reminder comes at ${REMINDER_TIME} on that day, by your time zone.
In a month that has no such day, it comes on the last day of the month.`

export const COMMANDS = `Commands:
/addcard <nickname> <last4> statement <day> - track a card by statement cycle; <day> is the day of the month it closes
/addcard <nickname> <last4> calendar - track a card by calendar month
/cards - list your cards
/removecard <nickname> - stop tracking a card
/renamecard <nickname> <new nickname> - give a card another nickname
/cycle <nickname> statement <day> - change a card to a statement cycle that closes on <day>
/cycle <nickname> calendar - change a card to calendar months
/spend -what you have spent on each card in its current window
/spend <nickname> - every purchase on one card in its current window
/best <merchant> - which of your cards to pay with there, by its bonus and what is left of its cap
/add <nickname> <amount> <merchant> - add a purchase by hand; its date can go before the merchant
/remove <purchase id> - take a purchase out
/products - list the card products whose reward rules are known
/product <nickname> <product key> - link a card to a product, or to none
/sort <nickname> - how a card's purchases are sorted into the reward categories of its product
/sort <purchase id> - move one purchase to another category
/patterns - list what you spend every month at a merchant, which is held back from what is left of a cap
/pattern <nickname> <amount> <merchant> - save such a monthly amount for a card, or remove it with none
/remind <nickname> <day> - be reminded of a card's bill on that day of every month, or remove the reminder with none
/timezone - show the time zone that your cards' windows are counted in
/timezone <name> - change it, for example /timezone Asia/Tokyo
/connect - connect your Gmail, so that your bank's alerts can be read
/status - whether your Gmail is connected, and what has been read from it
/disconnect - disconnect your Gmail
/mcp - let an AI assistant, such as Claude Code, read your card totals and purchases
/mcp revoke - take that access away again
/delete - delete everything stored about you`

export const CONNECT_HEADS_UP =
  `Connecting gives Spend Tracker read-only access to your Gmail. Before you open the link:

1. Google will warn that it has not verified this app. To continue, choose "Advanced", then "Go to ... (unsafe)".
2. If the page says that sign-in is not allowed in this browser, open the link in Safari or Chrome instead.
3. After you approve, the page shows a 6-digit code. Send that code here to finish.

The link works for ${ATTEMPT_MINUTES} minutes:`

export const WELCOME =
  'Welcome to Spend Tracker. It keeps a running total of what you spend on each credit card, ' +
  'for the current statement cycle or calendar month. Cycles and months begin and end by Singapore time ' +
  '(Asia/Singapore), unless you set another time zone with /timezone.'

// What the bot says of its assistant, where it has one. Nobody is asked before a question of theirs is sent to the
// AI provider, so the bot says what is sent: in its welcome, and under the list of its commands when the list is
// sent without the welcome. After what it says of a question, it says that it can be told what to do in the same
// way. Where it reads photos, it says the same of a photo, after those.

export const ASK =
  'You can also just ask a question in your own words, and it is answered by an AI service, which is sent your ' +
  'question and the card and purchase details needed to answer it.'

export const ASK_TOO =
  'Any other message is read as a question, and is answered by an AI service, which is sent your question and the ' +
  'card and purchase details needed to answer it.'

export const DO =
  'You can say what you want done in your own words too, as in "add 5.20 lunch to evol as other spend" or "set my ' +
  'time zone to Tokyo": the same AI service works out what you asked for, and the bot does it.'

export const PHOTO =
  "You can send a photo of your card transactions too, such as a screenshot from your bank's app, and the " +
  'purchases in it are added. A caption can name the card and the category, as in "add these to evol as other ' +
  'spend". The photo is read by the same AI service, which is sent the photo, its caption, your time zone, and ' +
  'the nicknames and category names of your cards.'

export const NO_ASSISTANT =
  'The assistant, which answers questions asked in your own words, is not available on this service. ' +
  'Send /start for the list of commands.'

export const QUESTION_TOO_LONG = `A question can be ${MAX_QUESTION_LENGTH} characters at most.`

/**
 * What a question is answered with at once, so that its user knows that it came: the placeholder, which the reply
 * then takes the place of. It says what to make of it when nothing does, because a Worker that is ended before it
 * is done can say nothing more.
 */
export const WORKING =
  'Working on it… If this message is still here in half a minute, something went wrong. Please ask again.'

export const NOT_ANSWERED = 'That question could not be answered. Try again later, or ask it another way.'

export const TOOK_TOO_LONG = 'That question took too long to answer. Try again later, or ask it another way.'

/**
 * What the placeholder of a message is made to say once the assistant has made out things to do in it, before the
 * first of them is done. Whatever is done for a message is done again for one that is sent again, and purchases are
 * then stored a second time. So from here on the placeholder does not say to ask again, as READING does not.
 */
export const DOING =
  'Doing what you asked… If this message is still here in half a minute, something went wrong. Check /spend ' +
  'before you ask again.'

/**
 * What a message is answered with when the doing of what it asked for has begun and its reply cannot be made in
 * time, or cannot be sent: what PHOTO_READ_NO_REPLY is to a photo. Nothing that is said from then on says to ask
 * again without a look at what is there.
 */
export const DONE_NO_REPLY =
  'What you asked for may have been done, but the bot could not reply to it. Check /spend before you ask again.'

// What the things that the assistant was asked to do are answered with, where the answer is not that of a command.

export const NO_PURCHASES_SAID = 'No purchases to add were found in that message.'

/** What a second lot of purchases in one message is answered with: they are stored under the id of their message. */
export const ONE_ADDING = 'Purchases are added from one message once. Send the others in a message of their own.'

/**
 * What a message is answered with when it was read before: Telegram delivers a message again when it has not heard
 * that the message was taken. It is not read a second time: see readBefore.
 */
export const READ_ALREADY =
  "That message was read already. Look at /spend, and at the bot's earlier messages, for what came of it."

/**
 * What is said of a thing that the assistant asked for and the bot does not do for it: a command that there is not,
 * a line that is no command, and the two that it is given no say in, which are /add and the code of a sign-in.
 */
export const NOT_DONE =
  'Something that you asked for could not be done. Ask for it another way, or send /start for the list of commands.'

export const NO_MORE =
  'The bot does only so much for one message. What is not answered above was not done: ask for it again, a little ' +
  'at a time.'

/**
 * What is said after the replies to what was done, when the model said that there was more to do and could not be
 * asked what: the provider refused the request, or did not answer it in time. See actInRounds.
 */
export const REST_NOT_DONE = 'The rest of what you asked for was not done. Ask for it again.'

/** What follows an answer that went by merchant codes that the assistant's model worked out itself. */
export function assumedCodes(codes: number[]): string {
  const named = codes.map((code) => String(code).padStart(4, '0'))
  return codes.length === 1
    ? `Code ${named[0]} is assumed: the usual code for that kind of business, not one the bot found.`
    : `Codes ${named.join(', ')} are assumed: the usual codes for that kind of business, not ones the bot found.`
}

/**
 * What follows an answer for a merchant that card_rules was asked about: what placed it. That is what each lookup
 * service lists for it, those that list a store first, or the bot's own list, or the user's mark, or that nothing
 * did, so that a code shown for it is inferred.
 */
export function foundLine(merchant: string, found: Found): string {
  const ands = new Intl.ListFormat('en')
  switch (found.by) {
    case 'reports':
      return `${merchant}: ${reportsSaid(found.reported)}.`
    case 'list':
      return `${merchant}: the bot's own list gives ${codeNamed(found.mcc, found.name)}.`
    case 'mark':
      return found.products.length === 0
        ? `${merchant}: placed as you marked it before.`
        : `${merchant}: placed as you marked it before, on the ${ands.format(found.products)}.`
    case 'none':
      return `${merchant}: no store was found for it on ${SOURCES.join(' or ')}, so any codes below are inferred.`
  }
}

/** What each lookup service lists, those that list a store first. */
function reportsSaid(reported: Reported[]): string {
  const listed = (source: string) =>
    reported.filter((one) => one.source === source).map(({ store, mcc, name }) => `${store} as ${codeNamed(mcc, name)}`)
  const listing = SOURCES.filter((source) => listed(source).length > 0)
  return [
    ...listing.map((source) => `${source} lists ${new Intl.ListFormat('en').format(listed(source))}`),
    ...SOURCES.filter((source) => !listing.includes(source)).map((source) => `${source} has nothing`),
  ].join('; ')
}

/**
 * The bot's answer to a question that card_rules looked at codes for, in the place of the model's: each card once,
 * those that earn their bonus on some of the codes first, with them, the most first, then those that do if paid
 * online, then the rest.
 */
export function verdictLine({ cards, rows }: Checked): string {
  const each = cards.map((card, at) => ({
    card,
    codes: rows.filter(({ on }) => on[at].bonus === 'yes').map(({ mcc }) => String(mcc).padStart(4, '0')),
    depends: rows.find(({ on }) => on[at].bonus === 'depends')?.on[at],
  }))
  const earning = each
    .filter(({ codes }) => codes.length > 0)
    .sort((one, other) => other.codes.length - one.codes.length)
  // A card that earns on none of the codes is said as its cells say it: see `bonusCell`.
  const others = new Map<string, string[]>()
  const rest = each.filter(({ codes }) => codes.length === 0)
  const dependsFirst = [...rest.filter(({ depends }) => depends), ...rest.filter(({ depends }) => !depends)]
  for (const { card, depends } of dependsFirst) {
    const said = depends ? `Bonus ${bonusCell(depends.bonus, depends.group).toLowerCase()}` : bonusCell('no', undefined)
    others.set(said, [...(others.get(said) ?? []), card])
  }
  const ands = new Intl.ListFormat('en')
  return [
    ['Bonus on these codes', earning.map(({ card, codes }) => `${card} (${codes.join(', ')})`)] as const,
    ...others,
  ]
    .filter(([, listed]) => listed.length > 0)
    .map(([said, listed]) => `${said}: ${ands.format(listed)}.`)
    .join(' ')
}

/** A merchant category code with its published name, when it has one: "5734 Computer Software Stores". */
export function codeNamed(mcc: number, name: string | undefined): string {
  const code = String(mcc).padStart(4, '0')
  return name === undefined ? code : `${code} ${name}`
}

/**
 * How a card counts a code, in the table after an answer. Where that depends on how a purchase is paid, it is said by
 * the group that the purchase would then be in: "Online Spend" as "If paid online".
 */
export function bonusCell(bonus: Bonus, group: string | undefined): string {
  if (bonus === 'yes') return 'Bonus'
  if (bonus === 'no') return 'No bonus'
  return group === undefined ? 'Depends' : `If paid ${group.replace(/ Spend$/, '').toLowerCase()}`
}

/** What goes before a command that is too long to ride under a button: see confirmButtons. */
export const SEND_YOURSELF = 'The bot does this only when you send the command yourself:'

// What the press of a button under a message that asks before a command is run is answered with, and what the
// message then says under what it asked. After "Do it" that is where to look, and not what came of it: the command
// may have replied that it could not be done.

export const SEE_REPLY = 'See the reply below.'

export const CANCELLED = 'Cancelled. Nothing was changed.'

/**
 * What a photo is answered with at once: its placeholder, as WORKING is that of a question. A Worker that is ended
 * before it is done may have stored purchases of the photo by then, and a photo that is sent again stores its
 * purchases a second time. So this one does not say to send the photo again.
 */
export const READING =
  'Reading your photo… If this message is still here in half a minute, something went wrong. Check /spend before ' +
  'you send the photo again.'

// What a photo that nothing was added from is answered with, in the place of its placeholder. Nothing of it is
// stored when one of these is said, so each can say to send a photo again.

export const NO_PURCHASES = 'No purchases to add were found in that photo.'

export const PHOTO_NOT_READ = 'That photo could not be read. Send a clearer photo, or add its purchases with /add.'

export const PHOTO_TOOK_TOO_LONG = 'That photo took too long to read. Try again later, or add its purchases with /add.'

export const PHOTO_TOO_LARGE = 'That photo is too large to read. Crop it to the purchases, and send it again.'

/**
 * What a photo is answered with when a purchase of it is stored, or is held for its user to answer for, and
 * something fails after that, or its time runs out: what STORED_NO_REPLY is to an /add. A photo that is sent again
 * is a message with a new id. It stores its purchases a second time, and those that are held are then asked about
 * twice, under two messages whose buttons both add them. So from the storing or the holding of the first of them
 * on, nothing that is said of a photo says to send it again. The message that asks about what is held may be in the
 * chat by then, under this one or over it: so it says to look at the bot's other messages, and not where.
 */
export const PHOTO_READ_NO_REPLY =
  "The purchases in your photo were read, but the bot could not finish its reply. Check /spend and the bot's " +
  'other messages before you send the photo again.'

export const NO_CARDS = `You have no cards yet. Add one with:\n${ADD_CARD_USAGE}`

/** What follows a card's total whose amounts in other currencies have what they come to in its own beside them. */
export const AT_REFERENCE_RATES = "≈ at today's reference rates; the bank's rate and fees differ."

export const NONE_LINKED =
  'None of your cards is linked to a product, so the bot does not know where a purchase would earn a bonus. To ' +
  'link one, send /product <nickname> <product key>.'

/** What /best says first: the card to use, and what the order goes by. */
export function useCard(card: string): string {
  return `Use ${card}. Ranked by bonus and caps (the bot does not know earn rates):`
}

export const TOO_MANY_CARDS =
  `You have ${MAX_CARDS} cards, which is as many as can be tracked. To add another, first remove one with ` +
  '/removecard <nickname>.'

// What /product says besides of a card that had another product: in its reply, and in what is asked before it is
// run for the assistant.

export const SORTED_AGAIN =
  'The purchases of its current window are sorted again by the rules of that product, and what you marked by hand ' +
  'is forgotten.'

export const WILL_SORT_AGAIN =
  'The purchases of its current window will be sorted again by the rules of that product, and what you marked by ' +
  'hand will be forgotten.'

export const NO_PATTERNS =
  'You have no monthly patterns. To have what you spend at a merchant every month held back from what is left of ' +
  "a card's cap, send /pattern <nickname> <amount> <merchant>."

export const TOO_MANY_PATTERNS =
  `You have ${MAX_PATTERNS} patterns, which is as many as can be kept. To save another, first remove one with ` +
  '/pattern <nickname> <merchant> none.'

export const NO_SUCH_PATTERN = 'That card has no such pattern. Send /patterns for the ones that you have.'

/** How the reply to a save begins what it says of a pattern that holds nothing back of any cap, before why. */
export const HOLDS_NOTHING = 'It holds nothing back:'

// What goes over the line that shows a pattern: what /pattern did with it, and what is asked before /pattern is run
// for the assistant.

export const PATTERN_SAVED = 'Saved this pattern:'

export const PATTERN_REMOVED = 'Removed this pattern:'

export const SAVE_PATTERN = 'Save this pattern? It replaces the one that the card has for this merchant, if it has one.'

export const REMOVE_PATTERN = 'Remove this pattern?'

/** What a monthly review says first. A message that asks as SAVE_PATTERN does comes after it for each offer. */
export const REVIEW =
  'Monthly review: each message below names a card and a merchant that you paid with it in both of the last two ' +
  'months, with what you spent there last month. Saved as a pattern, that amount is held back every month from ' +
  'what is left of a cap of the card, until it is spent. Nothing is saved unless you press "Do it".'

// What the bot says of the reminder of a card's bill. `card` is the card as the bot names one: see `label` in
// ./replies.

/** What a reminder says. */
export function billDue(card: string): string {
  return `Reminder: the bill of ${card} is due.`
}

/** What /remind answers once a reminder is set. `next` is when the next one comes, by the clock of `timeZone`. */
export function reminderSet(card: string, day: number, next: string, timeZone: string): string {
  return (
    `You will be reminded of the bill of ${card} on day ${day} of every month. The next reminder comes on ${next} ` +
    `(${timeZone}).`
  )
}

export function reminderRemoved(card: string): string {
  return `${card} has no reminder now.`
}

// What is asked before /remind is run for the assistant.

export function askReminder(card: string, day: number): string {
  return `Remind you of the bill of ${card} on day ${day} of every month?`
}

export function askNoReminder(card: string): string {
  return `Remove the reminder of ${card}?`
}

export const TOO_MANY_BY_HAND =
  `You have added ${MAX_BY_HAND_PER_DAY} purchases by hand in the last 24 hours, which is as many as can be added ` +
  'in that time. Try again later.'

// What the bot says around the purchases that it asks about once it has added them, because no rule placed them:
// see `unplaced` in ../catalogue. Where each counts until it is marked is said in its own message.

/** What goes before them: why they are asked about. */
export const NOT_PLACED = 'Not placed by any rule, so each counts as shown until you mark it:'

/** What comes after them when there are more than are asked about. What told of the adding lists those by id. */
export function moreNotPlaced(count: number): string {
  return `Not asked about: ${count} more of those listed above. /sort <purchase id> asks about one.`
}

export const TIMEZONE_USAGE = '/timezone <IANA name>, for example /timezone Asia/Tokyo'

export const NO_SIGN_IN =
  'No sign-in is waiting for a code. It may have expired, or had too many wrong codes. Send /connect to start again.'

// What a message that the bot does not read is answered with, so that nobody waits for the answer to one.

export const NOT_TEXT =
  'The bot only reads text messages. It cannot read an attachment, such as a photo, a file or a voice message, or ' +
  'the caption under one. Please send your question or command as text.'

/** The same, where the bot reads photos. A picture that is sent as a file is no photo, and is not read. */
export const NOT_TEXT_OR_PHOTO =
  'The bot reads text messages and photos. It cannot read any other attachment, such as a file or a voice message, ' +
  'or the caption under one. Please send your question or command as text, and a picture of your card ' +
  'transactions as a photo and not as a file.'

export const EDITED = 'The bot does not read a message again after it has been edited. Please send it as a new message.'

// What an update is answered with when the handling of it fails, so that nobody waits for an answer that is not
// coming: a message, or what a press of a button is answered with, which Telegram shows for a moment.

export const FAILED = "Something went wrong on the bot's side. Please try again in a moment."

/**
 * What an /add is answered with when a purchase for its message is stored and something fails after that: the
 * reading of what its card then comes to, or the sending of the reply. It does not say to try again, as FAILED
 * does. An /add that is sent again is a message with a new id, and stores the purchase a second time. No other
 * command does harm when it is sent again, and some have to be: the token that /mcp makes is nowhere but in its
 * reply, and neither is the link of /connect. So whatever else fails is answered with FAILED, the sending of a
 * reply included.
 */
export const STORED_NO_REPLY =
  'Your purchase was stored, but the bot could not reply to it. Check it with /spend before adding it again.'

export const PRESS_FAILED = 'Something went wrong. Please try again in a moment.'

/** What a failure that says to try again says instead when it was the database that failed. */
export const DATABASE_DOWN =
  "The bot's database is not answering right now, which is a problem at Cloudflare. Please try again later."

/** The failure texts that say to try again. The others say that something may have been done, and stay as they are. */
const TRY_AGAIN = new Set([FAILED, PRESS_FAILED, NOT_ANSWERED, PHOTO_NOT_READ])

/**
 * What a user is told when something failed with `error`: `text`, or DATABASE_DOWN in its place, and then the
 * reference of the request, which finds its lines in the log: see `ray` in ../deps. Nothing of the error is said.
 */
export function failureReply(text: string, error: unknown, ray: string | undefined): string {
  const said = isDatabaseError(error) && TRY_AGAIN.has(text) ? DATABASE_DOWN : text
  return ray ? `${said} Ref: ${ray}` : said
}
