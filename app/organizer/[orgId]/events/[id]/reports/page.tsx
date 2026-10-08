import Link from 'next/link'
import { fmtDateTimeTz, money } from '../../../../../../lib/format.ts'
import { REPORT_ROLES } from '../../../../../../lib/organizer.ts'
import { funnel } from '../../../../../../lib/analytics.ts'
import { eventReport } from '../../../../../../lib/reports.ts'
import { loadEvent } from '../../../../guard.ts'

export const dynamic = 'force-dynamic'

// Inline SVG horizontal bars: label, bar scaled to the largest value, value.
function Bars({ rows, title }: { rows: { label: string; value: number; text: string }[]; title: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <svg role="img" aria-label={title} viewBox={`0 0 560 ${rows.length * 26 + 4}`} width="100%" style={{ maxWidth: 560 }}>
      {rows.map((r, i) => (
        <g key={r.label} transform={`translate(0 ${i * 26 + 2})`}>
          <text x="0" y="15" fontSize="12" fill="currentColor">{r.label.slice(0, 18)}</text>
          <rect x="130" y="2" width={Math.max((r.value / max) * 300, 1)} height="18" rx="3" fill="#6366f1" />
          <text x={130 + Math.max((r.value / max) * 300, 1) + 6} y="15" fontSize="12" fill="currentColor">{r.text}</text>
        </g>
      ))}
    </svg>
  )
}

export default async function Reports({ params }: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id, REPORT_ROLES)
  const r = eventReport(e.id, e.tz)
  const base = `/organizer/${orgId}/events/${e.id}`
  const f = funnel(e.id)
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a')
  return (
    <>
      <h1>Reports: {e.title}</h1>
      <p className="muted">{e.venue} · {fmtDateTimeTz(e.starts_at, e.tz)} · <Link href={base}>Back to event</Link> · <a href={`${base}/reports/csv`}>Download CSV</a> · <Link href={`${base}/marketing`}>Marketing</Link></p>
      <table>
        <tbody>
          <tr><td>Orders</td><td>{r.orders}</td></tr>
          <tr><td>Gross (everything charged)</td><td>{money(r.gross)}</td></tr>
          <tr><td>Refunds</td><td>{money(r.refunds)}</td></tr>
          <tr><td>Fees (platform, live orders)</td><td>{money(r.fees)}</td></tr>
          <tr><td>Tax (live orders)</td><td>{money(r.tax)}</td></tr>
          <tr><td>Ticket protection premiums</td><td>{money(r.protection)}</td></tr>
          <tr><td><strong>Net to organizer</strong></td><td><strong>{money(r.net)}</strong></td></tr>
          <tr><td>Attendance</td><td>{r.attendance.scanned} scanned / {r.attendance.total} tickets</td></tr>
        </tbody>
      </table>
      <p className="muted">Resale between fans is not part of these figures. Net = face value after promos, minus refunds paid on live orders.</p>
      <h2>Funnel</h2>
      <p className="muted">Counts only, nothing about who: event page views, seat holds started, orders placed.</p>
      <Bars title="Funnel from event page views to orders" rows={[{ label: 'Event views', value: f.view, text: String(f.view) }, { label: 'Holds', value: f.hold, text: `${f.hold} (${pct(f.hold, f.view)} of views)` }, { label: 'Orders', value: f.order, text: `${f.order} (${pct(f.order, f.hold)} of holds)` }]} />
      <h2>Sold by price level</h2>
      {r.byLevel.length ? <Bars title="Tickets sold by price level" rows={r.byLevel.map((l) => ({ label: l.level, value: l.sold, text: `${l.sold} · ${money(l.revenue)}` }))} /> : <p>No sales yet.</p>}
      <h2>Sold by day</h2>
      {r.byDay.length ? <Bars title="Tickets sold by day" rows={r.byDay.map((d) => ({ label: d.day, value: d.sold, text: `${d.sold} · ${money(d.revenue)}` }))} /> : <p>No sales yet.</p>}
    </>
  )
}
