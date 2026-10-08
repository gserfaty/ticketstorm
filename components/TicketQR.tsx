'use client'
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

const WINDOW_MS = 15_000
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

// Same token as lib/safetix.ts makeToken, computed in the browser from the ticket secret. Rotates every 15s.
async function token(ticketId: number, secret: string, win: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ticketId}:${win}`))
  return `${ticketId}.${win}.${hex(mac)}`
}

export default function TicketQR({ ticketId, secret }: { ticketId: number; secret: string }) {
  const [img, setImg] = useState('')
  const [left, setLeft] = useState(0)
  useEffect(() => {
    let win = -1
    let dead = false
    const tick = async () => {
      const now = Date.now()
      setLeft(Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000))
      const w = Math.floor(now / WINDOW_MS)
      if (w === win) return
      win = w
      const url = await QRCode.toDataURL(await token(ticketId, secret, w), { margin: 1, width: 240 })
      if (!dead) setImg(url)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [ticketId, secret])
  return (
    <div>
      {img ? <img src={img} width={240} height={240} alt="Ticket QR code" /> : <div style={{ width: 240, height: 240 }} />}
      <p className="muted">Code refreshes in {left}s. Screenshots will not work.</p>
    </div>
  )
}
