import Flash from '../../../components/Flash.tsx'
import { feeDefaults } from '../../../lib/pricing.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { resaleDefaults } from '../../../lib/rules.ts'
import { saveFeeDefaults, saveResaleDefaultsAction } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Fees({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const f = feeDefaults()
  const r = resaleDefaults()
  return (
    <>
      <h1>Fee defaults</h1>
      <p className="muted">Used by every event that does not set its own fee rule. New quotes use these at once; tickets already held keep their face price.</p>
      <Flash {...(await searchParams)} />
      <form action={saveFeeDefaults} className="stack">
        <label>Service fee % of face <input name="service_pct" type="number" min="0" max="50" defaultValue={f.service_pct} /></label>
        <label>Facility charge per ticket (cents) <input name="facility_cents" type="number" min="0" defaultValue={f.facility_cents} /></label>
        <label>Order processing fee (cents) <input name="order_cents" type="number" min="0" defaultValue={f.order_cents} /></label>
        <label>Delivery fee per order (cents) <input name="delivery_cents" type="number" min="0" defaultValue={f.delivery_cents ?? 0} /></label>
        <button>Save</button>
      </form>
      <h2>Resale defaults</h2>
      <p className="muted">Face value = the unit price paid on the original order line. An event can override every field.</p>
      <form action={saveResaleDefaultsAction} className="stack">
        <label><input type="checkbox" name="enabled" defaultChecked={r.enabled} /> Resale allowed</label>
        <label>Floor % of face <input name="min_pct" type="number" min="0" max="1000" defaultValue={r.min_pct} /></label>
        <label>Ceiling % of face <input name="max_pct" type="number" min="1" max="1000" defaultValue={r.max_pct} /></label>
        <label>Seller fee % (taken from the seller) <input name="seller_fee_pct" type="number" min="0" max="50" defaultValue={r.seller_fee_pct} /></label>
        <label>Buyer fee % (added for the buyer) <input name="buyer_fee_pct" type="number" min="0" max="50" defaultValue={r.buyer_fee_pct} /></label>
        <button>Save resale defaults</button>
      </form>
    </>
  )
}
