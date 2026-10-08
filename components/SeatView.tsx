// "View from seat": an illustrative perspective drawing generated from the seat's position on the chart (the stage is at the top centre,
// x 500, y 40). Farther seats see a smaller stage, side seats see it off-centre. Obstructed seats get a pillar in front. Not a photo.
const STAGE = { x: 500, y: 40 }

export default function SeatView({ x, y, obstructed, label }: { x: number; y: number; obstructed: boolean; label: string }) {
  const dx = x - STAGE.x
  const dist = Math.max(Math.hypot(dx, y - STAGE.y), 60)
  const w = Math.min(Math.max(26000 / dist, 40), 260) // apparent stage width
  const cx = 160 - (dx / dist) * 90 // off-centre for side seats
  const top = 62 + Math.min(dist / 700, 1) * 36 // farther = higher up = stage lower in the frame
  const h = w * 0.28
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox="0 0 320 180" role="img" aria-label={`Illustrative view from ${label}${obstructed ? ', partly blocked by a pillar' : ''}`} style={{ width: '100%', maxWidth: 320, borderRadius: 6, background: '#0b0c1a' }}>
        <defs><linearGradient id="vs-hall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1b1d3a" /><stop offset="1" stopColor="#0d0e22" /></linearGradient></defs>
        <rect width={320} height={180} fill="url(#vs-hall)" />
        <polygon points={`0,180 320,180 ${cx + w * 0.9},${top + h} ${cx - w * 0.9},${top + h}`} fill="#15162e" />
        <rect x={cx - w / 2} y={top} width={w} height={h} fill="#7c3aed" stroke="#c4b5fd" />
        <rect x={cx - w / 2 + w * 0.1} y={top - h * 0.5} width={w * 0.8} height={h * 0.5} fill="#312e81" />
        {Array.from({ length: 9 }, (_, i) => <circle key={i} cx={20 + i * 35 + ((i * 7) % 11)} cy={168 - ((i * 5) % 7)} r={13} fill="#05060f" />)}
        {obstructed && <rect x={96} y={0} width={34} height={180} fill="#3a3340" stroke="#9a8f8f" />}
      </svg>
      <figcaption className="muted">{obstructed ? 'Limited view: a pillar or rail blocks part of the stage. ' : ''}Illustration generated from the seat position, not a photo.</figcaption>
    </figure>
  )
}
