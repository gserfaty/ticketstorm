// iCalendar (RFC 5545) for one event. Pure: no DB, no clock except the `now` argument.
// Text values escape \ ; , and newlines (section 3.3.11); lines fold at 75 octets with CRLF + space (3.1).
export const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')

// 20261008T200000Z
export const icsDate = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

export function fold(line: string): string {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > (out.length ? 74 : 75)) { // continuation lines start with a space that counts too
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}

export const DEFAULT_MINUTES = 180 // events have no end time; calendars get a 3 hour block

export type IcsEvent = { id: number; title: string; starts_at: string; status: string; description: string | null; venue: string; address: string; city: string; state: string }

export function buildIcs(e: IcsEvent, url: string, now = new Date()): string {
  const end = new Date(Date.parse(e.starts_at) + DEFAULT_MINUTES * 60_000).toISOString()
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TicketStorm//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${e.id}@ticketstorm`,
    `DTSTAMP:${icsDate(now.toISOString())}`,
    `DTSTART:${icsDate(e.starts_at)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(e.title)}`,
    `LOCATION:${icsEscape(`${e.venue}, ${e.address}, ${e.city}, ${e.state}`)}`,
    ...(e.description ? [`DESCRIPTION:${icsEscape(e.description)}`] : []),
    `URL:${url}`,
    `STATUS:${e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}
