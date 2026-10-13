// The service's log: a line for each thing that it does, or that goes wrong. A line is JSON, written to the console,
// which is what Cloudflare keeps of a Worker (Workers Logs) and what `wrangler tail` shows. The line of a failure is
// written with console.error, and every other line with console.log, so that Cloudflare has a failure at the level
// of an error and can count it as one.
//
// THE PRIVACY LINE. This service reads people's mail and keeps their purchases. Its log is read by whoever runs it,
// and is kept by Cloudflare. So a line never holds:
//
//   - the text of a message, of a question or of an answer
//   - a photo or any byte of one, the caption under one, or the id that Telegram knows a file by
//   - the text or the subject of an email, the name of a merchant, or an email address
//   - a Telegram user id or chat id, or the digits of a card
//   - an access token, a refresh token, an API key, or the state or the code of a sign-in
//   - the message of an error that anything outside this codebase threw, which can quote what it was given
//
// A line may hold the service's own id of a user, which is the id of their row and is known to nobody outside, the
// names of events, commands, tools, parsers, banks and the methods of Telegram's API, counts, durations in
// milliseconds, HTTP statuses, booleans, the class name of an error, and the short codes that are spelt out in this
// file.
//
// The types below hold most of that line. An event has the fields that are listed for it here and no others, and a
// field is a number, a boolean, null or one of the words that are spelt out for it. Text that came from outside is a
// `string`, which the compiler takes for none of them. A number is what it cannot check: one that goes into a line
// is a count, a duration, a status or a user's id of the service's own, and never an id of Telegram's or the digits
// of a card.

/**
 * The names of the bot's commands, each without its slash. What a message begins with is text from outside, so the
 * log has a command only as the name that it is known to be.
 */
export const COMMAND_NAMES = [
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
  'patterns',
  'pattern',
  'remind',
  'timezone',
  'connect',
  'code',
  'status',
  'disconnect',
  'mcp',
  'delete',
] as const

/**
 * The commands that a press of "Do it" may run: those that a message can have asked about, and no others. See
 * pressConfirm in ./telegram/confirming.
 */
export const CONFIRMABLE = [
  'remove',
  'removecard',
  'disconnect',
  'mcp',
  'connect',
  'addcard',
  'renamecard',
  'product',
  'timezone',
  'pattern',
  'remind',
] as const

/**
 * The names of the assistant's tools. What a model calls a tool is text from outside, so the log has it only as the
 * name that it is known to be.
 */
export const TOOL_NAMES = [
  'show_spending',
  'find_purchases',
  'card_rules',
  'add_purchases',
  'set_category',
  'run_command',
] as const

/** Every event, with what its line holds besides its name. The README says what each of them means. */
export interface Events {
  check: {
    mailbox: boolean
    user: number | null
    listed: number
    unknown: number
    headers: number
    read: number
    stored: number
    unparsed: number
    rejected: number
    notified: number
    checked: boolean
    swept: number
    batches: number
    ms: number
  }
  check_failed: {
    stage: 'sweep' | 'take' | 'token' | 'list' | 'read' | 'store' | 'notify' | 'batches'
    user: number | null
  }
  access_lost: { user: number; told: boolean }
  reminder: { user: number | null; outcome: 'sent' | 'blocked' | 'failed' }
  review: { user: number | null; outcome: 'offered' | 'nothing' | 'blocked' | 'failed'; offered: number }
  alert: { outcome: 'stored' | 'duplicate' | 'unparsed'; parser: 'example-bank' | 'ocbc' | 'uob' | 'hsbc' | null }
  mcc_lookup: { outcome: 'found' | 'none' | 'failed' }
  connect_link: { user: number }
  connect_callback: {
    outcome:
      | 'code_shown'
      | 'not_completed'
      | 'expired'
      | 'replaced'
      | 'no_gmail_access'
      | 'no_lasting_access'
      | 'failed'
    user?: number
    stage?: 'claim' | 'exchange' | 'profile' | 'hold' | 'notify'
  }
  connect_code: {
    user: number
    outcome: 'connected' | 'wrong' | 'out_of_tries' | 'expired' | 'no_attempt'
    tries_left?: number
  }
  disconnect: { user: number; outcome: 'disconnected' | 'not_connected' }
  token_revoke: { outcome: 'revoked' | 'kept' | 'failed' }
  ai_call: {
    ms: number
    status?: number
    finish?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other' | null
    tool_calls?: number
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    retry_after?: number
  }
  mcp_tool: {
    user: number
    tool: 'get_spending_summary' | 'list_transactions'
    outcome: 'ok' | 'invalid' | 'failed'
    ms: number
  }
  mcp_refused: { why: 'wrong_origin' | 'no_token' | 'unknown_token' | 'wrong_method' }
  webhook_refused: { why: 'no_secret' | 'wrong_secret' }
  update: {
    kind:
      | 'command'
      | 'question'
      | 'code'
      | 'photo'
      | 'not_text'
      | 'edited'
      | 'press'
      | 'message'
      | 'other'
      | 'unreadable'
    command?: (typeof COMMAND_NAMES)[number] | 'unknown'
    outcome: 'replied' | 'deferred' | 'ignored' | 'failed'
    why?: 'not_private' | 'not_own_chat' | 'no_id' | 'not_text' | 'service_message' | 'nothing_read'
    handled?: boolean
    told?: boolean
    ms: number
  }
  question: {
    user: number | null
    outcome: 'answered' | 'acted' | 'busy' | 'failed' | 'timeout' | 'blocked'
    sent: 'rich' | 'text' | 'edit' | 'message' | 'none'
    placeholder: boolean
    requests: number
    tool_calls: number
    actions?: number
    ms: number
  }
  action: {
    user: number
    kind: 'show' | 'add' | 'category' | 'command'
    command?: Events['update']['command']
    outcome: 'done' | 'asked' | 'refused' | 'failed' | 'skipped'
    stored?: number
    held?: number
  }
  confirm_press: {
    user: number
    command?: (typeof CONFIRMABLE)[number]
    outcome: 'done' | 'cancelled' | 'refused'
  }
  assistant_tool: {
    user: number
    tool: (typeof TOOL_NAMES)[number] | 'unknown'
    outcome: 'ok' | 'invalid' | 'failed'
    ms: number
  }
  photo: {
    user: number | null
    outcome: 'read' | 'nothing' | 'no_cards' | 'repeated' | 'too_large' | 'busy' | 'failed' | 'timeout' | 'blocked'
    sent: 'rich' | 'text' | 'edit' | 'message' | 'none'
    placeholder: boolean
    bytes: number
    requests: number
    read: number
    unreadable: number
    stored: number
    held: number
    ms: number
  }
  held_press: { user: number; outcome: 'added' | 'skipped' | 'refused'; held: number; stored: number }
  telegram_failed: {
    method:
      | 'sendMessage'
      | 'sendRichMessage'
      | 'answerCallbackQuery'
      | 'editMessageText'
      | 'deleteMessage'
      | 'sendChatAction'
      | 'getFile'
      | 'downloadFile'
    status?: number
  }
}

/**
 * Why an error of this codebase's own was thrown: see `Failure`. `http_error` is for an answer from outside that was
 * an error, and the error then holds the HTTP status of that answer.
 */
export type Reason =
  | 'http_error'
  | 'grant_lost'
  | 'page_token'
  | 'no_access_token'
  | 'no_address'
  | 'no_date'
  | 'bad_key'
  | 'no_message'
  | 'bad_tool_call'
  | 'no_user_row'
  | 'chat_blocked'
  | 'no_message_id'
  | 'out_of_time'
  | 'no_answer'
  | 'still_calling_tools'
  | 'took_too_long'
  | 'file_too_large'
  | 'not_json'
  | 'bad_reading'
  | 'no_file_path'
  | 'no_vision_model'
  | 'cut_short'
  | 'no_stores'

/**
 * An error that this codebase throws of its own accord. It says what went wrong twice: in its message, for whoever
 * reads the code or a test, and in `reason`, which is what the log has of it. It has the name of a plain Error, as
 * the errors of Telegram and of the AI provider have.
 */
export class Failure extends Error {
  constructor(
    readonly reason: Reason,
    message?: string,
  ) {
    super(message)
  }
}

/**
 * What is given for the fields of an event, which is to hold no field that the event has not. Left to itself the
 * compiler lets one through when it comes in with the fields of something else, as `...purchase` would bring them.
 */
type Only<Fields, Given> = Given & Record<Exclude<keyof Given, keyof Fields>, never>

/** A class name is letters and nothing else. A name that is anything else is not taken for one, and is not written. */
const CLASS_NAME = /^[A-Za-z]{1,40}$/

/**
 * Whether what an error holds for its status is the status of an HTTP answer: a whole number from 100 to 599. Any
 * other number could be anything, an id of Telegram's among them, and is not written.
 */
function isHttpStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
}

/** Writes the line of an event: its name, and then its fields. A field that is undefined is left out. */
export function log<E extends keyof Events, const F extends Events[E]>(event: E, fields: Only<Events[E], F>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

/**
 * Writes the line of an event that failed, at the level of an error. To its fields this adds the class name of the
 * error, the reason of one that this codebase threw, and the HTTP status that the error holds, when it holds one.
 * Nothing else of an error is written, and its message never is.
 *
 * It is called where an error is caught, with whatever was thrown, and what an error holds is its thrower's to set.
 * So a name is taken only when it is text that reads as a class name, and a status only when it is one of an HTTP
 * answer: neither is written as it is found, and a name that is no text does not make this throw in its turn.
 */
export function logFailure<E extends keyof Events, const F extends Events[E]>(
  event: E,
  error: unknown,
  fields: Only<Events[E], F>,
): void {
  const name: unknown = error instanceof Error ? error.name : typeof error
  const status: unknown = (error as { status?: unknown } | null)?.status
  console.error(
    JSON.stringify({
      event,
      ...fields,
      error: typeof name === 'string' && CLASS_NAME.test(name) ? name : 'Error',
      ...(error instanceof Failure && { reason: error.reason }),
      ...(isHttpStatus(status) && { status }),
    }),
  )
}
