// Worker for holds.test.ts: own thread, own DatabaseSync connection (lib/db.ts opens $TICKETSTORM_DB).
import { workerData, parentPort } from 'node:worker_threads'
import { holdSeats, HoldError } from '../lib/inventory.ts'

const { id, eventId, workers, iterations, pools, counter } = workerData as { id: number; eventId: number; workers: number; iterations: number; pools: number[][]; counter: SharedArrayBuffer }
const c = new Int32Array(counter)

// Line all workers up at the start of each iteration so they actually collide.
function barrier(i: number) {
  Atomics.add(c, 0, 1)
  Atomics.notify(c, 0)
  for (let v = Atomics.load(c, 0); v < workers * (i + 1); v = Atomics.load(c, 0)) Atomics.wait(c, 0, v, 10)
}

let seed = id * 7919 + 1
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

const wins: { holdId: number; ids: number[] }[] = []
let conflicts = 0
for (let i = 0; i < iterations; i++) {
  barrier(i)
  // random 1-4 seats from this iteration's pool of 6 -> heavy overlap between workers
  const pool = [...pools[i]].sort(() => rnd() - 0.5)
  const ids = pool.slice(0, 1 + Math.floor(rnd() * 4))
  try {
    const h = holdSeats(eventId, { sessionToken: `w${id}-${i}`, userId: null }, ids)
    wins.push({ holdId: h.holdId, ids })
  } catch (e) {
    if (!(e instanceof HoldError)) throw e
    conflicts++
  }
}
parentPort!.postMessage({ wins, conflicts })
