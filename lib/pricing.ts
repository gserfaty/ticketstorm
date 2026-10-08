import { db } from './db.ts'
import { UserError } from './platform.ts'

export type FeeRule = { service_pct: number; facility_cents: number; order_cents: number; delivery_cents?: number }
export const DEFAULT_FEES: FeeRule = { service_pct: 10, facility_cents: 300, order_cents: 250, delivery_cents: 0 }

// Platform defaults (/admin/fees, settings.fee_defaults) over the built-ins.
export function feeDefaults(): FeeRule {
  const s = db.prepare("SELECT value FROM settings WHERE key = 'fee_defaults'").get() as { value: string } | undefined
  return { ...DEFAULT_FEES, ...(s ? JSON.parse(s.value) : {}) }
}

const whole = (v: unknown, min: number, max: number, what: string) => {
  const n = Number(v)
  if (v === '' || v === null || !Number.isInteger(n) || n < min || n > max) throw new UserError(`${what} must be a whole number from ${min} to ${max}`)
  return n
}

// Admin-only writers (the caller audits). Existing holds keep their face price; new quotes use the new fees/tax at once.
export function setFeeDefaults(f: Record<keyof FeeRule, unknown>) {
  const rule: FeeRule = {
    service_pct: whole(f.service_pct, 0, 50, 'Service fee %'), facility_cents: whole(f.facility_cents, 0, 100_000, 'Facility charge (cents)'),
    order_cents: whole(f.order_cents, 0, 100_000, 'Order fee (cents)'), delivery_cents: whole(f.delivery_cents, 0, 100_000, 'Delivery fee (cents)'),
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('fee_defaults', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(rule))
  return rule
}

export function setCityTax(cityId: number, bps: unknown) {
  const n = whole(bps, 0, 3000, 'Tax rate (basis points)')
  if (db.prepare('UPDATE cities SET tax_rate_bps = ? WHERE id = ?').run(n, cityId).changes !== 1) throw new UserError('Unknown city')
  return n
}

// Fee rule and tax for an event: the event's own fee_rule overrides the platform defaults; tax is the venue city's rate.
export type Ctx = { rule: FeeRule; bps: number }
export function pricingCtx(eventId: number): Ctx {
  const r = db
    .prepare('SELECT e.fee_rule, c.tax_rate_bps AS bps FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = v.city_id WHERE e.id = ?')
    .get(eventId) as { fee_rule: string | null; bps: number }
  return { rule: { ...feeDefaults(), ...(r.fee_rule ? JSON.parse(r.fee_rule) : {}) }, bps: r.bps }
}

export type Line = { inventoryId: number; eventId: number; label: string; base: number; unit: number; fee: number; tax: number; offerId?: number; offer?: string; listingId?: number }
export type AddonLine = { addonId: number; name: string; kind: string; qty: number; unit: number; taxEach: number }
// Merch, food and hospitality are taxed at the city rate; parking is not. No service or facility fees on any add-on.
const TAXED_ADDONS = ['merch', 'food', 'hospitality']
export type Quote = {
  lines: Line[]
  addons: AddonLine[]
  subtotal: number // tickets (after offers, before promo) + add-ons
  fees: number
  orderFee: number
  tax: number
  discount: number
  protection: number // opt-in ticket protection premium: protection_pct of the ticket face after the promo; not taxed, no fees; not part of subtotal
  total: number // subtotal + fees + tax - discount + protection; fees and tax are computed on the face AFTER the promo discount
  promo?: { id: number; code: string }
  promoError?: string
}

// Pure money math. Per ticket: face + service % + facility charge, then city tax on (face + those fees);
// plus one per-order processing/delivery fee (untaxed). fees = sum(line fees) + orderFee, so total = subtotal + fees + tax.
export function price(units: number[], rule: FeeRule, taxBps: number) {
  const lineFees = units.map((u) => (u > 0 ? Math.round((u * rule.service_pct) / 100) + rule.facility_cents : 0))
  const lineTax = units.map((u, i) => Math.round(((u + lineFees[i]) * taxBps) / 10000))
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const subtotal = sum(units)
  const orderFee = units.length ? rule.order_cents + (rule.delivery_cents ?? 0) : 0
  const fees = sum(lineFees) + orderFee
  const tax = sum(lineTax)
  return { subtotal, fees, orderFee, tax, total: subtotal + fees + tax, lineFees, lineTax }
}

// ---- dynamic / platinum pricing ----
export type Dyn = { price_cents: number; dyn_min_cents: number | null; dyn_max_cents: number | null; dyn_k: number | null; dyn_j: number | null }
export type Demand = { soldPct: number; queueFactor: number }
const QUEUE_FRESH_MS = 120_000 // a waiting entry counts only if it joined or polled in the last 2 minutes
const QUEUE_FULL = 100 // this many people waiting = queue factor 1

// price = clamp(base * (1 + k * sold% + j * queueDepthFactor), min, max). No min -> base; no max -> uncapped. k = j = 0 -> base.
export function dynamicPrice(l: Dyn, d: Demand): number {
  const raw = Math.round(l.price_cents * (1 + (l.dyn_k ?? 0) * d.soldPct + (l.dyn_j ?? 0) * d.queueFactor))
  return Math.min(Math.max(raw, l.dyn_min_cents ?? l.price_cents), l.dyn_max_cents ?? Infinity)
}

// sold% = sold units / sellable (non-blocked) units of the event; queue factor = people still waiting, capped at 1.
export function demand(eventId: number): Demand {
  const r = db.prepare("SELECT coalesce(sum(status = 'sold'), 0) AS sold, count(*) AS total FROM inventory WHERE event_id = ? AND status != 'blocked'").get(eventId) as { sold: number; total: number }
  const q = db.prepare('SELECT count(*) AS n FROM queue_entries WHERE event_id = ? AND admitted_at IS NULL AND seen_at > ?').get(eventId, new Date(Date.now() - QUEUE_FRESH_MS).toISOString()) as { n: number }
  return { soldPct: r.total ? r.sold / r.total : 0, queueFactor: Math.min(q.n / QUEUE_FULL, 1) }
}

// Fix the face price on rows that were just held. Quote and finalize read inventory.locked_cents from now on.
// Must run inside the hold's tx.
export function lockPrices(ids: number[]) {
  const rows = db
    .prepare(
      `SELECT i.id, i.event_id, pl.price_cents, pl.dyn_min_cents, pl.dyn_max_cents, pl.dyn_k, pl.dyn_j
       FROM inventory i JOIN price_levels pl ON pl.id = i.price_level_id WHERE i.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as (Dyn & { id: number; event_id: number })[]
  const seen = new Map<number, Demand>()
  const set = db.prepare('UPDATE inventory SET locked_cents = ? WHERE id = ?')
  for (const r of rows) {
    if (!seen.has(r.event_id)) seen.set(r.event_id, demand(r.event_id))
    set.run(dynamicPrice(r, seen.get(r.event_id)!), r.id)
  }
}

// ---- display: ONE helper for every price a fan sees before checkout ----
// All-in = face + the ticket's own fees + tax (what checkout charges per ticket). The per-order fee is not per ticket and is shown at checkout.
export function shown(cents: number, ctx: Ctx, allIn: boolean): number {
  if (!allIn || cents <= 0) return cents
  const p = price([cents], ctx.rule, ctx.bps)
  return cents + p.lineFees[0] + p.lineTax[0]
}

export type ShownLevel = { id: number; name: string; color: string | null; ticket_type: string; perks: string | null; bundle: boolean; cents: number }
// Levels with their CURRENT price (dynamic levels move with demand), cheapest first.
export function displayLevels(eventId: number, allIn: boolean): ShownLevel[] {
  const ctx = pricingCtx(eventId)
  const d = demand(eventId)
  const rows = db.prepare('SELECT * FROM price_levels WHERE event_id = ?').all(eventId) as (Dyn & { id: number; name: string; color: string | null; ticket_type: string; perks: string | null; event_ids: string | null })[]
  return rows
    .map((l) => ({ id: l.id, name: l.name, color: l.color, ticket_type: l.ticket_type, perks: l.perks, bundle: l.event_ids !== null, cents: shown(dynamicPrice(l, d), ctx, allIn) }))
    .sort((a, b) => a.cents - b.cents || a.id - b.id)
}

export function displayRange(eventId: number, allIn: boolean): [number, number] | null {
  const l = displayLevels(eventId, allIn)
  return l.length ? [l[0].cents, l[l.length - 1].cents] : null
}

// ---- promo codes ----
type Promo = { id: number; code: string; kind: 'pct' | 'fixed'; amount: number; max_uses: number; uses: number; expires_at: string | null }

// A code that is valid for this event right now: platform-wide, the org's, or this event's own. Throws UserError otherwise.
export function findPromo(code: string, eventId: number): Promo {
  const p = db
    .prepare(
      `SELECT p.id, p.code, p.kind, p.amount, p.max_uses, p.uses, p.expires_at FROM promo_codes p JOIN events e ON e.id = ?
       WHERE p.code = ? AND (p.event_id = e.id OR (p.event_id IS NULL AND (p.org_id IS NULL OR p.org_id = e.org_id)))`,
    )
    .get(eventId, code.trim()) as Promo | undefined
  // one message for unknown, expired and used-up codes, so guessing reveals nothing
  if (!p || (p.expires_at && p.expires_at <= new Date().toISOString()) || p.uses >= p.max_uses) throw new UserError('Invalid promo code')
  return p
}

// Never more than the ticket subtotal.
// Split a discount across ticket prices pro rata, whole cents, the remainder on the last priced ticket.
export function allocate(units: number[], discount: number): number[] {
  const sum = units.reduce((a, b) => a + b, 0)
  const out = units.map((u) => (sum ? Math.floor((discount * u) / sum) : 0))
  const last = units.map((u) => u > 0).lastIndexOf(true)
  if (last >= 0) out[last] += discount - out.reduce((a, b) => a + b, 0)
  return out
}

export const discountFor = (p: Pick<Promo, 'kind' | 'amount'>, subtotal: number) =>
  Math.min(p.kind === 'pct' ? Math.round((subtotal * p.amount) / 100) : p.amount, subtotal)

// ---- checkout options (promo, offers, add-ons) live on the hold so quote() is reproducible at finalize and after 3DS ----
export type Options = { promo?: string; offers?: Record<string, number>; addons?: Record<string, number>; protection?: boolean }

// Ticket protection price as a percent of the ticket subtotal (settings.protection_pct, default 8).
export function protectionPct(): number {
  const s = db.prepare("SELECT value FROM settings WHERE key = 'protection_pct'").get() as { value: string } | undefined
  return s ? Number(JSON.parse(s.value)) : 8
}
export const parseOptions = (s: string | null | undefined): Options => (s ? JSON.parse(s) : {})

export function setCheckoutOptions(holdId: number, sessionToken: string, input: { promo: string; offers: Record<number, number>; addons: Record<number, number>; protection?: boolean }) {
  const hold = db
    .prepare("SELECT event_id FROM holds WHERE id = ? AND session_token = ? AND status = 'active' AND expires_at > ?")
    .get(holdId, sessionToken, new Date().toISOString()) as { event_id: number } | undefined
  if (!hold) throw new UserError('Your hold expired')
  if (db.prepare("SELECT 1 FROM listings WHERE hold_id = ? AND status = 'active'").get(holdId)) throw new UserError('Promo codes, offers and add-ons do not apply to resale tickets')
  const out: Options = {}
  if (input.promo) out.promo = findPromo(input.promo, hold.event_id).code
  for (const [inv, offerId] of Object.entries(input.offers)) {
    if (!offerId) continue
    if (!db.prepare('SELECT 1 FROM inventory WHERE id = ? AND hold_id = ? AND event_id = ?').get(Number(inv), holdId, hold.event_id)) throw new UserError('Unknown ticket')
    if (!db.prepare('SELECT 1 FROM offers WHERE id = ? AND event_id = ?').get(offerId, hold.event_id)) throw new UserError('Unknown offer')
    ;(out.offers ??= {})[inv] = offerId
  }
  for (const [id, qty] of Object.entries(input.addons)) {
    if (!qty) continue
    const a = db.prepare('SELECT name, inventory - sold AS left FROM addons WHERE id = ? AND event_id = ?').get(Number(id), hold.event_id) as { name: string; left: number } | undefined
    if (!a) throw new UserError('Unknown add-on')
    if (!Number.isInteger(qty) || qty < 0 || qty > 8) throw new UserError('Choose 0 to 8 of an add-on')
    if (qty > a.left) throw new UserError(a.left ? `Only ${a.left} left: ${a.name}` : `${a.name} is sold out`)
    ;(out.addons ??= {})[id] = qty
  }
  if (input.protection) out.protection = true
  db.prepare('UPDATE holds SET options = ? WHERE id = ?').run(JSON.stringify(out), holdId)
}

// Quote for everything currently held by `holdId`. Face prices come from inventory.locked_cents (fixed at hold time), never the live
// level price. Bundle seats in the hold's other events are covered by the bundle price (unit 0).
export function quote(holdId: number): Quote {
  const hold = db.prepare('SELECT event_id, options FROM holds WHERE id = ?').get(holdId) as { event_id: number; options: string | null }
  const ctx = pricingCtx(hold.event_id)
  type R = { id: number; event_id: number; price_cents: number; level: string; section: string; row: string | null; number: number | null; listing_id?: number }
  const rows = db
    .prepare(
      `SELECT i.id, i.event_id, coalesce(i.locked_cents, pl.price_cents) AS price_cents, pl.name AS level, s.name AS section, st.row, st.number
       FROM inventory i JOIN price_levels pl ON pl.id = i.price_level_id JOIN sections s ON s.id = i.section_id LEFT JOIN seats st ON st.id = i.seat_id
       WHERE i.hold_id = ? ORDER BY i.id`,
    )
    .all(holdId) as R[]
  // a resale hold reserves one listing instead of inventory rows; the buyer pays the seller's asking price, no offers/promo/add-ons
  const resale = db
    .prepare(
      `SELECT i.id, i.event_id, l.price_cents, 'Verified Resale' AS level, s.name AS section, st.row, st.number, l.id AS listing_id
       FROM listings l JOIN tickets t ON t.id = l.ticket_id JOIN inventory i ON i.id = t.inventory_id JOIN sections s ON s.id = i.section_id
       LEFT JOIN seats st ON st.id = i.seat_id WHERE l.hold_id = ? AND l.status = 'active'`,
    )
    .all(holdId) as R[]
  rows.push(...resale)
  const opts = resale.length ? {} : parseOptions(hold.options)

  const offerOf = (invId: number) => {
    const id = opts.offers?.[invId]
    return id ? (db.prepare('SELECT id, name, pct_off FROM offers WHERE id = ? AND event_id = ?').get(id, hold.event_id) as { id: number; name: string; pct_off: number } | undefined) : undefined
  }
  const offers = rows.map((r) => (r.event_id === hold.event_id ? offerOf(r.id) : undefined))
  const units = rows.map((r, i) => (r.event_id === hold.event_id ? Math.round((r.price_cents * (100 - (offers[i]?.pct_off ?? 0))) / 100) : 0))
  // promo first: the discount is spread over the tickets and fees and tax are computed on what is left
  let promo: Promo | undefined
  let promoError: string | undefined
  if (opts.promo) {
    try {
      promo = findPromo(opts.promo, hold.event_id)
    } catch (e) {
      if (!(e instanceof UserError)) throw e
      promoError = e.message
    }
  }
  const faceTotal = units.reduce((a, b) => a + b, 0)
  const discount = promo ? discountFor(promo, faceTotal) : 0
  const share = allocate(units, discount)
  const p = price(units.map((u, i) => u - share[i]), ctx.rule, ctx.bps)
  const lines: Line[] = rows.map((r, i) => ({
    inventoryId: r.id,
    eventId: r.event_id,
    label: `${r.level} · ${r.row ? `Section ${r.section} Row ${r.row} Seat ${r.number}` : `General admission ${r.section}`}`,
    base: r.event_id === hold.event_id ? r.price_cents : 0,
    unit: units[i],
    fee: p.lineFees[i],
    tax: p.lineTax[i],
    ...(offers[i] ? { offerId: offers[i]!.id, offer: offers[i]!.name } : {}),
    ...(r.listing_id ? { listingId: r.listing_id } : {}),
  }))

  const addons: AddonLine[] = []
  for (const [id, qty] of Object.entries(opts.addons ?? {})) {
    const a = db.prepare('SELECT id, name, kind, price_cents FROM addons WHERE id = ? AND event_id = ?').get(Number(id), hold.event_id) as { id: number; name: string; kind: string; price_cents: number } | undefined
    if (a && qty > 0) addons.push({ addonId: a.id, name: a.name, kind: a.kind, qty, unit: a.price_cents, taxEach: TAXED_ADDONS.includes(a.kind) ? Math.round((a.price_cents * ctx.bps) / 10000) : 0 })
  }
  const addonTotal = addons.reduce((n, a) => n + a.qty * a.unit, 0)

  const addonTax = addons.reduce((n, a) => n + a.qty * a.taxEach, 0)
  const subtotal = faceTotal + addonTotal
  const tax = p.tax + addonTax
  // protection insures the tickets actually paid for (face after the promo); it is an insurance premium, so no fees and no tax
  const protection = opts.protection ? Math.round(((faceTotal - discount) * protectionPct()) / 100) : 0
  return {
    lines, addons, subtotal, fees: p.fees, orderFee: p.orderFee, tax, discount, protection, total: subtotal + p.fees + tax - discount + protection,
    ...(promo ? { promo: { id: promo.id, code: promo.code } } : {}),
    ...(promoError ? { promoError } : {}),
  }
}
