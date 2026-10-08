import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { saveCityTax } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Taxes({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const cities = db.prepare('SELECT id, name, state, tax_rate_bps FROM cities ORDER BY name').all() as { id: number; name: string; state: string; tax_rate_bps: number }[]
  return (
    <>
      <h1>City taxes</h1>
      <p className="muted">Tax is charged on face plus fees, at the rate of the venue&apos;s city. 100 basis points = 1%.</p>
      <Flash {...(await searchParams)} />
      {cities.map((c) => (
        <form action={saveCityTax} className="card buy" key={c.id}>
          <input type="hidden" name="cityId" value={c.id} />
          <span style={{ minWidth: 160 }}>{c.name}, {c.state}</span>
          <input name="bps" type="number" min="0" max="3000" defaultValue={c.tax_rate_bps} aria-label={`Tax rate for ${c.name} in basis points`} /> bps
          <button>Save</button>
        </form>
      ))}
    </>
  )
}
