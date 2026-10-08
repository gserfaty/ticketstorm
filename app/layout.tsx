import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import Link from 'next/link'
import './globals.css'
import { listCities } from '../lib/geo.ts'
import { runJobsThrottled } from '../lib/jobs.ts'
import { db } from '../lib/db.ts'
import { allInOn, currencyPref, getSession, getUser, langPref } from '../lib/session.ts'
import { LANGS, t } from '../lib/i18n.ts'
import { CURRENCIES, validCurrency } from '../lib/currency.ts'
import SearchBox from '../components/SearchBox.tsx'
import { setCity, setCurrency, setLang, toggleAllIn } from './actions.ts'

export const metadata = { title: 'TicketStorm', description: 'Live events, tickets in a flash' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  runJobsThrottled()
  const user = await getUser()
  const isMember = !!user && !!db.prepare('SELECT 1 FROM org_members WHERE user_id = ?').get(user.id)
  const city = (await cookies()).get('city')?.value ?? ''
  const allIn = await allInOn()
  const cur = validCurrency(await currencyPref())
  const lang = await langPref()
  const T = (k: Parameters<typeof t>[1]) => t(lang, k)
  const unread = user ? (db.prepare('SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id) as { n: number }).n : 0
  const imp = user && (await getSession())?.impersonator_id ? (db.prepare('SELECT email FROM users WHERE id = ?').get((await getSession())!.impersonator_id!) as { email: string }) : undefined
  return (
    <html lang={lang}>
      <body>
        <a href="#main" className="skip">{T('nav.skip')}</a>
        {imp && (
          <div className="imp-banner" role="alert">
            <span>Support mode: you are viewing TicketStorm as <strong>{user!.email}</strong> (admin {imp.email}). Security, payment, payout, organizer and admin actions are disabled. This session is audited.</span>
            <form action="/impersonate/stop" method="post"><button>Stop viewing as this user</button></form>
          </div>
        )}
        <header className="top">
          <Link href="/" className="brand">TicketStorm</Link>
          <form action="/search" className="search">
            <SearchBox />
          </form>
          <form action={setCity} className="city">
            <select name="city" defaultValue={city} aria-label="City">
              <option value="">{T('nav.cities')}</option>
              {listCities().map((c) => (
                <option key={c.id} value={c.id}>{c.name}, {c.state}</option>
              ))}
            </select>
            <button>{T('nav.set')}</button>
          </form>
          <form action={toggleAllIn} className="city">
            <button title="Show prices with fees and tax included" aria-pressed={allIn}>{allIn ? T('nav.allin_on') : T('nav.allin_off')}</button>
          </form>
          <form action={setCurrency} className="city" title="Display only: approximate conversions. You are always charged in USD.">
            <select name="currency" defaultValue={cur} aria-label="Display currency">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            <button>{T('nav.show')}</button>
          </form>
          <form action={setLang} className="city">
            <select name="lang" defaultValue={lang} aria-label={T('nav.language')}>{LANGS.map((l) => <option key={l} value={l}>{l === 'en' ? 'English' : 'Español'}</option>)}</select>
            <button>{T('nav.set')}</button>
          </form>
          <Link href="/discover">{T('nav.discover')}</Link>
          <Link href="/gift-cards">{T('nav.gift')}</Link>
          <Link href="/map">{T('nav.map')}</Link>
          {user && <Link href="/inbox" aria-label={`Inbox, ${unread} unread`}>{T('nav.inbox')}{unread > 0 && <> <span className="badge on-sale">{unread}</span></>}</Link>}
          <details className="account">
            <summary>{user ? user.name || user.email : T('nav.account')}</summary>
            <nav>
              {user ? (
                <>
                  <span>{user.email}</span>
                  <Link href="/tickets">{T('nav.tickets')}</Link>
                  <Link href="/orders">{T('nav.orders')}</Link>
                  <Link href="/account">{T('nav.settings')}</Link>
                  <Link href="/favorites">{T('nav.favorites')}</Link>
                  <Link href="/sell">{T('nav.sell')}</Link>
                  <Link href="/listings">{T('nav.listings')}</Link>
                  <Link href="/seller">{T('nav.seller')}</Link>
                  <Link href="/claims">{T('nav.claims')}</Link>
                  <Link href="/account/payouts">{T('nav.payouts')}</Link>
                  <Link href={isMember ? '/organizer' : '/become-organizer'}>{isMember ? T('nav.organizer') : T('nav.become')}</Link>
                  {user.role === 'admin' && <Link href="/admin">{T('nav.admin')}</Link>}
                  <form action="/logout" method="post"><button>{T('nav.logout')}</button></form>
                </>
              ) : (
                <>
                  <Link href="/login">{T('nav.login')}</Link>
                  <Link href="/signup">{T('nav.signup')}</Link>
                </>
              )}
              <Link href="/lookup">{T('nav.lookup')}</Link>
              <Link href="/help">{T('nav.help')}</Link>
              {process.env.NODE_ENV !== 'production' && <Link href="/dev/outbox">Dev outbox</Link>}
            </nav>
          </details>
        </header>
        <main id="main" tabIndex={-1}>{children}</main>
      </body>
    </html>
  )
}
