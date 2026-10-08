'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { FAV_KINDS, targetExists, toggleFavorite } from '../../lib/favorites.ts'
import type { FavKind } from '../../lib/favorites.ts'
import { getUser } from '../../lib/session.ts'

// Same-host referer path, so the heart returns you to the page you were on.
async function backPath() {
  const h = await headers()
  try {
    const u = new URL(h.get('referer') ?? '')
    if (u.host === h.get('host')) return u.pathname + u.search
  } catch {}
  return '/favorites'
}

export async function toggleFav(f: FormData) {
  const kind = String(f.get('kind')) as FavKind
  const ref = Number(f.get('ref'))
  const back = await backPath()
  const user = await getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(back)}`) // guests log in first
  if (!FAV_KINDS.includes(kind) || !Number.isInteger(ref) || !targetExists(kind, ref)) redirect(back)
  toggleFavorite(user!.id, kind, ref)
  redirect(back)
}
