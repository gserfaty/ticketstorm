import Link from 'next/link'

const TABS: [string, string][] = [['profile', 'Profile'], ['payment', 'Saved cards'], ['notifications', 'Notifications'], ['security', 'Security'], ['privacy', 'Privacy']]
export default function AccountNav({ here }: { here: string }) {
  return <p className="genres">{TABS.map(([k, name]) => <Link key={k} href={`/account/${k}`} className={k === here ? 'on' : ''}>{name}</Link>)}</p>
}
