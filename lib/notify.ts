import { db } from './db.ts'

export const APP_URL = process.env.APP_URL ?? 'http://localhost:3000'

function send(channel: 'email' | 'sms', to: string, subject: string | null, body: string) {
  db.prepare('INSERT INTO outbox (channel, "to", subject, body) VALUES (?,?,?,?)').run(channel, to, subject, body)
  console.log(`[outbox:${channel}] to=${to} subject=${subject ?? ''}\n${body}`)
}

export const sendEmail = (to: string, subject: string, body: string) => send('email', to, subject, body)
export const sendSms = (to: string, body: string) => send('sms', to, null, body)

// In-app (push stand-in) notification
export function notify(userId: number, kind: string, title: string, body = '', link = '') {
  db.prepare('INSERT INTO notifications (user_id, kind, title, body, link) VALUES (?,?,?,?,?)').run(userId, kind, title, body, link)
}
