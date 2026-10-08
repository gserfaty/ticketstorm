'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { addCard, deleteAccount, deleteCard, saveAlertArea, savePrefs, setDefaultCard, setVendorLink, updateProfile } from '../../lib/account.ts'
import { allowed, clientIp } from '../../lib/defense.ts'
import { UserError } from '../../lib/platform.ts'
import { requestPayout } from '../../lib/payouts.ts'
import { logout, requireSelf } from '../../lib/session.ts'
import { setTwofa } from '../../lib/twofa.ts'

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

// Run `fn` for the logged-in user, then go back to `page` with a notice (or the UserError message).
async function run(page: string, fn: (userId: number) => void, ok: string, needsPassword = false): Promise<never> {
  const user = await requireSelf()
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
  await run('profile', (id) => updateProfile(id, { name: field(f, 'name'), phone: field(f, 'phone'), password: String(f.get('password') ?? ''), address: { line1: field(f, 'line1'), city: field(f, 'city'), state: field(f, 'state'), zip: field(f, 'zip') } }), 'Profile saved', true)
}

export async function removeCard(f: FormData) {
  await run('payment', (id) => deleteCard(id, Number(field(f, 'cardId'))), 'Card removed')
}

// Wallet: the card number is read here, validated and fingerprinted by lib/account.ts addCard, and goes no further. Only brand, last four and expiry are kept.
export async function addWalletCard(f: FormData) {
  await run('payment', (id) => addCard(id, { number: field(f, 'number').replace(/[\s-]/g, ''), exp: field(f, 'exp'), cvc: field(f, 'cvc') }, f.get('default') === 'on'), 'Card added')
}

export async function makeDefaultCard(f: FormData) {
  await run('payment', (id) => setDefaultCard(id, Number(field(f, 'cardId'))), 'Default card updated')
}

// Simulated vendor linking: records the choice only.
export async function toggleVendor(f: FormData) {
  const on = field(f, 'on') === '1'
  await run('linked', (id) => setVendorLink(id, field(f, 'vendor'), on), on ? 'Linked (simulation: nothing was imported)' : 'Unlinked')
}

export async function saveNotifications(f: FormData) {
  await run('notifications', (id) => savePrefs(id, f.getAll('pref').map(String)), 'Preferences saved')
}

export async function saveAlertAreaAction(f: FormData) {
  await run('notifications', (id) => saveAlertArea(id, field(f, 'city'), field(f, 'radius')), 'Alert area saved')
}

// Turn 2FA on or off. Both ask for the password again.
export async function toggleTwofa(f: FormData) {
  const on = field(f, 'on') === '1'
  await run('security', (id) => setTwofa(id, String(f.get('password') ?? ''), on), on ? 'Two-factor login is on' : 'Two-factor login is off', true)
}

export async function removeAccount(f: FormData) {
  const user = await requireSelf()
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

// Seller payout: the amount is checked against the ledger balance inside one transaction (lib/payouts.ts).
export async function requestPayoutAction(f: FormData) {
  await run('payouts', (id) => {
    const m = /^(\d{1,7})(\.\d{1,2})?$/.exec(field(f, 'amount'))
    requestPayout(`user:${id}`, id, m ? Math.round(Number(field(f, 'amount')) * 100) : 0)
  }, 'Payout requested. An admin will review it.')
}
