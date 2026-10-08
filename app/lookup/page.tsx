import Flash from '../../components/Flash.tsx'
import { redeemLookup, requestLookup } from './actions.ts'

export const dynamic = 'force-dynamic'

export default async function Lookup({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; email?: string; order?: string; step?: string }> }) {
  const sp = await searchParams
  return (
    <>
      <h1>Find your order</h1>
      <p className="muted">Bought as a guest? Enter the email you used and your order number. We email a one-time code to that address.</p>
      <Flash error={sp.error} notice={sp.notice} />
      <form action={requestLookup} className="stack">
        <input name="website" className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
        <input name="email" type="email" placeholder="Email on the order" defaultValue={sp.email ?? ''} required />
        <input name="order" inputMode="numeric" placeholder="Order number (e.g. 12)" defaultValue={sp.order ?? ''} required />
        <button>Email me a code</button>
      </form>
      {sp.step === 'code' && (
        <form action={redeemLookup} className="stack">
          <h2>Enter your code</h2>
          <input type="hidden" name="email" value={sp.email ?? ''} />
          <input type="hidden" name="order" value={sp.order ?? ''} />
          <input name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" maxLength={6} required />
          <button>Open my order</button>
          <span className="muted">In this demo the email is in the <a href="/dev/outbox">dev outbox</a>.</span>
        </form>
      )}
    </>
  )
}
