import { getAvailability } from './inventory.ts'

// Server-sent events for seat availability. The payload is exactly getAvailability(): [seat id, status letter, level id] and per-section GA
// counts. It never carries hold ids, session tokens or who holds what.
export const MAX_STREAMS = 100 // open connections for the whole process; beyond that the client falls back to polling
export const MAX_LIFE_MS = 5 * 60_000 // the server ends a stream after this; EventSource reconnects with fresh presale windows
export const TICK_MS = 3000
let open = 0
export const acquire = () => (open < MAX_STREAMS ? (open++, true) : false)
export const release = () => void (open = Math.max(0, open - 1))
export const streamCount = () => open

export const snapshot = (eventId: number, windowIds: number[]) => JSON.stringify(getAvailability(eventId, windowIds))
