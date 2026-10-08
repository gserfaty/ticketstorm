'use client'
import { useRouter } from 'next/navigation'
import { useActionState, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { useFormStatus } from 'react-dom'
import Countdown from './Countdown.tsx'
import type { PayState } from '../app/checkout/actions.ts'
import type { Captcha } from '../lib/defense.ts'

type Saved = { id: number; brand: string; last4: string; exp: string }
const METHODS: [string, string][] = [['card', 'Card'], ['applepay', 'Apple Pay'], ['googlepay', 'Google Pay'], ['paypal', 'PayPal']]
const WALLETS = ['applepay', 'googlepay']

function Submit({ label, onClick }: { label: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void }) {
  const { pending } = useFormStatus()
  return <button disabled={pending} onClick={onClick}>{pending ? 'Processing…' : label}</button>
}

// The browser's PaymentRequest when a wallet is set up on this device; false means "use the mock confirmation instead". The server never
// receives a wallet token: a wallet payment is a simulated Visa 4242.
async function nativeWallet(method: string, cents: number): Promise<boolean> {
  if (typeof PaymentRequest === 'undefined') return false
  try {
    const supportedMethods = method === 'applepay' ? 'https://apple.com/apple-pay' : 'https://google.com/pay'
    const req = new PaymentRequest([{ supportedMethods, data: {} }], { total: { label: 'TicketStorm', amount: { currency: 'USD', value: (cents / 100).toFixed(2) } } })
    if (!(await req.canMakePayment())) return false
    const res = await req.show()
    await res.complete('success')
    return true
  } catch {
    return false
  }
}

// Card number and CVC are never given a `name` that is logged or stored server-side; they are read once by the pay action.
export default function PayForm({ action, holdId, idemKey, expiresAt, email, saved, canSave, total, totalCents, installments, captcha, deliveries, prefill, express, creditCents, labels }: {
  action: (prev: PayState, f: FormData) => Promise<PayState>
  holdId: number
  idemKey: string
  expiresAt: string
  email: string | null
  saved: Saved[]
  canSave: boolean
  total: string
  totalCents: number
  installments: string[] | null // the four payments, e.g. ["$30.00", ...]; null = not offered for this order
  captcha: Captcha
  deliveries: [string, string][] // [value, label] the event offers; mobile first
  prefill?: { bname: string; baddress: string; bcity: string; bzip: string } // the account's saved address
  labels: Record<string, string> // translated checkout strings (lib/i18n.ts checkoutLabels)
  creditCents?: number // account credit available to spend (accounts only)
  express?: boolean // saved card (first in `saved`) and saved address are filled in; only the CVC is left to type
}) {
  const router = useRouter()
  const [state, formAction] = useActionState(action, {} as PayState)
  const [method, setMethod] = useState('card')
  const [dialog, setDialog] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const v: Record<string, string> = { ...prefill, ...state.v }
  const cap = state.captcha ?? captcha
  const wallet = WALLETS.includes(method)
  const label = METHODS.find((m) => m[0] === method)![1]

  const submitConfirmed = () => formRef.current!.requestSubmit() // submits without clicking the button, so beforeSubmit is not run again
  // wallets: native sheet if the device has one, otherwise the mock modal below
  async function beforeSubmit(e: MouseEvent<HTMLButtonElement>) {
    if (!wallet) return
    e.preventDefault()
    if (!formRef.current!.reportValidity()) return
    if (await nativeWallet(method, totalCents)) submitConfirmed()
    else setDialog(true)
  }

  return (
    <form ref={formRef} action={formAction} className="stack">
      {state.error && <p className="error" role="alert">{state.error}</p>}
      <p>{labels['co.timeleft']}: <strong><Countdown expiresAt={expiresAt} onExpire={() => router.refresh()} /></strong></p>
      <input type="hidden" name="holdId" value={holdId} />
      <input type="hidden" name="key" value={idemKey} />
      <input type="hidden" name="method" value={method} />
      <h2>{labels['co.contact']}</h2>
      {email ? <p>{labels['co.sentto']} <strong>{email}</strong></p> : <input name="email" type="email" defaultValue={v.email} placeholder="Email (for your tickets)" required autoComplete="email" />}
      {deliveries.length > 1 ? (
        <label>Delivery <select name="delivery" defaultValue="mobile">{deliveries.map(([k, name]) => <option key={k} value={k}>{name}</option>)}</select></label>
      ) : <p className="muted">Delivery: Mobile ticket</p>}
      {express && <p className="notice">Express checkout: your default card and saved address are filled in. Re-enter the card&apos;s CVC and press Pay.</p>}
      <h2>{labels['co.billing']}</h2>
      <input name="bname" defaultValue={v.bname} placeholder="Full name" required autoComplete="name" />
      <input name="baddress" defaultValue={v.baddress} placeholder="Street address" required autoComplete="street-address" />
      <input name="bcity" defaultValue={v.bcity} placeholder="City" required autoComplete="address-level2" />
      <input name="bzip" defaultValue={v.bzip} placeholder="ZIP" required autoComplete="postal-code" />
      <h2>{labels['co.stored']}</h2>
      <input name="giftcode" placeholder={labels['co.giftcode']} aria-label="Gift card code" autoComplete="off" />
      {!!creditCents && <label><input type="checkbox" name="usecredit" /> {labels['co.usecredit']} (${(creditCents / 100).toFixed(2)} available)</label>}
      <p className="muted">A gift card or credit pays first; if it covers less than the total, the card below is charged only the rest.</p>
      <h2>{labels['co.payment']}</h2>
      <div className="row" role="radiogroup" aria-label="Payment method">
        {METHODS.map(([k, name]) => <label key={k}><input type="radio" checked={method === k} onChange={() => setMethod(k)} /> {name}</label>)}
      </div>
      {method === 'card' && (
        <>
          {saved.length > 0 && (
            <select name="saved" defaultValue={express ? String(saved[0].id) : ''} aria-label="Saved card">
              <option value="">New card</option>
              {saved.map((c) => <option key={c.id} value={c.id}>{c.brand} ending {c.last4} ({c.exp})</option>)}
            </select>
          )}
          <input name="number" placeholder={labels['co.cardnumber']} inputMode="numeric" autoComplete="cc-number" />
          <input name="exp" placeholder="MM/YY" autoComplete="cc-exp" />
          <input name="cvc" placeholder="CVC (also needed for a saved card)" inputMode="numeric" autoComplete="cc-csc" required={express} />
          {canSave && <label><input type="checkbox" name="save" /> Save this card</label>}
          <p className="muted">Test cards: 4242 4242 4242 4242 pays, 4000 0000 0000 0002 declines, 4000 0000 0000 3220 asks for 3D Secure.</p>
        </>
      )}
      {wallet && <p className="muted">{label} (simulated): you confirm in a mock sheet and are charged as a Visa 4242.</p>}
      {method === 'paypal' && <p className="muted">You will approve the payment on a simulated PayPal page.</p>}
      {installments && method !== 'paypal' && (
        <label><input type="checkbox" name="installments" /> Pay in 4: {installments.join(', ')}. The first is charged now, the others every 14 days or less.</label>
      )}
      <label><input type="checkbox" name="policy" required /> {labels['co.policy']}</label>
      <input type="hidden" name="captchaToken" value={cap.token} />
      <label>{labels['co.human']} {cap.question}? <input name="captchaAnswer" inputMode="numeric" required autoComplete="off" /></label>
      <input name="website" className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
      <Submit label={method === 'paypal' ? labels['co.paypal'] : `${labels['co.pay']} ${total}`} onClick={beforeSubmit} />
      {dialog && (
        <dialog open className="card" aria-label={`${label} confirmation`}>
          <p><strong>{label}</strong> (simulated): pay {total} to TicketStorm?</p>
          <button type="button" onClick={() => { setDialog(false); submitConfirmed() }}>Confirm</button>{' '}
          <button type="button" onClick={() => setDialog(false)}>Cancel</button>
        </dialog>
      )}
    </form>
  )
}
