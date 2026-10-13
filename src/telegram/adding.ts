// The adding of purchases: of the one that /add describes, of those of a reading, such as a photo's, and of those
// that are held until their user answers for them with a button.

import { MAX_PURCHASES_PER_PHOTO, type PhotoReading } from '../ai/photo'
import { categoriesOf, categoryName, categoryOf, choicesOf, productOf, unplaced } from '../catalogue'
import type { Deps } from '../deps'
import { perCurrency } from '../domain/breakdown'
import { startingCategoriesOn } from '../domain/sorting'
import { cardTotals, type CardTotals } from '../domain/totals'
import { dayOf } from '../domain/window'
import { log } from '../log'
import {
  findUser,
  MANUAL,
  MAX_BY_HAND_PER_DAY,
  storeFor,
  type Card,
  type Sourced,
  type Store,
  type Transaction,
  type User,
} from '../store'
import { heldStoreFor, type HeldPurchase } from '../store-held'
import type { Outgoing, RichBlock } from './api'
import type { Entry } from './arguments'
import { carriedNotes, formatShortDate, maskLast4 } from './format'
import {
  BY_HAND_NOTE,
  heldButtons,
  heldLine,
  inMessages,
  purchaseBlocks,
  purchaseLine,
  purchaseTables,
  sortEnd,
  sortPrompt,
  UNSURE_NOTE,
  type Dated,
  type Line,
  type Section,
  type Table,
} from './purchases'
import { label, spendLine } from './replies'
import { sendReply, type Tabled } from './sending'
import { DEFAULT_CURRENCY, type Handling } from './shared'
import { moreNotPlaced, NOT_PLACED, TOO_MANY_BY_HAND } from './texts'

/**
 * A reading of purchases to add, as `readPhoto` gives one when it found some. Nothing in it says what it was read
 * from, and what is done with one is the same whatever that was: see addRead.
 */
export type Reading = Extract<PhotoReading, { status: 'read' }>

/**
 * How far the adding of a reading's purchases has got. Whoever waits for the adding shares this with it. The adding
 * notes here what it has done, as it does it, so that the log has that however the adding ends, and so that nobody
 * is told to send again a message whose purchases are stored. And whoever waits notes here when they wait no longer.
 */
export interface Adding {
  /** How many purchases the adding has stored. */
  stored: number
  /** How many it holds, for their user to answer for. */
  held: number
  /**
   * Whether a purchase for the message is in the store, or is on its way there: one that this adding stored or is
   * storing, or one that an earlier delivery of the message stored. A message that is sent again is a new message,
   * and stores its purchases a second time. So from then on its user is not to be told to send it again.
   */
  kept: boolean
  /**
   * Whether the time of whoever waits for the adding is up, which is theirs to note. By then the user has been told
   * that it took too long, and may send the message again. So from then on the adding stores nothing.
   */
  late: boolean
}

/** Purchases that are stored on one card: its last four digits, and the card, when their user has one with those. */
interface OnCard {
  last4: string
  card?: Card
  purchases: Dated[]
}

/**
 * What the user of a reading is told of the adding of its purchases: those that were added, as a reply that is sent
 * as a rich message, and after it the messages of text, which are the purchases that are held, with their buttons,
 * what there is to know besides, and last those that were added with nothing to place them: see unplacedPrompts. A
 * reading that left nothing to tell of has neither.
 */
export interface Added {
  rich?: Tabled
  text: Outgoing[]
}

/** What became of purchases that were to be stored for a message: see `keep`. */
interface Kept {
  /** Those that are stored, in the order given: by this storing of them or by an earlier one, and not taken out. */
  added: Transaction[]
  /** How many of them this storing stored. */
  stored: number
  /** How many an earlier storing stored, that their user has taken out since. These are not stored again. */
  takenOut: number
  /** How many were not stored, because their user has added as many purchases by hand as a user may in 24 hours. */
  leftOut: number
}

/**
 * Whether a message was read before: whether a purchase of it is stored, at any place that a reading has, or
 * purchases of it are held. Telegram delivers a message again when it has not heard that the message was taken. A
 * second reading of it can differ from the first, and purchases are stored under their places in the reading: so a
 * message that was read is not read again. One whose purchases were all taken out since is one that was read.
 */
export async function readBefore(deps: Deps, userId: number, messageId: number): Promise<boolean> {
  const { db, now } = deps
  const places = Array.from({ length: MAX_PURCHASES_PER_PHOTO }, (_, place) => sourceIdOf(messageId, place))
  const [stored, held] = await Promise.all([
    storeFor(db, userId).findBySourceIds(places),
    heldStoreFor(db, userId).find(messageId, Math.floor(now().getTime() / 1000)),
  ])
  return stored.length > 0 || held !== null
}

/** What a purchase of a reading is stored under: the id of the message, and its place in the reading. */
function sourceIdOf(messageId: number, place: number): string {
  return `${MANUAL}:${messageId}:${place}`
}

/**
 * Answers the press of a button under purchases that are held: see heldPrompt. A press adds them, to the card of
 * its button when the bot could not tell which card they were made with, or skips them. Either way the message
 * that asked about them is edited to say what was done, and they are held no longer. `under` is the id of that
 * message. A press is acted on only for purchases that are held for the user who pressed: their store finds no
 * others.
 *
 * Purchases that are no longer held are added by no press, which is then answered with that its button no longer
 * works: they were answered for already, or they waited for longer than purchases are held. They are let go of
 * last, once the message says what was done. So a press that Telegram did not take the answer to, or the edit
 * after it, can be made again.
 *
 * The press that is made again can be of another button. So a press says what is true of the store, whichever
 * button it was. Before it adds or skips, it looks whether these purchases are stored already. If they are, it
 * stores nothing and skips nothing, and brings the message up to date with what is stored. And the line that names
 * a card is made from the card that the purchases are stored on, and never from the button: see byCard.
 */
export async function pressHeld(
  deps: Deps,
  chatId: number,
  pressed: { messageId: number; choice: string },
  under: number | undefined,
  handling: Handling,
  answer: (text: string) => Promise<void>,
  refuse: () => Promise<void>,
): Promise<void> {
  const { db, messenger, now } = deps
  const user = await findUser(db, chatId)
  if (!user) return refuse()
  const batches = heldStoreFor(db, user.id)
  const batch = await batches.find(pressed.messageId, Math.floor(now().getTime() / 1000))
  const refused = () => {
    log('held_press', { user: user.id, outcome: 'refused', held: 0, stored: 0 })
    return refuse()
  }
  if (!batch) return refused()
  const count = batch.purchases.length
  const day = dayIn(user.timezone, now())
  /** Answers the press, puts the lines in the place of what the message asked, and lets go of the purchases. */
  const done = async (said: string, lines: Line[]) => {
    await answer(said)
    if (typeof under === 'number') {
      const [message] = inMessages(lines)
      await messenger.edit(chatId, under, message.text, message.entities)
    }
    await batches.remove(batch.messageId)
  }

  const store = storeFor(db, user.id)
  // What is stored of these purchases already: something, when an earlier press added them and the buttons stayed.
  const before = await store.findBySourceIds(batch.purchases.map(({ place }) => sourceIdOf(batch.messageId, place)))
  if (before.length === 0 && pressed.choice === 'skip') {
    log('held_press', { user: user.id, outcome: 'skipped', held: count, stored: 0 })
    const these = count === 1 ? 'This purchase was' : `These ${count} purchases were`
    return done('Skipped.', [{ text: `Skipped. ${these} not added:` }, ...heldLines(batch.purchases, day, false)])
  }

  const cards = await store.listCards()
  let kept: Kept
  if (before.length > 0) {
    // What the press asked for was done by the press before it, or cannot be done now that they are stored.
    handling.handled = true
    kept = standing(batch.messageId, batch.purchases, before)
  } else {
    // The card is the one that the purchases are held for or, when they are held for none, the one that the button
    // names. A press that brings the other of the two is none that a button under these purchases holds.
    const last4 = pressed.choice === 'add' ? batch.cardLast4 : batch.cardLast4 === null ? pressed.choice : null
    const card = last4 === null ? undefined : cards.find((each) => each.last4 === last4)
    if (!card) return refused()
    const categories = await categoriesFor(card, choiceOn(card, batch.category), batch.purchases)
    // What the press asked for is done once the purchases are stored, whatever fails after that.
    kept = await keep(store, card, categories, batch.messageId, batch.purchases, () => {
      handling.handled = true
    })
  }
  log('held_press', { user: user.id, outcome: 'added', held: count, stored: kept.stored })
  const added = kept.added.map((purchase) => ({ ...purchase, date: day(new Date(purchase.occurredAt * 1000)) }))
  const answered = added.length > 0 ? `Added ${counted(added.length)}.` : 'No purchases were added.'
  // After what was added comes the note of those that are counted in the window after theirs: see carriedNotes.
  const on = byCard(cards, added)
  const notes = [...carriedNotes(on, now(), user.timezone, day), ...keptNotes(kept)]
  await done(answered, [...addedLines(on), ...notes.map((text) => ({ text }))])
  // Asked once the purchases are let go of, so a press that comes after this one asks nothing again. Two that come
  // together both ask, as both say what was added.
  await sendReply(messenger, chatId, unplacedPrompts(on, user.timezone))
}

/**
 * Stores a purchase that its user described, and tells of it: the purchase, and where it leaves its card. On a card
 * with a product the message ends as the one for a purchase from an alert does, with where the purchase is sorted
 * and with the buttons that move it. `messageId` is Telegram's id of the message that described the purchase, and
 * `stored` is called once a purchase for that message is known to be stored.
 */
export async function addPurchase(
  store: Store,
  card: Card,
  entry: Entry,
  messageId: number,
  now: Date,
  timeZone: string,
  stored: () => void,
): Promise<string | Outgoing[]> {
  const described = { ...entry, cardLast4: card.last4, parser: MANUAL }
  const [category] = await startingCategoriesOn(card, [described])
  // No alert gives this purchase an id to be known by, so it is known by the message that described it. Telegram
  // delivers a message again when it has not heard that the message was taken, and that is then no second purchase.
  const sourceId = `${MANUAL}:${messageId}`
  const id = await store.insertTransaction({ ...described, sourceId, category })
  // The store adds no purchase past the limit, and none for a message that it has one for already. Which of the two
  // it was is looked up only now that one of them has happened. A message that comes again is answered with its
  // purchase as it stands, which is what the first delivery was answered with.
  const purchase = id === null ? await store.findBySourceId(sourceId) : { ...described, id, category, removedAt: null }
  if (!purchase) return TOO_MANY_BY_HAND
  if (purchase.removedAt !== null) return `ID ${purchase.id} has been taken out, and is not added again.`
  // From here on a purchase for this message is stored: by this delivery of the message, or by an earlier one.
  // Whatever fails after this, its user is not to be told to send the message again.
  stored()

  const [totals] = await cardTotals(store, [card], now, timeZone)
  const date = formatShortDate(new Date(purchase.occurredAt * 1000), timeZone)
  // After where the card stands comes the note of a purchase that is counted in the window after the one that it
  // was made in: see carriedNotes. The line that says where the purchase is sorted stays the last, as a press of a
  // button replaces the last line.
  const shortDate = (day: Date) => formatShortDate(day, timeZone)
  const notes = carriedNotes([{ card, purchases: [purchase] }], now, timeZone, shortDate)
  const told = [spendLine(totals, timeZone), ...notes].map((text) => ({ text }))
  const lines = [purchaseLine(purchase, date), ...told]
  const product = productOf(card.product)
  if (!product) return inMessages(lines)
  const { line, buttons } = sortEnd(product, purchase)
  const [message] = inMessages([...lines, { text: line }])
  return [{ ...message, buttons }]
}

/**
 * Adds the purchases of a reading for the user whose message they were read from, and makes what the user is told
 * of it. It knows nothing of what the reading was made from: a photo's is one, and whatever else gives a reading
 * has its purchases added by this, in the same way.
 *
 * The card is the one that the reading names or, for a user with one card, that card: but not when the reading
 * says that a card was named which is none of the user's, and the card is then not known. The category of a
 * purchase is the one that the reading names, when that is one of the card's, and otherwise where /add would start
 * the purchase. What is clear is stored at once: with the card known, every purchase that the reading is sure of.
 * What is not is held as one batch, for its user to answer for with the buttons under the message that shows it:
 * every purchase that the reading is unsure of and, with the card not known, all of them. See pressHeld for the
 * answer.
 *
 * `cards` are the user's cards, of which there is at least one. `messageId` is Telegram's id of the message: a
 * purchase is stored under it and under its place in the reading, whatever the message was, so that one which is
 * delivered again stores nothing twice. A message that was read before is not to be read again, which is for
 * whoever has a reading made to look to: see readBefore. Two deliveries that are read at the same moment get here
 * all the same, and the second is then told of the purchases as they are stored: under the card that they are on,
 * whichever card its own reading named. What is done is noted in `adding` as it is done: see Adding. Nothing is
 * returned, with nothing stored and nothing held, when the time of whoever waits was up before the storing began.
 */
export async function addRead(
  deps: Deps,
  user: User,
  cards: Card[],
  reading: Reading,
  messageId: number,
  adding: Adding,
): Promise<Added | undefined> {
  const { db, now } = deps
  const store = storeFor(db, user.id)
  // A user's one card stands in for the card that nobody named. It does not for a card that was named and that
  // they have not got: purchases that were said to be on another card are not put on this one without a word.
  const only = cards.length === 1 && !reading.unknownCard ? cards[0] : undefined
  const card = cards.find((each) => each.nickname === reading.card) ?? only
  const named = choiceOn(card, reading.category)
  // No more purchases are taken from one reading than this, whatever it holds. Each has its place from here on.
  const taken = reading.purchases.slice(0, MAX_PURCHASES_PER_PHOTO)
  const read = taken.map(({ occurredAt, amountMinor, currency, merchant, unsure }, place): HeldPurchase => {
    return { place, occurredAt, amountMinor, currency, merchant, unsure }
  })
  const clear = card ? read.filter((purchase) => !purchase.unsure) : []
  const unclear = card ? read.filter((purchase) => purchase.unsure) : read

  // Worked out before the look at `adding.late`, as it can wait for an answer from outside: nothing is waited for
  // between that look and the storing.
  const categories = await categoriesFor(card, named, clear)
  if (adding.late) return undefined
  // While the storing is under way, a purchase for the message may be in the store, and counts as one that is. A
  // storing that fails before anything is stored leaves none there. Once it is done, it is known whether one is.
  adding.kept = clear.length > 0
  const kept = await keep(store, card, categories, messageId, clear, (stored) => {
    adding.stored = stored
  }).catch((error: unknown) => {
    adding.kept = adding.stored > 0
    throw error
  })
  adding.kept = kept.added.length > 0
  if (unclear.length > 0) {
    // With the card not known, the key is held as the reading has it, for the card that a button names: see pressHeld.
    const category = card ? named : reading.category
    const batch = { messageId, cardLast4: card?.last4 ?? null, category, purchases: unclear }
    await heldStoreFor(db, user.id).hold(batch, Math.floor(now().getTime() / 1000))
    adding.held = unclear.length
  }

  // One formatter for all the dates: see dayIn.
  const day = dayIn(user.timezone, now())
  const added = kept.added.map((purchase) => ({ ...purchase, date: day(new Date(purchase.occurredAt * 1000)) }))
  let rich: Tabled | undefined
  let toSort: Outgoing[] = []
  if (added.length > 0) {
    // What was added is told by the card that it is stored on, which is not the reading's when an earlier delivery
    // of the message stored it on another: see byCard. With it is where it leaves that card, as the reply to /add
    // has it, and after that the note of those that are counted in the window after theirs.
    const on = byCard(cards, added)
    const totals = await cardTotals(store, on.flatMap((each) => each.card ?? []), now(), user.timezone)
    rich = addedReply(on, totals, user.timezone, carriedNotes(on, now(), user.timezone, day))
    toSort = unplacedPrompts(on, user.timezone)
  }
  const asked = unclear.length > 0 ? [heldPrompt(messageId, unclear, day, cards, card, named)] : []

  // What there is to know besides, a line to each: what was not added, what was not read, and what was not taken.
  const notes = keptNotes(kept)
  if (reading.unreadable > 0) {
    const [purchases, them] = reading.unreadable === 1 ? ['purchase', 'it'] : ['purchases', 'them']
    // They are more where others were read, which their user has been told of by then.
    const count = `${reading.unreadable} ${read.length > 0 ? 'more ' : ''}${purchases}`
    notes.push(`${count} could not be read at all. Add ${them} by hand with /add.`)
  }
  if (reading.more || reading.purchases.length > taken.length) {
    notes.push(
      `Only the first ${MAX_PURCHASES_PER_PHOTO} purchases of a message are read. Send the rest on their own, or ` +
        'add them with /add.',
    )
  }
  const besides = notes.length > 0 ? [{ text: notes.join('\n') }] : []
  return { rich, text: [...asked, ...besides, ...toSort] }
}

/** What `keep` comes to when it is given no purchases. */
const NOTHING_KEPT: Kept = { added: [], stored: 0, takenOut: 0, leftOut: 0 }

/**
 * The category that each of the purchases of a reading is stored with on the card, in their order: the one that the
 * reading named for them or, when `named` is null, where /add would start each.
 */
async function categoriesFor(
  card: Card | undefined,
  named: string | null,
  purchases: HeldPurchase[],
): Promise<(string | null)[]> {
  return named === null ? startingCategoriesOn(card, purchases) : purchases.map(() => named)
}

/**
 * Stores purchases of a reading on a card, as /add stores one: they are purchases that their user added by hand,
 * and count as such. `categories` has the category of each: see categoriesFor. Nothing is stored when there is no
 * card to store it on, or nothing to store.
 *
 * No alert gives these purchases ids to be known by, so each is known by the message that it was read from and by
 * its place in the reading. Telegram delivers a message again when it has not heard that the message was taken,
 * and a button under purchases that are held can be pressed twice: neither stores a purchase a second time.
 *
 * `stored` is called once the purchases are in the store, with how many of them this storing put there. Whatever
 * fails after that, they are stored.
 */
async function keep(
  store: Store,
  card: Card | undefined,
  categories: (string | null)[],
  messageId: number,
  purchases: HeldPurchase[],
  stored: (count: number) => void,
): Promise<Kept> {
  if (!card || purchases.length === 0) return NOTHING_KEPT
  const given = purchases.map(({ place, occurredAt, amountMinor, currency, merchant }, at) => {
    const described = { cardLast4: card.last4, amountMinor, currency, merchant, occurredAt }
    return { ...described, sourceId: sourceIdOf(messageId, place), category: categories[at] }
  })
  // One statement for all of them, and their ids come back with what each is stored under.
  const ids = new Map((await store.insertByHand(given)).map(({ sourceId, id }) => [sourceId, id]))
  stored(ids.size)
  // The store adds no purchase past the limit, and none under a source id that it has one under already. Which of
  // the two it was is looked up only now that one of them has happened. A purchase that is stored already is told
  // of as it stands, which is what the first delivery of its message told of.
  const rest = given.filter(({ sourceId }) => !ids.has(sourceId)).map(({ sourceId }) => sourceId)
  const earlier = rest.length > 0 ? await store.findBySourceIds(rest) : []

  const kept: Kept = { added: [], stored: ids.size, takenOut: 0, leftOut: 0 }
  for (const { sourceId, ...purchase } of given) {
    const id = ids.get(sourceId)
    const before = earlier.find((each) => each.sourceId === sourceId)
    if (id !== undefined) kept.added.push({ ...purchase, id, parser: MANUAL })
    else if (!before) kept.leftOut++
    else if (before.removedAt === null) kept.added.push(before)
    else kept.takenOut++
  }
  return kept
}

/**
 * What became of purchases of a message of which some are stored already, when nothing more is stored now: what
 * `keep` would come to for them. `before` are those that are stored. Each that is not was left out for the limit
 * on purchases by hand when the others were stored, as one statement stores all that it has room for.
 */
function standing(messageId: number, purchases: HeldPurchase[], before: Sourced[]): Kept {
  const kept: Kept = { added: [], stored: 0, takenOut: 0, leftOut: 0 }
  for (const { place } of purchases) {
    const stored = before.find((each) => each.sourceId === sourceIdOf(messageId, place))
    if (!stored) kept.leftOut++
    else if (stored.removedAt === null) kept.added.push(stored)
    else kept.takenOut++
  }
  return kept
}

/**
 * Purchases by the card that each is stored on, a group to each card, in the order in which the cards first come.
 * Whatever names a card for purchases that are stored goes by this, and not by the card that a reading named or
 * that a button was for: a message that was delivered twice, or a button that was pressed after another, can bring
 * another card than the one that the purchases went to. `cards` are the user's. A card that they have removed since
 * is known by its last four digits alone.
 */
function byCard(cards: Card[], purchases: Dated[]): OnCard[] {
  const on = new Map<string, Dated[]>()
  for (const purchase of purchases) on.set(purchase.cardLast4, [...(on.get(purchase.cardLast4) ?? []), purchase])
  return [...on].map(([last4, those]) => ({
    last4,
    card: cards.find((each) => each.last4 === last4),
    purchases: those,
  }))
}

/**
 * What gives the day of a purchase that was read from a message, as its user is shown it: the day and the month,
 * as `shortDateIn` has them, and the year too when it is not the year that it is now in the time zone, as in
 * "5 Oct 2025". A photo mostly shows no year, so the year is the model's to choose, and a wrong one is not to go
 * unseen: a purchase of another year is in no window that anything is counted over. One formatter is made for all
 * the days of a reply, as there.
 */
function dayIn(timeZone: string, now: Date): (date: Date) => string {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric', month: 'short', year: 'numeric' })
  const thisYear = String(dayOf(now, timeZone).year)
  return (date) => {
    const parts = format.formatToParts(date)
    const get = (type: 'day' | 'month' | 'year') => parts.find((part) => part.type === type)?.value
    return get('year') === thisYear ? `${get('day')} ${get('month')}` : `${get('day')} ${get('month')} ${get('year')}`
  }
}

/**
 * The category that a reading named, when it is one that a purchase on the card can be put in by hand. Null when it
 * is not, when the reading named none, and when the card is not known.
 */
function choiceOn(card: Card | undefined, named: string | null): string | null {
  const product = productOf(card?.product)
  return product && choicesOf(product).some((choice) => choice.key === named) ? named : null
}

/** A count of purchases as a user is told it: "1 purchase", or "3 purchases". */
function counted(count: number): string {
  return `${count} ${count === 1 ? 'purchase' : 'purchases'}`
}

/**
 * What a user is told of those purchases of a reading that were to be stored and were not, a line to each fact: how
 * many they had taken out since an earlier delivery stored them, and how many the limit on purchases by hand left
 * out. Nothing in it says to send the message again: other purchases of the message may be stored.
 */
function keptNotes({ takenOut, leftOut }: Kept): string[] {
  const notes: string[] = []
  if (takenOut > 0) {
    const [have, are] = takenOut === 1 ? ['has', 'is'] : ['have', 'are']
    notes.push(`${takenOut} of these purchases ${have} been taken out, and ${are} not added again.`)
  }
  if (leftOut > 0) {
    const [were, them] = leftOut === 1 ? ['was', 'it'] : ['were', 'them']
    notes.push(
      `${counted(leftOut)} ${were} not added. You have added ${MAX_BY_HAND_PER_DAY} purchases by hand in the last ` +
        '24 hours, which is as many as can be added in that time. A purchase that the bot reads for you counts as ' +
        `one. Add ${them} with /add later.`,
    )
  }
  return notes
}

/**
 * Where purchases are put, as their user is told it: the card and, on a card with a product, the category, as in
 * "evol ••••5678 as Other Spend". `category` is the key of the category that they are in, or null for purchases
 * that are in none.
 */
function placed(card: Card, category: string | null): string {
  const product = productOf(card.product)
  if (!product) return label(card)
  const name = categoryName(product, category)
  return name === undefined ? `${label(card)}, not sorted` : `${label(card)} as ${name}`
}

/**
 * What the tables of purchases that were added to one card are of: one table for each category of the card's
 * product that a purchase of them is in, in the product's order, and one in all on a card with no product. A table
 * is named for its card and its category, which is the line that it is under, and ends with what its purchases
 * come to. Purchases on a card that their user has removed since are named for its last four digits.
 */
function addedSections({ last4, card, purchases: added }: OnCard): Section[] {
  const product = productOf(card?.product)
  const section = (purchases: Dated[], category: string | null): Section => ({
    name: `Added to ${card ? placed(card, category) : maskLast4(last4)}:`,
    purchases,
    spent: perCurrency(purchases),
  })
  if (!product) return [section(added, null)]
  // A purchase is told apart by what is stored for it. Where it is is what the product makes of that.
  const among = added.map((purchase) => ({ purchase, category: categoryOf(product, purchase.category) }))
  const keys = [...categoriesOf(product).map((category) => category.key), null]
  return keys.flatMap((key) => {
    const there = among.filter(({ category }) => category === key).map(({ purchase }) => purchase)
    return there.length > 0 ? [section(there, key)] : []
  })
}

/**
 * What was added once its user answered for it, as the lines of a message of text: each purchase on a line, with
 * its id, under the line that names its card and its category. This is what the message that asked about the
 * purchases is edited to say, and a message of text is not edited into a rich one: see sendLater. `on` are the
 * purchases by the card that each is stored on: see byCard.
 */
function addedLines(on: OnCard[]): Line[] {
  return on.flatMap(addedSections).flatMap(({ name = '', purchases }) => [
    { text: name },
    ...purchases.map((purchase) => purchaseLine(purchase, purchase.date)),
  ])
}

/**
 * What was added from a reading, as a reply: the purchases in tables like those of /spend with a card, each under
 * the line that names its card and its category, and after them where the card then stands, in the line that the
 * reply to /add has. It is one rich message. As text, a table is a block: see purchaseTables. `on` are the
 * purchases by the card that each is stored on, which is one card but for a message that was read twice, and
 * `totals` are what each of those cards then comes to. `notes` is the note of the purchases that are counted in the
 * window after theirs, when there is one, which comes last: see carriedNotes.
 */
function addedReply(on: OnCard[], totals: CardTotals[], timeZone: string, notes: string[]): Tabled {
  const homeCurrency = (card?: Card) => productOf(card?.product)?.homeCurrency ?? DEFAULT_CURRENCY
  // Every purchase of a reading is one that was added by hand, and is marked so in its table.
  const below = [BY_HAND_NOTE, ...totals.map((each) => spendLine(each, timeZone)), ...notes]
  return {
    rich: {
      blocks: [
        ...on.flatMap((each) => purchaseBlocks(addedSections(each), homeCurrency(each.card))),
        ...below.map((text): RichBlock => ({ type: 'paragraph', text })),
      ],
      skip_entity_detection: true,
    },
    asText() {
      const parts: (Line | Table)[][] = [
        ...on.flatMap((each) => purchaseTables(addedSections(each), homeCurrency(each.card))).map((table) => [table]),
        ...below.map((text) => [{ text }]),
      ]
      // An empty line before each part. A message does not begin with one.
      return inMessages(parts.flatMap((part) => [{ text: '' }, ...part]))
    },
  }
}

/**
 * The most purchases that are asked about after one adding: see unplacedPrompts. Each is a message of its own, and
 * five of those are as many as one adding should set off.
 */
const MAX_ASKED = 5

/**
 * What asks about those of the purchases that were added with nothing to place them: see `unplaced`. A line says
 * why, and under it each is a message of its own, as /sort shows it, with the buttons that move it. No more are
 * asked about than MAX_ASKED, and a line counts the rest. Nothing when something placed every purchase. `on` are the
 * purchases by the card that each is stored on: see byCard.
 */
function unplacedPrompts(on: OnCard[], timeZone: string): Outgoing[] {
  const those = on.flatMap(({ card, purchases }) => {
    const product = productOf(card?.product)
    if (!product) return []
    return purchases.filter((purchase) => unplaced(product, purchase)).map((purchase) => ({ product, purchase }))
  })
  if (those.length === 0) return []
  const asked = those.slice(0, MAX_ASKED).map(({ product, purchase }) => sortPrompt(product, purchase, timeZone))
  const more = those.length - asked.length
  return [{ text: NOT_PLACED }, ...asked, ...(more > 0 ? [{ text: moreNotPlaced(more) }] : [])]
}

/** Purchases that are held, each on a line: see heldLine. */
function heldLines(held: HeldPurchase[], shortDate: (date: Date) => string, flagged: boolean): Line[] {
  return held.map((purchase) => heldLine(purchase, shortDate(new Date(purchase.occurredAt * 1000)), flagged))
}

/**
 * The message that asks about purchases that are held: what is asked, each purchase on a line, and the buttons that
 * answer. With the card known, they are the purchases that the reading was not sure of, and one button adds them
 * while another skips them. With the card not known, they are all the purchases of the reading, each marked when the
 * reading was not sure of it, and in the place of the button that adds them there is one for each of the user's
 * cards. `named` is the category that the reading named, or null.
 */
function heldPrompt(
  messageId: number,
  held: HeldPurchase[],
  shortDate: (date: Date) => string,
  cards: Card[],
  card: Card | undefined,
  named: string | null,
): Outgoing {
  const count = held.length
  if (card) {
    // The category is named only when the reading named one: with none, each purchase starts where /add puts it.
    const where = named === null ? label(card) : placed(card, named)
    const head =
      count === 1
        ? `Not sure about this purchase. Check its amount and its date before you add it to ${where}:`
        : `Not sure about these ${count} purchases. Check the amount and the date of each before you add them ` +
          `to ${where}:`
    const [message] = inMessages([{ text: head }, ...heldLines(held, shortDate, false)])
    return { ...message, buttons: heldButtons(messageId, count) }
  }
  const head =
    count === 1
      ? 'Which card was this purchase made with? The bot could not tell.'
      : `Which card were these ${count} purchases made with? The bot could not tell.`
  const foot = held.some((purchase) => purchase.unsure) ? [{ text: UNSURE_NOTE }] : []
  const [message] = inMessages([{ text: head }, ...heldLines(held, shortDate, true), ...foot])
  return { ...message, buttons: heldButtons(messageId, count, cards) }
}
