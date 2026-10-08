'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

type Item = { eventId: number; token: string; at: number }
type Outcome = { result: string; message: string }
const KEY = 'ticketstorm.scanQueue'

const load = (): Item[] => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}
const save = (q: Item[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(q)) } catch {}
}

export default function Scanner({ eventId, initial }: { eventId: number; initial: { scanned: number; total: number } }) {
  const [att, setAtt] = useState(initial)
  const [last, setLast] = useState<Outcome | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [queued, setQueued] = useState(0)
  const [text, setText] = useState('')
  const [cam, setCam] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const flushing = useRef(false)

  const post = async (i: Item): Promise<Outcome | null> => {
    try {
      const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(i) })
      if (r.status >= 500) return null
      const j = await r.json()
      return r.ok ? j : { result: 'invalid', message: j.error ?? 'Error' }
    } catch {
      return null // offline: keep it queued
    }
  }

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/scan?eventId=${eventId}`, { cache: 'no-store' })
      if (r.ok) setAtt(await r.json())
    } catch {}
  }, [eventId])

  // Retry queued scans in order; the server decides duplicates, so a replay that finds the ticket used just reports it.
  const flush = useCallback(async () => {
    if (flushing.current) return
    flushing.current = true
    let q = load()
    while (q.length) {
      const o = await post(q[0])
      if (!o) break
      setLog((l) => [`${q[0].token.slice(0, 8)}… ${o.message} (queued scan)`, ...l].slice(0, 10))
      q = q.slice(1)
      save(q)
    }
    setQueued(q.length)
    flushing.current = false
    refresh()
  }, [refresh])

  const submit = async (token: string) => {
    token = token.trim()
    if (!token) return
    const item = { eventId, token, at: Date.now() }
    const o = await post(item)
    if (o) {
      setLast(o)
      setLog((l) => [`${token.slice(0, 8)}… ${o.message}`, ...l].slice(0, 10))
      refresh()
    } else {
      save([...load(), item])
      setQueued(load().length)
      setLast({ result: 'queued', message: 'Offline: scan queued, will retry' })
    }
  }

  useEffect(() => {
    setQueued(load().length)
    flush()
    const t = setInterval(() => { flush(); refresh() }, 5000)
    window.addEventListener('online', flush)
    return () => { clearInterval(t); window.removeEventListener('online', flush) }
  }, [flush, refresh])

  // Camera scanning where BarcodeDetector exists; the paste field always works.
  useEffect(() => {
    if (!cam) return
    let stop = false
    let stream: MediaStream | undefined
    ;(async () => {
      const BD = (window as unknown as { BarcodeDetector?: new (o: object) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector
      if (!BD) return setLast({ result: 'invalid', message: 'Camera scanning is not supported here; paste the code instead' })
      const det = new BD({ formats: ['qr_code'] })
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      video.current!.srcObject = stream
      await video.current!.play()
      let prev = ''
      while (!stop) {
        const [c] = await det.detect(video.current!).catch(() => [])
        if (c && c.rawValue !== prev) { prev = c.rawValue; await submit(c.rawValue) }
        await new Promise((r) => setTimeout(r, 400))
      }
    })().catch(() => setLast({ result: 'invalid', message: 'Camera unavailable' }))
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()) }
  }, [cam]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <p aria-live="polite"><strong>Attendance {att.scanned} / {att.total}</strong>{queued > 0 && <span className="muted"> · {queued} queued offline</span>}</p>
      <form onSubmit={(e) => { e.preventDefault(); submit(text); setText('') }} className="filters">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste ticket code" aria-label="Ticket code" size={40} autoFocus />
        <button>Scan</button>
        <button type="button" onClick={() => setCam((c) => !c)}>{cam ? 'Stop camera' : 'Use camera'}</button>
      </form>
      {cam && <video ref={video} playsInline muted style={{ maxWidth: '100%', width: 320 }} />}
      {last && <p role="status" className={last.result === 'valid' ? 'scan-ok' : 'scan-bad'} style={{ fontSize: '1.5rem' }}>{last.message}</p>}
      <ul>{log.map((l, i) => <li key={i} className="muted">{l}</li>)}</ul>
    </div>
  )
}
