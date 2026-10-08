import AccountNav from '../../../components/AccountNav.tsx'
import Flash from '../../../components/Flash.tsx'
import { PREF_CATEGORIES, PREF_CHANNELS, prefsOf } from '../../../lib/account.ts'
import { db } from '../../../lib/db.ts'
import { requireUser } from '../../../lib/session.ts'
import { saveNotifications } from '../actions.ts'

export const dynamic = 'force-dynamic'
const NAMES: Record<string, string> = { orders: 'Orders and tickets', alerts: 'Event alerts', marketing: 'News and offers' }

export default async function Notifications({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const prefs = prefsOf((db.prepare('SELECT notif_prefs FROM users WHERE id = ?').get(user.id) as { notif_prefs: string | null }).notif_prefs)
  return (
    <>
      <h1>Account</h1>
      <AccountNav here="notifications" />
      <Flash {...(await searchParams)} />
      <form action={saveNotifications} className="stack">
        <table>
          <thead><tr><th></th>{PREF_CHANNELS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {PREF_CATEGORIES.map((cat) => (
              <tr key={cat}>
                <td>{NAMES[cat]}</td>
                {PREF_CHANNELS.map((ch) => <td key={ch}><input type="checkbox" name="pref" value={`${cat}_${ch}`} defaultChecked={!!prefs[`${cat}_${ch}`]} aria-label={`${NAMES[cat]} by ${ch}`} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
        <button>Save</button>
      </form>
    </>
  )
}
