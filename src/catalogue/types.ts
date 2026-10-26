import type { Parser } from '../parsers/types'

/** A card product whose reward rules are known: what its purchases are sorted into, and what the bank pays on them. */
export interface Product {
  /** What a user types to link a card to the product. */
  key: string
  /** The parser of the bank whose alerts tell of the product's purchases. */
  bank: Parser['name']
  name: string
  /** The currency that the card is billed in. The amounts of the terms are in hundredths of its unit. */
  homeCurrency: string
  /** The date that the terms which the rules were taken from are as of. */
  termsAsOf: string
  /**
   * What has to be spent in a month, as the terms count one, before the groups with a limit earn their rate. Missing
   * when the terms set no minimum.
   */
  minimumSpendMinor?: number
  /** What a month below the minimum spend earns, as the terms state it. Missing when they do not say. */
  earnsBelowMinimum?: string
  /** The most cashback that the terms pay in a month, over the caps of its groups. Missing when they set none. */
  cashbackCapMinor?: number
  /**
   * How many days at the end of a window a card of the product counts in the next one: the day that the window
   * closes on, and as many before it as make up the number. A bank counts a purchase by the day that it is posted,
   * which is after the day that it was made. A product whose terms count a purchase by the day that it was made
   * says 0, and a product without this has what a card with no product has: DAYS_COUNTED_IN_NEXT in
   * ../domain/window, where `currentWindow` says what becomes of the number.
   */
  daysCountedInNext?: number
  groups: Group[]
  /**
   * The key of the category that a purchase is in when no rule and no stored choice says otherwise. A product
   * without one leaves such a purchase unsorted, for its user to sort.
   */
  defaultCategory?: string
  /**
   * What a user is told, with how the card's purchases are sorted, of the sorting that is left to them: a sentence
   * for what the names of the categories do not say.
   */
  sortingNote?: string
}

/** Categories that earn at one rate and, when the rate is paid on no more than so much spend, share that limit. */
export interface Group {
  name: string
  /**
   * The spend that the rate is paid on in a month, as the terms count one: a statement month, or the calendar month.
   * Missing when the terms set no limit.
   */
  limitMinor?: number
  /** What the group earns, as the terms state it, with any cap on the cashback itself. Missing when not known. */
  earns?: string
  categories: Category[]
}

/** What a purchase is sorted into. */
export interface Category {
  key: string
  /** What the category is called on the button that puts a purchase here, which reads "Mark as" and then this. */
  label: string
  /**
   * What puts a purchase here with nobody choosing: that it was made in another currency than the product's, or
   * that the text of its merchant matches the pattern.
   */
  automatic?: 'foreign-currency' | RegExp
  /** The merchants that the terms name for the category, as the terms write them. */
  named?: string[]
  /**
   * The merchant category codes that put a purchase here, when the code of its merchant is known: those that the
   * terms list, or 'unlisted' for every code that no other category of the product lists.
   */
  mccs?: Mcc[] | 'unlisted'
}

/** A merchant category code, or a run of them: its first and its last, which are both in it. */
export type Mcc = number | [from: number, to: number]
