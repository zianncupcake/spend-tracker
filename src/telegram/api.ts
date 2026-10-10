// Sending the bot's messages through the Telegram Bot API, and what goes with the buttons under some of them:
// https://core.telegram.org/bots/api#sendmessage
// https://core.telegram.org/bots/api#sendrichmessage
// https://core.telegram.org/bots/api#answercallbackquery
// https://core.telegram.org/bots/api#editmessagetext
// https://core.telegram.org/bots/api#sendchataction

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
export class ChatBlockedError extends Error {
  name = 'ChatBlockedError'
}

/**
 * Telegram answered a request with any other error: `status` is the HTTP status of its answer. It has the name of a
 * plain Error, which is what the logs know a failed request by.
 */
export class TelegramError extends Error {
  constructor(
    method: string,
    readonly status: number,
  ) {
    super(`Telegram ${method} failed with status ${status}`)
  }
}

export interface Messenger {
  send(chatId: number, text: string, entities?: MessageEntity[], buttons?: Button[][]): Promise<void>
  /**
   * Sends a rich message. Rich messages are new to Telegram, so it may answer one with an error where it would
   * take text: that is a TelegramError, and the caller can then send the same as text.
   */
  sendRich(chatId: number, message: RichMessage): Promise<void>
  /** Answers the press of a button, which ends the wait that the button shows. The text is shown for a moment. */
  answer(pressId: string, text: string): Promise<void>
  /** Puts new text in the place of a message's, with new buttons under it or none. */
  edit(chatId: number, messageId: number, text: string, entities?: MessageEntity[], buttons?: Button[][]): Promise<void>
  /**
   * Shows the chat that the bot is writing. Telegram shows it for five seconds at most, or until the bot's next
   * message comes.
   */
  typing(chatId: number): Promise<void>
}

export function telegramMessenger(token: string): Messenger {
  async function call(method: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    // The URL holds the bot token and the body holds the message, so neither goes into the error.
    if (response.status === 403) throw new ChatBlockedError()
    if (!response.ok) throw new TelegramError(method, response.status)
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
    typing(chatId) {
      return call('sendChatAction', { chat_id: chatId, action: 'typing' })
    },
  }
}
