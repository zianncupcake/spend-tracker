import type { Product } from './types'

// The UOB EVOL Card, from the FAQ that the bank publishes for it. Everything is counted by the statement month. The
// two groups with a limit earn 10% cashback, and the bank caps the cashback of each: at S$30 for online and mobile
// contactless spend, which S$300 of spend earns, and at S$20 for the gyms, telcos and streaming services it names,
// which S$200 earns. Neither earns the 10% in a statement month with less than S$800 of spend.
//
// The groups, and the categories that have a button, are called what the FAQ calls them.
//
// Online spend and a phone's tap in a shop share the one limit, so they are one category. It is the one that a
// purchase is in unless something says otherwise: that it was made in another currency, that it was made at one of
// the merchants named below, or that its user has marked it as other spend.

// A purchase is taken to be at one of the merchants that the FAQ names when the text of its merchant holds the name,
// in any case. Each of these is the source of a pattern.
const SELECTED_MERCHANTS = [
  'Anytime Fitness',
  'Classpass',
  'Virgin Active',
  'Fitness First',
  'Body Fit Training',
  'True Fitness',
  '247 Fitness',
  'Pure Yoga',
  'True Yoga',
  'Revolution SG',
  'Starhub',
  'Singtel',
  // Two characters that many other words hold, so it only counts as a word of its own.
  '\\bM1\\b',
  'Gomo',
  'MyRepublic',
  'Giga',
  'CirclesLife',
  'Netflix',
  'Spotify',
  'Disney plus',
]

export const uobEvol: Product = {
  key: 'uob-evol',
  name: 'UOB EVOL Card',
  homeCurrency: 'SGD',
  termsUrl:
    'https://www.uob.com.sg/web-resources/personal/pdf/personal/cards/credit-cards/rebates-cards/evol/uob-evol-faq.pdf',
  termsAsOf: '10 June 2026',
  minimumSpendMinor: 80000,
  groups: [
    {
      name: 'Online and Mobile Contactless Spend',
      limitMinor: 30000,
      // Websites, purchases made in an app, and Apple Pay, Google Pay or Samsung Pay in a shop.
      categories: [{ key: 'online', label: 'Online / Mobile Contactless Spend' }],
    },
    {
      name: 'Selected Gym, Telco and Streaming Spend',
      limitMinor: 20000,
      categories: [{ key: 'selected', automatic: new RegExp(SELECTED_MERCHANTS.join('|'), 'i') }],
    },
    // All other local spend, as the bank has it, which is where a purchase made with the card itself, tapped or
    // inserted, belongs. A purchase is put here only when its user marks it.
    { name: 'Other Spend', categories: [{ key: 'other', label: 'Other Spend' }] },
    { name: 'Overseas Foreign Currency Spend', categories: [{ key: 'fx', automatic: 'foreign-currency' }] },
  ],
  defaultCategory: 'online',
  sortingNote: 'Other Spend is where a purchase made with the physical card goes.',
}
