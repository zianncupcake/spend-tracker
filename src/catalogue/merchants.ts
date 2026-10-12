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

// Made ready once, and not for every purchase: a card that is linked to a product can have 200 of them to sort.
const NAMES = MERCHANTS.map(([name, mcc]) => ({ name: wordsOf(name).join(''), mcc }))

/**
 * The category code of the merchant: that of the first name above that the text of the merchant holds. Only letters
 * and digits are compared, as an alert does not keep to a name's blanks: it has "fp*Food Panda" for foodpanda. A
 * name begins where a word of the text does, or "TOKO INDONESIA" would hold koi, and it may end inside a word.
 * Undefined for a merchant that none of them names.
 */
export function codeOf(merchant: string): number | undefined {
  const words = wordsOf(merchant)
  const tails = words.map((_, from) => words.slice(from).join(''))
  return NAMES.find(({ name }) => tails.some((tail) => tail.startsWith(name)))?.mcc
}
