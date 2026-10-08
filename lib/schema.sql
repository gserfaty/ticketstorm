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
  used_at TEXT
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
  tax_rate_bps INTEGER NOT NULL DEFAULT 0
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
  ticket_limit INTEGER NOT NULL DEFAULT 8,
  queue_enabled INTEGER NOT NULL DEFAULT 0,
  queue_rate INTEGER,
  queue_cap INTEGER,
  fee_rule TEXT,
  transfer_rule TEXT,
  resale_rule TEXT,
  refund_window_until TEXT,
  popularity INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 1
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
  dyn_min_cents INTEGER,
  dyn_max_cents INTEGER
);

CREATE INDEX IF NOT EXISTS price_levels_event ON price_levels(event_id);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL CHECK (name IN ('adult','child','senior','student')),
  pct_off INTEGER NOT NULL DEFAULT 0
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
