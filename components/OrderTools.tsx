import { fmtDateTime, money } from '../lib/format.ts'
import { orderLines } from '../lib/orderadmin.ts'
import type { OrderRow } from '../lib/orderadmin.ts'

type Act = (f: FormData) => Promise<void>

// One order with every staff tool. Shared by the organizer's event orders page and the admin orders page; each passes its own server
// actions, and each action re-checks the actor against the order's real org (or admin) on the server.
export default function OrderTools({ o, tz, refund, resend, hold, release, move }: { o: OrderRow; tz: string; refund: Act; resend: Act; hold: Act; release: Act; move?: Act }) {
  const lines = orderLines(o.id)
  const open = ['paid', 'review', 'partially_refunded'].includes(o.status) || (o.status === 'cancelled' && o.paid > o.refunded)
  const id = <input type="hidden" name="orderId" value={o.id} />
  return (
    <div className="card">
      <strong>Order #{o.id}</strong> <span className="badge">{o.status.replace('_', ' ')}</span>{o.source && <span className="badge">{o.source}</span>} · {o.name || o.email} &lt;{o.email}&gt; · {money(o.total)} (paid {money(o.paid)}, refunded {money(o.refunded)}) · {fmtDateTime(o.created_at, tz)}
      {o.review_reason && <div className="muted">Held: {o.review_reason}</div>}
      <ul>
        {lines.map((l) => <li key={l.item_id}>{l.label} · {money(l.value)} · {l.status ?? 'no ticket'}{l.refunded_cents > 0 && ' · refunded'}</li>)}
      </ul>
      <div className="row">
        <form action={resend}>{id}<button>Resend tickets</button></form>
        {o.status === 'paid' && <form action={hold}>{id}<button>Fraud hold</button></form>}
        {o.status === 'review' && <form action={release}>{id}<button>Release hold</button></form>}
      </div>
      {open && (
        <form action={refund} className="stack">
          {id}
          <select name="mode" aria-label="Refund type">
            <option value="full">Cancel and refund everything left</option>
            <option value="items">Refund ticked items only</option>
            <option value="void">Void: cancel with no refund</option>
          </select>
          {lines.filter((l) => !l.refunded_cents && (l.status === 'valid' || l.status === 'listed')).map((l) => (
            <label key={l.item_id}><input type="checkbox" name="item" value={l.item_id} /> {l.label} ({money(l.value)})</label>
          ))}
          <label><input type="checkbox" name="fees" defaultChecked /> Include fees and tax of ticked items</label>
          <button>Refund</button>
        </form>
      )}
      {move && lines.some((l) => l.status === 'valid') && (
        <form action={move} className="row">
          {id}
          <select name="itemId" aria-label="Ticket to move">
            {lines.filter((l) => l.status === 'valid' && l.kind === 'ticket').map((l) => <option key={l.item_id} value={l.item_id}>{l.label}</option>)}
          </select>
          <input name="section" placeholder="New section" required size={8} />
          <input name="row" placeholder="Row (blank = GA)" size={8} />
          <input name="number" type="number" min={1} placeholder="Seat" />
          <button>Move seat</button>
        </form>
      )}
    </div>
  )
}
