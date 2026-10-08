import { notFound } from 'next/navigation'
import { db } from '../../../lib/db.ts'

type Msg = { id: number; created_at: string; channel: string; to: string; subject: string | null; body: string }

// Turn http(s) URLs in a message into links.
function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/).map((part, i) =>
    i % 2 ? <a key={i} href={part}>{part}</a> : part,
  )
}

export default function Outbox() {
  if (process.env.NODE_ENV === 'production') notFound()
  const msgs = db.prepare('SELECT id, created_at, channel, "to", subject, body FROM outbox ORDER BY id DESC LIMIT 200').all() as Msg[]
  return (
    <>
      <h1>Dev outbox</h1>
      <p className="muted">Simulated email/SMS. Nothing leaves this machine.</p>
      {msgs.map((m) => (
        <div className="card" key={m.id}>
          <div className="muted">#{m.id} · {m.created_at} · {m.channel} to {m.to}</div>
          {m.subject && <strong>{m.subject}</strong>}
          <pre>{linkify(m.body)}</pre>
        </div>
      ))}
      {msgs.length === 0 && <p>No messages yet.</p>}
    </>
  )
}
