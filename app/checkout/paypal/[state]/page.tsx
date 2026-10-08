import { db } from '../../../../lib/db.ts'
import { money } from '../../../../lib/format.ts'
import { liveHold } from '../../../../lib/orders.ts'
import { getSession } from '../../../../lib/session.ts'
import { threeDs } from '../../actions.ts'

export const dynamic = 'force-dynamic'

// Simulated PayPal. The state in the URL is the payment's idempotency key; it only resolves for the session that started the payment, and the
// page never takes a return URL: approving goes to the order, cancelling goes back to the hold's own checkout.
export default async function PayPal({ params }: { params: Promise<{ state: string }> }) {
  const state = (await params).state
  const session = await getSession()
  const p = session && /^[\w-]{8,64}$/.test(state)
    ? (db.prepare("SELECT id, amount, status, hold_id FROM payments WHERE idempotency_key = ? AND session_token = ? AND method = 'paypal' AND kind = 'charge'").get(state, session.token) as { id: number; amount: number; status: string; hold_id: number } | undefined)
    : undefined
  if (!p || p.status !== 'pending' || !liveHold(p.hold_id, session!.token)) return <><h1>PayPal</h1><p>This PayPal payment is not waiting for approval (it expired, was already used, or is not yours).</p></>
  return (
    <>
      <h1>PayPal (simulated)</h1>
      <p>Pay <strong>{money(p.amount)}</strong> to TicketStorm with your PayPal balance?</p>
      <form action={threeDs} className="buy">
        <input type="hidden" name="paymentId" value={p.id} />
        <input type="hidden" name="provider" value="paypal" />
        <button name="result" value="approve">Approve payment</button>
        <button name="result" value="fail">Cancel</button>
      </form>
    </>
  )
}
