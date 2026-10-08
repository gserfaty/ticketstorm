'use client'
import { useState } from 'react'

// Native share sheet where the browser has one; otherwise copy the link.
export default function ShareButton({ title, path }: { title: string; path: string }) {
  const [msg, setMsg] = useState('')
  async function share() {
    const url = new URL(path, location.href).href
    try {
      if (navigator.share) await navigator.share({ title, url })
      else {
        await navigator.clipboard.writeText(url)
        setMsg('Link copied')
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setMsg(`Copy this link: ${url}`) // clipboard blocked: show it
    }
  }
  return (
    <>
      <button type="button" onClick={share}>Share</button> <span className="muted" role="status">{msg}</span>
    </>
  )
}
