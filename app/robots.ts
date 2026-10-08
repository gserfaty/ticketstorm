import type { MetadataRoute } from 'next'
import { APP_URL } from '../lib/notify.ts'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/admin', '/organizer', '/api/', '/checkout', '/tickets', '/orders', '/account', '/transfers', '/party', '/dev', '/lookup'] },
    sitemap: `${APP_URL}/sitemap.xml`,
  }
}
