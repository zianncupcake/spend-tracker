import type { Product } from './types'

// The OCBC Rewards Card, from the terms that the bank publishes for it: the "Terms and Conditions Governing OCBC
// Rewards Card Programme", which are marked "Updated as of 5 October 2026". Everything is counted by the calendar
// month. All retail spend earns 5 OCBC$ for every S$5, the Base OCBC$, and spend in the "shopping spend categories"
// earns a bonus of 45 OCBC$ for every S$5 besides, the Bonus OCBC$ (clause 1(a)). The bank credits no more than
// 10,000 Bonus OCBC$ in a calendar month, and after that such spend earns the Base OCBC$ only. At 45 for every S$5
// that is 222 blocks of S$5 and a part of one more, so the limit is SGD 1,110 of spend. The terms set no minimum
// spend.
//
// The first group is called after the terms' "shopping spend categories", and the second is all other spend. The
// bonus is for retail transactions at a merchant whose category code is one of those that clause 2(b) lists: 5309
// duty free stores, 5311 departmental stores, 5611, 5621, 5631, 5641, 5651, 5655, 5661, 5691 and 5699, which are
// clothing, accessories, sports apparel and shoes, 5941 sporting goods stores and 5948 luggage or leather goods
// stores. And clause 2(c) names merchants "which will earn Bonus OCBC$ on any purchases made with these merchants":
// Alibaba, AliExpress, Amazon, Ezbuy, Guardian, Lazada, Mustafa Centre, NTUC Unity, Shopee, Taobao, TikTok Shop and
// Watsons. Two footnotes take something of that back: "Transactions with the description 'Shopee Pay' under MCC
// 5262 are not eligible to earn any OCBC$", and "Transactions under MCC 5411 (Grocery stores, Supermarkets) are not
// eligible to earn any Bonus OCBC$".
//
// Four things are assumed:
//
// 1. A purchase is taken for Shopping Spend until its user marks it otherwise, as on the other products. Whether
//    one earns the bonus goes by a category code of its merchant, which an alert does not say, and it is the limit
//    that a user watches. Where ./merchants knows the code, the purchase goes by it: but one at a merchant that
//    clause 2(c) names is put in Shopping Spend by that name first. So is one there under the code 5411, which the
//    terms deny the bonus.
// 2. The terms count by the calendar month, so a card of this product is to be added with `calendar`. Nothing
//    checks that it was.
// 3. The bank counts each purchase in blocks of S$5 and drops the rest, and counts nothing of one under S$5: by
//    clause 1(c), "Amounts charged in multiple transactions will not be combined to make up a S$5 block." The whole
//    amount of a purchase is held against the limit here, so what is Left is a little less than what the bank has
//    left.
// 4. The bank's 15X campaign is not tracked. By the "Terms and Conditions Governing the OCBC Rewards Card 15X OCBC$
//    Campaign", from 1 July 2026 to 31 March 2027 spend at Watsons, Shopee, Lazada, TikTok Shop and Taobao earns 5
//    more OCBC$ for every S$1, up to 5,000 OCBC$ a calendar month, on top of the bonus above. That is a second limit,
//    on spend at five of the merchants that is in Shopping Spend too, and a group has the one limit. Clause 1(b) of
//    the programme's terms lets the bank count what another campaign earns towards the 10,000, as it sees fit: the
//    limit here is of the programme's bonus alone.

// A purchase is taken to earn nothing when the text of its merchant holds this, in any case, with its space or
// without: it is the description that the terms name. It is the source of a pattern, as the names in the other
// products are.
const NOT_ELIGIBLE = ['Shopee ?Pay']

// The codes of clause 2(b).
const SHOPPING_MCCS = [5309, 5311, 5611, 5621, 5631, 5641, 5651, 5655, 5661, 5691, 5699, 5941, 5948]

// The merchants of clause 2(c), as the terms name them. A purchase is taken to be at one when the text of its
// merchant holds the name, in any case.
const SHOPPING_MERCHANTS = [
  'Alibaba',
  'AliExpress',
  'Amazon',
  'Ezbuy',
  'Guardian',
  'Lazada',
  'Mustafa Centre',
  // NTUC Unity, which the bank's FAQ calls Unity by FairPrice. Other words hold it, so it only counts as a word of
  // its own.
  '\\bUnity\\b',
  'Shopee',
  'Taobao',
  // TikTok Shop, which an alert can write with a mark between its two words.
  'TikTok',
  'Watsons',
]

export const ocbcRewards: Product = {
  key: 'ocbc-rewards',
  bank: 'ocbc',
  name: 'OCBC Rewards Card',
  homeCurrency: 'SGD',
  // Where the bank publishes the terms that the limits are from:
  // https://www.ocbc.com/iwov-resources/sg/ocbc/personal/pdf/cards/tnc-ocbc-rewards-card-and-titanium-rewards-creditcard-programme-wef-1nov23.pdf
  termsAsOf: '5 October 2026',
  // Clause 3(c) of the terms says that "Spend will be computed based on transaction posted date", and a purchase is
  // usually posted a day or two after it is made. So a purchase of the last days of a month is counted in the next
  // one. That it is two days is the owner's choice: how long a posting takes was not measured.
  daysCountedInNext: 2,
  groups: [
    {
      name: 'Shopping Spend',
      // 10,000 Bonus OCBC$, at 45 for every S$5: 222 blocks of S$5, and a part of one more.
      limitMinor: 111000,
      categories: [
        {
          key: 'shopping',
          label: 'Shopping Spend',
          // No text that names Shopee Pay, whatever else it names: this pattern is tried before that of `other`.
          automatic: new RegExp(`^(?!.*(?:${NOT_ELIGIBLE.join('|')})).*(?:${SHOPPING_MERCHANTS.join('|')})`, 'i'),
          mccs: SHOPPING_MCCS,
        },
      ],
    },
    // All other spend, as the bank has it. A purchase is put here when its user marks it, and when it has the
    // description that the terms name as earning nothing. The category has its button as well as its rule, so a
    // purchase that the rule placed has the one button, which marks it as Shopping Spend.
    {
      name: 'Other Spend',
      categories: [
        { key: 'other', label: 'Other Spend', automatic: new RegExp(NOT_ELIGIBLE.join('|'), 'i'), mccs: 'unlisted' },
      ],
    },
  ],
  defaultCategory: 'shopping',
  sortingNote:
    'Shopping Spend is spend at department, clothing, shoe, bag, sports and duty-free shops, and at Shopee, ' +
    'Lazada, Taobao, TikTok Shop, Amazon, AliExpress, Alibaba, Ezbuy, Watsons, Guardian, Mustafa Centre and NTUC ' +
    'Unity. Anything else is Other Spend, and so are groceries and Shopee Pay. A purchase at a merchant whose ' +
    'category code the bot knows starts where that code puts it.',
}
