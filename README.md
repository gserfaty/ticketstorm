# TicketStorm

A Ticketmaster clone: Next.js 15 + React 19 + TypeScript + SQLite (`node:sqlite`). No ORM, no DB server. See `docs/plan.md`.

Requires Node >= 23.6 (type stripping + `node:sqlite`).

## Setup

```
npm install
npm run reset     # delete data/ticketstorm.db* and seed it
npm run dev       # http://localhost:3000
```

Other scripts: `npm run seed`, `npm run jobs`, `npm test`, `npm run typecheck`, `npm run build`.

Emails and SMS are simulated: open `/dev/outbox` for verify and reset links.

## Seed accounts

Password for all: `password123`

| Email | Role |
|---|---|
| `fan@ticketstorm.test` | fan |
| `fan2@ticketstorm.test` | fan |
| `organizer@ticketstorm.test` | owner of org "Storm Live" |
| `scanner@ticketstorm.test` | scanner in "Storm Live" |
| `admin@ticketstorm.test` | platform admin |

Seed data: 12 cities, 8 venues, 30 artists, 83 events (80 upcoming over the next 120 days, 3 past).

## Organizer, scanner, admin

- `/organizer` (org members): events, pricing, inventory (kill/block/assign levels), venues + seating charts, members. New orgs start `pending`; an admin approves them at `/admin/orgs` before they can publish. Flag `require_event_approval` (`/admin/flags`) hides newly published events until approved at `/admin/events`.
- `/scan/[eventId]` (scanner, box office, manager, owner): paste a SafeTix code or use the camera; offline scans queue in localStorage and retry.
- Cancelling an event refunds every order (`refundEvent`); failed refunds (card 4000 0000 0000 0341) stay `cancelled` and show at `/admin/refunds` for retry.

## Transfers, resale, favorites

- Ticket page (`/tickets/[id]`): send to an email or phone (claim link goes to `/dev/outbox`), cancel while pending; recipient opens `/transfers/[id]?token=`, logs in or signs up, accepts. The accepted ticket gets a new secret; the old QR is dead.
- `/sell` and `/listings`: list a valid ticket at a price; resale seats show pink on the map and under "Verified Resale" on the ticket picker. Buyers hold the listing, then use normal checkout. Sellers are credited in `ledger` (no seller fee until P11).
- Hearts on event cards/pages (events, venues, lineup artists); `/favorites` lists them. Guests are sent to log in.

## Waiting room, presales, Verified Fan

- `neon-harbor-megatour` has a waiting room and goes on sale 2 minutes after `npm run reset` (6 admitted/min, 20 inside at once, 30 seeded fans already waiting). `/queue/[eventId]` joins (math question + hidden honeypot) and polls every 5s; the tickets page and `POST /api/holds` return 403 until admitted. Organizers set it at `/organizer/[orgId]/events/[id]/queue`.
- `neon-harbor-empire-wednesday` has a fan club presale open now: enter code `STORMFAN` on the event page to see and hold the held-back seats.
- `neon-harbor-catskill-saturday` has a Verified Fan campaign (1 fan selected) that closes registration in 10 minutes; log in and register on the event page. After it closes, `npm run jobs` runs the lottery once and sends codes to `/dev/outbox`.
- Organizers manage windows, codes (CSV) and held-back seats at `/organizer/[orgId]/events/[id]/access`.
- Limits: 5 queue joins/min and 10 checkout/login attempts/min per IP and per account; `blocklist` rows (`ip`/`email`) are refused at login, queue join and checkout.
