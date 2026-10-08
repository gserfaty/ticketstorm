import { db } from './db.ts'
import { tx } from './db.ts'
import { UserError } from './platform.ts'
import { APP_URL, notify, sendEmail } from './notify.ts'

export const ADA_KINDS = ['Wheelchair space', 'Companion seat', 'Hearing assistance', 'ASL interpreter', 'Sensory-friendly seating', 'Service animal', 'Other']

// Support ticket: an opening message; staff replies and fan follow-ups are appended to the JSON thread (addMessage).
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

export type Msg = { from: string; at: string; text: string; staff?: boolean }
export type Ticket = { id: number; created_at: string; user_id: number | null; email: string; kind: string; subject: string; status: string; messages: Msg[] }
const parse = (r: Omit<Ticket, 'messages'> & { messages: string }): Ticket => ({ ...r, messages: JSON.parse(r.messages) })

export const getSupportTicket = (id: number): Ticket | undefined => {
  const r = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id) as (Omit<Ticket, 'messages'> & { messages: string }) | undefined
  return r && parse(r)
}
export const userTickets = (userId: number): Ticket[] =>
  (db.prepare('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY id DESC').all(userId) as (Omit<Ticket, 'messages'> & { messages: string })[]).map(parse)

// Contact form (/help). Same checks as other forms; kind 'general'.
export function createContact(userId: number | null, email: string, subject: string, text: string): number {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new UserError('Enter a valid email address')
  if (!subject || subject.length > 120) throw new UserError('Subject required (120 characters max)')
  if (!text || text.length > 2000) throw new UserError('Message required (2000 characters max)')
  return createSupportTicket(userId, email.toLowerCase(), 'general', subject, text)
}

// Append a message in one tx (read-modify-write under BEGIN IMMEDIATE). Staff replies set 'answered', email the ticket's address (essential, no preference)
// and notify the user in-app; a fan's follow-up reopens the ticket. `userId` set = the fan, who must own the ticket.
export function addMessage(ticketId: number, by: { staff: true; name: string } | { staff: false; userId: number }, text: string) {
  text = text.trim()
  if (!text || text.length > 2000) throw new UserError('Message required (2000 characters max)')
  tx(() => {
    const t = getSupportTicket(ticketId)
    if (!t || (!by.staff && t.user_id !== by.userId)) throw new UserError('Ticket not found')
    if (t.status === 'closed' && !by.staff) throw new UserError('This ticket is closed')
    const m: Msg = by.staff ? { from: by.name, at: new Date().toISOString(), text, staff: true } : { from: t.email, at: new Date().toISOString(), text }
    db.prepare('UPDATE support_tickets SET messages = ?, status = ? WHERE id = ?').run(JSON.stringify([...t.messages, m]), by.staff ? 'answered' : 'open', ticketId)
    if (by.staff) {
      sendEmail(t.email, `Re: ${t.subject} (support ticket #${t.id})`, `${text}\n\n${t.user_id ? `View the conversation: ${APP_URL}/support/${t.id}` : 'Reply to this message to continue.'}`)
      if (t.user_id) notify(t.user_id, 'support', `Support replied: ${t.subject}`, text.slice(0, 140), `/support/${t.id}`)
    }
  })
}

export function closeTicket(ticketId: number) {
  if (db.prepare("UPDATE support_tickets SET status = 'closed' WHERE id = ? AND status != 'closed'").run(ticketId).changes !== 1) throw new UserError('Ticket not found or already closed')
}
