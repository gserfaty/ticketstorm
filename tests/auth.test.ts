import test from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword } from '../lib/auth.ts'

test('hash verifies only the right password', () => {
  const h = hashPassword('password123')
  assert.ok(!h.includes('password123'))
  assert.ok(verifyPassword('password123', h))
  assert.ok(!verifyPassword('password124', h))
})

test('hashes are salted', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'))
})

test('malformed stored hash is rejected', () => {
  assert.ok(!verifyPassword('x', 'plaintext'))
})
