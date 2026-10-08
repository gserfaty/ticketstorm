import { randomBytes } from 'node:crypto'
import { db, tx } from './db.ts'
import { mac } from './defense.ts'
import { money } from './format.ts'
import { HoldError } from './inventory.ts'
import { ledgerAdd } from './ledger.ts'
import { APP_URL, sendEmail } from './notify.ts'
import { charge, brandOf, validateCard } from './payments.ts'
import { UserError } from './platform.ts'
import { addCredit, giftAccount } from './stored.ts'

export const MIN_GIFT = 1000
export const MAX_GIFT = 50_000

// 16 characters from a 32-letter alphabet = 80 bits of randomness (unguessable; balance checks are rate-limited as well).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function newCode(): string {
  const b = randomBytes(16)
  const c = Array.from(b, (x) => ALPHABET[x % 32]).join('')
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12)}`
}
export const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')
const hashOf = (code: string) => mac(`gift:${normalize(code)}`).toString('hex')

export type Gift = { id: number; balance: number; last4: string }

// The card for a typed code, or undefined. Only the keyed hash is stored, so the code is looked up by hash.
export function findGift(code: string): Gift | undefined {
  if (normalize(code).length !== 16) return undefined
  const g = db.prepare('SELECT id, balance_cents AS balance, last4 FROM gift_cards WHERE code_hash = ?').get(hashOf(code)) as Gift | undefined
  return g && { ...g }
}

// For checkout: a usable card (exists, has a balance) or a HoldError with one message for "wrong" and "empty".
export function usableGift(code: string): Gift {
  const g = findGift(code)
  if (!g || g.balance <= 0) throw new HoldError('That gift card code is not valid or has no balance left', 409)
  return g
}

export type Purchase = { amount: number; recipient: string; message: string; number: string; exp: string; cvc: string }

// "Buy a gift card": a fake charge on a test card, then the code is emailed to the recipient (never shown on screen). Returns the card id.
export function purchaseGift(purchaserId: number, p: Purchase): number {
  if (!Number.isInteger(p.amount) || p.amount < MIN_GIFT || p.amount > MAX_GIFT) throw new UserError(`Choose an amount from ${money(MIN_GIFT)} to ${money(MAX_GIFT)}`)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.recipient) || p.recipient.length > 200) throw new UserError('Enter the recipient email')
  if (p.message.length > 300) throw new UserError('The message is limited to 300 characters')
  const err = validateCard({ number: p.number, exp: p.exp, cvc: p.cvc })
  if (err) throw new UserError(err)
  const o = charge(p.number.slice(-4))
  if (o.status === 'declined') throw new UserError('Your card was declined')
  if (o.status === 'requires_3ds') throw new UserError('3-D Secure cards cannot be used for gift cards in this demo')
  const code = newCode()
  const buyer = db.prepare('SELECT email FROM users WHERE id = ?').get(purchaserId) as { email: string }
  const id = tx(() => {
    const id = Number(db.prepare('INSERT INTO gift_cards (code_hash, last4, initial_cents, balance_cents, purchaser_id, recipient_email, message) VALUES (?,?,?,?,?,?,?)').run(hashOf(code), code.slice(-4), p.amount, p.amount, purchaserId, p.recipient.toLowerCase(), p.message || null).lastInsertRowid)
    ledgerAdd('cash', 'sale', -p.amount, `giftcard:${id}:purchase`)
    ledgerAdd(giftAccount(id), 'sale', p.amount, `giftcard:${id}:purchase`)
    return id
  })
  sendEmail(p.recipient.toLowerCase(), `You received a ${money(p.amount)} TicketStorm gift card`, `${p.message ? `"${p.message}"\n` : ''}Your gift card code: ${code}\nUse it at checkout, or check the balance at ${APP_URL}/gift-cards. Keep this code private.`)
  if (p.recipient.toLowerCase() !== buyer.email) sendEmail(buyer.email, `Your ${money(p.amount)} gift card was sent`, `We emailed the code for your ${money(p.amount)} gift card to ${p.recipient}.`)
  return id
}

// Move a card's whole balance to the user's account credit. Inside BEGIN IMMEDIATE the balance is read and zeroed with a guard on the value read,
// so a double click or a concurrent checkout cannot spend it twice.
export function redeemToCredit(userId: number, code: string): number {
  return tx(() => {
    const g = findGift(code)
    if (!g || g.balance <= 0) throw new UserError('That gift card code is not valid or has no balance left')
    if (db.prepare('UPDATE gift_cards SET balance_cents = 0 WHERE id = ? AND balance_cents = ?').run(g.id, g.balance).changes !== 1) throw new UserError('The balance changed, try again')
    addCredit(userId, g.balance, `giftcard:${g.id}`)
    ledgerAdd(giftAccount(g.id), 'sale', -g.balance, `giftcard:${g.id}:redeem`)
    ledgerAdd(`credit:${userId}`, 'sale', g.balance, `giftcard:${g.id}:redeem`)
    return g.balance
  })
}
