// Static SVG map: equirectangular projection of a ~9 km window around the point, no tiles, no scripts. Other venues in the window are dots.
type Pt = { lat: number; lng: number; name: string }
const W = 360
const H = 220
const SPAN_LAT = 0.08

export default function MiniMap({ lat, lng, name, others = [] }: { lat: number; lng: number; name: string; others?: Pt[] }) {
  const k = Math.cos((lat * Math.PI) / 180)
  const spanLng = (SPAN_LAT * W) / H / k // keep the pixels square
  const pos = (p: { lat: number; lng: number }) => [((p.lng - lng) / spanLng + 0.5) * W, (0.5 - (p.lat - lat) / SPAN_LAT) * H]
  const near = others.filter((o) => Math.abs(o.lat - lat) < SPAN_LAT / 2 && Math.abs(o.lng - lng) < spanLng / 2)
  const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`
  return (
    <figure>
      <svg className="minimap" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Map showing ${name}`}>
        {[1, 2, 3, 4, 5].map((i) => <line key={`v${i}`} x1={(W / 6) * i} y1={0} x2={(W / 6) * i} y2={H} stroke="#223" />)}
        {[1, 2, 3].map((i) => <line key={`h${i}`} x1={0} y1={(H / 4) * i} x2={W} y2={(H / 4) * i} stroke="#223" />)}
        {near.map((o) => { const [x, y] = pos(o); return <g key={o.name}><circle cx={x} cy={y} r={4} fill="#6b7280" /><text x={x + 7} y={y + 4} fontSize={10} fill="#9aa">{o.name}</text></g> })}
        <circle cx={W / 2} cy={H / 2} r={7} fill="#f87171" stroke="#fff" strokeWidth={2} />
        <text x={W / 2} y={H / 2 - 12} fontSize={12} fill="#fff" textAnchor="middle">{name}</text>
      </svg>
      <figcaption className="muted"><a href={osm} rel="noopener noreferrer" target="_blank">Open in OpenStreetMap</a> · {lat.toFixed(4)}, {lng.toFixed(4)}</figcaption>
    </figure>
  )
}
