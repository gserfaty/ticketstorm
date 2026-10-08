import AccountNav from '../../../components/AccountNav.tsx'
import Flash from '../../../components/Flash.tsx'
import { PREF_CATEGORIES, PREF_CHANNELS, PREF_LABELS, prefsOf } from '../../../lib/account.ts'
import { listCities } from '../../../lib/geo.ts'
import { db } from '../../../lib/db.ts'
import { requireUser } from '../../../lib/session.ts'
import { saveAlertAreaAction, saveNotifications } from '../actions.ts'

export const dynamic = 'force-dynamic'
const NAMES = PREF_LABELS
const CHANNEL_NAMES: Record<string, string> = { inapp: 'inbox', email: 'email', sms: 'SMS' }

export default async function Notifications({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const row = db.prepare('SELECT notif_prefs, home_city_id, alert_radius_mi FROM users WHERE id = ?').get(user.id) as { notif_prefs: string | null; home_city_id: number | null; alert_radius_mi: number }
  const prefs = prefsOf(row.notif_prefs)
  return (
    <>
      <h1>Account</h1>
      <AccountNav here="notifications" />
      <Flash {...(await searchParams)} />
      <form action={saveNotifications} className="stack">
        <table>
          <thead><tr><th></th>{PREF_CHANNELS.map((c) => <th key={c}>{CHANNEL_NAMES[c]}</th>)}</tr></thead>
          <tbody>
            {PREF_CATEGORIES.map((cat) => (
              <tr key={cat}>
                <td>{NAMES[cat]}</td>
                {PREF_CHANNELS.map((ch) => <td key={ch}><input type="checkbox" name="pref" value={`${cat}_${ch}`} defaultChecked={!!prefs[`${cat}_${ch}`]} aria-label={`${NAMES[cat]} by ${CHANNEL_NAMES[ch]}`} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
        <button>Save</button>
      </form>
      <h2>Alert area</h2>
      <p className="muted">Shows by artists and venues you follow are announced to you when they are within this distance of your home city.</p>
      <form action={saveAlertAreaAction} className="stack">
        <select name="city" defaultValue={row.home_city_id ?? ''} aria-label="Home city">
          <option value="">No home city (alert for every show)</option>
          {listCities().map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
        </select>
        <label>Radius (miles) <input name="radius" type="number" min="1" max="3000" defaultValue={row.alert_radius_mi} required /></label>
        <button>Save area</button>
      </form>
    </>
  )
}
