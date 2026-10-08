'use client'
import { useEffect, useState } from 'react'

// "2d 03:14:09" until an instant (on-sale, show start). Server and first client render agree (placeholder until mounted).
export default function Until({ iso, label, done = 'now' }: { iso: string; label: string; done?: string }) {
  const [ms, setMs] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setMs(Date.parse(iso) - Date.now())
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [iso])
  if (ms === null) return <span>{label} …</span>
  if (ms <= 0) return <span>{label} {done}</span>
  const s = Math.floor(ms / 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return <span role="timer" aria-label={label}>{label} {s >= 86400 ? `${Math.floor(s / 86400)}d ` : ''}{p(Math.floor((s % 86400) / 3600))}:{p(Math.floor((s % 3600) / 60))}:{p(s % 60)}</span>
}
