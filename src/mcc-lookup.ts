// The category codes (MCC) of merchants that ./catalogue/merchants does not know, asked of check-mcc.sg: a public
// list of the codes of stores, which takes no key and 100 requests in 15 minutes from one address.

import { lettersOf, namedIn, wordsOf } from './catalogue/merchants'
import { Failure, log, logFailure } from './log'

const SEARCH_URL = 'https://www.check-mcc.sg/api/store/search'

/**
 * How long an answer is waited for. The adding of a purchase waits with it, and the assistant's adding has this long
 * between the time that its model is given and its own.
 */
const TIMEOUT = 2_000

/** The most searches for one adding: an invocation has about 50 requests for all that it does. */
const MAX_SEARCHES = 10

/** The shortest name of a store that counts, in letters and digits: a shorter one is held by too many texts. */
const SHORTEST_NAME = 3

/** How many stores of an answer are looked at, which is as many as the service lists: a request has little CPU time. */
const MAX_STORES = 50

/** A store as the service lists it, which nothing has checked. */
type Listed = { Store?: unknown; MCC?: unknown } | null

/** The service answered a search with an error. The URL holds the word that was asked, so only the status is kept. */
class SearchError extends Failure {
  constructor(readonly status: number) {
    super('http_error', `check-mcc.sg search failed with status ${status}`)
  }
}

/**
 * The codes of the stores that count for a merchant, of those that the service listed. Its search lists every store
 * that contains the word, so a store counts only when its name is a run of whole words of the merchant's text: see
 * `namedIn`. Of those, the ones with the longest name are taken: a text that holds "SAMPLE MART EXPRESS" is of that
 * store, and not of "SAMPLE MART". None when no store counts, and when a code of those taken is not four digits.
 */
export function codesAmong(merchant: string, stores: Listed[]): number[] {
  const holds = namedIn(merchant, true)
  const counted = stores.flatMap((store) => {
    const name = typeof store?.Store === 'string' ? lettersOf(store.Store) : ''
    return name.length >= SHORTEST_NAME && holds(name) ? [{ name, code: store?.MCC }] : []
  })
  const longest = Math.max(...counted.map(({ name }) => name.length))
  const codes = counted.filter(({ name }) => name.length === longest).map(({ code }) => code)
  const fourDigits = (code: unknown) => typeof code === 'string' && /^\d{4}$/.test(code)
  return codes.every(fourDigits) ? codes.map(Number) : []
}

/**
 * The codes of the stores that count for each of the merchants, in their order: see `codesAmong`. The service is
 * asked for the first word of a merchant's text, as it finds nothing for the longer text of a bank. That is one
 * search for each distinct first word, all at the same time, and MAX_SEARCHES at the most. A merchant past them has
 * no codes, and neither has one whose first word is not asked for: see `wordToAsk`.
 */
export async function codesFoundFor(merchants: string[]): Promise<number[][]> {
  const words = merchants.map(wordToAsk)
  const asked = [...new Set(words)].filter((word) => word !== '').slice(0, MAX_SEARCHES)
  const listed = new Map(await Promise.all(asked.map(async (word) => [word, await search(word)] as const)))
  return merchants.map((merchant, at) => codesAmong(merchant, listed.get(words[at]) ?? []))
}

/**
 * The word that the service is asked for a merchant: the first of its text. Empty when that is not one to send: a
 * word with no letter can be a phone number or the number of a card, and one character names no store.
 */
function wordToAsk(merchant: string): string {
  const [first = ''] = wordsOf(merchant)
  return first.length >= 2 && /[a-z]/.test(first) ? first : ''
}

/**
 * The stores that the service lists for a word. None when it could not be asked, or answered with anything but a
 * list: a purchase is added whatever becomes of this. The log has what came of the search, and never the word.
 */
async function search(word: string): Promise<Listed[]> {
  try {
    const signal = AbortSignal.timeout(TIMEOUT)
    const response = await fetch(`${SEARCH_URL}?${new URLSearchParams({ q: word })}`, { signal })
    if (response.status !== 200) throw new SearchError(response.status)
    const { merchants } = await response.json<{ merchants?: unknown }>()
    if (!Array.isArray(merchants)) throw new Failure('no_stores', 'check-mcc.sg answered with no list of stores')
    log('mcc_lookup', { outcome: merchants.length > 0 ? 'found' : 'none' })
    return merchants.slice(0, MAX_STORES)
  } catch (error) {
    logFailure('mcc_lookup', error, { outcome: 'failed' })
    return []
  }
}
