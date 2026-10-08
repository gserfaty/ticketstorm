# TicketStorm

A Ticketmaster clone for learning and demo: Next.js 15 (App Router) + React 19 + TypeScript + SQLite via Node's built-in `node:sqlite`. No ORM, no database server, no external services. Payments, email, SMS and push are all simulated locally.

Phases P1 to P9 of [docs/plan.md](docs/plan.md) are implemented. Design details are in [ARCHITECTURE.md](ARCHITECTURE.md), history in [CHANGELOG.md](CHANGELOG.md), the feature inventory that drives the plan in [docs/research.md](docs/research.md).

## Requirements

- Node.js >= 23.6 (native TypeScript type stripping and `node:sqlite`; an ExperimentalWarning is expected and harmless)
- npm

## Setup

```
npm install
npm run reset     # delete data/ticketstorm.db* and seed it
npm run dev       # http://localhost:3000
```

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Next dev server |
| `npm run build` / `npm start` | Production build / server |
| `npm run seed` | Seed the DB (no-op if users already exist) |
| `npm run reset` | `rm -f data/ticketstorm.db*` then seed. Use after any `lib/schema.sql` change |
| `npm run jobs` | Run housekeeping once (`runJobs()`): expiry tidy-up, Verified Fan lottery and waitlist promotion |
| `npm test` | `node --test "tests/**/*.test.ts"` (temp DBs, never `data/`) |
| `npm run typecheck` | `tsc --noEmit` |

## Configuration

- `DEV_OTP=1`: with `NODE_ENV=development` (`npm run dev` sets it), 2FA texts always contain `000000`. Ignored in any other mode, so it can never open a production login. Without it codes are random and you read them at `/dev/outbox`.
- `FRAUD_RANDOM_PCT` (default `3`): chance, in percent, that an order is put in review by the random fraud check. `npm test` and the seed set it to `0`.
- `TRUST_PROXY=1`: read the client IP (used for rate limits and the IP blocklist) from the **last** `x-forwarded-for` entry, i.e. the one your own reverse proxy appended. Leave it unset when the app is not behind such a proxy: every caller then shares the IP `local`, so the per-IP limits become one global limit but cannot be spoofed.

## Seed accounts

Password for all: `password123`

| Email | Role |
|---|---|
| `fan@ticketstorm.test` | fan (paid orders for 2 seats on `neon-harbor-empire-saturday` and 2 on the rescheduled show; a saved card) |
| `fan2@ticketstorm.test` | fan (one ticket listed for resale, and an order in **review**) |
| `organizer@ticketstorm.test` | owner of org "Storm Live" |
| `scanner@ticketstorm.test` | scanner in "Storm Live" |
| `admin@ticketstorm.test` | platform admin |

Seed data (deterministic, `scripts/seed.ts`): 12 cities with tax rates, 9 venues generated in 5 layouts (arena, stadium, theater, amphitheater, club), 30 artists, and 92 events: 83 random ones (80 upcoming over the next 120 days, 3 past; a few cancelled, postponed or rescheduled; about 10 percent not yet on sale) plus the fixed scenarios below.

## Seeded demo scenarios

| Slug | What to try |
|---|---|
| `neon-harbor-megatour` | Waiting room. On sale 2 minutes after `npm run reset`, admits 6 per minute, 20 inside at once, 30 seeded fans already waiting. `/queue/<eventId>`; the tickets page and `POST /api/holds` return 403 until admitted. |
| `neon-harbor-empire-wednesday` | Fan club presale open now. Premium sections are held back; enter code `STORMFAN` (25 uses) on the event page. |
| `neon-harbor-catskill-saturday` | Verified Fan campaign. Registration closes 10 minutes after reset; 1 fan is selected. Log in, register, wait, then `npm run jobs` runs the lottery once and sends codes to `/dev/outbox`. |
| `neon-harbor-empire-saturday` | Resale and pricing. `fan2` has a ticket listed (pink "Verified Resale" seat on the map). `fan` already owns 2 tickets here. Has a dynamic **Platinum** level (section 102, rows A-B, $250 base, price rises with tickets sold; a held ticket keeps its price), add-ons at checkout (**Lot A parking, inventory 1**: the second buyer gets "sold out"; tour T-shirt; club lounge), promo `FIVEOFF`, and child/senior/student offers. |
| `neon-harbor-megatour` | Also a **Meet & Greet Package** level (section 101, rows A-B, perks text) and limits of 4 per order / 6 per event. |
| `home-stand-1`, `-2`, `-3` | Three-game bundle at Empire Arena. Section `202` has a "Season Bundle" level: holding a seat there holds the same seat in all three games. |
| `neon-harbor-empire-cancelled` | Cancelled event (not buyable). |
| `neon-harbor-empire-onsale-soon` | Not yet on sale ("Upcoming"). |
| `neon-harbor-empire-rescheduled` | Rescheduled with a refund window open for 7 days. `fan` has an order: `/orders/<id>` shows "Refund this order"; after the window (`UPDATE events SET refund_window_until = ...`) the button is gone. Far enough away for **pay in 4**. |
| order of `fan2` on the rescheduled show | In **review** (new account + $500 or more scores 60). Its ticket shows no QR and the scanner refuses it. `admin` approves or cancels it at `/admin/review`. |
| `neon-harbor-empire-saturday` and `neon-harbor-catskill-saturday` | Same artist, same Saturday, two venues about 50 miles apart (radius and date-filter checks); a Wednesday show exists too. |

## Promo codes, add-ons and offers (P8)

| Code | Effect |
|---|---|
| `STORM10` | 10 percent off tickets, any event, 1000 uses |
| `FIVEOFF` | $5 off, `neon-harbor-empire-saturday` only, 100 uses |

Enter a code, pick child (50 percent), senior (25) or student (20) per ticket, and add parking, merch or hospitality on the checkout page, then press "Update order". Promo discounts reduce the taxable amount; merch and hospitality are taxed, parking is not. The header button "All-in prices" switches every displayed price between face value and face + fees + tax. Admin sets platform fees at `/admin/fees` and per-city tax at `/admin/taxes`; organizers set limits, dynamic pricing, fees, offers, add-ons and promo codes at `/organizer/[orgId]/events/[id]/pricing`. Parking and hospitality purchases create their own QR passes under My tickets, scannable at `/scan/[eventId]`.

## Trying the P9 features

- **Payment methods**: pick Card, Apple Pay, Google Pay (a mock confirm dialog appears unless your browser has a real wallet) or PayPal (you are sent to a simulated PayPal page; Approve or Cancel). The refund policy box is required.
- **Pay in 4**: log in, hold seats for a show at least 4 days away (e.g. the rescheduled one) with a total of $40 or more, tick "Pay in 4". The order page lists four payments. To charge the next ones now: `sqlite3`-style `UPDATE payments SET due_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'` (or wait), then `npm run jobs`. To see a failed installment, pay with the 3DS card `4000 0000 0000 3220` (approve the 3DS page): the later charges are off-session and are declined, the order goes to review and the buyer gets an email.
- **2FA**: log in as `fan`, `/account/security`, enter the password, turn it on (seed phones exist). Log out and in again: after the password you land on `/login/otp`; the code is in `/dev/outbox` as an SMS (`000000` when started with `DEV_OTP=1 npm run dev`). A code works once, for 10 minutes, and dies after 5 wrong tries.
- **Social login**: on `/login` press "Continue with Google". On the fake consent page type any email and Allow; a new verified account is created. Use `fan@ticketstorm.test` with "verified" ticked to link to the seeded account, or unticked to see the refusal. Not available when `NODE_ENV=production`. Accounts with 2FA still get the OTP step.
- **Protection and claims**: tick "Add ticket protection" at checkout (8 percent, untaxed). On the order page file a claim; `/admin/claims` approves (refund of everything but the premium, tickets cancelled) or denies.
- **Exchange**: on a ticket page press "Exchange for another date", pick a date and ticket type, review the difference, confirm. The `neon-harbor-*` shows share one series.
- **Organizer and admin order tools**: `/organizer/<orgId>/events/<id>/orders` (as `organizer@`): search, resend, refund (full, ticked items with or without fees, void), fraud hold, move seat, comp tickets. `/admin/orders` has the same for admins.
- **Account**: `/account` has profile, saved cards, notification preferences, security, and privacy (JSON export, delete account).

## Test cards

Any Luhn-valid number works with a future `MM/YY` expiry and a 3-4 digit CVC. Behaviour is chosen by the last four digits. Card numbers and CVCs are never stored or logged; only brand and last4 are kept.

| Number | Behaviour |
|---|---|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0000 0000 0002` | Declined (`card_declined`) |
| `4000 0000 0000 9995` | Declined (`insufficient_funds`) |
| `4000 0000 0000 3220` | Requires 3-D Secure (approve or fail on `/checkout/3ds/<id>`) |
| `4000 0000 0000 0341` | Charge succeeds, but refunds fail (used to test failed event-cancel refunds at `/admin/refunds`) |

Checkout also asks a math question (single-use captcha) and has a hidden honeypot field.

## Features implemented (P1 to P9)

- **Accounts**: signup, login, logout, email verification, password reset (links in the dev outbox), scrypt hashing, cookie sessions, lazy guest sessions that survive login, `?next=` redirects.
- **Discovery**: home (trending, near you), search with category, genre, city + radius, date range and quick "today / weekend / month" filters (venue-local dates), accessible-seating filter, suggest endpoint, category pages, event pages with lineup, venue info, status badges (On sale, Upcoming, Sold out, Cancelled, Postponed, Rescheduled, Ended).
- **Seat selection and holds**: SVG seat map (zoom, pan, keyboard access), reserved seats, general admission areas, best available, accessible seats, per-hold countdown, polling availability, bundle levels, per-account ticket limit.
- **Checkout and orders**: fake card gateway, saved cards, 3DS, declines that keep the hold, idempotent payments, fees and city tax, guest checkout with emailed order links, order and ticket pages.
- **Mobile tickets (SafeTix-style)**: QR that rotates every 15 seconds, computed in the browser from a per-ticket secret.
- **Organizer** (`/organizer`): org signup (admin approval required), events (draft, publish, cancel with automatic refunds, postpone, reschedule), price levels, fee rules, on-sale time, inventory tool (block, comp, kill, assign levels, seat ranges), venues and seating charts (generate, JSON import/export, seat flags), members and roles.
- **Scanner** (`/scan/[eventId]`): paste or camera (`BarcodeDetector`), offline queue in localStorage with retry.
- **Admin** (`/admin`): users (block, role), orgs (approve, suspend), events (approve, unpublish, edit text), feature flags (`require_event_approval`), failed refund retry.
- **Transfers**: send a ticket to an email or phone, claim link in the outbox, cancel while pending, accept issues a new ticket and secret and kills the old QR.
- **Resale**: list, cancel, buy through the normal checkout; sellers credited in a ledger (`/listings` shows balance).
- **Favorites**: hearts on events, venues and artists; `/favorites`.
- **Waiting room, presales, Verified Fan, bot defense**: see the scenarios above. Organizers manage windows, codes (CSV), held-back seats and queue rate/cap at `/organizer/[orgId]/events/[id]/access` and `.../queue`. Limits: 5 queue joins per minute and 10 login/checkout/code attempts per minute per IP and per account; `blocklist` rows (`ip` / `email`) are refused at login, queue join, checkout and code entry.
- **Pricing and inventory rules**: orphan-seat rule on manual selection and Best Available, per-order and per-event ticket limits, dynamic/Platinum pricing locked at hold time, per-event fee rules over admin defaults, per-city tax, all-in price toggle, promo codes, offers, VIP packages with perks, add-ons with scannable passes, sortable list view beside the seat map.

- **Checkout extras and accounts (P9)**: Apple/Google Pay and PayPal mocks, pay in 4, fraud review queue, confirmation email and receipt, mock social login, SMS 2FA, account pages with GDPR export and delete, ticket protection with claims, refund window for rescheduled events, one shared refund function (full, per item, void), organizer and admin order tools (search, resend, refund, hold, move seats, comps), ticket exchange. Details in ARCHITECTURE.md.

Upcoming (see [docs/plan.md](docs/plan.md)): P10 notifications, recommendations, artist and venue pages; P11 transfer/resale rules, payouts, reports, admin ops; P12 nice-to-have sweep.

## Simulated external systems

- **Email and SMS** go to the `outbox` table and `console.log`; read them at `/dev/outbox` (404 when `NODE_ENV=production`). Verify links, reset links, order confirmations, transfer claim links and Verified Fan codes all land there.
- **Push** is the `notifications` table (rows are written; there is no inbox page yet, planned for P10).
- **Payments** are the fake gateway in `lib/payments.ts`; **payouts** are not implemented (ledger only).

## Tests

`npm test` runs `node:test` suites in `tests/` (`tests/p9.test.ts` covers refund caps, exchange both ways, installments, OTP, fraud review, protection, comps, social state and account export/delete): auth, discovery helpers, a multi-connection hold race, payments and idempotency, SafeTix windows, organizer/scan/refund flows including concurrent scans, resale and transfers including concurrent buys, queue and bot defense, presales and Verified Fan, pricing (fees, tax, dynamic prices, promos, offers, add-ons, limits) and the orphan-seat rule. They use temporary SQLite files via `TICKETSTORM_DB`.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [CHANGELOG.md](CHANGELOG.md)
- [docs/plan.md](docs/plan.md)
- [docs/research.md](docs/research.md)
