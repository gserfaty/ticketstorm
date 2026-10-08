// Worker for resale.test.ts: own thread + own DatabaseSync connection. All workers try to buy the same listing in lockstep.
import { workerData, parentPort } from 'node:worker_threads'
import { HoldError } from '../lib/inventory.ts'
import { finalize } from '../lib/orders.ts'
import { holdListing } from '../lib/resale.ts'

const { id, userId, listingId, workers, counter } = workerData as { id: number; userId: number; listingId: number; workers: number; counter: SharedArrayBuffer }
const c = new Int32Array(counter)
Atomics.add(c, 0, 1)
Atomics.notify(c, 0)
for (let v = Atomics.load(c, 0); v < workers; v = Atomics.load(c, 0)) Atomics.wait(c, 0, v, 10)

let result = 'lost'
try {
  const sessionToken = `buyer-${id}`
  const { holdId } = holdListing(listingId, { sessionToken, userId })
  const r = finalize({
    holdId, sessionToken, userId, email: `b${id}@x.test`, key: `race-key-${id}-padding`, method: 'card', brand: 'Visa', last4: '4242', exp: '12/39',
    save: false, billing: { name: 'B', address: 'a', city: 'c', zip: '1' },
  })
  result = 'orderId' in r ? 'won' : 'payment'
} catch (e) {
  if (!(e instanceof HoldError)) throw e
}
parentPort!.postMessage({ id, result })
