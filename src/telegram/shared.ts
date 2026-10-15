// What several of the files here share, kept apart so that no two of them import each other for it: the press of
// a button and the handling of an update, what the carrying out of an action came to, the currency of an amount
// that has none, and the stretches of code that a message keeps when it is edited.

import type { Events } from '../log'
import type { MessageEntity } from './api'
import type { Sent } from './sending'

export interface Press {
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

/**
 * What the log has of an update besides what came of it: what the update is. It is noted as soon as it is known, so
 * that an update whose handling fails is logged as what it was. See `update` in ../log.
 */
export type Seen = Pick<Events['update'], 'kind' | 'command' | 'why'>

/** The handling of one update, as it goes on. */
export interface Handling {
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
   * Telegram takes one answer to a press. It is given the error that the handling failed with: see failureReply.
   */
  tell?: (error: unknown) => Promise<void>
}

/**
 * What the carrying out of one action came to: the replies to it, in their order, and what the log has of it. An
 * action is `asked` when nothing of it is done until its user presses a button.
 */
export interface Carried {
  replies: Sent[]
  outcome: 'done' | 'asked' | 'refused'
  /** How many purchases an adding stored, and how many it holds. */
  stored?: number
  held?: number
}

/** The currency of an amount that is given without one, on a card whose product does not say. */
export const DEFAULT_CURRENCY = 'SGD'

/** An action that the bot did nothing of, with what its user is told of that. */
export function declined(text: string): Carried {
  return { replies: [[{ text }]], outcome: 'refused' }
}

/** Those of a message's stretches of code that end within its first `end` code units, as they came with it. */
export function codeWithin(
  entities: { type?: string; offset?: number; length?: number }[],
  end: number,
): MessageEntity[] {
  return entities.flatMap(({ type, offset, length }) =>
    type === 'code' && typeof offset === 'number' && typeof length === 'number' && offset + length <= end
      ? [{ type, offset, length }]
      : [],
  )
}
