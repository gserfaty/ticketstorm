import Flash from '../../components/Flash.tsx'
import { signUpOrg } from '../organizer/actions.ts'
import { requireUser } from '../../lib/session.ts'

export default async function BecomeOrganizer({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireUser()
  return (
    <>
      <h1>Sell tickets with TicketStorm</h1>
      <p className="muted">New organizations are reviewed by an admin before they can publish events.</p>
      <Flash error={(await searchParams).error} />
      <form action={signUpOrg} className="stack">
        <input name="name" placeholder="Organization name" required maxLength={80} />
        <button>Create organization</button>
      </form>
    </>
  )
}
