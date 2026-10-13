# TicketStorm UI/UX redesign + real event data: brief

**Summary:** Redesign every TicketStorm page (fan, organizer, admin) into a clean, bright, Airbnb-like green/white product, and power discovery with real events, venues and artists (with photos) from the Ticketmaster Discovery API in a hybrid model.

- **Date:** 2026-10-13
- **Status:** draft
- **App:** /Users/gabriel/code/ticketstorm. Next.js 15 App Router, React 19, TypeScript, SQLite (`node:sqlite`), one `app/globals.css` (106 lines today, no Tailwind, no UI library). Runtime deps are deliberately minimal: `next`, `react`, `react-dom`, `qrcode`.
- **Feature inventory:** README.md, ARCHITECTURE.md, docs/research.md (the existing product is complete through plan phase P12B).

## Open questions
1. **Design DNA, not yet set.** There is no existing brand: no logo, no fonts, no palette beyond the accent direction below. The exact lime/mint hue, the darker text green, the neutrals, and the type pairing all need choosing, with contrast checked.
2. **Seat-map state colours.** The brand is green, and "available" is conventionally green. The available / held / sold / blocked / resale / accessible / selected states need a scheme that doesn't collide with the brand accent and doesn't rely on colour alone.
3. **Ticketmaster API terms.** The developer.ticketmaster.com terms of use and branding guide couldn't be fetched during research. Confirm the attribution and logo rules, the display rules, how long data may be cached or stored, the image usage rules, and the requirement that purchases link to Ticketmaster, before shipping.
4. **Refresh cadence and quota.** The default quota is 5,000 calls/day at 5 requests/second. Which cities and genres to sync, how often, and whether to sync on a schedule (job) or on demand (search) are undecided.
5. **Images for app-native events.** Events that organizers create in-app have no photos. Options are an organizer image upload or URL (the `events.image` field already exists), or generated per-event artwork as the fallback.
6. **Typography (default, open to change).** A friendly rounded sans for headings, Airbnb-like, and a neutral sans for body. Loading from Google Fonts versus self-hosting is undecided; self-hosted keeps the app usable offline.

## Purpose and job to be done
- **Fans** hire TicketStorm to find something worth going to near them, feel confident about where they'll sit and what they'll pay, buy fast (often in a queue, under a timer), and get into the venue with a ticket on their phone.
- **Organizers** hire it to set up and price events, watch sales, and run the door.
- **Admins** hire it to keep the platform safe (fraud, refunds, disputes, support).
- Today the UI is a functional prototype (a plain stylesheet). It does the jobs, but it doesn't make discovery exciting or checkout feel trustworthy.

## Audience and devices
- **Fans:** phone first, with full desktop support (responsive, not a separate site). The key phone moments are browsing, the waiting room, seat selection under a hold timer, checkout, and showing the rotating QR at the gate.
- **Organizers and admins:** desktop first and denser (tables, reports, forms), sharing the same visual language. They must still work on a phone, for example the scanner page at the door.

## Brand and mood
- **Clean, bright, airy. "Airbnb-esque":** lots of white space, rounded corners, soft shadows, large imagery-led cards, friendly typography, a calm and trustworthy checkout.
- **Colour:** a **green/white** UI with a **vivid lime/mint** accent, which must stay **readable**:
  - lime/mint on large fills (primary buttons, highlights, chips, badges, selected states), with near-black text on top;
  - a deeper shade of the same green for links, small text and icons on white, so text contrast passes WCAG AA (4.5:1);
  - white as the dominant surface, with soft neutral greys for structure.
- Not dark, not "nightlife", not corporate blue (a deliberate contrast with Ticketmaster).

## Real data: hybrid model (decided)
- **Source:** the Ticketmaster Discovery API (public; instant key from developer.ticketmaster.com; events, venues, attractions, classifications, hi-res images in multiple sizes and ratios, price ranges and seat-map images when available; search by lat/long, city, genre, venue or keyword).
- **AXS is ruled out:** it has no public API (partner-only). Scraping is not acceptable.
- **Real Ticketmaster events** power discovery: home rails, search, category pages, and the event, venue and artist pages, with real photos. Their buy action links out to Ticketmaster. TicketStorm does not sell or simulate purchases of real Ticketmaster events.
- **App-native events** (created by organizers in TicketStorm) keep the full TicketStorm stack: seat map, holds, queue, checkout, tickets, transfer, resale, organizer and admin tools.
- **The two kinds of event must be visually unmistakable:** a real Ticketmaster event shows "Tickets on Ticketmaster" with attribution; an app-native event shows the TicketStorm buy flow.
- **The API key is the user's own:** `TICKETMASTER_API_KEY` in a gitignored `.env.local`, never committed. Without a key the app still runs on its native events.
- **No placeholder or demo data for discovery** where real data can be used. The user explicitly wants real data streamed through the app. Seeded demo events remain only to exercise the native selling features and tests.

## References
- **Airbnb:** the overall feel, i.e. card-led browsing, rounded and airy layouts, photo-first, a friendly sans, calm booking flow.
- **Ticketmaster and AXS:** for flows only (queue, seat map, mobile ticket), not their look.

## Taste signals (dealer pins)
- Green/white, clean and bright.
- A vivid lime/mint accent, but readable (fills, not text).
- Airbnb-like: rounded, airy, imagery-first.
- Phone first, with desktop support.
- Real imagery from the API rather than generated or placeholder art, for real events.
- Typography default: a rounded friendly sans for headings and a plain sans for body (not explicitly confirmed by the user).

## Constraints
- Keep the minimal-dependency stance: no CSS framework or UI kit unless justified; native CSS custom properties for tokens. Images should use Next's `<Image>` or plain `<img>`, with the Ticketmaster image host allowed.
- Accessibility must not regress: the keyboard seat map, skip link, focus styles, labels and AA contrast from P12B stay.
- The existing behaviour and tests must keep passing (161 tests), and money and ticket flows are unchanged.
- Process (user requirement): researcher → planner → developer → critic agents; every change updates the relevant docs (README.md, ARCHITECTURE.md, CHANGELOG.md) and is committed and pushed separately.
- Work stays inside /Users/gabriel/code/ticketstorm.
