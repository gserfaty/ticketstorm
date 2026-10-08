import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import Link from 'next/link'
import './globals.css'
import { listCities } from '../lib/geo.ts'
import { runJobsThrottled } from '../lib/jobs.ts'
import { db } from '../lib/db.ts'
import { allInOn, getUser } from '../lib/session.ts'
import SearchBox from '../components/SearchBox.tsx'
import { setCity, toggleAllIn } from './actions.ts'

export const metadata = { title: 'TicketStorm', description: 'Live events, tickets in a flash' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  runJobsThrottled()
  const user = await getUser()
  const isMember = !!user && !!db.prepare('SELECT 1 FROM org_members WHERE user_id = ?').get(user.id)
  const city = (await cookies()).get('city')?.value ?? ''
  const allIn = await allInOn()
  const unread = user ? (db.prepare('SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id) as { n: number }).n : 0
  return (
    <html lang="en">
      <body>
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
              {process.env.NODE_ENV !== 'production' && <Link href="/dev/outbox">Dev outbox</Link>}
            </nav>
          </details>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
