'use client'
import { useEffect, useState } from 'react'

// Saves the owner's ticket page(s) for offline use. One cache per user id; any other user's cache is deleted first. Only rendered for a
// logged-in owner. The QR itself needs no network: TicketQR computes it from the ticket secret in the page.
export default function OfflineTickets({ userId, urls = [] }: { userId: number; urls?: string[] }) {
  const [state, setState] = useState<'saving' | 'saved' | 'off'>('saving')
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('caches' in window)) return setState('off')
    let dead = false
    ;(async () => {
      try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' })
        const mine = `ts-tickets-u${userId}`
        for (const k of await caches.keys()) if (k.startsWith('ts-tickets-') && k !== mine) await caches.delete(k)
        const cache = await caches.open(mine)
        for (const u of [location.href, ...urls.map((p) => new URL(p, location.href).href)]) {
          const res = await fetch(u, { credentials: 'same-origin', cache: 'no-store' })
          if (res.ok) await cache.put(u, res)
        }
        // the scripts this page runs, so it can start without the network (the SW also keeps them as they load)
        const statics = await caches.open('ts-static')
        await statics.addAll([...new Set(performance.getEntriesByType('resource').map((r) => r.name).filter((n) => new URL(n).pathname.startsWith('/_next/static/')))])
        if (!dead) setState('saved')
      } catch {
        if (!dead) setState('off')
      }
    })()
    return () => { dead = true }
  }, [userId, urls.join()])
  return <p className="muted" role="status">{state === 'saved' ? 'Saved for offline use on this device: the code keeps refreshing without a connection. Logging out removes it.' : state === 'saving' ? 'Saving for offline use…' : 'Offline use is not available in this browser.'}</p>
}
