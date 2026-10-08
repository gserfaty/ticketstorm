import { db } from './db.ts'

// Append-only money log. Account is 'user:ID' | 'org:ID' | 'platform'. Call inside the tx that causes the entry.
export function ledgerAdd(account: string, kind: 'sale' | 'fee' | 'resale_credit' | 'refund' | 'payout', amount: number, ref: string) {
  db.prepare('INSERT INTO ledger (account, kind, amount, ref) VALUES (?,?,?,?)').run(account, kind, amount, ref)
}

export const balance = (account: string) =>
  (db.prepare('SELECT coalesce(sum(amount), 0) AS b FROM ledger WHERE account = ?').get(account) as { b: number }).b
