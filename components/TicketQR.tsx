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
  const [hidden, setHidden] = useState(false) // the code is blurred while the tab or window is not in front (screen recordings, app switcher)
  const [nfc, setNfc] = useState('')
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
    const hide = () => setHidden(true)
    const show = () => setHidden(document.hidden)
    const vis = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', vis)
    window.addEventListener('blur', hide)
    window.addEventListener('focus', show)
    return () => {
      dead = true
      clearInterval(t)
      document.removeEventListener('visibilitychange', vis)
      window.removeEventListener('blur', hide)
      window.removeEventListener('focus', show)
    }
  }, [ticketId, secret])

  // Demo of tap-to-enter: the phone offers the CURRENT token as its NFC payload, and a gate reader (the scanner page of an authorised staff
  // member, same browser) picks it up. The fan's browser never calls the scan API itself, so a fan cannot admit their own ticket.
  const tap = async () => {
    const t = await token(ticketId, secret, Math.floor(Date.now() / WINDOW_MS))
    try {
      const ch = new BroadcastChannel('ticketstorm-nfc')
      ch.postMessage({ token: t })
      ch.close()
    } catch {}
    setNfc(t)
  }
  return (
    <div>
      <div className={`qr ${hidden ? 'qr-hidden' : ''}`}>
        {img ? <img src={img} width={240} height={240} alt="Ticket QR code" /> : <div style={{ width: 240, height: 240 }} />}
        <div className="qr-band" aria-hidden="true" />
      </div>
      <p className="muted">{hidden ? 'Code hidden while this window is in the background. Click back in to show it.' : `Code refreshes in ${left}s. Screenshots will not work.`}</p>
      <button type="button" onClick={tap}>Tap to enter (NFC)</button>
      {nfc && <p className="muted">NFC payload ready for the gate reader (demo, nothing is admitted from here): <code>{nfc.slice(0, 18)}…</code></p>}
    </div>
  )
}
