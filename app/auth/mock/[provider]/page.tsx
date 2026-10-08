import { notFound } from 'next/navigation'
import { checkState, PROVIDERS, socialEnabled } from '../../../../lib/social.ts'
import { getSession } from '../../../../lib/session.ts'
import { completeSocial } from '../../../actions.ts'

export const dynamic = 'force-dynamic'

// Fake identity provider consent screen. Only reachable with a state that this browser session created (CSRF); never takes a return URL
// other than a same-site path, which completeSocial re-validates.
export default async function Consent({ params, searchParams }: { params: Promise<{ provider: string }>; searchParams: Promise<{ state?: string; next?: string }> }) {
  const { provider } = await params
  if (!socialEnabled() || !PROVIDERS.includes(provider)) notFound()
  const { state = '', next = '' } = await searchParams
  const session = await getSession()
  const name = provider[0].toUpperCase() + provider.slice(1)
  if (!session || !checkState(state, session.token, provider, false)) return <><h1>{name} (simulated)</h1><p className="error">This sign-in request is invalid or expired. <a href="/login">Back to login</a></p></>
  return (
    <>
      <h1>Sign in with {name} (simulated)</h1>
      <p>TicketStorm wants to see your name and email. There is no real {name} here: type who you are.</p>
      <form action={completeSocial} className="stack">
        <input type="hidden" name="provider" value={provider} />
        <input type="hidden" name="state" value={state} />
        <input type="hidden" name="next" value={next} />
        <input name="email" type="email" defaultValue={`${provider}.user@example.test`} required aria-label="Email" />
        <input name="name" defaultValue="Sam Social" aria-label="Name" />
        <label><input type="checkbox" name="verified" defaultChecked /> {name} has verified this email</label>
        <div className="buy">
          <button name="decision" value="allow">Allow</button>
          <button name="decision" value="deny">Deny</button>
        </div>
      </form>
    </>
  )
}
