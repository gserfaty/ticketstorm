import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const g = globalThis as { __db?: DatabaseSync }

function open(): DatabaseSync {
  const dir = join(process.cwd(), 'data')
  mkdirSync(dir, { recursive: true })
  const d = new DatabaseSync(process.env.TICKETSTORM_DB ?? join(dir, 'ticketstorm.db'))
  d.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
  d.exec(readFileSync(join(process.cwd(), 'lib', 'schema.sql'), 'utf8'))
  return d
}

// cached on globalThis so Next dev hot reload doesn't open a connection per edit
export const db = (g.__db ??= open())

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
