import AccountNav from '../../../components/AccountNav.tsx'
import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { requireUser } from '../../../lib/session.ts'
import { toggleTwofa } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Security({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const u = db.prepare('SELECT twofa_enabled, phone, password_hash FROM users WHERE id = ?').get(user.id) as { twofa_enabled: number; phone: string | null; password_hash: string | null }
  const links = db.prepare('SELECT provider FROM oauth_links WHERE user_id = ?').all(user.id) as { provider: string }[]
  return (
    <>
      <h1>Account</h1>
      <AccountNav here="security" />
      <Flash {...(await searchParams)} />
      <h2>Two-factor login</h2>
      <p>{u.twofa_enabled ? 'On: after your password we text a code to ' : 'Off. When on, after your password we text a code to '}{u.phone ?? 'the phone on your profile (add one first)'}.</p>
      {u.password_hash ? (
        <form action={toggleTwofa} className="stack">
          <input type="hidden" name="on" value={u.twofa_enabled ? '0' : '1'} />
          <input name="password" type="password" placeholder="Confirm your password" required autoComplete="current-password" />
          <button>{u.twofa_enabled ? 'Turn off two-factor login' : 'Turn on two-factor login'}</button>
        </form>
      ) : <p className="muted">Set a password with &quot;Forgot password&quot; to use two-factor login.</p>}
      <p className="muted">Logging in with Google, Apple or Facebook skips this step: that provider has already signed you in.</p>
      <h2>Linked logins</h2>
      <p>{links.length ? links.map((l) => l.provider).join(', ') : 'None.'}</p>
    </>
  )
}
