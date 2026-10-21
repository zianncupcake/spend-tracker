// The category codes (MCC) of merchants that ./catalogue/merchants does not know, asked of two public services that
// take no key: check-mcc.sg, and heymax.ai for a merchant that the first lists no store for.

import { lettersOf, namedIn, wordsOf } from './catalogue/merchants'
import { Failure, log, logFailure, type Events } from './log'

/** A service that lists the stores which contain a word, and where an answer of its holds them. */
interface Service {
  source: Events['mcc_lookup']['source']
  url: (word: string) => string
  headers: Record<string, string>
  /** The list of an answer, which is no list when the answer is not as expected. */
  rows: (answer: unknown) => unknown
  /** The fields of a row that hold the name of a store and its code. */
  name: string
  code: string
}

/** A public list of the codes of stores, which takes 100 requests in 15 minutes from one address. */
const CHECK_MCC: Service = {
  source: 'check-mcc.sg',
  url: (word) => `https://www.check-mcc.sg/api/store/search?${new URLSearchParams({ q: word })}`,
  headers: {},
  rows: (answer) => (answer as { merchants?: unknown } | null)?.merchants,
  name: 'Store',
  code: 'MCC',
}

/** The site's own endpoint, and not a documented one: it may change. */
const HEYMAX: Service = {
  source: 'heymax.ai',
  url: (word) => {
    const asked = new URLSearchParams({ query: word, useVisaApi: 'true', country: 'SG', page_size: '10' })
    return `https://heymax.ai/api/merchants?${asked}`
  },
  headers: { accept: 'application/json' },
  rows: (answer) => answer,
  name: 'name',
  code: 'mcc_code',
}

/** The services, in the order that their stores are looked at. */
const SERVICES = [CHECK_MCC, HEYMAX]

export const SOURCES = SERVICES.map(({ source }) => source)

/** The most stores that a question about a merchant reports. */
const MAX_REPORTS = 6

/**
 * How long an answer is waited for. The adding of a purchase waits with it, and the assistant's adding has this long
 * between the time that its model is given and its own.
 */
const TIMEOUT = 2_000

/**
 * The most words that are asked for one adding, each of both services: an invocation has about 50 requests for all
 * that it does.
 */
const MAX_SEARCHES = 10

/** The shortest name of a store that counts, in letters and digits: a shorter one is held by too many texts. */
const SHORTEST_NAME = 3

/**
 * How many stores of an answer are looked at, which is as many as check-mcc.sg lists: a request has little CPU time.
 */
const MAX_STORES = 50

/** A store as a service lists it, which nothing has checked. */
type Listed = { name: unknown; code: unknown }

/** A store that a service lists for a merchant that a question names, and its code. */
export interface Report {
  source: Service['source']
  store: string
  mcc: number
}

/** A service answered a search with an error. The URL holds the word that was asked, so only the status is kept. */
class SearchError extends Failure {
  constructor(
    source: Service['source'],
    readonly status: number,
  ) {
    super('http_error', `${source} search failed with status ${status}`)
  }
}

/**
 * The codes of the stores that count for a merchant, of those that a service listed. Its search lists every store
 * that contains the word, so a store counts only when its name is a run of whole words of the merchant's text: see
 * `namedIn`. Of those, the ones with the longest name are taken: a text that holds "SAMPLE MART EXPRESS" is of that
 * store, and not of "SAMPLE MART". None when no store counts, and when a code of those taken is not four digits.
 */
export function codesAmong(merchant: string, stores: Listed[]): number[] {
  const holds = namedIn(merchant, true)
  const counted = stores.flatMap((store) => {
    const name = typeof store.name === 'string' ? lettersOf(store.name) : ''
    return name.length >= SHORTEST_NAME && holds(name) ? [{ name, code: store.code }] : []
  })
  const longest = Math.max(...counted.map(({ name }) => name.length))
  const codes = counted.filter(({ name }) => name.length === longest).map(({ code }) => code)
  return codes.every(fourDigits) ? codes.map(Number) : []
}

/**
 * The stores that a question about the merchant reports, of those that a service listed, each with its code. A store
 * counts when either name begins with the other, as whole words: "Sample Soft SG" counts for "sample soft", as a
 * question names a business more loosely than an alert does, and "The Sample Soft" does not. A store whose code is
 * not four digits is left out, and so is one that is listed again with the same code.
 */
export function storesNaming(merchant: string, stores: Listed[]): Omit<Report, 'source'>[] {
  const asked = lettersOf(merchant)
  const named = stores.flatMap(({ name, code }) => {
    if (typeof name !== 'string' || !fourDigits(code)) return []
    const letters = lettersOf(name)
    const counts = letters.length >= SHORTEST_NAME && (begins(name, asked) || begins(merchant, letters))
    return counts ? [{ store: name.trim(), mcc: Number(code) }] : []
  })
  return named.filter((one, at) => named.findIndex(({ store, mcc }) => store === one.store && mcc === one.mcc) === at)
}

/** Whether the text begins with the name, given as `lettersOf` makes it, and the name ends where a word does. */
function begins(text: string, name: string): boolean {
  const words = wordsOf(text)
  const ends = words.map((_, at) => words.slice(0, at + 1).join('').length)
  return name !== '' && words.join('').startsWith(name) && ends.includes(name.length)
}

function fourDigits(code: unknown): boolean {
  return typeof code === 'string' && /^\d{4}$/.test(code)
}

/**
 * The codes of the stores that count for each of the merchants, in their order: see `codesAmong`. The stores of
 * heymax.ai are looked at only for a merchant that those of check-mcc.sg give no codes.
 */
export async function codesFoundFor(merchants: string[]): Promise<number[][]> {
  return (await listedFor(merchants)).map((listed, at) => codesOf(merchants[at], listed))
}

/**
 * What the services find for a merchant that a question names, from the one search of each: the codes that a
 * purchase there goes by, as `codesFoundFor` has them, and the stores that `storesNaming` reports, MAX_REPORTS at the
 * most.
 */
export async function lookedUp(merchant: string): Promise<{ codes: number[]; reported: Report[] }> {
  const [listed] = await listedFor([merchant])
  const reported = SERVICES.flatMap(({ source }, at) =>
    storesNaming(merchant, listed[at]).map((store) => ({ source, ...store })),
  )
  return { codes: codesOf(merchant, listed), reported: reported.slice(0, MAX_REPORTS) }
}

function codesOf(merchant: string, [first, second]: Listed[][]): number[] {
  const codes = codesAmong(merchant, first)
  return codes.length > 0 ? codes : codesAmong(merchant, second)
}

/**
 * The stores that each service lists for each of the merchants, in their order and in the order of SERVICES. A
 * service is asked for the first word of a merchant's text, as it finds nothing for the longer text of a bank. Both
 * are asked for each distinct first word, all at the same time, and for MAX_SEARCHES words at the most. A merchant
 * past those words has no stores, and neither has one whose first word is not asked for: see `wordToAsk`.
 */
async function listedFor(merchants: string[]): Promise<Listed[][][]> {
  const words = merchants.map(wordToAsk)
  const asked = [...new Set(words)].filter((word) => word !== '').slice(0, MAX_SEARCHES)
  const allFor = async (word: string) =>
    [word, await Promise.all(SERVICES.map((service) => search(service, word)))] as const
  const listed = new Map(await Promise.all(asked.map(allFor)))
  return words.map((word) => listed.get(word) ?? SERVICES.map(() => []))
}

/**
 * The word that a service is asked for a merchant: the first of its text. Empty when that is not one to send: a
 * word with no letter can be a phone number or the number of a card, and one character names no store.
 */
function wordToAsk(merchant: string): string {
  const [first = ''] = wordsOf(merchant)
  return first.length >= 2 && /[a-z]/.test(first) ? first : ''
}

/**
 * The stores that a service lists for a word. None when it could not be asked, or answered with anything but a
 * list: a purchase is added whatever becomes of this. The log has what came of the search, and never the word.
 */
async function search(service: Service, word: string): Promise<Listed[]> {
  const { source } = service
  try {
    const signal = AbortSignal.timeout(TIMEOUT)
    const response = await fetch(service.url(word), { headers: service.headers, signal })
    if (response.status !== 200) throw new SearchError(source, response.status)
    const rows = service.rows(await response.json())
    if (!Array.isArray(rows)) throw new Failure('no_stores', `${source} answered with no list of stores`)
    log('mcc_lookup', { source, outcome: rows.length > 0 ? 'found' : 'none' })
    return rows.slice(0, MAX_STORES).map((row: Record<string, unknown> | null) => {
      return { name: row?.[service.name], code: row?.[service.code] }
    })
  } catch (error) {
    logFailure('mcc_lookup', error, { source, outcome: 'failed' })
    return []
  }
}
