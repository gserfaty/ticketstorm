import { db } from './db.ts'
import { UserError } from './platform.ts'

export const ADA_KINDS = ['Wheelchair space', 'Companion seat', 'Hearing assistance', 'ASL interpreter', 'Sensory-friendly seating', 'Service animal', 'Other']

// Minimal support ticket (P11 adds the admin reply thread on top): one opening message.
export function createSupportTicket(userId: number | null, email: string, kind: string, subject: string, text: string): number {
  return Number(
    db
      .prepare('INSERT INTO support_tickets (user_id, email, kind, subject, messages) VALUES (?,?,?,?,?)')
      .run(userId, email, kind, subject, JSON.stringify([{ from: email, at: new Date().toISOString(), text }])).lastInsertRowid,
  )
}

// ADA / accommodation request. `context` is the event or venue the fan was looking at (looked up by slug, never trusted as text).
export function createAdaRequest(userId: number | null, f: { email: string; name: string; need: string; details: string; event?: string; venue?: string }): number {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email) || f.email.length > 200) throw new UserError('Enter a valid email address')
  if (!ADA_KINDS.includes(f.need)) throw new UserError('Choose what you need')
  if (!f.details || f.details.length > 2000) throw new UserError('Describe your request (2000 characters max)')
  if (f.name.length > 100) throw new UserError('Name is limited to 100 characters')
  const ev = f.event ? (db.prepare('SELECT title FROM events WHERE slug = ?').get(f.event) as { title: string } | undefined) : undefined
  const ve = f.venue ? (db.prepare('SELECT name FROM venues WHERE slug = ?').get(f.venue) as { name: string } | undefined) : undefined
  const where = ev ? ` for ${ev.title}` : ve ? ` at ${ve.name}` : ''
  return createSupportTicket(userId, f.email.toLowerCase(), 'ada', `ADA request: ${f.need}${where}`, `${f.name ? `From: ${f.name}\n` : ''}${f.details}`)
}
