import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { toggleFlag } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Flags({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const flags = db.prepare('SELECT key, enabled FROM feature_flags ORDER BY key').all() as { key: string; enabled: number }[]
  return (
    <>
      <h1>Feature flags</h1>
      <Flash {...(await searchParams)} />
      {flags.map((f) => (
        <form action={toggleFlag} className="card buy" key={f.key}>
          <input type="hidden" name="key" value={f.key} /><input type="hidden" name="enabled" value={f.enabled ? '0' : '1'} />
          <code>{f.key}</code> <span className="badge">{f.enabled ? 'on' : 'off'}</span> <button>Turn {f.enabled ? 'off' : 'on'}</button>
        </form>
      ))}
    </>
  )
}
