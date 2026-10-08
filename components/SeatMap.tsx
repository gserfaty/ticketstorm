'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as RKeyboardEvent, PointerEvent as RPointerEvent } from 'react'
import Countdown from './Countdown.tsx'

export type MapSection = { id: number; name: string; kind: 'reserved' | 'ga'; path: string; lx: number; ly: number }
export type MapLevel = { id: number; name: string; color: string | null; cents: number; type: string }
// [inventory id, section id, row, number, x, y, flags] flags: 1 accessible, 2 companion
export type MapSeat = [number, number, string, number, number, number, number]
export type Avail = { seats: (readonly [number, string, number])[]; ga: { sectionId: number; levelId: number; total: number; free: number }[] }
export type Hold = { id: number; expiresAt: string; seatIds: number[]; ga: { sectionId: number; qty: number } | null }

type Props = { eventId: number; ticketLimit: number; qty: number; sections: MapSection[]; levels: MapLevel[]; seats: MapSeat[]; initial: Avail; hold: Hold | null }
type VB = { x: number; y: number; w: number; h: number }

const W = 1000
const H = 800
const FULL: VB = { x: 0, y: 0, w: W, h: H }
const usd = (c: number) => `$${(c / 100).toFixed(2)}`
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
const fit = (v: VB): VB => {
  const w = clamp(v.w, 80, W)
  const h = w * (H / W)
  return { w, h, x: clamp(v.x, 0, W - w), y: clamp(v.y, 0, H - h) }
}

// Section paths are rectangles ("M x y h w v h ..."); anything else falls back to the full view.
function bbox(path: string): VB {
  const m = /^M([\d.-]+) ([\d.-]+)h([\d.-]+)v([\d.-]+)/.exec(path)
  if (!m) return FULL
  const [x, y, w, h] = m.slice(1).map(Number)
  const side = Math.max(w + 40, (h + 40) * (W / H))
  return fit({ x: x + w / 2 - side / 2, y: y + h / 2 - (side * H) / W / 2, w: side, h: 0 })
}

function seatRadius(ss: MapSeat[]) {
  const gap = (v: number[]) => {
    const u = [...new Set(v)].sort((a, b) => a - b)
    return u.length > 1 ? Math.min(...u.slice(1).map((x, i) => x - u[i])) : 20
  }
  return Math.min(gap(ss.map((s) => s[4])), gap(ss.map((s) => s[5]))) * 0.42
}

export default function SeatMap({ eventId, ticketLimit, qty, sections, levels, seats, initial, hold: initialHold }: Props) {
  const [avail, setAvail] = useState(initial)
  const [hold, setHold] = useState(initialHold)
  const [selected, setSelected] = useState<number[]>([])
  const [open, setOpen] = useState<number | null>(initialHold?.ga?.sectionId ?? null)
  const [vb, setVb] = useState<VB>(FULL)
  const [maxPrice, setMaxPrice] = useState(Math.max(...levels.map((l) => l.cents)))
  const [adaOnly, setAdaOnly] = useState(false)
  const [bestQty, setBestQty] = useState(qty)
  const [bestLevel, setBestLevel] = useState(0)
  const [gaQty, setGaQty] = useState(Math.min(qty, ticketLimit))
  const [msg, setMsg] = useState<{ error: boolean; text: string } | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const svg = useRef<SVGSVGElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const drag = useRef<{ cx: number; cy: number; vb: VB; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const vbRef = useRef(vb)
  vbRef.current = vb

  const levelById = useMemo(() => new Map(levels.map((l) => [l.id, l])), [levels])
  const seatById = useMemo(() => new Map(seats.map((s) => [s[0], s])), [seats])
  const sectionById = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections])
  const bySection = useMemo(() => {
    const m = new Map<number, MapSeat[]>()
    for (const s of seats) m.set(s[1], [...(m.get(s[1]) ?? []), s])
    return m
  }, [seats])
  const radius = useMemo(() => new Map([...bySection].map(([id, ss]) => [id, seatRadius(ss)])), [bySection])
  const status = useMemo(() => new Map(avail.seats.map((s) => [s[0], s])), [avail])
  const gaById = useMemo(() => new Map(avail.ga.map((g) => [g.sectionId, g])), [avail])
  const mine = useMemo(() => new Set(hold?.seatIds), [hold])
  const price = (id: number) => levelById.get(status.get(id)?.[2] ?? 0)?.cents ?? 0

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/events/${eventId}/inventory`, { cache: 'no-store' }).catch(() => null)
    if (r?.ok) setAvail(await r.json())
  }, [eventId])

  useEffect(() => {
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])
  // someone else grabbed a selected seat -> drop it
  useEffect(() => setSelected((sel) => (sel.every((id) => status.get(id)?.[1] === 'a') ? sel : sel.filter((id) => status.get(id)?.[1] === 'a'))), [status])

  // wheel zoom around the cursor (non-passive so the page doesn't scroll)
  useEffect(() => {
    const el = svg.current!
    const onWheel = (e: WheelEvent) => {
      // let the page scroll unless ctrl/meta is held or the map is already zoomed in
      if (!(e.ctrlKey || e.metaKey) && vbRef.current.w >= W) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const k = e.deltaY > 0 ? 1.15 : 1 / 1.15
      setVb((v) => {
        const px = v.x + ((e.clientX - r.left) / r.width) * v.w
        const py = v.y + ((e.clientY - r.top) / r.height) * v.h
        const w = clamp(v.w * k, 80, W)
        return fit({ w, h: 0, x: px - ((px - v.x) / v.w) * w, y: py - ((py - v.y) / v.h) * (w * H / W) })
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = (k: number) => setVb((v) => fit({ w: v.w * k, h: 0, x: v.x + (v.w - v.w * k) / 2, y: v.y + (v.h - v.h * k) / 2 }))
  const down = (e: RPointerEvent) => {
    drag.current = { cx: e.clientX, cy: e.clientY, vb, moved: false }
    dragged.current = false
  }
  const move = (e: RPointerEvent) => {
    const d = drag.current
    if (!d || !(e.buttons & 1 || e.pointerType === 'touch')) return
    const r = svg.current!.getBoundingClientRect()
    const dx = e.clientX - d.cx
    const dy = e.clientY - d.cy
    if (Math.hypot(dx, dy) > 4) dragged.current = true
    if (dragged.current) setVb(fit({ ...d.vb, x: d.vb.x - (dx * d.vb.w) / r.width, y: d.vb.y - (dy * d.vb.h) / r.height }))
  }
  const showTip = (e: RPointerEvent, text: string) => {
    const r = wrap.current!.getBoundingClientRect()
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text })
  }

  function openSection(s: MapSection) {
    if (dragged.current) return void (dragged.current = false)
    setOpen(s.id)
    setVb(bbox(s.path))
  }
  function clickSeat(id: number) {
    if (dragged.current) return void (dragged.current = false)
    if (hold) return
    setMsg(null)
    setSelected((sel) => {
      if (sel.includes(id)) return sel.filter((x) => x !== id)
      if (sel.length >= ticketLimit) {
        setMsg({ error: true, text: `You can select up to ${ticketLimit} tickets.` })
        return sel
      }
      return [...sel, id]
    })
  }

  async function post(body: object) {
    setBusy(true)
    setMsg(null)
    const res = await fetch('/api/holds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventId, ...body }) }).catch(() => null)
    const data = res ? await res.json().catch(() => ({})) : {}
    if (res?.ok) {
      const ga = (body as { ga?: { sectionId: number } }).ga
      setHold({ id: data.holdId, expiresAt: data.expiresAt, seatIds: ga ? [] : data.seatIds, ga: ga ? { sectionId: ga.sectionId, qty: data.seatIds.length } : null })
      setSelected([])
    } else {
      setMsg({ error: true, text: data.error ?? 'Could not hold those tickets. Try again.' })
    }
    await refresh()
    setBusy(false)
  }

  async function release(expired = false) {
    if (hold) await fetch(`/api/holds/${hold.id}`, { method: 'DELETE' }).catch(() => null)
    setHold(null)
    setMsg(expired ? { error: true, text: 'Your hold expired and the tickets were released.' } : { error: false, text: 'Hold released.' })
    refresh()
  }

  const dimmed = (id: number, flags: number) => (adaOnly && !flags) || price(id) > maxPrice
  const visible = (s: MapSeat) => s[1] === open || (adaOnly && s[6] > 0)
  const cur = open ? sectionById.get(open) : undefined
  const curGa = cur?.kind === 'ga' ? gaById.get(cur.id) : undefined
  const minC = Math.min(...levels.map((l) => l.cents))
  const maxC = Math.max(...levels.map((l) => l.cents))
  // keyboard access for clickable SVG groups: Tab to focus, Enter/Space to activate
  const key = (fn: () => void) => ({
    role: 'button' as const,
    tabIndex: 0,
    onKeyDown: (e: RKeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        dragged.current = false
        fn()
      }
    },
  })
  const seatLabel = (s: MapSeat) => `${sectionById.get(s[1])?.name} · Row ${s[2]} · Seat ${s[3]}`
  const listed = (hold ? hold.seatIds : selected).map((id) => seatById.get(id)).filter((s): s is MapSeat => !!s)
  const total = selected.reduce((n, id) => n + price(id), 0)

  return (
    <div className="seatmap">
      <div className="map-controls">
        <label>Qty <select value={bestQty} onChange={(e) => setBestQty(+e.target.value)}>
          {Array.from({ length: ticketLimit }, (_, i) => <option key={i + 1}>{i + 1}</option>)}
        </select></label>
        <select value={bestLevel} onChange={(e) => setBestLevel(+e.target.value)} aria-label="Price level">
          <option value={0}>Any price level</option>
          {levels.map((l) => <option key={l.id} value={l.id}>{l.name} {usd(l.cents)}</option>)}
        </select>
        <button disabled={busy || !!hold} onClick={() => post({ bestAvailable: { qty: bestQty, ...(bestLevel ? { levelId: bestLevel } : {}), accessible: adaOnly } })}>Best available</button>
      </div>
      <div className="map-controls">
        <label>Max price {usd(maxPrice)} <input type="range" min={minC} max={maxC} step={100} value={maxPrice} onChange={(e) => setMaxPrice(+e.target.value)} /></label>
        <label><input type="checkbox" checked={adaOnly} onChange={(e) => setAdaOnly(e.target.checked)} /> ♿ Accessible seating</label>
      </div>

      <div className="map-wrap" ref={wrap}>
        <svg ref={svg} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} role="group" aria-label="Seat map" style={{ touchAction: vb.w < W ? 'none' : 'pan-y' }}
          onPointerDown={down} onPointerMove={move} onPointerUp={() => (drag.current = null)} onPointerLeave={() => { drag.current = null; setTip(null) }}>
          <rect x={0} y={0} width={W} height={H} fill="transparent" onClick={() => { if (!dragged.current) setOpen(null); dragged.current = false }} />
          <text x={500} y={22} textAnchor="middle" className="stage">STAGE / FIELD</text>
          {sections.map((s) => {
            const g = gaById.get(s.id)
            const ss = bySection.get(s.id) ?? []
            const rep = ss.find((x) => !x[6]) ?? ss[0]
            const lv = levelById.get(g ? g.levelId : (status.get(rep?.[0])?.[2] ?? 0))
            const free = g ? g.free : ss.filter((x) => status.get(x[0])?.[1] === 'a').length
            const off = free === 0 || (lv?.cents ?? 0) > maxPrice
            return (
              <g key={s.id} className={`sec ${open === s.id ? 'open' : ''}`} onClick={() => openSection(s)} {...key(() => openSection(s))}
                aria-label={`${s.kind === 'ga' ? 'General admission' : 'Section'} ${s.name}, ${free} available`}
                onPointerMove={(e) => showTip(e, `${s.kind === 'ga' ? 'General admission ' : 'Section '}${s.name} · ${lv ? usd(lv.cents) : ''} · ${free} available`)} onPointerLeave={() => setTip(null)}>
                <path d={s.path} fill={off ? '#2a2d45' : (lv?.color ?? '#3b82f6')} fillOpacity={open === s.id ? 0.18 : off ? 0.5 : 0.55} stroke="#9aa" strokeWidth={1} />
                {open !== s.id && <text x={s.lx} y={s.ly} textAnchor="middle" dominantBaseline="central" className="seclabel">{s.name}</text>}
              </g>
            )
          })}
          {seats.filter(visible).map((s) => {
            const [id, sid, , , x, y, flags] = s
            const st = status.get(id)
            const r = open === sid ? (radius.get(sid) ?? 5) : 5
            const state = selected.includes(id) ? 'sel' : mine.has(id) ? 'mine' : (st?.[1] ?? 's')
            const dim = dimmed(id, flags)
            const can = state === 'a' && !dim && !hold
            return (
              <g key={id} opacity={dim ? 0.2 : 1} className={`seat st-${state} ${flags ? 'ada' : ''}`} onClick={() => can || state === 'sel' ? clickSeat(id) : undefined} {...key(() => can || state === 'sel' ? clickSeat(id) : undefined)}
                aria-label={`${seatLabel(s)}, ${usd(price(id))}, ${{ a: 'available', h: 'held', s: 'sold', b: 'unavailable', sel: 'selected', mine: 'yours' }[state]}`}
                onPointerMove={(e) => showTip(e, `${seatLabel(s)} · ${usd(price(id))}${flags & 1 ? ' · ♿ accessible' : flags & 2 ? ' · companion' : ''} · ${{ a: 'available', h: 'held', s: 'sold', b: 'unavailable', sel: 'selected', mine: 'yours' }[state]}`)} onPointerLeave={() => setTip(null)}>
                <circle cx={x} cy={y} r={r} fill={state === 'a' ? (levelById.get(st?.[2] ?? 0)?.color ?? '#3b82f6') : undefined} />
                {(flags & 1) > 0 && <text x={x} y={y} fontSize={r * 1.5} textAnchor="middle" dominantBaseline="central" pointerEvents="none">♿</text>}
              </g>
            )
          })}
        </svg>
        <div className="zoom">
          <button onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom in">+</button>
          <button onClick={() => zoomBy(1.5)} aria-label="Zoom out">−</button>
          <button onClick={() => { setVb(FULL); setOpen(null) }} aria-label="Reset zoom">⟲</button>
        </div>
        {tip && <div className="tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>{tip.text}</div>}
      </div>

      <ul className="legend">
        {levels.map((l) => <li key={l.id}><i style={{ background: l.color ?? '#3b82f6' }} /> {l.name} {usd(l.cents)}</li>)}
        <li><i className="st-sel" /> Selected</li>
        <li><i className="st-mine" /> Yours (held)</li>
        <li><i className="st-h" /> Held by others</li>
        <li><i className="st-s" /> Sold</li>
        <li><i className="st-b" /> Unavailable</li>
        <li>♿ Accessible</li>
        <li className="muted"><i className="st-resale" /> Resale (coming soon)</li>
      </ul>

      <div role="status" aria-live="polite">{msg && <p className={msg.error ? 'error' : 'notice'}>{msg.text}</p>}</div>

      {cur?.kind === 'ga' && !hold && (
        <div className="card">
          <strong>General admission {cur.name}</strong> · {curGa?.free ?? 0} left · {usd(levelById.get(curGa?.levelId ?? 0)?.cents ?? 0)} each
          <div className="map-controls">
            <button aria-label="Fewer" onClick={() => setGaQty(Math.max(1, gaQty - 1))}>−</button> <strong>{gaQty}</strong>
            <button aria-label="More" onClick={() => setGaQty(Math.min(ticketLimit, gaQty + 1))}>+</button>
            <button disabled={busy || !curGa?.free} onClick={() => post({ ga: { sectionId: cur.id, qty: gaQty } })}>Hold {gaQty} ticket{gaQty === 1 ? '' : 's'}</button>
          </div>
        </div>
      )}

      {hold ? (
        <div className="card holdbar">
          <strong>Tickets held</strong> · time left <Countdown expiresAt={hold.expiresAt} onExpire={() => release(true)} />
          <ul>
            {hold.ga && <li>{hold.ga.qty} × General admission {sectionById.get(hold.ga.sectionId)?.name}</li>}
            {listed.map((s) => <li key={s[0]}>{seatLabel(s)} · {usd(price(s[0]))}</li>)}
          </ul>
          <button onClick={() => release()}>Release</button> <a className="btn" href={`/checkout/${hold.id}`}>Checkout</a>
        </div>
      ) : selected.length > 0 && (
        <div className="card">
          <strong>{selected.length} selected</strong> · {usd(total)}
          <ul>
            {listed.map((s) => <li key={s[0]}>{seatLabel(s)} · {usd(price(s[0]))} <button aria-label="Remove" onClick={() => { dragged.current = false; clickSeat(s[0]) }}>×</button></li>)}
          </ul>
          <button disabled={busy} onClick={() => post({ seatIds: selected })}>Hold {selected.length} seat{selected.length === 1 ? '' : 's'}</button>
        </div>
      )}
    </div>
  )
}
