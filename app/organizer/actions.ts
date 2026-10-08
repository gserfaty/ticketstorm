'use server'

import { notFound, redirect } from 'next/navigation'
import { db, tx } from '../../lib/db.ts'
import * as access from '../../lib/access.ts'
import { parseLocal } from '../../lib/format.ts'
import { holdOrder, approveReview } from '../../lib/fraud.ts'
import { refundEvent, sendConfirmation } from '../../lib/orders.ts'
import { compTickets, moveSeat, ORDER_ROLES, refundFromForm } from '../../lib/orderadmin.ts'
import * as org from '../../lib/organizer.ts'
import { audit, UserError } from '../../lib/platform.ts'
import { requireOrgRole, requireUser } from '../../lib/session.ts'

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const num = (f: FormData, k: string) => Number(f.get(k))
const MANAGE = org.MANAGE_ROLES

// Run a mutation, then bounce back to `back` with a notice, or with the message if it was a UserError.
function run(back: string, fn: () => void, ok = 'Saved'): never {
  try {
    fn()
  } catch (e) {
    if (e instanceof UserError) redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(e.message)}`)
    throw e
  }
  redirect(`${back}?notice=${encodeURIComponent(ok)}`)
}

// Event actions: the org is read from the event row and the actor's role is checked against THAT org.
async function authEvent(f: FormData, roles = MANAGE) {
  const e = db.prepare('SELECT e.id, e.org_id, e.status, v.tz FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.id = ?').get(num(f, 'eventId')) as
    | { id: number; org_id: number; status: string; tz: string }
    | undefined
  if (!e) notFound()
  const { user } = await requireOrgRole(e!.org_id, roles)
  const sub = ['pricing', 'inventory', 'access', 'queue', 'orders'].includes(text(f, 'page')) ? `/${text(f, 'page')}` : ''
  return { ...e!, user, back: `/organizer/${e!.org_id}/events/${e!.id}${sub}` }
}

async function authVenue(f: FormData) {
  const v = db.prepare('SELECT id, org_id FROM venues WHERE id = ?').get(num(f, 'venueId')) as { id: number; org_id: number } | undefined
  if (!v) notFound()
  const { user } = await requireOrgRole(v!.org_id, MANAGE)
  return { ...v!, user, back: `/organizer/${v!.org_id}/venues/${v!.id}/chart` }
}

export async function signUpOrg(f: FormData) {
  const user = await requireUser()
  let id: number
  try {
    id = org.createOrg(user.id, text(f, 'name'))
  } catch (e) {
    if (e instanceof UserError) redirect(`/become-organizer?error=${encodeURIComponent(e.message)}`)
    throw e
  }
  audit(user.id, 'org.create', `org:${id}`)
  redirect(`/organizer/${id}?notice=${encodeURIComponent('Organization created. An admin must approve it before you can publish events.')}`)
}

function eventForm(f: FormData, tz: string): org.EventForm {
  const starts = text(f, 'startsAt')
  const doors = text(f, 'doorsAt')
  return {
    title: text(f, 'title'), category: text(f, 'category'), genre: text(f, 'genre'), venueId: num(f, 'venueId'),
    startsAt: parseLocal(starts, tz), doorsAt: doors ? parseLocal(doors, tz) : null, image: text(f, 'image'), description: text(f, 'description'),
  }
}

export async function createEventAction(f: FormData) {
  const orgId = num(f, 'orgId')
  const { user } = await requireOrgRole(orgId, MANAGE)
  const back = `/organizer/${orgId}/events/new`
  const venue = db.prepare('SELECT tz FROM venues WHERE id = ? AND org_id = ?').get(num(f, 'venueId'), orgId) as { tz: string } | undefined
  let id = 0
  try {
    id = org.createEvent(orgId, eventForm(f, venue?.tz ?? 'UTC'))
  } catch (e) {
    if (e instanceof UserError) redirect(`${back}?error=${encodeURIComponent(e.message)}`)
    throw e
  }
  audit(user.id, 'event.create', `event:${id}`)
  redirect(`/organizer/${orgId}/events/${id}?notice=Draft+created.+Add+price+levels%2C+then+publish.`)
}

export async function saveEvent(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.updateEvent(e.id, eventForm(f, e.tz)); audit(e.user.id, 'event.update', `event:${e.id}`) })
}

export async function publish(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.publishEvent(e.id); audit(e.user.id, 'event.publish', `event:${e.id}`) }, 'Published')
}

export async function cancelEvent(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => {
    if (!['published', 'postponed', 'rescheduled', 'cancelled'].includes(e.status)) throw new UserError('Only published events can be cancelled')
    const r = refundEvent(e.id)
    audit(e.user.id, 'event.cancel', `event:${e.id}`, r)
    if (r.failed) throw new UserError(`Cancelled. ${r.refunded} order(s) refunded; ${r.failed} refund(s) failed and were flagged for admin.`)
  }, 'Event cancelled and all orders refunded')
}

export async function changeDate(f: FormData) {
  const e = await authEvent(f)
  const kind = text(f, 'kind') === 'postponed' ? 'postponed' : 'rescheduled'
  run(e.back, () => { org.changeDate(e.id, kind, parseLocal(text(f, 'startsAt'), e.tz)); audit(e.user.id, `event.${kind}`, `event:${e.id}`) }, `Event ${kind}; ticket holders notified`)
}

export async function addLevel(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.addLevel(e.id, text(f, 'name'), text(f, 'price'), text(f, 'type'), text(f, 'color'), text(f, 'perks')); audit(e.user.id, 'level.add', `event:${e.id}`) })
}

export async function removeLevel(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.removeLevel(e.id, num(f, 'levelId')); audit(e.user.id, 'level.remove', `event:${e.id}`) })
}

export async function repriceLevel(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.repriceLevel(e.id, num(f, 'levelId'), text(f, 'price')); audit(e.user.id, 'level.reprice', `event:${e.id}`) })
}

export async function saveFees(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.setFees(e.id, { service_pct: f.get('service_pct'), facility_cents: f.get('facility_cents'), order_cents: f.get('order_cents'), delivery_cents: f.get('delivery_cents') }); audit(e.user.id, 'fees.set', `event:${e.id}`) })
}

export async function saveDynamic(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.setDynamic(e.id, num(f, 'levelId'), { min: text(f, 'min'), max: text(f, 'max'), k: text(f, 'k'), j: text(f, 'j') }); audit(e.user.id, 'level.dynamic', `event:${e.id}`, { levelId: num(f, 'levelId'), min: text(f, 'min'), max: text(f, 'max'), k: text(f, 'k'), j: text(f, 'j') }) })
}

export async function saveLimits(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.setLimits(e.id, f.get('order_limit'), f.get('ticket_limit')); audit(e.user.id, 'limits.set', `event:${e.id}`, { order: text(f, 'order_limit'), event: text(f, 'ticket_limit') }) })
}

// Promo codes: org_id comes from the event row, so a manager can only create and delete codes for their own org.
export async function addPromoAction(f: FormData) {
  const e = await authEvent(f)
  const exp = text(f, 'expiresAt')
  run(e.back, () => {
    if (exp && !parseLocal(exp, e.tz)) throw new UserError('Enter a valid expiry')
    org.addPromo(e.org_id, e.id, { code: text(f, 'code'), kind: text(f, 'kind'), amount: text(f, 'amount'), maxUses: f.get('maxUses'), expiresAt: exp ? parseLocal(exp, e.tz) : null, wholeOrg: f.get('scope') === 'org' })
    audit(e.user.id, 'promo.add', `event:${e.id}`, { code: text(f, 'code') })
  })
}

export async function removePromoAction(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.removePromo(e.org_id, num(f, 'promoId')); audit(e.user.id, 'promo.remove', `event:${e.id}`, { promoId: num(f, 'promoId') }) })
}

export async function expirePromoAction(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.expirePromo(e.org_id, num(f, 'promoId')); audit(e.user.id, 'promo.expire', `event:${e.id}`, { promoId: num(f, 'promoId') }) })
}

export async function saveOffer(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.setOffer(e.id, text(f, 'name'), f.get('pct')); audit(e.user.id, 'offer.set', `event:${e.id}`, { name: text(f, 'name'), pct: text(f, 'pct') }) })
}

export async function addAddonAction(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.addAddon(e.id, text(f, 'kind'), text(f, 'name'), text(f, 'price'), f.get('inventory')); audit(e.user.id, 'addon.add', `event:${e.id}`, { name: text(f, 'name') }) })
}

export async function removeAddonAction(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { org.removeAddon(e.id, num(f, 'addonId')); audit(e.user.id, 'addon.remove', `event:${e.id}`, { addonId: num(f, 'addonId') }) })
}

export async function saveOnsale(f: FormData) {
  const e = await authEvent(f)
  const v = text(f, 'onsaleAt')
  run(e.back, () => {
    const iso = v ? parseLocal(v, e.tz) : null
    if (v && !iso) throw new UserError('Enter a valid date and time')
    org.setOnsale(e.id, iso)
    audit(e.user.id, 'onsale.set', `event:${e.id}`, { iso })
  })
}

export async function inventoryAction(f: FormData) {
  const e = await authEvent(f)
  let n = 0
  run(e.back, () => {
    const op = text(f, 'op')
    n = org.applyInventory(e.id, num(f, 'sectionId'), text(f, 'row'), op, num(f, 'levelId') || undefined, num(f, 'from') || undefined, num(f, 'to') || undefined)
    audit(e.user.id, 'inventory.apply', `event:${e.id}`, { op, section: num(f, 'sectionId'), row: text(f, 'row'), n })
  }, 'Updated')
}

export async function createVenueAction(f: FormData) {
  const orgId = num(f, 'orgId')
  const { user } = await requireOrgRole(orgId, MANAGE)
  run(`/organizer/${orgId}`, () => {
    const id = org.createVenue(orgId, { name: text(f, 'name'), address: text(f, 'address'), cityId: num(f, 'cityId'), tz: text(f, 'tz'), kind: text(f, 'kind') })
    audit(user.id, 'venue.create', `venue:${id}`)
  }, 'Venue created')
}

export async function regenerateChart(f: FormData) {
  const v = await authVenue(f)
  run(v.back, () => { org.regenerateChart(v.id, text(f, 'kind')); audit(v.user.id, 'chart.generate', `venue:${v.id}`) }, 'Chart generated')
}

export async function importChart(f: FormData) {
  const v = await authVenue(f)
  run(v.back, () => { org.importChart(v.id, String(f.get('json') ?? '')); audit(v.user.id, 'chart.import', `venue:${v.id}`) }, 'Chart imported')
}

export async function flagSeats(f: FormData) {
  const v = await authVenue(f)
  run(v.back, () => {
    const n = org.flagSeats(v.id, num(f, 'sectionId'), text(f, 'row'), num(f, 'from'), num(f, 'to'), text(f, 'flag'), f.get('on') === '1')
    audit(v.user.id, 'chart.flag', `venue:${v.id}`, { n })
    if (!n) throw new UserError('No matching seats')
  })
}

// Members: only owners manage them. orgId comes from the form but requireOrgRole proves the actor is an owner of exactly that org.
export async function addMember(f: FormData) {
  const orgId = num(f, 'orgId')
  const { user } = await requireOrgRole(orgId, ['owner'])
  run(`/organizer/${orgId}/members`, () => { org.addMember(orgId, text(f, 'email'), text(f, 'role')); audit(user.id, 'member.set', `org:${orgId}`, { email: text(f, 'email'), role: text(f, 'role') }) })
}

export async function removeMember(f: FormData) {
  const orgId = num(f, 'orgId')
  const { user } = await requireOrgRole(orgId, ['owner'])
  run(`/organizer/${orgId}/members`, () => { org.removeMember(orgId, num(f, 'userId')); audit(user.id, 'member.remove', `org:${orgId}`, { userId: num(f, 'userId') }) })
}

export async function addWindowAction(f: FormData) {
  const e = await authEvent(f)
  const when = (k: string) => (text(f, k) ? parseLocal(text(f, k), e.tz) : null)
  run(e.back, () => {
    const id = access.addWindow(e.id, {
      name: text(f, 'name'), kind: text(f, 'kind'), startsAt: when('startsAt'), endsAt: when('endsAt'), requiresCode: f.get('requiresCode') === 'on',
      regStarts: when('regStarts'), regEnds: when('regEnds'), slots: num(f, 'slots'), buyBy: when('buyBy'),
    })
    audit(e.user.id, 'window.add', `event:${e.id}`, { windowId: id })
  }, 'Window added')
}

export async function generateCodesAction(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => { const n = access.generateCodes(e.id, num(f, 'windowId'), num(f, 'n'), num(f, 'maxUses')); audit(e.user.id, 'codes.generate', `event:${e.id}`, { windowId: num(f, 'windowId'), n }) }, 'Codes generated')
}

export async function assignWindowAction(f: FormData) {
  const e = await authEvent(f)
  let n = 0
  run(e.back, () => { n = access.assignWindow(e.id, num(f, 'windowId'), num(f, 'sectionId'), text(f, 'row')); audit(e.user.id, 'window.assign', `event:${e.id}`, { windowId: num(f, 'windowId'), section: num(f, 'sectionId'), row: text(f, 'row'), n }) }, 'Inventory updated')
}

export async function saveQueueAction(f: FormData) {
  const e = await authEvent(f)
  run(e.back, () => {
    const on = f.get('enabled') === 'on'
    access.setQueue(e.id, on, num(f, 'rate'), num(f, 'cap'))
    audit(e.user.id, 'queue.set', `event:${e.id}`, { on, rate: num(f, 'rate'), cap: num(f, 'cap') })
  })
}

// ---- orders of an event (box office tools) ----
// The order is loaded first and the actor is checked against the org that owns ITS event; nothing from the form is trusted for scoping.
async function authOrder(f: FormData) {
  const o = db.prepare('SELECT o.id, o.event_id, o.status, e.org_id FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = ?').get(num(f, 'orderId')) as
    | { id: number; event_id: number; status: string; org_id: number }
    | undefined
  if (!o) notFound()
  const { user } = await requireOrgRole(o!.org_id, ORDER_ROLES)
  return { ...o!, user, back: `/organizer/${o!.org_id}/events/${o!.event_id}/orders` }
}

export async function orderRefund(f: FormData) {
  const o = await authOrder(f)
  const mode = text(f, 'mode')
  run(o.back, () => {
    const r = refundFromForm(o.id, mode, f.getAll('item').map(Number), f.get('fees') === 'on', `organizer:${o.user.id}`)
    audit(o.user.id, `order.${mode === 'void' ? 'void' : 'refund'}`, `order:${o.id}`, { mode, items: f.getAll('item'), fees: f.get('fees') === 'on', amount: r.amount })
  }, 'Done')
}

export async function orderResend(f: FormData) {
  const o = await authOrder(f)
  run(o.back, () => { sendConfirmation(o.id); audit(o.user.id, 'order.resend', `order:${o.id}`) }, 'Tickets re-sent')
}

export async function orderHold(f: FormData) {
  const o = await authOrder(f)
  run(o.back, () => {
    if (!tx(() => holdOrder(o.id, 'organizer_hold'))) throw new UserError('Only a paid order can be held')
    audit(o.user.id, 'order.hold', `order:${o.id}`)
  }, 'Order held: its tickets stop working until released')
}

// An organizer can lift its own hold; a fraud-score hold stays with the admin review queue.
export async function orderRelease(f: FormData) {
  const o = await authOrder(f)
  run(o.back, () => {
    if (!approveReview(o.id, 'organizer_hold')) throw new UserError('Only holds placed by an organizer can be released here; the rest go through admin review')
    audit(o.user.id, 'order.release', `order:${o.id}`)
  }, 'Hold released')
}

export async function orderMove(f: FormData) {
  const o = await authOrder(f)
  run(o.back, () => {
    const t = db
      .prepare("SELECT t.id FROM tickets t JOIN order_items oi ON oi.order_id = t.order_id AND oi.inventory_id = t.inventory_id WHERE oi.id = ? AND oi.order_id = ? AND t.status = 'valid'")
      .get(num(f, 'itemId'), o.id) as { id: number } | undefined
    if (!t) throw new UserError('Only a valid ticket can be moved')
    const id = moveSeat(o.id, t.id, { section: text(f, 'section'), row: text(f, 'row'), number: text(f, 'number') ? num(f, 'number') : null })
    audit(o.user.id, 'order.move_seat', `order:${o.id}`, { ticket: t.id, newTicket: id })
  }, 'Seat moved; the old QR code no longer works')
}

export async function orderComp(f: FormData) {
  const e = await authEvent(f, ORDER_ROLES)
  run(`/organizer/${e.org_id}/events/${e.id}/orders`, () => {
    // one seat per line: "Section" for general admission or "Section, Row, Seat"
    const seats = text(f, 'seats').split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((p) => p[0]).map(([section, row = '', number = '']) => ({ section, row, number: number ? Number(number) : null }))
    const id = compTickets(e.id, text(f, 'email'), seats, text(f, 'note'))
    audit(e.user.id, 'order.comp', `order:${id}`, { event: e.id, email: text(f, 'email'), seats: seats.length })
  }, 'Complimentary tickets sent')
}
