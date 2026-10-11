// Sending the bot's messages through the Telegram Bot API, and what goes with the buttons under some of them:
// https://core.telegram.org/bots/api#sendmessage
// https://core.telegram.org/bots/api#sendrichmessage
// https://core.telegram.org/bots/api#answercallbackquery
// https://core.telegram.org/bots/api#editmessagetext
// https://core.telegram.org/bots/api#deletemessage
// https://core.telegram.org/bots/api#sendchataction
// And fetching a file that the bot was sent, such as a photo:
// https://core.telegram.org/bots/api#getfile

import { Failure, logFailure, type Events } from '../log'

/**
 * The methods of Telegram's API that the bot calls. A method is what the log knows a request that failed by. The
 * download of a file is no method of the API, and is known as one all the same: `downloadFile`.
 */
type Method = Events['telegram_failed']['method']

/**
 * How long Telegram is given to answer one request, in milliseconds. A request that it never answers would
 * otherwise be waited for until Cloudflare ends the Worker, and nothing that was to come after it would be done, or
 * logged: the answering of a question waits for its placeholder to be sent, and the telling that an answer could not
 * be sent waits for the answer.
 */
const REQUEST_TIMEOUT = 5_000

/**
 * A stretch of a message's text that is shown in a way of its own: Telegram's MessageEntity, of the two types that
 * the bot uses. Both are shown in letters that are all of one width: "code" is a stretch within a line, and "pre"
 * is a block of whole lines, which is what lets the columns of a table line up. Telegram makes a command or a link
 * of whatever looks like one in the text of a message. It makes none inside a stretch of either type, because such
 * a stretch holds no other entity. The offset and the length are in UTF-16 code units, which is what the indices
 * and the length of a string are.
 */
export interface MessageEntity {
  type: 'code' | 'pre'
  offset: number
  length: number
}

/**
 * A button under a message: Telegram's InlineKeyboardButton, of the kind that sends `data` back to the bot when
 * it is pressed. Telegram takes 64 bytes of data at most.
 */
export interface Button {
  text: string
  data: string
}

/** A message for the bot to send: its text, what is marked in it, and the rows of buttons under it. */
export interface Outgoing {
  text: string
  entities?: MessageEntity[]
  buttons?: Button[][]
}

/**
 * Text in a rich message: Telegram's RichText, of the two kinds that the bot uses. A string is plain text, in which
 * nothing is taken for markup. The other kind is such text set in bold.
 */
export type RichText = string | { type: 'bold'; text: string }

/**
 * A cell of a table: Telegram's RichBlockTableCell. A header cell names a column, `colspan` is how many columns a
 * cell that is wider than one takes up, and a cell's text is set to the left unless `align` says otherwise.
 */
export interface TableCell {
  text: string
  is_header?: true
  colspan?: number
  align?: 'right'
}

/**
 * A block of a rich message: Telegram's InputRichBlock, of the two types that the bot uses. A table is rows of
 * cells, and is drawn with lines between them.
 */
export type RichBlock =
  | { type: 'paragraph'; text: RichText }
  | { type: 'table'; cells: TableCell[][]; is_bordered: true }

/**
 * A message that is made of blocks, of which a table is one: Telegram's InputRichMessage, which it has had since
 * Bot API 10.1 of June 2026. Telegram makes a command or a link of whatever looks like one in a rich message too,
 * and `skip_entity_detection` has it make none. So that is always set, and all text is given as plain text: a
 * merchant's name is then shown as it is written, with nothing in it to tap.
 *
 * Telegram takes 32,768 characters, 500 blocks with the rows of the tables counted among them, and 20 columns to a
 * table.
 */
export interface RichMessage {
  blocks: RichBlock[]
  skip_entity_detection: true
}

/** Telegram will not have the chat sent anything: its user has blocked the bot, or their account is gone. */
export class ChatBlockedError extends Failure {
  name = 'ChatBlockedError'

  constructor() {
    super('chat_blocked')
  }
}

/**
 * Telegram answered a request with any other error: `status` is the HTTP status of its answer. It has the name of a
 * plain Error, which is what the logs know a failed request by.
 */
export class TelegramError extends Failure {
  constructor(
    method: string,
    readonly status: number,
  ) {
    super('http_error', `Telegram ${method} failed with status ${status}`)
  }
}

export interface Messenger {
  send(chatId: number, text: string, entities?: MessageEntity[], buttons?: Button[][]): Promise<void>
  /**
   * Sends a message of plain text, as `send` does, and returns the id that Telegram gave it: what the message is
   * edited or deleted by.
   */
  post(chatId: number, text: string): Promise<number>
  /**
   * Sends a rich message. Rich messages are new to Telegram, so it may answer one with an error where it would
   * take text: that is a TelegramError, and the caller can then send the same as text.
   */
  sendRich(chatId: number, message: RichMessage): Promise<void>
  /** Answers the press of a button, which ends the wait that the button shows. The text is shown for a moment. */
  answer(pressId: string, text: string): Promise<void>
  /** Puts new text in the place of a message's, with new buttons under it or none. */
  edit(chatId: number, messageId: number, text: string, entities?: MessageEntity[], buttons?: Button[][]): Promise<void>
  /** Takes a message of the bot's out of its chat. Telegram lets a bot do that for 48 hours after it sent one. */
  delete(chatId: number, messageId: number): Promise<void>
  /**
   * Shows the chat that the bot is writing. Telegram shows it for five seconds at most, or until the bot's next
   * message comes.
   */
  typing(chatId: number): Promise<void>
  /**
   * The bytes of a file that Telegram holds, by its file id. Throws a Failure with the reason `file_too_large` for a
   * file of more than `maxBytes`, and what any other request throws when Telegram refuses or does not answer.
   */
  file(fileId: string, maxBytes: number): Promise<Uint8Array>
}

export function telegramMessenger(token: string): Messenger {
  /**
   * Makes Telegram a request, and returns what `read` makes of its answer to it, which is no error. A request that
   * Telegram has not answered in REQUEST_TIMEOUT is given up on, and fails with what fetch throws then, which is a
   * TimeoutError. A request that fails is logged, whoever made it and whatever they then do about it: with its
   * method, and with the status of the answer when there was one. A request that Telegram takes is not logged: one
   * question makes up to twelve. `read` is given the signal that ends the request too, for an answer whose reading
   * is to end with it.
   */
  async function exchange<Read>(
    method: Method,
    url: string,
    init: RequestInit,
    read: (answer: Response, signal: AbortSignal) => Read | Promise<Read>,
  ): Promise<Read> {
    let status: number | undefined
    try {
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT)
      const response = await fetch(url, { ...init, signal })
      status = response.status
      // The URL holds the bot token and the body holds the message, so neither goes into the error.
      if (response.status === 403) throw new ChatBlockedError()
      if (!response.ok) throw new TelegramError(method, response.status)
      return await read(response, signal)
    } catch (error) {
      // Nothing of the error's message is logged: what fetch throws could quote the URL, which holds the bot token.
      logFailure('telegram_failed', error, { method, status })
      throw error
    }
  }

  /** Posts Telegram a request for a method of its API, with what the method takes: see `exchange`. */
  function request<Read>(
    method: Method,
    body: Record<string, unknown>,
    read: (answer: Response) => Read | Promise<Read>,
  ): Promise<Read> {
    const posted = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    return exchange(method, `https://api.telegram.org/bot${token}/${method}`, posted, read)
  }

  /** Posts Telegram a request whose answer holds nothing that the bot reads. */
  function call(method: Method, body: Record<string, unknown>): Promise<void> {
    return request(method, body, () => {})
  }

  // Plain text, with no parse mode. No message of the bot's has a use for the preview of a link.
  const plain = (text: string, entities?: MessageEntity[]) => ({
    text,
    entities,
    link_preview_options: { is_disabled: true },
  })
  const keyboard = (buttons: Button[][]) => ({
    inline_keyboard: buttons.map((row) => row.map(({ text, data }) => ({ text, callback_data: data }))),
  })

  return {
    send(chatId, text, entities, buttons) {
      const markup = buttons && keyboard(buttons)
      return call('sendMessage', { chat_id: chatId, ...plain(text, entities), reply_markup: markup })
    },
    post(chatId, text) {
      return request('sendMessage', { chat_id: chatId, ...plain(text) }, async (answer) => {
        // Telegram answers with the message as it sent it. Only its id is read.
        const { result } = await answer.json<{ result?: { message_id?: unknown } }>()
        if (typeof result?.message_id !== 'number') {
          throw new Failure('no_message_id', 'Telegram sendMessage returned no message id')
        }
        return result.message_id
      })
    },
    sendRich(chatId, message) {
      return call('sendRichMessage', { chat_id: chatId, rich_message: message })
    },
    answer(pressId, text) {
      return call('answerCallbackQuery', { callback_query_id: pressId, text })
    },
    // A keyboard with no rows takes away the buttons that the message had.
    edit(chatId, messageId, text, entities, buttons = []) {
      return call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        ...plain(text, entities),
        reply_markup: keyboard(buttons),
      })
    },
    delete(chatId, messageId) {
      return call('deleteMessage', { chat_id: chatId, message_id: messageId })
    },
    typing(chatId) {
      return call('sendChatAction', { chat_id: chatId, action: 'typing' })
    },
    async file(fileId, maxBytes) {
      const tooLarge = () => new Failure('file_too_large', `The file holds more than ${maxBytes} bytes`)
      // Telegram answers with where the file is to be had, and with its size when it knows that.
      const { path, size } = await request('getFile', { file_id: fileId }, async (answer) => {
        const { result } = await answer.json<{ result?: { file_path?: unknown; file_size?: unknown } }>()
        if (typeof result?.file_path !== 'string') {
          throw new Failure('no_file_path', 'Telegram getFile returned no file path')
        }
        return { path: result.file_path, size: result.file_size }
      })
      // A file that is too large is no request that failed, so it has no line of one: it is the caller's to log.
      if (typeof size === 'number' && size > maxBytes) throw tooLarge()
      // The address holds the bot token, as that of every request does: see `exchange` for where it never goes.
      const address = `https://api.telegram.org/file/bot${token}/${path}`
      // Room for `maxBytes` is made whatever the file holds, so that is to be what a file may well hold, and no
      // number that stands for no limit: see `bytesWithin`.
      const within = (answer: Response, signal: AbortSignal) => bytesWithin(answer, maxBytes, signal)
      const bytes = await exchange('downloadFile', address, {}, within)
      if (!bytes) throw tooLarge()
      return bytes
    },
  }
}

/**
 * The bytes of an answer's body, or null when it holds more than `most` of them.
 *
 * The body is read once, into room for one byte more than it may hold. The read ends when the room is full or the
 * body is at its end, whichever comes first: so a body that fills the room is too long, and what is left of it is
 * given up on, and one that does not is all there. The bytes are the part of the room that was filled.
 *
 * It is read so because a Worker has little time to compute in. Read the usual way, a body comes 4,096 bytes at a
 * time, with a turn of a loop for each: the 400,000 bytes of a photo were measured at one to two milliseconds so,
 * and at a tenth of one this way. The room is made before anything is read, so what it costs grows with `most`: half
 * a millisecond more at 5 MB.
 *
 * `signal` is what ends the request that the answer is to. A body that stops coming is given up on when it ends,
 * and this then throws what the signal ended with, which is what fetch throws for a request that got no answer.
 */
async function bytesWithin(answer: Response, most: number, signal: AbortSignal): Promise<Uint8Array | null> {
  // An answer with nothing in it has no body to read.
  if (!answer.body) return new Uint8Array(0)
  // The body of an answer is a stream of bytes, which is the kind that can be read into room of the reader's own.
  const reader = answer.body.getReader({ mode: 'byob' })
  // The Fetch standard has a body end with the signal of its request. Whether the runtime ends one so could not be
  // seen, as no test may make a request that a runtime answers: so the reading is ended here, which does no harm to
  // one that the runtime ends too.
  const giveUp = () => void reader.cancel(signal.reason).catch(() => {})
  signal.addEventListener('abort', giveUp)
  if (signal.aborted) giveUp()
  const { value = new Uint8Array(0) } = await reader.readAtLeast(most + 1, new Uint8Array(most + 1))
  // A read that was given up on can end with nothing, as that of a body with nothing in it does.
  signal.throwIfAborted()
  if (value.length <= most) return value
  await reader.cancel()
  return null
}
