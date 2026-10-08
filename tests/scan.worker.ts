// Worker for organizer.test.ts: own thread + own DatabaseSync connection, all workers scan the same tickets in lockstep.
import { workerData, parentPort } from 'node:worker_threads'
import { scanTicket } from '../lib/scan.ts'

const { eventId, userId, tokens, workers, counter } = workerData as { eventId: number; userId: number; tokens: string[]; workers: number; counter: SharedArrayBuffer }
const c = new Int32Array(counter)
const results: string[] = []
tokens.forEach((token, i) => {
  Atomics.add(c, 0, 1)
  Atomics.notify(c, 0)
  for (let v = Atomics.load(c, 0); v < workers * (i + 1); v = Atomics.load(c, 0)) Atomics.wait(c, 0, v, 10)
  results.push(scanTicket(eventId, token, userId).result)
})
parentPort!.postMessage(results)
