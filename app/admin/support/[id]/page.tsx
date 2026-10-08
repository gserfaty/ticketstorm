import { notFound } from 'next/navigation'
import Flash from '../../../../components/Flash.tsx'
import Thread from '../../../../components/Thread.tsx'
import { getSupportTicket } from '../../../../lib/support.ts'
import { requireAdmin } from '../../../../lib/session.ts'
import { supportClose, supportReply } from '../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function AdminSupportTicket({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  await requireAdmin()
  const id = Number((await params).id)
  const t = Number.isSafeInteger(id) ? getSupportTicket(id) : undefined
  if (!t) notFound()
  return (
    <>
      <h1>#{t!.id} {t!.subject} <span className="badge">{t!.status}</span></h1>
      <p className="muted">{t!.email} · {t!.kind}{t!.user_id ? ` · user ${t!.user_id}` : ' · guest'}</p>
      <Flash {...(await searchParams)} />
      <Thread messages={t!.messages} />
      <form action={supportReply} className="stack">
        <input type="hidden" name="ticketId" value={t!.id} />
        <textarea name="message" rows={4} maxLength={2000} placeholder="Reply (emailed to the fan)" aria-label="Reply" required />
        <button>Send reply</button>
      </form>
      {t!.status !== 'closed' && <form action={supportClose}><input type="hidden" name="ticketId" value={t!.id} /><button>Close ticket</button></form>}
    </>
  )
}
