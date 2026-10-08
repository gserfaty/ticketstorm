import { db, tx } from './db.ts'
import { attendance } from './scan.ts'
import { ledgerAdd } from './ledger.ts'
import { localDate } from './format.ts'
import { UserError } from './platform.ts'

// ---- CSV ----
// A cell that starts with = + - @ (or tab / CR) is a formula to Excel and Sheets: prefix a quote. Numbers are never prefixed (a refund may be negative).
export function csvCell(v: string | number | null | undefined): string {
  if (typeof v === 'number') return String(v)
  let s = v ?? ''
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const toCsv = (rows: (string | number | null)[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

// ---- report ----
// Orders that were charged (not pending), without fan-to-fan resale orders: that money is not the organizer's.
const CHARGED = "o.status IN ('paid','review','partially_refunded','refunded','cancelled') AND coalesce(o.source, '') != 'resale'"
const LIVE = "o.status IN ('paid','partially_refunded')"
export const ENDED_AFTER_MS = 6 * 3_600_000 // an event counts as over 6 hours after it starts

export type Report = {
  orders: number; gross: number; refunds: number; fees: number; tax: number; protection: number; net: number
  byLevel: { level: string; sold: number; revenue: number }[]
  byDay: { day: string; sold: number; revenue: number }[]
  bySrc: { src: string; orders: number; tickets: number; revenue: number }[]
  attendance: { scanned: number; total: number }
}

const one = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T

// Money, in cents. gross = everything charged; refunds = refund payments; fees / tax / protection = what the platform and the city keep from live orders;
// net = what the organizer keeps = live-order face (subtotal - discount) minus refunds paid out on those orders.
export function settlementFigures(eventId: number) {
  const gross = one<{ s: number }>(`SELECT coalesce(sum(o.total), 0) AS s FROM orders o WHERE o.event_id = ? AND ${CHARGED}`, eventId).s
  const refunds = one<{ s: number }>(`SELECT coalesce(sum(p.amount), 0) AS s FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.event_id = ? AND ${CHARGED} AND p.kind = 'refund' AND p.status = 'succeeded' AND p.method != 'exchange'`, eventId).s
  const live = one<{ n: number; face: number; fees: number; tax: number; prot: number; refunded: number }>(
    `SELECT count(*) AS n, coalesce(sum(o.subtotal - o.discount), 0) AS face, coalesce(sum(o.fees), 0) AS fees, coalesce(sum(o.tax), 0) AS tax, coalesce(sum(o.protection), 0) AS prot,
       coalesce(sum((SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.order_id = o.id AND p.kind = 'refund' AND p.status = 'succeeded' AND p.method != 'exchange')), 0) AS refunded
     FROM orders o WHERE o.event_id = ? AND ${LIVE} AND coalesce(o.source, '') != 'resale'`, eventId)
  // ponytail: a partial refund is taken out of the organizer's share, even when it returned fees or tax too
  const net = Math.max(live.face - live.refunded, 0)
  return { gross, refunds, fees: live.fees, tax: live.tax, protection: live.prot, net, liveOrders: live.n, collected: net + live.fees + live.tax + live.prot }
}

export function eventReport(eventId: number, tz: string): Report {
  const f = settlementFigures(eventId)
  const orders = one<{ n: number }>(`SELECT count(*) AS n FROM orders o WHERE o.event_id = ? AND ${CHARGED}`, eventId).n
  const items = db
    .prepare(
      `SELECT pl.name AS level, o.created_at, o.src, oi.unit_cents FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN inventory i ON i.id = oi.inventory_id
       JOIN price_levels pl ON pl.id = i.price_level_id WHERE o.event_id = ? AND ${LIVE} AND coalesce(o.source, '') != 'resale' AND oi.kind = 'ticket' AND oi.refunded_cents = 0`,
    )
    .all(eventId) as { level: string; created_at: string; src: string | null; unit_cents: number }[]
  const group = <K extends string>(key: (r: (typeof items)[number]) => string, name: K) => {
    const m = new Map<string, { sold: number; revenue: number }>()
    for (const r of items) {
      const g = m.get(key(r)) ?? { sold: 0, revenue: 0 }
      g.sold++
      g.revenue += r.unit_cents
      m.set(key(r), g)
    }
    return [...m].map(([k, g]) => ({ [name]: k, ...g })) as ({ sold: number; revenue: number } & Record<K, string>)[]
  }
  const bySrc = db
    .prepare(
      `SELECT coalesce(o.src, 'direct') AS src, count(*) AS orders, coalesce(sum((SELECT count(*) FROM order_items WHERE order_id = o.id AND kind = 'ticket')), 0) AS tickets, coalesce(sum(o.total), 0) AS revenue
       FROM orders o WHERE o.event_id = ? AND ${CHARGED} GROUP BY 1 ORDER BY revenue DESC`,
    )
    .all(eventId) as Report['bySrc']
  return {
    orders, gross: f.gross, refunds: f.refunds, fees: f.fees, tax: f.tax, protection: f.protection, net: f.net,
    byLevel: group((r) => r.level, 'level').sort((a, b) => b.revenue - a.revenue),
    byDay: group((r) => localDate(r.created_at, tz), 'day').sort((a, b) => a.day.localeCompare(b.day)),
    bySrc, attendance: attendance(eventId),
  }
}

// One row per charged order, then a TOTAL row. The total column sums to select sum(total) over the same orders.
export function reportCsv(eventId: number): string {
  const rows = db
    .prepare(
      `SELECT o.id, o.created_at, o.email, o.status, o.subtotal, o.fees, o.tax, o.protection, o.discount, o.total, o.src FROM orders o WHERE o.event_id = ? AND ${CHARGED} ORDER BY o.id`,
    )
    .all(eventId) as { id: number; created_at: string; email: string; status: string; subtotal: number; fees: number; tax: number; protection: number; discount: number; total: number; src: string | null }[]
  const sum = (k: 'subtotal' | 'fees' | 'tax' | 'protection' | 'discount' | 'total') => rows.reduce((n, r) => n + r[k], 0)
  return toCsv([
    ['order', 'created_at', 'email', 'status', 'subtotal_cents', 'fees_cents', 'tax_cents', 'protection_cents', 'discount_cents', 'total_cents', 'src'],
    ...rows.map((r) => [r.id, r.created_at, r.email, r.status, r.subtotal, r.fees, r.tax, r.protection, r.discount, r.total, r.src ?? '']),
    ['TOTAL', '', '', '', sum('subtotal'), sum('fees'), sum('tax'), sum('protection'), sum('discount'), sum('total'), ''],
  ])
}

// ---- settlement ----
// After the event is over, move its money into the ledger once. Zero-sum (ref settle:event:ID): cash -collected, org +net, platform +fees +protection, tax +tax.
// The settlements PRIMARY KEY makes a second run a no-op (returns settled: false).
export function settleEvent(eventId: number, actorId: number | null, now = Date.now()): { settled: boolean; net: number } {
  return tx(() => {
    const ev = db.prepare('SELECT org_id, status, starts_at FROM events WHERE id = ?').get(eventId) as { org_id: number; status: string; starts_at: string } | undefined
    if (!ev) throw new UserError('Event not found')
    const prior = db.prepare('SELECT net FROM settlements WHERE event_id = ?').get(eventId) as { net: number } | undefined
    if (prior) return { settled: false, net: prior.net }
    if (ev.status === 'cancelled' || ev.status === 'draft') throw new UserError('Only events that took place can be settled')
    if (Date.parse(ev.starts_at) + ENDED_AFTER_MS > now) throw new UserError('The event is not over yet')
    const open = one<{ n: number }>("SELECT count(*) AS n FROM orders WHERE event_id = ? AND (status = 'review' OR refund_error IS NOT NULL)", eventId).n
    if (open) throw new UserError(`Resolve ${open} order(s) in review or with failed refunds first`)
    const f = settlementFigures(eventId)
    db.prepare('INSERT INTO settlements (event_id, org_id, collected, net, fees, tax, last_refund_payment_id, settled_by) VALUES (?,?,?,?,?,?,(SELECT coalesce(max(id), 0) FROM payments WHERE kind = \'refund\'),?)').run(eventId, ev.org_id, f.collected, f.net, f.fees + f.protection, f.tax, actorId)
    const ref = `settle:event:${eventId}`
    ledgerAdd('cash', 'sale', -f.collected, ref)
    ledgerAdd(`org:${ev.org_id}`, 'sale', f.net, ref)
    ledgerAdd('platform', 'fee', f.fees + f.protection, ref)
    ledgerAdd('tax', 'fee', f.tax, ref)
    return { settled: true, net: f.net }
  })
}

// A refund that happens AFTER the event was settled takes money back from everyone who was paid: for each such refund payment (once, ref
// refund:payment:ID) the buyer's cash comes out of the organizer's face share, the platform's fees and the tax in proportion to the order's total,
// so the ledger stays zero-sum. The org balance may go negative (it was already paid out); payouts need balance >= amount, so it cannot draw more.
// Resale orders are not the organizer's money (settleListing / reverseResale handle them). Call inside the refund's tx, after the refund rows exist.
export function reverseAfterSettlement(orderId: number) {
  const o = db
    .prepare(
      `SELECT o.source, o.subtotal - o.discount AS face, o.fees, o.tax, o.protection, o.total, s.org_id, s.last_refund_payment_id AS after FROM orders o
       JOIN settlements s ON s.event_id = o.event_id WHERE o.id = ?`,
    )
    .get(orderId) as { source: string | null; face: number; fees: number; tax: number; protection: number; total: number; org_id: number; after: number } | undefined
  if (!o || o.source === 'resale' || o.total <= 0) return
  const pays = db.prepare("SELECT id, amount FROM payments WHERE order_id = ? AND kind = 'refund' AND status = 'succeeded' AND method != 'exchange' AND id > ? ORDER BY id").all(orderId, o.after) as { id: number; amount: number }[]
  for (const p of pays) {
    const ref = `refund:payment:${p.id}`
    if (db.prepare('SELECT 1 FROM ledger WHERE ref = ?').get(ref)) continue
    const platform = Math.round((p.amount * (o.fees + o.protection)) / o.total)
    const tax = Math.round((p.amount * o.tax) / o.total)
    ledgerAdd('cash', 'refund', p.amount, ref)
    ledgerAdd(`org:${o.org_id}`, 'refund', -(p.amount - platform - tax), ref)
    ledgerAdd('platform', 'refund', -platform, ref)
    ledgerAdd('tax', 'refund', -tax, ref)
  }
}

// Refunding a resale order takes back the whole resale ledger group (seller net, platform fees, tax, cash), once per listing (guard: ref listing:ID:reversal).
export function reverseResale(orderId: number) {
  const l = db.prepare("SELECT l.id FROM orders o JOIN listings l ON l.hold_id = o.hold_id AND l.status = 'sold' WHERE o.id = ? AND o.source = 'resale'").get(orderId) as { id: number } | undefined
  if (!l || db.prepare('SELECT 1 FROM ledger WHERE ref = ?').get(`listing:${l.id}:reversal`)) return
  db.prepare('INSERT INTO ledger (account, kind, amount, ref) SELECT account, kind, -amount, ? FROM ledger WHERE ref = ?').run(`listing:${l.id}:reversal`, `listing:${l.id}`)
}
