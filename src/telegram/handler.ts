import { answerQuestion, type Action, type Answer } from '../ai/assistant'
import { asPhotoCard, MAX_PURCHASES_PER_PHOTO, readPhoto, type PhotoReading } from '../ai/photo'
import type { AiProvider } from '../ai/provider'
import { categoriesOf, categoryName, categoryOf, choicesOf, productOf, products } from '../catalogue'
import type { Product } from '../catalogue/types'
import { ATTEMPT_MINUTES, confirmCode, disconnect, startConnect } from '../connect'
import type { Deps } from '../deps'
import { breakDown, perCurrency } from '../domain/breakdown'
import { sortByRules, startingCategoryOn, WINDOW_LIMIT } from '../domain/sorting'
import { cardTotals, type CardTotals } from '../domain/totals'
import { countedIn, currentWindow, dayOf, startOfDay } from '../domain/window'
import { Failure, log, logFailure, type Events } from '../log'
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
  type Sourced,
  type Store,
  type Transaction,
  type User,
} from '../store'
import { connectStoreFor, type Connection } from '../store-connect'
import { heldStoreFor, type HeldPurchase } from '../store-held'
import { mailStoreFor, type MailSummary } from '../store-mail'
import { mcpStoreFor } from '../store-mcp'
import {
  ChatBlockedError,
  TelegramError,
  type MessageEntity,
  type Messenger,
  type Outgoing,
  type RichBlock,
  type RichMessage,
  type RichText,
  type TableCell,
} from './api'
import {
  carriedNotes,
  COUNTED_BY_POSTING,
  countedDays,
  describeCounted,
  describeTotals,
  describeWindow,
  formatShortDate,
  formatShortDateTime,
  formatTotals,
  maskLast4,
  shortDateIn,
} from './format'
import {
  BY_HAND_NOTE,
  breakdownLines,
  confirmButtons,
  heldButtons,
  heldLine,
  inMessages,
  MAX_LENGTH,
  purchaseBlocks,
  purchaseLine,
  purchaseTables,
  readConfirmPress,
  readHeldPress,
  readPress,
  sectionsOf,
  sortEnd,
  UNSURE_NOTE,
  whereSorted,
  type Dated,
  type Line,
  type Section,
  type Table,
} from './purchases'

/** The parts of a Telegram update this bot reads. All optional, because it arrives as unchecked JSON. */
export interface Update {
  message?: {
    /** Telegram's id of the message, which no other message in its chat has. A delivery that is repeated has it too. */
    message_id?: number
    /**
     * What a message of text says. A message of anything else has none: the words under a photo or a file are its
     * caption.
     */
    text?: string
    /**
     * A photo, in each of the sizes that Telegram keeps it in. Each has the id that its file is asked for by, how
     * wide and how high it is and, most of the time, how many bytes its file has.
     */
    photo?: { file_id?: string; width?: number; height?: number; file_size?: number }[]
    /** The words under a photo or a file. The bot reads those under a photo, where it reads photos, and no others. */
    caption?: string
    chat?: { id?: number; type?: string }
    from?: { id?: number }
    /**
     * What a message holds that Telegram wrote in the chat itself, to note that a message was pinned there, or that
     * the timer which deletes the chat's messages was set. The bot reads neither: only that one of them is there.
     */
    pinned_message?: unknown
    message_auto_delete_timer_changed?: unknown
  }
  /** A message as it stands after it was edited, which Telegram posts in the place of `message` then. */
  edited_message?: Update['message']
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

/** One reply as it is sent: a rich message, which goes as text when Telegram does not take it, or messages of text. */
type Sent = Tabled | Outgoing[]

/**
 * What the making of a reply that was left for later comes to. It is the reply, which is sent in messages of its
 * own: a rich message, messages of text after it, or both. Or it is several replies, to be sent in their order: one
 * for each thing that the assistant was asked to do. Or it is what its user is told in the place of one, with what
 * went wrong when something did: a question that was not answered, or a photo that nothing was added from.
 */
type Made<Outcome> =
  | { outcome: Outcome; rich?: Tabled; text?: Outgoing[] }
  | { outcome: Outcome; replies: Sent[] }
  | { outcome: Outcome; notice: string; error?: unknown }

/**
 * A reply that is still to be made: the answer to a question, or what came of the reading of a photo. A model takes
 * seconds over either, and Telegram posts an update again when it has waited too long to hear that the update was
 * taken. So such a reply is made, and sent, once Telegram has heard that: see sendLater.
 */
interface Deferred<Outcome extends string> {
  /** What the chat is sent at once, which the reply then takes the place of: see WORKING. */
  placeholder: string
  /**
   * What the log has of the reply as far as the sending of it goes, which sendLater notes here. The making notes
   * what it learns in the same place, so that the line has as much as was learnt, however the reply ends.
   */
  noted: { outcome: Outcome | 'blocked'; sent: Asked['sent']; placeholder: boolean }
  /**
   * Makes the reply. When it throws, the reply is one that could not be made. `instead` has the placeholder say
   * something else from then on, for a making that gets to where what the placeholder says is no longer so.
   */
  make(instead: (text: string) => Promise<void>): Promise<Made<Outcome>>
  /** What the making comes to when the reply is not made in its time: see REPLY_TIME. */
  late(): Made<Outcome>
  /** What its user is told when the reply could not be made, or could not be sent. */
  failed(): string
  /**
   * Writes the line that the log has of the reply, once it has ended: after `ms` milliseconds, and with what went
   * wrong, when anything did.
   */
  record(ms: number, wrong: unknown): void
}

/**
 * What is left to be done about an update once Telegram has been told that the update was taken: see Deferred. It
 * does not throw: what comes of it is logged, as what came of the update was.
 */
export type Later = () => Promise<void>

/**
 * What the log has of an update besides what came of it: what the update is. It is noted as soon as it is known, so
 * that an update whose handling fails is logged as what it was. See `update` in ../log.
 */
type Seen = Pick<Events['update'], 'kind' | 'command' | 'why'>

/** The handling of one update, as it goes on. */
interface Handling {
  seen: Seen
  /**
   * Whether what the update asked for has been done, so that only the telling of it is left: which the log has of
   * an update whose handling fails. A message is handled once its reply has been made, and a press once it is to
   * be answered. An /add is the exception: it is handled once a purchase for its message is stored, and not before.
   */
  handled: boolean
  /**
   * Tells whoever sent the update that the handling of it failed, in the words for how far the handling had got.
   * There is none before the update is known to be one to answer, and none for a press that has been answered, as
   * Telegram takes one answer to a press.
   */
  tell?: () => Promise<void>
}

/**
 * What the log has of a question, but for how long its answering took. It is noted as the answering goes on, so that
 * a question is logged with as much as was learnt of it, however its answering ends. See `question` in ../log.
 */
type Asked = Omit<Events['question'], 'ms'>

/**
 * What the log has of a photo, but for how long its reading took, and for what was done with the purchases that
 * were read from it, which is noted where it is done: see Adding. See `photo` in ../log.
 */
type Read = Omit<Events['photo'], 'stored' | 'held' | 'ms'>

/** One of the sizes that Telegram keeps a photo in, as far as the bot goes by it. */
interface PhotoSize {
  /** What its file is asked for by. */
  fileId: string
  /** How many pixels it has: its width by its height. */
  pixels: number
  /** How many bytes its file has, when Telegram says. */
  bytes?: number
}

/**
 * A reading of purchases to add, as `readPhoto` gives one when it found some. Nothing in it says what it was read
 * from, and what is done with one is the same whatever that was: see addRead.
 */
export type Reading = Extract<PhotoReading, { status: 'read' }>

/**
 * How far the adding of a reading's purchases has got. Whoever waits for the adding shares this with it. The adding
 * notes here what it has done, as it does it, so that the log has that however the adding ends, and so that nobody
 * is told to send again a message whose purchases are stored. And whoever waits notes here when they wait no longer.
 */
export interface Adding {
  /** How many purchases the adding has stored. */
  stored: number
  /** How many it holds, for their user to answer for. */
  held: number
  /**
   * Whether a purchase for the message is in the store, or is on its way there: one that this adding stored or is
   * storing, or one that an earlier delivery of the message stored. A message that is sent again is a new message,
   * and stores its purchases a second time. So from then on its user is not to be told to send it again.
   */
  kept: boolean
  /**
   * Whether the time of whoever waits for the adding is up, which is theirs to note. By then the user has been told
   * that it took too long, and may send the message again. So from then on the adding stores nothing.
   */
  late: boolean
}

/**
 * How far the doing of what the assistant was asked to do has got. Whoever waits for it shares this with it, as an
 * adding is shared: the adding of purchases is one of the things that can be asked for, and notes its own part here.
 */
interface Doing extends Adding {
  /**
   * Whether the doing has begun. From then on something may be done that a second asking would do again. So from
   * then on the user is not to be told to ask again without a look at what is there.
   */
  begun: boolean
}

/** How many queries the things that are done for one message may still run: see ACTION_QUERIES. */
interface Room {
  left: number
}

/**
 * What the actions of one answer are carried out for, and within what: the user who asked, the ids that Telegram
 * knows them and their message by, how far the doing has got, and the queries that are left for it.
 */
interface Asking {
  user: User
  telegramId: number
  messageId: number
  doing: Doing
  room: Room
  /**
   * Whether a tool that reads had given the model anything before it asked for these: see `Answer` in
   * ../ai/assistant. What a tool returns holds text that somebody else wrote, as the name of a merchant is, and a
   * model can take such text for its user's wish. So what it asks for after it has read is trusted less: see act.
   */
  afterReading: boolean
}

/**
 * What the carrying out of one action came to: the replies to it, in their order, and what the log has of it. An
 * action is `asked` when nothing of it is done until its user presses a button.
 */
interface Carried {
  replies: Sent[]
  outcome: 'done' | 'asked' | 'refused'
  /** How many purchases an adding stored, and how many it holds. */
  stored?: number
  held?: number
}

/**
 * What an action comes to: what its carrying out came to, or that it was not begun. It is `full` when there was no
 * room left for it, and `late` when the time of whoever waits was up.
 */
type Came = Carried | 'full' | 'late'

/**
 * What the carrying out of the actions of one answer came to: the replies, in their order, and what came of each
 * action. `outcomes` is there when every action was carried out, and is missing when the carrying out ended at one
 * that failed, or at one that there was no room for: the model is then asked for nothing more.
 */
interface Acted {
  replies: Sent[]
  outcomes?: Carried['outcome'][]
}

/** An answer of the assistant's that asks for things to be done: see `Answer` in ../ai/assistant. */
type Acting = Extract<Answer, { status: 'acting' }>

/** Purchases that are stored on one card: its last four digits, and the card, when their user has one with those. */
interface OnCard {
  last4: string
  card?: Card
  purchases: Dated[]
}

/**
 * What the user of a reading is told of the adding of its purchases: those that were added, as a reply that is sent
 * as a rich message, and after it the messages of text, which are the purchases that are held, with their buttons,
 * and what there is to know besides. A reading that left nothing to tell of has neither.
 */
export interface Added {
  rich?: Tabled
  text: Outgoing[]
}

/** What became of purchases that were to be stored for a message: see `keep`. */
interface Kept {
  /** Those that are stored, in the order given: by this storing of them or by an earlier one, and not taken out. */
  added: Transaction[]
  /** How many of them this storing stored. */
  stored: number
  /** How many an earlier storing stored, that their user has taken out since. These are not stored again. */
  takenOut: number
  /** How many were not stored, because their user has added as many purchases by hand as a user may in 24 hours. */
  leftOut: number
}

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

/**
 * The most bytes of a photo that the bot fetches to have it read: about 400 KB. Telegram keeps a photo in several
 * sizes, and the one that is read is the largest that is no more than this. A photo goes to the model as text, in
 * base64, and the encoding of it costs CPU time, of which an invocation has about 10 ms on the free plan.
 */
const MAX_PHOTO_BYTES = 400_000

/** What a photo is, as the model is told it. Telegram keeps a photo as a JPEG, whatever it was sent as. */
const PHOTO_MIME = 'image/jpeg'

/**
 * How often a chat is shown that the bot is writing while a reply that was left for later is made, in milliseconds.
 * Telegram shows it for five seconds at most.
 */
const TYPING_EVERY = 4_000

/**
 * How long a reply that was left for later is waited for, in milliseconds, from when the making of it begins: the
 * answer to a question, or what came of a photo. A Worker is given 30 seconds after its response, and what is left
 * of them is for telling the user what came of it. It is more than the assistant gives the model in all, so a model
 * that is slow is the assistant's to stop: see ANSWER_TIME in ../ai/assistant. And it is more than the reading of a
 * photo gives the model, which is the reading's to stop: see CALL_TIMEOUT in ../ai/photo.
 */
const REPLY_TIME = 27_000

/** The most blocks that Telegram takes in a rich message: see RichMessage. An answer has one to each of its lines. */
const MAX_PARAGRAPHS = 500

/**
 * The names of the bot's commands, each without its slash. What a message begins with is text from outside, so the
 * log has a command only as the name that it is known to be.
 */
const COMMAND_NAMES = [
  'start',
  'addcard',
  'cards',
  'products',
  'product',
  'removecard',
  'renamecard',
  'spend',
  'add',
  'remove',
  'sort',
  'timezone',
  'connect',
  'code',
  'status',
  'disconnect',
  'mcp',
  'delete',
] as const

/**
 * The commands that the assistant has run at once, as if their user had sent them: the adding of a card, the
 * renaming of one, the linking of one to a product and the changing of the time zone, each of which is undone in
 * one step, and those that only show things. It is a list of what is run, and not of what is not: a command that the
 * bot is given later is run for no model until somebody puts it here. See runAsked for what becomes of every other
 * line.
 */
const RUN_AT_ONCE = [
  'addcard',
  'renamecard',
  'product',
  'timezone',
  'cards',
  'spend',
  'sort',
  'products',
  'status',
] as const

/**
 * Those of them that change something. They are asked about first, as the commands below are, when the model had
 * read with a tool before it asked for them: see Asking.
 */
const CHANGING = ['addcard', 'renamecard', 'product', 'timezone'] as const

/**
 * The commands that are asked about first, whatever the model had read: those that remove or revoke. They are the
 * taking out of a purchase or of a card, the giving up of the access to a Gmail, the removing of an assistant's
 * token, the making of a new one, which ends the one that there is, and the starting of a sign-in, which cancels
 * one that is waiting for its code. The assistant runs none of them: each waits for its user to press a button.
 */
const ASKED_FIRST = ['remove', 'removecard', 'disconnect', 'mcp', 'connect'] as const

/**
 * The commands that a press of "Do it" may run: those that a message can have asked about, and no others. See
 * pressConfirm.
 */
const CONFIRMABLE = [...ASKED_FIRST, ...CHANGING] as const

/**
 * The most queries that the things which are done for one message may run between them, each counted at the most
 * that it can run: the actions of all the answers that the model gives to the message, when it gives them one at a
 * time. An action that there is no room left for is not begun, and neither is any after it: see act.
 *
 * A request may run 50 queries, and the answering runs its own. Two of them are run for every message: one for the
 * user, and one for their cards. The calls of the tool that reads can run twelve besides, whether they give the
 * model a listing or are told what is wrong with them: six of them are answered for a question, however many
 * answers it has, and a listing is two queries. See MAX_TOOL_CALLS in ../ai/assistant. That is 14 at the most, so
 * the actions leave a request inside the 50, whether or not anything was read for the model before it asked for
 * them.
 */
const ACTION_QUERIES = 30

/**
 * The most queries that the adding of a reading's purchases runs: the cards, the two that look whether the message
 * was read before, the storing, the look for what the limit left out, the holding, and the total of each card that
 * the purchases are on. That is one card, and two only for a message of which two deliveries were read at once.
 */
const ADD_QUERIES = 8

/**
 * The most queries that a command runs, but for /spend with no card named, which runs one for each card and two
 * more. The most is that of /product: the user, the cards, the linking, the purchases of the card's window, and a
 * statement for each category that a rule of the product gives, of which the one product that there is has two.
 */
const COMMAND_QUERIES = 6

/**
 * The most cards that are each shown in full when the assistant is asked to show what was spent on every card: see
 * showAsked. Each is a rich message of its own, and five of those are as many as one message of the user's should
 * set off. A user with more cards is shown what /spend with no card named shows, which is one message.
 */
const SHOWN_IN_FULL = 5

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

const RENAME_CARD_USAGE = 'Usage: /renamecard <nickname> <new nickname>'

const COMMANDS = `Commands:
/addcard <nickname> <last4> statement <day> - track a card by statement cycle; <day> is the day of the month it closes
/addcard <nickname> <last4> calendar - track a card by calendar month
/cards - list your cards
/removecard <nickname> - stop tracking a card
/renamecard <nickname> <new nickname> - give a card another nickname
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
// sent without the welcome. After what it says of a question, it says that it can be told what to do in the same
// way. Where it reads photos, it says the same of a photo, after those.

const ASK =
  'You can also just ask a question in your own words, and it is answered by an AI service, which is sent your ' +
  'question and the card and purchase details needed to answer it.'

const ASK_TOO =
  'Any other message is read as a question, and is answered by an AI service, which is sent your question and the ' +
  'card and purchase details needed to answer it.'

const DO =
  'You can say what you want done in your own words too, as in "add 5.20 lunch to evol as other spend" or "set my ' +
  'time zone to Tokyo": the same AI service works out what you asked for, and the bot does it.'

const PHOTO =
  "You can send a photo of your card transactions too, such as a screenshot from your bank's app, and the " +
  'purchases in it are added. A caption can name the card and the category, as in "add these to evol as other ' +
  'spend". The photo is read by the same AI service, which is sent the photo, its caption, your time zone, and ' +
  'the nicknames and category names of your cards.'

const NO_ASSISTANT =
  'The assistant, which answers questions asked in your own words, is not available on this service. ' +
  'Send /start for the list of commands.'

const QUESTION_TOO_LONG = `A question can be ${MAX_QUESTION_LENGTH} characters at most.`

/**
 * What a question is answered with at once, so that its user knows that it came: the placeholder, which the reply
 * then takes the place of. It says what to make of it when nothing does, because a Worker that is ended before it
 * is done can say nothing more.
 */
const WORKING =
  'Working on it… If this message is still here in half a minute, something went wrong. Please ask again.'

const NOT_ANSWERED = 'That question could not be answered. Try again later, or ask it another way.'

const TOOK_TOO_LONG = 'That question took too long to answer. Try again later, or ask it another way.'

/**
 * What the placeholder of a message is made to say once the assistant has made out things to do in it, before the
 * first of them is done. Whatever is done for a message is done again for one that is sent again, and purchases are
 * then stored a second time. So from here on the placeholder does not say to ask again, as READING does not.
 */
const DOING =
  'Doing what you asked… If this message is still here in half a minute, something went wrong. Check /spend ' +
  'before you ask again.'

/**
 * What a message is answered with when the doing of what it asked for has begun and its reply cannot be made in
 * time, or cannot be sent: what PHOTO_READ_NO_REPLY is to a photo. Nothing that is said from then on says to ask
 * again without a look at what is there.
 */
const DONE_NO_REPLY =
  'What you asked for may have been done, but the bot could not reply to it. Check /spend before you ask again.'

// What the things that the assistant was asked to do are answered with, where the answer is not that of a command.

const NO_PURCHASES_SAID = 'No purchases to add were found in that message.'

/** What a second lot of purchases in one message is answered with: they are stored under the id of their message. */
const ONE_ADDING = 'Purchases are added from one message once. Send the others in a message of their own.'

/**
 * What a message is answered with when it was read before: Telegram delivers a message again when it has not heard
 * that the message was taken. It is not read a second time: see readBefore.
 */
const READ_ALREADY =
  "That message was read already. Look at /spend, and at the bot's earlier messages, for what came of it."

/**
 * What is said of a thing that the assistant asked for and the bot does not do for it: a command that there is not,
 * a line that is no command, and the two that it is given no say in, which are /add and the code of a sign-in.
 */
const NOT_DONE =
  'Something that you asked for could not be done. Ask for it another way, or send /start for the list of commands.'

const NO_MORE =
  'The bot does only so much for one message. What is not answered above was not done: ask for it again, a little ' +
  'at a time.'

/**
 * What is said after the replies to what was done, when the model said that there was more to do and could not be
 * asked what: the provider refused the request, or did not answer it in time. See actInRounds.
 */
const REST_NOT_DONE = 'The rest of what you asked for was not done. Ask for it again.'

/** What goes before a command that is too long to ride under a button: see confirmButtons. */
const SEND_YOURSELF = 'The bot does this only when you send the command yourself:'

// What the press of a button under a message that asks before a command is run is answered with, and what the
// message then says under what it asked.

const CONFIRMED_DONE = 'Done.'

const CANCELLED = 'Cancelled. Nothing was changed.'

/**
 * What a photo is answered with at once: its placeholder, as WORKING is that of a question. A Worker that is ended
 * before it is done may have stored purchases of the photo by then, and a photo that is sent again stores its
 * purchases a second time. So this one does not say to send the photo again.
 */
const READING =
  'Reading your photo… If this message is still here in half a minute, something went wrong. Check /spend before ' +
  'you send the photo again.'

// What a photo that nothing was added from is answered with, in the place of its placeholder. Nothing of it is
// stored when one of these is said, so each can say to send a photo again.

const NO_PURCHASES = 'No purchases to add were found in that photo.'

const PHOTO_NOT_READ = 'That photo could not be read. Send a clearer photo, or add its purchases with /add.'

const PHOTO_TOOK_TOO_LONG = 'That photo took too long to read. Try again later, or add its purchases with /add.'

const PHOTO_TOO_LARGE = 'That photo is too large to read. Crop it to the purchases, and send it again.'

/**
 * What a photo is answered with when a purchase of it is stored, or is held for its user to answer for, and
 * something fails after that, or its time runs out: what STORED_NO_REPLY is to an /add. A photo that is sent again
 * is a message with a new id. It stores its purchases a second time, and those that are held are then asked about
 * twice, under two messages whose buttons both add them. So from the storing or the holding of the first of them
 * on, nothing that is said of a photo says to send it again. The message that asks about what is held may be in the
 * chat by then, under this one or over it: so it says to look at the bot's other messages, and not where.
 */
const PHOTO_READ_NO_REPLY =
  "The purchases in your photo were read, but the bot could not finish its reply. Check /spend and the bot's " +
  'other messages before you send the photo again.'

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

// What a message that the bot does not read is answered with, so that nobody waits for the answer to one.

const NOT_TEXT =
  'The bot only reads text messages. It cannot read an attachment, such as a photo, a file or a voice message, or ' +
  'the caption under one. Please send your question or command as text.'

/** The same, where the bot reads photos. A picture that is sent as a file is no photo, and is not read. */
const NOT_TEXT_OR_PHOTO =
  'The bot reads text messages and photos. It cannot read any other attachment, such as a file or a voice message, ' +
  'or the caption under one. Please send your question or command as text, and a picture of your card ' +
  'transactions as a photo and not as a file.'

const EDITED = 'The bot does not read a message again after it has been edited. Please send it as a new message.'

// What an update is answered with when the handling of it fails, so that nobody waits for an answer that is not
// coming: a message, or what a press of a button is answered with, which Telegram shows for a moment.

const FAILED = "Something went wrong on the bot's side. Please try again in a moment."

/**
 * What an /add is answered with when a purchase for its message is stored and something fails after that: the
 * reading of what its card then comes to, or the sending of the reply. It does not say to try again, as FAILED
 * does. An /add that is sent again is a message with a new id, and stores the purchase a second time. No other
 * command does harm when it is sent again, and some have to be: the token that /mcp makes is nowhere but in its
 * reply, and neither is the link of /connect. So whatever else fails is answered with FAILED, the sending of a
 * reply included.
 */
const STORED_NO_REPLY =
  'Your purchase was stored, but the bot could not reply to it. Check it with /spend before adding it again.'

const PRESS_FAILED = 'Something went wrong. Please try again in a moment.'

/**
 * Answers a text message that a user sent in their private chat with the bot, or their press of a button under one
 * of the bot's messages there. Where the bot reads photos, it reads a photo that is sent there too, and adds the
 * purchases in it. Any other message there that is not text, and one of text that was edited, are answered with
 * that the bot does not read them. Every other update is ignored.
 *
 * Everything is done by the time this returns but the answering of a question and the reading of a photo, which are
 * returned to be done once Telegram has been told that the update was taken: see Later.
 *
 * It does not throw. Whatever comes of an update is logged, with what the update was and how long the handling of
 * it took. When that fails, whoever sent the update is told so: see tellOfFailure.
 */
export async function handleUpdate(deps: Deps, update: Update): Promise<Later | void> {
  const began = deps.now().getTime()
  const handling: Handling = { seen: { kind: 'other' }, handled: false }
  try {
    const later = await handle(deps, update, handling)
    const { kind, command, why } = handling.seen
    // What is not ignored, and is not left for later, has been replied to.
    const outcome = later ? 'deferred' : why ? 'ignored' : 'replied'
    log('update', { kind, command, outcome, why, ms: deps.now().getTime() - began })
    return later
  } catch (error) {
    const told = await tellOfFailure(handling.tell, error)
    const { seen, handled } = handling
    const ms = deps.now().getTime() - began
    // Nothing of the error's message is logged: it could quote what the update held, or what is stored.
    logFailure('update', error, { kind: seen.kind, command: seen.command, outcome: 'failed', handled, told, ms })
  }
}

/** Does what `handleUpdate` is said to do, and notes in `handling` what the update is found to be on the way. */
async function handle(deps: Deps, update: Update, handling: Handling): Promise<Later | void> {
  const { seen } = handling
  if (update.callback_query) return press(deps, update.callback_query, handling)

  // An update holds one thing: here a message, or a message as it stands after it was edited.
  const message = update.message ?? update.edited_message
  if (!message) return ignore(seen, 'nothing_read')
  seen.kind = update.message ? 'message' : 'edited'
  const { message_id: messageId, text, chat, from } = message
  if (chat?.type !== 'private' || typeof chat.id !== 'number') return ignore(seen, 'not_private')
  // The user is known by who sent the message, and the reply goes to the chat it was sent in. A user's private
  // chat with the bot has the user's own id, so the two are the same, and an update in which they differ is not
  // one to answer.
  if (typeof from?.id !== 'number' || from.id !== chat.id) return ignore(seen, 'not_own_chat')
  const chatId = chat.id
  handling.tell = () => deps.messenger.send(chatId, FAILED)

  // An edited message is not read again: a command in it is not run, and a question in it is not asked. Its user
  // is told so when it is one of text. One that is not was answered when it first came, and Telegram posts edits
  // that are none of its user's making, as every move of a live location is. So a photo is not read again either,
  // when the words under it are changed.
  if (!update.message) {
    return typeof text === 'string' ? sendReply(deps.messenger, chatId, EDITED) : ignore(seen, 'not_text')
  }
  // What Telegram writes in a chat itself is no message of its user's, and is not answered: that a message was
  // pinned, and that the timer which deletes the chat's messages was set. The list is short on purpose. Whatever
  // else the bot does not know is answered with NOT_TEXT, because silence is the worse mistake.
  if (message.pinned_message !== undefined || message.message_auto_delete_timer_changed !== undefined) {
    return ignore(seen, 'service_message')
  }
  if (typeof text !== 'string') {
    // A photo is read where the service has a model that reads one, and the words under it go to that model with
    // it. The reading is left for later, as the answering of a question is: see readLater.
    const { ai } = deps
    const sizes = sizesOf(message.photo)
    if (ai?.visionModel !== undefined && sizes.length > 0) {
      seen.kind = 'photo'
      // The purchases of a photo are stored under the id of its message.
      if (typeof messageId !== 'number') return ignore(seen, 'no_id')
      const caption = typeof message.caption === 'string' ? message.caption : ''
      const reading = readLater(deps, ai, from.id, messageId, sizes, caption)
      return () => sendLater(deps, chatId, reading)
    }
    // The words under any other attachment are no question, and are sent to nobody.
    seen.kind = 'not_text'
    return sendReply(deps.messenger, chatId, ai?.visionModel === undefined ? NOT_TEXT : NOT_TEXT_OR_PHOTO)
  }
  if (typeof messageId !== 'number') return ignore(seen, 'no_id')

  // An /add says when a purchase for its message is stored. What it asked for is done from then on, and whatever
  // fails after that is not answered with FAILED, which says to try again: see STORED_NO_REPLY.
  const stored = () => {
    handling.handled = true
    handling.tell = () => deps.messenger.send(chatId, STORED_NO_REPLY)
  }
  const answer = await reply(deps, from.id, messageId, text, seen, stored)
  if (typeof answer === 'object' && 'make' in answer) return () => sendLater(deps, chatId, answer)
  // What any other message asked for is done once its reply has been made: only the sending of it is left.
  if (seen.command !== 'add') handling.handled = true
  return sendReply(deps.messenger, chatId, answer)
}

/** Notes why an update is ignored, which is all that is done about one that is. */
function ignore(seen: Seen, why: NonNullable<Seen['why']>): void {
  seen.why = why
}

/**
 * Tells whoever sent an update that the handling of it failed, with `tell`, and returns whether they were told. A
 * chat that Telegram will send nothing to is not told: it would take this no more than it took what failed. When
 * the telling fails too, that is all: the request that failed has its own line in the log.
 */
async function tellOfFailure(tell: Handling['tell'], error: unknown): Promise<boolean> {
  if (!tell || error instanceof ChatBlockedError) return false
  try {
    await tell()
    return true
  } catch {
    return false
  }
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
    // The request that Telegram refused has its own line in the log: see request in ./api.
    return asText()
  }
}

/**
 * Makes a reply that was left to be made, which is the answer to a question or what came of a photo, and sends it.
 * Its user is not left to wonder in the meantime: the chat is sent a placeholder at once, which the reply takes the
 * place of. And they are told whatever comes of it: that it could not be done, when the reply cannot be made or
 * cannot be sent, and that it took too long, when the making does. What they are told then is the reply's own to
 * say: see Deferred.
 *
 * Only a chat that Telegram will send nothing to is told nothing.
 *
 * It does not throw. What came of the reply is logged in one line when this ends, however it ends. A request to
 * Telegram that fails on the way has a line of its own, whether or not the making goes on after it: see `request`
 * in ./api.
 */
async function sendLater<Outcome extends string>(
  { messenger, now }: Deps,
  chatId: number,
  reply: Deferred<Outcome>,
): Promise<void> {
  const began = now().getTime()
  // The time that a reply is given starts here, with the first thing that is done about it.
  const until = began + REPLY_TIME
  const { noted } = reply
  // What went wrong with a reply that was not made or not sent, which its line has as the error of a failure.
  let wrong: unknown
  try {
    const placeholder = await sendPlaceholder(messenger, chatId, reply.placeholder)
    noted.placeholder = placeholder !== undefined
    // What is said in the place of the placeholder. A reply is not said there: it can be a rich message, and
    // Telegram's reference does not say that a message of text can be edited into one. So it is sent as any other
    // reply is, in messages of its own, and the placeholder is then deleted.
    let notice: string | undefined
    try {
      const came = await made(messenger, chatId, reply, until - now().getTime(), placeholder)
      if ('notice' in came) {
        notice = came.notice
        wrong = came.error
      } else {
        // One reply or several, each sent in its turn. A reply went as a rich message when every rich message of it
        // did, and it had one.
        const replies: Sent[] = 'replies' in came ? came.replies : [...(came.rich ? [came.rich] : []), came.text ?? []]
        let [rich, refused] = [0, 0]
        for (const each of replies) {
          const asText = 'rich' in each ? await sendTabled(messenger, chatId, each) : each
          await sendReply(messenger, chatId, asText)
          if ('rich' in each) rich++
          if ('rich' in each && asText.length > 0) refused++
        }
        noted.sent = rich > 0 && refused === 0 ? 'rich' : 'text'
      }
      noted.outcome = came.outcome
    } catch (error) {
      if (error instanceof ChatBlockedError) throw error
      notice = reply.failed()
      wrong = error
    }
    if (notice !== undefined) {
      noted.sent = await sayInstead(messenger, chatId, placeholder, notice)
    } else if (placeholder !== undefined) {
      // The reply is in the chat, and a placeholder that stays above it is all that a failure to delete it leaves.
      await messenger.delete(chatId, placeholder).catch(() => {})
    }
  } catch (error) {
    // What gets here was said to nobody. A chat that Telegram will send nothing to is the one that is to be told
    // nothing, whatever came of its reply. Anything else is a notice that could not be said in a message of its
    // own either: the reply is logged with what went wrong before that.
    if (error instanceof ChatBlockedError) noted.outcome = 'blocked'
    if (error instanceof ChatBlockedError || wrong === undefined) wrong = error
  }
  reply.record(now().getTime() - began, wrong)
}

/**
 * Sends the placeholder: see WORKING. Returns the id that Telegram gave it, or nothing when it could not be sent,
 * and the reply is then made all the same. A chat that Telegram will send nothing to ends the making here, before
 * the model is asked anything: that error goes on as it is.
 */
async function sendPlaceholder(messenger: Messenger, chatId: number, text: string): Promise<number | undefined> {
  try {
    return await messenger.post(chatId, text)
  } catch (error) {
    if (error instanceof ChatBlockedError) throw error
    return undefined
  }
}

/**
 * Makes a reply that was left to be made, with the chat shown that the bot is writing until it is made: Telegram
 * shows that for five seconds, so it is shown again every four. The making is waited for only so long, which is
 * `time` in milliseconds. Then the reply is one that took too long, and whatever the making comes to after that is
 * sent to nobody. `placeholder` is the id of the placeholder, when it was sent: the making can have it say
 * something else.
 */
async function made<Outcome extends string>(
  messenger: Messenger,
  chatId: number,
  reply: Deferred<Outcome>,
  time: number,
  placeholder: number | undefined,
): Promise<Made<Outcome>> {
  const showTyping = () => {
    // The reply is made all the same.
    messenger.typing(chatId).catch(() => {})
  }
  showTyping()
  const typing = setInterval(showTyping, TYPING_EVERY)
  const late = Promise.withResolvers<Made<Outcome>>()
  const deadline = setTimeout(() => late.resolve(reply.late()), time)
  // With no placeholder to edit, or with one that Telegram will not have edited, the reply is made all the same.
  const instead = async (text: string) => {
    if (placeholder !== undefined) await messenger.edit(chatId, placeholder, text).catch(() => {})
  }
  try {
    return await Promise.race([reply.make(instead), late.promise])
  } finally {
    clearInterval(typing)
    clearTimeout(deadline)
  }
}

/**
 * Says one thing in the place of the placeholder, which is edited to say it. With no placeholder, or with one that
 * Telegram will not have edited, as one that its user has deleted, it is sent as a message of its own. Returns which
 * of the two it was.
 */
async function sayInstead(
  messenger: Messenger,
  chatId: number,
  placeholder: number | undefined,
  text: string,
): Promise<'edit' | 'message'> {
  if (placeholder !== undefined) {
    try {
      await messenger.edit(chatId, placeholder, text)
      return 'edit'
    } catch (error) {
      // A chat that is to be sent nothing would take a message no more than it took the edit.
      if (error instanceof ChatBlockedError) throw error
    }
  }
  await messenger.send(chatId, text)
  return 'message'
}

/**
 * The reply to a message or, to a question for the assistant, the reply that is still to be made. What the message
 * is found to be is noted in `seen`, and `stored` is what an /add calls once a purchase for the message is stored.
 */
async function reply(
  deps: Deps,
  telegramId: number,
  messageId: number,
  text: string,
  seen: Seen,
  stored: () => void,
): Promise<Reply | Deferred<Asked['outcome']>> {
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
      return spendReply(await cardTotals(store, cards, now(), timezone), timezone)
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
      return ask(deps, telegramId, messageId, text.trim())
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
 * The reply to a question for the assistant. Where the bot has one, it is a reply that is still to be made, as the
 * answer takes the seconds that a model takes over it: see sendLater for what its user is shown in the meantime.
 *
 * The assistant answers, or makes out what the message asks the bot to do. What it makes out is done here, and by
 * nothing of its own: see actInRounds. `messageId` is Telegram's id of the message, which purchases that it asks to
 * have added are stored under.
 */
function ask(
  deps: Deps,
  telegramId: number,
  messageId: number,
  question: string,
): Reply | Deferred<Asked['outcome']> {
  const { ai, db } = deps
  if (!ai) return NO_ASSISTANT
  if (question.length > MAX_QUESTION_LENGTH) return QUESTION_TOO_LONG

  // Until more is learnt of it, the question is one that failed, of a user who is not known, with nothing said.
  const asked: Asked = { user: null, outcome: 'failed', sent: 'none', placeholder: false, requests: 0, tool_calls: 0 }
  const doing: Doing = { stored: 0, held: 0, kept: false, late: false, begun: false }
  // What the answering comes to when its time is up. Once the doing of what was asked for has begun, its user is
  // not told to try again: see DONE_NO_REPLY.
  const outOfTime = (): Made<Asked['outcome']> => ({
    outcome: 'timeout',
    notice: doing.begun ? DONE_NO_REPLY : TOOK_TOO_LONG,
    error: new Failure('took_too_long', 'The question took too long to answer'),
  })
  return {
    placeholder: WORKING,
    noted: asked,
    async make(instead) {
      // A question needs a user as a command does: its answer is read from their store.
      const user = await findOrCreateUser(db, telegramId)
      asked.user = user.id
      const result = await answerQuestion(deps, ai, user, question, asked)
      switch (result.status) {
        case 'answered':
          return { outcome: 'answered', rich: answered(result.text) }
        case 'acting': {
          asked.actions = result.actions.length
          // Nothing is begun once the time is up: its user has been told so by then, and may ask again.
          if (doing.late) return outOfTime()
          // The placeholder says to ask again when it is still there in half a minute, which is not to be said of a
          // message that things are done for.
          await instead(DOING)
          const room: Room = { left: ACTION_QUERIES }
          const replies = await actInRounds(deps, { user, telegramId, messageId, doing, room }, result, asked)
          return replies ? { outcome: 'acted', replies } : outOfTime()
        }
        case 'busy':
          return { outcome: 'busy', notice: busyReply(result.retryAfter), error: result.error }
        case 'timeout':
          return { outcome: 'timeout', notice: TOOK_TOO_LONG, error: result.error }
        case 'failed':
          return { outcome: 'failed', notice: NOT_ANSWERED, error: result.error }
      }
    },
    late() {
      doing.late = true
      return outOfTime()
    },
    failed: () => (doing.begun ? DONE_NO_REPLY : NOT_ANSWERED),
    record(ms, wrong) {
      const line = { ...asked, ms }
      // Nothing of an error's message is logged: it could quote the question, or what is stored.
      if (asked.outcome === 'answered' || asked.outcome === 'acted') log('question', line)
      else logFailure('question', wrong, line)
    },
  }
}

/**
 * Carries out all that the assistant makes of one message, an answer at a time: the actions of the answer and then,
 * while the model said that there is more to do and can be asked again, those of the answer that it gives next. A
 * model gives one call to a message, so the things of a message that asks for several come one to an answer: see
 * `next` of Answer in ../ai/assistant. Returns the replies to all of them, in their order, or nothing when the time
 * of whoever waits was up. `how` is whom the things are done for, and within what: the room of queries and the
 * `doing` are those of all the answers together. The count of the actions is kept in `noted`, for the log.
 *
 * The model is told what came of each thing in one of three texts, and nothing else: see toldOf. It is asked no
 * more when a thing failed, or there was no room for one, as its user has been told that the rest was not done.
 * When it said that there was more on the last request that a question may make, its user is told so too. What it
 * writes when it is asked again goes to nobody, as it was told to write nothing. And when it cannot be asked again,
 * the replies to what was done are kept, and its user is told that the rest was not: see REST_NOT_DONE.
 */
async function actInRounds(
  deps: Deps,
  how: Omit<Asking, 'afterReading'>,
  first: Acting,
  noted: Pick<Asked, 'actions'>,
): Promise<Sent[] | undefined> {
  const replies: Sent[] = []
  let [before, dropped] = [0, 0]
  for (let answer = first; ; ) {
    const { actions, afterReading } = answer
    noted.actions = before + actions.length
    dropped += answer.dropped
    const acted = await act(deps, { ...how, afterReading }, actions, before)
    if (!acted) return undefined
    replies.push(...acted.replies)
    before += actions.length
    if (!acted.outcomes) break
    if (!answer.next) {
      if (answer.more) replies.push([{ text: NO_MORE }])
      break
    }
    const next = await answer.next(acted.outcomes.map(toldOf))
    if (how.doing.late) return undefined
    if (next.status !== 'acting') {
      if (next.status !== 'answered') replies.push([{ text: REST_NOT_DONE }])
      break
    }
    answer = next
  }
  // What the model asked for and the assistant did not hand on was not done either, and is not passed over in
  // silence: the reply ends with the line that says so, once, however many those were.
  const last = replies.at(-1)
  const said = Array.isArray(last) ? last.at(-1)?.text : undefined
  if (dropped > 0 && said !== NOT_DONE) replies.push([{ text: NOT_DONE }])
  return replies
}

/**
 * What the model is told came of a thing that it asked to have done, when it is asked what else there is to do. It
 * is one of three texts, by what came of the thing, and nothing of the reply or of what is stored: a model can take
 * what it is told for its user's wish, and can repeat it.
 */
function toldOf(outcome: Carried['outcome']): string {
  if (outcome === 'done') return 'Done.'
  return outcome === 'asked' ? 'The user has been asked to confirm it.' : 'It was not done.'
}

/**
 * Carries out the actions of one answer of the assistant's, in their order. The model has only said what was asked
 * for. Each thing is done here, by the code that the bot's commands run, and each is answered with a reply of its
 * own, which is the bot's and not the model's. Returns the replies with what came of each action, or nothing when
 * the time of whoever waits was up: nothing is begun from then on.
 *
 * What removes or revokes is not done here at all: it is asked about, and done when its user presses a button. And
 * the deleting of everything is done for nobody but a user who sends the command themselves. See runAsked.
 *
 * What the model asks for after a tool has read for it is trusted less than what it makes of its user's words
 * alone: what a tool returns holds text that somebody else wrote. So whatever of it would change something is asked
 * about first too. Purchases are held whole, for their user to add with a button, and the commands that change
 * something wait for a press as those that remove do. Purchases are sorted as before, and so is whatever only shows
 * things. See Asking.
 *
 * An action that fails ends the carrying out. Those before it stay done, each with its reply, and the user is told
 * that it is those that are answered: see wentWrong. So does an action that there is no room left for, of the
 * queries that the actions may run between them: see ACTION_QUERIES. Every action has a line in the log, with what
 * came of it and nothing of what it held.
 *
 * `how` is whom the actions are carried out for, and within what. What is done is noted in its `doing` as it is
 * done: see Doing. `before` is how many things of the message were carried out for the answers before this one,
 * which the user is told of when one of these fails.
 */
async function act(deps: Deps, how: Asking, actions: Action[], before: number): Promise<Acted | undefined> {
  const { user, doing } = how
  // What the log has of each action besides what came of it. A command is known by its name in the bot's own list.
  const noted = actions.map((action): Pick<Events['action'], 'user' | 'kind' | 'command'> => {
    const command = action.kind === 'command' ? (commandIn(action.line).name ?? 'unknown') : undefined
    return { user: user.id, kind: action.kind, command }
  })
  /** Notes that the actions from the one at `from` on were not begun. */
  const skip = (from: number) => {
    for (const each of noted.slice(from)) log('action', { ...each, outcome: 'skipped' })
  }
  const replies: Sent[] = []
  const outcomes: Carried['outcome'][] = []

  for (const [at, action] of actions.entries()) {
    if (doing.late) return undefined
    doing.begun = true
    try {
      const came = await carriedOut(deps, how, action)
      if (came === 'late') return undefined
      if (came === 'full') {
        replies.push([{ text: NO_MORE }])
        skip(at)
        return { replies }
      }
      replies.push(...came.replies)
      outcomes.push(came.outcome)
      log('action', { ...noted[at], outcome: came.outcome, stored: came.stored, held: came.held })
    } catch (error) {
      // Nothing of the error's message is logged: it could quote what the action held, or what is stored.
      logFailure('action', error, { ...noted[at], outcome: 'failed' })
      replies.push([{ text: wentWrong(before + at, before + actions.length) }])
      skip(at + 1)
      return { replies }
    }
  }
  return { replies, outcomes }
}

/** Carries out one action: see act. */
function carriedOut(deps: Deps, how: Asking, action: Action): Promise<Came> {
  switch (action.kind) {
    case 'show':
      return showAsked(deps, how, action.card)
    case 'add':
      return addAsked(deps, how, action.reading)
    case 'category':
      return sortAsked(deps, how, action.ids, action.category)
    case 'command':
      return runAsked(deps, how, action.line)
  }
}

/** An action that the bot did nothing of, with what its user is told of that. */
function declined(text: string): Carried {
  return { replies: [[{ text }]], outcome: 'refused' }
}

/** Takes so many queries out of the room that is left, when there is room for them. Returns whether there was. */
function take(room: Room, queries: number): boolean {
  if (queries > room.left) return false
  room.left -= queries
  return true
}

/**
 * What a user is told when an action failed: that those before it are answered, when there are any, and that the
 * rest may not have been done. `answered` is how many actions came before the one that failed, out of `asked`. The
 * one that failed may have been done in part, as an adding that stored its purchases and then could not add up their
 * card. So nothing here says to ask again without a look at what is there.
 */
function wentWrong(answered: number, asked: number): string {
  if (answered === 0) {
    return (
      "Something went wrong on the bot's side, and what you asked for may not have been done. Check /spend before " +
      'you ask again.'
    )
  }
  const [first, are] = answered === 1 ? ['The first', 'is'] : [`The first ${answered}`, 'are']
  return (
    `${first} of the ${asked} things that you asked for ${are} answered above. Something then went wrong on the ` +
    "bot's side, and the rest may not have been done. Check /spend before you ask for the rest again."
  )
}

/**
 * Shows a user what they have spent, when that is what the assistant made of their message. What is shown is what
 * /spend shows, in the bot's own tables: none of it is a model's writing.
 *
 * `nickname` is the card to show, as the assistant gave it, or nothing for every card. One card is shown as /spend
 * with its nickname shows it: see spendDetail. Every card is shown so too, each in a reply of its own and in the
 * order that /cards lists them in, when their user has no more of them than SHOWN_IN_FULL. A user with more is
 * shown what /spend with no card named shows: a row for each card, in the one table of one message.
 *
 * The assistant gives the nickname of a card that the model was told of, and of no other. When that card is there no
 * longer, the reply is that something could not be done. It does not say the nickname back, which is a model's text.
 *
 * Nothing here waits for a button, whatever the model had read: it only shows.
 */
async function showAsked(deps: Deps, how: Asking, nickname?: string): Promise<Came> {
  const { user, telegramId, messageId, room } = how
  if (!take(room, 1)) return 'full'
  const store = storeFor(deps.db, user.id)
  const cards = await store.listCards()
  if (cards.length === 0) return declined(NO_CARDS)

  if (nickname === undefined && cards.length > SHOWN_IN_FULL) {
    // The command reads the user and their cards for itself, and then the total of each card.
    if (!take(room, MAX_CARDS + 2)) return 'full'
    const said = await ran(deps, telegramId, messageId, '/spend')
    return said ? { replies: [said], outcome: 'done' } : declined(NOT_DONE)
  }

  // The cards that are each shown in full: every card, or the one of that nickname, when there is one.
  const shown = nickname === undefined ? cards : cards.filter((card) => card.nickname === nickname)
  if (shown.length === 0) return declined(NOT_DONE)
  // Two queries for each card: see spendDetail.
  if (!take(room, 2 * shown.length)) return 'full'
  const now = deps.now()
  const replies = await Promise.all(shown.map((card) => spendDetail(store, card, now, user.timezone)))
  return { replies, outcome: 'done' }
}

/**
 * Adds the purchases that the assistant made out in a message, as those that are read from a photo are added: by
 * addRead, under the id of the message, with the same limit and the same buttons for what is not clear.
 *
 * A message has its purchases added once. Those of a second adding in the same answer would be stored under the
 * places of the first, so they are not added: their user is told to send them on their own. And a message that was
 * read before is not added from again, as a photo that was is not read again: see readBefore.
 *
 * Purchases that the model gave after a tool had read for it are held whole. None is stored at once: each is taken
 * for one that the model was not sure of, so that all of them are asked about, with the buttons. See Asking.
 */
async function addAsked(
  deps: Deps,
  { user, messageId, doing, room, afterReading }: Asking,
  given: Extract<Action, { kind: 'add' }>['reading'],
): Promise<Came> {
  if (given.status === 'nothing') return declined(NO_PURCHASES_SAID)
  if (doing.kept || doing.held > 0) return declined(ONE_ADDING)
  if (!take(room, ADD_QUERIES)) return 'full'
  const cards = await storeFor(deps.db, user.id).listCards()
  if (cards.length === 0) return declined(NO_CARDS)
  if (await readBefore(deps, user.id, messageId)) return declined(READ_ALREADY)

  const doubted = given.purchases.map((purchase) => ({ ...purchase, unsure: true }))
  const reading = afterReading ? { ...given, purchases: doubted } : given
  const added = await addRead(deps, user, cards, reading, messageId, doing)
  if (!added) return 'late'
  const replies: Sent[] = [...(added.rich ? [added.rich] : []), ...(added.text.length > 0 ? [added.text] : [])]
  // A reading that left nothing to tell of is one that found nothing to add.
  if (replies.length === 0) return declined(NO_PURCHASES_SAID)
  // Purchases that are all held are asked about, with the buttons under the message that shows them.
  const outcome = doing.kept ? 'done' : doing.held > 0 ? 'asked' : 'refused'
  return { replies, outcome, stored: doing.stored, held: doing.held }
}

/**
 * Sorts purchases into a category of their card's product, as a press of "Mark as" sorts one: see press. `ids` are
 * the purchases and `key` is the category, as the model gave them, and nothing has checked either against what is
 * stored. So each purchase is looked up through the store of the user who asked, which finds no purchase of anyone
 * else's, and is moved only when its card has a product and the category is one that can be chosen for that product.
 *
 * The reply has a line for each purchase: where it now is, in the words that the press says it in, or why it was
 * not moved. A purchase takes two queries, so those that there is no room left for are not moved, and are counted
 * in one line.
 */
async function sortAsked(deps: Deps, { user, room }: Asking, ids: number[], key: string): Promise<Came> {
  // The cards, and then the finding of each purchase and the moving of it.
  if (room.left < 3) return 'full'
  take(room, 1)
  const store = storeFor(deps.db, user.id)
  const cards = await store.listCards()
  const lines: string[] = []
  let [moved, left] = [0, 0]
  for (const id of new Set(ids)) {
    if (!take(room, 2)) {
      left++
      continue
    }
    const purchase = await store.findTransaction(id)
    if (!purchase) {
      lines.push(`You have no purchase with ID ${id}.`)
      continue
    }
    const card = cards.find((each) => each.last4 === purchase.cardLast4)
    const product = productOf(card?.product)
    if (!card || !product) {
      lines.push(`ID ${purchase.id} is on a card that is linked to no product, so there is nothing to sort it into.`)
      continue
    }
    const category = choicesOf(product).find((choice) => choice.key === key)
    if (!category) {
      lines.push(
        `ID ${purchase.id} was not moved: a purchase on ${label(card)} cannot be marked as that. ` +
          `Send /sort ${purchase.id} for what it can be marked as.`,
      )
      continue
    }
    // Nothing moves a purchase to where it is already: see press.
    if (categoryOf(product, purchase.category) !== category.key) await store.setCategory(purchase.id, category.key)
    lines.push(sortEnd(product, { id: purchase.id, category: category.key }).line)
    moved++
  }
  if (left > 0) {
    const [purchases, them] = left === 1 ? ['purchase was', 'it'] : ['purchases were', 'them']
    lines.push(
      `${left} more ${purchases} not moved: the bot sorts only so many for one message. Ask for ${them} again.`,
    )
  }
  if (lines.length === 0) return declined(NOT_DONE)
  return { replies: [inMessages(lines.map((text) => ({ text })))], outcome: moved > 0 ? 'done' : 'refused' }
}

/**
 * The command that a line is of, by its name in the bot's own list, and the words after it: as `reply` takes a
 * message apart. It has no name when the line is of none of the bot's commands, or is no command at all.
 */
function commandIn(line: string): { name?: (typeof COMMAND_NAMES)[number]; args: string[] } {
  const [first = '', ...args] = line.trim().split(/\s+/)
  const command = first.split('@')[0].toLowerCase()
  return { name: COMMAND_NAMES.find((name) => command === `/${name}`), args }
}

/**
 * Runs a command as if its user had sent the line, and returns its reply as it is sent. Nothing for a line whose
 * reply is one that is still to be made, which only a question's is: no command's is, and no line that is run here
 * is anything but a command.
 */
async function ran(deps: Deps, telegramId: number, messageId: number, line: string): Promise<Sent | undefined> {
  const said = await reply(deps, telegramId, messageId, line, { kind: 'other' }, () => {})
  if (typeof said === 'string') return [{ text: said }]
  return 'make' in said ? undefined : said
}

/**
 * Does what a line that the assistant gave as a command asks for, where the bot does that for the assistant. The
 * line is a model's text, and nothing has checked it: what it is of is told from its first word alone, by the bot's
 * own list of its commands.
 *
 * What is run is what is listed to be run, and nothing else: see RUN_AT_ONCE. A line of one of those commands is
 * run as if its user had sent it: see ran. A line of a command that removes or revokes is not run. Its user is
 * asked first, with buttons, and so they are about a command that changes something when the model had read before
 * it gave the line: see confirmFor. Only /timezone with nothing after it is not asked about then, as it shows the
 * time zone and changes nothing.
 *
 * A line of /delete is not run either, whatever follows the command. It is answered with what /delete answers when
 * it is sent with nothing after it, which says what to send to go ahead: the deleting of everything is done for a
 * user who sends that themselves, and for nobody else.
 *
 * Every other line is answered with that it could not be done, whatever it is: a command that is on neither list,
 * as /add is, whose purchases the assistant gives to be added in a way of their own, and /code, which takes the six
 * digits that its user was shown in a browser. And a command that there is not, or a line that is no command, which
 * would go to the assistant as a question: that would be the assistant asking itself.
 */
async function runAsked(deps: Deps, how: Asking, line: string): Promise<Came> {
  const { telegramId, messageId, room, afterReading } = how
  const { name, args } = commandIn(line)
  const shows = name === 'timezone' && args.length === 0
  const asked =
    ASKED_FIRST.find((each) => each === name) ??
    (afterReading && !shows ? CHANGING.find((each) => each === name) : undefined)
  // To ask takes one query at the most: the purchase, the cards or the connection that the asking names.
  if (asked) return take(room, 1) ? confirmFor(deps, how.user, asked, args) : 'full'

  if (name === 'delete') {
    // The line that is run is this one, and never the model's: nothing that follows the command is run with it.
    const warning = await ran(deps, telegramId, messageId, '/delete')
    return warning ? { replies: [warning], outcome: 'refused' } : declined(NOT_DONE)
  }
  if (!RUN_AT_ONCE.some((each) => each === name)) return declined(NOT_DONE)

  const queries = name === 'spend' && args.length === 0 ? MAX_CARDS + 2 : COMMAND_QUERIES
  if (!take(room, queries)) return 'full'
  const said = await ran(deps, telegramId, messageId, line)
  return said ? { replies: [said], outcome: 'done' } : declined(NOT_DONE)
}

/**
 * Asks before a command is run: with a message that says what would be done and to what, and with a button that
 * does it and one that does not. Nothing is done until the first of them is pressed: see pressConfirm. The command
 * rides under the buttons as the line that its user would send, which is made here from what the model's line was
 * read to mean, and is none of the model's text.
 *
 * Where there is nothing that the command could do, it is answered with what the command itself would say of that,
 * and with no buttons: a purchase or a card that the user has not got, a nickname that a card of theirs has
 * already, a Gmail that is not connected, and one that is connected already. A line that the command would not take
 * is answered with that it could not be done.
 */
async function confirmFor(
  deps: Deps,
  user: User,
  name: (typeof CONFIRMABLE)[number],
  args: string[],
): Promise<Carried> {
  const { db } = deps
  switch (name) {
    case 'remove': {
      const [, id] = PURCHASE_ID.exec(args[0] ?? '') ?? []
      if (args.length !== 1 || id === undefined) return declined(NOT_DONE)
      const purchase = await storeFor(db, user.id).findTransaction(Number(id))
      if (!purchase) return declined(`You have no purchase with ID ${Number(id)}.`)
      const date = formatShortDate(new Date(purchase.occurredAt * 1000), user.timezone)
      return confirmation(`/remove ${purchase.id}`, [
        { text: `Take this purchase out of ${maskLast4(purchase.cardLast4)}?` },
        purchaseLine(purchase, date),
      ])
    }
    case 'removecard': {
      const [nickname = ''] = args
      if (args.length !== 1 || !NICKNAME.test(nickname)) return declined(NOT_DONE)
      const card = (await storeFor(db, user.id).listCards()).find((each) => each.nickname === nickname)
      if (!card) return declined(`You have no card called ${nickname}.`)
      return confirmation(`/removecard ${nickname}`, [{ text: `Stop tracking ${label(card)}?` }])
    }
    case 'disconnect': {
      if (args.length !== 0) return declined(NOT_DONE)
      const connection = await connectStoreFor(db, user.id).findConnection()
      if (!connection) return declined('Your Gmail is not connected.')
      return confirmation('/disconnect', [
        { text: `Disconnect your Gmail ${connection.email}? Its mail will no longer be read for this chat.` },
      ])
    }
    case 'mcp':
      if (args.length === 0) {
        return confirmation('/mcp', [
          { text: 'Make a new assistant access token? The one that you have now, if you have one, will stop working.' },
        ])
      }
      if (args.length !== 1 || args[0].toLowerCase() !== 'revoke') return declined(NOT_DONE)
      return confirmation('/mcp revoke', [
        { text: 'Remove your assistant access token? An assistant that uses it will no longer read your data.' },
      ])
    case 'connect': {
      if (args.length !== 0) return declined(NOT_DONE)
      const connection = await connectStoreFor(db, user.id).findConnection()
      if (connection?.status === 'active') {
        return declined(`Your Gmail ${connection.email} is already connected. Send /disconnect to remove it.`)
      }
      // A new sign-in takes the place of one that is under way: see startConnect in ../connect. Whoever has just
      // approved at Google, and has their code still to send, would send it to no sign-in.
      return confirmation('/connect', [
        {
          text:
            'Start a new sign-in to connect your Gmail? A sign-in that is waiting for its code is cancelled, and ' +
            'its code will no longer work.',
        },
      ])
    }
    case 'addcard': {
      const card = parseCard(args)
      if (typeof card === 'string') return declined(NOT_DONE)
      const window = card.windowType === 'statement' ? `statement ${card.statementDay}` : 'calendar'
      const words = ['/addcard', card.nickname, card.last4, window, ...(card.product ? [card.product] : [])]
      return confirmation(words.join(' '), [{ text: 'Add this card?' }, { text: describeCard(card) }])
    }
    case 'renamecard': {
      const [nickname = '', renamed = ''] = args
      if (args.length !== 2 || !NICKNAME.test(nickname) || !NICKNAME.test(renamed)) return declined(NOT_DONE)
      const cards = await storeFor(db, user.id).listCards()
      const card = cards.find((each) => each.nickname === nickname)
      if (!card) return declined(`You have no card called ${nickname}.`)
      // The card's own nickname is one that a card has already, as it is to the command.
      const taken = cards.some((each) => each.nickname === renamed)
      if (taken) return declined(`You already have a card called ${renamed}.`)
      return confirmation(`/renamecard ${nickname} ${renamed}`, [{ text: `Rename ${label(card)} to ${renamed}?` }])
    }
    case 'product': {
      const [nickname = '', key = ''] = args
      const product = productOf(key.toLowerCase())
      const known = product || key.toLowerCase() === 'none'
      if (args.length !== 2 || !NICKNAME.test(nickname) || !known) return declined(NOT_DONE)
      const card = (await storeFor(db, user.id).listCards()).find((each) => each.nickname === nickname)
      if (!card) return declined(`You have no card called ${nickname}.`)
      const text = product
        ? `Link ${label(card)} to ${product.name}?`
        : `Link ${label(card)} to no product? Its purchases will no longer be sorted.`
      return confirmation(`/product ${nickname} ${product?.key ?? 'none'}`, [{ text }])
    }
    case 'timezone': {
      const zone = args.length === 1 ? timeZoneNamed(args[0]) : null
      if (!zone) return declined(NOT_DONE)
      return confirmation(`/timezone ${zone}`, [
        { text: `Change your time zone to ${zone}? Your cards' cycles and months will begin and end by it.` },
      ])
    }
  }
}

/**
 * The message that asks before a command is run: the lines, and under them the buttons that the command's line
 * rides in. A line that does not fit there is given to its user to send themselves, marked as code so that it can
 * be copied whole, and nothing is asked.
 */
function confirmation(line: string, lines: Line[]): Carried {
  const buttons = confirmButtons(line)
  if (!buttons) {
    const whole = { text: line, marked: { offset: 0, length: line.length } }
    return { replies: [inMessages([{ text: SEND_YOURSELF }, whole])], outcome: 'refused' }
  }
  const [message] = inMessages(lines)
  return { replies: [[{ ...message, buttons }]], outcome: 'asked' }
}

/**
 * Whether a message was read before: whether a purchase of it is stored, at any place that a reading has, or
 * purchases of it are held. Telegram delivers a message again when it has not heard that the message was taken. A
 * second reading of it can differ from the first, and purchases are stored under their places in the reading: so a
 * message that was read is not read again. One whose purchases were all taken out since is one that was read.
 */
async function readBefore(deps: Deps, userId: number, messageId: number): Promise<boolean> {
  const { db, now } = deps
  const places = Array.from({ length: MAX_PURCHASES_PER_PHOTO }, (_, place) => sourceIdOf(messageId, place))
  const [stored, held] = await Promise.all([
    storeFor(db, userId).findBySourceIds(places),
    heldStoreFor(db, userId).find(messageId, Math.floor(now().getTime() / 1000)),
  ])
  return stored.length > 0 || held !== null
}

/** What a purchase of a reading is stored under: the id of the message, and its place in the reading. */
function sourceIdOf(messageId: number, place: number): string {
  return `${MANUAL}:${messageId}:${place}`
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
 * The sizes of a photo that a file can be asked for, from what Telegram posted of the photo, which nothing has
 * checked. None for a message that has no photo.
 */
function sizesOf(photo: unknown): PhotoSize[] {
  if (!Array.isArray(photo)) return []
  return photo.flatMap((size: { file_id?: unknown; width?: unknown; height?: unknown; file_size?: unknown } | null) => {
    if (typeof size?.file_id !== 'string') return []
    const { file_id: fileId, width, height, file_size: bytes } = size
    const pixels = typeof width === 'number' && typeof height === 'number' ? width * height : 0
    return [{ fileId, pixels, bytes: typeof bytes === 'number' ? bytes : undefined }]
  })
}

/**
 * The size of a photo to fetch: the largest of those that have no more than MAX_PHOTO_BYTES. A size that Telegram
 * gave no number of bytes for is taken to be one of them: `Messenger.file` fetches no more than so many bytes, and
 * says so when a file has more. Nothing when every size is known to have more.
 */
function sizeToFetch(sizes: PhotoSize[]): PhotoSize | undefined {
  const fitting = sizes.filter(({ bytes }) => bytes === undefined || bytes <= MAX_PHOTO_BYTES)
  // Of two that have as many pixels, the later is taken.
  return fitting.reduce<PhotoSize | undefined>(
    (largest, size) => (largest && largest.pixels > size.pixels ? largest : size),
    undefined,
  )
}

/**
 * The bytes of a file of Telegram's that is to be read as a photo, which may have no more than MAX_PHOTO_BYTES.
 * Nothing for a file that has more.
 */
async function bytesOf(messenger: Messenger, fileId: string): Promise<Uint8Array | undefined> {
  try {
    return await messenger.file(fileId, MAX_PHOTO_BYTES)
  } catch (error) {
    if (error instanceof Failure && error.reason === 'file_too_large') return undefined
    throw error
  }
}

/**
 * The reading of a photo, which is a reply that is still to be made, as the answer to a question is: see sendLater
 * for what its user is shown in the meantime. The largest of the photo's sizes that is small enough is fetched from
 * Telegram and read by a model, with the caption and with what the user's cards are called and sorted into. What
 * is then done with the purchases that the model read is addRead's to do.
 */
function readLater(
  deps: Deps,
  ai: AiProvider,
  telegramId: number,
  messageId: number,
  sizes: PhotoSize[],
  caption: string,
): Deferred<Read['outcome']> {
  const { db, messenger } = deps
  // Until more is learnt of it, the photo is one whose reading failed, of a user who is not known, with nothing said.
  const noted: Read = {
    user: null,
    outcome: 'failed',
    sent: 'none',
    placeholder: false,
    bytes: 0,
    requests: 0,
    read: 0,
    unreadable: 0,
  }
  const adding: Adding = { stored: 0, held: 0, kept: false, late: false }
  // Whether anything of the photo is stored, or is held for its user to answer for. From then on its user is not
  // told to send it again: see PHOTO_READ_NO_REPLY.
  const taken = () => adding.kept || adding.held > 0
  // What the reading comes to when its time is up.
  const outOfTime = (): Made<Read['outcome']> => ({
    outcome: 'timeout',
    notice: taken() ? PHOTO_READ_NO_REPLY : PHOTO_TOOK_TOO_LONG,
    error: new Failure('took_too_long', 'The photo took too long to read'),
  })

  return {
    placeholder: READING,
    noted,
    async make() {
      // A photo needs a user as a command does: its purchases go into their store, on a card of theirs.
      const user = await findOrCreateUser(db, telegramId)
      noted.user = user.id
      const cards = await storeFor(db, user.id).listCards()
      if (cards.length === 0) return { outcome: 'no_cards', notice: NO_CARDS }
      // A photo that was read before is not fetched, and the model is not asked about it again: see readBefore.
      if (await readBefore(deps, user.id, messageId)) return { outcome: 'repeated', notice: READ_ALREADY }

      const size = sizeToFetch(sizes)
      const image = size && (await bytesOf(messenger, size.fileId))
      if (!image) return { outcome: 'too_large', notice: PHOTO_TOO_LARGE }
      noted.bytes = image.byteLength

      const input = { image, mime: PHOTO_MIME, caption, cards: cards.map(asPhotoCard), timeZone: user.timezone }
      const reading = await readPhoto(deps, ai, input, noted)
      switch (reading.status) {
        case 'nothing':
          return { outcome: 'nothing', notice: NO_PURCHASES }
        case 'busy':
          return { outcome: 'busy', notice: busyReply(reading.retryAfter), error: reading.error }
        case 'timeout':
          return { outcome: 'timeout', notice: PHOTO_TOOK_TOO_LONG, error: reading.error }
        case 'failed':
          return { outcome: 'failed', notice: PHOTO_NOT_READ, error: reading.error }
      }
      noted.read = Math.min(reading.purchases.length, MAX_PURCHASES_PER_PHOTO)
      noted.unreadable = reading.unreadable
      const added = await addRead(deps, user, cards, reading, messageId, adding)
      if (!added) return outOfTime()
      // A reading that left nothing to tell of is one that found nothing to add.
      if (!added.rich && added.text.length === 0) return { outcome: 'nothing', notice: NO_PURCHASES }
      return { outcome: 'read', ...added }
    },
    late() {
      adding.late = true
      return outOfTime()
    },
    failed: () => (taken() ? PHOTO_READ_NO_REPLY : PHOTO_NOT_READ),
    record(ms, wrong) {
      const line = { ...noted, stored: adding.stored, held: adding.held, ms }
      // Nothing of an error's message is logged: it could quote what the photo held, or what is stored.
      if (wrong === undefined) log('photo', line)
      else logFailure('photo', wrong, line)
    },
  }
}

/**
 * Answers the press of a button. Most of the bot's buttons move a purchase to a category. Others answer for
 * purchases that are held, and others say whether a command that removes or revokes is to be run. A press does the
 * one that its button is for, for the user who made it, and in their own private chat with the bot.
 */
async function press(deps: Deps, { id, from, data, message }: Press, handling: Handling): Promise<void> {
  const { db, messenger } = deps
  const { seen } = handling
  seen.kind = 'press'
  if (typeof id !== 'string') return ignore(seen, 'no_id')
  // As with a message: an update whose chat is not the private chat of the user it is from is not one to answer.
  if (message?.chat?.type !== 'private') return ignore(seen, 'not_private')
  if (typeof from?.id !== 'number' || message.chat.id !== from.id) return ignore(seen, 'not_own_chat')
  const chatId = from.id

  // Telegram shows a button as waiting until its press is answered, and takes one answer to a press. So a press
  // whose handling fails is answered with that it did, unless it has been answered by then.
  handling.tell = () => messenger.answer(id, PRESS_FAILED)
  const answer = async (text: string) => {
    // A press is answered once what it asked for is done, or is found to be nothing that can be done.
    handling.handled = true
    await messenger.answer(id, text)
    handling.tell = undefined
  }

  // A client can send what no button of the bot's holds. So every part of it is looked up before anything is
  // changed, and the purchase through the store of the user who pressed, which finds no purchase of anyone else's.
  const refuse = () => answer('That button no longer works.')
  const brought = typeof data === 'string' ? data : ''
  // A button under a message that asks before a command is run holds what no other button does, and so does one
  // under purchases that are held: see readConfirmPress and readHeldPress.
  const confirmed = readConfirmPress(brought)
  if (confirmed) return pressConfirm(deps, chatId, confirmed, message, handling, answer, refuse)
  const held = readHeldPress(brought)
  if (held) return pressHeld(deps, chatId, held, message.message_id, handling, answer, refuse)
  const pressed = readPress(brought)
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
  await answer(line)

  // The message ends with the line that said where the purchase was. That line is replaced, and so are the buttons:
  // by those for where the purchase is now.
  if (typeof message.message_id === 'number' && typeof message.text === 'string') {
    const kept = message.text.slice(0, message.text.lastIndexOf('\n') + 1)
    const marked = codeWithin(message.entities ?? [], kept.length)
    await messenger.edit(chatId, message.message_id, kept + line, marked.length > 0 ? marked : undefined, buttons)
  }
}

/**
 * Answers the press of a button under purchases that are held: see heldPrompt. A press adds them, to the card of
 * its button when the bot could not tell which card they were made with, or skips them. Either way the message
 * that asked about them is edited to say what was done, and they are held no longer. `under` is the id of that
 * message. A press is acted on only for purchases that are held for the user who pressed: their store finds no
 * others.
 *
 * Purchases that are no longer held are added by no press, which is then answered with that its button no longer
 * works: they were answered for already, or they waited for longer than purchases are held. They are let go of
 * last, once the message says what was done. So a press that Telegram did not take the answer to, or the edit
 * after it, can be made again.
 *
 * The press that is made again can be of another button. So a press says what is true of the store, whichever
 * button it was. Before it adds or skips, it looks whether these purchases are stored already. If they are, it
 * stores nothing and skips nothing, and brings the message up to date with what is stored. And the line that names
 * a card is made from the card that the purchases are stored on, and never from the button: see byCard.
 */
async function pressHeld(
  deps: Deps,
  chatId: number,
  pressed: { messageId: number; choice: string },
  under: number | undefined,
  handling: Handling,
  answer: (text: string) => Promise<void>,
  refuse: () => Promise<void>,
): Promise<void> {
  const { db, messenger, now } = deps
  const user = await findUser(db, chatId)
  if (!user) return refuse()
  const batches = heldStoreFor(db, user.id)
  const batch = await batches.find(pressed.messageId, Math.floor(now().getTime() / 1000))
  const refused = () => {
    log('held_press', { user: user.id, outcome: 'refused', held: 0, stored: 0 })
    return refuse()
  }
  if (!batch) return refused()
  const count = batch.purchases.length
  const day = dayIn(user.timezone, now())
  /** Answers the press, puts the lines in the place of what the message asked, and lets go of the purchases. */
  const done = async (said: string, lines: Line[]) => {
    await answer(said)
    if (typeof under === 'number') {
      const [message] = inMessages(lines)
      await messenger.edit(chatId, under, message.text, message.entities)
    }
    await batches.remove(batch.messageId)
  }

  const store = storeFor(db, user.id)
  // What is stored of these purchases already: something, when an earlier press added them and the buttons stayed.
  const before = await store.findBySourceIds(batch.purchases.map(({ place }) => sourceIdOf(batch.messageId, place)))
  if (before.length === 0 && pressed.choice === 'skip') {
    log('held_press', { user: user.id, outcome: 'skipped', held: count, stored: 0 })
    const these = count === 1 ? 'This purchase was' : `These ${count} purchases were`
    return done('Skipped.', [{ text: `Skipped. ${these} not added:` }, ...heldLines(batch.purchases, day, false)])
  }

  const cards = await store.listCards()
  let kept: Kept
  if (before.length > 0) {
    // What the press asked for was done by the press before it, or cannot be done now that they are stored.
    handling.handled = true
    kept = standing(batch.messageId, batch.purchases, before)
  } else {
    // The card is the one that the purchases are held for or, when they are held for none, the one that the button
    // names. A press that brings the other of the two is none that a button under these purchases holds.
    const last4 = pressed.choice === 'add' ? batch.cardLast4 : batch.cardLast4 === null ? pressed.choice : null
    const card = last4 === null ? undefined : cards.find((each) => each.last4 === last4)
    if (!card) return refused()
    // What the press asked for is done once the purchases are stored, whatever fails after that.
    kept = await keep(store, card, choiceOn(card, batch.category), batch.messageId, batch.purchases, () => {
      handling.handled = true
    })
  }
  log('held_press', { user: user.id, outcome: 'added', held: count, stored: kept.stored })
  const added = kept.added.map((purchase) => ({ ...purchase, date: day(new Date(purchase.occurredAt * 1000)) }))
  const answered = added.length > 0 ? `Added ${counted(added.length)}.` : 'No purchases were added.'
  // After what was added comes the note of those that are counted in the window after theirs: see carriedNotes.
  const on = byCard(cards, added)
  const notes = [...carriedNotes(on, now(), user.timezone, day), ...keptNotes(kept)]
  return done(answered, [...addedLines(on), ...notes.map((text) => ({ text }))])
}

/**
 * Answers the press of a button under a message that asks before a command is run: see confirmFor. "Do it" runs the
 * command as if its user had sent it, and "Cancel" runs nothing. Either way the press is answered, and the message
 * then says which it was under what it asked, with no buttons.
 *
 * After "Do it" the command's reply is sent first, as a message of its own, before the press is answered or the
 * message is edited. The reply can be all that there is of what the command did: the token that /mcp makes is
 * nowhere else, and the one before it is dead by then. So nothing that Telegram refuses after the command has run
 * keeps the reply from the chat. A press that Telegram delivers a second time is one whose edit it refuses, as the
 * message says already what the edit would have it say. And once the reply is sent, neither the answering nor the
 * edit undoes or hides anything by failing: each is tried whatever came of the other, and a request that failed has
 * its own line in the log. A reply that cannot be sent fails the press, with its buttons still there to press again.
 *
 * The line that a button brings is what a client sent, which can be anything. It is run only when it is a line of
 * one of the commands that such a message can ask about, and a press that brings any other is answered with that
 * its button no longer works: a press runs nothing that deletes everything, and nothing that no message asks
 * about. What is run is run by `reply`, for the user who pressed, which takes the line apart as it takes a message
 * apart.
 *
 * Nothing here keeps a press from being made twice. A message that was pressed has no buttons, and a command that
 * is run a second time says so itself, as when its user sends it twice: there is no such purchase, or no such card.
 */
async function pressConfirm(
  deps: Deps,
  chatId: number,
  pressed: { run: boolean; line: string },
  under: NonNullable<Press['message']>,
  handling: Handling,
  answer: (text: string) => Promise<void>,
  refuse: () => Promise<void>,
): Promise<void> {
  const { db, messenger } = deps
  const user = await findUser(db, chatId)
  if (!user) return refuse()
  const { name } = commandIn(pressed.line)
  const command = CONFIRMABLE.find((each) => each === name)
  if (!command) {
    log('confirm_press', { user: user.id, outcome: 'refused' })
    return refuse()
  }
  /** Has the message say what the press was answered with, under what it asked, with no buttons under it. */
  const edited = async (said: string) => {
    if (typeof under.message_id !== 'number' || typeof under.text !== 'string') return
    const marked = codeWithin(under.entities ?? [], under.text.length)
    const text = `${under.text}\n${said}`
    await messenger.edit(chatId, under.message_id, text, marked.length > 0 ? marked : undefined)
  }

  if (!pressed.run) {
    log('confirm_press', { user: user.id, command, outcome: 'cancelled' })
    await answer(CANCELLED)
    return edited(CANCELLED)
  }
  // No command that a press runs stores anything under the id of a message, so it is given none.
  const said = await ran(deps, chatId, 0, pressed.line)
  if (!said) return refuse()
  // What the press asked for is done once the command has run, whatever fails after that.
  handling.handled = true
  log('confirm_press', { user: user.id, command, outcome: 'done' })
  // The reply first: it can be all that there is of what the command did. Then the press is answered and the
  // message edited, each whatever came of the other. A request that Telegram refuses has its line in the log.
  await sendReply(messenger, chatId, said)
  await answer(CONFIRMED_DONE).catch(() => {})
  await edited(CONFIRMED_DONE).catch(() => {})
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
 * the card's current window and is not after today, and for a word of the merchant when it is not: see firstWritten
 * for which days those are. With no year, it names the latest day so written that is not after today: on 2
 * January, "30/12" is the 30th of the December before.
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
  return start !== null && start >= firstWritten(card, now, timeZone) && start <= at ? noonOf(start) : null
}

/**
 * Unix seconds of where the days begin that /add takes for those of the card's current window, when one of them is
 * written D/M. They are the days whose purchases the window counts, which begin before the window does: see
 * currentWindow. On the last days of a window the current one is the next, which is still to start. The days of the
 * window that is closing are taken then too, as they were before a window counted any days but its own.
 */
function firstWritten(card: Card, now: Date, timeZone: string): number {
  const window = currentWindow(card, now, timeZone)
  const counted = countedIn(window).start
  if (now.getTime() >= window.start.getTime()) return counted
  // The window that is closing is the one that counts what was bought just before this one counts anything.
  return currentWindow(card, new Date(counted * 1000 - 1), timeZone).start.getTime() / 1000
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
 * and with the buttons that move it. `messageId` is Telegram's id of the message that described the purchase, and
 * `stored` is called once a purchase for that message is known to be stored.
 */
async function addPurchase(
  store: Store,
  card: Card,
  entry: Entry,
  messageId: number,
  now: Date,
  timeZone: string,
  stored: () => void,
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
  // From here on a purchase for this message is stored: by this delivery of the message, or by an earlier one.
  // Whatever fails after this, its user is not to be told to send the message again.
  stored()

  const [totals] = await cardTotals(store, [card], now, timeZone)
  const date = formatShortDate(new Date(purchase.occurredAt * 1000), timeZone)
  // After where the card stands comes the note of a purchase that is counted in the window after the one that it
  // was made in: see carriedNotes. The line that says where the purchase is sorted stays the last, as a press of a
  // button replaces the last line.
  const shortDate = (day: Date) => formatShortDate(day, timeZone)
  const notes = carriedNotes([{ card, purchases: [purchase] }], now, timeZone, shortDate)
  const told = [spendLine(totals, timeZone), ...notes].map((text) => ({ text }))
  const lines = [purchaseLine(purchase, date), ...told]
  const product = productOf(card.product)
  if (!product) return inMessages(lines)
  const { line, buttons } = sortEnd(product, purchase)
  const [message] = inMessages([...lines, { text: line }])
  return [{ ...message, buttons }]
}

/**
 * Adds the purchases of a reading for the user whose message they were read from, and makes what the user is told
 * of it. It knows nothing of what the reading was made from: a photo's is one, and whatever else gives a reading
 * has its purchases added by this, in the same way.
 *
 * The card is the one that the reading names or, for a user with one card, that card: but not when the reading
 * says that a card was named which is none of the user's, and the card is then not known. The category of a
 * purchase is the one that the reading names, when that is one of the card's, and otherwise where /add would start
 * the purchase. What is clear is stored at once: with the card known, every purchase that the reading is sure of.
 * What is not is held as one batch, for its user to answer for with the buttons under the message that shows it:
 * every purchase that the reading is unsure of and, with the card not known, all of them. See pressHeld for the
 * answer.
 *
 * `cards` are the user's cards, of which there is at least one. `messageId` is Telegram's id of the message: a
 * purchase is stored under it and under its place in the reading, whatever the message was, so that one which is
 * delivered again stores nothing twice. A message that was read before is not to be read again, which is for
 * whoever has a reading made to look to: see readBefore. Two deliveries that are read at the same moment get here
 * all the same, and the second is then told of the purchases as they are stored: under the card that they are on,
 * whichever card its own reading named. What is done is noted in `adding` as it is done: see Adding. Nothing is
 * returned, with nothing stored and nothing held, when the time of whoever waits was up before the storing began.
 */
export async function addRead(
  deps: Deps,
  user: User,
  cards: Card[],
  reading: Reading,
  messageId: number,
  adding: Adding,
): Promise<Added | undefined> {
  const { db, now } = deps
  const store = storeFor(db, user.id)
  // A user's one card stands in for the card that nobody named. It does not for a card that was named and that
  // they have not got: purchases that were said to be on another card are not put on this one without a word.
  const only = cards.length === 1 && !reading.unknownCard ? cards[0] : undefined
  const card = cards.find((each) => each.nickname === reading.card) ?? only
  const named = choiceOn(card, reading.category)
  // No more purchases are taken from one reading than this, whatever it holds. Each has its place from here on.
  const taken = reading.purchases.slice(0, MAX_PURCHASES_PER_PHOTO)
  const read = taken.map(({ occurredAt, amountMinor, currency, merchant, unsure }, place): HeldPurchase => {
    return { place, occurredAt, amountMinor, currency, merchant, unsure }
  })
  const clear = card ? read.filter((purchase) => !purchase.unsure) : []
  const unclear = card ? read.filter((purchase) => purchase.unsure) : read

  if (adding.late) return undefined
  // While the storing is under way, a purchase for the message may be in the store, and counts as one that is. A
  // storing that fails before anything is stored leaves none there. Once it is done, it is known whether one is.
  adding.kept = clear.length > 0
  const kept = await keep(store, card, named, messageId, clear, (stored) => {
    adding.stored = stored
  }).catch((error: unknown) => {
    adding.kept = adding.stored > 0
    throw error
  })
  adding.kept = kept.added.length > 0
  if (unclear.length > 0) {
    const batch = { messageId, cardLast4: card?.last4 ?? null, category: named, purchases: unclear }
    await heldStoreFor(db, user.id).hold(batch, Math.floor(now().getTime() / 1000))
    adding.held = unclear.length
  }

  // One formatter for all the dates: see dayIn.
  const day = dayIn(user.timezone, now())
  const added = kept.added.map((purchase) => ({ ...purchase, date: day(new Date(purchase.occurredAt * 1000)) }))
  let rich: Tabled | undefined
  if (added.length > 0) {
    // What was added is told by the card that it is stored on, which is not the reading's when an earlier delivery
    // of the message stored it on another: see byCard. With it is where it leaves that card, as the reply to /add
    // has it, and after that the note of those that are counted in the window after theirs.
    const on = byCard(cards, added)
    const totals = await cardTotals(store, on.flatMap((each) => each.card ?? []), now(), user.timezone)
    rich = addedReply(on, totals, user.timezone, carriedNotes(on, now(), user.timezone, day))
  }
  const asked = unclear.length > 0 ? [heldPrompt(messageId, unclear, day, cards, card, named)] : []

  // What there is to know besides, a line to each: what was not added, what was not read, and what was not taken.
  const notes = keptNotes(kept)
  if (reading.unreadable > 0) {
    const [purchases, them] = reading.unreadable === 1 ? ['purchase', 'it'] : ['purchases', 'them']
    // They are more where others were read, which their user has been told of by then.
    const count = `${reading.unreadable} ${read.length > 0 ? 'more ' : ''}${purchases}`
    notes.push(`${count} could not be read at all. Add ${them} by hand with /add.`)
  }
  if (reading.more || reading.purchases.length > taken.length) {
    notes.push(
      `Only the first ${MAX_PURCHASES_PER_PHOTO} purchases of a message are read. Send the rest on their own, or ` +
        'add them with /add.',
    )
  }
  return { rich, text: notes.length > 0 ? [...asked, { text: notes.join('\n') }] : asked }
}

/** What `keep` comes to when it is given no purchases. */
const NOTHING_KEPT: Kept = { added: [], stored: 0, takenOut: 0, leftOut: 0 }

/**
 * Stores purchases of a reading on a card, as /add stores one: they are purchases that their user added by hand,
 * and count as such. `named` is the category that the reading named for them, or null: a purchase then starts
 * where /add would start it. Nothing is stored when there is no card to store it on, or nothing to store.
 *
 * No alert gives these purchases ids to be known by, so each is known by the message that it was read from and by
 * its place in the reading. Telegram delivers a message again when it has not heard that the message was taken,
 * and a button under purchases that are held can be pressed twice: neither stores a purchase a second time.
 *
 * `stored` is called once the purchases are in the store, with how many of them this storing put there. Whatever
 * fails after that, they are stored.
 */
async function keep(
  store: Store,
  card: Card | undefined,
  named: string | null,
  messageId: number,
  purchases: HeldPurchase[],
  stored: (count: number) => void,
): Promise<Kept> {
  if (!card || purchases.length === 0) return NOTHING_KEPT
  const given = purchases.map(({ place, occurredAt, amountMinor, currency, merchant }) => {
    const described = { cardLast4: card.last4, amountMinor, currency, merchant, occurredAt }
    const category = named ?? startingCategoryOn(card, described)
    return { ...described, sourceId: sourceIdOf(messageId, place), category }
  })
  // One statement for all of them, and their ids come back with what each is stored under.
  const ids = new Map((await store.insertByHand(given)).map(({ sourceId, id }) => [sourceId, id]))
  stored(ids.size)
  // The store adds no purchase past the limit, and none under a source id that it has one under already. Which of
  // the two it was is looked up only now that one of them has happened. A purchase that is stored already is told
  // of as it stands, which is what the first delivery of its message told of.
  const rest = given.filter(({ sourceId }) => !ids.has(sourceId)).map(({ sourceId }) => sourceId)
  const earlier = rest.length > 0 ? await store.findBySourceIds(rest) : []

  const kept: Kept = { added: [], stored: ids.size, takenOut: 0, leftOut: 0 }
  for (const { sourceId, ...purchase } of given) {
    const id = ids.get(sourceId)
    const before = earlier.find((each) => each.sourceId === sourceId)
    if (id !== undefined) kept.added.push({ ...purchase, id, parser: MANUAL })
    else if (!before) kept.leftOut++
    else if (before.removedAt === null) kept.added.push(before)
    else kept.takenOut++
  }
  return kept
}

/**
 * What became of purchases of a message of which some are stored already, when nothing more is stored now: what
 * `keep` would come to for them. `before` are those that are stored. Each that is not was left out for the limit
 * on purchases by hand when the others were stored, as one statement stores all that it has room for.
 */
function standing(messageId: number, purchases: HeldPurchase[], before: Sourced[]): Kept {
  const kept: Kept = { added: [], stored: 0, takenOut: 0, leftOut: 0 }
  for (const { place } of purchases) {
    const stored = before.find((each) => each.sourceId === sourceIdOf(messageId, place))
    if (!stored) kept.leftOut++
    else if (stored.removedAt === null) kept.added.push(stored)
    else kept.takenOut++
  }
  return kept
}

/**
 * Purchases by the card that each is stored on, a group to each card, in the order in which the cards first come.
 * Whatever names a card for purchases that are stored goes by this, and not by the card that a reading named or
 * that a button was for: a message that was delivered twice, or a button that was pressed after another, can bring
 * another card than the one that the purchases went to. `cards` are the user's. A card that they have removed since
 * is known by its last four digits alone.
 */
function byCard(cards: Card[], purchases: Dated[]): OnCard[] {
  const on = new Map<string, Dated[]>()
  for (const purchase of purchases) on.set(purchase.cardLast4, [...(on.get(purchase.cardLast4) ?? []), purchase])
  return [...on].map(([last4, those]) => ({
    last4,
    card: cards.find((each) => each.last4 === last4),
    purchases: those,
  }))
}

/**
 * What gives the day of a purchase that was read from a message, as its user is shown it: the day and the month,
 * as `shortDateIn` has them, and the year too when it is not the year that it is now in the time zone, as in
 * "5 Oct 2025". A photo mostly shows no year, so the year is the model's to choose, and a wrong one is not to go
 * unseen: a purchase of another year is in no window that anything is counted over. One formatter is made for all
 * the days of a reply, as there.
 */
function dayIn(timeZone: string, now: Date): (date: Date) => string {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric', month: 'short', year: 'numeric' })
  const thisYear = String(dayOf(now, timeZone).year)
  return (date) => {
    const parts = format.formatToParts(date)
    const get = (type: 'day' | 'month' | 'year') => parts.find((part) => part.type === type)?.value
    return get('year') === thisYear ? `${get('day')} ${get('month')}` : `${get('day')} ${get('month')} ${get('year')}`
  }
}

/**
 * The category that a reading named, when it is one that a purchase on the card can be put in by hand. Null when it
 * is not, when the reading named none, and when the card is not known.
 */
function choiceOn(card: Card | undefined, named: string | null): string | null {
  const product = productOf(card?.product)
  return product && choicesOf(product).some((choice) => choice.key === named) ? named : null
}

/** A count of purchases as a user is told it: "1 purchase", or "3 purchases". */
function counted(count: number): string {
  return `${count} ${count === 1 ? 'purchase' : 'purchases'}`
}

/**
 * What a user is told of those purchases of a reading that were to be stored and were not, a line to each fact: how
 * many they had taken out since an earlier delivery stored them, and how many the limit on purchases by hand left
 * out. Nothing in it says to send the message again: other purchases of the message may be stored.
 */
function keptNotes({ takenOut, leftOut }: Kept): string[] {
  const notes: string[] = []
  if (takenOut > 0) {
    const [have, are] = takenOut === 1 ? ['has', 'is'] : ['have', 'are']
    notes.push(`${takenOut} of these purchases ${have} been taken out, and ${are} not added again.`)
  }
  if (leftOut > 0) {
    const [were, them] = leftOut === 1 ? ['was', 'it'] : ['were', 'them']
    notes.push(
      `${counted(leftOut)} ${were} not added. You have added ${MAX_BY_HAND_PER_DAY} purchases by hand in the last ` +
        '24 hours, which is as many as can be added in that time. A purchase that the bot reads for you counts as ' +
        `one. Add ${them} with /add later.`,
    )
  }
  return notes
}

/**
 * Where purchases are put, as their user is told it: the card and, on a card with a product, the category, as in
 * "evol ••••5678 as Other Spend". `category` is the key of the category that they are in, or null for purchases
 * that are in none.
 */
function placed(card: Card, category: string | null): string {
  const product = productOf(card.product)
  if (!product) return label(card)
  const name = categoryName(product, category)
  return name === undefined ? `${label(card)}, not sorted` : `${label(card)} as ${name}`
}

/**
 * What the tables of purchases that were added to one card are of: one table for each category of the card's
 * product that a purchase of them is in, in the product's order, and one in all on a card with no product. A table
 * is named for its card and its category, which is the line that it is under, and ends with what its purchases
 * come to. Purchases on a card that their user has removed since are named for its last four digits.
 */
function addedSections({ last4, card, purchases: added }: OnCard): Section[] {
  const product = productOf(card?.product)
  const section = (purchases: Dated[], category: string | null): Section => ({
    name: `Added to ${card ? placed(card, category) : maskLast4(last4)}:`,
    purchases,
    spent: perCurrency(purchases),
  })
  if (!product) return [section(added, null)]
  // A purchase is told apart by what is stored for it. Where it is is what the product makes of that.
  const among = added.map((purchase) => ({ purchase, category: categoryOf(product, purchase.category) }))
  const keys = [...categoriesOf(product).map((category) => category.key), null]
  return keys.flatMap((key) => {
    const there = among.filter(({ category }) => category === key).map(({ purchase }) => purchase)
    return there.length > 0 ? [section(there, key)] : []
  })
}

/**
 * What was added once its user answered for it, as the lines of a message of text: each purchase on a line, with
 * its id, under the line that names its card and its category. This is what the message that asked about the
 * purchases is edited to say, and a message of text is not edited into a rich one: see sendLater. `on` are the
 * purchases by the card that each is stored on: see byCard.
 */
function addedLines(on: OnCard[]): Line[] {
  return on.flatMap(addedSections).flatMap(({ name = '', purchases }) => [
    { text: name },
    ...purchases.map((purchase) => purchaseLine(purchase, purchase.date)),
  ])
}

/**
 * What was added from a reading, as a reply: the purchases in tables like those of /spend with a card, each under
 * the line that names its card and its category, and after them where the card then stands, in the line that the
 * reply to /add has. It is one rich message. As text, a table is a block: see purchaseTables. `on` are the
 * purchases by the card that each is stored on, which is one card but for a message that was read twice, and
 * `totals` are what each of those cards then comes to. `notes` is the note of the purchases that are counted in the
 * window after theirs, when there is one, which comes last: see carriedNotes.
 */
function addedReply(on: OnCard[], totals: CardTotals[], timeZone: string, notes: string[]): Tabled {
  const homeCurrency = (card?: Card) => productOf(card?.product)?.homeCurrency ?? DEFAULT_CURRENCY
  // Every purchase of a reading is one that was added by hand, and is marked so in its table.
  const below = [BY_HAND_NOTE, ...totals.map((each) => spendLine(each, timeZone)), ...notes]
  return {
    rich: {
      blocks: [
        ...on.flatMap((each) => purchaseBlocks(addedSections(each), homeCurrency(each.card))),
        ...below.map((text): RichBlock => ({ type: 'paragraph', text })),
      ],
      skip_entity_detection: true,
    },
    asText() {
      const parts: (Line | Table)[][] = [
        ...on.flatMap((each) => purchaseTables(addedSections(each), homeCurrency(each.card))).map((table) => [table]),
        ...below.map((text) => [{ text }]),
      ]
      // An empty line before each part. A message does not begin with one.
      return inMessages(parts.flatMap((part) => [{ text: '' }, ...part]))
    },
  }
}

/** Purchases that are held, each on a line: see heldLine. */
function heldLines(held: HeldPurchase[], shortDate: (date: Date) => string, flagged: boolean): Line[] {
  return held.map((purchase) => heldLine(purchase, shortDate(new Date(purchase.occurredAt * 1000)), flagged))
}

/**
 * The message that asks about purchases that are held: what is asked, each purchase on a line, and the buttons that
 * answer. With the card known, they are the purchases that the reading was not sure of, and one button adds them
 * while another skips them. With the card not known, they are all the purchases of the reading, each marked when the
 * reading was not sure of it, and in the place of the button that adds them there is one for each of the user's
 * cards. `named` is the category that the reading named, or null.
 */
function heldPrompt(
  messageId: number,
  held: HeldPurchase[],
  shortDate: (date: Date) => string,
  cards: Card[],
  card: Card | undefined,
  named: string | null,
): Outgoing {
  const count = held.length
  if (card) {
    // The category is named only when the reading named one: with none, each purchase starts where /add puts it.
    const where = named === null ? label(card) : placed(card, named)
    const head =
      count === 1
        ? `Not sure about this purchase. Check its amount and its date before you add it to ${where}:`
        : `Not sure about these ${count} purchases. Check the amount and the date of each before you add them ` +
          `to ${where}:`
    const [message] = inMessages([{ text: head }, ...heldLines(held, shortDate, false)])
    return { ...message, buttons: heldButtons(messageId, count) }
  }
  const head =
    count === 1
      ? 'Which card was this purchase made with? The bot could not tell.'
      : `Which card were these ${count} purchases made with? The bot could not tell.`
  const foot = held.some((purchase) => purchase.unsure) ? [{ text: UNSURE_NOTE }] : []
  const [message] = inMessages([{ text: head }, ...heldLines(held, shortDate, true), ...foot])
  return { ...message, buttons: heldButtons(messageId, count, cards) }
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

/**
 * A card in one line, with its window and, when it is linked to one, the name of its product: as the bot says which
 * card it has added, and as /cards lists a card when its reply is sent as text.
 */
function describeCard(card: Card): string {
  const product = productOf(card.product)
  return `${label(card)}: ${describeWindow(card)}${product ? `, ${product.name}` : ''}`
}

function spendLine(each: CardTotals, timeZone: string): string {
  return `${label(each.card)}: ${describeTotals(each, timeZone)}`
}

// The replies that set values out in one table, so that each value is under a header, or beside a name, that says
// what it is: those to /cards, to /spend with no card named, to /products and to /status. Each is one rich message.
// As text, which is sent when Telegram does not take the rich message, each is the lines that the command replied
// with before it had a table.

/**
 * A table of a rich message, drawn with lines: the row that names its columns, when it has one, and its rows.
 * `right` are the columns whose cells are set to the right, as amounts and counts are in the tables of purchases.
 */
function tableOf(header: string[] | undefined, rows: string[][], right: number[] = []): RichBlock {
  const cell = (text: string, column: number): TableCell =>
    right.includes(column) ? { text, align: 'right' } : { text }
  const named = (header ?? []).map((text, column): TableCell => ({ ...cell(text, column), is_header: true }))
  const cells = [...(header ? [named] : []), ...rows.map((row) => row.map(cell))]
  return { type: 'table', cells, is_bordered: true }
}

/** A reply that is one rich message of the blocks. `text` makes the text that is sent in its place: see Tabled. */
function tabled(blocks: RichBlock[], text: () => string): Tabled {
  return { rich: { blocks, skip_entity_detection: true }, asText: () => [{ text: text() }] }
}

/** A line of a reply as a block of its rich message. */
function paragraphOf(text: string): RichBlock {
  return { type: 'paragraph', text }
}

/**
 * A user's cards, as /cards shows them: one table, with a row for each card. A card that is linked to no product
 * has a dash where the name of its product would be, as a purchase with no merchant has one for its merchant. As
 * text, it is a line for each card: see describeCard.
 */
function cardsReply(cards: Card[]): Tabled {
  const rows = cards.map((card) => [
    card.nickname,
    maskLast4(card.last4),
    describeWindow(card),
    productOf(card.product)?.name ?? '-',
  ])
  return tabled([tableOf(['Nickname', 'Card', 'Window', 'Product'], rows)], () => cards.map(describeCard).join('\n'))
}

/**
 * What a user has spent on each of their cards in its current window, as /spend with no card named shows it: one
 * table, with a row for each card, and under it why some days are counted and that the totals are estimates.
 *
 * `Spent` is what the card's window comes to, a currency at a time. Nothing spent is none of the card's own
 * currency, as in the tables of /spend with a card. `Counted` is the days of the purchases that the total counts,
 * which are the window's own or some days earlier than those: see currentWindow. `Resets` is the day on which the
 * total starts again, which is the first day of the next window. Why the days are other than the window's own is
 * said once for all the cards, when it is so of any.
 *
 * As text, a card has a line, and under that which days its total counts, when they are not its window's own.
 */
function spendReply(totals: CardTotals[], timeZone: string): Tabled {
  // One formatter writes all the dates: see shortDateIn.
  const shortDate = shortDateIn(timeZone)
  const why = totals.some(({ window }) => window.counts) ? [COUNTED_BY_POSTING] : []
  const below = [...why, 'Totals are estimated from bank alerts.']
  const rows = totals.map(({ card, window, totals: spent, count }) => {
    const nothing = [{ currency: productOf(card.product)?.homeCurrency ?? DEFAULT_CURRENCY, amountMinor: 0 }]
    const { start, end } = window.counts ?? window
    // The last day that is counted is the one before the end, which is the first that is not.
    const counted = `${shortDate(start)} to ${shortDate(new Date(end.getTime() - 1))}`
    const resets = shortDate(window.end)
    return [card.nickname, formatTotals(spent.length > 0 ? spent : nothing), String(count), counted, resets]
  })
  const table = tableOf(['Nickname', 'Spent', 'Purchases', 'Counted', 'Resets'], rows, [1, 2])
  return tabled([table, ...below.map(paragraphOf)], () => {
    const lines = totals.flatMap((each) => [spendLine(each, timeZone), ...countedDays(each.window, shortDate)])
    return [...lines, '', ...below].join('\n')
  })
}

/**
 * The card products whose reward rules are known, as /products shows them: a table of the key of each and its name,
 * under the line that says what they are and over the one that says how a card is linked to one. As text, a
 * product has a line.
 */
function productsReply(): Tabled {
  const above = 'The card products whose reward rules are known:'
  const below = 'To link a card to one, send /product <nickname> <product key>. Or add the key to the end of /addcard.'
  const rows = products.map(({ key, name }) => [key, name])
  return tabled([paragraphOf(above), tableOf(['Key', 'Product'], rows), paragraphOf(below)], () =>
    [above, ...products.map(({ key, name }) => `${key} - ${name}`), '', below].join('\n'),
  )
}

/**
 * A card's current window in full: its purchases from the earliest on, in tables that end with what they come to,
 * and after the tables what the whole window comes to. A card with a product has a table for each group of the
 * product, which ends with the group's limit where it has one, and then how far the spend is towards the product's
 * minimum, when it has one. A card with no product has one table, of all its purchases. It is one rich message. As
 * text, it can come to more than one message takes.
 *
 * The purchases are those that the window counts, which begin some days before the window does: see currentWindow.
 * The heading has the window as its bank has it, each purchase has its own day, and the line under the total says
 * which days are counted, and why.
 */
async function spendDetail(store: Store, card: Card, now: Date, timeZone: string): Promise<Tabled> {
  const window = currentWindow(card, now, timeZone)
  const { start, end } = countedIn(window)
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
    [
      `Total: ${describeTotals({ card, window, totals: perCurrency(sums), count }, timeZone)}`,
      ...describeCounted(card, window, shortDate),
    ],
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

/**
 * Whether a user's Gmail is connected and what has been read from it, as /status shows it: one table with no row of
 * headers, in which a row is what a value is and the value. Whose Gmail it is comes first, and how it stands when
 * there is one. Under the table is what there is to do about it, when there is anything: to connect it, or to
 * connect it again. As text, it is three lines.
 */
function statusReply(connection: Connection | null, summary: MailSummary, timeZone: string): Tabled {
  const { lastCheckedAt, purchases, unparsed } = summary
  const checked = lastCheckedAt === null ? 'not yet' : formatShortDateTime(new Date(lastCheckedAt * 1000), timeZone)
  const active = connection?.status === 'active'
  const gmail = connection
    ? [
        ['Gmail', connection.email],
        ['Status', active ? 'connected' : 'needs reconnecting'],
      ]
    : [['Gmail', 'not connected']]
  const rows = [
    ...gmail,
    ['Alerts last fully checked', checked],
    [`Purchases recorded, last ${STATUS_DAYS} days`, String(purchases)],
    [`Alerts that could not be read, last ${STATUS_DAYS} days`, String(unparsed)],
  ]
  const toDo = active ? [] : [`Send /connect to ${connection ? 'reconnect' : 'connect'} it.`]
  return tabled([tableOf(undefined, rows), ...toDo.map(paragraphOf)], () =>
    [
      gmailStatus(connection),
      `Alerts last fully checked: ${checked}`,
      `Last ${STATUS_DAYS} days: ${purchases} ${purchases === 1 ? 'purchase' : 'purchases'} recorded, ` +
        `${unparsed} ${unparsed === 1 ? 'alert' : 'alerts'} could not be read`,
    ].join('\n'),
  )
}

function gmailStatus(connection: Connection | null): string {
  if (!connection) return 'Your Gmail is not connected. Send /connect to connect it.'
  const gmail = `Your Gmail ${connection.email}`
  return connection.status === 'active'
    ? `${gmail} is connected.`
    : `${gmail} needs reconnecting. Send /connect to reconnect it.`
}
