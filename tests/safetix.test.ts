import test from 'node:test'
import assert from 'node:assert/strict'
import { makeToken, verifyToken, WINDOW_MS } from '../lib/safetix.ts'

const secret = 'a'.repeat(64)
const t0 = 1_800_000_000_000

test('current window and +/-1 verify, +/-2 fail', () => {
  const tok = makeToken(7, secret, t0)
  assert.ok(verifyToken(tok, secret, t0))
  assert.ok(verifyToken(tok, secret, t0 + WINDOW_MS))
  assert.ok(verifyToken(tok, secret, t0 - WINDOW_MS))
  assert.ok(!verifyToken(tok, secret, t0 + 2 * WINDOW_MS))
  assert.ok(!verifyToken(tok, secret, t0 - 2 * WINDOW_MS))
})

test('tampering fails', () => {
  const [id, w, mac] = makeToken(7, secret, t0).split('.')
  assert.ok(!verifyToken(`8.${w}.${mac}`, secret, t0))
  assert.ok(!verifyToken(`${id}.${Number(w) + 1}.${mac}`, secret, t0))
  assert.ok(!verifyToken(`${id}.${w}.${'0'.repeat(64)}`, secret, t0))
  assert.ok(!verifyToken(`${id}.${w}.${mac}`, 'b'.repeat(64), t0))
  assert.ok(!verifyToken('garbage', secret, t0))
})

test('token changes each 15s window', () => {
  assert.notEqual(makeToken(7, secret, t0), makeToken(7, secret, t0 + WINDOW_MS))
})
