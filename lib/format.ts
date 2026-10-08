export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function fmtDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso))
}

export function fmtDateTimeTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(new Date(iso))
}

// YYYY-MM-DD of an instant on the wall clock of tz
export const localDate = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

// Escape LIKE wildcards; pair with ESCAPE '\' in SQL.
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&')

// Inclusive [from, to] local dates for the quick "when" filters, given today's local date (YYYY-MM-DD).
// Weekend = Fri-Sun: from today if today is Fri-Sun, else the coming Friday.
export function whenRange(when: 'today' | 'weekend' | 'month', today: string): [string, string] {
  const t = Date.parse(today + 'T00:00:00Z')
  const day = (offset: number) => new Date(t + offset * 86_400_000).toISOString().slice(0, 10)
  const dow = new Date(t).getUTCDay() // 0 Sun .. 6 Sat
  if (when === 'today') return [day(0), day(0)]
  if (when === 'month') return [day(0), day(30)]
  if (dow === 0) return [day(0), day(0)]
  if (dow >= 5) return [day(0), day(7 - dow)]
  return [day(5 - dow), day(7 - dow)]
}
