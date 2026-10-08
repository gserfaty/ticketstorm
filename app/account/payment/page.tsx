import Link from 'next/link'
import AccountNav from '../../../components/AccountNav.tsx'
import Flash from '../../../components/Flash.tsx'
import { addressOf, MAX_CARDS } from '../../../lib/account.ts'
import { db } from '../../../lib/db.ts'
import { listSavedCards } from '../../../lib/payments.ts'
import { creditBalance, creditHistory } from '../../../lib/stored.ts'
import { money } from '../../../lib/format.ts'
import { requireUser } from '../../../lib/session.ts'
import { addWalletCard, makeDefaultCard, removeCard } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Wallet({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const cards = listSavedCards(user.id)
  const addr = addressOf((db.prepare('SELECT address FROM users WHERE id = ?').get(user.id) as { address: string | null }).address)
  const express = cards.length > 0 && !!addr.line1 && !!addr.city && !!addr.zip
  return (
    <>
      <h1>Account</h1>
      <AccountNav here="payment" />
      <Flash {...(await searchParams)} />
      <p className="muted">Your wallet keeps only the brand, last four digits and expiry. The card number and CVC are checked and then forgotten. Express checkout fills in your default card and your saved address; you still re-enter the CVC.</p>
      <p className={express ? 'notice' : 'muted'}>{express ? 'Express checkout is ready.' : <>Express checkout needs a card here and an address in your <Link href="/account/profile">profile</Link>.</>}</p>
      <h2>Account credit</h2>
      <p>Balance <strong>{money(creditBalance(user.id))}</strong>. Credit comes from refunds you chose to take as credit and from redeemed <Link href="/gift-cards">gift cards</Link>; it is applied at checkout before the card.</p>
      <ul className="plain">{creditHistory(user.id).map((c, i) => <li key={i} className="muted">{c.created_at.slice(0, 10)} · {c.amount > 0 ? '+' : ''}{money(c.amount)} · {c.ref}</li>)}</ul>
      <h2>Cards</h2>
      {cards.map((c) => (
        <div className="card row" key={c.id}>
          {c.brand} ending {c.last4} · expires {c.exp} {c.is_default ? <span className="badge on-sale">default</span> : null}
          {!c.is_default && <form action={makeDefaultCard}><input type="hidden" name="cardId" value={c.id} /><button>Make default</button></form>}
          <form action={removeCard}><input type="hidden" name="cardId" value={c.id} /><button>Delete</button></form>
        </div>
      ))}
      {!cards.length && <p>No saved cards.</p>}
      {cards.length < MAX_CARDS && (
        <form action={addWalletCard} className="stack">
          <h2>Add a card</h2>
          <input name="number" placeholder="Card number" inputMode="numeric" autoComplete="cc-number" required />
          <input name="exp" placeholder="MM/YY" autoComplete="cc-exp" required />
          <input name="cvc" placeholder="CVC (checked, not stored)" inputMode="numeric" autoComplete="cc-csc" required />
          <label><input type="checkbox" name="default" /> Make it my default card</label>
          <button>Add card</button>
          <span className="muted">Test card: 4242 4242 4242 4242.</span>
        </form>
      )}
    </>
  )
}
