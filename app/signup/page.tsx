import { signup } from '../actions.ts'

export default async function Signup({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams
  return (
    <>
      <h1>Sign up</h1>
      {error && <p className="error">{error}</p>}
      <form action={signup} className="stack">
        <input name="name" placeholder="Name" autoComplete="name" />
        <input name="email" type="email" placeholder="Email" required autoComplete="email" />
        <input name="password" type="password" placeholder="Password (8+ characters)" required minLength={8} autoComplete="new-password" />
        <button>Create account</button>
      </form>
      <p>Have an account? <a href="/login">Log in</a></p>
    </>
  )
}
