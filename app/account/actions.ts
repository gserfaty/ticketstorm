'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { deleteAccount, deleteCard, savePrefs, updateProfile } from '../../lib/account.ts'
import { allowed, clientIp } from '../../lib/defense.ts'
import { UserError } from '../../lib/platform.ts'
import { logout, requireUser } from '../../lib/session.ts'
import { setTwofa } from '../../lib/twofa.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

// Run `fn` for the logged-in user, then go back to `page` with a notice (or the UserError message).
async function run(page: string, fn: (userId: number) => void, ok: string, needsPassword = false): Promise<never> {
  const user = await requireUser()
  // password-checking forms share one limit so they can't be used to guess the password
  if (needsPassword && !allowed('reauth', clientIp(await headers()), user.id, 5)) redirect(`/account/${page}?error=${encodeURIComponent('Too many attempts, wait a minute')}`)
  try {
    fn(user.id)
  } catch (e) {
    if (e instanceof UserError) redirect(`/account/${page}?error=${encodeURIComponent(e.message)}`)
    throw e
  }
  redirect(`/account/${page}?notice=${encodeURIComponent(ok)}`)
}

export async function saveProfile(f: FormData) {
  await run('profile', (id) => updateProfile(id, { name: field(f, 'name'), phone: field(f, 'phone'), address: { line1: field(f, 'line1'), city: field(f, 'city'), state: field(f, 'state'), zip: field(f, 'zip') } }), 'Profile saved')
}

export async function removeCard(f: FormData) {
  await run('payment', (id) => deleteCard(id, Number(field(f, 'cardId'))), 'Card removed')
}

export async function saveNotifications(f: FormData) {
  await run('notifications', (id) => savePrefs(id, f.getAll('pref').map(String)), 'Preferences saved')
}

// Turn 2FA on or off. Both ask for the password again.
export async function toggleTwofa(f: FormData) {
  const on = field(f, 'on') === '1'
  await run('security', (id) => setTwofa(id, String(f.get('password') ?? ''), on), on ? 'Two-factor login is on' : 'Two-factor login is off', true)
}

export async function removeAccount(f: FormData) {
  const user = await requireUser()
  if (!allowed('reauth', clientIp(await headers()), user.id, 5)) redirect(`/account/privacy?error=${encodeURIComponent('Too many attempts, wait a minute')}`)
  try {
    deleteAccount(user.id, String(f.get('confirm') ?? ''))
  } catch (e) {
    if (e instanceof UserError) redirect(`/account/privacy?error=${encodeURIComponent(e.message)}`)
    throw e
  }
  await logout()
  redirect('/')
}
