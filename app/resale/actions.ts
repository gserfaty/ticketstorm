'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '../../lib/db.ts'
import { allowed, clientIp } from '../../lib/defense.ts'
import { HoldError } from '../../lib/inventory.ts'
import { acceptOffer, makeOffer, rejectOffer, reservedFor, withdrawOffer } from '../../lib/offers.ts'
import { cancelListing, createListing, holdListing, updateListing } from '../../lib/resale.ts'
import { ensureSession, requireSelf } from '../../lib/session.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const id = (f: FormData, k: string) => (/^\d+$/.test(field(f, k)) ? Number(field(f, k)) : 0)
const go = (path: string, key: 'error' | 'notice', msg: string): never => redirect(`${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(msg)}`)

// "12.50" -> 1250. Whole dollars or up to 2 decimals, 6 digits max.
const toCents = (s: string) => (/^\d{1,6}(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : 0)

export async function sellTicket(f: FormData) {
  const user = await requireSelf()
  const back = '/sell'
  try {
    createListing(user.id, id(f, 'ticketId'), toCents(field(f, 'price')))
  } catch (e) {
    if (e instanceof HoldError) go(back, 'error', e.message)
    throw e
  }
  redirect('/listings?notice=' + encodeURIComponent('Listed for resale.'))
}

export async function editListingAction(f: FormData) {
  const user = await requireSelf()
  try {
    updateListing(user.id, id(f, 'listingId'), toCents(field(f, 'price')))
  } catch (e) {
    if (e instanceof HoldError) go('/listings', 'error', e.message)
    throw e
  }
  redirect('/listings?notice=' + encodeURIComponent('Price updated.'))
}

export async function cancelListingAction(f: FormData) {
  const user = await requireSelf()
  try {
    cancelListing(user.id, id(f, 'listingId'))
  } catch (e) {
    if (e instanceof HoldError) go('/listings', 'error', e.message)
    throw e
  }
  redirect('/listings?notice=' + encodeURIComponent('Listing cancelled.'))
}

// Guests may buy; the hold belongs to the session like any other. Lands on the normal checkout.
export async function buyListing(f: FormData) {
  const token = await ensureSession()
  const userId = (db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: number | null }).user_id
  const back = field(f, 'back').startsWith('/') && !field(f, 'back').startsWith('//') ? field(f, 'back') : '/'
  let holdId = 0
  try {
    holdId = holdListing(id(f, 'listingId'), { sessionToken: token, userId }).holdId
  } catch (e) {
    if (e instanceof HoldError) go(back, 'error', e.message)
    throw e
  }
  redirect(`/checkout/${holdId}`)
}

// ---- offers: every one is a fan action on a ticket or money, so requireSelf (an impersonating admin is refused) ----
export async function makeOfferAction(f: FormData) {
  const user = await requireSelf()
  const back = field(f, 'back').startsWith('/') && !field(f, 'back').startsWith('//') ? field(f, 'back') : '/'
  if (!allowed('offer', clientIp(await headers()), user.id, 10)) go(back, 'error', 'Too many offers, wait a minute')
  try {
    makeOffer(user.id, id(f, 'listingId'), toCents(field(f, 'price')))
  } catch (e) {
    if (e instanceof HoldError) go(back, 'error', e.message)
    throw e
  }
  go(back, 'notice', 'Offer sent. The seller has 48 hours to answer; follow it on your seller dashboard.')
}

const offerAction = (fn: (userId: number, offerId: number) => void, ok: string) => async (f: FormData) => {
  const user = await requireSelf()
  try {
    fn(user.id, id(f, 'offerId'))
  } catch (e) {
    if (e instanceof HoldError) go('/seller', 'error', e.message)
    throw e
  }
  go('/seller', 'notice', ok)
}
export const acceptOfferAction = offerAction(acceptOffer, 'Offer accepted. The ticket is reserved for the buyer for 30 minutes.')
export const rejectOfferAction = offerAction(rejectOffer, 'Offer declined.')
export const withdrawOfferAction = offerAction(withdrawOffer, 'Offer withdrawn.')

export async function checkoutOfferAction(f: FormData) {
  const user = await requireSelf()
  const token = await ensureSession()
  let holdId = 0
  try {
    holdId = holdListing(reservedFor(user.id, id(f, 'offerId')), { sessionToken: token, userId: user.id }).holdId
  } catch (e) {
    if (e instanceof HoldError) go('/seller', 'error', e.message)
    throw e
  }
  redirect(`/checkout/${holdId}`)
}
