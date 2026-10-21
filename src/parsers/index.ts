import { dbs } from './dbs'
import { hsbc } from './hsbc'
import { ocbc } from './ocbc'
import type { AlertEmail, ParsedTransaction, Parser } from './types'
import { uob } from './uob'

/** Exported for the tests, which add a stand-in for a bank to it. */
export const parsers: Parser[] = [ocbc, uob, hsbc, dbs]

// Email text can be hostile, so no parser ever sees more of it than this.
const MAX_TEXT_LENGTH = 20_000

export type ParsedAlert = ParsedTransaction & { parser: Parser['name'] }

/** Every address that a bank's alerts come from. Mail from no other sender is looked for. */
export function alertSenders(): string[] {
  return parsers.flatMap((parser) => parser.senders)
}

/** The parser of the bank that the email came from, going by its sender. Undefined when it came from no bank. */
export function parserOf(email: AlertEmail): Parser | undefined {
  const sender = email.from.trim().toLowerCase()
  return parsers.find((candidate) => candidate.senders.includes(sender))
}

/** The reading of the email by the parser of the bank it came from, or null. */
export function parseAlert(email: AlertEmail): ParsedAlert | null {
  const bounded = { ...email, text: email.text.slice(0, MAX_TEXT_LENGTH) }
  const parser = parserOf(email)
  if (!parser) return null
  const transaction = parser.parse(bounded)
  return transaction && { ...transaction, parser: parser.name }
}
