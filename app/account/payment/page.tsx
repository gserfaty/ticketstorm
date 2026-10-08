import AccountNav from '../../../components/AccountNav.tsx'
import Flash from '../../../components/Flash.tsx'
import { listSavedCards } from '../../../lib/payments.ts'
import { requireUser } from '../../../lib/session.ts'
import { removeCard } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Payment({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const cards = listSavedCards(user.id)
  return (
    <>
      <h1>Account</h1>
      <AccountNav here="payment" />
      <Flash {...(await searchParams)} />
      <p className="muted">Cards are saved from checkout ("Save this card"). Only the brand, last four digits and expiry are kept.</p>
      {cards.map((c) => (
        <div className="card buy" key={c.id}>
          {c.brand} ending {c.last4} · expires {c.exp}
          <form action={removeCard}><input type="hidden" name="cardId" value={c.id} /><button>Delete</button></form>
        </div>
      ))}
      {!cards.length && <p>No saved cards.</p>}
    </>
  )
}
