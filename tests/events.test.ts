import test from 'node:test'
import assert from 'node:assert/strict'
import { likeEscape, localDate, whenRange } from '../lib/format.ts'

test('weekend is Fri-Sun', () => {
  assert.deepEqual(whenRange('weekend', '2026-10-07'), ['2026-10-09', '2026-10-11']) // Wed
  assert.deepEqual(whenRange('weekend', '2026-10-10'), ['2026-10-10', '2026-10-11']) // Sat
  assert.deepEqual(whenRange('weekend', '2026-10-11'), ['2026-10-11', '2026-10-11']) // Sun
})

test('today is the venue-local date, not UTC', () => {
  const now = '2026-10-08T00:54:00Z' // Wed 8:54pm EDT, already Thursday in UTC
  assert.deepEqual(whenRange('today', localDate(now, 'America/New_York')), ['2026-10-07', '2026-10-07'])
})

test('localDate uses the venue tz', () => {
  assert.equal(localDate('2026-10-11T02:00:00Z', 'America/Los_Angeles'), '2026-10-10')
})

test('likeEscape neutralises wildcards', () => {
  assert.equal(likeEscape('100%_a\\'), '100\\%\\_a\\\\')
})
