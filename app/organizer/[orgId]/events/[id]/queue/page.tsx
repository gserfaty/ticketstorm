import Link from 'next/link'
import Flash from '../../../../../../components/Flash.tsx'
import { db } from '../../../../../../lib/db.ts'
import { fmtDateTimeTz } from '../../../../../../lib/format.ts'
import { loadEvent } from '../../../../guard.ts'
import { saveQueueAction } from '../../../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function QueueSettings({ params, searchParams }: { params: Promise<{ orgId: string; id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { orgId, id } = await params
  const { e } = await loadEvent(orgId, id)
  const q = db.prepare('SELECT queue_enabled, queue_rate, queue_cap FROM events WHERE id = ?').get(e.id) as { queue_enabled: number; queue_rate: number | null; queue_cap: number | null }
  const s = db
    .prepare('SELECT count(*) AS total, coalesce(sum(admitted_at IS NULL), 0) AS waiting, coalesce(sum(expires_at > ?), 0) AS shopping FROM queue_entries WHERE event_id = ?')
    .get(new Date().toISOString(), e.id) as { total: number; waiting: number; shopping: number }
  return (
    <>
      <h1>Waiting room: {e.title}</h1>
      <p><Link href={`/organizer/${orgId}/events/${e.id}`}>Back to event</Link></p>
      <Flash {...(await searchParams)} />
      <p className="muted">On sale {e.onsale_at ? fmtDateTimeTz(e.onsale_at, e.tz) : 'immediately'}. {s.total} joined · {s.waiting} waiting · {s.shopping} shopping now.</p>
      <form action={saveQueueAction} className="stack">
        <input type="hidden" name="eventId" value={e.id} />
        <input type="hidden" name="page" value="queue" />
        <label><input type="checkbox" name="enabled" defaultChecked={!!q.queue_enabled} /> Require the waiting room to buy</label>
        <label>Admit per minute <input name="rate" type="number" min="1" defaultValue={q.queue_rate ?? 60} /></label>
        <label>Shoppers inside at once (cap) <input name="cap" type="number" min="1" defaultValue={q.queue_cap ?? 200} /></label>
        <button>Save</button>
      </form>
    </>
  )
}
