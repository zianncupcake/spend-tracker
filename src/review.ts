// The monthly review, by the scheduled run: what looks monthly in a user's spending is offered to them as patterns
// to add, each with the question that is asked before /pattern is run. What looks monthly is worked out in
// ./domain/review.

import { categoryOf, groupOf, productOf } from './catalogue'
import { lettersOf, namedIn } from './catalogue/merchants'
import type { Deps } from './deps'
import { groupFor } from './domain/patterns'
import { nextReminder } from './domain/reminder'
import { monthlyAmong, monthsBefore, type Monthly } from './domain/review'
import { log, logFailure } from './log'
import { storeFor, type Card, type User } from './store'
import { findDueReview, moveReview, offerStoreFor, type DueReview } from './store-review'
import { ChatBlockedError } from './telegram/api'
import { parsePattern } from './telegram/arguments'
import { confirmFor } from './telegram/confirming'
import { formatAmount } from './telegram/format'
import { sendReply } from './telegram/sending'
import { REVIEW } from './telegram/texts'

/** How many patterns one review offers. Each is a message, and a run may make 50 requests. */
const MAX_OFFERS = 5

/** How many purchases one review reads: the latest of them. A run has little CPU time. */
const MAX_PURCHASES = 2000

const DAY = 86_400

/** A pattern that a review offers: what was spent with the card at a merchant in a month. */
type Candidate = Monthly & { card: Card }

/**
 * Reviews the user whose review has been due longest, when one is due: one in a run. It does not throw: a failure
 * is logged, and the run goes on to the mail.
 */
export async function reviewDueUser(deps: Deps): Promise<void> {
  const { db, messenger } = deps
  const date = deps.now()
  const now = Math.floor(date.getTime() / 1000)
  let due: DueReview | null = null
  try {
    due = await findDueReview(db, now)
    if (!due) return
    let next: number
    try {
      next = nextReminder(1, due.timezone, date)
    } catch (error) {
      // The user steps aside for a day, as a reminder does and for the same reason: see sendDueReminder.
      await moveReview(db, due.id, due.at, now + DAY)
      throw error
    }
    // Moved on to next month's before anything else, so that a review that fails is not made again this month, and
    // does not keep the others waiting. A run that moves nothing leaves the review to the run that did.
    if (!(await moveReview(db, due.id, due.at, next))) return
    // With none set, the user is only given their first, so that it comes at 09:00 on a 1st as every other does:
    // a user whom no run has seen, and one who has changed their time zone.
    if (due.at === 0) return
    const candidates = await candidatesFor(db, due, date)
    if (candidates.length === 0) return log('review', { user: due.id, outcome: 'nothing', offered: 0 })
    await messenger.send(due.chatId, REVIEW)
    for (const candidate of candidates) {
      const { replies } = await confirmFor(deps, due, 'pattern', argsOf(candidate))
      for (const reply of replies) await sendReply(messenger, due.chatId, reply)
    }
    // Recorded once all of them are sent: what a review that fails had to offer is offered by the next one.
    await offerStoreFor(db, due.id).record(candidates.map(({ card, letters }) => ({ cardLast4: card.last4, letters })))
    log('review', { user: due.id, outcome: 'offered', offered: candidates.length })
  } catch (error) {
    const user = due?.id ?? null
    // A chat that has blocked the bot is nothing that went wrong here.
    if (error instanceof ChatBlockedError) return log('review', { user, outcome: 'blocked', offered: 0 })
    logFailure('review', error, { user, outcome: 'failed', offered: 0 })
  }
}

/**
 * What a review at `now` offers the user: on each card that is linked to a product, what looks monthly among its
 * purchases of the two months before that count against a cap. The largest amounts come first, and there are no
 * more than MAX_OFFERS.
 */
async function candidatesFor(db: D1Database, user: User, now: Date): Promise<Candidate[]> {
  const store = storeFor(db, user.id)
  const { start, later, end } = monthsBefore(now, user.timezone)
  const [cards, purchases, patterns, offered] = await Promise.all([
    store.listCards(),
    store.listTransactions(null, start, end, MAX_PURCHASES),
    store.listPatterns(),
    offerStoreFor(db, user.id).list(),
  ])
  return cards
    .flatMap((card) => {
      const product = productOf(card.product)
      if (!product) return []
      // What a pattern of the card counts already is not looked at: a purchase whose text holds its name, as in
      // heldBack. Most cards have no pattern, and a run has little CPU time.
      const onCard = patterns.filter(({ cardLast4 }) => cardLast4 === card.last4)
      const names = onCard.map(({ merchant }) => lettersOf(merchant))
      const counted = (text: string | null) => names.length > 0 && text !== null && names.some(namedIn(text))
      const own = purchases.filter(
        (each) => each.cardLast4 === card.last4 && each.currency === product.homeCurrency && !counted(each.merchant),
      )
      return product.groups.flatMap((group) => {
        if (group.limitMinor === undefined) return []
        // A pattern is held against the group that its name starts in, whatever its purchases count in. So one is
        // offered only where the two are the same: among the purchases that are sorted into this group.
        const sorted = own.filter((each) => groupOf(product, categoryOf(product, each.category)) === group)
        // The name alone is not enough: a purchase from before its card had the product is stored unsorted, and
        // so is here in the default group, though a rule of the product places its whole text elsewhere.
        return monthlyAmong(sorted, later)
          .filter(({ name, text }) => groupFor(product, name) === group && groupFor(product, text) === group)
          .map((monthly): Candidate => ({ card, ...monthly }))
      })
    })
    .filter((candidate) => {
      const { card, letters } = candidate
      const before = offered.some((each) => each.cardLast4 === card.last4 && each.letters === letters)
      // /pattern is to save what is offered: no name that is too short or too long for it, and none that ends
      // with its "none".
      return !before && parsePattern(argsOf(candidate))?.save !== undefined
    })
    .sort((one, other) => other.amountMinor - one.amountMinor)
    .slice(0, MAX_OFFERS)
}

/** The words after /pattern that save the candidate. */
function argsOf({ card, name, amountMinor }: Candidate): string[] {
  return [card.nickname, formatAmount(amountMinor), ...name.split(' ')]
}
