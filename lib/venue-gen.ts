// Deterministic venue chart generator. Canvas is a 1000x800 SVG viewBox; the stage sits at the top.
export type GenSeat = { row: string; number: number; x: number; y: number; accessible: number; companion: number; obstructed: number }
export type GenSection = {
  name: string
  kind: 'reserved' | 'ga'
  capacity: number | null
  path: string
  label_x: number
  label_y: number
  rank: number // lower = better seats
  seats: GenSeat[]
}
export type VenueKind = 'arena' | 'stadium' | 'theater' | 'amphitheater' | 'club'

const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}z`
const rowLabel = (i: number) => String.fromCharCode(65 + i)

function reserved(name: string, x: number, y: number, w: number, h: number, rows: number, perRow: number, rank: number): GenSection {
  const seats: GenSeat[] = []
  for (let r = 0; r < rows; r++) {
    for (let n = 1; n <= perRow; n++) {
      const lastRow = r === rows - 1
      seats.push({
        row: rowLabel(r),
        number: n,
        x: Math.round((x + (w * (n - 0.5)) / perRow) * 10) / 10,
        y: Math.round((y + (h * (r + 0.5)) / rows) * 10) / 10,
        // ADA spots at the back of each block, each with its companion seat right beside it (1+2, 4+5)
        accessible: lastRow && (n === 1 || n === 4) ? 1 : 0,
        companion: lastRow && (n === 2 || n === 5) ? 1 : 0,
        obstructed: 0,
      })
    }
  }
  return { name, kind: 'reserved', capacity: null, path: rect(x, y, w, h), label_x: x + w / 2, label_y: y + h / 2, rank, seats }
}

function ga(name: string, x: number, y: number, w: number, h: number, capacity: number, rank: number): GenSection {
  return { name, kind: 'ga', capacity, path: rect(x, y, w, h), label_x: x + w / 2, label_y: y + h / 2, rank, seats: [] }
}

export function generateVenue(kind: VenueKind): GenSection[] {
  switch (kind) {
    case 'arena':
      return [
        ga('Floor', 300, 90, 400, 240, 1200, 1),
        reserved('101', 80, 90, 200, 240, 12, 10, 2),
        reserved('102', 300, 350, 400, 170, 12, 24, 2),
        reserved('103', 720, 90, 200, 240, 12, 10, 2),
        reserved('201', 80, 550, 200, 210, 10, 14, 3),
        reserved('202', 300, 550, 400, 210, 10, 24, 3),
        reserved('203', 720, 550, 200, 210, 10, 14, 3),
      ]
    case 'stadium':
      return [
        ga('Field', 300, 200, 400, 300, 3000, 1),
        reserved('West', 60, 150, 220, 400, 20, 12, 2),
        reserved('East', 720, 150, 220, 400, 20, 12, 2),
        reserved('North', 300, 40, 400, 140, 8, 36, 3),
        reserved('South', 300, 520, 400, 140, 8, 36, 3),
        reserved('Upper North', 60, 690, 880, 90, 5, 60, 4),
      ]
    case 'theater':
      return [
        reserved('Orchestra', 200, 100, 600, 300, 16, 24, 1),
        reserved('Mezzanine', 200, 430, 600, 130, 8, 26, 2),
        reserved('Balcony', 200, 590, 600, 130, 8, 28, 3),
      ]
    case 'amphitheater':
      return [
        reserved('Pavilion A', 100, 100, 230, 300, 12, 12, 1),
        reserved('Pavilion B', 350, 100, 300, 300, 12, 18, 1),
        reserved('Pavilion C', 670, 100, 230, 300, 12, 12, 1),
        ga('Lawn', 100, 440, 800, 300, 2000, 2),
      ]
    case 'club':
      return [ga('Floor', 150, 150, 700, 500, 600, 1)]
  }
}

export const venueCapacity = (secs: GenSection[]) => secs.reduce((n, s) => n + (s.kind === 'ga' ? (s.capacity ?? 0) : s.seats.length), 0)
