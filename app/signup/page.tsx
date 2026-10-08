import { signup } from '../actions.ts'

export default async function Signup({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next = '' } = await searchParams
  return (
    <>
      <h1>Sign up</h1>
      {error && <p className="error">{error}</p>}
      <form action={signup} className="stack">
        <input type="hidden" name="next" value={next} />
        <input name="name" placeholder="Name" aria-label="Name" autoComplete="name" />
        <input name="email" type="email" placeholder="Email" aria-label="Email" required autoComplete="email" />
        <input name="password" type="password" placeholder="Password (8+ characters)" aria-label="Password" required minLength={8} autoComplete="new-password" />
        <button>Create account</button>
      </form>
      <p>Have an account? <a href={`/login?next=${encodeURIComponent(next)}`}>Log in</a></p>
    </>
  )
}
