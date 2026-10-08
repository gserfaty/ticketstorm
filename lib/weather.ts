import { createHash } from 'node:crypto'

// SIMULATED forecast: a pure function of (date, city), so the same show always "has" the same weather. Not real data; the UI says so.
const SKY = ['Sunny', 'Partly cloudy', 'Cloudy', 'Light rain', 'Clear evening', 'Windy']

export function weather(ymd: string, city: string, lat = 40): { sky: string; highC: number; lowC: number; rainPct: number } {
  const h = createHash('sha256').update(`${ymd}|${city}`).digest()
  const month = Number(ymd.slice(5, 7))
  const season = Math.cos(((month - 7) / 12) * 2 * Math.PI) // +1 in July, -1 in January (northern hemisphere)
  const base = 18 + 12 * season - (Math.abs(lat) - 35) * 0.4
  const highC = Math.round(base + (h[0] % 9) - 4)
  const sky = SKY[h[1] % SKY.length]
  return { sky, highC, lowC: highC - 5 - (h[2] % 4), rainPct: sky === 'Light rain' ? 60 + (h[3] % 30) : h[3] % 25 }
}
