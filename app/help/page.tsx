import Link from 'next/link'
import Flash from '../../components/Flash.tsx'
import { getUser } from '../../lib/session.ts'
import { submitContact } from './actions.ts'

export const dynamic = 'force-dynamic'

const FAQ: [string, string][] = [
  ['How do my tickets work?', 'Tickets are mobile only. Open the ticket in My tickets: the QR code changes every 15 seconds, so a screenshot will not get you in. You can add a simulated pass to Apple or Google Wallet from the ticket page.'],
  ['Can I send a ticket to a friend?', 'Yes, from the ticket page, by email or phone number. The ticket stays yours until they accept; you can cancel while it is pending, and the old code stops working once it is accepted. Some events close transfers a number of hours before the show or turn them off.'],
  ['How does resale work?', 'List a ticket from Sell tickets at a price between the event\'s floor and ceiling (a percent of the face value). The buyer gets a new ticket and the old one stops working. TicketStorm keeps a seller fee (10% unless the event says otherwise) and the money lands in your balance; request a payout under Account > Payouts.'],
  ['What if an event is cancelled or moved?', 'Cancelled events are refunded automatically to the original card. If a show moves to a new date, your tickets stay valid and you have a short window to ask for a refund.'],
  ['How do refunds and ticket protection work?', 'Orders are refundable only when the organizer allows it (cancelled or rescheduled shows). With ticket protection you can file a claim from the order page.'],
  ['I did not get my confirmation email', 'Open the order under Orders and press "Resend confirmation". Guests can use the link in the original email.'],
  ['How do I ask for accessible seating?', 'Use the accessible filter on the seat map, or send an accessibility request.'],
]

export default async function Help({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const user = await getUser()
  return (
    <>
      <h1>Help</h1>
      <Flash {...(await searchParams)} />
      {FAQ.map(([q, a]) => <details className="info" key={q}><summary>{q}</summary><p>{a}</p></details>)}
      <p><Link href="/support/ada">Accessibility request</Link>{user && <> · <Link href="/support">My support tickets</Link></>}</p>
      <h2 id="contact">Contact us</h2>
      <form action={submitContact} className="stack">
        <input name="website" className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
        {user ? <p>Replies go to {user.email}.</p> : <input name="email" type="email" placeholder="Your email" aria-label="Your email" required />}
        <input name="subject" placeholder="Subject" aria-label="Subject" maxLength={120} required />
        <textarea name="message" rows={5} maxLength={2000} placeholder="How can we help?" aria-label="Message" required />
        <button>Send</button>
      </form>
    </>
  )
}
