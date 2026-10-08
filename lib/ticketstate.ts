// One label for a ticket's state, used by every page that shows a ticket. Statuses live in tickets.status; the rest is derived:
// an order under review puts tickets on hold, a valid ticket for a show that is over reads "expired" (nothing rewrites the row), a pending transfer is noted.
export function ticketState(status: string, orderStatus: string, startsAt: string, pendingTransfer = false, now = Date.now()): string {
  if (status === 'valid') {
    if (orderStatus === 'review') return 'on hold (order under review)'
    if (Date.parse(startsAt) + 12 * 3_600_000 < now) return 'expired (event over)'
    return pendingTransfer ? 'valid · transfer pending' : 'valid'
  }
  return ({ listed: 'listed for resale', resold: 'sold on resale', transferred: 'transferred away', used: 'used (scanned)', cancelled: 'cancelled', expired: 'expired' } as Record<string, string>)[status] ?? status
}
