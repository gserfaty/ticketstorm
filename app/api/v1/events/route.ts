import { NextResponse } from 'next/server'
import { apiAllowed, apiEvents, authenticateKey } from '../../../../lib/devtools.ts'

// Read-only, organization-scoped. The org comes from the API key, never from the request. 401 without a valid key, 429 over 60 requests a minute per key.
export async function GET(req: Request) {
  const key = authenticateKey(req.headers.get('authorization'))
  if (!key) return NextResponse.json({ error: 'A valid API key is required: Authorization: Bearer tsk_...' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } })
  if (!apiAllowed(key.keyId)) return NextResponse.json({ error: 'Rate limit: 60 requests per minute per key' }, { status: 429, headers: { 'retry-after': '60' } })
  return NextResponse.json({ data: apiEvents(key.orgId) }, { headers: { 'cache-control': 'no-store' } })
}
