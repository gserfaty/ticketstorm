import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '../../../lib/db.ts'
import { fmtDateTimeTz } from '../../../lib/format.ts'
import { getUser } from '../../../lib/session.ts'
import { viewTransfer } from '../../../lib/transfers.ts'
import { acceptTransferAction, cancelTransferAction, declineTransferAction } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function TransferPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string; error?: string; notice?: string }> }) {
  const id = Number((await params).id)
  const { token = '', error, notice } = await searchParams
  const user = await getUser()
  const t = Number.isInteger(id) ? viewTransfer(id, user?.id ?? null, token) : undefined
  if (!t) notFound()
  const k = db
    .prepare(
      `SELECT e.title, e.starts_at, v.name AS venue, v.tz, s.name AS section, st.row, st.number, u.name AS sender, u.email AS sender_email
       FROM tickets tk JOIN inventory i ON i.id = tk.inventory_id JOIN events e ON e.id = i.event_id JOIN venues v ON v.id = e.venue_id
       JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id JOIN users u ON u.id = ?
       WHERE tk.id = ?`,
    )
    .get(t!.from_user, t!.ticket_id) as { title: string; starts_at: string; venue: string; tz: string; section: string; row: string | null; number: number | null; sender: string; sender_email: string }
  const isSender = user?.id === t!.from_user
  const pending = t!.status === 'pending' && t!.expires_at > new Date().toISOString()
  const here = `/transfers/${id}?token=${encodeURIComponent(token)}`
  return (
    <>
      <h1>Ticket transfer</h1>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <div className="card">
        <strong>{k.title}</strong>
        <div className="muted">{k.venue} · {fmtDateTimeTz(k.starts_at, k.tz)}</div>
        <div>{k.row ? `Section ${k.section} Row ${k.row} Seat ${k.number}` : `General admission ${k.section}`}</div>
        <div className="muted">From {k.sender || k.sender_email} to {t!.to_email ?? t!.to_phone} · {pending ? 'pending' : t!.status === 'pending' ? 'expired' : t!.status}</div>
      </div>
      {isSender ? (
        pending && (
          <form action={cancelTransferAction}>
            <input type="hidden" name="transferId" value={id} />
            <input type="hidden" name="back" value={`/transfers/${id}`} />
            <button>Cancel transfer</button>
          </form>
        )
      ) : !user ? (
        <p>
          <Link href={`/login?next=${encodeURIComponent(here)}`}>Log in</Link> or <Link href={`/signup?next=${encodeURIComponent(here)}`}>sign up</Link> to claim this ticket.
        </p>
      ) : pending ? (
        <div className="row">
          <form action={acceptTransferAction}>
            <input type="hidden" name="transferId" value={id} />
            <input type="hidden" name="token" value={token} />
            <button>Accept ticket</button>
          </form>{' '}
          <form action={declineTransferAction}>
            <input type="hidden" name="transferId" value={id} />
            <input type="hidden" name="token" value={token} />
            <button>Decline</button>
          </form>
        </div>
      ) : (
        <p>This transfer is {t!.status === 'pending' ? 'expired' : t!.status}.</p>
      )}
    </>
  )
}
