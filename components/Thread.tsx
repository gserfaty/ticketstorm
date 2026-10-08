import { fmtDateTime } from '../lib/format.ts'
import type { Msg } from '../lib/support.ts'

// Support conversation. Text is rendered by React (escaped); pre-wrap keeps line breaks.
export default function Thread({ messages }: { messages: Msg[] }) {
  return (
    <>
      {messages.map((m, i) => (
        <div className="card" key={i}>
          <strong>{m.staff ? `${m.from} (TicketStorm support)` : m.from}</strong> <span className="muted">{fmtDateTime(m.at, 'UTC')} UTC</span>
          <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
        </div>
      ))}
    </>
  )
}
