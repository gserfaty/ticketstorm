import AccountNav from '../../../components/AccountNav.tsx'
import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { requireUser } from '../../../lib/session.ts'
import { removeAccount } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Privacy({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const hasPassword = !!(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string | null }).password_hash
  return (
    <>
      <h1>Account</h1>
      <AccountNav here="privacy" />
      <Flash {...(await searchParams)} />
      <h2>Download your data</h2>
      <p><a className="btn" href="/account/privacy/export" download>Download JSON</a></p>
      <h2>Delete your account</h2>
      <p>Your name, email, phone, address, saved cards and sign-in links are erased and you are logged out everywhere. Your orders and tickets stay on record without any personal details, your listings and pending transfers are cancelled, and you can no longer use tickets you still hold.</p>
      <form action={removeAccount} className="stack">
        <input name="confirm" type={hasPassword ? 'password' : 'text'} placeholder={hasPassword ? 'Your password' : 'Type your email address'} required autoComplete="off" />
        <button>Delete my account</button>
      </form>
    </>
  )
}
