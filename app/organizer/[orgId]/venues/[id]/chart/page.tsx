import Link from 'next/link'
import { notFound } from 'next/navigation'
import Flash from '../../../../../../components/Flash.tsx'
import { db } from '../../../../../../lib/db.ts'
import { exportChart, MANAGE_ROLES, VENUE_KINDS } from '../../../../../../lib/organizer.ts'
import { requireOrgRole } from '../../../../../../lib/session.ts'
import { flagSeats, importChart, regenerateChart } from '../../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Chart({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const v = db.prepare('SELECT id, org_id, name FROM venues WHERE id = ?').get(Number(id)) as { id: number; org_id: number; name: string } | undefined
  if (!v || v.org_id !== Number(orgId)) notFound()
  await requireOrgRole(v!.org_id, MANAGE_ROLES)
  const secs = exportChart(v!.id)
  const sections = db.prepare('SELECT id, name FROM sections WHERE venue_id = ? AND kind = ? ORDER BY rank, id').all(v!.id, 'reserved') as { id: number; name: string }[]
  const hidden = <input type="hidden" name="venueId" value={v!.id} />
  return (
    <>
      <h1>Seating chart: {v!.name}</h1>
      <p><Link href={`/organizer/${orgId}`}>Back</Link></p>
      <Flash {...(await searchParams)} />
      <svg viewBox="0 0 1000 800" role="img" aria-label="Seating chart preview" style={{ width: '100%', background: '#0b0c1a', borderRadius: 8 }}>
        {secs.map((s) => <path key={s.name} d={s.path} fill="#1a1b33" stroke="#445" />)}
        {secs.flatMap((s) => s.seats.map((t) => <circle key={`${s.name}${t.row}${t.number}`} cx={t.x} cy={t.y} r={3} fill={t.accessible ? '#14b8a6' : t.companion ? '#a855f7' : t.obstructed ? '#f87171' : '#6b7280'} />))}
        {secs.map((s) => <text key={s.name} x={s.label_x} y={s.label_y} fill="#fff" fontSize="16" textAnchor="middle">{s.name}</text>)}
      </svg>
      <p className="muted">Teal = accessible, purple = companion, red = obstructed view.</p>
      <h2>Generate</h2>
      <form action={regenerateChart} className="filters">{hidden}<select name="kind" aria-label="Layout">{VENUE_KINDS.map((k) => <option key={k}>{k}</option>)}</select><button>Replace chart with this layout</button></form>
      <h2>Seat flags</h2>
      <form action={flagSeats} className="filters">
        {hidden}
        <select name="sectionId" aria-label="Section">{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input name="row" placeholder="Row" required size={4} />
        <input name="from" type="number" min="1" placeholder="From seat" required />
        <input name="to" type="number" min="1" placeholder="To seat" required />
        <select name="flag" aria-label="Flag"><option>accessible</option><option>companion</option><option>obstructed</option></select>
        <select name="on" aria-label="Value"><option value="1">on</option><option value="0">off</option></select>
        <button>Apply</button>
      </form>
      <h2>Import / export JSON</h2>
      <form action={importChart} className="stack" style={{ maxWidth: '100%' }}>
        {hidden}
        <textarea name="json" rows={10} defaultValue={JSON.stringify(secs)} aria-label="Chart JSON" />
        <button>Import (replaces the chart)</button>
      </form>
    </>
  )
}
