// Today's reference rates of the European Central Bank, asked of frankfurter.dev, a public service that takes no key.

import { Failure, log, logFailure } from './log'

/** Units of each currency for one unit of the currency that they were asked against. */
export type Rates = Record<string, number>

/** How long an answer is waited for: the reply to /spend waits with it. */
const TIMEOUT = 2_000

/** frankfurter.dev answered with an error. Only its status is kept. */
class RatesError extends Failure {
  constructor(readonly status: number) {
    super('http_error', `frankfurter.dev failed with status ${status}`)
  }
}

/**
 * Today's rate of each of the currencies against `base`, in one request, and none when there are no currencies.
 * Null when it could not be asked, or when the answer lacks a rate of one of them that is a number above 0. The log
 * has what came of the request, and never the currencies.
 */
export async function ratesFor(base: string, currencies: string[]): Promise<Rates | null> {
  if (currencies.length === 0) return {}
  try {
    const asked = new URLSearchParams({ base, symbols: currencies.join(',') })
    const signal = AbortSignal.timeout(TIMEOUT)
    const response = await fetch(`https://api.frankfurter.dev/v1/latest?${asked}`, { signal })
    if (response.status !== 200) throw new RatesError(response.status)
    const given = ((await response.json()) as { rates?: Record<string, unknown> } | null)?.rates
    const rates = currencies.map((currency) => [currency, given?.[currency]] as const)
    const valid = ([, rate]: readonly [string, unknown]) => typeof rate === 'number' && Number.isFinite(rate) && rate > 0
    if (!rates.every(valid)) throw new Failure('no_rates', 'frankfurter.dev answered without a rate of each currency')
    log('rates_lookup', { outcome: 'found' })
    return Object.fromEntries(rates) as Rates
  } catch (error) {
    logFailure('rates_lookup', error, { outcome: 'failed' })
    return null
  }
}
