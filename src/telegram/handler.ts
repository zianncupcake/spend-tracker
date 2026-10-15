import { categoriesOf, productOf } from '../catalogue'
import type { Deps } from '../deps'
import { markAs } from '../domain/sorting'
import { log, logFailure } from '../log'
import { findUser, storeFor } from '../store'
import { ask } from './actions'
import { pressHeld } from './adding'
import { ChatBlockedError } from './api'
import { reply } from './commands'
import { pressConfirm } from './confirming'
import { readLater, sizesOf } from './photos'
import { readConfirmPress, readHeldPress, readPress, sortEnd } from './purchases'
import { sendLater, sendReply } from './sending'
import { codeWithin, type Handling, type Press, type Seen } from './shared'
import { EDITED, FAILED, failureReply, NOT_TEXT, NOT_TEXT_OR_PHOTO, PRESS_FAILED, STORED_NO_REPLY } from './texts'

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

/**
 * What is left to be done about an update once Telegram has been told that the update was taken: see Deferred. It
 * does not throw: what comes of it is logged, as what came of the update was.
 */
export type Later = () => Promise<void>

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
  handling.tell = (error) => deps.messenger.send(chatId, failureReply(FAILED, error, deps.ray))

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
    handling.tell = (error) => deps.messenger.send(chatId, failureReply(STORED_NO_REPLY, error, deps.ray))
  }
  const answer =
    (await reply(deps, from.id, messageId, text, seen, stored)) ?? ask(deps, from.id, messageId, text.trim())
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
    await tell(error)
    return true
  } catch {
    return false
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
  handling.tell = (error) => messenger.answer(id, failureReply(PRESS_FAILED, error, deps.ray))
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
  const category = product && categoriesOf(product).find((choice) => choice.key === pressed.category)
  if (!product || !category) return refuse()

  // This one purchase is all that a press moves. What is remembered of it for later purchases: see markAs.
  await markAs(store, product, purchase, category.key)
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
