import { expect, it } from 'vitest'
import {
  describeTotals,
  describeWindow,
  formatAmount,
  formatMoney,
  formatShortDate,
  formatShortDateTime,
  maskLast4,
  shortDateIn,
} from '../src/telegram/format'

it('formats money from hundredths', () => {
  expect(formatMoney(123456, 'SGD')).toBe('SGD 1,234.56')
  expect(formatMoney(1240, 'SGD')).toBe('SGD 12.40')
  expect(formatMoney(5, 'USD')).toBe('USD 0.05')
  expect(formatMoney(0, 'USD')).toBe('USD 0.00')
  expect(formatMoney(99999999999999, 'SGD')).toBe('SGD 999,999,999,999.99')
  expect(formatMoney(-1240, 'SGD')).toBe('SGD -12.40')
})

it('formats an amount from hundredths as the number that money has, with no currency', () => {
  expect(formatAmount(123456)).toBe('1,234.56')
  expect(formatAmount(1240)).toBe('12.40')
  expect(formatAmount(5)).toBe('0.05')
  expect(formatAmount(0)).toBe('0.00')
  expect(formatAmount(99999999999999)).toBe('999,999,999,999.99')
  expect(formatAmount(-1240)).toBe('-12.40')
})

it('formats a short date as seen in the time zone', () => {
  const instant = new Date('2026-10-15T16:00:00Z') // midnight starting 16 October in Singapore

  expect(formatShortDate(instant, 'Asia/Singapore')).toBe('16 Oct')
  expect(formatShortDate(instant, 'America/New_York')).toBe('15 Oct')
})

it('formats many short dates in one time zone as it formats each of them alone', () => {
  const instant = new Date('2026-10-15T16:00:00Z')
  const inSingapore = shortDateIn('Asia/Singapore')

  expect(inSingapore(instant)).toBe('16 Oct')
  expect(shortDateIn('America/New_York')(instant)).toBe('15 Oct')
  // Through a year and a bit, at every time of day.
  for (let hours = 0; hours < 400 * 24; hours += 31) {
    const date = new Date(instant.getTime() + hours * 3_600_000)
    expect(inSingapore(date)).toBe(formatShortDate(date, 'Asia/Singapore'))
  }
})

it('formats a short date and time as seen in the time zone, on a 24-hour clock', () => {
  const instant = new Date('2026-10-15T16:05:00Z') // five past midnight on 16 October in Singapore

  expect(formatShortDateTime(instant, 'Asia/Singapore')).toBe('16 Oct, 00:05')
  expect(formatShortDateTime(instant, 'America/New_York')).toBe('15 Oct, 12:05')
  expect(formatShortDateTime(new Date('2026-10-15T09:30:00Z'), 'Asia/Singapore')).toBe('15 Oct, 17:30')
})

it('describes a card', () => {
  expect(describeWindow({ windowType: 'calendar' })).toBe('calendar month')
  expect(describeWindow({ windowType: 'statement', statementDay: 15 })).toBe(
    'statement closes on the 15th of the month',
  )
  expect(maskLast4('1234')).toBe('••••1234')
})

it('describes every statement day with its English ordinal ending', () => {
  const endings = {
    st: [1, 21, 31],
    nd: [2, 22],
    rd: [3, 23],
    th: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 24, 25, 26, 27, 28, 29, 30],
  }

  for (const [ending, days] of Object.entries(endings)) {
    for (const statementDay of days) {
      expect(describeWindow({ windowType: 'statement', statementDay })).toBe(
        `statement closes on the ${statementDay}${ending} of the month`,
      )
    }
  }
})

it("describes what a card's window holds, and when it starts again", () => {
  const card = { nickname: 'visa', last4: '1234', windowType: 'statement', statementDay: 15 } as const
  const window = { start: new Date('2026-09-15T16:00:00Z'), end: new Date('2026-10-15T16:00:00Z') }
  const sgd = { currency: 'SGD', amountMinor: 124696 }
  const usd = { currency: 'USD', amountMinor: 500 }

  expect(describeTotals({ card, window, totals: [sgd, usd], count: 3 }, 'Asia/Singapore')).toBe(
    'SGD 1,246.96 + USD 5.00 in 3 purchases, resets 16 Oct',
  )
  expect(describeTotals({ card, window, totals: [usd], count: 1 }, 'Asia/Singapore')).toBe(
    'USD 5.00 in 1 purchase, resets 16 Oct',
  )
  expect(describeTotals({ card, window, totals: [], count: 0 }, 'America/New_York')).toBe(
    'no purchases, resets 15 Oct',
  )
})
