import { cookies } from 'next/headers'
import Flash from '../../components/Flash.tsx'
import { readLookupCookie } from '../../lib/lookup.ts'
import { redeemLookup, requestLookup } from './actions.ts'

export const dynamic = 'force-dynamic'

export default async function Lookup({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; step?: string }> }) {
  const sp = await searchParams
  const pending = sp.step === 'code' ? readLookupCookie((await cookies()).get('lookup')?.value) : undefined
  return (
    <>
      <h1>Find your order</h1>
      <p className="muted">Bought as a guest? Enter the email you used and your order number. We email a one-time code to that address.</p>
      <Flash error={sp.error} notice={sp.notice} />
      <form action={requestLookup} className="stack">
        <input name="website" className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
        <input name="email" type="email" placeholder="Email on the order" required />
        <input name="order" inputMode="numeric" placeholder="Order number (e.g. 12)" required />
        <button>Email me a code</button>
      </form>
      {pending && (
        <form action={redeemLookup} className="stack">
          <h2>Enter your code</h2>
          <p className="muted">Checking order #{pending.orderId}.</p>
          <input name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" maxLength={6} required />
          <button>Open my order</button>
          <span className="muted">In this demo the email is in the <a href="/dev/outbox">dev outbox</a>.</span>
        </form>
      )}
    </>
  )
}
