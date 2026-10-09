'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as RKeyboardEvent, PointerEvent as RPointerEvent } from 'react'
import Countdown from './Countdown.tsx'
import SeatView from './SeatView.tsx'

export type MapSection = { id: number; name: string; kind: 'reserved' | 'ga'; path: string; lx: number; ly: number; rank: number }
// cents = the price to display (already all-in when the fan chose all-in pricing)
export type MapLevel = { id: number; name: string; color: string | null; cents: number; type: string; perks: string | null }
// [inventory id, section id, row, number, x, y, flags] flags: 1 accessible, 2 companion, 4 limited view (obstructed)
export type MapSeat = [number, number, string, number, number, number, number]
export type Avail = { seats: (readonly [number, string, number])[]; ga: { sectionId: number; levelId: number; total: number; free: number }[] }
export type Hold = { id: number; expiresAt: string; seatIds: number[]; ga: { sectionId: number; qty: number } | null }

type Props = { eventId: number; ticketLimit: number; allIn: boolean; qty: number; sections: MapSection[]; levels: MapLevel[]; seats: MapSeat[]; initial: Avail; hold: Hold | null; accessibleFirst?: boolean }
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

export default function SeatMap({ eventId, ticketLimit, allIn, qty, sections, levels, seats, initial, hold: initialHold, accessibleFirst = false }: Props) {
  const [avail, setAvail] = useState(initial)
  const [hold, setHold] = useState(initialHold)
  const [selected, setSelected] = useState<number[]>([])
  const [open, setOpen] = useState<number | null>(initialHold?.ga?.sectionId ?? null)
  const [vb, setVb] = useState<VB>(FULL)
  const [sort, setSort] = useState<'price' | 'best'>('price')
  const [maxPrice, setMaxPrice] = useState(Math.max(...levels.map((l) => l.cents)))
  const [adaOnly, setAdaOnly] = useState(accessibleFirst)
  const [companion, setCompanion] = useState(true) // an accessible seat also holds the companion seat beside it
  const [bestQty, setBestQty] = useState(qty)
  const [bestLevel, setBestLevel] = useState(0)
  const [gaQty, setGaQty] = useState(Math.min(qty, ticketLimit))
  const [msg, setMsg] = useState<{ error: boolean; text: string } | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<number | null>(null) // seat shown in the "view from seat" panel
  const [rove, setRove] = useState<number | null>(null) // the one seat in the Tab order (roving tabindex); arrow keys move it
  const svg = useRef<SVGSVGElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const drag = useRef<{ cx: number; cy: number; vb: VB; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const vbRef = useRef(vb)
  vbRef.current = vb

  // after "Hold N seats" keyboard focus would fall to <body>: move it to the Checkout link
  useEffect(() => { if (hold) document.getElementById('checkout-link')?.focus() }, [hold?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // List view: every section that still has seats, with its cheapest open price. Sort by lowest price or best seats (section rank).
  const list = useMemo(() => {
    const rows: { s: MapSection; free: number; cents: number; level: string }[] = []
    for (const s of sections) {
      let free = 0
      let best: MapLevel | undefined
      if (s.kind === 'ga') {
        const g = gaById.get(s.id)
        free = g?.free ?? 0
        best = levelById.get(g?.levelId ?? 0)
      } else {
        for (const x of bySection.get(s.id) ?? []) {
          const st = status.get(x[0])
          const lv = levelById.get(st?.[2] ?? 0)
          if (st?.[1] === 'a' && lv) {
            free++
            if (!best || lv.cents < best.cents) best = lv
          }
        }
      }
      if (free && best && best.cents <= maxPrice) rows.push({ s, free, cents: best.cents, level: best.name })
    }
    return rows.sort((a, b) => (sort === 'price' ? a.cents - b.cents || a.s.rank - b.s.rank : a.s.rank - b.s.rank || a.cents - b.cents))
  }, [sections, bySection, gaById, levelById, status, sort, maxPrice])

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/events/${eventId}/inventory`, { cache: 'no-store' }).catch(() => null)
    if (r?.ok) setAvail(await r.json())
  }, [eventId])

  // live updates over SSE (/api/events/[id]/stream); when it is unavailable (no EventSource, 503 over the cap, a dropped connection) poll every 5s
  const [live, setLive] = useState(false)
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined
    const stopPolling = () => { clearInterval(t); t = undefined }
    const poll = () => { t ??= setInterval(refresh, 5000) }
    if (typeof EventSource === 'undefined') {
      poll()
      return stopPolling
    }
    const es = new EventSource(`/api/events/${eventId}/stream`)
    es.onmessage = (m) => { stopPolling(); setLive(true); setAvail(JSON.parse(m.data)) }
    es.onerror = () => { setLive(false); poll() } // the browser keeps retrying; polling covers the gap (and a permanent 503)
    return () => { es.close(); stopPolling() }
  }, [refresh, eventId])
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

  function openSection(s: MapSection, fromKeyboard = false) {
    if (dragged.current) return void (dragged.current = false)
    setOpen(s.id)
    setVb(bbox(s.path))
    // keyboard users land on the first seat of the section, so they do not tab through every section label to reach it
    if (fromKeyboard) setTimeout(() => svg.current?.querySelector<SVGGElement>(`[data-sec="${s.id}"]`)?.focus(), 50)
  }
  // Arrow keys move focus to the nearest seat in that direction (same section); Enter / Space select it; Escape goes back to the section.
  function seatKeys(e: RKeyboardEvent, seat: MapSeat, activate: () => void) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      dragged.current = false
      return activate()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(null)
      setVb(FULL)
      return void setTimeout(() => svg.current?.querySelector<SVGGElement>(`[data-section="${seat[1]}"]`)?.focus(), 50)
    }
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key]
    if (!dir) return
    e.preventDefault()
    let best: MapSeat | undefined
    let bestScore = Infinity
    for (const o of bySection.get(seat[1]) ?? []) {
      const dx = (o[4] - seat[4]) * dir[0]
      const dy = (o[5] - seat[5]) * dir[1]
      const along = dx + dy
      const across = Math.abs((o[4] - seat[4]) * dir[1]) + Math.abs((o[5] - seat[5]) * dir[0])
      if (o === seat || along <= 0.01) continue
      const score = along + across * 2
      if (score < bestScore) (best = o, (bestScore = score))
    }
    if (best) svg.current?.querySelector<SVGGElement>(`[data-seat="${best[0]}"]`)?.focus()
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

  const dimmed = (id: number, flags: number) => (adaOnly && !(flags & 3)) || price(id) > maxPrice
  const visible = (s: MapSeat) => s[1] === open || (adaOnly && (s[6] & 3) > 0)
  const tabSeat = seats.find((x) => x[0] === rove && visible(x))?.[0] ?? seats.find(visible)?.[0] // roving tabindex: one tabbable seat
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

      <div className="map-layout">
      <div className="map-wrap" ref={wrap}>
        <svg ref={svg} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} role="group" aria-label="Seat map" style={{ touchAction: vb.w < W ? 'none' : 'pan-y' }}
          onPointerDown={down} onPointerMove={move} onPointerUp={() => (drag.current = null)} onPointerLeave={() => { drag.current = null; setTip(null) }}>
          <rect x={0} y={0} width={W} height={H} fill="transparent" onClick={() => { if (!dragged.current) setOpen(null); dragged.current = false }} />
          <text x={500} y={22} textAnchor="middle" className="stage">STAGE / FIELD</text>
          {sections.map((s) => {
            const g = gaById.get(s.id)
            const ss = bySection.get(s.id) ?? []
            const rep = ss.find((x) => !(x[6] & 3)) ?? ss[0]
            const lv = levelById.get(g ? g.levelId : (status.get(rep?.[0])?.[2] ?? 0))
            const free = g ? g.free : ss.filter((x) => status.get(x[0])?.[1] === 'a').length
            const off = free === 0 || (lv?.cents ?? 0) > maxPrice
            return (
              <g key={s.id} data-section={s.id} className={`sec ${open === s.id ? 'open' : ''}`} onClick={() => openSection(s)} {...key(() => openSection(s, true))}
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
              <g key={id} data-seat={id} data-sec={sid} opacity={dim ? 0.2 : 1} className={`seat st-${state} ${flags & 3 ? 'ada' : ''} ${flags & 4 ? 'ltd' : ''}`} onClick={() => can || state === 'sel' ? clickSeat(id) : undefined}
                role="button" aria-pressed={state === 'sel' || state === 'mine'} aria-disabled={!(can || state === 'sel')} tabIndex={id === tabSeat ? 0 : -1}
                onKeyDown={(e) => seatKeys(e, s, () => (can || state === 'sel' ? clickSeat(id) : undefined))}
                onFocus={() => { setView(id); setRove(id) }} aria-label={`${seatLabel(s)}${flags & 4 ? ', limited view' : ''}, ${state === 'r' ? '' : usd(price(id)) + ', '}${{ a: 'available', h: 'held', s: 'sold', b: 'unavailable', r: 'verified resale', sel: 'selected', mine: 'yours' }[state]}`}
                onPointerMove={(e) => { setView(id); showTip(e, `${seatLabel(s)}${state === 'r' ? '' : ' · ' + usd(price(id))}${flags & 1 ? ' · ♿ accessible' : flags & 2 ? ' · companion' : ''}${flags & 4 ? ' · limited view' : ''} · ${{ a: 'available', h: 'held', s: 'sold', b: 'unavailable', r: 'verified resale', sel: 'selected', mine: 'yours' }[state]}`) }} onPointerLeave={() => setTip(null)}>
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
      <aside className="listview" aria-label="Sections with tickets">
        <label>Sort <select value={sort} onChange={(e) => setSort(e.target.value as 'price' | 'best')}>
          <option value="price">Lowest price</option>
          <option value="best">Best seats</option>
        </select></label>
        <ul>
          {list.map((r) => (
            <li key={r.s.id}>
              <button onClick={() => openSection(r.s)}>{r.s.kind === 'ga' ? 'GA ' : 'Section '}{r.s.name}</button>{' '}
              {r.level} · {usd(r.cents)}{allIn ? ' all-in' : ''} <span className="muted">{r.free} left</span>
            </li>
          ))}
          {list.length === 0 && <li className="muted">Nothing in this price range.</li>}
        </ul>
        {view !== null && seatById.get(view) && (
          <>
            <h3>View from seat</h3>
            <SeatView x={seatById.get(view)![4]} y={seatById.get(view)![5]} obstructed={(seatById.get(view)![6] & 4) > 0} label={seatLabel(seatById.get(view)!)} />
            <p className="muted">{seatLabel(seatById.get(view)!)}</p>
          </>
        )}
      </aside>
      </div>

      <p className="muted">{live ? 'Live seat updates on.' : 'Seat updates refresh every few seconds.'} Hover or focus a seat to preview the view. Keyboard: Tab to a section and press Enter, move between seats with the arrow keys, Enter selects, Escape goes back to the sections.</p>
      <ul className="legend">
        {levels.map((l) => <li key={l.id} title={l.perks ?? undefined}><i style={{ background: l.color ?? '#3b82f6' }} /> {l.name} {usd(l.cents)}</li>)}
        <li><i className="st-sel" /> Selected</li>
        <li><i className="st-mine" /> Yours (held)</li>
        <li><i className="st-h" /> Held by others</li>
        <li><i className="st-s" /> Sold</li>
        <li><i className="st-b" /> Unavailable</li>
        <li>♿ Accessible</li>
        <li><i className="ltd" /> Limited view (pillar or rail)</li>
        <li className="muted">{allIn ? 'Prices include fees and tax' : 'Prices before fees and tax'}</li>
        <li><i className="st-r" /> Verified Resale (buy below the map)</li>
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
          <button onClick={() => release()}>Release</button> <a className="btn" id="checkout-link" href={`/checkout/${hold.id}`}>Checkout</a>
        </div>
      ) : selected.length > 0 && (
        <div className="card">
          <strong>{selected.length} selected</strong> · {usd(total)}
          {listed.some((s) => s[6] & 1) && (
            <p><label><input type="checkbox" checked={companion} onChange={(e) => setCompanion(e.target.checked)} /> Also hold the companion seat beside each accessible seat (counts toward your ticket limit)</label></p>
          )}
          <ul>
            {listed.map((s) => <li key={s[0]}>{seatLabel(s)} · {usd(price(s[0]))} <button aria-label="Remove" onClick={() => { dragged.current = false; clickSeat(s[0]) }}>×</button></li>)}
          </ul>
          <button disabled={busy} onClick={() => post({ seatIds: selected, companion })}>Hold {selected.length} seat{selected.length === 1 ? '' : 's'}</button>
        </div>
      )}
    </div>
  )
}
