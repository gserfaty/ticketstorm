import { notFound, redirect } from 'next/navigation'
import { db } from '../../../lib/db.ts'
import { newCaptcha } from '../../../lib/defense.ts'
import { fmtDateTimeTz } from '../../../lib/format.ts'
import QueueRoom from '../../../components/QueueRoom.tsx'

export const dynamic = 'force-dynamic'

export default async function Queue({ params }: { params: Promise<{ eventId: string }> }) {
  const id = Number((await params).eventId)
  const e = Number.isSafeInteger(id)
    ? (db.prepare("SELECT e.id, e.slug, e.title, e.onsale_at, e.queue_enabled, v.tz FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.id = ? AND e.status != 'draft' AND e.approved = 1").get(id) as
        | { id: number; slug: string; title: string; onsale_at: string | null; queue_enabled: number; tz: string }
        | undefined)
    : undefined
  if (!e) notFound()
  if (!e!.queue_enabled) redirect(`/events/${e!.slug}`)
  return (
    <>
      <h1>Waiting room: {e!.title}</h1>
      {e!.onsale_at && <p className="muted">On sale {fmtDateTimeTz(e!.onsale_at, e!.tz)}. Joining early is fine: before the sale starts, places are drawn at random.</p>}
      <QueueRoom eventId={e!.id} slug={e!.slug} captcha={newCaptcha()} />
    </>
  )
}
