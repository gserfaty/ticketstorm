import { db } from './db.ts'

// Append-only, double-entry money log: every event writes rows that sum to ZERO, so `select sum(amount) from ledger` is always 0.
// A row's amount is the change in what the platform owes that account. Accounts:
//   user:ID / org:ID  what a seller or organizer can draw
//   platform          fees the platform keeps
//   tax               sales tax collected, owed to the city
//   payouts           requested payouts not yet paid out
//   cash              the other side of money that entered or left the platform (negative = money held)
// Call inside the tx that causes the entry.
export type LedgerKind = 'sale' | 'fee' | 'resale_credit' | 'refund' | 'payout'
export function ledgerAdd(account: string, kind: LedgerKind, amount: number, ref: string) {
  if (amount !== 0) db.prepare('INSERT INTO ledger (account, kind, amount, ref) VALUES (?,?,?,?)').run(account, kind, amount, ref)
}

export const balance = (account: string) =>
  (db.prepare('SELECT coalesce(sum(amount), 0) AS b FROM ledger WHERE account = ?').get(account) as { b: number }).b

export const ledgerTotal = () => (db.prepare('SELECT coalesce(sum(amount), 0) AS s FROM ledger').get() as { s: number }).s
