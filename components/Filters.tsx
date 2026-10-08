import type { Filters as F } from '../lib/events.ts'
import { CATEGORIES } from '../lib/events.ts'
import type { City } from '../lib/geo.ts'

export default function Filters({ f, cities }: { f: F; cities: City[] }) {
  return (
    <form action="/search" className="filters">
      <input name="q" type="search" defaultValue={f.q} placeholder="Search" aria-label="Search" />
      <select name="category" defaultValue={f.category ?? ''} aria-label="Category">
        <option value="">All categories</option>
        {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
      </select>
      <select name="city" defaultValue={f.city ?? ''} aria-label="City">
        <option value="">Any city</option>
        {cities.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
      </select>
      <input name="radius" type="number" min="1" max="20000" defaultValue={f.radius} placeholder="Radius" aria-label="Radius" />
      <select name="unit" defaultValue={f.unit} aria-label="Unit">
        <option value="mi">mi</option>
        <option value="km">km</option>
      </select>
      <select name="when" defaultValue={f.when ?? ''} aria-label="When">
        <option value="">Any date</option>
        <option value="today">Today</option>
        <option value="weekend">This weekend</option>
        <option value="month">Next 30 days</option>
      </select>
      <label>From <input name="from" type="date" defaultValue={f.from} /></label>
      <label>To <input name="to" type="date" defaultValue={f.to} /></label>
      <label><input name="accessible" type="checkbox" value="1" defaultChecked={f.accessible} /> Accessible seating</label>
      {f.genre && <input type="hidden" name="genre" value={f.genre} />}
      <button>Search</button>
    </form>
  )
}
