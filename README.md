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
