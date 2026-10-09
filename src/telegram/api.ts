// Sending the bot's messages through the Telegram Bot API, and what goes with the buttons under some of them:
// https://core.telegram.org/bots/api#sendmessage
// https://core.telegram.org/bots/api#answercallbackquery
// https://core.telegram.org/bots/api#editmessagetext

/**
 * A stretch of a message's text that is shown in a way of its own: Telegram's MessageEntity, of the one type that
 * the bot uses. Telegram makes a command or a link of whatever looks like one in the text of a message. It makes
 * none inside a stretch that is marked as code, because such a stretch holds no other entity. The offset and the
 * length are in UTF-16 code units, which is what the indices and the length of a string are.
 */
export interface MessageEntity {
  type: 'code'
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

/** Telegram will not have the chat sent anything: its user has blocked the bot, or their account is gone. */
export class ChatBlockedError extends Error {
  name = 'ChatBlockedError'
}

export interface Messenger {
  send(chatId: number, text: string, entities?: MessageEntity[], buttons?: Button[][]): Promise<void>
  /** Answers the press of a button, which ends the wait that the button shows. The text is shown for a moment. */
  answer(pressId: string, text: string): Promise<void>
  /** Puts new text in the place of a message's, with new buttons under it or none. */
  edit(chatId: number, messageId: number, text: string, entities?: MessageEntity[], buttons?: Button[][]): Promise<void>
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
    if (!response.ok) throw new Error(`Telegram ${method} failed with status ${response.status}`)
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
  }
}
