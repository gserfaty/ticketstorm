'use client'
import { useActionState } from 'react'
import type { KeyState } from '../app/organizer/actions.ts'

// Creates an API key and shows it once, right here. Reloading the page loses it for good: only a hash is stored.
export default function NewKey({ action, orgId }: { action: (prev: KeyState, f: FormData) => Promise<KeyState>; orgId: number }) {
  const [state, formAction] = useActionState(action, {} as KeyState)
  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="orgId" value={orgId} />
      <input name="name" placeholder="Key name (e.g. Website)" required maxLength={60} aria-label="Key name" />
      <button>Create API key</button>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.key && <p className="notice card" role="status">Copy this key now. It is shown once and cannot be recovered:<br /><code>{state.key}</code></p>}
    </form>
  )
}
