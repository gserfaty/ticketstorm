import { notFound } from 'next/navigation'
import Scanner from '../../../components/Scanner.tsx'
import { db } from '../../../lib/db.ts'
import { SCAN_ROLES } from '../../../lib/organizer.ts'
import { attendance } from '../../../lib/scan.ts'
import { requireOrgRole } from '../../../lib/session.ts'

export const dynamic = 'force-dynamic'

export default async function Scan({ params }: { params: Promise<{ eventId: string }> }) {
  const id = Number((await params).eventId)
  const e = Number.isSafeInteger(id) ? (db.prepare('SELECT id, org_id, title FROM events WHERE id = ?').get(id) as { id: number; org_id: number; title: string } | undefined) : undefined
  if (!e) notFound()
  await requireOrgRole(e!.org_id, SCAN_ROLES)
  return (
    <>
      <h1>Scan: {e!.title}</h1>
      <Scanner eventId={e!.id} initial={{ ...attendance(e!.id) }} />
    </>
  )
}
