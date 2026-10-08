'use server'

import { redirect } from 'next/navigation'
import { stopImpersonation } from '../../lib/session.ts'

// Available to the impersonation session itself (the target user is not an admin); signs the admin back in.
export async function stopViewingAs() {
  await stopImpersonation()
  redirect('/admin/users')
}
