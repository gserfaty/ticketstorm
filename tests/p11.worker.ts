// Worker for p11.test.ts: own thread + own connection; all workers request the full balance in lockstep.
import { workerData, parentPort } from 'node:worker_threads'
import { requestPayout } from '../lib/payouts.ts'

const { account, userId, amount, workers, counter } = workerData as { account: string; userId: number; amount: number; workers: number; counter: SharedArrayBuffer }
const c = new Int32Array(counter)
Atomics.add(c, 0, 1)
Atomics.notify(c, 0)
for (let v = Atomics.load(c, 0); v < workers; v = Atomics.load(c, 0)) Atomics.wait(c, 0, v, 10)
let ok = false
try {
  requestPayout(account, userId, amount)
  ok = true
} catch {}
parentPort!.postMessage({ ok })
