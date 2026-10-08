import type { NextConfig } from 'next'

// Every page refuses to be framed by other sites (clickjacking); only /embed/* (a static event card with no cookies and no actions) may be framed anywhere.
const config: NextConfig = {
  async headers() {
    return [{ source: '/((?!embed/).*)', headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'self'" }, { key: 'X-Frame-Options', value: 'SAMEORIGIN' }] }]
  },
}

export default config
