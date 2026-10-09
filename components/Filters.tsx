import type { Filters as F } from '../lib/events.ts'
import { CATEGORIES } from '../lib/events.ts'
import type { City } from '../lib/geo.ts'

const dollars = (c?: number) => (c === undefined ? '' : String(c / 100))

export default function Filters({ f, cities, genres, venues, allIn, canDistance }: { f: F; cities: City[]; genres: string[]; venues: { slug: string; name: string }[]; allIn: boolean; canDistance: boolean }) {
  return (
    <form action="/search" className="filters">
      <input name="q" type="search" defaultValue={f.q} placeholder="Search" aria-label="Search" />
      <select name="category" defaultValue={f.category ?? ''} aria-label="Category">
        <option value="">All categories</option>
        {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
      </select>
      <select name="city" defaultValue={f.city ?? ''} aria-label="City">
        <option value="">All locations</option>
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
      <select name="genre" defaultValue={f.genre ?? ''} aria-label="Genre">
        <option value="">Any genre</option>
        {genres.map((g) => <option key={g} value={g}>{g}</option>)}
      </select>
      <select name="venue" defaultValue={f.venue ?? ''} aria-label="Venue">
        <option value="">Any venue</option>
        {venues.map((v) => <option key={v.slug} value={v.slug}>{v.name}</option>)}
      </select>
      <label>Price $ <input name="min" type="number" min="0" step="1" defaultValue={dollars(f.min)} placeholder="min" aria-label="Minimum price" style={{ width: '5rem' }} />
        – <input name="max" type="number" min="0" step="1" defaultValue={dollars(f.max)} placeholder="max" aria-label="Maximum price" style={{ width: '5rem' }} /></label>
      <span className="muted">{allIn ? 'incl. fees and tax' : 'before fees and tax'}</span>
      <label><input name="resale" type="checkbox" value="1" defaultChecked={f.resale} /> Verified resale</label>
      <label><input name="presale" type="checkbox" value="1" defaultChecked={f.presale} /> Presale</label>
      <select name="sort" defaultValue={f.sort ?? ''} aria-label="Sort by">
        <option value="">Sort: best match</option>
        <option value="date">Date</option>
        <option value="price">Price (low to high)</option>
        {canDistance && <option value="distance">Distance</option>}
        <option value="popularity">Popularity</option>
      </select>
      <button>Search</button>
    </form>
  )
}
