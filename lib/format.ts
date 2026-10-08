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

export const slugify = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// Local wall-clock time in a tz -> UTC ISO (DST-correct).
export function localToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): string {
  const guess = Date.UTC(y, m, d, h, min)
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(guess)).map((x) => [x.type, +x.value]),
  )
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return new Date(guess - (asUtc - guess)).toISOString()
}

// <input type="datetime-local"> value ("YYYY-MM-DDTHH:mm", venue wall clock) -> UTC ISO, or null if malformed.
export function parseLocal(v: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v)
  if (!m || Number.isNaN(Date.parse(v + 'Z'))) return null
  return localToUtc(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], tz)
}

// UTC ISO -> datetime-local value on the wall clock of tz
export const toLocalInput = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)).replace(' ', 'T')

// HH:MM on the wall clock of tz
export const fmtTime = (iso: string, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
