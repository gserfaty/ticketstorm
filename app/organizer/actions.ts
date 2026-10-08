'use server'

import { notFound, redirect } from 'next/navigation'
import { db } from '../../lib/db.ts'
import { parseLocal } from '../../lib/format.ts'
import { refundEvent } from '../../lib/orders.ts'
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
  const sub = ['pricing', 'inventory'].includes(text(f, 'page')) ? `/${text(f, 'page')}` : ''
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
  run(e.back, () => { org.addLevel(e.id, text(f, 'name'), text(f, 'price'), text(f, 'type'), text(f, 'color')); audit(e.user.id, 'level.add', `event:${e.id}`) })
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
  run(e.back, () => { org.setFees(e.id, { service_pct: f.get('service_pct'), facility_cents: f.get('facility_cents'), order_cents: f.get('order_cents') }); audit(e.user.id, 'fees.set', `event:${e.id}`) })
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
