// DISPLAY-ONLY currency. A fixed table of made-up, rounded rates (units of currency per 1 USD). Checkout always charges USD, and every
// converted amount is labelled approximate. Nothing here touches stored prices.
export const RATES: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.36, AUD: 1.52, MXN: 17.2, JPY: 151 }
export const CURRENCIES = Object.keys(RATES)
export const LOCAL_CURRENCY: Record<string, string> = { CA: 'CAD', MX: 'MXN', GB: 'GBP', AU: 'AUD', JP: 'JPY' }

export const validCurrency = (c?: string | null) => (c && Object.hasOwn(RATES, c) ? c : 'USD')

export function convert(cents: number, cur: string): number {
  return Math.round((cents / 100) * RATES[validCurrency(cur)] * 100) / 100
}

// "≈ CA$13.60" for CAD; '' for USD (nothing to add).
export function approx(cents: number, cur: string): string {
  const c = validCurrency(cur)
  if (c === 'USD') return ''
  return `≈ ${new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol' }).format(convert(cents, c))}`
}

// The currency to show next to USD amounts: the viewer's choice, else the event country's currency (international events), else none.
export const displayCurrency = (pref: string | undefined, country: string) => (validCurrency(pref) !== 'USD' ? validCurrency(pref) : (LOCAL_CURRENCY[country] ?? 'USD'))
