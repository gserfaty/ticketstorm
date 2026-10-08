import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import Link from 'next/link'
import './globals.css'
import { listCities } from '../lib/geo.ts'
import { runJobsThrottled } from '../lib/jobs.ts'
import { db } from '../lib/db.ts'
import { allInOn, currencyPref, getSession, getUser } from '../lib/session.ts'
import { CURRENCIES, validCurrency } from '../lib/currency.ts'
import SearchBox from '../components/SearchBox.tsx'
import { setCity, setCurrency, toggleAllIn } from './actions.ts'
import { stopViewingAs } from './impersonate/actions.ts'

export const metadata = { title: 'TicketStorm', description: 'Live events, tickets in a flash' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  runJobsThrottled()
  const user = await getUser()
  const isMember = !!user && !!db.prepare('SELECT 1 FROM org_members WHERE user_id = ?').get(user.id)
  const city = (await cookies()).get('city')?.value ?? ''
  const allIn = await allInOn()
  const cur = validCurrency(await currencyPref())
  const unread = user ? (db.prepare('SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id) as { n: number }).n : 0
  const imp = user && (await getSession())?.impersonator_id ? (db.prepare('SELECT email FROM users WHERE id = ?').get((await getSession())!.impersonator_id!) as { email: string }) : undefined
  return (
    <html lang="en">
      <body>
        {imp && (
          <div className="imp-banner" role="alert">
            <span>Support mode: you are viewing TicketStorm as <strong>{user!.email}</strong> (admin {imp.email}). Security, payment, payout, organizer and admin actions are disabled. This session is audited.</span>
            <form action={stopViewingAs}><button>Stop viewing as this user</button></form>
          </div>
        )}
        <header className="top">
          <Link href="/" className="brand">TicketStorm</Link>
          <form action="/search" className="search">
            <SearchBox />
          </form>
          <form action={setCity} className="city">
            <select name="city" defaultValue={city} aria-label="City">
              <option value="">All cities</option>
              {listCities().map((c) => (
                <option key={c.id} value={c.id}>{c.name}, {c.state}</option>
              ))}
            </select>
            <button>Set</button>
          </form>
          <form action={toggleAllIn} className="city">
            <button title="Show prices with fees and tax included" aria-pressed={allIn}>{allIn ? 'All-in prices: on' : 'All-in prices: off'}</button>
          </form>
          <form action={setCurrency} className="city" title="Display only: approximate conversions. You are always charged in USD.">
            <select name="currency" defaultValue={cur} aria-label="Display currency">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            <button>Show</button>
          </form>
          <Link href="/discover">Discover</Link>
          <Link href="/map">Map</Link>
          {user && <Link href="/inbox" aria-label={`Inbox, ${unread} unread`}>Inbox{unread > 0 && <> <span className="badge on-sale">{unread}</span></>}</Link>}
          <details className="account">
            <summary>{user ? user.name || user.email : 'Account'}</summary>
            <nav>
              {user ? (
                <>
                  <span>{user.email}</span>
                  <Link href="/tickets">My tickets</Link>
                  <Link href="/orders">Orders</Link>
                  <Link href="/account">Account settings</Link>
                  <Link href="/favorites">Favorites</Link>
                  <Link href="/sell">Sell tickets</Link>
                  <Link href="/listings">My listings</Link>
                  <Link href="/account/payouts">Payouts</Link>
                  <Link href={isMember ? '/organizer' : '/become-organizer'}>{isMember ? 'Organizer' : 'Become an organizer'}</Link>
                  {user.role === 'admin' && <Link href="/admin">Admin</Link>}
                  <form action="/logout" method="post"><button>Log out</button></form>
                </>
              ) : (
                <>
                  <Link href="/login">Log in</Link>
                  <Link href="/signup">Sign up</Link>
                </>
              )}
              <Link href="/lookup">Find a guest order</Link>
              <Link href="/help">Help</Link>
              {process.env.NODE_ENV !== 'production' && <Link href="/dev/outbox">Dev outbox</Link>}
            </nav>
          </details>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
