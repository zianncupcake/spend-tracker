// What a user types after a command, and the reading of it: the patterns that the words are held to, the card
// that /addcard's words describe, the purchase that /add's describe, what /cycle's, /pattern's and /remind's ask
// for, and the name of a time zone.

import { productOf } from '../catalogue'
import { lettersOf } from '../catalogue/merchants'
import { CURRENCY, dayStart, isRealDay, ISO_DATE, noonOf } from '../domain/by-hand'
import { countedIn, currentWindow, dayOf, type WindowRule } from '../domain/window'
import { hundredths, MAX_MERCHANT_LENGTH } from '../parsers/shared'
import {
  MAX_PATTERN_MERCHANT,
  MAX_PATTERN_SKIPS,
  MIN_PATTERN_LETTERS,
  type Card,
  type Pattern,
} from '../store'
import { ADD_CARD_USAGE, ADD_USAGE, CYCLE_USAGE } from './texts'

/** What /add is told of a purchase, after the card that it was made with. */
export interface Entry {
  amountMinor: number
  currency: string
  merchant: string
  /** Unix seconds. */
  occurredAt: number
}

/** What /pattern is asked for: to save a pattern for a card's merchant or, with nothing to `save`, to remove it. */
interface PatternAsked {
  nickname: string
  merchant: string
  save?: Pick<Pattern, 'amountMinor' | 'skips'>
}

export const NICKNAME = /^[A-Za-z0-9_-]{1,20}$/
const LAST4 = /^\d{4}$/
const DAY = /^\d{1,2}$/
export const CODE = /^\d{6}$/
export const PRODUCT_KEY = /^[A-Za-z0-9-]{1,30}$/
/** A purchase's id as its user gives it: the number that it is shown as, with or without a # before it. */
export const PURCHASE_ID = /^#?(\d{1,15})$/
/** An amount as the parsers of the banks' alerts read one, with or without the code of its currency before it. */
const AMOUNT = /^([A-Za-z]{3})?(\d{1,3}(?:,\d\d\d){0,3}|\d{1,12})(\.\d{1,2}|)$/
/** Day and month, and after them the year or the last two digits of it. */
const SHORT_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d\d|\d{4}))?$/
/** What an alert is written in. A name with any other character, as "café" has, is in the merchant of no purchase. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/** The time zone of the name, spelt as Intl spells it. Null when Intl knows no time zone of that name. */
export function timeZoneNamed(name: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** The card that /addcard's arguments describe, or a message saying what is wrong with them. */
export function parseCard(args: string[]): Card | string {
  const usage = `Usage:\n${ADD_CARD_USAGE}`
  const [nickname = '', last4 = '', type = '', day = ''] = args
  if (args.length < 3) return usage
  if (!NICKNAME.test(nickname)) return 'The nickname must be 1 to 20 characters: letters, digits, _ or -.'
  if (!LAST4.test(last4)) return 'The last four digits must be exactly four digits, like 1234.'

  // The key of a product can come as one more word, after all that says what the card's window is.
  const words = type.toLowerCase() === 'statement' ? 4 : 3
  const key = args[words]
  if (args.length > words + 1 || (key !== undefined && !PRODUCT_KEY.test(key))) return usage
  const product = productOf(key?.toLowerCase())
  if (key !== undefined && !product) return noSuchProduct(key)
  const linked = product ? { product: product.key } : {}

  const window = windowOf(type, day)
  if (window === null) return usage
  return typeof window === 'string' ? window : { nickname, last4, ...window, ...linked }
}

/** The card and the window that /cycle's arguments ask for, or a message saying what is wrong with them. */
export function parseCycle(args: string[]): ({ nickname: string } & WindowRule) | string {
  const [nickname = '', type = '', day = ''] = args
  const words = type.toLowerCase() === 'statement' ? 3 : 2
  const window = NICKNAME.test(nickname) && args.length === words ? windowOf(type, day) : null
  if (window === null) return CYCLE_USAGE
  return typeof window === 'string' ? window : { nickname, ...window }
}

/**
 * The window that "calendar", or "statement" and its day, describe, as /addcard and /cycle take them: a message
 * saying what is wrong with the day, or null for words that are neither.
 */
function windowOf(type: string, day: string): WindowRule | string | null {
  if (type.toLowerCase() === 'calendar') return { windowType: 'calendar' }
  if (type.toLowerCase() !== 'statement' || day === '') return null
  const statementDay = DAY.test(day) ? Number(day) : 0
  if (statementDay < 1 || statementDay > 31) return 'The statement day must be a number from 1 to 31.'
  return { windowType: 'statement', statementDay }
}

/** A window in the words that /addcard and /cycle take for it. */
export function windowWords(window: WindowRule): string {
  return window.windowType === 'statement' ? `statement ${window.statementDay}` : 'calendar'
}

export function noSuchProduct(key: string): string {
  return `There is no product called ${key}. Send /products for the ones there are.`
}

/**
 * The purchase that /add's arguments after the card describe, or a message saying what is wrong with them: an
 * amount, then a date or none, then the merchant in as many words as it takes. `homeCurrency` is the currency of
 * an amount that comes without one, and `card` is the card that the purchase was made with.
 */
export function parseEntry(
  args: string[],
  card: Card,
  homeCurrency: string,
  now: Date,
  timeZone: string,
): Entry | string {
  // A currency can stand apart from its amount, as in "USD 12.50".
  const apart = CURRENCY.test(args[0])
  const [, currency = homeCurrency, whole, decimals] = AMOUNT.exec(apart ? args[0] + args[1] : args[0]) ?? []
  if (whole === undefined) return ADD_USAGE
  const amountMinor = hundredths(whole, decimals)
  if (amountMinor === 0) return 'The amount must be more than zero.'

  const rest = args.slice(apart ? 2 : 1)
  const dated = timeNamed(rest[0] ?? '', card, now, timeZone)
  // What is taken for a date is no word of the merchant, so a merchant has to follow it.
  const merchant = rest.slice(dated === null ? 0 : 1).join(' ')
  if (merchant === '') return ADD_USAGE
  if (merchant.length > MAX_MERCHANT_LENGTH) return `The merchant can be ${MAX_MERCHANT_LENGTH} characters at most.`
  if (typeof dated === 'string') return dated
  const occurredAt = dated ?? Math.floor(now.getTime() / 1000)
  return { amountMinor, currency: currency.toUpperCase(), merchant, occurredAt }
}

/**
 * What /pattern's arguments ask for, or null when they are none of what it takes. A line that ends with "none"
 * removes, whatever comes before that: a merchant can begin with a number, as "247 fitness" does. Any other line
 * saves: an amount as /add reads one, with no currency, then the merchant and, after "except", the skipped days.
 */
export function parsePattern(args: string[]): PatternAsked | null {
  const [nickname = '', ...rest] = args
  if (!NICKNAME.test(nickname)) return null
  if (rest.at(-1)?.toLowerCase() === 'none') {
    const merchant = patternMerchant(rest.slice(0, -1))
    return merchant === null ? null : { nickname, merchant }
  }
  const [, currency, whole, decimals] = AMOUNT.exec(rest[0] ?? '') ?? []
  if (whole === undefined || currency !== undefined) return null
  const amountMinor = hundredths(whole, decimals)
  // The word "except" ends the merchant, and a day at the least comes after it.
  const except = rest.findIndex((word) => word.toLowerCase() === 'except')
  const [named, days] = except < 0 ? [rest.slice(1), []] : [rest.slice(1, except), rest.slice(except + 1)]
  const merchant = patternMerchant(named)
  // Each day once, in the order of the calendar: days that are written so sort into it as text.
  const skips = [...new Set(days)].sort()
  const dated = days.every(isDay) && skips.length <= MAX_PATTERN_SKIPS && (except < 0 || skips.length > 0)
  if (amountMinor === 0 || merchant === null || !dated) return null
  return { nickname, merchant, save: { amountMinor, skips } }
}

/**
 * What /remind's arguments ask for, or null when they are none of what it takes: a card, and the day of the month
 * on which to be reminded of its bill. With "none" for the day the reminder is taken away, and `day` is null.
 */
export function parseReminder(args: string[]): { nickname: string; day: number | null } | null {
  const [nickname = '', given = ''] = args
  if (args.length !== 2 || !NICKNAME.test(nickname)) return null
  if (given.toLowerCase() === 'none') return { nickname, day: null }
  const day = DAY.test(given) ? Number(given) : 0
  return day >= 1 && day <= 31 ? { nickname, day } : null
}

/**
 * The merchant of a pattern as it is stored, from what its user called it: see the migration that added the table.
 * Null for a name that is too long, for one with too few letters and digits to tell a merchant by, and for one
 * with a character that no alert is written with.
 */
function patternMerchant(given: string[]): string | null {
  const name = given.join(' ')
  const sized = lettersOf(name).length >= MIN_PATTERN_LETTERS && name.length <= MAX_PATTERN_MERCHANT
  return sized && PRINTABLE_ASCII.test(name) ? name.toLowerCase() : null
}

/** Whether the text is a day that a calendar has, written YYYY-MM-DD. */
function isDay(text: string): boolean {
  const [, year, month, day] = ISO_DATE.exec(text) ?? []
  return year !== undefined && isRealDay(Number(year), Number(month), Number(day))
}

/**
 * When a purchase with the date that is given to /add was made, in unix seconds, or a message saying what is wrong
 * with the date. Null for text that is not taken for a date, which is then the first word of the merchant.
 *
 * Text written YYYY-MM-DD is always a date. Text written D/M, or D/M and then a year or its last two digits, can as
 * well begin the name of a merchant, as "24/7" and "7/11" do. It is taken for a date when the day it names is one of
 * the card's current window and is not after today, and for a word of the merchant when it is not: see firstWritten
 * for which days those are. With no year, it names the latest day so written that is not after today: on 2
 * January, "30/12" is the 30th of the December before.
 */
function timeNamed(text: string, card: Card, now: Date, timeZone: string): number | string | null {
  const at = Math.floor(now.getTime() / 1000)

  const iso = ISO_DATE.exec(text)
  if (iso) {
    const start = dayStart(Number(iso[1]), Number(iso[2]), Number(iso[3]), timeZone)
    if (start === null) return 'There is no such date.'
    return start > at ? 'That date is still to come.' : noonOf(start, at)
  }

  const [, day, month, year] = SHORT_DATE.exec(text) ?? []
  if (day === undefined) return null
  const today = dayOf(now, timeZone)
  const toCome = Number(month) > today.month || (Number(month) === today.month && Number(day) > today.day)
  // Two digits of a year are of this century. With no year, it is this year's day, or last year's when this year's
  // is still to come.
  const fullYear = year === undefined ? today.year - (toCome ? 1 : 0) : Number(year) + (year.length === 2 ? 2000 : 0)
  const start = dayStart(fullYear, Number(month), Number(day), timeZone)
  return start !== null && start >= firstWritten(card, now, timeZone) && start <= at ? noonOf(start, at) : null
}

/**
 * Unix seconds of where the days begin that /add takes for those of the card's current window, when one of them is
 * written D/M. They are the days whose purchases the window counts, which begin before the window does: see
 * currentWindow. On the last days of a window the current one is the next, which is still to start. The days of the
 * window that is closing are taken then too, as they were before a window counted any days but its own.
 */
function firstWritten(card: Card, now: Date, timeZone: string): number {
  const window = currentWindow(card, now, timeZone)
  const counted = countedIn(window).start
  if (now.getTime() >= window.start.getTime()) return counted
  // The window that is closing is the one that counts what was bought just before this one counts anything.
  return currentWindow(card, new Date(counted * 1000 - 1), timeZone).start.getTime() / 1000
}
