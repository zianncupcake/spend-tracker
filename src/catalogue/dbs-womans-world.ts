import type { Product } from './types'

// The DBS Woman's World Card, from the bank's "Terms and Conditions Governing the DBS Woman's Card Promotions and
// Programmes", which are marked "Updated 27 Jul 2026", and from clause 2.3(f) of its rewards terms. Online spend earns
// 10 DBS Points for every S$5 on the first S$1,000 of a calendar month (clause 19). Other spend earns 1, or 3 in
// another currency, with no limit. The terms set no minimum spend.
//
// Three things are assumed. A purchase is taken for Online Spend until its user marks it otherwise: the bank goes by
// what the merchant's bank tells it (clause 13), which an alert does not say, and it is the limit that a user
// watches. Online spend in another currency counts towards the same S$1,000, so no category is for another
// currency. And the terms count by the calendar month, so a card of this product is to be added with `calendar`.

// The codes of Table 1, which clause 11 takes out of online spend, in its order. The first is 0763 in the terms.
const NOT_ONLINE_MCCS = [
  763, 4784, 4829, 4900, 5047, 5199, 5960, 5993, 6010, 6011, 6012, 6051, 6050, 6211, 6300, 6381, 6399, 6513, 6529,
  6530, 6534, 6540, 7261, 7276, 7311, 7322, 7339, 7349, 7372, 7375, 7393, 7399, 7511, 7523, 7995, 8062, 8111, 8211,
  8220, 8241, 8244, 8249, 8299, 8398, 8651, 8661, 8699, 8911, 8931, 8999, 9211, 9222, 9223, 9311, 9399, 9402, 9405,
]

// Those of the terms of Table 2 that a user in Singapore is likely to meet: clause 11 takes them out of online spend
// too. A purchase matches one when the text of its merchant holds it, in any case.
const NOT_ONLINE = [
  'AMAZE',
  // Three letters that other words hold, so it only counts as a word of its own.
  '\\bAXS\\b',
  'CARDUP',
  // EZLINK and EZ-LINK in the terms.
  'EZ[- ]?LINK',
  'FAVEPAY',
  'FLASHPAY',
  'IPAYMY',
  // SHOPEEPAY in the terms. An alert can have it with a space.
  'Shopee ?Pay',
  'SINGTEL DASH',
  'TRANSIT',
  'YOUTRIP',
]

export const dbsWomansWorld: Product = {
  key: 'dbs-womans-world',
  name: "DBS Woman's World Card",
  homeCurrency: 'SGD',
  termsAsOf: '27 July 2026',
  // Clause 19(c) counts online spend by its transaction date, which clause 14 has as the day that the merchant
  // settles it, and not by the day that it is posted.
  daysCountedInNext: 0,
  groups: [
    {
      name: 'Online Spend',
      // Clause 19(b): the bonus is on the first S$1,000 of online spend in a calendar month.
      limitMinor: 100000,
      categories: [{ key: 'online', label: 'Online Spend' }],
    },
    // No category takes the codes that Table 1 does not list: such a code does not say how a purchase was made, so
    // the purchase stays where it is.
    {
      name: 'Other Spend',
      categories: [
        { key: 'other', label: 'Other Spend', automatic: new RegExp(NOT_ONLINE.join('|'), 'i'), mccs: NOT_ONLINE_MCCS },
      ],
    },
  ],
  defaultCategory: 'online',
  sortingNote:
    'Online Spend is what is bought on the internet. A purchase made in a shop is Other Spend, and so are bills, ' +
    'top-ups, insurance, and school and hospital fees. A purchase at a merchant whose category code the bot knows ' +
    'starts where that code puts it.',
}
