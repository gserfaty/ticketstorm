import Link from 'next/link'
import { db } from '../../lib/db.ts'
import { requireUser } from '../../lib/session.ts'
import { markAllRead, markRead } from './actions.ts'

export const dynamic = 'force-dynamic'

type Row = { id: number; created_at: string; kind: string; title: string; body: string | null; link: string | null; read_at: string | null }

export default async function Inbox() {
  const user = await requireUser()
  const rows = db.prepare('SELECT id, created_at, kind, title, body, link, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id) as Row[]
  const unread = rows.filter((r) => !r.read_at).length
  return (
    <>
      <h1>Inbox</h1>
      <p className="muted">{unread} unread · <Link href="/account/notifications">Notification settings</Link></p>
      {unread > 0 && <form action={markAllRead}><button>Mark all read</button></form>}
      {rows.map((r) => (
        <div className={`card ${r.read_at ? '' : 'unread'}`} key={r.id}>
          <div className="muted">{r.created_at.slice(0, 16).replace('T', ' ')} UTC · {r.kind.replace('_', ' ')}</div>
          <div>{r.link ? <Link href={r.link}>{r.title}</Link> : r.title}</div>
          {r.body && <div className="muted">{r.body}</div>}
          {!r.read_at && <form action={markRead}><input type="hidden" name="id" value={r.id} /><button>Mark read</button></form>}
        </div>
      ))}
      {rows.length === 0 && <p>No notifications yet.</p>}
    </>
  )
}
