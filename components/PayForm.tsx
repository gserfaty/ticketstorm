'use client'
import { useRouter } from 'next/navigation'
import { useFormStatus } from 'react-dom'
import Countdown from './Countdown.tsx'

type Saved = { id: number; brand: string; last4: string; exp: string }

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return <button disabled={pending}>{pending ? 'Processing…' : label}</button>
}

// Card number and CVC are never given a `name` that is logged or stored server-side; they are read once by the pay action.
export default function PayForm({ action, holdId, idemKey, expiresAt, email, saved, canSave, total }: {
  action: (f: FormData) => void
  holdId: number
  idemKey: string
  expiresAt: string
  email: string | null
  saved: Saved[]
  canSave: boolean
  total: string
}) {
  const router = useRouter()
  return (
    <form action={action} className="stack">
      <p>Time left to pay: <strong><Countdown expiresAt={expiresAt} onExpire={() => router.refresh()} /></strong></p>
      <input type="hidden" name="holdId" value={holdId} />
      <input type="hidden" name="key" value={idemKey} />
      <h2>Contact</h2>
      {email ? <p>Tickets will be sent to <strong>{email}</strong></p> : <input name="email" type="email" placeholder="Email (for your tickets)" required autoComplete="email" />}
      <p className="muted">Delivery: Mobile ticket</p>
      <h2>Billing address</h2>
      <input name="bname" placeholder="Full name" required autoComplete="name" />
      <input name="baddress" placeholder="Street address" required autoComplete="street-address" />
      <input name="bcity" placeholder="City" required autoComplete="address-level2" />
      <input name="bzip" placeholder="ZIP" required autoComplete="postal-code" />
      <h2>Payment</h2>
      {saved.length > 0 && (
        <select name="saved" defaultValue="" aria-label="Saved card">
          <option value="">New card</option>
          {saved.map((c) => <option key={c.id} value={c.id}>{c.brand} ending {c.last4} ({c.exp})</option>)}
        </select>
      )}
      <input name="number" placeholder="Card number" inputMode="numeric" autoComplete="cc-number" />
      <input name="exp" placeholder="MM/YY" autoComplete="cc-exp" />
      <input name="cvc" placeholder="CVC" inputMode="numeric" autoComplete="cc-csc" />
      {canSave && <label><input type="checkbox" name="save" /> Save this card</label>}
      <p className="muted">Test cards: 4242 4242 4242 4242 pays, 4000 0000 0000 0002 declines, 4000 0000 0000 3220 asks for 3D Secure.</p>
      <Submit label={`Pay ${total}`} />
    </form>
  )
}
