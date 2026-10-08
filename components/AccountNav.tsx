import Link from 'next/link'

const TABS: [string, string][] = [['profile', 'Profile'], ['payment', 'Wallet'], ['notifications', 'Notifications'], ['security', 'Security'], ['linked', 'Linked accounts'], ['payouts', 'Payouts'], ['privacy', 'Privacy']]
export default function AccountNav({ here }: { here: string }) {
  return <p className="genres">{TABS.map(([k, name]) => <Link key={k} href={`/account/${k}`} className={k === here ? 'on' : ''}>{name}</Link>)}</p>
}
