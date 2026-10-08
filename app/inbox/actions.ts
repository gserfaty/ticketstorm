'use server'

import { revalidatePath } from 'next/cache'
import { db } from '../../lib/db.ts'
import { requireUser } from '../../lib/session.ts'

export async function markRead(f: FormData) {
  const user = await requireUser()
  const id = Number(f.get('id'))
  if (Number.isInteger(id)) db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(new Date().toISOString(), id, user.id)
  revalidatePath('/', 'layout')
}

export async function markAllRead() {
  const user = await requireUser()
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(new Date().toISOString(), user.id)
  revalidatePath('/', 'layout')
}
