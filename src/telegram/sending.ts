// The replies as they are sent: what a reply is, and the sending of one, at once or, for a reply that is still to
// be made, later, with a placeholder in the chat in the meantime.

import type { Deps } from '../deps'
import type { Events } from '../log'
import { ChatBlockedError, TelegramError, type Messenger, type Outgoing, type RichMessage } from './api'
import { failureReply } from './texts'

/**
 * A reply that is sent as one rich message: one that has tables in it, in which a table is drawn as one, or an
 * answer of the assistant's. Rich messages are new to Telegram, so when it answers this one with an error, the
 * reply is sent as text instead: `asText` makes the messages of that, when they are needed.
 */
export interface Tabled {
  rich: RichMessage
  asText: () => Outgoing[]
}

/**
 * What a message is answered with: plain text, or messages with a name marked in them or buttons under them, or a
 * reply that is sent as a rich message.
 */
export type Reply = string | Outgoing[] | Tabled

/** One reply as it is sent: a rich message, which goes as text when Telegram does not take it, or messages of text. */
export type Sent = Tabled | Outgoing[]

/**
 * What the making of a reply that was left for later comes to. It is the reply, which is sent in messages of its
 * own: a rich message, messages of text after it, or both. Or it is several replies, to be sent in their order: one
 * for each thing that the assistant was asked to do. Or it is what its user is told in the place of one, with what
 * went wrong when something did: a question that was not answered, or a photo that nothing was added from.
 */
export type Made<Outcome> =
  | { outcome: Outcome; rich?: Tabled; text?: Outgoing[] }
  | { outcome: Outcome; replies: Sent[] }
  | { outcome: Outcome; notice: string; error?: unknown }

/**
 * A reply that is still to be made: the answer to a question, or what came of the reading of a photo. A model takes
 * seconds over either, and Telegram posts an update again when it has waited too long to hear that the update was
 * taken. So such a reply is made, and sent, once Telegram has heard that: see sendLater.
 */
export interface Deferred<Outcome extends string> {
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
  /** What is done once the reply is sent whole, with the replies that were sent. It does not throw. */
  sent?(replies: Sent[]): Promise<void>
  /**
   * Writes the line that the log has of the reply, once it has ended: after `ms` milliseconds, and with what went
   * wrong, when anything did.
   */
  record(ms: number, wrong: unknown): void
}

/**
 * What the log has of a question, but for how long its answering took. It is noted as the answering goes on, so that
 * a question is logged with as much as was learnt of it, however its answering ends. See `question` in ../log.
 */
export type Asked = Omit<Events['question'], 'ms'>

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

export async function sendReply(messenger: Messenger, chatId: number, answer: Reply): Promise<void> {
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
export async function sendLater<Outcome extends string>(
  { messenger, now, ray }: Deps,
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
        await reply.sent?.(replies)
      }
      noted.outcome = came.outcome
    } catch (error) {
      if (error instanceof ChatBlockedError) throw error
      notice = reply.failed()
      wrong = error
    }
    if (notice !== undefined) {
      const said = wrong === undefined ? notice : failureReply(notice, wrong, ray)
      noted.sent = await sayInstead(messenger, chatId, placeholder, said)
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
