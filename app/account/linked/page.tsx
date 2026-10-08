import AccountNav from '../../../components/AccountNav.tsx'
import Flash from '../../../components/Flash.tsx'
import { linkedVendors, VENDORS } from '../../../lib/account.ts'
import { requireUser } from '../../../lib/session.ts'
import { toggleVendor } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Linked({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const linked = linkedVendors(user.id)
  return (
    <>
      <h1>Account</h1>
      <AccountNav here="linked" />
      <Flash {...(await searchParams)} />
      <p className="notice-banner card"><strong>Simulation.</strong> These vendors are made up. Linking only records your choice: no tickets are imported, no credentials are asked for, and nothing is sent anywhere.</p>
      {VENDORS.map(([k, name]) => (
        <form action={toggleVendor} className="card row" key={k}>
          <input type="hidden" name="vendor" value={k} />
          <input type="hidden" name="on" value={linked.includes(k) ? '0' : '1'} />
          {name} · {linked.includes(k) ? <span className="badge on-sale">linked (simulated)</span> : <span className="muted">not linked</span>}
          <button>{linked.includes(k) ? 'Unlink' : 'Link account'}</button>
        </form>
      ))}
    </>
  )
}
