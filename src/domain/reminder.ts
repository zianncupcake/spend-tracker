import { dayOf, daysInMonth, hourOfDay } from './window'

/** The hour at which a reminder is due on its day, by the clock of its user's time zone. */
export const REMINDER_HOUR = 9

const DAY = 86_400

/**
 * When the next reminder of a day of the month is due, in unix seconds: the first time after `now` that it is
 * REMINDER_HOUR on that day in the time zone. A month that has no such day has it on its last day.
 */
export function nextReminder(day: number, timeZone: string, now: Date): number {
  const { year, month } = dayOf(now, timeZone)
  // `month` is 1 to 12 here, and the month after December carries over into January.
  const dueIn = (monthOf: number) => {
    const onDay = Math.min(day, daysInMonth(year, monthOf - 1))
    return hourOfDay(year, monthOf, onDay, REMINDER_HOUR, timeZone).getTime() / 1000
  }
  const thisMonth = dueIn(month)
  return thisMonth > now.getTime() / 1000 ? thisMonth : dueIn(month + 1)
}

/**
 * When a reminder that is due at `at`, in unix seconds, is due by the clock of another time zone: at REMINDER_HOUR
 * there, on the day that it was on. It is worked out from `at` and not from now, so that one which was still to
 * come is not put off a month, and one which was sent is not sent again.
 */
export function reminderIn(day: number, timeZone: string, at: number): number {
  // No two clocks are two days apart, so the first one after that is the one of the same day.
  return nextReminder(day, timeZone, new Date((at - 2 * DAY) * 1000))
}
