import { db } from '../../../../../lib/db.ts'
import { openWindowIds } from '../../../../../lib/access.ts'
import { acquire, MAX_LIFE_MS, release, snapshot, TICK_MS } from '../../../../../lib/stream.ts'
import { getSession } from '../../../../../lib/session.ts'

export const dynamic = 'force-dynamic'

// GET /api/events/[id]/stream: text/event-stream. A frame is sent when availability changes, a comment heartbeat otherwise.
// Capped globally (503 + Retry-After: the client then polls /inventory), closed on client abort and after MAX_LIFE_MS.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  if (!Number.isSafeInteger(id) || !db.prepare("SELECT 1 FROM events WHERE id = ? AND status != 'draft' AND approved = 1").get(id)) return Response.json({ error: 'Not found' }, { status: 404 })
  if (!acquire()) return Response.json({ error: 'Too many live connections, poll instead' }, { status: 503, headers: { 'Retry-After': '10' } })
  const win = openWindowIds(id, (await getSession())?.token)
  const enc = new TextEncoder()
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let life: ReturnType<typeof setTimeout> | undefined
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    clearTimeout(life)
    release()
    try { ctl?.close() } catch {}
  }
  const send = (s: string) => {
    try { ctl?.enqueue(enc.encode(s)) } catch { close() }
  }
  let last = ''
  const tick = () => {
    if (closed) return
    const d = snapshot(id, win)
    if (d !== last) (last = d, send(`data: ${d}\n\n`))
    else send(': heartbeat\n\n')
  }
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
      send('retry: 3000\n\n')
      tick()
      timer = setInterval(tick, TICK_MS)
      life = setTimeout(close, MAX_LIFE_MS)
      req.signal.addEventListener('abort', close)
    },
    cancel: close,
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } })
}
