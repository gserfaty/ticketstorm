import { db } from './db.ts'

export type FeeRule = { service_pct: number; facility_cents: number; order_cents: number }
const DEFAULT_FEES: FeeRule = { service_pct: 10, facility_cents: 300, order_cents: 250 }

export type Line = { inventoryId: number; eventId: number; label: string; unit: number; fee: number; tax: number }
export type Quote = { lines: Line[]; subtotal: number; fees: number; orderFee: number; tax: number; total: number }

// Pure money math. Per ticket: face + service % + facility charge, then city tax on (face + those fees);
// plus one per-order processing fee (untaxed). fees = sum(line fees) + orderFee, so total = subtotal + fees + tax.
export function price(units: number[], rule: FeeRule, taxBps: number) {
  const lineFees = units.map((u) => (u > 0 ? Math.round((u * rule.service_pct) / 100) + rule.facility_cents : 0))
  const lineTax = units.map((u, i) => Math.round(((u + lineFees[i]) * taxBps) / 10000))
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const subtotal = sum(units)
  const orderFee = units.length ? rule.order_cents : 0
  const fees = sum(lineFees) + orderFee
  const tax = sum(lineTax)
  return { subtotal, fees, orderFee, tax, total: subtotal + fees + tax, lineFees, lineTax }
}

// Quote for everything currently held by `holdId`. Bundle seats in the hold's other events are covered by the bundle price (unit 0).
export function quote(holdId: number): Quote {
  const hold = db.prepare('SELECT event_id FROM holds WHERE id = ?').get(holdId) as { event_id: number }
  const ev = db.prepare('SELECT fee_rule FROM events WHERE id = ?').get(hold.event_id) as { fee_rule: string | null }
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'fee_defaults'").get() as { value: string } | undefined
  const rule: FeeRule = { ...DEFAULT_FEES, ...(setting ? JSON.parse(setting.value) : {}), ...(ev.fee_rule ? JSON.parse(ev.fee_rule) : {}) }
  const { bps } = db
    .prepare('SELECT c.tax_rate_bps AS bps FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = v.city_id WHERE e.id = ?')
    .get(hold.event_id) as { bps: number }
  const rows = db
    .prepare(
      `SELECT i.id, i.event_id, pl.price_cents, pl.name AS level, s.name AS section, st.row, st.number
       FROM inventory i JOIN price_levels pl ON pl.id = i.price_level_id JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id
       WHERE i.hold_id = ? ORDER BY i.id`,
    )
    .all(holdId) as { id: number; event_id: number; price_cents: number; level: string; section: string; row: string | null; number: number | null }[]
  const units = rows.map((r) => (r.event_id === hold.event_id ? r.price_cents : 0))
  const p = price(units, rule, bps)
  const lines = rows.map((r, i) => ({
    inventoryId: r.id,
    eventId: r.event_id,
    label: `${r.level} · ${r.row ? `Section ${r.section} Row ${r.row} Seat ${r.number}` : `General admission ${r.section}`}`,
    unit: units[i],
    fee: p.lineFees[i],
    tax: p.lineTax[i],
  }))
  return { lines, subtotal: p.subtotal, fees: p.fees, orderFee: p.orderFee, tax: p.tax, total: p.total }
}
