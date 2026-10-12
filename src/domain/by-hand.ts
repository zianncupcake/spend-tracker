// What a purchase that is added by hand is read with, whichever way it is given: typed after /add, or made out by a
// model. Both ways go by what is here, so that a purchase is stored the same whichever way it was added.

import { startOfDay } from './window'

export const CURRENCY = /^[A-Za-z]{3}$/
export const ISO_DATE = /^(\d{4})-(\d\d)-(\d\d)$/

/** Unix seconds of the instant at which a day begins in the time zone. Null for a day that no calendar has. */
export function dayStart(year: number, month: number, day: number, timeZone: string): number | null {
  // A date that no calendar has rolls over into one that a calendar has, and then does not read back as it was given.
  const given = new Date(Date.UTC(year, month - 1, day))
  const exists = given.getUTCFullYear() === year && given.getUTCMonth() === month - 1 && given.getUTCDate() === day
  return exists ? startOfDay(year, month, day, timeZone).getTime() / 1000 : null
}

/**
 * The unix seconds that a purchase is stored at when it is given with its day and no time: noon of the day, which
 * begins at `start`, or `now` on a day that has not got to its noon yet. A time in the middle of its day is still of
 * that day when its user moves to another time zone, which the start of the day would not be.
 */
export function noonOf(start: number, now: number): number {
  return Math.min(start + 12 * 3600, now)
}
