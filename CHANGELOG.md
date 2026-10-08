# Changelog

All notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no version numbers yet; each section is a commit. Review-fix commits are grouped under their phase.

## P12B: nice-to-have sweep, features 12 to 22 (final phase)

Verified, not rebuilt: the resale policy UI (organizer event page: floor, ceiling, fees, on/off, platform defaults at `/admin/fees`), the hearing assistance / ASL interpreter / sensory-friendly request types on `/support/ada` (`ADA_KINDS`), and artist music/social links (stored in `artists.links`, now headed "Music and social", http(s) only, `nofollow`).

#### Added: resale (1/8)
- **Make an offer.** Table `resale_offers` (pending, accepted, rejected, withdrawn, expired, completed; one pending offer per buyer and listing by a partial unique index; offers lapse after 48 h). `makeOffer` requires an offer below the asking price and at or above the event's floor. `acceptOffer` reserves the listing for that buyer at the offer price for 30 minutes (`listings.reserved_for / reserved_until / offer_price_cents`) with ONE conditional UPDATE (active, nobody checking out, nothing already reserved), so two offers can never both be accepted (tested with worker threads); other pending offers are declined. While reserved nobody else can hold it, and the seller cannot edit, cancel or expire it (`IDLE` predicate). The buyer checks out from `/seller`; `holdListing` keeps the offer price for that buyer and extends the reservation to the hold, `pricing.quote` and `settleListing` read the same price (`rules.listingPrice`), so the ledger (seller net, fees, tax) uses the offer price and stays zero-sum. A lapsed reservation returns the listing to its asking price.
- **Price suggestion** on `/sell`: median of the other active listings in the ticket's section, else its price level, clamped to the floor and ceiling.
- **Seller dashboard** `/seller`: offers received (accept, reject), listings, sold with net per sale, balance, offers you made (withdraw, check out). Third-party resale is labelled as not integrated (skipped) on the dashboard, `/sell` and the offer text.
- **Claim status page** `/claims` (own claims, state and next step).
- Server actions use `requireSelf`; offers are rate limited (10 a minute).

#### Added: stored value, refunds, chargebacks (2/8)
- **Account credit** (`credits`, signed rows; balance is the sum). Spending is one guarded `INSERT ... SELECT ... WHERE balance >= amount`, so the balance never goes negative. Shown and listed on `/account/payment`.
- **Gift cards** (`gift_cards`): `/gift-cards` to buy (fake charge on a test card, 3DS refused), the 16-character code (80 bits, `XXXX-XXXX-XXXX-XXXX`) is emailed to the recipient and only a keyed hash is stored; check a balance (10 a minute per IP and account, same answer for wrong and empty); redeem the whole balance to account credit (guarded, single use). `balance_cents` has `CHECK >= 0`.
- **Partial payment at checkout.** The pay form takes a gift card code and a "use my credit" box. `planStored` splits the total (gift card, then credit, then card); the card is charged only the rest (a fully covered order asks for no card). The balances are taken inside the order's transaction by guarded decrements (a miss rolls the whole order back, tested with two 3DS orders on one card), each as its own `charge` payment (`giftcard` / `credit`), so `sum(payments) == total` and `sum(items) == total` hold. Pay in 4 cannot be combined with them.
- **Refunds return value to the source**: the shared refund function sends the gift-card part back onto the card and the credit part back to credit (`settleStoredRefunds`); the card part goes to the card as before. New option **refund as account credit** (self-service refund on a rescheduled event, organizer and admin refund forms; accounts only, not resale orders) via `RefundOpts.credit`.
- **Ledger.** Stored value is a liability: issuing or returning it writes `account +x, cash -x`; spending it writes `account -x, cash +x` (accounts `credit:<user>`, `giftcard:<id>`); after settlement `reverseAfterSettlement` books the credit/gift account instead of cash. Every pair sums to zero (asserted in the tests).
- **Chargebacks.** An order paid with the 0341 card opens a `disputes` row (the bank disputes it). `/admin/disputes`: **won** changes nothing; **lost** refunds the card part through the shared refund function as a `chargeback` payment that cannot fail, cancels the tickets and frees the seats; gift card and credit paid on the order return to their balances; after settlement the organizer, platform and tax accounts are reversed, zero-sum. Audited.

#### Added: content (3/8)
- **Add-on kinds**: organizers can create parking, merch, hospitality, VIP upgrade, food pre-order, camping and shuttle; VIP, camping and shuttle (like parking and hospitality) get scannable passes. All reuse `addons` and its guarded `sold` update.
- **Reviews** (`reviews`): event or venue, 1 to 5 stars, only for users who own a ticket that was scanned (`attended`), one per user per target (UNIQUE), pending until an admin approves at `/admin/reviews` (audited), shown on the event and venue pages as "verified attendee" with escaped text.
- **Seat views**: the venue page shows generated views from a middle seat of each reserved section (the P12A `SeatView`), labelled as illustrations.
- **Team pages**: `artists.kind` (`artist|team`); a team page shows the schedule and season tickets (the bundle price level, same seat in every game).
- **Weekly digest** (`lib/digest.ts`, in `runJobs`): up to 5 recommended events per user, once per user per ISO week through `alerts_sent`, sent as a marketing message so the user's marketing in-app / email / SMS preferences apply and the email has the unsubscribe footer.
- **Import artists** (`/favorites/import`): paste names; case, punctuation, "&" and a leading "the" are ignored; reports followed, already followed and unmatched.

#### Added: organizer tools and API (4/8)
- **Clone event** and **series template** (N more draft dates every D days, shared `series_key`) on the event page; copies details, rules, levels, offers and add-ons (no sales, bundles or presale windows).
- **API keys** (`api_keys`, `/organizer/[orgId]/developers`): `tsk_` + 192 random bits, shown once (client `useActionState`), only a SHA-256 hash stored, revocable, at most 10 active. `GET /api/v1/events` (Bearer key): 401 without a valid key, scoped to the key's org, 60 requests a minute per key (429), public event facts only. Audited create/revoke.
- **Webhooks** (`webhooks`): `order.created` and `order.refunded` are written to the outbox `webhook` channel with `X-TicketStorm-Signature: sha256=HMAC(secret, body)` in the subject; org-scoped; payloads carry ids and amounts, no personal data.
- **Embed** `/embed/event/[id]` (route handler, plain HTML card, no script, form or cookie; the button opens the main site in a new tab). `next.config.ts` sends `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` on every other route; the embed route alone allows `frame-ancestors *`. The developers page lists iframe snippets.
- **Guest list** (`.../events/[id]/guests`, printable; name, seat, delivery, will-call pickup, checked in) and **customer CSV** (`/organizer/[orgId]/customers/csv`, own org's live buyers only, formula-safe `csvCell`, audited).

#### Added: analytics, A/B, i18n, GDPR (5/8)
- **Funnel**: `events_log (event_id, kind view|hold|order)` with no user, session or IP; logged by the event page, `place()` and `createOrder`; shown on the organizer report.
- **A/B tests**: `feature_flags.variant_pct`; `bucket = sha256(flag:visitor) % 100` with the visitor id from an `ab` cookie set by middleware, so a visitor keeps the variant across login (tested: sticky, ~50 percent split, independent flags). Admin UI on `/admin/flags` (audited). Flag `ab_cta_text` changes the event page button text.
- **i18n**: `lib/i18n.ts` en/es for the navigation and checkout, `lang` cookie from a header switch, `<html lang>` follows it.
- **GDPR admin tools** `/admin/privacy`: export any user (JSON, audited) and erase (the shared `deleteAccount`, now with `null` = admin; blocked for admin accounts; pending offers withdrawn; audited). `exportData` also includes credit, gift cards bought, offers and reviews.

#### Accessibility (6/8)
Skip link, visible `:focus-visible` outline (and a thick ring on focused seats and sections), buttons and links at 4.5:1 or better (`#1d4ed8`), reduced-motion rule, labels on the checkout, login and signup fields, `main` landmark. Seat map: roving tabindex (one seat in the Tab order), Enter on a section focuses its first seat, arrow keys move between seats, Enter/Space select, Escape returns to the sections; seats have `role=button`, `aria-pressed` and full `aria-label`s. Checked by driving the page with keyboard events: section, arrows, select, hold, checkout.

#### Schema
`listings` (+3 columns), `payments.method` (+`credit`, `chargeback`), `artists.kind`, new tables `resale_offers`, `credits`, `disputes`, `gift_cards`, `events_log`, `reviews`, `api_keys`, `webhooks`. `npm run reset` is required.

#### Tests
`tests/p12b.test.ts` (+ `offers.worker.ts`): offer accept race (one winner), reserved price and ledger, lapsed reservation, price suggestion, gift card partial payment and refund back, gift card cannot be overspent, credit atomicity and refund-as-credit, chargeback lost (before and after settlement, zero-sum), review eligibility, digest idempotency and preferences, import matching, API key hashing / 401 / org scope / revoke / rate limit, webhook signature, clone and series, customer CSV, A/B stickiness, i18n, funnel privacy, admin erase.

## P12A review fixes

#### Fixed
- **Non-transferable left listings buyable.** `holdListing` now refuses events with `non_transferable`, and turning the flag on (`setDeliveryRules`, one tx) cancels the event's active listings (tickets back to `valid`, sellers notified, even a listing a buyer was checking out) and its pending transfers (senders notified). Saving the same setting again does nothing.
- **Impersonation and offline/print.** While `sessions.impersonator_id` is set the ticket pages do not render `OfflineTickets`, the print link or the party link, `/tickets/[id]/print` is a 404, and the tickets list does not save pages. "Stop viewing as this user" is now a plain POST route (`/impersonate/stop`) instead of a server action so the service worker sees it; the worker also clears all `ts-*` caches on POSTs to `/impersonate/*` and `/account/privacy` (account deletion), besides `/logout`, `/login`, `/signup`, `/auth/*`.
- **Scalper false positives.** The five published test card numbers get no fingerprint outside production (`payments.cardFingerprint`, used by `pay` and the wallet), so demo buyers are not flagged by the shared 4242 card; real card numbers and IP clusters work as before. The seed passes explicit fingerprints for its scalper demo.
- **Lookup**: the email and order number are no longer in URLs; the pair is kept in a signed (HMAC), httpOnly cookie scoped to `/lookup` for 15 minutes, which the code step reads. The per-order limit now counts only requests whose email matches the order (the IP limit still counts everything), so a stranger cannot spend the owner's allowance.
- **SSE slot leak**: `acquire()` runs after `getSession()` and `openWindowIds()`.
- **Service worker**: static cache is versioned (`ts-static-v2`) and `activate` deletes older `ts-static*` caches; `OfflineTickets` and the worker key saved pages by origin and path only (no query string, so flash messages and `?t=` tokens never create entries or misses).
- **Sitemap** excludes cancelled events.
- **Price alerts** compare with the cheapest price level that still has an available seat (a sold-out cheap level no longer triggers them).

#### Tests
- Added: flag-on cancels listings and transfers, held listing refused, saving twice is silent; alert ignores a level without stock; lookup cookie signature, tamper and expiry, exact order match; test cards have no fingerprint; sitemap hides cancelled events; service worker query keys, new clearing paths and old-cache deletion.

## P12A: nice-to-have sweep, features 1 to 11

Verified, not rebuilt: the Verified Fan waitlist (P7: `promoteWaitlist` gives codes to waitlisted fans when selected ones do not buy), transfer to a non-user by SMS link (`createTransfer` with a phone number texts a claim link; the recipient signs up to accept), and "reclaim" (= `cancelTransfer`; the ticket page button is now labelled "Reclaim ticket (cancel transfer)").

#### Added: discovery and SEO (1/6)
- **`/map`**: SVG lat/lng map of venues with upcoming events (equirectangular, no tiles or scripts; dot size = event count; category chips and any `/search` filter work; a dot lists that venue's events). **Discover** (`/discover`, `/discover/[slug]`): seeded editorial lists and city guides (table `discover`; a guide also shows the city's venues and next events), a **Top picks** rail (most popular upcoming event per category) on the home page and Discover.
- **Pagination**: `?page=` on `/search` and `/category/[slug]` (20 per page, `lib/discover.ts pageMath` clamps junk page numbers, `searchEvents` got an `offset`); "Showing N of M events" is kept and a Prev/Next `Pager` keeps every filter in the URL.
- **SEO**: `generateMetadata` (title, description, canonical, Open Graph through `lib/seo.ts pageMeta`) on event, venue, artist, category and discover pages; `app/sitemap.ts` (`sitemapEntries()`: only non-draft, approved, upcoming events, plus venues, artists, categories, discover) and `app/robots.ts` (private areas disallowed).
- Event page: related events (same category and genre or shared artist, never the same tour), venue mini map and an OpenStreetMap directions link, **simulated** deterministic weather (`lib/weather.ts`, sha256 of date and city, labelled as simulated), "N people viewing" (distinct sessions with an active hold plus waiting-room entries seen in the last 5 minutes; a count, no identities), on-sale countdown (`components/Until.tsx`).

#### Added: seat map extras (2/6)
- **View from seat** (`components/SeatView.tsx`): an SVG perspective generated from the seat's chart position (distance, side, elevation), shown for the hovered or focused seat; captioned as an illustration. Seats with `obstructed = 1` get a pillar in the picture, a dashed orange ring and "limited view" in the tooltip, the aria label, the legend and a note on the checkout page. Map seat flags are now `1 accessible, 2 companion, 4 limited view`; the accessible filter masks with `& 3`.
- **SSE** `GET /api/events/[id]/stream` (`lib/stream.ts`): sends `getAvailability()` (seat id, status letter, level id, GA counts) whenever it changes, a heartbeat comment otherwise. It carries no hold ids, session tokens or owners (tested structurally). At most 100 open streams process-wide (then 503 + `Retry-After`), each ends after 5 minutes or on client abort (timers and the counter are released). `SeatMap` uses `EventSource` and falls back to the old 5 s polling when SSE is missing, refused or dropped.

#### Added: ticket rules and flags (3/6)
- **Per-event flags** (organizer form "Delivery and ticket restrictions", audited `rules.delivery`): `print_ok` (otherwise mobile only), `willcall_ok`, `non_transferable`.
- **Non-transferable** is enforced in `assertTradable`, which transfer create, transfer accept and listing creation all call, and shown on the event and ticket pages.
- **Delivery choice at checkout** (mobile, print at home, will-call), validated server-side against the event in `finalize` (`assertDelivery`); resale purchases are always mobile. Stored in `orders.delivery`.
- **Print-at-home**: `/tickets/[id]/print` (owner, valid ticket, print-enabled events only) draws a static code (`makePrintToken`, `id.p.HMAC(secret, "id:print")`); `scanTicket` accepts it only when `print_ok`, and the same conditional UPDATE means the first scan wins (the mobile code of a used ticket is dead too).
- **Will-call**: the organizer orders page lists will-call orders; "Mark picked up" (`orderPickup`, box office, manager or owner of the order's own org, audited `order.pickup`) is one conditional UPDATE, so it cannot happen twice.
- **Price alerts** (`lib/pricealerts.ts`, table `price_alerts`, form on the event page, `requireSelf`): the job compares the cheapest face price (fees and the all-in toggle do not matter) with the target and notifies once per (user, event, target) through `alerts_sent`; changing the target re-arms it.
- **Scalper flagging** (`lib/scalpers.ts`): orders record `ip` (never `local`) and `card_fp` (keyed hash of the card number, never the number; saved cards keep it in `saved_cards.fp`). Three or more different accounts (by email) with live orders on one event sharing a fingerprint or IP flag their registered accounts (`users.flagged`, audit row `scalper.flag` with no actor). `/admin/scalpers` lists clusters; "Cancel and refund" recomputes the cluster from the database and calls `refundOrder` per order (audited `scalper.cancel_orders`).

#### Added: checkout extras (4/6)
- **Express checkout**: with a card in the wallet and a full address in the profile, checkout preselects the default card, fills the billing address and says so. A saved card now always needs its CVC typed again (server-checked; it is never stored). Not offered while impersonating, and `pay` still refuses then.
- **Card wallet** (`/account/payment`, tab "Wallet"): add a card (validated, then only brand, last four, expiry and a keyed fingerprint are kept), make default, delete; five cards at most.
- **Display currency**: header selector (cookie), fixed rate table in `lib/currency.ts` (EUR, GBP, CAD, AUD, MXN, JPY), amounts shown as "≈ €50.60" on cards, the event page and the checkout total; always labelled approximate, and checkout charges USD. International events (`cities.country` not `US`, seed: Toronto) default to their local currency and label tax as local VAT/GST/HST.
- **Protection step**: `/checkout/[holdId]/protection` asks yes or no once (stored as `holds.options.protection`, `false` counts as answered); the checkbox on the options form stays.
- **Guest order lookup** `/lookup`: email plus order number mails a 6-digit code to the order's address (`lookup_codes`, keyed hash only). The page answers identically whether or not the order exists; limits per IP and per order number; a code works once, for 15 minutes and 5 guesses; success opens a guest order with its access token, or sends an account order's owner to log in.
- **Simulated vendor linking** (`/account/linked`): three invented vendors; linking records a row and imports nothing. In the GDPR export and removed on account deletion, as are price alerts.

#### Added: offline, party, print (5/6)
- **Offline tickets**: `public/sw.js` (network first; serves a saved `/tickets` or `/tickets/<id>` page only when the network fails; keeps `/_next/static` scripts), `components/OfflineTickets.tsx` saves the owner's pages into one cache per user id and deletes any other user's. The cache is cleared by any POST to `/logout`, `/login`, `/signup` or `/auth`. The QR rotates offline because `TicketQR` computes the HMAC in the browser.
- **Share with party** `/party/[token]`: signed read-only link (`lib/party.ts`, `userId.eventId.expiry.HMAC`, expiry 12 h after the show) listing seats and states; never a secret, QR, email or payment detail; tamper or expiry gives 404.
- Countdown to the show on the ticket page.

#### Tests
- `tests/p12.test.ts` (pagination math, offset walk, sitemap visibility, weather determinism, viewer count, related events, SSE payload and connection cap, non-transferable enforcement, price-alert idempotency, delivery and print scan, will-call, scalper flag and bulk cancel, lookup single use, expiry and lockout, currency, protection step, wallet, party token tamper) and `tests/sw.test.ts` (the service worker run against fake globals).

#### Known limits
- The browser pane used for verification refuses to register service workers, so offline behaviour is covered by `tests/sw.test.ts` plus the cache-writing code path, not by a real DevTools-offline run.
- Scalper thresholds are constants; the shared test card 4242 trips them on purpose when three accounts use it on one event. Party links cannot be revoked before they expire. A static print code can be copied; first scan wins.

## P11 review fixes

#### Fixed
- **Refunds after settlement never reached the ledger** (the organizer kept money it had been paid and could withdraw it). `doRefund` now calls `reverseAfterSettlement`: for every refund payment made after the event's settlement (`settlements.last_refund_payment_id`), once per payment (ref `refund:payment:ID`), cash +refund and organizer, platform and tax accounts are debited in proportion to the order's face, fees plus protection, and tax. Covers `refundEvent` after settlement too. The org balance can reach zero or below; payouts need `amount <= balance`, so it cannot be overdrawn.
- **Impersonator could spend the target's money and tickets.** Purchases (`pay`, including saved cards and "save card") are refused while impersonating, as are 3DS approval, refund requests and claims, exchange, transfer, resale sell/edit/cancel, support replies and Verified Fan registration. Read-only pages and fan-neutral actions (favorites, inbox, search, presale code entry) still work. `refuseImpersonation()` / `requireSelf()` are the guards.
- **Refunding one resale order left the seller's credit.** The resale ledger reversal moved from `refundEvent` into `doRefund` (`reverseResale`, runs when a resale order becomes `refunded`, guarded by ref `listing:ID:reversal`), so every refund path reverses it once.
- `settlement.run` is audited only when the settlement actually ran.
- The impersonation test now exercises `assertNotImpersonating`, which `requireSelf` calls (plus source checks that every sensitive action file uses the guards).

## P11: ticket states, transfer and resale rules, payouts, organizer and admin ops

#### Added
- **SafeTix extras**: a moving band over the QR (CSS, still under `prefers-reduced-motion`), the code blurs on `visibilitychange` / window `blur` and returns on focus, `/api/tickets/[id]/pass` (owner only, 401/404 otherwise) downloads a mock Apple or Google pass JSON with a serial (`TS-<id>-<hmac>`), the event, seat, state and a barcode that is a link to the ticket page; it never contains the secret or a token. **NFC decision**: "Tap to enter (NFC)" only offers the current token as an NFC payload over a `BroadcastChannel`; the scanner page of an authorised staff member (same browser) picks it up and submits it through `/api/scan`, which still needs a scanner role (a fan's own POST is 403, checked). A fan cannot admit their own ticket. `lib/ticketstate.ts` gives one state label (valid, valid with transfer pending, on hold, listed, sold, transferred, used, cancelled, expired when the show is over) used on My tickets, the ticket page, orders and the pass.
- **Transfer rules** (`events.transfer_rule`: enabled, deadline hours before the show), enforced server-side in `createTransfer` AND `acceptTransfer` (`lib/rules.ts assertTransferOpen`). Job `expireTransfers()` marks pending transfers `expired` (older than 7 days, past the deadline, or show started) and notifies the sender; decline now notifies the sender too. Organizer form on the event page; the ticket page explains a closed or disabled transfer.
- **Resale rules** (`events.resale_rule` over `settings.resale_defaults`, admin form at `/admin/fees`): enabled, floor %, ceiling % of face, seller fee % (default 10), buyer fee % (default 5). **Face** = `order_items.unit_cents` of the ticket's original order line (a ticket bought on resale inherits the face of the ticket it replaced, so relisting cannot raise the ceiling; comps have face 0 and cannot be sold). Listing and re-pricing validate the band server-side. `updateListing` edits the price with one conditional UPDATE (not while a buyer holds it); the seller fee percent is stored on the listing when it is created or re-priced. Listings expire at event start (lazy through `expires_at`, plus job `expireListings()` that puts the ticket back to `valid`; a reschedule moves `expires_at`). "Your ticket sold" is an essential alert (inbox and email) with the net amount.
- **Resale money**: the buyer pays the resale buyer fee (a percent of the price, taxed) *instead of* the primary service, facility and order fees; it is the ticket item's `fee_cents`, so `sum(unit+fee+tax over items) == total`. The order has `source = 'resale'`. `settleListing` writes a zero-sum ledger group `listing:ID`: cash -(price+fee+tax), seller +(price - seller fee), platform +seller fee and +buyer fee (two rows), tax +tax.
- **Ledger** is now double-entry (`lib/ledger.ts`): accounts `user:ID`, `org:ID`, `platform`, `tax`, `payouts`, `cash`; every event writes rows that sum to 0 (`ledgerTotal()` is asserted in tests and shown on `/admin/payouts`).
- **Payouts** (`lib/payouts.ts`, table `payouts`): `/account/payouts` and `/organizer/[orgId]/payouts` request a payout; the balance check and the debit (account -X, `payouts` +X) are one `BEGIN IMMEDIATE` tx, so the pending request reserves the funds and concurrent requests cannot overdraw (6 worker connections test: exactly one wins). `/admin/payouts`: mark paid (`payouts` -X, `cash` +X) or reject (X returns to the account); each decided once.
- **Organizer reports** `events/[id]/reports` (owner, manager, finance): orders, gross, refunds, fees, tax, protection, net, attendance, sold by price level and by day (inline SVG bars), plus `reports/csv` (`text/csv`, one row per charged order and a TOTAL row equal to `sum(total)`). `csvCell` prefixes `'` to strings starting with `= + - @` tab or CR and quotes commas, quotes and newlines; numbers are never prefixed.
- **Settlement** (`lib/reports.ts settleEvent`, owner/finance on `/organizer/[orgId]/payouts`): once an event is over (start + 6 hours), idempotent through `settlements.event_id` PRIMARY KEY, refused while any order is in review or has a failed refund. Ledger `settle:event:ID`: cash -collected, org +net (live-order face after promos, minus refunds), platform +fees and protection, tax +tax.
- **Marketing**: `middleware.ts` stores a validated `?src=` slug (`^[a-z0-9][a-z0-9_-]{0,31}$`) in a 30-day httpOnly cookie; `pay` passes it to `finalize`, which stores it on `orders.src` (re-validated). `events/[id]/marketing` reports orders, tickets and charged amount per source, and sends an email campaign to followers (event, its artists, its venue) and buyers who opted in to "News and offers" email, through `emailUser` (unsubscribe footer). Limits: 3 campaigns per event per day, 500 opted-in recipients, subject 120 / body 2000 characters; audited with counts.
- **Admin**: `/admin/fraud` (flagged users with unflag, busiest rate-limit keys, blocklist add/remove, link to the review queue), flag/unflag on `/admin/users`, refund oversight table (all refund payments) on `/admin/refunds`, `/admin/audit` viewer, `/admin/payouts`, `/admin/support` threads.
- **Impersonation** (`lib/impersonation.ts`, `lib/session.ts`): admins press "View as this user" on `/admin/users` (never another admin, a blocked user or themselves). The admin's session is replaced by a 1-hour session of the target with `sessions.impersonator_id`; a banner with "Stop viewing" shows on every page; start and stop are audited (`impersonate.start|stop`, also when the admin logs out). `requireSelf()` refuses account security/profile/cards/payout actions, `requireOrgRole` (organizer mutations) and `requireAdmin` while impersonating.
- **Help and support**: `/help` (FAQ, contact form with honeypot and rate limit), `/support` and `/support/[id]` (owner only, reply), admin reply thread at `/admin/support/[id]` (staff reply emailed as essential mail, inbox notification, status answered/open/closed).
- **Audit**: every exported admin and organizer action calls `audit()` (a test scans both action files); new actions audit `rules.transfer`, `rules.resale`, `resale.defaults`, `campaign.send`, `settlement.run`, `payout.request|paid|reject`, `blocklist.add|remove`, `user.flag`, `support.reply|close`.
- Seed: `storm-rules-demo` (transfers closed 48 h before a show that starts in 36 h; resale 50 to 150 percent), `storm-settled-demo` (3 tickets, one scanned, source `newsletter`, settled into the org balance), a support ticket from `fan@` with a staff reply.
- Tests: `tests/p11.test.ts` (+ `p11.worker.ts`): ceiling and floor, seller net credit and its reversal on cancel, zero-sum ledger, payout reserve/reject/paid, concurrent payout requests, transfer deadline at create and accept, expiry jobs, CSV escaping and totals, `src` in the report, settlement idempotency, review blocks settlement, campaign opt-in and limits, impersonation rules, audit scan, support threads.

#### Changed
- `settleListing` takes the buyer's fee and tax; the seller ledger credit is now price minus the seller fee (was the full price). The cancel-after-resale reversal negates every row of the listing group once (guard: ref `listing:ID:reversal`), so the seller loses exactly the net credit. Tests updated.
- Resale checkouts no longer pay the primary service, facility and order fees; they pay the resale buyer fee only.
- Account actions use `requireSelf` instead of `requireUser`.

## P10 review fixes

#### Fixed
- **ICS semicolons were never escaped**: `'\;'` in a JS string is just `;`, so the earlier entry's claim that `;` was escaped was wrong (and the test expectation matched the bug). `icsEscape` now emits `\\;`; tests corrected.
- **GET unsubscribed**: mail scanners and link previews fetch links. `GET /unsubscribe?t=` now only shows a one-button confirm form; only POST (same signed token, also what one-click unsubscribe sends) changes preferences.
- **Preferences suppressed essential mail**: with order mail off, confirmations, cancel/postpone notices and transfer claim links were not sent. Order, ticket, transfer and event-change messages are essential: always sent, no footer, no preference. `PREF_CATEGORIES` is now `alerts` and `marketing` only (the misleading orders toggles are gone from `/account/notifications`; `orders_*` keys are ignored); `orders`-category alerts always reach the inbox; unsubscribe tokens for `orders` are rejected. `emailUser` is only for optional mail (alerts, marketing). Correction to the P10 entry below: event-change, confirmation and transfer emails no longer go through it.
- **Organizers could not set age, bag policy, set times or notices**: the event edit page has an "Event page details" form (`setEventInfo`: length limits, set times one per line as `HH:MM Act`, other `info` keys kept, org-scoped through `authEvent`, audited as `event.info`). Notices are stored as text and escaped on render (checked with a `<script>` notice).
- **Resale filter** is driven from the event's inventory (`inventory_status` index) to its listed ticket (`one_live_ticket`) to the listing (`one_active_listing`); `EXPLAIN QUERY PLAN` shows no scan of all listings.
- **`sort=distance` without a city** silently sorted by date: the option is hidden unless a city filter or city cookie exists, and a direct URL shows "Pick a city to sort by distance".
- Documented (`ponytail:`) that on-sale reminders need the jobs to run inside the hour before on-sale.

---

## P10: Discovery, content pages, notifications, accessibility

102 tests (13 new, in `tests/p10.test.ts`); `typecheck`, `test` and `build` green. All acceptance checks were also run against a live dev server with a scripted client (56 checks: filters and sorts, ICS, event/venue/artist pages, alert pipeline with `npm run jobs`, unsubscribe, companion holds, ADA form).

#### Added
- **Search** (`lib/events.ts searchEvents`): price range `min`/`max` (dollars, URL), genre (sub-genre of the category), venue (`venue=<slug>`), verified resale (`resale=1`: an active listing on a listed ticket), presale (`presale=1`: a window that has not ended), accessible (`accessible=1`), and `sort=relevance|date|price|distance|popularity`. Every param is validated in `parseFilters` and dropped when malformed. "Showing N of M" is kept (`total` counts every match, the page shows 60).
  - **No N+1**: filters are `EXISTS` subqueries and the price columns (`min`, `max`, "has a demand-priced level", fee rule, city tax) are scalar subqueries on `price_levels(event_id)`, so one statement returns everything; all-in prices for the whole result are computed with `shown()` using the fee rule and tax from that same row (platform fee defaults are read once). Only events with a dynamic level call `displayRange` (the same helper their card uses).
  - **All-in is consistent**: `min`/`max` and `sort=price` are in the units the fan sees (the all-in cookie is passed in as `opt.allIn`), and the filter form says "incl. fees and tax" or "before fees and tax". An event matches when its price range overlaps `[min, max]`.
  - **Relevance** with a query: title match 4, artist 3, venue 2, city 1, then popularity, then date; without a query: popularity then date. **Distance** is measured from the city filter, else the `city` cookie; without either it falls back to date.
  - **Accessible now means the event still has an accessible seat to buy** (an available or lapsed-hold inventory row on an accessible seat), not just that the venue has some. The tickets page takes `?accessible=1` and opens the seat map with the accessible filter on; the event page has an "Accessible seating" checkbox next to Find tickets.
- **Recommendations** (`recommendedEvents`, `score`): genre overlap (2 points per favorite/follow/purchase of that genre, up to 3), followed artist (+6), distance decay (4 at the home city, halving every 150 km; 2 when unknown), popularity (up to 3). Profile = favorited events, past orders, followed artists' genres (`json_each(artists.genres)`). Home shows "Recommended for you" for users and "Popular picks" (popularity + distance from the city cookie) for guests. Events already ordered are left out.
- **Event page**: age, doors, bag policy, set times (venue wall-clock `HH:MM`), notices banner (`role="alert"`), all from `events.info`; "Add to calendar" and "Share" (`components/ShareButton.tsx`: `navigator.share`, else clipboard, else shows the link); "Other dates" from `series_key`; links to the venue and each artist.
- **ICS** `GET /api/events/[id]/ics` (`lib/ics.ts`, pure): `DTSTART`/`DTEND`/`DTSTAMP` in UTC (`...Z`), `UID:event-<id>@ticketstorm`, SUMMARY/LOCATION/DESCRIPTION escaped per RFC 5545 (`\ ; ,` and newlines), lines folded at 75 octets (counted in bytes, CRLF + space), `STATUS:CANCELLED` for cancelled events. Draft or unapproved events and unknown ids are 404. Events have no end time, so `DTEND` is start + 3 hours (`DEFAULT_MINUTES`).
- **`/venues/[slug]`**: address, capacity, static SVG map (`components/MiniMap.tsx`: equirectangular window of about 9 km, neighbouring venues as dots, OpenStreetMap link), seating-chart preview (`components/ChartPreview.tsx`), parking / transit / bag / accessibility / FAQ as plain `<details>` sections (accessibility open by default, with the count of accessible seats and the ADA request link), upcoming events, follow heart.
- **`/artists/[slug]`**: bio, image, genres, http(s)-only links, tour dates, follow heart, related artists (both directions of `artist_related`).
- **Cross-links**: event cards link the venue and the headliner (`hl_slug`), the event page links venue and artists, and `/favorites` links artists and venues (the gap left by P6).
- **Notifications** (`lib/alerts.ts`):
  - `alertUser(userId, category, kind, ref, msg)` is the one way a pipeline alert is sent. It first inserts `(user_id, kind, ref)` into **`alerts_sent`** (primary key); if that row already exists nothing is sent, so running the jobs any number of times, or two processes at once, never sends the same alert twice. Then it delivers per the user's category preferences: inbox (`notifications`), email (outbox, with unsubscribe footer), SMS (outbox, needs a phone).
  - Jobs (`runAlerts()`, called at the end of `runJobs()`, one transaction): **new event** for a followed artist or venue (published after the follow, inside the fan's alert radius around their home city; no home city = no radius filter), **on-sale reminder** within the hour before `onsale_at` (fans of the event, its venue or one of its artists), **price drop** on favorited events (`favorites.last_price` is the cheapest face price when last seen; set when you favorite, updated by the job; a lower price alerts with ref `event:<id>:<price cents>`). Each is a single aggregate query with `NOT EXISTS (... alerts_sent ...)`, not per-user lookups.
  - **Event changes** keep the existing cancel/postpone/reschedule notifications; their emails now go through `emailUser`, so they respect the preference and carry the unsubscribe link. **Ticket delivered**: `finalize` (inbox/SMS; the confirmation email already goes out), fraud-review approval, and transfer accept. **Transfer received**: an existing recipient gets the claim email (`emailUser`) plus an inbox alert.
  - **Categories and channels**: `orders` (tickets, transfers, refunds, event changes), `alerts` (new show, on-sale, price drop), `marketing`; channels `inapp` (inbox), `email`, `sms`. Defaults: inbox on everywhere, email on for orders and alerts, SMS off. `/account/notifications` has the grid and the alert area (home city + radius, `users.home_city_id`, `users.alert_radius_mi`).
  - **`/inbox`**: newest 100, unread highlighted, mark one / all read; the header shows an unread badge (`notifications(user_id, read_at)` index).
- **Unsubscribe**: every email to a registered user (`emailUser`) ends with `/unsubscribe?t=<userId>.<category>.<HMAC>`. The HMAC is `mac('unsub:<user>:<category>')` with the existing server secret (`lib/defense.ts`), compared with `timingSafeEqual`; the category must be a known one. GET (the link) and POST (mail-client one-click) turn off `<category>_email` and keep every other preference; no login. Anything malformed or tampered is a 400.
- **Accessibility**: holding an accessible seat (`holdSeats`) also holds its linked companion seat (same section and row, number +/- 1, flagged `companion`, the next number wins) in the same `place()` transaction. The companion counts toward the per-order and per-account limits (checked again after the expansion, with a message that says what to do), must be free, and the whole selection goes through the orphan-seat check. `companion: false` opts out (checkbox on the seat map). The generated charts now put each accessible seat right beside its companion (seats 1+2 and 4+5 of the last row). Venue accessibility text on `/venues/[slug]`.
- **ADA request** `/support/ada` (`lib/support.ts`): email (logged-in users use theirs), need, details; creates a `support_tickets` row (`kind = 'ada'`, one opening message in `messages` JSON). Validated, honeypot, 5 per minute per IP and account. Linked from event and venue pages. P11 adds the admin reply thread on the same table.
- **Organizer**: the new-event form can set a headliner (`event_artists`), and `publishEvent` stamps `events.published_at`, which is what "new event" alerts count from.
- **Seed**: `fan@` follows **Cora Valdez**, whose New York date (`cora-valdez-noche-de-tormenta`) is a draft in the organizer's account: publish it as `organizer@`, run `npm run jobs`, and `fan@` gets inbox + email. `fan@` also watches `neon-harbor-empire-saturday` (lower a level's price in the organizer's pricing page, run the jobs: price-drop alert) and `neon-harbor-empire-onsale-soon` (on sale 50 minutes after reset: the reminder fires on the first job run). Home city New York, radius 100 mi. Set times, notice banner, age and bag policy on the Saturday show; venue accessibility and FAQ text; Neon Harbor bio, links and related artists; Neon Harbor's tour dates form a series ("Other dates").
- Tests (`tests/p10.test.ts`): ICS fields, escaping and folding (octets); unsubscribe token verify, tamper, category scoping; every email carries the link and respects the preference; new-show alert sent once however often the jobs run, and email-off still reaches the inbox; SMS only when enabled; radius filter; on-sale reminder and price-drop idempotency (including a price that was already announced); companion auto-hold, opt-out, taken companion, limits, orphan rule; search price/all-in/sort/genre/venue/accessible/presale and param validation; recommendation scoring; ADA ticket.

#### Changed
- `PREF_CHANNELS` is now `inapp, email, sms`; `prefsOf` defaults include the inbox. `holdSeats(eventId, owner, seatIds, companion = true)`. `searchEvents(f, limit, opt)` takes the viewer's all-in flag and reference city. `EventRow` gained `venue_slug`, `popularity`, `hl_name`, `hl_slug`.
- `favorites` gained `last_price`; new tables `alerts_sent`, `support_tickets`; new columns `users.alert_radius_mi`, `events.published_at`. Run `npm run reset`.

#### Deviations and decisions
- "Watched event" = favorited event. Price-drop compares the cheapest non-bundle **face** price; dynamic surcharges and the all-in toggle are not part of that comparison.
- "Ticket delivered" is sent at the moment tickets reach an account (checkout, review approval, transfer accept) rather than by a scheduled job, because delivery is instant here; it is still recorded in `alerts_sent` so it can't repeat. Guests have no preferences, so their mail is sent as written without an unsubscribe link.
- Events have no end time: ICS uses 3 hours.

---

## P9 review fixes

#### Fixed
- **Void kept the buyer's money** (`doRefund`): `refund: false` worked on any paid order (also for box office), cancelling tickets and keeping the payment. Void is now refused ("use a refund") while paid minus refunded is above zero, so it only applies to comps and unpaid orders. This also closes the item-refund-with-void case that marked a whole order cancelled.
- **Item refund on a pay-in-4 order over-collected**: the refund was capped at what was collected while later installments still charged the full price. Item refunds are refused while installments are pending. Full cancels (event cancel, fraud cancel, claim, refund window) void every pending row and refund only what was collected; tested.
- **Social login skipped 2FA**: `completeSocial` now sends the OTP and continues on `/login/otp` like the password login (shared `otpStep`).
- **Phone could be changed or cleared without the password while 2FA was on**: clearing is refused until 2FA is off; changing needs the current password (profile form has a password field).
- **Refunding exchange credit never touched the card**: refund rows for an `exchange` charge are now recorded as `card` (so the 0341 failure applies); only the internal credit move keeps method `exchange`.
- **Unverified provider emails**: no account is created from an email the provider has not verified (was: created unverified). `oauth_links` are deleted on password reset.
- **Approved claims kept seats sold for future shows**: seats are released when the show is still ahead, kept sold once it has started.
- **UI**: Exchange link also for `partially_refunded` orders (matches `exchangeable`); `/tickets` shows "on hold (order under review)" instead of "valid".
- Tests: void rules, pay-in-4 item refund and cancel, exchange-credit refund on 0341, unverified social, phone/2FA rules, claim seat release.

---

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
