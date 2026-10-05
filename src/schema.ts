// The DDL of docs/DATA_MODEL.md section 2, verbatim. A test keeps the two identical.
export const SCHEMA_SQL = `
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  name          TEXT    NOT NULL,
  starts_at     INTEGER NOT NULL,
  capacity      INTEGER NOT NULL CHECK (capacity >= 0),
  sold          INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held          INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  queue_enabled INTEGER NOT NULL DEFAULT 0 CHECK (queue_enabled IN (0,1)),
  created_at    INTEGER NOT NULL,
  CHECK (sold + held <= capacity)
);

CREATE TABLE tiers (
  id             TEXT PRIMARY KEY,
  event_id       TEXT    NOT NULL REFERENCES events(id),
  name           TEXT    NOT NULL,
  price_cents    INTEGER NOT NULL CHECK (price_cents >= 0),
  capacity       INTEGER NOT NULL CHECK (capacity >= 0),
  sold           INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held           INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  max_per_order  INTEGER NOT NULL DEFAULT 6 CHECK (max_per_order >= 1),
  sale_starts_at INTEGER,
  sale_ends_at   INTEGER,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  CHECK (sold + held <= capacity)
);
CREATE INDEX idx_tiers_event ON tiers(event_id, position);

CREATE TABLE promo_codes (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id),
  code       TEXT NOT NULL,                 -- stored lowercase
  kind       TEXT NOT NULL CHECK (kind IN ('PERCENT','FIXED')),
  value      INTEGER NOT NULL CHECK (value > 0),   -- percent 1..100, or cents
  max_uses   INTEGER CHECK (max_uses IS NULL OR max_uses >= 1),
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  valid_from INTEGER,
  valid_to   INTEGER,
  tier_id    TEXT REFERENCES tiers(id),     -- NULL = applies to all tiers
  created_at INTEGER NOT NULL,
  UNIQUE (event_id, code),
  CHECK (max_uses IS NULL OR used <= max_uses),
  CHECK (kind <> 'PERCENT' OR value <= 100)
);

CREATE TABLE queue_entries (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,   -- arrival order
  id               TEXT NOT NULL UNIQUE,
  event_id         TEXT NOT NULL REFERENCES events(id),
  email            TEXT NOT NULL,
  email_norm       TEXT NOT NULL,
  queue_token      TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL CHECK (status IN ('WAITING','ADMITTED','USED','EXPIRED')),
  joined_at        INTEGER NOT NULL,
  admitted_at      INTEGER,
  admit_expires_at INTEGER,
  used_at          INTEGER
);
-- one live entry per buyer per event; USED/EXPIRED rows stay as history and a re-join adds a new row
CREATE UNIQUE INDEX uq_queue_live ON queue_entries(event_id, email_norm)
  WHERE status IN ('WAITING','ADMITTED');
CREATE INDEX idx_queue_order ON queue_entries(event_id, status, seq);

CREATE TABLE holds (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id),
  email          TEXT NOT NULL,
  email_norm     TEXT NOT NULL,
  token_hash     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ACTIVE','CONVERTED','EXPIRED','RELEASED')),
  quantity_total INTEGER NOT NULL CHECK (quantity_total >= 1),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
  promo_code_id  TEXT REFERENCES promo_codes(id),
  queue_entry_id TEXT REFERENCES queue_entries(id),
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  closed_at      INTEGER
);
CREATE INDEX idx_holds_due   ON holds(status, expires_at);
CREATE INDEX idx_holds_buyer ON holds(event_id, email_norm, status);

CREATE TABLE hold_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_id          TEXT NOT NULL REFERENCES holds(id),
  tier_id          TEXT NOT NULL REFERENCES tiers(id),
  quantity         INTEGER NOT NULL CHECK (quantity >= 1),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE INDEX idx_hold_items_hold ON hold_items(hold_id);

CREATE TABLE orders (
  id             TEXT PRIMARY KEY,
  hold_id        TEXT NOT NULL UNIQUE REFERENCES holds(id),
  event_id       TEXT NOT NULL REFERENCES events(id),
  email          TEXT NOT NULL,
  email_norm     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')),
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL,
  total_cents    INTEGER NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  promo_code_id  TEXT REFERENCES promo_codes(id),
  payment_ref    TEXT NOT NULL,
  paid_at        INTEGER NOT NULL,
  CHECK (refunded_cents <= total_cents)
);
CREATE INDEX idx_orders_buyer ON orders(event_id, email_norm);

CREATE TABLE tickets (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  event_id        TEXT NOT NULL REFERENCES events(id),
  tier_id         TEXT NOT NULL REFERENCES tiers(id),
  qr_token        TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('VALID','CHECKED_IN','VOID')),
  paid_cents      INTEGER NOT NULL CHECK (paid_cents >= 0),
  checked_in_at   INTEGER,
  checked_in_gate TEXT,
  voided_at       INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_tickets_order ON tickets(order_id);
CREATE INDEX idx_tickets_tier  ON tickets(tier_id, status);

CREATE TABLE scan_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  ticket_id TEXT,
  gate      TEXT,
  result    TEXT NOT NULL   -- ADMITTED | ALREADY_CHECKED_IN | TICKET_VOID | INVALID_QR
);
`;
