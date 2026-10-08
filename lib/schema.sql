-- Idempotent; applied on every DB open. Schema change -> edit here, `npm run reset`.

-- Identity
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'fan' CHECK (role IN ('fan','admin')),
  email_verified_at TEXT,
  twofa_enabled INTEGER NOT NULL DEFAULT 0,
  address TEXT,
  notif_prefs TEXT,
  home_city_id INTEGER REFERENCES cities(id),
  alert_radius_mi INTEGER NOT NULL DEFAULT 100, -- followed-artist/venue alerts only for events this close to home_city_id
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deleted')),
  flagged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER REFERENCES users(id),
  expires_at TEXT NOT NULL,
  impersonator_id INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('verify','reset','otp','vf')),
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 -- wrong guesses; an otp code dies after 5
);
CREATE INDEX IF NOT EXISTS codes_lookup ON codes(kind, code);

CREATE TABLE IF NOT EXISTS oauth_links (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  UNIQUE(provider, subject)
);

-- Places and people
CREATE TABLE IF NOT EXISTS cities (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  country TEXT NOT NULL DEFAULT 'US' -- not US = international: tax is labelled local VAT/GST and prices are shown with an approximate local currency
);

CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended'))
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','manager','box_office','scanner','finance')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city_id INTEGER NOT NULL REFERENCES cities(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  tz TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 0,
  info TEXT,
  image TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reserved','ga')),
  capacity INTEGER,
  path TEXT NOT NULL,
  label_x REAL NOT NULL,
  label_y REAL NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  section_id INTEGER NOT NULL REFERENCES sections(id),
  row TEXT NOT NULL,
  number INTEGER NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  accessible INTEGER NOT NULL DEFAULT 0,
  companion INTEGER NOT NULL DEFAULT 0,
  obstructed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(section_id, row, number)
);

CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  bio TEXT,
  image TEXT,
  genres TEXT,
  links TEXT
);

CREATE TABLE IF NOT EXISTS artist_related (
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  related_id INTEGER NOT NULL REFERENCES artists(id),
  PRIMARY KEY (artist_id, related_id)
);

-- Events
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  series_key TEXT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  genre TEXT,
  starts_at TEXT NOT NULL,
  doors_at TEXT,
  image TEXT,
  description TEXT,
  info TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled','postponed','rescheduled')),
  onsale_at TEXT,
  hold_minutes INTEGER NOT NULL DEFAULT 8,
  ticket_limit INTEGER NOT NULL DEFAULT 8, -- per account for the whole event (paid + held)
  order_limit INTEGER,                     -- per order/hold; NULL = same as ticket_limit
  queue_enabled INTEGER NOT NULL DEFAULT 0,
  queue_rate INTEGER,
  queue_cap INTEGER,
  fee_rule TEXT,
  transfer_rule TEXT,
  resale_rule TEXT,
  refund_window_until TEXT,
  popularity INTEGER NOT NULL DEFAULT 0,
  published_at TEXT, -- set when a draft goes live; alerts for followed artists/venues count from here
  approved INTEGER NOT NULL DEFAULT 1,
  print_ok INTEGER NOT NULL DEFAULT 0,        -- 1 = print-at-home allowed (static code); 0 = mobile only
  willcall_ok INTEGER NOT NULL DEFAULT 0,     -- 1 = buyers may pick "will-call" delivery (box-office pickup)
  non_transferable INTEGER NOT NULL DEFAULT 0 -- 1 = tickets can be neither sent nor resold (server-enforced in assertTradable)
);
CREATE INDEX IF NOT EXISTS events_starts ON events(starts_at);
CREATE INDEX IF NOT EXISTS events_series ON events(series_key);
CREATE INDEX IF NOT EXISTS events_venue ON events(venue_id);

CREATE TABLE IF NOT EXISTS event_artists (
  event_id INTEGER NOT NULL REFERENCES events(id),
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  billing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, artist_id)
);

CREATE TABLE IF NOT EXISTS price_levels (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  color TEXT,
  price_cents INTEGER NOT NULL,
  ticket_type TEXT NOT NULL DEFAULT 'standard' CHECK (ticket_type IN ('standard','vip','platinum','accessible','standing')),
  dyn_min_cents INTEGER, -- dynamic pricing: price = clamp(base * (1 + k * sold% + j * queue factor), min, max); k = j = 0 -> fixed
  dyn_max_cents INTEGER,
  dyn_k REAL,
  dyn_j REAL,
  perks TEXT,            -- VIP / Meet & Greet package contents, shown to buyers
  event_ids TEXT -- bundle level: JSON array of event ids; holding a seat holds the same seat in each
);

CREATE INDEX IF NOT EXISTS price_levels_event ON price_levels(event_id);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL CHECK (name IN ('adult','child','senior','student')),
  pct_off INTEGER NOT NULL DEFAULT 0,
  UNIQUE(event_id, name)
);

-- Add-ons sold at checkout. `sold` only ever changes through the guarded UPDATE in createOrder.
CREATE TABLE IF NOT EXISTS addons (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_id INTEGER NOT NULL REFERENCES events(id),
  kind TEXT NOT NULL CHECK (kind IN ('parking','merch','vip','food','hospitality','camping','shuttle')),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  inventory INTEGER NOT NULL CHECK (inventory >= 0),
  sold INTEGER NOT NULL DEFAULT 0,
  CHECK (sold <= inventory)
);
CREATE INDEX IF NOT EXISTS addons_event ON addons(event_id);

-- org_id NULL = platform-wide; event_id NULL = every event of the org (or every event when org_id is NULL too)
CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  org_id INTEGER REFERENCES orgs(id),
  event_id INTEGER REFERENCES events(id),
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('pct','fixed')),
  amount INTEGER NOT NULL CHECK (amount > 0), -- percent for pct, cents for fixed
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  CHECK (uses <= max_uses)
);

CREATE INDEX IF NOT EXISTS event_artists_artist ON event_artists(artist_id);

-- Platform bits P1 needs
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','webhook')),
  "to" TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, read_at);

-- Inventory: one row per sellable unit. Reserved seat = 1 row; GA area = 1 row per capacity slot (seat_id NULL).
-- Expiry is lazy: status='held' AND held_until < now means available again.
CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  session_token TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  expires_at TEXT NOT NULL,
  options TEXT, -- JSON checkout choices: { promo, offers: {inventoryId: offerId}, addons: {addonId: qty} }
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','released'))
);
CREATE INDEX IF NOT EXISTS holds_session ON holds(session_token, event_id);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_id INTEGER NOT NULL REFERENCES events(id),
  section_id INTEGER NOT NULL REFERENCES sections(id),
  seat_id INTEGER REFERENCES seats(id),
  slot INTEGER,
  price_level_id INTEGER NOT NULL REFERENCES price_levels(id),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','held','sold','blocked')),
  block_kind TEXT CHECK (block_kind IN ('kill','comp','artist','promoter','production')),
  hold_id INTEGER REFERENCES holds(id),
  held_until TEXT,
  window_id INTEGER,
  locked_cents INTEGER, -- unit face price fixed when the row was held; quote and finalize use it, never the live price
  UNIQUE(event_id, seat_id),
  UNIQUE(event_id, section_id, slot)
);
CREATE INDEX IF NOT EXISTS inventory_status ON inventory(event_id, status);
CREATE INDEX IF NOT EXISTS inventory_hold ON inventory(hold_id);

-- Orders, tickets, payments (P4)
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER REFERENCES users(id),
  session_token TEXT NOT NULL, -- buyer's session: authorizes guest orders
  access_token TEXT NOT NULL,  -- unguessable emailed-link credential for guest orders
  email TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id),
  hold_id INTEGER NOT NULL UNIQUE REFERENCES holds(id), -- one order per hold
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','review','cancelled','refunded','partially_refunded')),
  subtotal INTEGER NOT NULL,
  fees INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  protection INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  promo_id INTEGER,
  delivery TEXT NOT NULL DEFAULT 'mobile',
  source TEXT,
  src TEXT, -- marketing source slug from ?src= (validated), reported per event
  refund_error TEXT, -- set when a refund failed at the gateway; order stays 'cancelled' until a retry succeeds
  review_reason TEXT, -- why status is 'review': fraud score, organizer hold, failed installment
  fraud_score INTEGER,
  ip TEXT,      -- client IP at checkout ('local' = unknown, never used for scalper detection)
  card_fp TEXT, -- HMAC of brand+last4+exp: a card fingerprint, never the card
  picked_up_at TEXT, -- will-call: when box office handed the tickets over
  picked_up_by INTEGER REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS orders_card_fp ON orders(card_fp);
CREATE INDEX IF NOT EXISTS orders_ip ON orders(ip);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_event ON orders(event_id);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL DEFAULT 'ticket' CHECK (kind IN ('ticket','addon','protection','giftcard','fee','discount')),
  inventory_id INTEGER REFERENCES inventory(id),
  addon_id INTEGER,
  offer_id INTEGER,
  unit_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0 -- >0 once this item was refunded on its own (an item can be refunded once)
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  inventory_id INTEGER REFERENCES inventory(id), -- NULL for an add-on pass (parking, hospitality)
  addon_id INTEGER REFERENCES addons(id),         -- set exactly when inventory_id is NULL
  owner_id INTEGER REFERENCES users(id), -- NULL = guest order
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','used','transferred','listed','resold','cancelled','expired')),
  secret TEXT NOT NULL,
  scanned_at TEXT,
  scanned_by INTEGER REFERENCES users(id),
  restrictions TEXT,
  CHECK ((inventory_id IS NULL) <> (addon_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_ticket ON tickets(inventory_id) WHERE status IN ('valid','listed','used');
CREATE INDEX IF NOT EXISTS tickets_owner ON tickets(owner_id);
CREATE INDEX IF NOT EXISTS tickets_order ON tickets(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  order_id INTEGER REFERENCES orders(id), -- NULL until the order exists (3DS in flight, declines)
  hold_id INTEGER REFERENCES holds(id),
  session_token TEXT,
  kind TEXT NOT NULL DEFAULT 'charge' CHECK (kind IN ('charge','refund','payout')),
  method TEXT NOT NULL DEFAULT 'card' CHECK (method IN ('card','saved','applepay','googlepay','paypal','giftcard','installments','exchange')),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded','declined','requires_3ds','pending')),
  brand TEXT,
  last4 TEXT,
  decline_code TEXT,
  meta TEXT, -- JSON: contact + billing + save-card flag. Never card number or CVC.
  parent_id INTEGER REFERENCES payments(id), -- a refund points at the charge it returns money to
  due_at TEXT,       -- pay-in-4: when a pending installment is charged
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS saved_cards (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  brand TEXT NOT NULL,
  last4 TEXT NOT NULL,
  exp TEXT NOT NULL,
  fake_token TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0, -- express checkout preselects it
  UNIQUE(user_id, brand, last4)
);

-- Platform (P5)
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  variant_pct INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  data TEXT
);

-- Fan-to-fan (P6)
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  from_user INTEGER NOT NULL REFERENCES users(id),
  to_email TEXT,
  to_phone TEXT,
  to_user INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled','expired')),
  expires_at TEXT NOT NULL,
  claim_token TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_transfer ON transfers(ticket_id) WHERE status = 'pending';

-- hold_id/held_until reserve a listing for one buyer's checkout; expiry is lazy (held_until < now = free again)
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','cancelled','expired')),
  expires_at TEXT NOT NULL,
  seller_fee_pct INTEGER NOT NULL DEFAULT 10, -- fixed when the listing is created or re-priced: what the seller was shown
  hold_id INTEGER REFERENCES holds(id),
  held_until TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_listing ON listings(ticket_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS listings_hold ON listings(hold_id);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  account TEXT NOT NULL, -- 'user:ID' | 'org:ID' | 'platform'
  kind TEXT NOT NULL CHECK (kind IN ('sale','fee','resale_credit','refund','payout')),
  amount INTEGER NOT NULL,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account);
CREATE INDEX IF NOT EXISTS ledger_ref ON ledger(ref);

-- Payout requests of a user or an org. The ledger debit is written with the request (it reserves the funds); rejecting writes it back.
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  account TEXT NOT NULL, -- 'user:ID' | 'org:ID'
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid','rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS payouts_account ON payouts(account);

-- One row per settled event: the PRIMARY KEY makes settlement idempotent.
CREATE TABLE IF NOT EXISTS settlements (
  event_id INTEGER PRIMARY KEY REFERENCES events(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  collected INTEGER NOT NULL,
  net INTEGER NOT NULL,
  fees INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  last_refund_payment_id INTEGER NOT NULL DEFAULT 0, -- refunds with a higher payment id happened after settlement and are reversed in the ledger
  settled_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS favorites (
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('artist','venue','event')),
  ref_id INTEGER NOT NULL,
  last_price INTEGER, -- event favorites: cheapest face price (cents) when the price-drop job last looked
  PRIMARY KEY (user_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS favorites_ref ON favorites(kind, ref_id);

-- One row per alert ever sent: (user, kind, ref) is unique, so a re-run of the alert jobs can never send it twice.
CREATE TABLE IF NOT EXISTS alerts_sent (
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, kind, ref)
);

-- ADA / accommodation requests and, in P11, contact-form tickets. messages = JSON [{from, at, text}].
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER REFERENCES users(id),
  email TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general',
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  messages TEXT NOT NULL DEFAULT '[]'
);

-- Access, queue, bot defense (P7)
CREATE TABLE IF NOT EXISTS onsale_windows (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fanclub' CHECK (kind IN ('public','artist','venue','card','fanclub','promoter','verified_fan','sponsor')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  requires_code INTEGER NOT NULL DEFAULT 1,
  reg_starts TEXT,
  reg_ends TEXT,
  vf_slots INTEGER,
  vf_buy_by TEXT,
  lottery_at TEXT,
  promoted_at TEXT
);
CREATE INDEX IF NOT EXISTS windows_event ON onsale_windows(event_id);

CREATE TABLE IF NOT EXISTS access_codes (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  window_id INTEGER NOT NULL REFERENCES onsale_windows(id),
  code TEXT NOT NULL UNIQUE,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id),
  CHECK (uses <= max_uses)
);

-- Which sessions have entered a valid code for a window (follows the session through login).
CREATE TABLE IF NOT EXISTS window_unlocks (
  window_id INTEGER NOT NULL REFERENCES onsale_windows(id),
  session_token TEXT NOT NULL,
  PRIMARY KEY (window_id, session_token)
);

CREATE TABLE IF NOT EXISTS vf_registrations (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  window_id INTEGER NOT NULL REFERENCES onsale_windows(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','selected','waitlisted','expired')),
  code TEXT,
  lottery_rank INTEGER,
  UNIQUE(window_id, user_id)
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_id INTEGER NOT NULL REFERENCES events(id),
  session_token TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  rank INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  admitted_at TEXT,
  expires_at TEXT,
  seen_at TEXT, -- last join/poll; people who stopped polling no longer count as demand
  UNIQUE(event_id, session_token)
);
CREATE INDEX IF NOT EXISTS queue_order ON queue_entries(event_id, admitted_at, rank);

-- Fixed-window counters: one row per (key, window start in ms). Also used for single-use captcha nonces.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE IF NOT EXISTS blocklist (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL CHECK (kind IN ('ip','email')),
  value TEXT NOT NULL,
  UNIQUE(kind, value)
);

-- Ticket protection claims (P9)
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','denied')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);
-- one open or approved claim per order
CREATE UNIQUE INDEX IF NOT EXISTS one_live_claim ON claims(order_id) WHERE status IN ('submitted','approved');

-- Ticket exchanges: old ticket -> a seat at another date of the same series (P9)
CREATE TABLE IF NOT EXISTS exchanges (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  from_ticket INTEGER NOT NULL REFERENCES tickets(id),
  to_inventory INTEGER NOT NULL REFERENCES inventory(id),
  from_order INTEGER NOT NULL REFERENCES orders(id),
  to_order INTEGER NOT NULL REFERENCES orders(id),
  diff_cents INTEGER NOT NULL
);

-- P12A
-- Seeded editorial lists and city guides. items = JSON [{slug, note}] of event slugs; a guide (city_id set) also shows the city's venues and events.
CREATE TABLE IF NOT EXISTS discover (
  slug TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('list','guide')),
  title TEXT NOT NULL,
  blurb TEXT NOT NULL,
  city_id INTEGER REFERENCES cities(id),
  items TEXT NOT NULL DEFAULT '[]'
);

-- A fan's target price for an event. The alert job notifies once per (user, event, target) through alerts_sent.
CREATE TABLE IF NOT EXISTS price_alerts (
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, event_id)
);

-- Guest order lookup: a 6-digit code mailed to the order's email. Only a keyed hash is stored; single use, 15 minutes, 5 wrong tries.
CREATE TABLE IF NOT EXISTS lookup_codes (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lookup_order ON lookup_codes(order_id);

-- Simulated "link another ticket vendor" (nothing is imported or sent anywhere).
CREATE TABLE IF NOT EXISTS vendor_links (
  user_id INTEGER NOT NULL REFERENCES users(id),
  vendor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, vendor)
);
