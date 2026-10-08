import { requestReset, setPassword } from '../actions.ts'

export default async function Reset({ searchParams }: { searchParams: Promise<{ code?: string; sent?: string; error?: string }> }) {
  const { code, sent, error } = await searchParams
  return (
    <>
      <h1>Reset password</h1>
      {error && <p className="error">{error}</p>}
      {sent && <p className="notice">If that email has an account, a reset link is on its way.</p>}
      {code ? (
        <form action={setPassword} className="stack">
          <input type="hidden" name="code" value={code} />
          <input name="password" type="password" placeholder="New password (8+ characters)" required minLength={8} autoComplete="new-password" />
          <button>Set new password</button>
        </form>
      ) : (
        <form action={requestReset} className="stack">
          <input name="email" type="email" placeholder="Email" required />
          <button>Send reset link</button>
        </form>
      )}
    </>
  )
}
