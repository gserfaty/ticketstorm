import { db } from './db.ts'
import { refundOrder } from './orders.ts'

// Anti-scalper flagging. A "cluster" is one event whose live orders came from SCALPER_ACCOUNTS or more different accounts (by email) that share
// a card fingerprint (HMAC of the card number, never the number) or a client IP. The accounts are flagged for review (users.flagged) and an admin
// can cancel and refund the whole cluster's orders through the shared refund function. 'local' (IP unknown, no TRUST_PROXY) is never a cluster key.
// ponytail: the thresholds are constants and the test card 4242... is shared by every tester, so three accounts using it on one event trip this on purpose.
export const SCALPER_ACCOUNTS = 3
const LIVE = "('paid','review','partially_refunded')"

export type Cluster = { eventId: number; title: string; kind: 'card' | 'ip'; key: string; accounts: { account: string; userId: number | null; orders: { id: number; status: string }[] }[] }
const COL = { card: 'card_fp', ip: 'ip' } as const

type Row = { event_id: number; title: string; k: string; account: string; user_id: number | null; oid: number; status: string }
function rows(kind: 'card' | 'ip', eventId?: number): Row[] {
  const c = COL[kind]
  return db
    .prepare(
      `SELECT o.event_id, e.title, o.${c} AS k, lower(o.email) AS account, o.user_id, o.id AS oid, o.status FROM orders o JOIN events e ON e.id = o.event_id
       WHERE o.${c} IS NOT NULL AND o.${c} != 'local' AND o.status IN ${LIVE} AND coalesce(o.source, '') NOT IN ('comp', 'resale') AND (? IS NULL OR o.event_id = ?)
         AND (SELECT count(DISTINCT lower(o2.email)) FROM orders o2 WHERE o2.event_id = o.event_id AND o2.${c} = o.${c} AND o2.status IN ${LIVE} AND coalesce(o2.source, '') NOT IN ('comp', 'resale')) >= ?
       ORDER BY o.event_id, o.${c}, o.id`,
    )
    .all(eventId ?? null, eventId ?? null, SCALPER_ACCOUNTS) as Row[]
}

export function clusters(eventId?: number): Cluster[] {
  const out = new Map<string, Cluster>()
  for (const kind of ['card', 'ip'] as const) {
    for (const r of rows(kind, eventId)) {
      const id = `${r.event_id}|${kind}|${r.k}`
      const c = out.get(id) ?? { eventId: r.event_id, title: r.title, kind, key: r.k, accounts: [] }
      let a = c.accounts.find((x) => x.account === r.account)
      if (!a) c.accounts.push((a = { account: r.account, userId: r.user_id, orders: [] }))
      a.orders.push({ id: r.oid, status: r.status })
      out.set(id, c)
    }
  }
  return [...out.values()]
}

// Called inside the order's transaction: if this order completes a cluster, flag its registered accounts once and leave an audit row (no human actor).
export function flagScalpers(orderId: number) {
  const o = db.prepare('SELECT event_id FROM orders WHERE id = ?').get(orderId) as { event_id: number }
  const fresh: number[] = []
  for (const c of clusters(o.event_id)) {
    if (!c.accounts.some((a) => a.orders.some((x) => x.id === orderId))) continue
    for (const a of c.accounts) if (a.userId && db.prepare('UPDATE users SET flagged = 1 WHERE id = ? AND flagged = 0').run(a.userId).changes === 1) fresh.push(a.userId)
  }
  if (fresh.length) db.prepare("INSERT INTO audit_log (actor_id, action, target, data) VALUES (NULL, 'scalper.flag', ?, ?)").run(`event:${o.event_id}`, JSON.stringify({ users: fresh, order: orderId }))
}

// Admin: cancel and refund every live order of one cluster, each in its own transaction through refundOrder (the one refund function).
// The cluster is recomputed from the database; nothing but the key comes from the form.
export function cancelCluster(eventId: number, kind: string, key: string): { cancelled: number[]; failed: { id: number; why: string }[] } {
  if (kind !== 'card' && kind !== 'ip') throw new Error('Unknown cluster kind')
  const c = clusters(eventId).find((x) => x.kind === kind && x.key === key)
  const cancelled: number[] = []
  const failed: { id: number; why: string }[] = []
  for (const o of c?.accounts.flatMap((a) => a.orders) ?? []) {
    try {
      refundOrder(o.id, { reason: 'scalper_policy' })
      cancelled.push(o.id)
    } catch (e) {
      failed.push({ id: o.id, why: (e as Error).message })
    }
  }
  return { cancelled, failed }
}
