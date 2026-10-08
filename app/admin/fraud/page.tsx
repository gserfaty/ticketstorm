import Link from 'next/link'
import Flash from '../../../components/Flash.tsx'
import { db } from '../../../lib/db.ts'
import { requireAdmin } from '../../../lib/session.ts'
import { blocklistAdd, blocklistRemove, setUserFlag } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function Fraud({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const flagged = db.prepare("SELECT id, email, name FROM users WHERE flagged = 1 ORDER BY id").all() as { id: number; email: string; name: string }[]
  const keys = db.prepare("SELECT key, sum(count) AS hits FROM rate_limits WHERE key NOT LIKE 'captcha:%' GROUP BY key ORDER BY hits DESC LIMIT 15").all() as { key: string; hits: number }[]
  const block = db.prepare('SELECT id, kind, value FROM blocklist ORDER BY id DESC').all() as { id: number; kind: string; value: string }[]
  const review = (db.prepare("SELECT count(*) AS n FROM orders WHERE status = 'review'").get() as { n: number }).n
  return (
    <>
      <h1>Fraud and bots</h1>
      <Flash {...(await searchParams)} />
      <p><Link href="/admin/review">Order review queue</Link> ({review} waiting)</p>
      <h2>Flagged users</h2>
      {flagged.map((u) => (
        <div className="card" key={u.id}>
          {u.name} &lt;{u.email}&gt;
          <form action={setUserFlag} className="buy"><input type="hidden" name="userId" value={u.id} /><input type="hidden" name="flagged" value="0" /><input type="hidden" name="back" value="fraud" /><button>Unflag</button></form>
        </div>
      ))}
      {!flagged.length && <p>None. Flag users from <Link href="/admin/users">Users</Link>.</p>}
      <h2>Busiest rate-limit keys (last hour)</h2>
      <table><tbody>{keys.map((k) => <tr key={k.key}><td><code>{k.key}</code></td><td>{k.hits}</td></tr>)}</tbody></table>
      <h2>Blocklist</h2>
      <form action={blocklistAdd} className="row">
        <select name="kind" aria-label="Kind"><option value="ip">IP</option><option value="email">Email</option></select>
        <input name="value" placeholder="IP or email" aria-label="Value" required /> <button>Block</button>
      </form>
      {block.map((b) => (
        <div className="card" key={b.id}>{b.kind}: {b.value}
          <form action={blocklistRemove} className="buy"><input type="hidden" name="id" value={b.id} /><button>Remove</button></form>
        </div>
      ))}
    </>
  )
}
