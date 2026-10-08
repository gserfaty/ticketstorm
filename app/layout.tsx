import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import Link from 'next/link'
import './globals.css'
import { listCities } from '../lib/geo.ts'
import { runJobsThrottled } from '../lib/jobs.ts'
import { getUser } from '../lib/session.ts'
import SearchBox from '../components/SearchBox.tsx'
import { setCity } from './actions.ts'

export const metadata = { title: 'TicketStorm', description: 'Live events, tickets in a flash' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  runJobsThrottled()
  const user = await getUser()
  const city = (await cookies()).get('city')?.value ?? ''
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
          <details className="account">
            <summary>{user ? user.name || user.email : 'Account'}</summary>
            <nav>
              {user ? (
                <>
                  <span>{user.email}</span>
                  <Link href="/tickets">My tickets</Link>
                  <Link href="/orders">Orders</Link>
                  <form action="/logout" method="post"><button>Log out</button></form>
                </>
              ) : (
                <>
                  <Link href="/login">Log in</Link>
                  <Link href="/signup">Sign up</Link>
                </>
              )}
              <Link href="/dev/outbox">Dev outbox</Link>
            </nav>
          </details>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
