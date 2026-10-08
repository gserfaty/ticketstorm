// Worker for p12b.test.ts: own thread + own DB connection; all workers try to accept their own offer on the SAME listing in lockstep.
import { workerData, parentPort } from 'node:worker_threads'
import { HoldError } from '../lib/inventory.ts'
import { acceptOffer } from '../lib/offers.ts'

const { id, sellerId, offerId, workers, counter } = workerData as { id: number; sellerId: number; offerId: number; workers: number; counter: SharedArrayBuffer }
const c = new Int32Array(counter)
Atomics.add(c, 0, 1)
Atomics.notify(c, 0)
for (let v = Atomics.load(c, 0); v < workers; v = Atomics.load(c, 0)) Atomics.wait(c, 0, v, 10)
let result = 'lost'
try {
  acceptOffer(sellerId, offerId)
  result = 'won'
} catch (e) {
  if (!(e instanceof HoldError)) throw e
}
parentPort!.postMessage({ id, result })
