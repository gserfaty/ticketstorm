import { db } from './db.ts'
import { HoldError } from './inventory.ts'
import { UserError } from './platform.ts'

// Per-event transfer and resale rules (events.transfer_rule / resale_rule JSON, only the fields the organizer set) over platform defaults.
export type TransferRule = { enabled: boolean; deadline_hours: number | null }
export type ResaleRule = { enabled: boolean; min_pct: number; max_pct: number; seller_fee_pct: number; buyer_fee_pct: number }
export const DEFAULT_RESALE: ResaleRule = { enabled: true, min_pct: 0, max_pct: 300, seller_fee_pct: 10, buyer_fee_pct: 5 }

const json = (s: string | null | undefined) => (s ? (JSON.parse(s) as Record<string, unknown>) : {})
const whole = (v: unknown, min: number, max: number, what: string) => {
  const n = Number(v)
  if (v === '' || v === null || !Number.isInteger(n) || n < min || n > max) throw new UserError(`${what} must be a whole number from ${min} to ${max}`)
  return n
}
const check = (r: ResaleRule) => {
  if (r.min_pct > r.max_pct) throw new UserError('The floor cannot be above the ceiling')
  return r
}

export function resaleDefaults(): ResaleRule {
  const s = db.prepare("SELECT value FROM settings WHERE key = 'resale_defaults'").get() as { value: string } | undefined
  return { ...DEFAULT_RESALE, ...(s ? JSON.parse(s.value) : {}) }
}

export function resaleRule(eventId: number): ResaleRule {
  const e = db.prepare('SELECT resale_rule FROM events WHERE id = ?').get(eventId) as { resale_rule: string | null } | undefined
  return { ...resaleDefaults(), ...json(e?.resale_rule) }
}

export function transferRule(eventId: number): TransferRule {
  const e = db.prepare('SELECT transfer_rule FROM events WHERE id = ?').get(eventId) as { transfer_rule: string | null } | undefined
  return { enabled: true, deadline_hours: null, ...json(e?.transfer_rule) }
}

type ResaleForm = { enabled: unknown; min_pct: unknown; max_pct: unknown; seller_fee_pct: unknown; buyer_fee_pct: unknown }
const parseResale = (f: ResaleForm): ResaleRule => ({
  enabled: f.enabled === 'on' || f.enabled === true || f.enabled === '1',
  min_pct: whole(f.min_pct, 0, 1000, 'Floor %'), max_pct: whole(f.max_pct, 1, 1000, 'Ceiling %'),
  seller_fee_pct: whole(f.seller_fee_pct, 0, 50, 'Seller fee %'), buyer_fee_pct: whole(f.buyer_fee_pct, 0, 50, 'Buyer fee %'),
})

// Admin: platform defaults. Events that set their own rule keep it; the rest follow at once.
export function setResaleDefaults(f: ResaleForm) {
  const r = check(parseResale(f))
  db.prepare("INSERT INTO settings (key, value) VALUES ('resale_defaults', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(r))
  return r
}

// Organizer: per-event override (all fields). `inherit` removes the override.
export function setResaleRule(eventId: number, f: ResaleForm, inherit = false) {
  const r = inherit ? null : check(parseResale(f))
  db.prepare('UPDATE events SET resale_rule = ? WHERE id = ?').run(r ? JSON.stringify(r) : null, eventId)
  return r
}

export function setTransferRule(eventId: number, enabled: boolean, hours: unknown) {
  const deadline_hours = hours === '' || hours === null ? null : whole(hours, 1, 24 * 60, 'Deadline hours')
  db.prepare('UPDATE events SET transfer_rule = ? WHERE id = ?').run(JSON.stringify({ enabled, deadline_hours }), eventId)
}

// Last moment a transfer of a ticket to this event may be created or accepted, or null for "until the show".
export function transferCloses(eventId: number, startsAt: string): string | null {
  const r = transferRule(eventId)
  return r.deadline_hours === null ? null : new Date(Date.parse(startsAt) - r.deadline_hours * 3_600_000).toISOString()
}

// Server-side gate for transfer create AND accept.
export function assertTransferOpen(eventId: number, now = Date.now()) {
  const ev = db.prepare('SELECT starts_at FROM events WHERE id = ?').get(eventId) as { starts_at: string }
  const r = transferRule(eventId)
  if (!r.enabled) throw new HoldError('The organizer has turned off ticket transfers for this event')
  const closes = transferCloses(eventId, ev.starts_at)
  if (closes && now >= Date.parse(closes)) throw new HoldError(`Transfers for this event closed ${r.deadline_hours} hours before the show`)
}

// Organizer: how tickets reach the buyer and whether they can change hands. Printing and will-call are opt-in; mobile is always available.
export function setDeliveryRules(eventId: number, f: { print_ok: boolean; willcall_ok: boolean; non_transferable: boolean }) {
  db.prepare('UPDATE events SET print_ok = ?, willcall_ok = ?, non_transferable = ? WHERE id = ?').run(f.print_ok ? 1 : 0, f.willcall_ok ? 1 : 0, f.non_transferable ? 1 : 0, eventId)
}

export const DELIVERIES = ['mobile', 'print', 'willcall'] as const
export type Delivery = (typeof DELIVERIES)[number]
export const DELIVERY_LABEL: Record<Delivery, string> = { mobile: 'Mobile ticket', print: 'Print at home', willcall: 'Will-call (pick up at the box office)' }

// Server-side check of the delivery a buyer chose against what the event offers.
export function assertDelivery(eventId: number, d: string): Delivery {
  if (!(DELIVERIES as readonly string[]).includes(d)) throw new HoldError('Choose a delivery method', 400)
  const e = db.prepare('SELECT print_ok, willcall_ok FROM events WHERE id = ?').get(eventId) as { print_ok: number; willcall_ok: number }
  if (d === 'print' && !e.print_ok) throw new HoldError('This event is mobile-only: tickets cannot be printed', 409)
  if (d === 'willcall' && !e.willcall_ok) throw new HoldError('Will-call is not offered for this event', 409)
  return d as Delivery
}
