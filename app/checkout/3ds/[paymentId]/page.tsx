import { db } from '../../../../lib/db.ts'
import { money } from '../../../../lib/format.ts'
import { getSession } from '../../../../lib/session.ts'
import { threeDs } from '../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function ThreeDS({ params }: { params: Promise<{ paymentId: string }> }) {
  const id = Number((await params).paymentId)
  const session = await getSession()
  const p = session && (db.prepare("SELECT id, amount, brand, last4, status FROM payments WHERE id = ? AND session_token = ? AND kind = 'charge'").get(id, session.token) as
    | { id: number; amount: number; brand: string; last4: string; status: string }
    | undefined)
  if (!p || p.status !== 'requires_3ds') return <><h1>3D Secure</h1><p>Nothing to authenticate here.</p></>
  return (
    <>
      <h1>3D Secure check</h1>
      <p>Your bank wants to confirm a payment of <strong>{money(p.amount)}</strong> on {p.brand} ending {p.last4}. (Simulated bank page.)</p>
      <form action={threeDs} className="buy">
        <input type="hidden" name="paymentId" value={p.id} />
        <button name="result" value="approve">Approve</button>
        <button name="result" value="fail">Fail</button>
      </form>
    </>
  )
}
