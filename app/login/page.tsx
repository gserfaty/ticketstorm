import { loginAction } from '../actions.ts'

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = await searchParams
  return (
    <>
      <h1>Log in</h1>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <form action={loginAction} className="stack">
        <input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <input name="password" type="password" placeholder="Password" required autoComplete="current-password" />
        <button>Log in</button>
      </form>
      <p><a href="/reset">Forgot password?</a> · <a href="/signup">Sign up</a></p>
    </>
  )
}
