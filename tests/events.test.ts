import test from 'node:test'
import assert from 'node:assert/strict'
import { likeEscape, localDate, whenRange } from '../lib/format.ts'

test('weekend is Fri-Sun', () => {
  assert.deepEqual(whenRange('weekend', new Date('2026-10-07T12:00:00Z')), ['2026-10-09', '2026-10-11']) // Wed
  assert.deepEqual(whenRange('weekend', new Date('2026-10-10T12:00:00Z')), ['2026-10-10', '2026-10-11']) // Sat
  assert.deepEqual(whenRange('weekend', new Date('2026-10-11T12:00:00Z')), ['2026-10-11', '2026-10-11']) // Sun
})

test('localDate uses the venue tz', () => {
  assert.equal(localDate('2026-10-11T02:00:00Z', 'America/Los_Angeles'), '2026-10-10')
})

test('likeEscape neutralises wildcards', () => {
  assert.equal(likeEscape('100%_a\\'), '100\\%\\_a\\\\')
})
