# TicketStorm: Ticketmaster Feature Inventory

Source note: compiled from working knowledge of Ticketmaster (web/app/Help Center/Presale docs); web tools were not used. Verify specifics before copying UX text.
Tags: [C]=CORE [I]=IMPORTANT [N]=NICE-TO-HAVE. EXT = depends on real external system; SIM = how a clone simulates it.

## 1. Discovery / Search / Browse (fan)
- [C] Home page: featured/hero events, trending, near-you rails
- [C] Text search: artist, team, event, venue, city; autocomplete suggestions
- [C] Category browse: Music (genres), Sports (leagues), Arts & Theater, Family, Comedy, Festivals
- [C] Location: city/metro selector, geolocation, radius (miles/km) filter. SIM: city lookup table, lat/lng haversine
- [C] Date filter: date range, "this weekend", calendar picker
- [I] Filters: price range, genre/sub-genre, venue, ticket type (resale, presale), accessible, "all-in price" toggle
- [I] Sort: relevance, date, price, distance, popularity
- [I] Recommendations: based on favorites, history, location. SIM: genre/location score rules
- [N] Map view of events; "Discover" editorial lists; city guides; Top picks
- [N] Pagination/infinite scroll, shareable filter URLs, SEO event URLs

## 2. Event Page
- [C] Title, date/time/timezone, venue, performers/lineup, image, description, on-sale status (upcoming/on sale/sold out/cancelled/postponed/rescheduled)
- [C] Ticket CTA, quantity picker, price range, ticket-type selection
- [I] Event info: age limit, doors time, bag policy, door rules, set times, important notices banners
- [I] Add to calendar (ICS), share (link/social)
- [I] Event series/multi-date (tour dates list), "other dates" switcher
- [N] Related events, venue map/directions, weather, "X people viewing", countdown to on-sale

## 3. Seat Map & Selection
- [C] Interactive SVG map: sections -> rows -> seats; zoom/pan; hover tooltips; availability color; price-level legend
- [C] Reserved seating (specific seat) vs General Admission (qty only, pit/floor/lawn)
- [C] Price levels/tiers mapped to sections; price filter slider on map
- [C] Best Available (auto-pick N adjacent seats; quantity-based) and manual seat pick
- [C] Seat states: available, held (by other), sold, blocked/kill, accessible, resale
- [I] List view alongside map (sorted by price/best); "lowest price"/"best seats" sort
- [I] Seat-adjacency rules / no orphan single seats (Ticketmaster "no leaving 1 seat")
- [I] Quantity limits per order/event (ticket limit)
- [N] 3D/"View from seat" photos; virtual venue; sightline notes (obstructed/limited view)
- [N] Real-time seat updates via websockets/polling (SIM: SSE)

## 4. Queue / Waiting Room
- [C] Waiting room before on-sale for high-demand events; random position assignment among those arriving before on-sale; FIFO after. SIM: in-memory/Redis queue + admit rate
- [C] Smart Queue: position/estimated wait, "do not refresh", admit into shopping with timed window
- [I] Rate-limited admission (N users/min), capacity cap on concurrent shoppers
- [I] Bot mitigation: Captcha/Queue-It style challenge, per-account/IP/device limits, ticket limits. EXT: bot-detection (SIM: simple rate-limit + honeypot/math captcha)
- [N] Anti-scalper account flagging, order cancellation for violations

## 5. Presales / Access
- [I] Presale types: artist, venue, credit-card (Amex etc.), fan-club, promoter, Verified Fan, Citi-style sponsor
- [I] Presale code entry (access codes/promo codes unlock hidden tickets or earlier on-sale)
- [I] Per-event on-sale schedule: multiple windows w/ start/end, audience rules
- [I] Verified Fan: register in window -> scored/selected -> SMS/email code + unique link on selection -> shop in assigned slot. EXT: SMS/phone verification, bot scoring. SIM: registration form, random lottery draw, code emailed to console log, fake OTP
- [N] Waitlist for Verified Fan non-selected; Capital One-style card verification (skip)

## 6. Pricing
- [C] Price levels/tiers per section; face value + fees
- [I] Dynamic/"Official Platinum" pricing: premium seats priced by demand in real time; admin sets min/max + algorithm. SIM: price = base * demand multiplier based on sold%/queue size
- [I] Fee types: service fee, facility charge, order processing fee, delivery; fee rules per event
- [I] All-in pricing (taxes/fees upfront, required in US since 2025 for tickets): toggle display; per-ticket breakdown at checkout
- [I] Promo/discount codes; fixed/percent; limited uses
- [N] Price alerts, drop-price notifications

## 7. Ticket Types
- [C] Standard admission, GA, reserved, VIP packages, accessible, resale, season/multi-event, ticket-bundle
- [I] Platinum / Official Platinum, Standing-room, Child/Senior/Student discounted, Meet & Greet, Add-on bundles (parking, merch, hospitality)
- [N] Mobile-only vs print; Resale-restricted (non-transferable) tickets; Will-call

## 8. Cart, Holds, Checkout
- [C] Seat hold on selection with countdown timer (typically ~2-10 min, event-configurable); release on expire/abandon. SIM: DB holds table w/ expires_at + sweeper/lazy expiry
- [C] Cart/order summary: items, per-ticket price, fees, taxes, total
- [C] Checkout: contact info, payment, delivery method (mobile transfer), confirm; guest checkout vs account
- [C] Payment: card; saved cards; billing address. EXT: payments (Stripe/Adyen). SIM: fake gateway w/ test card numbers (4242...), always-success/decline cases, idempotency key
- [I] Alternative pay: Apple Pay/Google Pay/PayPal/gift card/Klarna-style installments (Ticketmaster "Pay in installments" via Affirm/etc.). EXT. SIM: stubs
- [I] Taxes: by jurisdiction. SIM: flat rate per city
- [I] Order confirmation page + email. EXT: email. SIM: console/Mailhog/in-DB outbox
- [I] Fraud/3DS checks. EXT. SIM: skip or random review flag
- [N] Express checkout, saved address, multi-currency, international taxes, installment payments, "Ticket protection" upsell step

## 9. Orders / Account
- [C] Account signup/login: email+password, email verification, password reset, sessions/JWT
- [I] Social login (Google/Apple/Facebook) EXT: OAuth. SIM: skip or mock provider
- [I] 2FA / SMS verification. EXT: SMS. SIM: OTP logged to console
- [C] Order history: upcoming/past/cancelled; order detail w/ receipt, tickets, status
- [I] Profile: name, address, phone, payment methods, notification prefs, delete account/GDPR export
- [I] Resend confirmation email; download receipt PDF
- [N] Sign in as guest to look up order; Wallet of saved cards; account linking from other ticket vendors

## 10. Mobile Tickets & SafeTix
- [C] Digital ticket view: QR/barcode, section/row/seat, event info, in-app ("My Tickets")
- [I] SafeTix: barcode rotates every few seconds (HMAC/TOTP-style token) + screenshot prevention; verified server-side at scan. SIM: signed time-windowed token (HMAC over ticketId+time/15s) rendered as QR; scanner validates window
- [I] Add to Apple Wallet / Google Wallet (.pkpass / Google Wallet API). EXT: Apple/Google signing certs. SIM: show button + generate mock pkpass JSON or hide
- [I] NFC tap entry (Tap-to-enter, venue hardware). EXT: NFC. SIM: skip / button that emulates tap
- [I] Ticket states: valid, scanned/used, transferred, listed, cancelled, expired
- [N] Offline ticket display, print-at-home PDF fallback, group "share with party" view, countdown to event

## 11. Transfer
- [C] Transfer tickets to recipient by email/phone; recipient accepts and claims (account required); sender can cancel pending transfer
- [I] Transfer states: pending/accepted/declined/expired/cancelled; ticket invalidates sender's barcode on accept
- [I] Per-event transfer rules (disabled, deadline, no-resale-restrictions)
- [N] Transfer to non-user via SMS link (EXT SMS; SIM log link); "Reclaim" before accept

## 12. Resale / Fan-to-Fan Marketplace
- [C] Sellers list owned tickets (select seats, set price); listing appears on event page with seat map
- [C] Buyers buy resale tickets; ownership swaps atomically; barcode regenerated
- [I] Price floor/ceiling rules (face value caps per event/jurisdiction); seller fee (~15% TM) and buyer fee
- [I] Seller payout (bank/PayPal) after event/after sale. EXT: payouts (Stripe Connect). SIM: ledger balance, fake payout
- [I] Edit/cancel listing; listing expiry; sold notification
- [I] Verified resale only (no unauthorized listings), "Verified Resale" label
- [N] Third-party resale integration, offers/make-an-offer, price suggestion, seller dashboards

## 13. Insurance / Protection
- [I] Ticket protection add-on at checkout (cancellation/refund-for-reason); typical % of price. EXT: insurer (Allianz/Cover-Genius type). SIM: flat % fee, claim form with manual admin decision
- [N] Claim submission/status

## 14. Refunds / Exchanges / Cancellations
- [C] Cancelled event: automatic full refund to original payment; postponed/rescheduled: tickets valid, refund window
- [I] Rescheduled -> option to refund within N days; refund status tracking
- [I] Admin refund tools: full/partial, fees refunded or not, void
- [I] Exchange (event-specific, e.g. upgrade/ different date) and "Ticket Exchange"
- [I] Refund policies shown at checkout (usually no refunds unless cancelled)
- [N] Chargeback handling, credits instead of cash refunds

## 15. Favorites / Follow / Notifications
- [C] Follow/favorite artists, venues, teams, events; "My favorites" list
- [I] Alerts: new event announced for followed artist/venue near me; on-sale reminders; price drops; event changes; ticket delivery; transfer received. Channels: email, push, SMS. EXT: push/SMS/email. SIM: in-app inbox + email to console log
- [I] Notification preferences/unsubscribe per category
- [N] Weekly digest, "Track" via Spotify/Apple Music link to import artists (EXT)

## 16. Accessibility
- [C] Accessible seating section/filters: wheelchair, companion, ADA seats flagged on map
- [I] Accessible request flow: "Accessible" filter selects accessible inventory; companion seats auto-linked
- [I] Venue accessibility info (parking, entrances, services); ADA requests via contact form/phone
- [N] Hearing-assist, sensory, sign language request; WCAG AA site, keyboard seat selection, screen-reader labels

## 17. Gift Cards / Add-ons
- [N] Ticketmaster gift cards: purchase, redeem code, balance, apply at checkout (SIM: code table with balance)
- [I] Parking: purchase add-on per event/lot (qty, price) with pass/QR. EXT: venue parking system. SIM: inventory-limited add-on product
- [N] Merch, VIP upgrades, food/drink pre-order, hospitality/premium packages, camping, shuttle

## 18. Venue Pages
- [I] Venue profile: name, address, map, capacity, seating charts, photos, info (parking, transit, bag policy, accessibility, FAQ), upcoming events, follow
- [N] Venue reviews, "Getting there" directions, seat-view photos

## 19. Artist / Performer Pages
- [I] Artist profile: bio, image, genres, upcoming events (tour dates), follow, related artists
- [N] Music sample links, social links, fan discussions; Team pages (schedule/season tickets)

## 20. Reviews
- [N] Event & venue reviews/ratings (note: TM generally does not show user reviews; low priority), verified-attendee-only reviews, moderation

## 21. Organizer / Venue Side (Ticketmaster "Host" / Promoter / Archtics-like)
- [C] Org/venue accounts & roles (owner, manager, box office, scanner, finance)
- [C] Event creation: title, category, venue, date/time, images, description, status (draft/published/on-sale/cancelled)
- [C] Venue & seat map management: sections/rows/seats, GA areas, capacity, import/edit chart (SVG/JSON designer)
- [C] Inventory management: allocate seats to price levels, holds/kills (comps, artist, promoter, production), release, on-sale schedule
- [C] Pricing setup: price levels, ticket types, fee rules, dynamic pricing params, discount/promo/access codes
- [C] Check-in/scanning: scanner web app/PWA; validates barcode (SafeTix token), marks used, rejects duplicates, offline-tolerant, live attendance count. EXT: hardware scanners (NFC/handhelds). SIM: phone camera/manual code entry
- [I] Sales dashboard & reports: gross/net sales, tickets sold by level/day, attendance, fees, settlement/payout reports, CSV export
- [I] Presale configuration (Verified Fan campaigns, code lists, audience), queue settings (admit rate, capacity)
- [I] Order management: search orders, resend tickets, cancel/refund, move seats, comp tickets, fraud holds
- [I] Marketing: event pages/promo links with tracking, email campaigns (EXT email), fan lists
- [I] Payouts/settlement: revenue minus fees paid to organizer. EXT: bank rails. SIM: ledger + fake payout record
- [N] Multi-event/season/series templates, clone event, API/webhooks, embeddable widgets, guest-list/will-call, customer data export, resale policy controls (cap/disable transfer)

## 22. Admin / Platform
- [C] Admin console: user mgmt, event/org approval, content moderation, feature flags
- [I] Fraud/bot management dashboard; blocked accounts/IPs; order review queue
- [I] Fee config, tax config, refund oversight, support tools (impersonate/view order), audit log
- [I] Customer support: help center/FAQ, contact/ticket system
- [N] Analytics (funnel, conversion), A/B tests, localization/i18n, multi-currency, GDPR tooling, public API

## 23. External-Dependency Simulation Cheat Sheet
| System | Real | Clone simulation |
|---|---|---|
| Payments | Stripe/Adyen | fake gateway: test PANs, success/decline/3DS-stub, idempotency keys, refund API |
| Payouts | Stripe Connect | ledger balances + admin "mark paid" |
| Email | SES/SendGrid | outbox table + console/MailHog |
| SMS / OTP | Twilio | log OTP to console; fixed code in dev |
| Push | APNs/FCM | in-app notification inbox / SSE |
| Apple/Google Wallet | PassKit certs | download mock pass JSON or placeholder button |
| NFC | venue hardware | "tap" button on ticket + scanner |
| SafeTix barcode | proprietary | HMAC time-window QR rotating ~15s; scanner verifies |
| Bot detection | Queue-It/Akamai/Captcha | rate limits + simple captcha + queue |
| Geo/maps | Google Maps | static venue lat/lng + Leaflet/OSM |
| Insurance | underwriter | flat % fee + admin-reviewed claims |
| Verified Fan scoring | proprietary | random lottery |
| Tax | Avalara | flat rates table |
| Seat chart design | Seatmap designer | seeded JSON generator + SVG renderer |

## 24. MVP Cut (suggested)
All [C] items: search/browse, event page, seat map (reserved+GA, best available), holds+timer, checkout w/ fake payments, auth, orders, mobile ticket w/ rotating QR, transfer, basic resale, favorites, accessible seats, organizer event/venue/inventory creation + scanner, admin basics, waiting room (simple queue).
