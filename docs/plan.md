# TicketStorm Implementation Plan

**Status: P1 to P12B are all implemented (see CHANGELOG.md).**

Source of truth for the developer and critic agents. Feature refs (§N) point to docs/research.md.

## Stack
- **Next.js 15 (App Router) + React 19 + TypeScript + SQLite via Node's built-in `node:sqlite` (`DatabaseSync`).** One process, one language, no ORM/DB server/native build. Node v23.7 verified to support it (SQLite 3.47.2: RETURNING, partial indexes, JSON). ExperimentalWarning is harmless.
- Server Actions for forms; route handlers for JSON (inventory polling, holds, queue, scanner, autocomplete, ICS, pass).
- Scripts/tests run as plain `node` on `.ts` (type stripping default in Node ≥23.6) — no tsx/jest. Tests use `node:test`.
- **Runtime deps: `next`, `react`, `react-dom`, `qrcode`.** Dev deps: `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `@types/qrcode`. Nothing else.
- Native over libs: one `app/globals.css` (no Tailwind); scrypt passwords + HMAC SafeTix via `node:crypto`, browser `crypto.subtle`; receipts via print CSS + `window.print()`; scanner camera via `BarcodeDetector` with paste fallback; hand-rolled SVG seat map with viewBox zoom; maps = SVG lat/lng projection + OSM link.
- Fallback: if Next can't resolve `node:sqlite`, add `webpack: c => { c.externals.push({'node:sqlite':'commonjs node:sqlite'}); return c }` to `next.config.ts`; else swap to `better-sqlite3` (only `lib/db.ts` changes).

## Global conventions
- npm scripts: `dev` (next dev), `build`, `seed` (`node scripts/seed.ts`), `reset` (delete `data/ticketstorm.db*` then seed), `jobs` (`node scripts/jobs.ts`), `test` (`node --test tests/`), `typecheck` (`tsc --noEmit`). `"engines": {"node": ">=23.6"}`.
- tsconfig: `allowImportingTsExtensions`, `verbatimModuleSyntax`, `noEmit`, `strict`. No `enum`, `namespace`, or parameter properties. Type-only imports use `import type`.
- `lib/` files import each other by relative path with `.ts` extension, never `@/`. Anything tests/scripts import must not import `next/*`. Cookie/session code only in `lib/session.ts`.
- One `lib/schema.sql`, idempotent (`CREATE TABLE IF NOT EXISTS`), applied on DB open. Schema change → edit file, `npm run reset`. No migrations; dev DB is disposable.
- DB: `PRAGMA journal_mode=WAL; busy_timeout=5000; foreign_keys=ON`. `lib/db.ts` exports `db` and `tx(fn)` (`BEGIN IMMEDIATE`…`COMMIT`, `ROLLBACK` on throw).
- Money = integer cents. Times = UTC ISO strings; venues have `tz`; display via `Intl.DateTimeFormat`.
- Deterministic seed (mulberry32, fixed slugs). Seed accounts (password `password123`, listed in README): `fan@ticketstorm.test`, `fan2@ticketstorm.test`, `organizer@ticketstorm.test` (owner of org "Storm Live"), `scanner@ticketstorm.test`, `admin@ticketstorm.test`.
- Jobs: `lib/jobs.ts runJobs()` idempotent; called from root layout throttled to once/30s via `settings` timestamp, and via `npm run jobs`. Expiry is lazy everywhere (`expires_at < now` = expired in every query); jobs only tidy up and notify.
- Simulated external systems: email/SMS → `outbox` table (viewable at `/dev/outbox`, also `console.log`). Push → `notifications` table (in-app inbox).
- Every phase ends: `npm run typecheck && npm test && npm run build` green, `npm run reset && npm run dev` boots, one commit.

## Directory layout
```
app/
  layout.tsx, globals.css, page.tsx (home)
  search/  category/[slug]/  events/[slug]/ (page, tickets/)  venues/[slug]/  artists/[slug]/
  queue/[eventId]/  checkout/[holdId]/  checkout/3ds/[paymentId]/  orders/ orders/[id]/ (+ receipt/)
  tickets/ tickets/[id]/  transfers/[id]/  sell/ listings/  favorites/  inbox/
  account/ (profile, security, payment, notifications, privacy)  login/ signup/ verify/ reset/ auth/mock/[provider]/
  help/ support/  gift-cards/  lookup/
  organizer/  organizer/[orgId]/ (events/, events/[id]/{edit,inventory,pricing,access,queue,orders,reports,marketing}, venues/[id]/chart, payouts/, members/)
  scan/[eventId]/
  admin/ (users, orgs, events, flags, fees, taxes, fraud, refunds, claims, audit, support, reviews)
  dev/outbox/
  embed/event/[id]/
  api/ events/[id]/inventory, holds, holds/[id], queue/[eventId], scan, suggest, events/[id]/ics, tickets/[id]/pass, v1/events
lib/  db.ts schema.sql session.ts auth.ts geo.ts venue-gen.ts inventory.ts pricing.ts payments.ts orders.ts
      safetix.ts transfers.ts resale.ts queue.ts access.ts notify.ts jobs.ts ledger.ts format.ts
components/  SeatMap.tsx Countdown.tsx TicketQR.tsx EventCard.tsx Filters.tsx PayForm.tsx
scripts/  seed.ts jobs.ts
tests/   holds.test.ts payments.test.ts safetix.test.ts pricing.test.ts queue.test.ts resale.test.ts
data/    (gitignored db)
```

## Data model (all tables: `id INTEGER PK`, `created_at`)
**Identity**
- `users`: email UNIQUE, password_hash, name, phone, role (fan|admin), email_verified_at, twofa_enabled, address json, notif_prefs json, home_city_id, status (active|blocked|deleted), flagged
- `sessions`: token PK, user_id NULL (anon guest), expires_at, impersonator_id
- `codes`: user_id, kind (verify|reset|otp|vf), code, expires_at, used_at
- `oauth_links`: user_id, provider, subject

**Places and people**
- `cities`: name, state, lat, lng, tax_rate_bps
- `orgs`: name, status (pending|approved|suspended)
- `org_members`: (org_id, user_id) PK, role (owner|manager|box_office|scanner|finance)
- `venues`: org_id, slug, name, address, city_id, lat, lng, tz, capacity, info json (parking, transit, bag, accessibility, faq), image
- `sections`: venue_id, name, kind (reserved|ga), capacity (GA), path (SVG), label_x, label_y, rank
- `seats`: section_id, row, number, x, y, accessible, companion, obstructed; UNIQUE(section_id,row,number)
- `artists`: slug, name, bio, image, genres, links json; `artist_related`

**Events**
- `events`: org_id, venue_id, series_key, slug, title, category, genre, starts_at, doors_at, image, description, info json (age, bag, notices, set_times), status (draft|published|cancelled|postponed|rescheduled), onsale_at, hold_minutes, ticket_limit, queue_enabled, queue_rate, queue_cap, fee_rule json, transfer_rule json, resale_rule json (min_pct, max_pct, enabled), refund_window_until, popularity, approved
- `event_artists`: event_id, artist_id, billing
- `price_levels`: event_id, name, color, price_cents, ticket_type (standard|vip|platinum|accessible|standing), dyn_min_cents, dyn_max_cents
- `offers`: event_id, name (adult|child|senior|student), pct_off

**Inventory (core)** — one row per sellable unit; reserved seat = 1 row; GA area = 1 row per capacity slot (seat_id NULL, slot set).
- `inventory`: event_id, section_id, seat_id, slot, price_level_id, status (available|held|sold|blocked), block_kind (kill|comp|artist|promoter|production), hold_id, held_until, window_id NULL; UNIQUE(event_id,seat_id), UNIQUE(event_id,section_id,slot)

**Holds and orders**
- `holds`: session_token, user_id, event_id, expires_at, status (active|converted|released)
- `orders`: user_id NULL, email, event_id, status (pending|paid|review|cancelled|refunded|partially_refunded), subtotal, fees, tax, protection, discount, total (cents), promo_id, delivery, source, idempotency_key UNIQUE
- `order_items`: order_id, kind (ticket|addon|protection|giftcard), inventory_id, addon_id, offer_id, unit_cents, fee_cents, tax_cents

**Tickets**
- `tickets`: order_id, inventory_id, owner_id, status (valid|used|transferred|listed|resold|cancelled|expired), secret, scanned_at, scanned_by, restrictions json
- `CREATE UNIQUE INDEX one_live_ticket ON tickets(inventory_id) WHERE status IN ('valid','listed','used')` — DB-level backstop against double-selling.

**Payments**
- `payments`: order_id, kind (charge|refund|payout), method (card|saved|applepay|googlepay|paypal|giftcard|installments), amount, status (succeeded|declined|requires_3ds|pending), brand, last4, decline_code, idempotency_key UNIQUE
- `saved_cards`: user_id, brand, last4, exp, fake_token

**Fan-to-fan**
- `transfers`: ticket_id, from_user, to_email, to_user, status (pending|accepted|declined|cancelled|expired), expires_at, claim_token
- `listings`: ticket_id, seller_id, price_cents, status (active|sold|cancelled|expired), expires_at; partial UNIQUE(ticket_id) WHERE active
- `ledger`: account ('user:ID'|'org:ID'|'platform'), kind (sale|fee|resale_credit|refund|payout), amount, ref

**Access and queue**
- `onsale_windows`: event_id, name, kind (public|artist|venue|card|fanclub|promoter|verified_fan|sponsor), starts_at, ends_at, requires_code, reg_starts, reg_ends
- `access_codes`: window_id, code, max_uses, uses, user_id
- `vf_registrations`: window_id, user_id, status (registered|selected|waitlisted), code
- `promo_codes`: event_id NULL, code, kind (pct|fixed), amount, max_uses, uses, expires_at
- `queue_entries`: event_id, session_token, user_id, rank (random pre-onsale, else sequence), joined_at, admitted_at, expires_at
- `rate_limits`: key, window_start, count
- `blocklist`: kind (ip|email), value

**Engagement**
- `favorites`: (user_id, kind (artist|venue|event), ref_id) PK
- `notifications`: user_id, kind, title, body, link, read_at
- `outbox`: channel (email|sms|webhook), to, subject, body
- `price_alerts`: user_id, event_id, target_cents

**Add-ons and protection**
- `addons`: event_id, kind (parking|merch|vip|food|hospitality|camping|shuttle), name, price_cents, inventory, sold, CHECK(sold <= inventory)
- `claims`: order_id, reason, status (submitted|approved|denied)
- `refund_requests`: order_id, reason, status
- `exchanges`: from_ticket, to_inventory, diff_cents
- `gift_cards`: code UNIQUE, balance_cents, purchaser_id
- `credits`: user_id, amount

**Platform**
- `reviews`: user_id, event_id/venue_id, rating, body, status (pending|approved|rejected)
- `support_tickets`: user_id, email, subject, status, messages json
- `audit_log`: actor_id, action, target, data json
- `feature_flags`: key PK, enabled, variant_pct
- `settings`: key PK, value json (default fees, tax mode, protection pct, last_jobs_run)
- `api_keys`: org_id, key
- `webhooks`: org_id, url, events

### Seat-hold algorithm (`lib/inventory.ts`) — used by every hold path
```
tx(() => {
  // expired-hold release folded into predicate (lazy expiry)
  const r = db.prepare(`UPDATE inventory SET status='held', hold_id=?, held_until=?
     WHERE event_id=? AND id IN (${ids}) AND window_id IS ? AND
       (status='available' OR (status='held' AND held_until < ?))`).run(...)
  if (r.changes !== ids.length) throw new Conflict()   // rollback => all-or-nothing
})
```
- Best Available and GA pick candidate ids inside the same `BEGIN IMMEDIATE` tx, then run the same UPDATE.
- Hold→sold conversion in one tx: check hold not expired, inventory `status='sold'`, insert tickets. Partial unique index on tickets is the final guard.

---

## Phases

### P1 — Foundation, auth, outbox [CORE §9 auth, §23 email/SMS sim]
- Scaffold Next, tsconfig, `lib/db.ts`, `lib/schema.sql` (identity, place, event tables now; later phases add).
- `lib/auth.ts` (scrypt hash/verify). `lib/session.ts` (httpOnly cookie, `getUser`, `requireUser`, `requireAdmin`, `requireOrgRole`; lazy anon guest sessions).
- Pages: `/signup`, `/login`, `/logout`, `/verify?code=`, `/reset` (request → set new). Verify/reset links go to outbox.
- `lib/notify.ts`: `sendEmail`, `sendSms`, `notify`. `/dev/outbox` lists messages with clickable links.
- `lib/geo.ts` (cities, haversine). `lib/venue-gen.ts` (arena, stadium, theater, amphitheater w/ GA lawn, club GA-only). `scripts/seed.ts`: 12 cities, 8 venues, 30 artists, ~80 events over next 120 days, 3 past events, seed users, 1 org.
- Layout header: search box, city picker, account menu.
- **Acceptance:** `npm install && npm run reset && npm run dev` → `/` 200. `select count(*) from events` ≥ 80. Signup `new@x.test` → verify email in `/dev/outbox` → link marks verified. Login/logout; wrong password errors. Reset link changes password, old one stops working. `ticketstorm_session` cookie httpOnly. `password_hash` never plaintext. `tests/auth.test.ts` hash/verify.

### P2 — Discovery and event page [CORE §1, §2; §16 accessible filter]
- Home: Featured hero, Trending (popularity), Near you (city cookie or geolocation → nearest city).
- `/search?q=&category=&city=&radius=&unit=mi|km&from=&to=&when=weekend|today|month&accessible=1` over artists/events/venues/cities via SQL LIKE. `<input type="date">`. Filters in URL.
- `/api/suggest?q=` grouped artists/events/venues; debounced client, datalist or small listbox.
- `/category/[slug]` for music, sports, arts-theater, family, comedy, festivals, with genre sub-filter.
- `/events/[slug]`: title, venue-tz date/time, venue, lineup, image, description, status badge (upcoming/on sale/sold out/cancelled/postponed/rescheduled), price range, ticket types, qty picker, "Find tickets" → `/events/[slug]/tickets`.
- **Acceptance:** search for seeded artist lists its events; suggest returns it within 2 chars. City/radius changes results; 10 mi excludes a venue 50 mi away. "This weekend" = Fri–Sun only. Cancelled seed event shows badge, no CTA. Not-yet-on-sale shows "On sale <date>". Times in venue tz.

### P3 — Seat map, inventory, holds [CORE §3, §6 price levels, §7 core types, §8 holds, §16 ADA on map]
- `lib/inventory.ts`: generate inventory on publish (seed calls it); `holdSeats`, `holdBestAvailable(eventId, qty, priceLevel?, accessible?)`, `holdGA(sectionId, qty)`, `releaseHold`, `getAvailability`.
- `components/SeatMap.tsx`: SVG sections colored by price level; viewBox zoom/pan (wheel, drag, +/-); click section → seats; hover tooltips (section/row/seat/price); state colors (available, held, sold, blocked, accessible ♿, resale legend-only until P6); price legend; price `<input type=range>`; select/deselect. GA sections → qty stepper.
- `GET /api/events/[id]/inventory` compact `[id, status, levelId]`; client polls 5s.
- `POST /api/holds` `{seatIds}` | `{bestAvailable:{qty, levelId}}` | `{ga:{sectionId, qty}}` → `{holdId, expiresAt}` or 409. `DELETE /api/holds/[id]`.
- `components/Countdown.tsx` on hold bar; on expiry release and inform user.
- Seed ticket types: standard, reserved, GA (pit/floor/lawn), VIP, accessible + companion.
- Season/bundle: "bundle" price level with `event_ids` json attached to a seeded 3-game series; holding it holds the matching seat in each event in one tx.
- **Acceptance:** `tests/holds.test.ts`: 8 worker_threads with own DB connections race 200× on the same 4 seats with random overlaps; each seat held by ≤1 hold, every hold all-or-nothing. Expired hold can be taken by a new hold. Two-browser: A holds X, B sees held ≤5s, B gets 409. Best Available qty 4 = 4 adjacent same row. GA qty 3 decrements lawn. `hold_minutes=1` → seat frees with no job. Accessible filter highlights only ADA seats.

### P4 — Checkout, fake payments, orders, mobile tickets [CORE §8, §9 orders, §10, §6 fees, basic tax]
- `lib/pricing.ts quote(hold, opts)`: per-ticket face, service fee %, facility charge, per-order processing fee, flat city tax, total. Reads `events.fee_rule`, defaults from `settings`.
- `/checkout/[holdId]`: summary, contact (guest requires email; logged-in prefilled), delivery "Mobile ticket", billing address, countdown, `PayForm` (number, exp, cvc, "save card").
- `lib/payments.ts` fake gateway: Luhn/exp/CVC validation. 4242424242424242 success; 4000000000000002 generic decline; 4000000000009995 insufficient funds; 4000000000003220 3DS challenge at `/checkout/3ds/[paymentId]` (Approve/Fail); 4000000000000341 succeeds but later refunds fail. Hidden-form UUID `idempotency_key`; double submit returns same order. `charge`, `refund`, `listSavedCards`.
- `lib/orders.ts finalize` one tx: validate hold active → payment → inventory sold → order+items → tickets with random `secret` → `holds.status=converted`. Confirmation `/orders/[id]`.
- `/orders` tabs Upcoming/Past/Cancelled; detail shows receipt breakdown + tickets.
- `lib/safetix.ts`: token `ticketId.window.HMAC(secret, ticketId:window)`, 15s window. `TicketQR.tsx` computes via `crypto.subtle` from secret on owner page, renders with `qrcode`, rotates every 15s. `/tickets` (My Tickets), `/tickets/[id]`.
- **Acceptance:** `tests/payments.test.ts` each card's result, Luhn rejects 4242424242424241, repeated idempotency key → no second charge. `tests/safetix.test.ts` verifies current window, ±1 OK, ±2 fail, tampered HMAC fail. Full flow as guest and `fan@` with 4242 → paid order, tickets at `/tickets`, QR changes every 15s. 0002 shows decline, hold stays, retry possible. 3220 goes through 3DS. Double-click Pay → one order. Total = face + fees + tax matching line breakdown. Pay after hold expiry refused, no order/tickets created.

### P5 — Organizer, scanner, admin, cancellations [CORE §21, §22, §14]
- `/organizer`: org switcher; members/roles (owner, manager, box_office, scanner, finance) via `requireOrgRole`; org signup creates `pending` org.
- Event CRUD: title, category/genre, venue, dates, image URL, description, status (draft → published → cancelled/postponed/rescheduled). Admin approval when flag `require_event_approval` on.
- Venue chart (`/organizer/[orgId]/venues/[id]/chart`): generator form (layout type, sections, rows, seats/row, GA capacity), JSON import/export textarea, per-seat accessible/companion/obstructed toggles on SVG preview.
- Inventory (`events/[id]/inventory`): bulk-select seats on map → assign price level, block/kill with `block_kind`, release.
- Pricing (`events/[id]/pricing`): price levels, ticket types, fee_rule form, on-sale datetime.
- Scanner `/scan/[eventId]` (scanner role): `BarcodeDetector` camera or paste field; `POST /api/scan` verifies HMAC window, marks used, rejects duplicates ("Already scanned at 19:42"); live attendance count (polled); failed POSTs queue in localStorage and retry, dupes resolved server-side.
- `/admin`: users (search, block/unblock, role), org approval, event approval, moderation (unpublish, edit text), feature-flag toggles.
- Cancel → `lib/orders.ts refundEvent()` full refunds via `payments.refund`, tickets `cancelled`, buyers emailed. Postpone/reschedule keeps tickets valid, new date, notify holders.
- **Acceptance:** `organizer@` creates event on seeded venue, 2 price levels, kills a row, publishes; killed row blocked on fan map; fan buys a ticket. Scan → "Valid"; again → "Already used"; 2-min-old token → "Expired code"; attendance increments. `fan@` blocked from `/organizer/*` and `/admin/*`. Cancel creates refund payments, orders `refunded`, emails in outbox. Reschedule keeps tickets valid with new date. Pending orgs can't publish until approved.

### P6 — Transfer, resale, favorites [CORE §11, §12, §15]
- `lib/transfers.ts`: transfer to email or phone → pending transfer + claim link to outbox (email or SMS); sender can cancel while pending; `/transfers/[id]?token=` recipient logs in/signs up, accepts/declines; accept tx: old ticket `transferred`, new ticket for recipient with new `secret` (old barcode dead).
- `lib/resale.ts`: `/sell` lists valid tickets, set price → ticket `listed` + active listing. Resale seats distinct color on map, "Verified Resale" in list. Buying uses same hold/checkout flow; finalize tx: seller ticket `resold`, buyer new ticket/new secret, listing `sold`, ledger seller credit.
- Favorites: heart buttons on artist/venue/event cards & pages; `/favorites`.
- **Acceptance:** `fan@` → `fan2@` transfer; cancellable before accept; after accept, old QR rejected, new accepted. `fan@` lists at $X, `fan2@` buys, ownership swaps. `tests/resale.test.ts`: two concurrent buys of one listing → exactly one succeeds. Listed ticket can't be transferred; transferred can't be listed (UI hides + server rejects). Favorites persist across sessions.

### P7 — Waiting room, bot defense, presales / Verified Fan [CORE §4; IMPORTANT §4, §5, §21 presale/queue config]
- `lib/queue.ts` (DB): pre-onsale join → random rank; post-onsale → max+1 (FIFO). Lazy admission per poll: admitted so far ≤ `queue_rate × minutes since onsale`, active shoppers ≤ `queue_cap`. Admitted users get timed shopping window (`expires_at`).
- `/queue/[eventId]` polls `GET /api/queue/[eventId]` every 5s: position, est. wait, "Do not refresh". Refresh keeps same entry (keyed by session).
- Queue-enabled events: `/events/[slug]/tickets` and `POST /api/holds` require admitted unexpired entry.
- Bot defense: `rate_limits` on IP + account; math captcha + hidden honeypot on queue join & checkout; `blocklist` checked at login, queue join, checkout; per-account ticket limit across all orders for the event.
- `lib/access.ts`: multiple `onsale_windows`; inventory tied to `window_id` visible/holdable only during window with valid access code (entered on event page, stored in session).
- Verified Fan: registration form during reg window; job runs lottery at close → selected/waitlisted; selected get email+SMS with unique code+link; waitlisted promoted if selected don't buy.
- Organizer UI: `events/[id]/access` (windows, generate N codes, CSV download, VF campaigns); `events/[id]/queue` (enable, rate, cap).
- **Acceptance:** `tests/queue.test.ts` (fake clock): 100 pre-onsale joins randomly ordered; rate 10/min → ~10 admitted after 1 min; cap respected. Seeded high-demand event: two browsers see positions advance; shopping pre-admission → 403. 6th rapid join from one IP → 429. Filled honeypot rejected. Presale seats invisible without code; with seeded code visible and use count increments. `npm run jobs` after VF reg close → selected get codes in outbox that unlock presale.

### P8 — Pricing, ticket types, add-ons, inventory rules [IMPORTANT §3, §6, §7, §17 parking, §21/§22 fee config]
- List view beside map sortable by lowest price / best seats (section rank).
- Orphan-seat rule: reject selections leaving a single empty seat between taken seats or at row edge, with clear message; Best Available respects it. Per-order and per-event ticket limits.
- Dynamic/Platinum: price = clamp(base × (1 + k × sold% + j × queueDepthFactor), min, max), recomputed per quote; organizer sets min/max/k; face locked into hold at hold time (`unit_cents` on hold line).
- Per-event fee rules (service %, facility, order processing, delivery). Platform defaults at `/admin/fees`; per-city tax at `/admin/taxes`.
- All-in pricing toggle (cookie): displayed prices include fees+tax; checkout shows per-ticket breakdown.
- Promo codes (fixed/pct, limited uses, expiry) at checkout, decremented on finalize; organizer UI.
- Offers: child/senior/student per ticket at checkout; standing-room levels; Meet & Greet/VIP packages as price levels with perks text.
- Add-ons (parking, merch, hospitality) at checkout; atomic `UPDATE addons SET sold=sold+? WHERE id=? AND sold+? <= inventory`; each parking pass gets its own QR (reuse safetix).
- **Acceptance:** `tests/pricing.test.ts`: fee/tax math; dynamic price within clamp; promo limited to N uses; quotes consistent with all-in on/off. Seats 1 & 3 with 2 free and 4 taken → orphan rejection. 9 tickets with limit 8 rejected, incl. across two orders. Changing platinum k or sold% changes price. Parking inventory 1 → second buyer sees "sold out". Admin fee change reflected in new quote.

### P9 — Checkout extras, account, protection, refunds/exchanges [IMPORTANT §8, §9, §13, §14, §21 order mgmt]
- Payment stubs: Apple/Google Pay (`PaymentRequest` if available, else mock modal); PayPal mock redirect; installments "pay in 4" = 4 scheduled payments rows charged by job; gift card balance (purchase flow in P12).
- Fraud rule score (new account + high value + mismatched billing city + random 3%) → order `review`; admin queue approves/cancels.
- Confirmation email with order link; "Resend confirmation"; `/orders/[id]/receipt` with print CSS ("Download PDF" = `window.print()`).
- Social login `/auth/mock/google|apple|facebook`: fake consent → link/create via `oauth_links`.
- 2FA in Security: login asks for OTP via SMS outbox; dev code `000000` when `NODE_ENV=development`.
- Profile: name, address, phone, saved cards (delete), notification prefs, GDPR JSON export, delete account (anonymize, keep orders).
- Ticket protection: checkout add-on at `settings.protection_pct` (default 8%) of subtotal; claim form on order; `/admin/claims` approve/deny; approval → refund.
- Refunds: rescheduled events get refund button until `refund_window_until`; refund status on order; refund policy acknowledged via checkbox at checkout.
- Admin/organizer refund tools: full/partial (per item, with/without fees), void. Organizer `events/[id]/orders`: search, resend tickets, cancel/refund, move seats (atomic inventory swap), comp tickets ($0 order), fraud hold.
- Exchange: swap ticket to another date in same series; diff charged/refunded; hold on new seat then one tx.
- **Acceptance:** social login creates user + logs in. 2FA without OTP fails, with outbox code succeeds. Protection on order; claim + admin approve → refund payment. Rescheduled event refund works in window, button gone after. Partial refund 1 of 3 cancels only that ticket and frees seat. Move seats frees old seat, old QR invalid. Exchange charges diff. Installment job charges next installment. GDPR export JSON contains user's orders.

### P10 — Discovery, content pages, notifications, accessibility [IMPORTANT §1, §2, §15, §16, §18, §19]
- Search filters: price range, genre/sub-genre, venue, resale/presale availability, accessible. Sort: relevance, date, price, distance, popularity.
- Recommendations: score = genre overlap with favorites/history + followed artist + distance decay + popularity; "Recommended for you" rail.
- Event page: age limit, doors, bag policy, set times, notices banner. ICS via `/api/events/[id]/ics`. Share via `navigator.share` with copy-link fallback. "Other dates" switcher via `series_key`.
- `/venues/[slug]`: address, static SVG map + OSM link, capacity, chart preview, info tabs (parking, transit, bag, accessibility, FAQ), upcoming events, follow.
- `/artists/[slug]`: bio, image, genres, tour dates, follow, related artists.
- Alerts via jobs: new event for followed artist/venue within radius; on-sale reminder 1h before; price drop on watched events; event change (postpone/cancel); ticket delivered; transfer received. Channels in-app (`/inbox` with unread badge), email, SMS per-category prefs. Every email has signed-token unsubscribe link turning that category off.
- Accessibility: accessible filter selects accessible inventory; accessible seat offers/auto-holds linked companion in same tx; venue accessibility info; ADA request form → support ticket.
- **Acceptance:** price filter/sort correct. ICS imports into Calendar.app at correct UTC. Follow artist → organizer publishes in-radius event → `npm run jobs` → inbox + outbox notification. Unsubscribe → next same-category event: no email, still inbox (if enabled). Accessible seat + companion holds 2 seats. Venue & artist pages render and cross-link.

### P11 — Ticket states, transfer/resale rules, payouts, organizer/admin ops [IMPORTANT §10, §11, §12, §21, §22]
- SafeTix extras: animated moving band over QR; QR blurs on `visibilitychange`/blur; "Add to Apple/Google Wallet" downloads mock pass JSON (`/api/tickets/[id]/pass`); "Tap to enter (NFC)" button sends current token to scan endpoint; ticket state visible on every ticket.
- Transfer rules per event (disabled, or deadline N hours before show, server-enforced); job expires transfers; decline possible.
- Resale rules: floor/ceiling % of face; seller fee (default 10%) + buyer fee; edit/cancel listings; listings expire at event start; "Your ticket sold" notification; only system tickets listable. Seller payout: ledger balance at `/account/payouts`, "request payout" → pending payout, admin "mark paid".
- Organizer: `events/[id]/reports` gross/net, sold by level & by day (inline SVG bars), attendance, fees, CSV export (`text/csv`). Settlement: revenue minus platform fees into org ledger + payouts page. Marketing: `?src=` promo links recorded on orders & reported; email campaign to fan list (followers + buyers) → outbox.
- Admin: fraud/bot dashboard (flagged users, top rate-limited IPs, blocklist CRUD, order review queue); refund oversight list; support impersonation (banner, `sessions.impersonator_id`, audited); `audit_log` written by every admin/organizer mutation via one `audit()` helper; `/help` static FAQ + contact form → `support_tickets` with admin reply thread.
- **Acceptance:** listing above ceiling rejected. After resale seller balance = price − 10%; payout request + admin mark paid → balance 0. Transfer past deadline rejected; pending transfer `expired` after job. CSV totals match `select sum(total)`. Impersonation shows banner + audit row. Order `src` appears in marketing report.

### P12 — NICE-TO-HAVE sweep [all §1–§22 N items]
Smallest simulated version of each. Grouped commits allowed within this phase; app stays runnable after each. Split into 12A (§1–§11) and 12B (§12–§22) if too large.
- §1/§2: SVG lat/lng map view; editorial "Discover" lists & city guides (seeded); Top picks; `?page=` pagination; SEO (slug URLs, `generateMetadata`, `sitemap.ts`, `robots.ts`); related events; directions link; fake deterministic weather (hash of date+city); "N people viewing" (active holds + queue entries last 5 min); on-sale countdown.
- §3: generated "View from seat" perspective SVG; obstructed/limited-view notes; SSE `/api/events/[id]/stream` with polling fallback.
- §4–§7: scalper flagging (many accounts per IP/card → admin cancels orders); VF waitlist if not done; price alerts; mobile-only vs print flags; non-transferable tickets; will-call delivery with box-office pickup marking.
- §8/§9: express checkout (saved card + address); display-only multi-currency (fixed rates) + international tax flag; dedicated protection upsell step; guest order lookup `/lookup` (email + order # + outbox code); card wallet page; mocked vendor account linking (labeled simulation).
- §10/§11: offline tickets via `public/sw.js` caching `/tickets/*` (QR works offline since HMAC is client-side); print-at-home (print CSS); group "share with party" read-only link; event countdown; transfer to non-user by SMS link; "reclaim" pending transfer (= cancel).
- §12–§14: resale make-an-offer (seller accepts/rejects); price suggestion (median active listings); seller dashboard; third-party resale labeled skipped (external); claim status page; chargebacks (0341 card → dispute admin resolves); refunds as account credit applied at checkout.
- §15/§16: weekly digest job; "import artists" by pasted list (instead of Spotify); hearing-assist/sensory/ASL request types; WCAG pass (keyboard seat selection with arrows/Enter on seat buttons, `aria-label` on seats, focus styles, contrast).
- §17–§20: gift cards (fake-charge purchase → code by email; redeem, balance check, partial payment at checkout); merch/VIP upgrade/food pre-order/camping/shuttle add-ons (reuse addons); event & venue reviews by verified attendees only (has used ticket), moderated at `/admin/reviews`; seat-view photos (reuse view-from-seat); artist music/social links; team pages (artist `kind=team`, schedule, season tickets via P3 bundle level).
- §21: clone event; series templates (create N dates); org API keys + read-only `/api/v1/events`; webhooks logged to outbox `webhook` channel; embeddable widget `/embed/event/[id]` with iframe snippet; guest list / will-call; customer data CSV export; resale policy UI for `resale_rule`.
- §22: analytics funnel (event view → hold → order via small `events_log` table); A/B tests via `feature_flags.variant_pct` with sticky session bucketing; i18n en/es dictionary for nav + checkout with language switch; GDPR admin tooling (export/erase any user).
- **Acceptance:** one critic check per bullet, e.g. keyboard-only purchase works; DevTools offline `/tickets/[id]` QR still rotates; partial gift card leaves card charged for remainder; embed iframe renders; `/api/v1/events` 401 without key; review impossible without used ticket; 50% A/B flag → same session same variant. `npm test` + `npm run build` green.

---

## Critic standing checks (every phase)
1. `npm run typecheck && npm test && npm run build` pass; `npm run reset && npm run dev` boots with no runtime errors on `/`, an event page, `/tickets`, `/organizer`, `/admin` (as the right user).
2. No new dependencies beyond the list above unless justified in the commit message.
3. Every state-changing route checks auth/role server-side, not just UI.
4. No hold/ticket/listing/transfer state change outside `tx()`.
5. No secrets or real external calls; every simulated system writes to `outbox` or `notifications`.

## Scope notes
- Simulated, not real: wallet pass signing, NFC hardware, real OAuth, SMS, push, bank payouts.
- Not implemented (labeled placeholders): third-party resale integration, other-vendor account linking.
