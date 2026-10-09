import type { Product } from './types'

// The UOB EVOL Card, from the FAQ that the bank publishes for it. Everything is counted by the statement month. The
// two groups with a limit earn 10% cashback, and the bank caps the cashback of each: at S$30 for online and mobile
// contactless spend, which S$300 of spend earns, and at S$20 for the gyms, telcos and streaming services it names,
// which S$200 earns. Neither earns the 10% in a statement month with less than S$800 of spend.

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
      name: 'Online and mobile contactless',
      limitMinor: 30000,
      categories: [
        // Websites and purchases made in an app.
        { key: 'online', label: 'Online' },
        // Apple Pay, Google Pay or Samsung Pay in a shop. Tapping the card itself is not this.
        { key: 'mobile', label: 'Phone tap' },
      ],
    },
    {
      name: 'Gym, telco and streaming',
      limitMinor: 20000,
      categories: [{ key: 'selected', automatic: new RegExp(SELECTED_MERCHANTS.join('|'), 'i') }],
    },
    { name: 'Other local spend', categories: [{ key: 'other', label: 'Physical card or other' }] },
    { name: 'Foreign currency', categories: [{ key: 'fx', automatic: 'foreign-currency' }] },
  ],
  excluded: { key: 'excluded', label: "Doesn't count" },
}
