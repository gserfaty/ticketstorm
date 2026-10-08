import Link from 'next/link'
import Flash from '../../../../components/Flash.tsx'
import NewKey from '../../../../components/NewKey.tsx'
import { db } from '../../../../lib/db.ts'
import { fmtDateTime } from '../../../../lib/format.ts'
import { APP_URL } from '../../../../lib/notify.ts'
import { MANAGE_ROLES } from '../../../../lib/organizer.ts'
import { requireOrgRole } from '../../../../lib/session.ts'
import { addWebhookAction, createApiKeyAction, removeWebhookAction, revokeApiKeyAction } from '../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Developers({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const orgId = Number((await params).orgId)
  await requireOrgRole(orgId, MANAGE_ROLES)
  const keys = db.prepare('SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE org_id = ? ORDER BY id DESC').all(orgId) as { id: number; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }[]
  const hooks = db.prepare('SELECT id, url, secret, (SELECT count(*) FROM outbox WHERE channel = \'webhook\' AND "to" = webhooks.url) AS sent FROM webhooks WHERE org_id = ? ORDER BY id').all(orgId) as { id: number; url: string; secret: string; sent: number }[]
  const events = db.prepare("SELECT id, title FROM events WHERE org_id = ? AND status != 'draft' ORDER BY starts_at LIMIT 20").all(orgId) as { id: number; title: string }[]
  return (
    <>
      <h1>Developers</h1>
      <p><Link href={`/organizer/${orgId}`}>Back to organization</Link></p>
      <Flash {...(await searchParams)} />

      <h2>API keys</h2>
      <p className="muted">Read-only: <code>GET {APP_URL}/api/v1/events</code> with <code>Authorization: Bearer tsk_...</code> lists this organization&apos;s events (no buyers, no personal data). 60 requests a minute per key. Keys are stored as a hash.</p>
      <NewKey action={createApiKeyAction} orgId={orgId} />
      {keys.map((k) => (
        <div className="card row" key={k.id}>
          <code>{k.prefix}…</code> {k.name} · created {fmtDateTime(k.created_at, 'UTC')} UTC · {k.last_used_at ? `last used ${fmtDateTime(k.last_used_at, 'UTC')} UTC` : 'never used'} ·{' '}
          {k.revoked_at ? <span className="badge cancelled">revoked</span> : <form action={revokeApiKeyAction}><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="keyId" value={k.id} /><button>Revoke</button></form>}
        </div>
      ))}

      <h2>Webhooks</h2>
      <p className="muted">Events (<code>order.created</code>, <code>order.refunded</code>) are signed with HMAC-SHA256 using the secret, sent as <code>X-TicketStorm-Signature: sha256=…</code> over the exact body, and logged to the <Link href="/dev/outbox">dev outbox</Link> (webhook channel) instead of the network in this demo.</p>
      {hooks.map((h) => (
        <div className="card" key={h.id}>
          <code>{h.url}</code> · {h.sent} logged · secret <code>{h.secret}</code>
          <form action={removeWebhookAction}><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="webhookId" value={h.id} /><button>Remove</button></form>
        </div>
      ))}
      <form action={addWebhookAction} className="stack">
        <input type="hidden" name="orgId" value={orgId} />
        <input name="url" type="url" placeholder="https://example.com/hooks/ticketstorm" required aria-label="Webhook URL" />
        <button>Add webhook</button>
      </form>

      <h2>Embeddable widget</h2>
      <p className="muted">Paste the snippet into your site. The card only links back to TicketStorm (opens in a new tab); nothing inside the frame logs in or buys.</p>
      {events.map((e) => (
        <div className="card" key={e.id}>
          <strong>{e.title}</strong>
          <pre>{`<iframe src="${APP_URL}/embed/event/${e.id}" width="360" height="200" style="border:0" title="${e.title.replace(/"/g, '&quot;')} on TicketStorm"></iframe>`}</pre>
          <a href={`/embed/event/${e.id}`} target="_blank" rel="noopener">Preview</a>
        </div>
      ))}

      <h2>Customer data</h2>
      <p className="muted">Download your own buyers (email, name, orders, tickets, spend) for events of this organization. Each download is recorded in the audit log.</p>
      <p><a className="btn" href={`/organizer/${orgId}/customers/csv`}>Download customers CSV</a></p>
    </>
  )
}
