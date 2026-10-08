'use server'

import { redirect } from 'next/navigation'
import { clearPriceAlert, setPriceAlert } from '../../lib/pricealerts.ts'
import { UserError } from '../../lib/platform.ts'
import { db } from '../../lib/db.ts'
import { requireSelf } from '../../lib/session.ts'

const back = (slug: string, key: 'notice' | 'error', msg: string): never => redirect(`/events/${encodeURIComponent(slug)}?${key}=${encodeURIComponent(msg)}`)

// Price alert for the logged-in fan only (the account is the session's, never a form field). Refused while an admin is viewing as the user.
export async function priceAlert(f: FormData) {
  const user = await requireSelf()
  const e = db.prepare('SELECT id, slug FROM events WHERE id = ?').get(Number(f.get('eventId'))) as { id: number; slug: string } | undefined
  if (!e) redirect('/')
  try {
    if (f.get('clear')) clearPriceAlert(user.id, e!.id)
    else setPriceAlert(user.id, e!.id, String(f.get('target') ?? ''))
  } catch (err) {
    if (err instanceof UserError) back(e!.slug, 'error', err.message)
    throw err
  }
  back(e!.slug, 'notice', f.get('clear') ? 'Price alert removed' : 'Price alert saved. We will tell you once when tickets reach your price.')
}
