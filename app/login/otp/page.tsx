import Flash from '../../../components/Flash.tsx'
import { devOtp } from '../../../lib/twofa.ts'
import { resendOtpAction, verifyOtpAction } from '../../actions.ts'

export default async function Otp({ searchParams }: { searchParams: Promise<{ p?: string; next?: string; error?: string; notice?: string }> }) {
  const { p = '', next = '', error, notice } = await searchParams
  return (
    <>
      <h1>Enter your code</h1>
      <Flash error={error} notice={notice} />
      <p>We texted a 6-digit code to the phone on your account. It expires in 10 minutes.</p>
      {devOtp() && <p className="muted">Dev mode: the code is 000000 (DEV_OTP=1).</p>}
      <form action={verifyOtpAction} className="stack">
        <input type="hidden" name="p" value={p} />
        <input type="hidden" name="next" value={next} />
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} placeholder="123456" required />
        <button>Verify</button>
      </form>
      <form action={resendOtpAction}>
        <input type="hidden" name="p" value={p} />
        <input type="hidden" name="next" value={next} />
        <button>Resend code</button>
      </form>
    </>
  )
}
