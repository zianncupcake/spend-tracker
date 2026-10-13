// The carrying out of what the assistant makes of a message: the asking of it, the things that it asks to have
// done, each of which the bot's own code does, and the queries that they may run between them.

import { answerQuestion, type Action, type Answer } from '../ai/assistant'
import { categoryOf, choicesOf, productOf } from '../catalogue'
import type { Deps } from '../deps'
import { CONFIRMABLE, Failure, log, logFailure, type Events } from '../log'
import { findOrCreateUser, MAX_CARDS, storeFor, type User } from '../store'
import { addRead, readBefore, type Adding } from './adding'
import type { RichBlock } from './api'
import { commandIn, ran } from './commands'
import { confirmFor } from './confirming'
import { inMessages, MAX_LENGTH, sortEnd } from './purchases'
import { busyReply, label, spendDetail } from './replies'
import type { Asked, Deferred, Made, Reply, Sent, Tabled } from './sending'
import { declined, type Carried } from './shared'
import {
  DOING,
  DONE_NO_REPLY,
  MAX_QUESTION_LENGTH,
  NO_ASSISTANT,
  NO_CARDS,
  NO_MORE,
  NO_PURCHASES_SAID,
  NOT_ANSWERED,
  NOT_DONE,
  ONE_ADDING,
  QUESTION_TOO_LONG,
  READ_ALREADY,
  REST_NOT_DONE,
  TOOK_TOO_LONG,
  WORKING,
} from './texts'

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
   * Whether find_purchases had given the model anything before it asked for these: see `Answer` in
   * ../ai/assistant. What it returns holds text that somebody else wrote, as the name of a merchant is, and a
   * model can take such text for its user's wish. So what it asks for after it has read is trusted less: see act.
   */
  afterReading: boolean
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

/** The most blocks that Telegram takes in a rich message: see RichMessage. An answer has one to each of its lines. */
const MAX_PARAGRAPHS = 500

/**
 * The commands that the assistant has run at once, as if their user had sent them: the adding of a card, the
 * renaming of one and the changing of the time zone, each of which is undone in one step, and those that only show
 * things. It is a list of what is run, and not of what is not: a command that the bot is given later is run for no
 * model until somebody puts it here. See runAsked for what becomes of every other line.
 */
const RUN_AT_ONCE = [
  'addcard',
  'renamecard',
  'timezone',
  'cards',
  'spend',
  'sort',
  'products',
  'patterns',
  'status',
] as const

/**
 * Those of them that change something: the user's cards, or the user. They are asked about first, as the commands
 * below are, when the model had read with a tool before it asked for them: see Asking. And after one of them is
 * run, the user and their cards are read again for what the model asks for next: see actInRounds.
 */
const CHANGING = ['addcard', 'renamecard', 'timezone'] as const

/**
 * The commands that are asked about first, whatever the model had read: those that remove or revoke. They are the
 * taking out of a purchase or of a card, the giving up of the access to a Gmail, the removing of an assistant's
 * token, the making of a new one, which ends the one that there is, the starting of a sign-in, which cancels one
 * that is waiting for its code, the removing of a pattern or of a reminder, or the saving of one, which takes the
 * place of the one that there is, and the linking of a card to a product, which forgets what was marked by hand
 * under another. The assistant runs none of them: each waits for its user to press a button. So they are what a
 * press may run, but for the commands above: see CONFIRMABLE in ../log.
 */
const ASKED_FIRST = CONFIRMABLE.filter((name) => !CHANGING.some((changing) => changing === name))

/**
 * The most queries that the things which are done for one message may run between them, each counted at the most
 * that it can run: the actions of all the answers that the model gives to the message, when it gives them one at a
 * time, and what is read again between two of them: see actInRounds. An action that there is no room left for is
 * not begun, and neither is any after it: see act.
 *
 * A request may run 50 queries, and the answering runs its own. Two of them are run for every message: one for the
 * user, and one for their cards. The calls of the tools that read can run twelve besides, whether they give the
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
 * What a command that is run at once is counted at, but for /spend with no card named, which runs one for each card
 * and two more. None runs more: the most is five, as /addcard with a product runs, which are the user, the adding,
 * the purchases of the card's window, and a statement for each category that a rule of the product gives, of which
 * a product has two at the most.
 */
const COMMAND_QUERIES = 6

/**
 * The most cards that are each shown in full when the assistant is asked to show what was spent on every card: see
 * showAsked. Each is a rich message of its own, and five of those are as many as one message of the user's should
 * set off. A user with more cards is shown what /spend with no card named shows, which is one message.
 */
const SHOWN_IN_FULL = 5

/**
 * The reply to a question for the assistant. Where the bot has one, it is a reply that is still to be made, as the
 * answer takes the seconds that a model takes over it: see sendLater for what its user is shown in the meantime.
 *
 * The assistant answers, or makes out what the message asks the bot to do. What it makes out is done here, and by
 * nothing of its own: see actInRounds. `messageId` is Telegram's id of the message, which purchases that it asks to
 * have added are stored under.
 */
export function ask(
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
  let { user } = how
  for (let answer = first; ; ) {
    const { actions, afterReading } = answer
    noted.actions = before + actions.length
    dropped += answer.dropped
    const acted = await act(deps, { ...how, user, afterReading }, actions, before)
    if (!acted) return undefined
    replies.push(...acted.replies)
    before += actions.length
    if (!acted.outcomes) break
    // After a command that can change them, what the model asks for next goes by the user and their cards as they
    // then are: two queries, the one for the user here and the assistant's for the cards. With no room left for
    // them, the model is asked no more.
    const changed = acted.outcomes.some((outcome, at) => outcome === 'done' && changes(actions[at]))
    if (!answer.next || (changed && !take(how.room, 2))) {
      if (answer.more) replies.push([{ text: NO_MORE }])
      break
    }
    if (changed) user = await findOrCreateUser(deps.db, how.telegramId)
    const next = await answer.next(acted.outcomes.map(toldOf), changed)
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

/** Whether an action is the running of a command that can change the user's cards, or the user: see CHANGING. */
function changes(action: Action): boolean {
  return action.kind === 'command' && CHANGING.some((each) => each === commandIn(action.line).name)
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
 * The assistant gives the nickname of a card that its user had when it checked the call. When that card is there no
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
  // The user's patterns, which are read once for all the cards, and two queries for each card: see spendDetail.
  if (!take(room, 1 + 2 * shown.length)) return 'full'
  const now = deps.now()
  const patterns = await store.listPatterns()
  const replies = await Promise.all(shown.map((card) => spendDetail(store, card, patterns, now, user.timezone)))
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
