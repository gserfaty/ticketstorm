import { notFound } from 'next/navigation'
import Flash from '../../../components/Flash.tsx'
import Thread from '../../../components/Thread.tsx'
import { getSupportTicket } from '../../../lib/support.ts'
import { requireUser } from '../../../lib/session.ts'
import { replyToSupport } from '../actions.ts'

export const dynamic = 'force-dynamic'

export default async function SupportTicket({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await requireUser()
  const id = Number((await params).id)
  const t = Number.isSafeInteger(id) ? getSupportTicket(id) : undefined
  if (!t || t.user_id !== user.id) notFound() // owner only
  return (
    <>
      <h1>#{t!.id} {t!.subject} <span className="badge">{t!.status}</span></h1>
      <Flash {...(await searchParams)} />
      <Thread messages={t!.messages} />
      {t!.status !== 'closed' && (
        <form action={replyToSupport} className="stack">
          <input type="hidden" name="ticketId" value={t!.id} />
          <textarea name="message" rows={4} maxLength={2000} placeholder="Reply" aria-label="Reply" required />
          <button>Send reply</button>
        </form>
      )}
    </>
  )
}
