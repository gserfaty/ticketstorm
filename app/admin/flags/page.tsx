import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { setVariant, toggleFlag } from '../actions.ts'
import { bucket } from '../../../lib/ab.ts'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export default async function Flags({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const flags = db.prepare('SELECT key, enabled, variant_pct FROM feature_flags ORDER BY key').all() as { key: string; enabled: number; variant_pct: number }[]
  const me = (await cookies()).get('ab')?.value ?? 'none'
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
      <h2>A/B tests</h2>
      <p className="muted">A flag that is on shows variant B to <em>variant share</em> percent of visitors, chosen by hashing the flag and the visitor&apos;s <code>ab</code> cookie, so a visitor always sees the same variant. Off = everyone sees A. <code>ab_cta_text</code> changes the event page button ("Find tickets" vs "Get tickets now").</p>
      {flags.filter((f) => f.key !== 'require_event_approval').map((f) => (
        <form action={setVariant} className="card row" key={f.key}>
          <input type="hidden" name="key" value={f.key} />
          <code>{f.key}</code> <span className="badge">{f.enabled ? 'on' : 'off'}</span>
          <label>Variant B share % <input name="pct" type="number" min={0} max={100} defaultValue={f.variant_pct} /></label> <button>Save</button>
          <span className="muted">You are in variant {f.enabled && bucket(f.key, me) < f.variant_pct ? 'B' : 'A'} (bucket {bucket(f.key, me)})</span>
        </form>
      ))}
    </>
  )
}
