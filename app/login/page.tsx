import { PROVIDERS, socialEnabled } from '../../lib/social.ts'
import { loginAction, startSocial } from '../actions.ts'

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; next?: string }> }) {
  const { error, notice, next = '' } = await searchParams
  return (
    <>
      <h1>Log in</h1>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <form action={loginAction} className="stack">
        <input type="hidden" name="next" value={next} />
        <input name="email" type="email" placeholder="Email" aria-label="Email" required autoComplete="email" />
        <input name="password" type="password" placeholder="Password" aria-label="Password" required autoComplete="current-password" />
        <button>Log in</button>
      </form>
      {socialEnabled() && (
        <div className="row">
          {PROVIDERS.map((p) => (
            <form key={p} action={startSocial}>
              <input type="hidden" name="next" value={next} />
              <input type="hidden" name="provider" value={p} />
              <button>Continue with {p[0].toUpperCase() + p.slice(1)}</button>
            </form>
          ))}
        </div>
      )}
      <p><a href="/reset">Forgot password?</a> · <a href={`/signup?next=${encodeURIComponent(next)}`}>Sign up</a></p>
    </>
  )
}
