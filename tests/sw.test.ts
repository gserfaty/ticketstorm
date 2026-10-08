import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Runs public/sw.js against a tiny fake of the service-worker globals: offline fallback, what it refuses to touch, and cache clearing.
function boot(online: boolean) {
  const stores = new Map<string, Map<string, string>>()
  const handlers: Record<string, (e: any) => void> = {}
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (k: string) => stores.delete(k),
    open: async (k: string) => {
      if (!stores.has(k)) stores.set(k, new Map())
      const s = stores.get(k)!
      return { match: async (u: string) => (s.has(u) ? new Response(s.get(u)) : undefined), put: async (u: string | Request, r: Response) => void s.set(typeof u === 'string' ? u : u.url, await r.text()) }
    },
    match: async () => undefined,
  }
  const self = { location: { origin: 'http://t' }, skipWaiting() {}, clients: { claim: async () => {} }, addEventListener: (n: string, f: (e: any) => void) => (handlers[n] = f) }
  const fetchFn = async () => { if (!online) throw new Error('offline'); return new Response('live page') }
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, caches, fetch: fetchFn, URL, Response })
  const ask = async (url: string, o: { method?: string; mode?: string } = {}) => {
    let out: Promise<Response> | undefined
    const waits: Promise<unknown>[] = []
    handlers.fetch({ request: { url, method: o.method ?? 'GET', mode: o.mode ?? 'navigate' }, respondWith: (p: Promise<Response>) => (out = p), waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    return out && (await out)
  }
  return { stores, ask }
}

test('service worker: serves a saved ticket page offline, never other pages, and clears on logout or login', async () => {
  const off = boot(false)
  off.stores.set('ts-tickets-u1', new Map([['http://t/tickets/5', 'saved ticket page']]))
  assert.equal(await (await off.ask('http://t/tickets/5'))!.text(), 'saved ticket page')
  assert.equal((await off.ask('http://t/tickets/6'))!.status, 503) // not saved
  assert.equal(await off.ask('http://t/orders/5'), undefined) // not a ticket page: the SW does not answer
  assert.equal(await off.ask('http://t/tickets/5/print'), undefined)
  assert.equal(await off.ask('http://elsewhere/tickets/5'), undefined)
  const on = boot(true)
  on.stores.set('ts-tickets-u1', new Map([['http://t/tickets/5', 'stale']]))
  assert.equal(await (await on.ask('http://t/tickets/5'))!.text(), 'live page') // online: network first
  for (const path of ['/logout', '/login', '/signup']) {
    on.stores.set('ts-tickets-u1', new Map([['x', 'y']]))
    assert.equal(await on.ask(`http://t${path}`, { method: 'POST' }), undefined)
    assert.equal(on.stores.size, 0, path) // cleared, request left alone
  }
  on.stores.set('ts-tickets-u1', new Map())
  await on.ask('http://t/orders', { method: 'POST' })
  assert.equal(on.stores.size, 1) // other POSTs leave the cache alone
})
