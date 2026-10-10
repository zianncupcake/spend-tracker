/** A card product whose reward rules are known: what its purchases are sorted into, and what the bank pays on them. */
export interface Product {
  /** What a user types to link a card to the product. */
  key: string
  name: string
  /** The currency that the card is billed in. The limits and the minimum spend are in hundredths of its unit. */
  homeCurrency: string
  /** Where the bank publishes the terms that the rules were taken from, and the date that those terms are as of. */
  termsUrl: string
  termsAsOf: string
  /** What has to be spent in a statement month before the groups with a limit earn their rate. */
  minimumSpendMinor: number
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
  /** The spend in a statement month that the rate is paid on. Missing when the terms set no limit. */
  limitMinor?: number
  categories: Category[]
}

/** What a purchase is sorted into. */
export interface Category {
  key: string
  /**
   * What the category is called on the button that puts a purchase here, which reads "Mark as" and then this. A
   * category without it cannot be chosen by hand.
   */
  label?: string
  /**
   * What puts a purchase here with nobody choosing: that it was made in another currency than the product's, or
   * that the text of its merchant matches the pattern.
   */
  automatic?: 'foreign-currency' | RegExp
}

/** A category that a user can put a purchase in: one with a button. */
export type Choice = Category & { label: string }
