'use client'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'

type Captcha = { question: string; token: string }
type Status = { state: 'none' | 'expired' } | { state: 'waiting'; position: number; waitMinutes: number } | { state: 'admitted'; expiresAt: string }

export default function QueueRoom({ eventId, slug, captcha }: { eventId: number; slug: string; captcha: Captcha }) {
  const router = useRouter()
  const [st, setSt] = useState<Status | null>(null)
  const [cap, setCap] = useState(captcha)
  const [error, setError] = useState('')
  const poll = useCallback(async () => {
    const r = await fetch(`/api/queue/${eventId}`, { cache: 'no-store' }).catch(() => null)
    if (r?.ok) setSt(await r.json())
  }, [eventId])
  useEffect(() => {
    poll()
    const t = setInterval(poll, 5000)
    return () => clearInterval(t)
  }, [poll])
  useEffect(() => {
    if (st?.state === 'admitted') router.push(`/events/${slug}/tickets`)
  }, [st, router, slug])

  async function join(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    const r = await fetch(`/api/queue/${eventId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: f.get('answer'), token: cap.token, website: f.get('website') }),
    }).catch(() => null)
    const body = await r?.json().catch(() => null)
    if (r?.ok) {
      setError('')
      setSt(body)
    } else {
      setError(body?.error ?? 'Could not join, try again')
      if (body?.captcha) setCap(body.captcha)
    }
    form.reset()
  }

  if (!st) return <p className="muted">Loading…</p>
  if (st.state === 'waiting')
    return (
      <div className="card" role="status">
        <p>You are number <strong>{st.position}</strong> in line. Estimated wait: about {st.waitMinutes} min.</p>
        <p className="muted">Do not refresh or close this page needlessly: your place is saved, but this page moves you in the moment it is your turn.</p>
      </div>
    )
  if (st.state === 'admitted') return <p role="status">You are in. Taking you to the tickets…</p>
  return (
    <form onSubmit={join} className="stack">
      {st.state === 'expired' && <p className="error">Your shopping time ran out. Join again to get back in line.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <label>What is {cap.question}? <input name="answer" inputMode="numeric" required autoComplete="off" /></label>
      <input name="website" className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
      <button>Join the waiting room</button>
    </form>
  )
}
