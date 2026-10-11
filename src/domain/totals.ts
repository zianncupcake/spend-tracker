import type { Card, Store } from '../store'
import { countedIn, currentWindow, type SpendWindow } from './window'

export interface CardTotals {
  card: Card
  window: SpendWindow
  totals: { currency: string; amountMinor: number }[]
  /** The purchases that the window counts, across all currencies. */
  count: number
}

/** What has been spent on each card in its current window. */
export function cardTotals(store: Store, cards: Card[], now: Date, timeZone: string): Promise<CardTotals[]> {
  return Promise.all(
    cards.map(async (card) => {
      const window = currentWindow(card, now, timeZone)
      const { start, end } = countedIn(window)
      const sums = await store.sumByCurrency(card.last4, start, end)
      return {
        card,
        window,
        totals: sums.map(({ currency, amountMinor }) => ({ currency, amountMinor })),
        count: sums.reduce((count, sum) => count + sum.count, 0),
      }
    }),
  )
}
