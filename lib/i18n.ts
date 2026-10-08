// English / Spanish for the navigation and checkout. Anything missing in Spanish falls back to English. The language is a cookie (`lang`) set by the header switch.
export const LANGS = ['en', 'es'] as const
export type Lang = (typeof LANGS)[number]
export const validLang = (v: unknown): Lang => (LANGS as readonly unknown[]).includes(v) ? (v as Lang) : 'en'

const en = {
  'nav.discover': 'Discover', 'nav.map': 'Map', 'nav.gift': 'Gift cards', 'nav.inbox': 'Inbox', 'nav.account': 'Account', 'nav.tickets': 'My tickets', 'nav.orders': 'Orders',
  'nav.settings': 'Account settings', 'nav.favorites': 'Favorites', 'nav.sell': 'Sell tickets', 'nav.listings': 'My listings', 'nav.seller': 'Seller dashboard', 'nav.claims': 'Claims',
  'nav.payouts': 'Payouts', 'nav.organizer': 'Organizer', 'nav.become': 'Become an organizer', 'nav.admin': 'Admin', 'nav.logout': 'Log out', 'nav.login': 'Log in', 'nav.signup': 'Sign up',
  'nav.lookup': 'Find a guest order', 'nav.help': 'Help', 'nav.skip': 'Skip to main content', 'nav.language': 'Language', 'nav.set': 'Set', 'nav.show': 'Show', 'nav.cities': 'All cities',
  'nav.allin_on': 'All-in prices: on', 'nav.allin_off': 'All-in prices: off',
  'co.title': 'Checkout', 'co.total': 'Total', 'co.contact': 'Contact', 'co.billing': 'Billing address', 'co.payment': 'Payment', 'co.stored': 'Gift card and credit',
  'co.timeleft': 'Time left to pay', 'co.pay': 'Pay', 'co.processing': 'Processing…', 'co.sentto': 'Tickets will be sent to', 'co.giftcode': 'Gift card code (optional)',
  'co.usecredit': 'Use my account credit', 'co.policy': 'I accept the refund policy: refunds only if the event is cancelled, or within the window after it is rescheduled, or with ticket protection.',
  'co.update': 'Update order', 'co.promo': 'Promo code', 'co.back': 'Back to seat map', 'co.human': 'Are you human?', 'co.cardnumber': 'Card number', 'co.paypal': 'Continue to PayPal',
} as const
export type Key = keyof typeof en

const es: Partial<Record<Key, string>> = {
  'nav.discover': 'Descubrir', 'nav.map': 'Mapa', 'nav.gift': 'Tarjetas de regalo', 'nav.inbox': 'Bandeja', 'nav.account': 'Cuenta', 'nav.tickets': 'Mis entradas', 'nav.orders': 'Pedidos',
  'nav.settings': 'Ajustes de la cuenta', 'nav.favorites': 'Favoritos', 'nav.sell': 'Vender entradas', 'nav.listings': 'Mis anuncios', 'nav.seller': 'Panel de vendedor', 'nav.claims': 'Reclamaciones',
  'nav.payouts': 'Cobros', 'nav.organizer': 'Organizador', 'nav.become': 'Hazte organizador', 'nav.admin': 'Administración', 'nav.logout': 'Cerrar sesión', 'nav.login': 'Iniciar sesión', 'nav.signup': 'Registrarse',
  'nav.lookup': 'Buscar un pedido de invitado', 'nav.help': 'Ayuda', 'nav.skip': 'Saltar al contenido principal', 'nav.language': 'Idioma', 'nav.set': 'Aplicar', 'nav.show': 'Mostrar', 'nav.cities': 'Todas las ciudades',
  'nav.allin_on': 'Precios con todo incluido: sí', 'nav.allin_off': 'Precios con todo incluido: no',
  'co.title': 'Pago', 'co.total': 'Total', 'co.contact': 'Contacto', 'co.billing': 'Dirección de facturación', 'co.payment': 'Método de pago', 'co.stored': 'Tarjeta de regalo y crédito',
  'co.timeleft': 'Tiempo restante para pagar', 'co.pay': 'Pagar', 'co.processing': 'Procesando…', 'co.sentto': 'Las entradas se enviarán a', 'co.giftcode': 'Código de tarjeta de regalo (opcional)',
  'co.usecredit': 'Usar mi crédito de cuenta', 'co.policy': 'Acepto la política de reembolsos: solo si el evento se cancela, dentro del plazo tras una reprogramación o con protección de entradas.',
  'co.update': 'Actualizar pedido', 'co.promo': 'Código promocional', 'co.back': 'Volver al mapa de asientos', 'co.human': '¿Eres humano?', 'co.cardnumber': 'Número de tarjeta', 'co.paypal': 'Continuar a PayPal',
}

export const t = (lang: Lang, key: Key): string => (lang === 'es' ? es[key] : undefined) ?? en[key]
// the checkout strings as a plain object, to hand to a client component
export const checkoutLabels = (lang: Lang): Record<string, string> => Object.fromEntries((Object.keys(en) as Key[]).filter((k) => k.startsWith('co.')).map((k) => [k, t(lang, k)]))
