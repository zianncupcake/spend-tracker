import type { Product } from './types'

// The UOB EVOL Card, from the FAQ that the bank publishes for it. Everything is counted by the statement month. The
// terms cap the cashback of a group and not its spend, so the limit of a group with one is the spend whose 10% is
// that cap.
//
// The groups, and the categories that have a button, are called what the FAQ calls them.
//
// Online spend and a phone's tap in a shop share the one limit, so they are one category. It is the one that a
// purchase is in unless something says otherwise: that it was made in another currency, that it was made at one of
// the merchants named below, or that its user has marked it as other spend.

// The merchants that the FAQ names, as it writes them. A purchase is taken to be at one when the text of its merchant
// holds the name, in any case.
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
  'M1',
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
  bank: 'uob',
  name: 'UOB EVOL Card',
  homeCurrency: 'SGD',
  // Where the bank publishes the terms that the limits and rates are from:
  // https://www.uob.com.sg/web-resources/personal/pdf/personal/cards/credit-cards/rebates-cards/evol/uob-evol-faq.pdf
  termsAsOf: '15 October 2026',
  minimumSpendMinor: 80000,
  earnsBelowMinimum: '0.3% cashback on local spend. Overseas Foreign Currency Spend still earns its rate.',
  cashbackCapMinor: 8000,
  // UOB's terms count spend that is "successfully charged and posted to the Card account in each Statement Month",
  // and a purchase is usually posted a day or two after it is made. So a purchase of the last days of a statement
  // month is counted in the next one. That it is two days is the owner's choice: how long a posting takes was not
  // measured.
  daysCountedInNext: 2,
  groups: [
    {
      name: 'Online and Mobile Contactless Spend',
      limitMinor: 30000,
      earns: '10% cashback, at most S$30 a statement month',
      // Websites, purchases made in an app, and Apple Pay, Google Pay or Samsung Pay in a shop.
      categories: [{ key: 'online', label: 'Online / Mobile Contactless Spend' }],
    },
    {
      name: 'Selected Gym, Telco and Streaming Spend',
      limitMinor: 20000,
      earns: '10% cashback, at most S$20 a statement month',
      categories: [
        {
          key: 'selected',
          label: 'Selected Gym, Telco and Streaming Spend',
          named: SELECTED_MERCHANTS,
          automatic: new RegExp(
            SELECTED_MERCHANTS.map((name) =>
              // Two characters that many other words hold, so it only counts as a word of its own.
              name === 'M1' ? '\\bM1\\b' : name,
            ).join('|'),
            'i',
          ),
        },
      ],
    },
    // All other local spend, as the bank has it, which is where a purchase made with the card itself, tapped or
    // inserted, belongs. A purchase is put here only when its user marks it.
    {
      name: 'Other Spend',
      earns: '0.3% cashback, at most S$30 a statement month',
      categories: [{ key: 'other', label: 'Other Spend' }],
    },
    {
      name: 'Overseas Foreign Currency Spend',
      earns:
        '1% cashback, but 0.5% in China or Europe, and in Australia from 1 January 2027. No minimum spend, no cap, ' +
        'and outside the S$80 cap on local cashback. These rates run to 31 December 2027.',
      categories: [{ key: 'fx', label: 'Overseas Foreign Currency Spend', automatic: 'foreign-currency' }],
    },
  ],
  defaultCategory: 'online',
  sortingNote: 'Other Spend is where a purchase made with the physical card goes.',
}
