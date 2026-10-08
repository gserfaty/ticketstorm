'use client'
import { useEffect, useState } from 'react'

type Group = { name?: string; title?: string }

export default function SearchBox({ defaultValue = '' }: { defaultValue?: string }) {
  const [q, setQ] = useState(defaultValue)
  const [options, setOptions] = useState<{ label: string; value: string }[]>([])

  useEffect(() => {
    if (q.trim().length < 2) return setOptions([])
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/suggest?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal })
        const d = (await r.json()) as Record<'artists' | 'events' | 'venues', Group[]>
        setOptions(
          (['artists', 'events', 'venues'] as const).flatMap((k) =>
            d[k].map((x) => ({ label: k.slice(0, -1), value: (x.name ?? x.title)! })),
          ),
        )
      } catch {}
    }, 200)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q])

  return (
    <>
      <input name="q" type="search" list="suggestions" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Search artists, events, venues" aria-label="Search" autoComplete="off" />
      <datalist id="suggestions">
        {options.map((o) => <option key={o.label + o.value} value={o.value} label={o.label} />)}
      </datalist>
    </>
  )
}
