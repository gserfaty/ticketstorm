import { db } from './db.ts'

export type City = { id: number; name: string; state: string; lat: number; lng: number; tax_rate_bps: number }

const KM_PER_MI = 1.609344

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

export const kmToMi = (km: number) => km / KM_PER_MI
export const miToKm = (mi: number) => mi * KM_PER_MI

export function listCities(): City[] {
  return db.prepare('SELECT id, name, state, lat, lng, tax_rate_bps FROM cities ORDER BY name').all() as City[]
}

export function nearestCity(lat: number, lng: number): City | undefined {
  return listCities().sort(
    (a, b) => haversineKm(lat, lng, a.lat, a.lng) - haversineKm(lat, lng, b.lat, b.lng),
  )[0]
}
