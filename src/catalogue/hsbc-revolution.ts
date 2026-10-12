import type { Mcc, Product } from './types'

// The HSBC Revolution Credit Card, from the terms that the bank publishes for its reward points: the "Terms and
// Conditions governing the HSBC Revolution Credit Card Reward Points Programme", which are marked "Effective from 1
// April 2026". Everything is counted by the calendar month. An Eligible Transaction earns 1 Base Point and 9 Bonus
// Points for every SGD1 (clause 7.1), and the bank caps the Bonus Points at 9,000 a month (clause 7.2), which SGD
// 1,000 of spend earns. The Base Points are not capped. Every other Qualifying Transaction earns 1 Reward point for
// every SGD1 (clause 8). The terms set no minimum spend.
//
// The two groups are called what the terms call them, as nearly as a button allows. An Eligible Transaction is one
// of the "Selected Contactless Payments" (Visa payWave, Apple Pay, Google Pay, Samsung Pay) or of the "Selected
// Online Transactions", at a merchant whose category code is one of those that the terms list (clauses 5 to 7), under
// these headings: travel (airlines, car rental, lodging, cruise lines), department stores and retail stores, dining
// excluding hotel dining, and others such as transportation (taxicabs and limousines) and membership clubs.
//
// Three things are assumed:
//
// 1. The limit is that of a cardholder who does not keep SGD50,000 in an HSBC Everyday Global Account. One who does
//    earns 19 Bonus Points for every SGD1, and those are capped at 22,800 a month, which SGD 1,200 of spend earns.
//    The product has the one limit.
// 2. The terms count by the calendar month, so a card of this product is to be added with `calendar`. Nothing
//    checks that it was.
// 3. Whether a purchase is an Eligible Transaction goes by how it was made and by a category code of its merchant,
//    and an alert email says neither. So a purchase is taken for one until its user marks it otherwise: it is the
//    limit that a user watches, and to count too much against it is the safer mistake. Two things place a purchase
//    with nobody choosing: the rule for travel agencies below, and the code of a merchant that ./merchants knows.
//
// A purchase at a travel agency is no Eligible Transaction. The travel codes of the terms are those of airlines (3000
// to 3350, 4511), car rental (3351 to 3500), lodging (3501 to 3999, 7011) and cruise lines (4411), and the code of
// travel agencies and tour operators, 4722, is not among them. So a purchase at one of the agencies that are named
// below starts in Other Transactions, and its user can mark it as an Eligible Transaction with its button.
//
// The names are not the bank's. The bank goes by a merchant's category code, and names no merchant. That these
// merchants carry the code of a travel agency is what card blogs reported in March and April 2026: The MileLion and
// Mainly Miles. The code is the merchant's bank's to set, and can differ from one charge to another. A booking that
// an airline or a hotel charges itself is not covered by the rule, as it is under that airline's or hotel's name. And
// the HSBC Singapore app shows the code of a transaction once it is posted, which is how its user can check, and
// then move the purchase.

// A purchase is taken to be at a travel agency when the text of its merchant holds one of these names, in any case.
// Each of these is the source of a pattern.
const TRAVEL_AGENCIES = [
  'Trip\\.com',
  // Other names hold the four that begin with \b here: "pagoda" and "archipelago" do, and so does the site of a
  // hotel's own, as "examplehotels.com" would be. So each of the four only counts where it begins a word.
  '\\bAgoda',
  '\\bBooking\\.com',
  'Expedia',
  '\\bHotels\\.com',
  // "Kayaking" holds it, so it only counts as a word of its own.
  '\\bKayak\\b',
  'Klook',
  'KKday',
  '\\bPelago',
  'Traveloka',
  'Airbnb',
]

// The codes of clause 7, in the order of its 49 rows, with a new line at each of its four headings.
const ELIGIBLE_MCCS: Mcc[] = [
  [3000, 3350], 4511, [3351, 3500], [3501, 3999], 7011, 4411,
  4816, 5045, 5262, 5309, 5310, 5311, 5331, 5399, 5611, 5621, 5631, 5641, 5651, 5655, 5661, 5691, 5699, 5732, 5733,
  5734, 5735, 5912, 5942, 5944, 5945, 5946, 5947, 5948, 5949, 5964, 5965, 5966, 5967, 5968, 5969, 5970, 5992, 5999,
  5441, 5462, 5811, 5812, 5813,
  4121, 7997,
]

export const hsbcRevolution: Product = {
  key: 'hsbc-revolution',
  name: 'HSBC Revolution Credit Card',
  homeCurrency: 'SGD',
  // Where the bank publishes the terms that the limits are from:
  // https://www.hsbc.com.sg/content/dam/hsbc/sg/documents/credit-cards/revolution/offers/revolution-credit-card-reward-points-terms-and-conditions.pdf
  termsAsOf: '1 April 2026',
  // Clause 7.2 of the terms counts "the total amount of Eligible Transactions posted into HSBC's credit card system
  // within each qualifying calendar month", and a purchase is usually posted a day or two after it is made. So a
  // purchase of the last days of a month is counted in the next one. That it is two days is the owner's choice: how
  // long a posting takes was not measured.
  daysCountedInNext: 2,
  groups: [
    {
      name: 'Eligible Transactions',
      // 9,000 Bonus Points, at 9 for every SGD1.
      limitMinor: 100000,
      categories: [{ key: 'eligible', label: 'Eligible Transactions', mccs: ELIGIBLE_MCCS }],
    },
    // All other Qualifying Transactions, as the bank has it. A purchase is put here when its user marks it, and when
    // it is at one of the travel agencies above. The category has its button as well as its rule, so a purchase that
    // the rule placed has the one button, which marks it as an Eligible Transaction.
    {
      name: 'Other Transactions',
      categories: [
        {
          key: 'other',
          label: 'Other Transactions',
          automatic: new RegExp(TRAVEL_AGENCIES.join('|'), 'i'),
          mccs: 'unlisted',
        },
      ],
    },
  ],
  defaultCategory: 'eligible',
  sortingNote:
    'Eligible Transactions are online and contactless purchases in travel, department and retail stores, dining, ' +
    'taxis and membership clubs. Anything else is Other Transactions. A travel agency such as Trip.com, Agoda or ' +
    'Klook is not travel to the bank, so a purchase there starts in Other Transactions. A purchase at a merchant ' +
    'whose category code the bot knows starts where that code puts it.',
}
