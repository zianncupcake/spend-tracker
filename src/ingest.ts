import { startingCategoriesOn } from './domain/sorting'
import { dayOf, startOfDay } from './domain/window'
import { log } from './log'
import { parseAlert, parsePayment, parserOf } from './parsers'
import type { AlertEmail, ParsedPayment } from './parsers/types'
import type { Card, Store, Transaction } from './store'

export type IngestResult =
  | {
      status: 'stored'
      transaction: Transaction
      card: Card | undefined
      remembered: boolean
      /** The scheduled entry that the alert took the place of, when there was one. */
      cleared: Transaction | null
    }
  | { status: 'payment'; payment: ParsedPayment; card: Card | undefined }
  | { status: 'duplicate' }
  | { status: 'unparsed' }

/**
 * The entry point for bank alert emails: reads the purchase out of one and
 * stores it for the store's user. The purchase is stored even when the user
 * has not registered a card with those last four digits yet. When they have,
 * the card comes back with the purchase, which starts in the category that
 * the card's product gives it. An email that holds no purchase can hold a bill
 * payment instead, which is stored and comes back the same way.
 *
 * A stored purchase takes out the scheduled entry that it is the charge for, of the day that it was made on in
 * `timeZone`, so that the payment is not counted twice. It takes no category from that entry.
 */
export async function ingestAlert(store: Store, email: AlertEmail, timeZone: string): Promise<IngestResult> {
  const result = await ingest(store, email, timeZone)
  // What came of the alert is logged with the parser of the bank that sent it, whether or not that parser could
  // read it: an alert that its bank's parser cannot read is what a bank that has changed its wording looks like.
  log('alert', { outcome: result.status, parser: parserOf(email)?.name ?? null })
  return result
}

async function ingest(store: Store, email: AlertEmail, timeZone: string): Promise<IngestResult> {
  const transaction = parseAlert(email)
  if (!transaction) return ingestPayment(store, email)
  const card = (await store.listCards()).find((each) => each.last4 === transaction.cardLast4)
  const [{ category, remembered }] = await startingCategoriesOn(store, card, [transaction])
  const id = await store.insertTransaction({ ...transaction, sourceId: email.sourceId, category })
  if (id === null) return { status: 'duplicate' }
  const { year, month, day } = dayOf(new Date(transaction.occurredAt * 1000), timeZone)
  const [start, end] = [day, day + 1].map((each) => startOfDay(year, month, each, timeZone).getTime() / 1000)
  // With no card there is nothing that a scheduled entry could have been added to.
  const cleared = card ? await store.clearScheduled(transaction, start, end) : null
  return { status: 'stored', transaction: { ...transaction, id, category, scheduled: 0 }, card, remembered, cleared }
}

async function ingestPayment(store: Store, email: AlertEmail): Promise<IngestResult> {
  const payment = parsePayment(email)
  if (!payment) return { status: 'unparsed' }
  const stored = await store.insertPayment({ ...payment, sourceId: email.sourceId, paidAt: email.receivedAt })
  if (!stored) return { status: 'duplicate' }
  const card = (await store.listCards()).find((each) => each.last4 === payment.cardLast4)
  return { status: 'payment', payment, card }
}
