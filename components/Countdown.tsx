'use client'
import { useEffect, useRef, useState } from 'react'

// m:ss until expiresAt; calls onExpire once when it reaches zero.
export default function Countdown({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
  const [left, setLeft] = useState<number | null>(null) // null until mounted, so server and client markup match
  const cb = useRef(onExpire)
  cb.current = onExpire
  useEffect(() => {
    const tick = () => {
      const ms = Date.parse(expiresAt) - Date.now()
      setLeft(Math.max(0, ms))
      if (ms <= 0) {
        clearInterval(t)
        cb.current()
      }
    }
    const t = setInterval(tick, 1000)
    tick()
    return () => clearInterval(t)
  }, [expiresAt])
  if (left === null) return <span>--:--</span>
  const s = Math.ceil(left / 1000)
  return <span role="timer" aria-label="Time left on your hold">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}
