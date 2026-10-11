export interface AlertEmail {
  /** An id taken from the email. It is what makes a repeated alert a duplicate. */
  sourceId: string
  /** The sender's bare address, such as alerts@examplebank.test. */
  from: string
  subject: string
  /** Unix seconds. */
  receivedAt: number
  text: string
}

export interface ParsedTransaction {
  cardLast4: string
  /** Hundredths of the currency unit, whatever the currency: SGD 12.40 is 1240. */
  amountMinor: number
  /** Three-letter code, such as SGD. */
  currency: string
  merchant: string | null
  /** Unix seconds, UTC. */
  occurredAt: number
}

export interface Parser {
  /**
   * What a purchase that the parser read is stored under, and what the log knows the bank by. The name of a new
   * parser is added here, and to the `alert` event in src/log.ts.
   */
  name: 'example-bank' | 'ocbc' | 'uob'
  /** The bare addresses that the bank sends its alerts from, in lower case. */
  senders: string[]
  /** Null when the email is from this parser's bank but holds no purchase it can read. */
  parse(email: AlertEmail): ParsedTransaction | null
}
