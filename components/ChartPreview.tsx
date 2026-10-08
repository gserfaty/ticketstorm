// Small seating-chart preview: section shapes only, shaded by rank (best seats brightest).
export default function ChartPreview({ sections }: { sections: { name: string; path: string; rank: number; kind: string }[] }) {
  const shade = (r: number) => ['#ec4899', '#a855f7', '#3b82f6', '#14b8a6'][Math.min(Math.max(r, 1), 4) - 1]
  return (
    <svg className="chartprev" viewBox="0 0 1000 800" role="img" aria-label={`Seating chart with ${sections.length} sections`}>
      {sections.map((s) => <path key={s.name} d={s.path} fill={shade(s.rank)} fillOpacity={0.5} stroke="#9aa" strokeWidth={2}><title>{s.kind === 'ga' ? 'General admission ' : 'Section '}{s.name}</title></path>)}
    </svg>
  )
}
