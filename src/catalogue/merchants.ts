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

/** The text in lower case, with a blank for every run of what is not a letter or a digit, and one at each end. */
function spaced(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
}

// Made ready once, and not for every purchase: a card that is linked to a product can have 200 of them to sort.
const NAMES = MERCHANTS.map(([name, mcc]) => ({ name: spaced(name), mcc }))

/**
 * The category code of the merchant: that of the first name above that the text of the merchant holds as whole
 * words. Undefined for a merchant that none of them names.
 */
export function codeOf(merchant: string): number | undefined {
  const text = spaced(merchant)
  return NAMES.find(({ name }) => text.includes(name))?.mcc
}
