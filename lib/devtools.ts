import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from './db.ts'
import { hit } from './defense.ts'
import { APP_URL } from './notify.ts'
import { UserError } from './platform.ts'

// ---- API keys: `tsk_` + 48 hex chars (192 bits). Only the SHA-256 hash is stored (the key is that random, so a fast hash is enough). ----
const hash = (key: string) => createHash('sha256').update(key).digest('hex')

export function createApiKey(orgId: number, name: string, userId: number): string {
  if (!name || name.length > 60) throw new UserError('Give the key a name (60 characters max)')
  if ((db.prepare('SELECT count(*) AS n FROM api_keys WHERE org_id = ? AND revoked_at IS NULL').get(orgId) as { n: number }).n >= 10) throw new UserError('At most 10 active keys per organization')
  const key = `tsk_${randomBytes(24).toString('hex')}`
  db.prepare('INSERT INTO api_keys (org_id, name, prefix, key_hash, created_by) VALUES (?,?,?,?,?)').run(orgId, name, key.slice(0, 8), hash(key), userId)
  return key // shown once; never recoverable
}

export function revokeApiKey(orgId: number, keyId: number) {
  if (db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), keyId, orgId).changes !== 1) throw new UserError('Key not found')
}

// The org (and key id) behind an `Authorization: Bearer tsk_...` header, or undefined. Revoked keys and suspended orgs fail like unknown keys.
export function authenticateKey(header: string | null): { orgId: number; keyId: number } | undefined {
  const m = /^Bearer (tsk_[0-9a-f]{48})$/.exec(header ?? '')
  if (!m) return undefined
  const k = db
    .prepare("SELECT k.id, k.org_id FROM api_keys k JOIN orgs o ON o.id = k.org_id WHERE k.key_hash = ? AND k.revoked_at IS NULL AND o.status = 'approved'")
    .get(hash(m[1])) as { id: number; org_id: number } | undefined
  if (!k) return undefined
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), k.id)
  return { orgId: k.org_id, keyId: k.id }
}

export const API_LIMIT = 60 // requests per minute per key
export const apiAllowed = (keyId: number) => hit(`api:key:${keyId}`, API_LIMIT)

// Read-only event list for ONE organization. Public event facts only: no orders, buyers, emails or counts of people.
export function apiEvents(orgId: number) {
  const rows = db
    .prepare(
      `SELECT e.id, e.slug, e.title, e.category, e.starts_at, e.status, e.onsale_at, v.name AS venue, c.name AS city, c.state,
         (SELECT min(price_cents) FROM price_levels WHERE event_id = e.id AND event_ids IS NULL) AS min_price_cents,
         (SELECT max(price_cents) FROM price_levels WHERE event_id = e.id AND event_ids IS NULL) AS max_price_cents
       FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = v.city_id WHERE e.org_id = ? AND e.status != 'draft' ORDER BY e.starts_at LIMIT 200`,
    )
    .all(orgId) as { slug: string }[]
  return rows.map((r) => ({ ...r, url: `${APP_URL}/events/${r.slug}` }))
}

// ---- webhooks: delivery is simulated by an outbox row (channel 'webhook'); the subject carries the HMAC signature of the body ----
export function addWebhook(orgId: number, url: string) {
  if (!/^https?:\/\/[^\s/$.?#][^\s]{0,300}$/.test(url)) throw new UserError('Enter an http(s) URL')
  if ((db.prepare('SELECT count(*) AS n FROM webhooks WHERE org_id = ?').get(orgId) as { n: number }).n >= 5) throw new UserError('At most 5 webhooks per organization')
  db.prepare('INSERT INTO webhooks (org_id, url, secret) VALUES (?,?,?)').run(orgId, url, `whsec_${randomBytes(24).toString('hex')}`)
}
export function removeWebhook(orgId: number, id: number) {
  if (db.prepare('DELETE FROM webhooks WHERE id = ? AND org_id = ?').run(id, orgId).changes !== 1) throw new UserError('Webhook not found')
}

export const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const want = Buffer.from(sign(secret, body), 'hex')
  const got = Buffer.from(signature, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

// Call inside the tx that causes the event. `data` must not contain personal data.
export function emitWebhook(orgId: number, type: string, data: Record<string, unknown>) {
  for (const w of db.prepare('SELECT url, secret FROM webhooks WHERE org_id = ?').all(orgId) as { url: string; secret: string }[]) {
    const body = JSON.stringify({ id: `evt_${randomBytes(8).toString('hex')}`, type, created: new Date().toISOString(), data })
    db.prepare("INSERT INTO outbox (channel, \"to\", subject, body) VALUES ('webhook', ?, ?, ?)").run(w.url, `${type} X-TicketStorm-Signature: sha256=${sign(w.secret, body)}`, body)
    console.log(`[outbox:webhook] to=${w.url} type=${type}`)
  }
}
