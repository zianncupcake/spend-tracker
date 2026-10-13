// The sending of the reminders of cards' bills, by the scheduled run. When a reminder is due is worked out in
// ./domain/reminder.

import type { Deps } from './deps'
import { nextReminder } from './domain/reminder'
import { dayOf, startOfDay } from './domain/window'
import { log, logFailure } from './log'
import { findDueReminder, moveReminder, type DueReminder } from './store-reminders'
import { ChatBlockedError } from './telegram/api'
import { maskLast4 } from './telegram/format'
import { billDue } from './telegram/texts'

const DAY = 86_400

/** How long after a reminder could not be sent it is tried again, in seconds. */
const RETRY_AFTER = 10 * 60

/**
 * Sends the reminder that has been due longest, when one is due: one in a run. It does not throw: a failure is
 * logged, and the run goes on to the mail.
 */
export async function sendDueReminder(deps: Deps): Promise<void> {
  const { db, messenger } = deps
  const date = deps.now()
  const now = Math.floor(date.getTime() / 1000)
  let due: DueReminder | null = null
  try {
    due = await findDueReminder(db, now)
    if (!due) return
    let next: number
    try {
      next = nextReminder(due.day, due.timezone, date)
    } catch (error) {
      // With a time zone that the runtime does not know, it would stay the one that has been due longest, and no
      // other would ever be sent. So it steps aside for a day.
      await moveReminder(db, due.cardId, due.at, now + DAY)
      throw error
    }
    // Moved on to next month's before it is sent, so that one that cannot be sent does not keep the others waiting.
    if (!(await moveReminder(db, due.cardId, due.at, next))) return
    try {
      await messenger.send(due.chatId, billDue(`${due.nickname} ${maskLast4(due.last4)}`))
    } catch (error) {
      // No later try would get the message to a user who has blocked the bot.
      if (error instanceof ChatBlockedError) return log('reminder', { user: due.ownerId, outcome: 'blocked' })
      // Tried again while it is still the day of the reminder for its user.
      const retry = now + RETRY_AFTER
      if (retry < endOfDay(due.at, due.timezone)) await moveReminder(db, due.cardId, next, retry)
      throw error
    }
    log('reminder', { user: due.ownerId, outcome: 'sent' })
  } catch (error) {
    logFailure('reminder', error, { user: due?.ownerId ?? null, outcome: 'failed' })
  }
}

/** Unix seconds of where the day of an instant ends in the time zone. */
function endOfDay(instant: number, timeZone: string): number {
  const { year, month, day } = dayOf(new Date(instant * 1000), timeZone)
  return startOfDay(year, month, day + 1, timeZone).getTime() / 1000
}
