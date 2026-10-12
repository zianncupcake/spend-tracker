// The category codes (MCC) of merchants, by their names: the owner's own notes. A bank's alert names a merchant and
// never its code, and a card's bonus goes by the code. A name is spelt as an alert is expected to spell it.
const MERCHANTS: [name: string, mcc: number][] = [
  ['koi', 5814],
  ['chateraise', 5814],
  ['foodpanda', 5814],
  ['ji de chi', 5814],
  ['kuan chilli pan', 5814],
  ['dj bakery', 5814],
  ['koufu', 5814],
  ['big short', 5814],
  ['yole', 5814],
  ['ppp coffee', 5814],
  ['saladstop', 5814],
  ['a.c.a.i bowl', 5812],
  ['bakery cuisine', 5462],
  ['lavender', 5462],
  ['shopee', 5262],
  ['tiktok', 5399],
  ['uniqlo', 5651],
  ['fairprice', 5411],
  ['scarlett supermarket', 5411],
  ['7-eleven', 5499],
  ['grab', 4121],
  ['ticketmaster', 7922],
  ['shaw theatres', 7832],
  ['fs8', 7997],
  ['traveloka', 4722],
  ['trazy', 4722],
  ['airbnb', 4722],
  ['pelago', 4722],
]

/** The words of the text: its runs of letters and digits, in lower case. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** A name as it is looked for: its letters and digits alone, in lower case. Empty for a name that has neither. */
export function lettersOf(name: string): string {
  return wordsOf(name).join('')
}

// Made ready once, and not for every purchase: a card that is linked to a product can have 200 of them to sort.
const NAMES = MERCHANTS.map(([name, mcc]) => ({ name: lettersOf(name), mcc }))

/**
 * What tells whether the text of a merchant holds a name, which is given as `lettersOf` makes it. Only letters and
 * digits are compared, as an alert does not keep to a name's blanks: it has "fp*Food Panda" for foodpanda. A name
 * begins where a word of the text does, or "TOKO INDONESIA" would hold koi, and it may end inside a word.
 */
export function namedIn(merchant: string): (name: string) => boolean {
  // The words are joined once, and a name is tried only where one of them starts, which is at 40 places at the
  // most: a request has little CPU time, and a card's window can hold 200 purchases to look for 50 names in.
  const words = wordsOf(merchant)
  const joined = words.join('')
  const starts: number[] = []
  let at = 0
  for (const word of words) {
    starts.push(at)
    at += word.length
  }
  // Nothing holds an empty name, which would be at every one of those places.
  return (name) => name !== '' && starts.some((start) => joined.startsWith(name, start))
}

/**
 * The category code of the merchant: that of the first name above that the text of the merchant holds. Undefined
 * for a merchant that none of them names.
 */
export function codeOf(merchant: string): number | undefined {
  const holds = namedIn(merchant)
  return NAMES.find(({ name }) => holds(name))?.mcc
}
