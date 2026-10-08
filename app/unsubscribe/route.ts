import { NextResponse } from 'next/server'
import { unsubscribe, verifyUnsub } from '../../lib/alerts.ts'
import { PREF_LABELS } from '../../lib/account.ts'

const page = (status: number, msg: string) =>
  new NextResponse(`<!doctype html><meta charset="utf-8"><title>Unsubscribe</title><body style="font:16px system-ui;max-width:32rem;margin:3rem auto"><p>${msg}</p><p><a href="/account/notifications">Notification settings</a></p>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })

// The link at the bottom of every email: signed (user, category) token, no login needed. GET for the link, POST for mail clients' one-click unsubscribe.
function handle(req: Request) {
  const v = verifyUnsub(new URL(req.url).searchParams.get('t') ?? '')
  if (!v) return page(400, 'This unsubscribe link is not valid.')
  unsubscribe(v.userId, v.category)
  return page(200, `You will no longer get ${PREF_LABELS[v.category].toLowerCase()} emails. You can turn them back on in your settings.`)
}
export const GET = handle
export const POST = handle
