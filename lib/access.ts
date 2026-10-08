import { randomBytes, randomInt } from 'node:crypto'
import { db, tx } from './db.ts'
import { APP_URL, notify, sendEmail, sendSms } from './notify.ts'
import { UserError } from './platform.ts'

export const WINDOW_KINDS = ['public', 'artist', 'venue', 'card', 'fanclub', 'promoter', 'verified_fan', 'sponsor']
const iso = (ms: number) => new Date(ms).toISOString()

// Windows this session may buy from right now: open, and either code-free or unlocked by this session.
export function openWindowIds(eventId: number, sessionToken: string | null | undefined, nowIso = iso(Date.now())): number[] {
  return (
    db
      .prepare(
        `SELECT w.id FROM onsale_windows w WHERE w.event_id = ? AND w.starts_at <= ? AND w.ends_at > ?
         AND (w.requires_code = 0 OR EXISTS (SELECT 1 FROM window_unlocks u WHERE u.window_id = w.id AND u.session_token = ?))`,
      )
      .all(eventId, nowIso, nowIso, sessionToken ?? '') as { id: number }[]
  ).map((r) => r.id)
}

// Enter a presale code on the event page. The use is counted by a guarded UPDATE, so a code with max_uses N unlocks N sessions, never N+1.
// Re-entering for a session that already unlocked the window costs nothing.
export function redeemCode(eventId: number, sessionToken: string, userId: number | null, raw: string, now = Date.now()): number {
  return tx(() => {
    const c = db
      .prepare(
        `SELECT c.id, c.window_id, c.user_id, w.starts_at, w.ends_at FROM access_codes c JOIN onsale_windows w ON w.id = c.window_id
         WHERE w.event_id = ? AND c.code = ?`,
      )
      .get(eventId, raw.trim().toUpperCase()) as { id: number; window_id: number; user_id: number | null; starts_at: string; ends_at: string } | undefined
    if (!c) throw new UserError('That code is not valid for this event')
    if (c.ends_at <= iso(now)) throw new UserError('This presale has ended')
    if (c.starts_at > iso(now)) throw new UserError('This presale has not started yet')
    if (c.user_id !== null && c.user_id !== userId) throw new UserError(userId ? 'This code belongs to another account' : 'Log in to use this code')
    if (db.prepare('SELECT 1 FROM window_unlocks WHERE window_id = ? AND session_token = ?').get(c.window_id, sessionToken)) return c.window_id
    if (db.prepare('UPDATE access_codes SET uses = uses + 1 WHERE id = ? AND uses < max_uses').run(c.id).changes !== 1) throw new UserError('This code has been used up')
    db.prepare('INSERT INTO window_unlocks (window_id, session_token) VALUES (?,?)').run(c.window_id, sessionToken)
    return c.window_id
  })
}

// ---- organizer side (callers have authorised the actor for the event's org) ----
export type WindowForm = { name: string; kind: string; startsAt: string | null; endsAt: string | null; requiresCode: boolean; regStarts: string | null; regEnds: string | null; slots: number; buyBy: string | null }

export function addWindow(eventId: number, f: WindowForm): number {
  if (!f.name || f.name.length > 80) throw new UserError('Name required (80 characters max)')
  if (!WINDOW_KINDS.includes(f.kind)) throw new UserError('Pick a window type')
  if (!f.startsAt || !f.endsAt || f.startsAt >= f.endsAt) throw new UserError('Enter a start before the end')
  const vf = f.kind === 'verified_fan'
  if (vf) {
    if (!f.regStarts || !f.regEnds || f.regStarts >= f.regEnds || f.regEnds > f.startsAt) throw new UserError('Registration must open and close before the sale starts')
    if (!Number.isInteger(f.slots) || f.slots < 1 || f.slots > 100_000) throw new UserError('Fans to select must be a whole number from 1 to 100000')
    if (f.buyBy && (f.buyBy <= f.startsAt || f.buyBy >= f.endsAt)) throw new UserError('Buy-by must fall inside the sale window')
  }
  return Number(
    db
      .prepare('INSERT INTO onsale_windows (event_id, name, kind, starts_at, ends_at, requires_code, reg_starts, reg_ends, vf_slots, vf_buy_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(eventId, f.name, f.kind, f.startsAt, f.endsAt, vf || f.requiresCode ? 1 : 0, vf ? f.regStarts : null, vf ? f.regEnds : null, vf ? f.slots : null, vf ? f.buyBy : null).lastInsertRowid,
  )
}

const ownWindow = (eventId: number, windowId: number) => {
  if (!db.prepare('SELECT 1 FROM onsale_windows WHERE id = ? AND event_id = ?').get(windowId, eventId)) throw new UserError('Window not found')
}

const newCode = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex').toUpperCase()}`

export function generateCodes(eventId: number, windowId: number, n: number, maxUses: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new UserError('Generate 1 to 1000 codes')
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100_000) throw new UserError('Uses per code must be a whole number from 1 to 100000')
  return tx(() => {
    ownWindow(eventId, windowId)
    const ins = db.prepare('INSERT INTO access_codes (window_id, code, max_uses) VALUES (?,?,?)')
    for (let i = 0; i < n; i++) ins.run(windowId, newCode('PS'), maxUses)
    return n
  })
}

export function codesCsv(eventId: number, windowId: number): string {
  ownWindow(eventId, windowId)
  const rows = db.prepare('SELECT code, max_uses, uses FROM access_codes WHERE window_id = ? ORDER BY id').all(windowId) as { code: string; max_uses: number; uses: number }[]
  return ['code,max_uses,uses', ...rows.map((r) => `${r.code},${r.max_uses},${r.uses}`)].join('\n') + '\n'
}

// Move a section (or one row) of available seats into a window; windowId 0 puts them back on public sale. Held/sold seats are never touched.
export function assignWindow(eventId: number, windowId: number, sectionId: number, row: string): number {
  return tx(() => {
    if (windowId) ownWindow(eventId, windowId)
    if (!db.prepare('SELECT 1 FROM sections s JOIN events e ON e.venue_id = s.venue_id WHERE s.id = ? AND e.id = ?').get(sectionId, eventId)) throw new UserError('Pick a section')
    const r = db
      .prepare(
        `UPDATE inventory SET window_id = ? WHERE event_id = ? AND section_id = ? AND status = 'available' AND
         (? = '' OR seat_id IN (SELECT id FROM seats WHERE section_id = ? AND row = ?)) AND (window_id IS NULL) = ?`,
      )
      .run(windowId || null, eventId, sectionId, row, sectionId, row, windowId ? 1 : 0)
    return Number(r.changes)
  })
}

export function setQueue(eventId: number, enabled: boolean, rate: number, cap: number) {
  if (enabled && (!Number.isInteger(rate) || rate < 1 || rate > 100_000)) throw new UserError('Rate must be a whole number from 1 to 100000 per minute')
  if (enabled && (!Number.isInteger(cap) || cap < 1 || cap > 100_000)) throw new UserError('Cap must be a whole number from 1 to 100000')
  db.prepare('UPDATE events SET queue_enabled = ?, queue_rate = ?, queue_cap = ? WHERE id = ?').run(enabled ? 1 : 0, enabled ? rate : null, enabled ? cap : null, eventId)
}

// ---- Verified Fan ----
export function registerVf(windowId: number, userId: number, now = Date.now()) {
  const w = db.prepare("SELECT reg_starts, reg_ends FROM onsale_windows WHERE id = ? AND kind = 'verified_fan'").get(windowId) as { reg_starts: string; reg_ends: string } | undefined
  if (!w) throw new UserError('Registration not found')
  if (w.reg_starts > iso(now) || w.reg_ends <= iso(now)) throw new UserError('Registration is closed')
  if (db.prepare('INSERT OR IGNORE INTO vf_registrations (window_id, user_id) VALUES (?,?)').run(windowId, userId).changes !== 1) throw new UserError('You are already registered')
}

type Win = { id: number; event_id: number; vf_slots: number; title: string; slug: string }

function giveCode(w: Win, reg: { id: number; user_id: number }) {
  const code = newCode('VF')
  db.prepare('INSERT INTO access_codes (window_id, code, max_uses, user_id) VALUES (?,?,1,?)').run(w.id, code, reg.user_id)
  db.prepare("UPDATE vf_registrations SET status = 'selected', code = ? WHERE id = ?").run(code, reg.id)
  const u = db.prepare('SELECT email, phone FROM users WHERE id = ?').get(reg.user_id) as { email: string; phone: string | null }
  const link = `${APP_URL}/events/${w.slug}?code=${code}`
  sendEmail(u.email, `You're in: Verified Fan for ${w.title}`, `You were selected! Your one-time presale code is ${code}.\nUse it here: ${link}`)
  if (u.phone) sendSms(u.phone, `TicketStorm: you're selected for ${w.title}. Code ${code}: ${link}`)
  notify(reg.user_id, 'vf', `You were selected for ${w.title}`, `Your presale code: ${code}`, `/events/${w.slug}?code=${code}`)
}

// Once per window after registration closes (claimed by `lottery_at`, so repeat runs do nothing): shuffle, first N selected, the rest waitlisted.
export function runLottery(now = Date.now()) {
  const due = db
    .prepare("SELECT id FROM onsale_windows WHERE kind = 'verified_fan' AND lottery_at IS NULL AND reg_ends <= ?")
    .all(iso(now)) as { id: number }[]
  for (const { id } of due)
    tx(() => {
      if (db.prepare('UPDATE onsale_windows SET lottery_at = ? WHERE id = ? AND lottery_at IS NULL').run(iso(now), id).changes !== 1) return
      const w = db.prepare('SELECT w.id, w.event_id, w.vf_slots, e.title, e.slug FROM onsale_windows w JOIN events e ON e.id = w.event_id WHERE w.id = ?').get(id) as Win
      const regs = db.prepare('SELECT id, user_id FROM vf_registrations WHERE window_id = ?').all(id) as { id: number; user_id: number }[]
      for (let i = regs.length - 1; i > 0; i--) {
        const j = randomInt(i + 1)
        ;[regs[i], regs[j]] = [regs[j], regs[i]]
      }
      regs.forEach((r, i) => {
        db.prepare('UPDATE vf_registrations SET lottery_rank = ? WHERE id = ?').run(i, r.id)
        if (i < w.vf_slots) giveCode(w, r)
        else {
          db.prepare("UPDATE vf_registrations SET status = 'waitlisted' WHERE id = ?").run(r.id)
          notify(r.user_id, 'vf', `You are on the waitlist for ${w.title}`, 'We will email you if a spot opens up.')
        }
      })
    })
}

// Once per window after `vf_buy_by`: selected fans with no paid order lose their code, and the same number of waitlisted fans are selected in their place.
export function promoteWaitlist(now = Date.now()) {
  const due = db
    .prepare('SELECT id FROM onsale_windows WHERE lottery_at IS NOT NULL AND promoted_at IS NULL AND vf_buy_by IS NOT NULL AND vf_buy_by <= ? AND ends_at > ?')
    .all(iso(now), iso(now)) as { id: number }[]
  for (const { id } of due)
    tx(() => {
      if (db.prepare('UPDATE onsale_windows SET promoted_at = ? WHERE id = ? AND promoted_at IS NULL').run(iso(now), id).changes !== 1) return
      const w = db.prepare('SELECT w.id, w.event_id, w.vf_slots, e.title, e.slug FROM onsale_windows w JOIN events e ON e.id = w.event_id WHERE w.id = ?').get(id) as Win
      const idle = db
        .prepare(
          `SELECT r.id, r.user_id FROM vf_registrations r WHERE r.window_id = ? AND r.status = 'selected' AND NOT EXISTS
           (SELECT 1 FROM orders o WHERE o.user_id = r.user_id AND o.event_id = ? AND o.status IN ('paid','review','partially_refunded'))`,
        )
        .all(id, w.event_id) as { id: number; user_id: number }[]
      const next = db.prepare("SELECT id, user_id FROM vf_registrations WHERE window_id = ? AND status = 'waitlisted' ORDER BY lottery_rank LIMIT ?").all(id, idle.length) as { id: number; user_id: number }[]
      for (const r of idle) {
        db.prepare('UPDATE access_codes SET max_uses = uses WHERE window_id = ? AND user_id = ?').run(id, r.user_id)
        db.prepare("UPDATE vf_registrations SET status = 'expired', code = NULL WHERE id = ?").run(r.id)
        db.prepare('DELETE FROM window_unlocks WHERE window_id = ? AND session_token IN (SELECT token FROM sessions WHERE user_id = ?)').run(id, r.user_id)
        notify(r.user_id, 'vf', `Your presale code for ${w.title} expired`, 'You did not buy in time, so your spot went to the waitlist.')
      }
      for (const r of next) giveCode(w, r)
    })
}

// Presale inventory nobody bought goes back on public sale once its window closes.
export function releaseEndedWindows(now = Date.now()) {
  db.prepare("UPDATE inventory SET window_id = NULL WHERE status = 'available' AND window_id IN (SELECT id FROM onsale_windows WHERE ends_at <= ?)").run(iso(now))
}
