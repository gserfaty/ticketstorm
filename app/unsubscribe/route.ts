import { NextResponse } from 'next/server'
import { unsubscribe, verifyUnsub } from '../../lib/alerts.ts'
import { PREF_LABELS } from '../../lib/account.ts'

const page = (status: number, body: string) =>
  new NextResponse(`<!doctype html><meta charset="utf-8"><title>Unsubscribe</title><body style="font:16px system-ui;max-width:32rem;margin:3rem auto">${body}<p><a href="/account/notifications">Notification settings</a></p>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })

// GET only asks (mail scanners and link previews fetch links, so a GET must change nothing); POST, with the same signed token, unsubscribes.
// POST is also what mail clients' one-click unsubscribe sends.
export function GET(req: Request) {
  const t = new URL(req.url).searchParams.get('t') ?? ''
  const v = verifyUnsub(t)
  if (!v) return page(400, '<p>This unsubscribe link is not valid.</p>')
  return page(200, `<p>Stop ${PREF_LABELS[v.category].toLowerCase()} emails?</p><form method="post" action="/unsubscribe?t=${encodeURIComponent(t)}"><button>Unsubscribe</button></form>`)
}

export function POST(req: Request) {
  const v = verifyUnsub(new URL(req.url).searchParams.get('t') ?? '')
  if (!v) return page(400, '<p>This unsubscribe link is not valid.</p>')
  unsubscribe(v.userId, v.category)
  return page(200, `<p>You will no longer get ${PREF_LABELS[v.category].toLowerCase()} emails. You can turn them back on in your settings.</p>`)
}
