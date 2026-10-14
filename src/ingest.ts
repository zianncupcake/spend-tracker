import { startingCategoriesOn } from './domain/sorting'
import { log } from './log'
import { parseAlert, parserOf } from './parsers'
import type { AlertEmail } from './parsers/types'
import type { Card, Store, Transaction } from './store'

export type IngestResult =
  | { status: 'stored'; transaction: Transaction; card: Card | undefined; remembered: boolean }
  | { status: 'duplicate' }
  | { status: 'unparsed' }

/**
 * The entry point for bank alert emails: reads the purchase out of one and
 * stores it for the store's user. The purchase is stored even when the user
 * has not registered a card with those last four digits yet. When they have,
 * the card comes back with the purchase, which starts in the category that
 * the card's product gives it.
 */
export async function ingestAlert(store: Store, email: AlertEmail): Promise<IngestResult> {
  const result = await ingest(store, email)
  // What came of the alert is logged with the parser of the bank that sent it, whether or not that parser could
  // read it: an alert that its bank's parser cannot read is what a bank that has changed its wording looks like.
  log('alert', { outcome: result.status, parser: parserOf(email)?.name ?? null })
  return result
}

async function ingest(store: Store, email: AlertEmail): Promise<IngestResult> {
  const transaction = parseAlert(email)
  if (!transaction) return { status: 'unparsed' }
  const card = (await store.listCards()).find((each) => each.last4 === transaction.cardLast4)
  const [{ category, remembered }] = await startingCategoriesOn(store, card, [transaction])
  const id = await store.insertTransaction({ ...transaction, sourceId: email.sourceId, category })
  if (id === null) return { status: 'duplicate' }
  return { status: 'stored', transaction: { ...transaction, id, category }, card, remembered }
}
