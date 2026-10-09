import { exampleBank } from './example-bank'
import { ocbc } from './ocbc'
import type { AlertEmail, ParsedTransaction, Parser } from './types'
import { uob } from './uob'

const parsers: Parser[] = [exampleBank, ocbc, uob]

// Email text can be hostile, so no parser ever sees more of it than this.
const MAX_TEXT_LENGTH = 20_000

export type ParsedAlert = ParsedTransaction & { parser: string }

/** Every address that a bank's alerts come from. Mail from no other sender is looked for. */
export function alertSenders(): string[] {
  return parsers.flatMap((parser) => parser.senders)
}

/** The reading of the email by the parser of the bank it came from, or null. */
export function parseAlert(email: AlertEmail): ParsedAlert | null {
  const bounded = { ...email, text: email.text.slice(0, MAX_TEXT_LENGTH) }
  const sender = email.from.trim().toLowerCase()
  const parser = parsers.find((candidate) => candidate.senders.includes(sender))
  if (!parser) return null
  const transaction = parser.parse(bounded)
  return transaction && { ...transaction, parser: parser.name }
}
