// Asking before a command is run: the message that asks, with its buttons, and the press that answers it.

import { productOf } from '../catalogue'
import type { Deps } from '../deps'
import { CONFIRMABLE, log } from '../log'
import { findUser, storeFor, type User } from '../store'
import { connectStoreFor } from '../store-connect'
import {
  NICKNAME,
  noSuchProduct,
  parseCard,
  parsePattern,
  parseReminder,
  PRODUCT_KEY,
  PURCHASE_ID,
  timeZoneNamed,
} from './arguments'
import { commandIn, ran } from './commands'
import { formatAmount, formatShortDate, maskLast4 } from './format'
import { confirmButtons, inMessages, purchaseLine, type Line } from './purchases'
import { describeCard, label, patternLine } from './replies'
import { sendReply } from './sending'
import { codeWithin, declined, type Carried, type Handling, type Press } from './shared'
import {
  askNoReminder,
  askReminder,
  CANCELLED,
  NOT_DONE,
  REMOVE_PATTERN,
  RENAME_ADDED,
  SAVE_PATTERN,
  SEE_REPLY,
  SEND_YOURSELF,
  WILL_SORT_AGAIN,
} from './texts'

/**
 * Asks before a command is run: with a message that says what would be done and to what, and with a button that
 * does it and one that does not. Nothing is done until the first of them is pressed: see pressConfirm. The command
 * rides under the buttons as the line that its user would send, which is made here from what the model's line was
 * read to mean, and is none of the model's text.
 *
 * Where there is nothing that the command could do, it is answered with what the command itself would say of that,
 * and with no buttons: a purchase or a card that the user has not got, a product that there is not, a nickname that
 * a card of theirs has already, a Gmail that is not connected, and one that is connected already. A line that the
 * command would not take is answered with that it could not be done.
 */
export async function confirmFor(
  deps: Deps,
  user: User,
  name: (typeof CONFIRMABLE)[number],
  args: string[],
): Promise<Carried> {
  const { db } = deps
  switch (name) {
    case 'remove': {
      const [, id] = PURCHASE_ID.exec(args[0] ?? '') ?? []
      if (args.length !== 1 || id === undefined) return declined(NOT_DONE)
      const purchase = await storeFor(db, user.id).findTransaction(Number(id))
      if (!purchase) return declined(`You have no purchase with ID ${Number(id)}.`)
      const date = formatShortDate(new Date(purchase.occurredAt * 1000), user.timezone)
      return confirmation(`/remove ${purchase.id}`, [
        { text: `Take this purchase out of ${maskLast4(purchase.cardLast4)}?` },
        purchaseLine(purchase, date),
      ])
    }
    case 'removecard': {
      const [nickname = ''] = args
      if (args.length !== 1 || !NICKNAME.test(nickname)) return declined(NOT_DONE)
      const card = (await storeFor(db, user.id).listCards()).find((each) => each.nickname === nickname)
      if (!card) return declined(`You have no card called ${nickname}.`)
      return confirmation(`/removecard ${nickname}`, [{ text: `Stop tracking ${label(card)}?` }])
    }
    case 'disconnect': {
      if (args.length !== 0) return declined(NOT_DONE)
      const connection = await connectStoreFor(db, user.id).findConnection()
      if (!connection) return declined('Your Gmail is not connected.')
      return confirmation('/disconnect', [
        { text: `Disconnect your Gmail ${connection.email}? Its mail will no longer be read for this chat.` },
      ])
    }
    case 'mcp':
      if (args.length === 0) {
        return confirmation('/mcp', [
          { text: 'Make a new assistant access token? The one that you have now, if you have one, will stop working.' },
        ])
      }
      if (args.length !== 1 || args[0].toLowerCase() !== 'revoke') return declined(NOT_DONE)
      return confirmation('/mcp revoke', [
        { text: 'Remove your assistant access token? An assistant that uses it will no longer read your data.' },
      ])
    case 'connect': {
      if (args.length !== 0) return declined(NOT_DONE)
      const connection = await connectStoreFor(db, user.id).findConnection()
      if (connection?.status === 'active') {
        return declined(`Your Gmail ${connection.email} is already connected. Send /disconnect to remove it.`)
      }
      // A new sign-in takes the place of one that is under way: see startConnect in ../connect. Whoever has just
      // approved at Google, and has their code still to send, would send it to no sign-in.
      return confirmation('/connect', [
        {
          text:
            'Start a new sign-in to connect your Gmail? A sign-in that is waiting for its code is cancelled, and ' +
            'its code will no longer work.',
        },
      ])
    }
    case 'addcard': {
      const card = parseCard(args)
      if (typeof card === 'string') return declined(NOT_DONE)
      const window = card.windowType === 'statement' ? `statement ${card.statementDay}` : 'calendar'
      const words = ['/addcard', card.nickname, card.last4, window, ...(card.product ? [card.product] : [])]
      return confirmation(words.join(' '), [{ text: 'Add this card?' }, { text: describeCard(card) }])
    }
    case 'renamecard': {
      const [nickname = '', renamed = ''] = args
      if (args.length !== 2 || !NICKNAME.test(nickname) || !NICKNAME.test(renamed)) return declined(NOT_DONE)
      const cards = await storeFor(db, user.id).listCards()
      const card = cards.find((each) => each.nickname === nickname)
      if (!card) return declined(`You have no card called ${nickname}.`)
      // The card's own nickname is one that a card has already, as it is to the command.
      const taken = cards.some((each) => each.nickname === renamed)
      if (taken) return declined(`You already have a card called ${renamed}.`)
      return confirmation(`/renamecard ${nickname} ${renamed}`, [{ text: `Rename ${label(card)} to ${renamed}?` }])
    }
    case 'product': {
      const [nickname = '', key = ''] = args
      if (args.length !== 2 || !NICKNAME.test(nickname) || !PRODUCT_KEY.test(key)) return declined(NOT_DONE)
      const product = productOf(key.toLowerCase())
      if (!product && key.toLowerCase() !== 'none') return declined(noSuchProduct(key))
      const card = (await storeFor(db, user.id).listCards()).find((each) => each.nickname === nickname)
      if (!card) return declined(`You have no card called ${nickname}.`)
      // What /product forgets of a card that has another product: see `reply` in ./commands.
      const relinked = card.product !== undefined && card.product !== product?.key
      const text = product
        ? `Link ${label(card)} to ${product.name}?${relinked ? ` ${WILL_SORT_AGAIN}` : ''}`
        : `Link ${label(card)} to no product? Its purchases will no longer be sorted.`
      return confirmation(`/product ${nickname} ${product?.key ?? 'none'}`, [{ text }])
    }
    case 'timezone': {
      const zone = args.length === 1 ? timeZoneNamed(args[0]) : null
      if (!zone) return declined(NOT_DONE)
      return confirmation(`/timezone ${zone}`, [
        { text: `Change your time zone to ${zone}? Your cards' cycles and months will begin and end by it.` },
      ])
    }
    case 'pattern': {
      const asked = parsePattern(args)
      if (!asked) return declined(NOT_DONE)
      const { nickname, merchant, save } = asked
      const card = (await storeFor(db, user.id).listCards()).find((each) => each.nickname === nickname)
      if (!card) return declined(`You have no card called ${nickname}.`)
      if (!save) {
        const line = `/pattern ${nickname} ${merchant} none`
        return confirmation(line, [{ text: REMOVE_PATTERN }, patternLine(card, merchant)])
      }
      const except = save.skips.length > 0 ? ['except', ...save.skips] : []
      const line = ['/pattern', nickname, formatAmount(save.amountMinor), merchant, ...except].join(' ')
      return confirmation(line, [{ text: SAVE_PATTERN }, patternLine(card, merchant, save)])
    }
    case 'remind': {
      const asked = parseReminder(args)
      if (!asked) return declined(NOT_DONE)
      const { nickname, day } = asked
      const card = (await storeFor(db, user.id).listCards()).find((each) => each.nickname === nickname)
      if (!card) return declined(`You have no card called ${nickname}.`)
      const text = day === null ? askNoReminder(label(card)) : askReminder(label(card), day)
      return confirmation(`/remind ${nickname} ${day ?? 'none'}`, [{ text }])
    }
  }
}

/**
 * The message that asks before a command is run: the lines, and under them the buttons that the command's line
 * rides in. A line that does not fit there is given to its user to send themselves, marked as code so that it can
 * be copied whole, and nothing is asked.
 */
function confirmation(line: string, lines: Line[]): Carried {
  const buttons = confirmButtons(line)
  if (!buttons) {
    const whole = { text: line, marked: { offset: 0, length: line.length } }
    return { replies: [inMessages([{ text: SEND_YOURSELF }, whole])], outcome: 'refused' }
  }
  const [message] = inMessages(lines)
  return { replies: [[{ ...message, buttons }]], outcome: 'asked' }
}

/**
 * Answers the press of a button under a message that asks before a command is run: see confirmFor. "Do it" runs the
 * command as if its user had sent it, and "Cancel" runs nothing. Either way the press is answered, and the message
 * then says which it was under what it asked, with no buttons.
 *
 * After "Do it" the command's reply is sent first, as a message of its own, before the press is answered or the
 * message is edited. The reply can be all that there is of what the command did: the token that /mcp makes is
 * nowhere else, and the one before it is dead by then. So nothing that Telegram refuses after the command has run
 * keeps the reply from the chat. A press that Telegram delivers a second time is one whose edit it refuses, as the
 * message says already what the edit would have it say. And once the reply is sent, neither the answering nor the
 * edit undoes or hides anything by failing: each is tried whatever came of the other, and a request that failed has
 * its own line in the log. A reply that cannot be sent fails the press, with its buttons still there to press again.
 *
 * The line that a button brings is what a client sent, which can be anything. It is run only when it is a line of
 * one of the commands that such a message can ask about, and a press that brings any other is answered with that
 * its button no longer works: a press runs nothing that deletes everything, and nothing that no message asks
 * about. What is run is run by `reply`, for the user who pressed, which takes the line apart as it takes a message
 * apart.
 *
 * Nothing here keeps a press from being made twice. A message that was pressed has no buttons, and a command that
 * is run a second time says so itself, as when its user sends it twice: there is no such purchase, or no such card.
 */
export async function pressConfirm(
  deps: Deps,
  chatId: number,
  pressed: { run: boolean; line: string },
  under: NonNullable<Press['message']>,
  handling: Handling,
  answer: (text: string) => Promise<void>,
  refuse: () => Promise<void>,
): Promise<void> {
  const { db, messenger } = deps
  const user = await findUser(db, chatId)
  if (!user) return refuse()
  const { name } = commandIn(pressed.line)
  const command = CONFIRMABLE.find((each) => each === name)
  if (!command) {
    log('confirm_press', { user: user.id, outcome: 'refused' })
    return refuse()
  }
  /** Has the message say what the press was answered with, under what it asked, with no buttons under it. */
  const edited = async (said: string) => {
    if (typeof under.message_id !== 'number' || typeof under.text !== 'string') return
    const marked = codeWithin(under.entities ?? [], under.text.length)
    const text = `${under.text}\n${said}`
    await messenger.edit(chatId, under.message_id, text, marked.length > 0 ? marked : undefined)
  }

  if (!pressed.run) {
    log('confirm_press', { user: user.id, command, outcome: 'cancelled' })
    await answer(CANCELLED)
    return edited(CANCELLED)
  }
  // No command that a press runs stores anything under the id of a message, so it is given none.
  const said = await ran(deps, chatId, 0, pressed.line)
  if (!said) return refuse()
  // What the press asked for is done once the command has run, whatever fails after that.
  handling.handled = true
  log('confirm_press', { user: user.id, command, outcome: 'done' })
  // The reply first: it can be all that there is of what the command did. Then the press is answered and the
  // message edited, each whatever came of the other. A request that Telegram refuses has its line in the log.
  // A card can be added by a press under an alert, with a nickname that the bot chose: see addCardButtons.
  const reply = command === 'addcard' && Array.isArray(said) ? [...said, { text: RENAME_ADDED }] : said
  await sendReply(messenger, chatId, reply)
  await answer(SEE_REPLY).catch(() => {})
  await edited(SEE_REPLY).catch(() => {})
}
