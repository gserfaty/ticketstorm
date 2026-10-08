import { db, tx } from './db.ts'
import { balance, ledgerAdd } from './ledger.ts'
import { alertUser } from './alerts.ts'
import { money } from './format.ts'
import { UserError } from './platform.ts'

export type Payout = { id: number; created_at: string; account: string; amount: number; status: string; requested_by: number; decided_by: number | null; decided_at: string | null }

// Request money out of `account` ('user:ID' | 'org:ID'; the caller proved the actor may). The balance check and the debit are one BEGIN IMMEDIATE tx, so
// two concurrent requests cannot both pass. The debit itself reserves the funds: balance = what is still free to request.
export function requestPayout(account: string, actorId: number, amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new UserError('Enter an amount above $0')
  return tx(() => {
    const b = balance(account)
    if (amountCents > b) throw new UserError(`You can request at most ${money(Math.max(b, 0))}`)
    const id = Number(db.prepare('INSERT INTO payouts (account, amount, requested_by) VALUES (?,?,?)').run(account, amountCents, actorId).lastInsertRowid)
    ledgerAdd(account, 'payout', -amountCents, `payout:${id}`)
    ledgerAdd('payouts', 'payout', amountCents, `payout:${id}`)
    return id
  })
}

// Admin: paid (the money leaves: payouts -> cash) or rejected (funds go back to the account). Conditional on 'requested', so a payout is decided once.
export function decidePayout(payoutId: number, adminId: number, paid: boolean) {
  tx(() => {
    const p = db
      .prepare("UPDATE payouts SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'requested' RETURNING account, amount, requested_by")
      .get(paid ? 'paid' : 'rejected', adminId, new Date().toISOString(), payoutId) as { account: string; amount: number; requested_by: number } | undefined
    if (!p) throw new UserError('That payout was already decided')
    ledgerAdd('payouts', 'payout', -p.amount, `payout:${payoutId}:${paid ? 'paid' : 'rejected'}`)
    ledgerAdd(paid ? 'cash' : p.account, 'payout', p.amount, `payout:${payoutId}:${paid ? 'paid' : 'rejected'}`)
    alertUser(p.requested_by, 'orders', 'payout_decided', `payout:${payoutId}`, {
      title: paid ? `Payout of ${money(p.amount)} sent` : `Payout of ${money(p.amount)} rejected`,
      body: paid ? 'The money is on its way (simulated bank transfer).' : 'The amount is back in your balance.',
      link: p.account.startsWith('org:') ? `/organizer/${p.account.slice(4)}/payouts` : '/account/payouts',
    })
  })
}

export const payoutsOf = (account: string) => db.prepare('SELECT * FROM payouts WHERE account = ? ORDER BY id DESC LIMIT 50').all(account) as Payout[]
