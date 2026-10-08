import Link from 'next/link'
import Flash from '../../components/Flash.tsx'
import { money } from '../../lib/format.ts'
import { MAX_GIFT, MIN_GIFT } from '../../lib/giftcards.ts'
import { creditBalance } from '../../lib/stored.ts'
import { getUser } from '../../lib/session.ts'
import { buyGiftCard, checkBalance, redeemGiftCard } from './actions.ts'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Gift cards | TicketStorm' }

export default async function GiftCards({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await getUser()
  return (
    <>
      <h1>Gift cards</h1>
      <Flash {...(await searchParams)} />
      <p className="muted">Give tickets without picking the show. The code is emailed to the recipient and works at checkout for part or all of an order; if it covers less than the total, the card is charged the rest. Refunds of the part paid with a gift card go back onto the card.</p>
      {user && <p>Your account credit: <strong>{money(creditBalance(user.id))}</strong></p>}

      <h2>Check a balance</h2>
      <form action={checkBalance} className="stack">
        <input name="code" placeholder="XXXX-XXXX-XXXX-XXXX" aria-label="Gift card code" required autoComplete="off" />
        <button>Check balance</button>
      </form>

      {user ? (
        <>
          <h2>Redeem to your account</h2>
          <form action={redeemGiftCard} className="stack">
            <input name="code" placeholder="XXXX-XXXX-XXXX-XXXX" aria-label="Gift card code to redeem" required autoComplete="off" />
            <button>Add the whole balance to my account credit</button>
          </form>
          <h2>Buy a gift card</h2>
          <form action={buyGiftCard} className="stack">
            <label>Amount ($) <input name="amount" inputMode="decimal" required pattern="\d{1,4}(\.\d{1,2})?" defaultValue="50" /> <span className="muted">{money(MIN_GIFT)} to {money(MAX_GIFT)}</span></label>
            <label>Recipient email <input name="recipient" type="email" required defaultValue={user.email} /></label>
            <label>Message (optional) <textarea name="message" maxLength={300} rows={2} /></label>
            <input name="number" placeholder="Card number" inputMode="numeric" autoComplete="cc-number" required />
            <input name="exp" placeholder="MM/YY" autoComplete="cc-exp" required />
            <input name="cvc" placeholder="CVC" inputMode="numeric" autoComplete="cc-csc" required />
            <button>Buy gift card</button>
            <span className="muted">Test card: 4242 4242 4242 4242 (a fake charge; nothing real is charged).</span>
          </form>
        </>
      ) : <p><Link href="/login?next=/gift-cards">Log in</Link> to buy or redeem a gift card.</p>}
    </>
  )
}
