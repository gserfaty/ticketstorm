# Changelog

All notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no version numbers yet; each section is a commit. Review-fix commits are grouped under their phase.

## P9: Checkout extras, account, protection, refunds and exchanges

Commits d8216bf (feature) and 30b8536 (repeat-exchange fix, extra test, notes). 85 tests (`tests/p9.test.ts` is new); `typecheck`, `test` and `build` green; the acceptance checks below were also run against a live dev server with scripted form posts (cookie jar, no JS) and one real browser pass for the Apple Pay modal.

#### Added
- **Payment methods** (`components/PayForm.tsx`, `app/checkout/actions.ts`, `lib/orders.ts finalize`):
  - **Apple Pay / Google Pay**: the button tries the browser's `PaymentRequest` and falls back to a mock confirm dialog. No wallet token reaches the server; the payment is recorded with method `applepay` / `googlepay` as the test Visa 4242.
  - **PayPal mock**: `pay` stores a `pending` payment (method `paypal`, no card) and redirects to `/checkout/paypal/<state>`. The state is the payment's idempotency key and only resolves for the session that created the payment (`session_token` match; moved to the new token on login). The page takes no return URL: approve goes to the order, cancel goes back to that hold's own checkout (no open redirect). It reuses `approve3ds` / `fail3ds`, which now accept `pending` as well as `requires_3ds`.
  - **Pay in 4** (`lib/installments.ts`): accounts only, order of $40 or more, show at least 4 days away. Four `payments` rows with method `installments`: the first (quarter plus rounding) is charged at checkout, three are `pending` with `due_at` every 14 days (squeezed so the last is due a day before the show). `chargeDueInstallments()` runs in `runJobs()`; each row is claimed with `WHERE status = 'pending'`, so a second run or a parallel run charges nothing twice. Off-session charges treat the 3DS test card as declined (`authentication_required`).
  - **Failed installment policy**: the row is `declined`, the order goes to `review` (reason `installment_failed`, tickets stop working, remaining installments pause), the buyer is emailed and notified. Admin approves (the unpaid part is written off) or cancels (what was paid is refunded, pending rows are voided).
  - **Saved cards** were already selectable at checkout and owner-only (`saved_cards WHERE id AND user_id`); now covered by a live check.
  - **Refund policy checkbox** is required at checkout (HTML `required` plus a server check).
- **Fraud review** (`lib/fraud.ts`): score = new account or guest 30 (younger than 7 days) + total of $500 or more 30 + billing city differs from the profile city (address, else home city) 20 + random check 50 (`FRAUD_RANDOM_PCT`, default 3 percent). A score of 50 or more puts the order in `review` inside `createOrder`. While in review the tickets cannot be scanned (`scanTicket`: "Order under review"), transferred or listed (`assertTradable`), no QR is shown, and active listings and pending transfers are cancelled. `/admin/review` approves, or cancels (shared refund, seats released). Organizers can also place and lift their own hold (`organizer_hold`); a fraud hold can only be lifted by an admin.
- **Confirmation email and receipt**: `sendConfirmation()` (used by `createOrder`, "Resend confirmation" and organizer "Resend tickets"; rate limited 3/min); `/orders/[id]/receipt` with print CSS and a "Download PDF" button (`window.print()`); both authorize exactly like the order page (`getOrder`: owner, or guest session / emailed token).
- **Order page**: status, refund status ("refunded $X in full", "refund could not be completed, we are retrying"), payment and installment schedule, receipt link, resend, refund-window button, claim form.
- **Mock social login** (`lib/social.ts`, `/auth/mock/[provider]`): Google, Apple, Facebook. The login page's button runs a server action that signs a state (HMAC of session, provider, nonce, expiry) and redirects to the fake consent page, which only renders for a valid state of the same session. Allow burns the nonce (single use), then links by `(provider, email)`: an existing account is linked only if the "provider verified this email" box is ticked (otherwise refused: account takeover guard), otherwise a verified user is created. `login()` runs, so guest holds and queue place follow. `next` is validated (`^/(?![/\\])`). Disabled (404) when `NODE_ENV=production`. Social login skips 2FA.
- **2FA** (`lib/twofa.ts`, `/account/security`, `/login/otp`): enable and disable re-check the password (rate limited) and need a phone on the profile. After the password step login texts a 6-digit code to the SMS outbox and continues on `/login/otp` with a signed token bound to the browser session; nobody is logged in until the code is accepted. Codes are single use (conditional `UPDATE ... WHERE used_at IS NULL`), expire after 10 minutes, a newer code replaces the older, and 5 wrong guesses (`codes.attempts`) kill a code; verify and send are also rate limited per IP and account. **Dev code**: `000000` is generated only when `NODE_ENV=development` and `DEV_OTP=1`; otherwise codes are random (`devOtp()`, unit tested for production).
- **Account** (`/account/profile|payment|notifications|security|privacy`, `lib/account.ts`): name, phone, address; saved cards list and delete (owner only); notification preferences (orders/alerts/marketing by email/sms, stored in `users.notif_prefs`); GDPR JSON export (`/account/privacy/export`, selected by the session's user id only; leaves out password hashes, ticket secrets, gateway tokens and other people's data); delete account = anonymize (email becomes `deleted-ID@deleted.invalid`, name, phone, address, prefs, password cleared; `orders.email` and `payments.meta` scrubbed; sessions, saved cards, oauth links, favorites, notifications and codes deleted; active listings and pending transfers cancelled). Orders, tickets and ledger rows stay. Refused for admins, org members and users with pending installments; the password (or the email for social-only accounts) is required.
- **Ticket protection** (`lib/protection.ts`): opt-in checkbox at checkout; premium = `settings.protection_pct` (default 8) percent of the ticket face after the promo, **not taxed and no fees**, stored as an `order_items` row of kind `protection` and `orders.protection` (so `sum(items) == total`). Claim form on the order (one open or approved claim per order, partial unique index), `/admin/claims` approve or deny. Approve = one tx: claim status, then the shared refund of everything except the premium, tickets cancelled. **The seats stay sold** (consistent with `refundEvent`): claims arrive close to or after the show and a cancelled ticket cannot be scanned. A card that refuses the refund rolls the approval back.
- **Refund window**: rescheduling sets `events.refund_window_until` (14 days, never past the new show). Orders for a `rescheduled` event show "Refund this order" until then (full refund, seats back on sale, only if nothing was scanned and every ticket is still with the buyer); the server re-checks the window on submit.
- **One shared refund function** (`lib/orders.ts doRefund` / `refundOrder` / `refundInTx`) used by `refundEvent`, claims, the rescheduled-event button, fraud cancel, admin and organizer tools. Modes: everything left, chosen items (with or without fees and tax; the promo discount is spread pro rata with `allocate()` like `quote()`), void (cancel, no money back). Caps: amount is clamped to paid minus refunded, `payments.refund` rejects more than a charge minus what it already returned, an item is refunded once, an item refund needs a live ticket. Refunded tickets are cancelled in the same tx; seats are released unless `release: false` (event cancellation, claims). `record: true` (event cancel) keeps the old behaviour (order `cancelled` + `refund_error`); every other caller is strict and rolls back if the card refuses.
- **`lib/payments.ts` refunds**: refund rows now carry `parent_id` (the charge they return money to), so `refundMoney(orderId, amount)` can spread a refund over several charges (installments, exchange credit) and never exceed any of them.
- **Organizer `events/[id]/orders`** (`lib/orderadmin.ts`, `components/OrderTools.tsx`): search by order number, email or name plus status filter; resend tickets; cancel/refund (full, ticked items with or without fees, void); fraud hold and release; move seats; comp tickets. Roles owner, manager, box_office. Every action loads the order, takes the org from the order's **event** row and checks the actor against it; all are audited. The same component backs the admin `/admin/orders` search (full, items, void, hold, release, resend).
  - **Move seats** (`moveSeat`): one tx. The new seat is claimed first (a lost race changes nothing), then the old ticket is cancelled and its seat freed, and a new ticket with a new secret is issued; the order item follows the seat. No price is charged or returned.
  - **Comps** (`compTickets`): a $0 order (`source = 'comp'`) from free seats or seats blocked as comps, with its own `converted` hold row so `orders.hold_id` stays unique. **Decision: comps do not count toward the per-account ticket limit** (an allocation, not a purchase, and it must not stop the guest from buying); `assertTicketLimit` excludes `source = 'comp'`.
- **Exchange** (`lib/exchange.ts`, `/tickets/[id]/exchange`): to another date of the same `series_key`. Step 1 holds one seat through the normal hold path (all gates apply) and previews the difference. Step 2 is one tx: a new order for the new event (own order, so `refundEvent`, limits and organizer tools stay per event), new ticket, old ticket cancelled and its seat freed. The old ticket's value moves across as `exchange` credit rows (a refund row on the old order, a charge row on the new one, carrying the card's brand and last4); only the difference touches the card: charged with `chargeStored` (declined: everything rolls back) or refunded with `refundMoney`. Not allowed: promo orders, bundle seats, orders with pending installments, review orders.
- **Seed**: `neon-harbor-empire-rescheduled` (status `rescheduled`, refund window open 7 days) with an order for `fan@`; a `review` order for `fan2@` (5 Premium seats on a brand-new account: score 60); `protection_pct` setting. The seed switches `FRAUD_RANDOM_PCT` off so its own orders are deterministic.
- **Schema**: `codes.attempts`; `orders.review_reason`, `orders.fraud_score`; `order_items.refunded_cents`; `payments.parent_id`, `payments.due_at`, method `exchange`; tables `claims` and `exchanges`.

#### Changed
- `quote()` returns `protection` and adds it to `total`; `Options` gains `protection`.
- `orders.status` values now all used: `paid`, `review`, `partially_refunded`, `refunded`, `cancelled`.
- `refundEvent` is a loop over `doRefund` with `release: false, record: true`; it also picks up `partially_refunded` orders. Its refund amount is now "paid minus refunded" instead of the sum of items (identical for single-charge orders; correct for installments and exchanges).
- `login()` also carries over a guest's pending PayPal payment.
- `npm test` sets `FRAUD_RANDOM_PCT=0` so the 3 percent random fraud check cannot make order tests flaky.

#### Deviations and decisions
- Protection is untaxed and fee-free; claims keep seats sold; comps are outside the ticket limit; a failed installment holds the order for admin review; moving a seat never changes the price; void means "cancel without refund".
- The retry button on `/admin/refunds` still re-runs `refundEvent` for the event (every failed refund comes from an event cancellation: the other refund paths are strict and roll back).
- Not built: refund requests as a table (refunds in the window are immediate), gift card payment (P12), phone verification when enabling 2FA, exchange for promo/bundle/installment orders (`ponytail:` notes in code).

---

## [Unreleased]

### P7 review fixes
- **Presales were unusable on queue-enabled events.** The waiting room only admits from `onsale_at`, and `place()` required admission, so a presale (which runs before the public sale) could never be bought. `place()` now lets a session with an unlocked open window hold that window's seats without admission and before on-sale, restricted to window inventory (the visibility predicate takes `pub`); public seats still need admission and an open sale. The tickets page follows the same rule.
- **Client IP was spoofable** (`lib/defense.ts`): the first `x-forwarded-for` entry is attacker-controlled, bypassing the 429 limits and the IP blocklist. It is now read only when `TRUST_PROXY=1`, using the last entry; otherwise the IP is `local`. Documented in README.md.
- **Guests bypassed `ticket_limit`**: logging out and buying as a guest reset the count. `finalize` now also counts paid tickets on orders with the same email (case-insensitive), for guests and logged-in users alike.
- **Waitlist promotion order**: promotion used registration order. The lottery now stores each position in `vf_registrations.lottery_rank` and promotion follows it.
- **Misleading VF state after the buy-by cutoff**: selected fans who did not buy were set back to `waitlisted`, and their session unlocks survived the code revocation. They are now `expired` (new status), their unlocks are deleted, and they get an in-app notification.
- **Several draws in the waiting room**: a logged-in user could join from N browsers for N places. Joining logged in now takes over the user's existing live entry (moves it to the joining session) instead of creating another.
- **`releaseEndedWindows` cleared `window_id` on held rows** too; it now only clears `status='available'` rows.
- Tests added for each fix in `tests/access.test.ts`.

### Added
- README.md, ARCHITECTURE.md and this CHANGELOG.md.

### Known limitations
- See "Known limitations and deferrals" in ARCHITECTURE.md (`ponytail:` deferrals: scan timestamp trust, whole-bundle refund, proxy-dependent client IP).

---

## P8 review fixes

#### Fixed
- **Bundles could not be bought**: the per-account limit counted every bundled game's line (3 bundle seats looked like 3 tickets per game). `finalize` now counts only the hold event's lines and the held-seat count in `assertTicketLimit` adds `i.event_id = h.event_id`. Test buys a 3-game bundle with a limit of 2.
- **Tax on discounted tickets**: a promo is now allocated pro rata across the ticket lines (whole cents, remainder on the last priced line) before `price()` runs, so service fee, facility charge and tax are computed on the discounted face. The discount is still its own negative `order_items` row and `sum(items) == total` holds.
- **Add-ons were untaxed**: merch, food and hospitality are taxed at the city rate (`order_items.tax_cents` per unit); parking stays untaxed. No fees on any add-on.
- **Promo brute force**: `applyOptions` is rate limited (10/min per IP and account, like access codes) and unknown, expired and used-up codes all answer "Invalid promo code".
- **`setDynamic`** accepted a max below or a min above the base price; it now requires min <= base <= max.
- **Used promo codes could be deleted** (order pages then showed a blank code). Deletion is refused once `uses > 0`; organizers get an "Expire now" button (`promo.expire`, audited). Deleting an unknown or other organization's id now reports "Promo code not found".
- **Queue factor counted abandoned entries**: `queue_entries.seen_at` is set on join and on every poll, and `demand()` counts only waiting entries seen in the last 2 minutes.

---

## P8: Pricing, ticket types, add-ons, inventory rules

### b3cd498 (2026-10-08) P8: pricing, ticket types, add-ons, inventory rules

#### Added
- **Orphan-seat rule** (`orphanSeat`, `assertNoOrphans` in `lib/inventory.ts`): a selection may not leave exactly one empty seat between taken seats or between a taken seat and the row edge (an aisle gap in the numbering counts as an edge). One pure function, used by manual selection (`holdSeats`) and by Best Available (which now slides a window over each run of adjacent seats and takes the first window that passes). Held (by anyone else), sold, blocked and presale-hidden seats count as taken; the caller's own previous hold does not (it is released first). The error names the seat: "Seat 2 in Section 202 Row E would be left empty on its own...". Single seats that were already stranded and are not next to the selection are left alone. GA is exempt.
- **Ticket limits**: `events.order_limit` (per order; NULL = same as `ticket_limit`) next to the existing `ticket_limit`, which is now documented as the per-event, per-account cap and is not duplicated: `assertTicketLimit` (paid orders by user or same email, plus live holds in other sessions) still enforces it at hold time and again in `finalize`. Organizer form on the pricing page; event page, tickets page and seat map use `orderLimit()`.
- **Dynamic / Platinum pricing**: `price_levels.dyn_min_cents`, `dyn_max_cents`, `dyn_k`, `dyn_j`; `dynamicPrice` = `clamp(base x (1 + k x sold% + j x queue factor), min, max)`, recomputed per display and per new hold. sold% is sold / non-blocked units of the event; the queue factor is people still waiting in the waiting room over 100, capped at 1. Organizer UI per level (min, max, k, j).
- **Locked face price**: `inventory.locked_cents` is written for every row in the same transaction that holds it (`lockPrices`). `quote()` reads it (never the live level price), so the price shown at checkout is the price charged, whatever demand does afterwards. Re-pricing a level is still refused while its seats are held or sold.
- **Fee rules**: `feeRule` precedence is built-in defaults, then platform defaults (`settings.fee_defaults`), then the event's `fee_rule`, field by field. New `delivery_cents` (per order, folded into the order fee line). Admin pages `/admin/fees` and `/admin/taxes` (per-city `tax_rate_bps`), admin-only, validated, each change written to `audit_log` (`fees.defaults`, `tax.set`).
- **All-in pricing toggle**: header button sets the `allin` cookie (`toggleAllIn`, `allInOn()` in `lib/session.ts`). One helper, `shown()` / `displayLevels()` / `displayRange()` in `lib/pricing.ts`, feeds event cards, the event page range and level list, the seat map (legend, tooltips, list view, totals, slider) and resale prices; checkout shows each ticket as `face + fees + tax = all-in`. Because it calls the same `price()` as `quote()`, the displayed all-in amounts add up to the checkout total (plus the single order fee).
- **Promo codes** (`promo_codes`): percent or fixed, `max_uses`, optional expiry, platform-wide, per organization, or per event. Entered at checkout, validated server side (`findPromo`), stored on the hold with the other checkout options. `createOrder` takes the use with `UPDATE promo_codes SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND (not expired)` inside the order transaction, so concurrent buyers cannot exceed `max_uses` and a failed order consumes nothing. The discount never exceeds the ticket subtotal and is stored as an `order_items` row of kind `discount` (negative), so `sum(items) == orders.total` still holds. Organizer UI is org-scoped (the org is read from the event row).
- **Offers** (child, senior, student percent off per ticket, chosen per ticket at checkout; `order_items.offer_id`), set by the organizer; fees and tax follow the discounted face.
- **VIP / Meet & Greet packages** and **standing-room levels**: `price_levels.perks` text shown on the event page, legend tooltip and organizer page; the seed has a Platinum level, a Meet & Greet package and Standing levels.
- **Add-ons** (`addons`: parking, merch, hospitality): chosen at checkout, stored on the hold. `createOrder` runs `UPDATE addons SET sold = sold + ? WHERE id = ? AND sold + ? <= inventory` per add-on inside the order transaction; a miss rolls the whole order back, charge included ("Lot A parking is sold out"). Each parking or hospitality unit also gets a pass: a `tickets` row with `inventory_id` NULL and `addon_id` set, with its own secret and SafeTix QR. It appears on the order page and in My tickets, and the scanner accepts it ("Valid · Lot A parking").
- **List view** beside the seat map, sortable by lowest price or best seats (section rank), respecting the price slider.
- **Checkout** gets an "Update order" form (promo code, per-ticket offer, add-on quantities) above the payment form.
- Organizer pricing page sections: dynamic pricing per level, ticket limits, delivery fee, offers, add-ons, promo codes.
- Tests: `tests/pricing.test.ts` (fee/tax math, dynamic clamp, platinum lock, admin fee and tax changes, all-in consistency, promo limits and caps, offers, add-on oversell and passes, limits across orders), `tests/orphan.test.ts` (pure rule, manual, edge, taken states, Best Available), and a 3DS + promo + add-on case in `tests/payments.test.ts`.
- Seed: Platinum level (k 3, j 0.5, $250 to $900) and add-ons on `neon-harbor-empire-saturday` (Lot A parking with **inventory 1**, tour T-shirt, club lounge), Meet & Greet package on `neon-harbor-megatour` (order limit 4, event limit 6), child/senior/student offers on every event, promo codes `STORM10` (10 percent, platform-wide) and `FIVEOFF` ($5, Saturday show only).
- Schema: `addons`, `promo_codes`, `events.order_limit`, `price_levels.dyn_k/dyn_j/perks`, `inventory.locked_cents`, `holds.options`, `order_items.kind = 'discount'`, `tickets.addon_id` (and `tickets.inventory_id` nullable, with a CHECK that exactly one of them is set), unique `(event_id, name)` on `offers`.

#### Changed
- `quote()` now returns `addons`, `discount`, `promo` / `promoError` and per-line `base` / `offerId`; `orders.subtotal` is tickets plus add-ons and `total = subtotal + fees + tax - discount`. A promo that stops being valid blocks payment with a clear message instead of silently changing the total.
- `FeeRule` gained optional `delivery_cents`; `EventRow` no longer carries `min_cents` / `max_cents` (cards use `displayRange`).
- `place()` error for oversized orders is now "Choose 1 to N tickets per order".
- `getTicket`, `scanTicket`, My tickets and the order page handle tickets without a seat (LEFT JOIN on `inventory` and `addons`). Transfers and resale still refuse passes (`assertTradable` joins `inventory`).
- `tests/holds.test.ts`: one replace-own-hold step now picks seats that satisfy the orphan rule.

#### Fixed
- An unlocked presale could only be reached by typing the tickets URL. The event page now shows a "Find presale tickets" button (and the public on-sale date) to a session that has unlocked an open window before the public on-sale.

#### Known limitations
- Add-ons carry no service or facility fee.
- Displayed prices on an open seat map do not refresh dynamic prices until reload; the hold locks the real price and checkout shows it.
- Offers are not locked at hold time (only face price is); promo and offer choices live on the hold and are cleared when the shopper replaces the hold.

---

## P7: Waiting room, bot defense, presales and Verified Fan

### 8cccfa2 (2026-10-07) P7: waiting room, bot defense, presales and Verified Fan

#### Added
- Waiting room (`lib/queue.ts`, `/queue/[eventId]`, `GET/POST /api/queue/[eventId]`, `components/QueueRoom.tsx`): random rank before on-sale, FIFO after, lazy admission by rate (per minute since on-sale) and cap (live admitted), 10-minute shopping window, injectable clock, 5-second polling.
- Server-side queue gate on the tickets page (redirects to the queue) and on every hold path (`place()`, `holdListing`): 403 until admitted.
- Bot defense (`lib/defense.ts`): fixed-window rate limiter in one upsert, HMAC math captcha with single-use nonces, honeypot field, IP/email `blocklist`. Applied to login (10/min), queue join (5/min), checkout (10/min) and presale code entry (10/min), per IP and per account.
- Captcha and honeypot on the checkout form; every refusal returns a fresh captcha.
- Per-account `ticket_limit` (`assertTicketLimit`): paid orders + live holds from the user's other sessions + new quantity; checked at hold time, at finalize, and for resale holds.
- On-sale windows (`onsale_windows`) with access codes, single-session unlocks (`window_unlocks`), presale seats hidden from the map and from every hold path unless the window is open and unlocked; unsold presale seats return to public sale when the window ends.
- Verified Fan: registration window, one-time lottery job (shuffle, first N selected, rest waitlisted, codes via email/SMS/in-app), buy-by deadline with waitlist promotion for idle selected fans.
- Organizer pages: `events/[id]/access` (windows, generate codes, CSV download via route handler, hold back a section or row) and `events/[id]/queue` (enable, rate, cap).
- Event page: presale cards, code form (`?code=` prefills), Verified Fan registration, "Join the waiting room" link.
- Seed: `neon-harbor-megatour` (queue on, on sale in 2 minutes, 6/min, cap 20, 30 fans waiting), `neon-harbor-empire-wednesday` fan club presale (code `STORMFAN`), `neon-harbor-catskill-saturday` Verified Fan campaign.
- Schema: `onsale_windows`, `access_codes`, `window_unlocks`, `vf_registrations`, `queue_entries`, `rate_limits`, `blocklist`.
- Tests: `tests/queue.test.ts`, `tests/access.test.ts`.

#### Changed
- Login now also carries the waiting-room place and unlocked presales to the new session.
- Jobs also purge old rate-limit rows and long-expired queue entries, release ended windows, run the lottery and waitlist promotion.
- Availability and hold queries use a shared "visible window" predicate instead of `window_id IS NULL`.

#### Security
- Presale code use is a guarded `UPDATE ... WHERE uses < max_uses`; the schema also has `CHECK (uses <= max_uses)`.
- Captcha nonces are burned on first use, so a token cannot be replayed or used to guess.

---

## P6: Transfers, resale, favorites

### 3fa7281 (2026-10-07) P6 review fixes

#### Fixed
- Cancelling an event after a ticket was resold refunded both the original and the new order but left the seller's resale credit in the ledger (money created). `refundEvent` now adds a reversing `resale_credit` row once per listing (`ref = listing:ID:reversal`, guarded).
- Order page showed duplicate lines for a ticket that had been transferred or resold (join on `order_id + inventory_id` matched multiple ticket rows). It now joins the lowest ticket id.
- Ticket page linked to the order for new owners who cannot view it; the link now shows only to the buyer or for guest tickets.
- Event cancel and reschedule notified only the buyer; they now also notify current holders (transfer recipients, resale buyers).
- Removed a redundant row spread in `activeListings`.

### c4f993e (2026-10-07) P6: transfers, resale listings, ledger, favorites

#### Added
- Transfers (`lib/transfers.ts`, `/transfers/[id]`): send to an email or phone, 128-bit claim token, 7-day expiry, claim link via outbox/SMS and in-app notice; sender can cancel; recipient accepts or declines. Accept inserts a new ticket with a new secret and marks the old one `transferred` (old QR dead).
- Resale (`lib/resale.ts`, `/sell`, `/listings`, `app/resale/actions.ts`): list a valid ticket (status `listed`), cancel, listings expire at event start. A buyer holds a listing with one conditional UPDATE, then uses the normal checkout at the seller's price; `settleListing` runs inside the buyer's finalize transaction (listing sold, seller ticket `resold`, ledger credit, seller notified).
- Resale seats show on the map (pink "Verified Resale") and in the ticket picker.
- `ledger` table and `lib/ledger.ts` (append-only, `ledgerAdd`, `balance`).
- Favorites (`lib/favorites.ts`, `/favorites`, `components/Heart.tsx`) for events, venues and artists; guests are sent to log in.
- Login and signup honour `?next=` (same-site paths only).
- Seed: `fan2` buys a seat and lists it; `fan` has a paid order.
- Tests: `tests/resale.test.ts`, `tests/resale.worker.ts` (concurrent buys, old token dead after transfer).

#### Changed
- `quote()` includes listing holds as "Verified Resale" lines.
- `refundEvent` cancels active listings and pending transfers.
- `free()` also clears a listing's hold.

#### Security
- Partial unique indexes `one_pending_transfer` and `one_active_listing`; transfer and listing are mutually exclusive (NOT EXISTS guard on listing; `assertTradable` on transfer).

---

## P5: Organizer, scanner, admin, cancellations

### 72eb43a (2026-10-07) P5 review fixes

#### Fixed
- Doors could be set after the event start; now rejected.
- On-sale could be set at or after the event start; now rejected.
- Inventory tool could only act on a whole row or section; added an optional seat range (from/to) so single seats can be killed or blocked.
- Scanner replay window: queued scan timestamps were only limited to the last 24 hours. They are now accepted only between doors minus 6 hours and start plus 12 hours, else server time is used. The remaining trust in device time is recorded as a `ponytail:` note.
- Offline scan queue dropped scans on 401/403; it now keeps them queued and shows "Signed out or not allowed".
- Reschedule email printed a raw UTC timestamp; it now uses the venue time zone.
- Admin refund retry ran for any event id; it now requires the event to be `cancelled`.
- "Already used. Already scanned at" message duplicated words.

### 141697d (2026-10-07) P5: organizer, scanner, admin, cancellations and reschedules

#### Added
- Organizer area (org-scoped): org signup (starts `pending`), events (create, edit, publish, cancel, postpone, reschedule), price levels and fee rules, on-sale time, inventory tool (price level, kill/comp/artist/promoter/production blocks, release), venues with generated charts, chart JSON import/export, seat flags, members and roles (last-owner protection).
- Scanner (`lib/scan.ts`, `/api/scan`, `/scan/[eventId]`, `components/Scanner.tsx`): SafeTix verification, admission by a single conditional UPDATE, results valid/used/expired/invalid/wrong_event, attendance counts, offline queue in localStorage.
- Admin area: users (block, role), orgs (approve/suspend), events (approve/unpublish, edit text), feature flags, failed-refund list with retry.
- `refundEvent` (idempotent, per-order transactions, failed refunds stay `cancelled` with `refund_error`), reschedule/postpone with holder notifications.
- `feature_flags` and `audit_log` tables; `lib/platform.ts` (`UserError`, flags, `audit`); `require_event_approval` flag.
- Role helpers `requireOrgRole`, `requireAdmin`, `memberRole`.
- Tests: `tests/organizer.test.ts`, `tests/scan.worker.ts` (concurrent scans of one ticket: exactly one valid).

#### Security
- Org authorization always derives the org from the target row (event or venue), never from the URL or form; `/api/scan` authorizes against the event's org.
- Pending and suspended orgs cannot publish.

---

## P4: Checkout, fake payments, orders, mobile tickets

### 2d99069 (2026-10-07) P4 review fixes

#### Fixed
- Order total did not equal the sum of its items because the per-order fee had no row. It is now stored as an `order_items` row of kind `fee`, and shown on the order page.
- Guest users following the "Order" link from a ticket page lost the access token; the token is now preserved in the link.
- A declined or invalid payment redirected back and wiped the billing form. `pay()` now returns form state (without card number or CVC) so fields are refilled and errors appear inline (`useActionState`).
- Logging in during checkout dropped the guest hold, pending 3DS payment and guest orders. `login()` now moves them to the new session.

#### Security
- `/dev/outbox` and its nav link are disabled when `NODE_ENV=production`.

### 6459d4f (2026-10-07) P4: checkout, fake payments, orders, SafeTix mobile tickets

#### Added
- Fake gateway (`lib/payments.ts`): Luhn and expiry validation, behaviour by last4 (`0002` decline, `9995` insufficient funds, `3220` 3DS, `0341` refund fails). Card numbers and CVCs are never stored.
- Pricing (`lib/pricing.ts`): service percent + facility charge per ticket, city tax on face + fees, one per-order fee; defaults overridable by settings and per-event `fee_rule`.
- Checkout page with countdown, saved cards, billing address, guest email; 3DS page.
- `finalize()` transaction: hold check, payment, inventory sold, order, items, tickets, hold converted; payments idempotent through a UNIQUE key; declines keep the hold.
- Orders list and detail pages, ticket list and detail pages; confirmation email to the outbox.
- SafeTix tokens (`lib/safetix.ts`, `components/TicketQR.tsx`): HMAC over `ticketId:window`, 15-second windows, plus or minus one window accepted.
- Schema: `orders`, `order_items`, `tickets` (with the `one_live_ticket` partial unique index), `payments`, `saved_cards`.
- Tests: `tests/payments.test.ts`, `tests/safetix.test.ts`.

#### Security
- Order and ticket access control: owner for user orders, buying session or emailed access token for guest orders, constant-time token compare; no sequential-id access.
- Payments and holds are matched by session token.

---

## P3: Seat map, inventory, holds

### 61ae0da (2026-10-07) P3 review fixes

#### Fixed
- `runJobs` executed its statements outside a transaction; now a single `tx()`.
- Seat map was keyboard-inaccessible; seats and sections are now focusable with Enter/Space and have `aria-label`s.
- Bundle holds did not verify that the other games were on sale; now rejected if any is draft, unapproved, or not buyable.
- Best available could pick bundle-level seats when no level was named; now excluded.
- Holding GA in a section with no GA inventory returned a confusing result; now "Unknown section" (400).
- Availability endpoint revealed draft or unapproved events; now 404.
- Presale-window seats counted as free in GA totals and showed as available; they now count as unavailable.
- Mouse wheel on the seat map always blocked page scroll; it now zooms only with Ctrl/Cmd or when already zoomed.
- Dragging the map could trigger a seat or section click afterwards; the drag flag is now reset correctly.

### ab1a48a (2026-10-07) P3: seat map, inventory, holds

#### Added
- Inventory generated per event (one row per reserved seat and per GA slot), levels by section rank and seat flags.
- Hold algorithm (`lib/inventory.ts`): every path (specific seats, best available, GA, bundle) ends in one conditional UPDATE inside `BEGIN IMMEDIATE`, expiry folded into the predicate, all-or-nothing.
- Session-owned holds, one live hold per session per event, release by owner only, `activeHold` restores the map after reload.
- Bundle levels: holding a seat holds the same seat in every game of the bundle.
- Routes: `POST /api/holds`, `DELETE /api/holds/[id]`, `GET /api/events/[id]/inventory` (compact availability).
- `components/SeatMap.tsx` (SVG, zoom, pan, per-section drill-down, best available, GA picker, polling) and `components/Countdown.tsx`; tickets page `/events/[slug]/tickets`.
- Seed: inventory for every event, three-game bundle with a "Season Bundle" level in section 202.
- Schema: `holds`, `inventory`, `price_levels.event_ids`, `offers`.
- Tests: `tests/holds.test.ts` and `tests/holds.worker.ts` (8 connections x 200 iterations: no double holds, all-or-nothing).

---

## P2: Discovery, search, categories, event page

### 10501be (2026-10-07) P2 review fixes

#### Fixed
- Concurrent build workers raced switching to WAL and failed with SQLITE_BUSY; opening the DB now sets the busy timeout first and retries the WAL pragma.
- "Today" and "weekend" filters used the UTC date, dropping evening shows; they now use the venue-local date.
- Search showed only the capped result count; it now says "Showing N of M events".
- Impossible dates such as `2026-02-31` passed validation; the date parser now round-trips the string.
- Added index `price_levels_event`.

### 01e8273 (2026-10-07) P2: discovery, search, suggest, categories, event page

#### Added
- Home page: trending and "near you" (city cookie or geolocation).
- Search (`/search`) with text, category, genre, city and radius (miles or km), date range, quick date filters, accessible-seating filter; URL params validated.
- Autocomplete (`/api/suggest`), category pages, event page with lineup and status badges, `eventState`.
- City selector in the header, `NearMe`, `EventCard`, `Filters`, `SearchBox` components.
- Seed: 83 random events plus fixed events (Saturday at two venues about 50 miles apart, Wednesday, cancelled, not-yet-on-sale).
- Tests: `tests/events.test.ts`.

---

## P1: Foundation, auth, outbox, seed

### aca1aa2 (2026-10-07) P1 review fixes

#### Fixed
- Reset and verify codes were checked then marked used in separate statements (race allowed double use); now consumed with `UPDATE ... RETURNING`.
- Requesting a new reset or verify code left older codes valid; older unused codes are now invalidated.
- Reset-email flooding; at most one reset code per minute per account.
- `fail()` redirects appended `?error=` to paths that already had a query string.
- Password hash comparison threw on a malformed (wrong-length) stored hash; length is now checked first.
- Missing indexes: `sessions(user_id)`, `events(venue_id)`, `event_artists(artist_id)`.
- Seed event slugs now use the loop index (stable) instead of dates.

#### Security
- `setCity` rejects non-numeric city values and redirects only to a same-host referer (previously an arbitrary `back` form field: open redirect).
- Password reset still signs the user out everywhere.

### 3796e1e (2026-10-07) Untrack .DS_Store

#### Changed
- Removed `.DS_Store` from git and ignored it.

### bb0f7f2 (2026-10-07) P1: foundation, auth, outbox, seed

#### Added
- Next.js 15 + React 19 + TypeScript scaffold using `node:sqlite` with no ORM; Node >= 23.6; `engines` in `package.json`. Deviation: the test script uses a glob because `node --test tests/` fails on Node 23.7.
- Idempotent `lib/schema.sql` (identity, places, events) applied on every DB open; WAL, busy timeout, foreign keys; `tx()` using `BEGIN IMMEDIATE`.
- Auth: scrypt password hashing, cookie sessions, lazy guest sessions, signup, login, logout, email verification, password reset.
- Simulated email/SMS outbox (`lib/notify.ts`, `/dev/outbox`).
- Geo helpers (haversine, nearest city), deterministic venue chart generator (arena, stadium, theater, amphitheater, club).
- Deterministic seed (cities, venues, artists, events, five accounts with password `password123`), `npm run seed`, `reset`, `jobs`, `test`, `typecheck`.
- `runJobs()` housekeeping, throttled call from the root layout.
- Tests: `tests/auth.test.ts`.
