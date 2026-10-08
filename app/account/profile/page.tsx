import AccountNav from '../../../components/AccountNav.tsx'
import Flash from '../../../components/Flash.tsx'
import { addressOf } from '../../../lib/account.ts'
import { db } from '../../../lib/db.ts'
import { requireUser } from '../../../lib/session.ts'
import { saveProfile } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Profile({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const u = db.prepare('SELECT name, phone, address FROM users WHERE id = ?').get(user.id) as { name: string; phone: string | null; address: string | null }
  const a = addressOf(u.address)
  return (
    <>
      <h1>Account</h1>
      <AccountNav here="profile" />
      <Flash {...(await searchParams)} />
      <p className="muted">{user.email}</p>
      <form action={saveProfile} className="stack">
        <label>Name <input name="name" defaultValue={u.name} maxLength={80} autoComplete="name" /></label>
        <label>Phone (used for texts and two-factor codes) <input name="phone" defaultValue={u.phone ?? ''} autoComplete="tel" /></label>
        <label>Street address <input name="line1" defaultValue={a.line1} autoComplete="street-address" /></label>
        <label>City <input name="city" defaultValue={a.city} autoComplete="address-level2" /></label>
        <label>State <input name="state" defaultValue={a.state} autoComplete="address-level1" /></label>
        <label>ZIP <input name="zip" defaultValue={a.zip} autoComplete="postal-code" /></label>
        <button>Save</button>
      </form>
    </>
  )
}
