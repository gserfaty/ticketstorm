export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function fmtDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso))
}
