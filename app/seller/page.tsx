import Flash from '../../components/Flash.tsx'
import Link from 'next/link'
import { fmtDateTime, money } from '../../lib/format.ts'
import { sellerView } from '../../lib/offers.ts'
import { requireUser } from '../../lib/session.ts'
import { cancelListingAction } from '../resale/actions.ts'
import { acceptOfferAction, checkoutOfferAction, rejectOfferAction, withdrawOfferAction } from '../resale/actions.ts'

export const dynamic = 'force-dynamic'

export default async function Seller({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const v = sellerView(user.id)
  return (
    <>
      <h1>Seller dashboard</h1>
      <Flash {...(await searchParams)} />
      <p>Balance <strong>{money(v.balance)}</strong> · net from {v.sold.length} sold: <strong>{money(v.net)}</strong> · <Link href="/account/payouts">Request a payout</Link> · <Link href="/sell">Sell a ticket</Link></p>
      <p className="muted">Third-party resale (other marketplaces) is not integrated; this dashboard covers TicketStorm Verified Resale only.</p>

      <h2>Offers you received</h2>
      {v.received.map((o) => (
        <div className="card row" key={o.id}>
          <span>{o.title}: offer <strong>{money(o.price_cents)}</strong> (asking {money(o.ask)}), expires {fmtDateTime(o.expires_at, 'UTC')} UTC</span>
          <form action={acceptOfferAction}><input type="hidden" name="offerId" value={o.id} /><button>Accept</button></form>
          <form action={rejectOfferAction}><input type="hidden" name="offerId" value={o.id} /><button>Reject</button></form>
        </div>
      ))}
      {!v.received.length && <p className="muted">No open offers.</p>}

      <h2>Your listings</h2>
      {v.listings.map((l) => (
        <div className="card row" key={l.id}>
          <span>{l.title} · {money(l.price_cents)} (you receive {money(l.price_cents - Math.round((l.price_cents * l.seller_fee_pct) / 100))}){l.reserved ? <> · <span className="badge">reserved for an accepted offer</span></> : null}</span>
          {!l.reserved && <form action={cancelListingAction}><input type="hidden" name="listingId" value={l.id} /><button>Cancel listing</button></form>}
        </div>
      ))}
      {!v.listings.length && <p className="muted">No active listings.</p>}

      <h2>Sold</h2>
      {v.sold.map((s) => <div className="card" key={s.id}>{s.title} · sold for {money(s.price_cents)} · you received {money(s.net)}</div>)}
      {!v.sold.length && <p className="muted">Nothing sold yet.</p>}

      <h2>Offers you made</h2>
      {v.made.map((o) => (
        <div className="card row" key={o.id}>
          <span>{o.title}: your offer {money(o.price_cents)} (asking {money(o.ask)}) · <span className="badge">{o.status}</span></span>
          {o.status === 'pending' && <form action={withdrawOfferAction}><input type="hidden" name="offerId" value={o.id} /><button>Withdraw</button></form>}
          {o.status === 'accepted' && <form action={checkoutOfferAction}><input type="hidden" name="offerId" value={o.id} /><button>Check out at {money(o.price_cents)}</button></form>}
          {o.status === 'accepted' && o.reserved_until && <span className="muted">reserved until {fmtDateTime(o.reserved_until, 'UTC')} UTC</span>}
        </div>
      ))}
      {!v.made.length && <p className="muted">You have not made any offers.</p>}
    </>
  )
}
