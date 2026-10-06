-- AtomicPass Live schema (PostgreSQL). Times are epoch milliseconds (BIGINT), money is paise (INTEGER).
-- Every counter has a CHECK, so the database refuses an oversell even if application code is wrong.

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'BUYER' CHECK (role IN ('BUYER', 'ORGANISER')),
  org_name   TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE otp_codes (
  phone      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  organiser_id  TEXT REFERENCES users(id),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'Music',
  city          TEXT NOT NULL DEFAULT 'Bengaluru',
  venue         TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  banner        TEXT NOT NULL DEFAULT '#0b6e6e,#12232b',
  status        TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED')),
  starts_at     BIGINT NOT NULL,
  capacity      INTEGER NOT NULL CHECK (capacity >= 0),
  sold          INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held          INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  queue_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    BIGINT NOT NULL,
  CHECK (sold + held <= capacity)
);
CREATE INDEX idx_events_listing ON events(status, city, starts_at);
CREATE INDEX idx_events_organiser ON events(organiser_id);

CREATE TABLE tiers (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id),
  name           TEXT NOT NULL,
  price_paise    INTEGER NOT NULL CHECK (price_paise >= 0),
  capacity       INTEGER NOT NULL CHECK (capacity >= 0),
  sold           INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held           INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  max_per_order  INTEGER NOT NULL DEFAULT 6 CHECK (max_per_order >= 1),
  seated         BOOLEAN NOT NULL DEFAULT FALSE,
  sale_starts_at BIGINT,
  sale_ends_at   BIGINT,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     BIGINT NOT NULL,
  CHECK (sold + held <= capacity)
);
CREATE INDEX idx_tiers_event ON tiers(event_id, position);

-- Reserved seating: one row per seat. A seat is taken by a conditional UPDATE (AVAILABLE -> HELD).
CREATE TABLE seats (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(id),
  tier_id   TEXT NOT NULL REFERENCES tiers(id),
  row_label TEXT NOT NULL,
  seat_no   INTEGER NOT NULL,
  status    TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'HELD', 'SOLD')),
  hold_id   TEXT,
  UNIQUE (tier_id, row_label, seat_no),
  CHECK ((status = 'AVAILABLE') = (hold_id IS NULL))
);
CREATE INDEX idx_seats_tier ON seats(tier_id, status);
CREATE INDEX idx_seats_hold ON seats(hold_id) WHERE hold_id IS NOT NULL;

CREATE TABLE promo_codes (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id),
  code       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('PERCENT', 'FIXED')),
  value      INTEGER NOT NULL CHECK (value > 0),
  max_uses   INTEGER CHECK (max_uses IS NULL OR max_uses >= 1),
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  valid_from BIGINT,
  valid_to   BIGINT,
  tier_id    TEXT REFERENCES tiers(id),
  created_at BIGINT NOT NULL,
  UNIQUE (event_id, code),
  CHECK (max_uses IS NULL OR used <= max_uses),
  CHECK (kind <> 'PERCENT' OR value <= 100)
);

CREATE TABLE queue_entries (
  seq              BIGSERIAL PRIMARY KEY,
  id               TEXT NOT NULL UNIQUE,
  event_id         TEXT NOT NULL REFERENCES events(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL CHECK (status IN ('WAITING', 'ADMITTED', 'USED', 'EXPIRED')),
  joined_at        BIGINT NOT NULL,
  admitted_at      BIGINT,
  admit_expires_at BIGINT,
  used_at          BIGINT
);
CREATE UNIQUE INDEX uq_queue_live ON queue_entries(event_id, user_id) WHERE status IN ('WAITING', 'ADMITTED');
CREATE INDEX idx_queue_order ON queue_entries(event_id, status, seq);

CREATE TABLE holds (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAYING', 'CONVERTED', 'EXPIRED', 'RELEASED')),
  quantity_total INTEGER NOT NULL CHECK (quantity_total >= 1),
  subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  total_paise    INTEGER NOT NULL CHECK (total_paise >= 0),
  promo_code_id  TEXT REFERENCES promo_codes(id),
  queue_entry_id TEXT REFERENCES queue_entries(id),
  created_at     BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL,
  pay_started_at BIGINT,
  closed_at      BIGINT
);
CREATE INDEX idx_holds_due   ON holds(expires_at) WHERE status IN ('ACTIVE', 'PAYING');
CREATE INDEX idx_holds_user  ON holds(user_id, status);
CREATE INDEX idx_holds_event ON holds(event_id, user_id, status);

CREATE TABLE hold_items (
  id               BIGSERIAL PRIMARY KEY,
  hold_id          TEXT NOT NULL REFERENCES holds(id),
  tier_id          TEXT NOT NULL REFERENCES tiers(id),
  quantity         INTEGER NOT NULL CHECK (quantity >= 1),
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0)
);
CREATE INDEX idx_hold_items_hold ON hold_items(hold_id);

CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  hold_id           TEXT NOT NULL REFERENCES holds(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL,
  provider_order_id TEXT NOT NULL UNIQUE,
  amount_paise      INTEGER NOT NULL CHECK (amount_paise >= 0),
  status            TEXT NOT NULL CHECK (status IN ('CREATED', 'SUCCESS', 'FAILED', 'LATE_REFUNDED')),
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);
CREATE INDEX idx_payments_hold ON payments(hold_id);
CREATE INDEX idx_payments_open ON payments(created_at) WHERE status = 'CREATED';

-- Every message from the payment gateway, stored once. The primary key makes redelivery harmless.
CREATE TABLE webhook_events (
  event_id     TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  BIGINT NOT NULL
);

CREATE TABLE orders (
  id             TEXT PRIMARY KEY,
  hold_id        TEXT NOT NULL UNIQUE REFERENCES holds(id),
  payment_id     TEXT NOT NULL REFERENCES payments(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  event_id       TEXT NOT NULL REFERENCES events(id),
  status         TEXT NOT NULL CHECK (status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')),
  subtotal_paise INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL,
  total_paise    INTEGER NOT NULL,
  refunded_paise INTEGER NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  promo_code_id  TEXT REFERENCES promo_codes(id),
  paid_at        BIGINT NOT NULL,
  CHECK (refunded_paise <= total_paise)
);
CREATE INDEX idx_orders_user ON orders(user_id, paid_at DESC);
CREATE INDEX idx_orders_event ON orders(event_id);

CREATE TABLE tickets (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  event_id        TEXT NOT NULL REFERENCES events(id),
  tier_id         TEXT NOT NULL REFERENCES tiers(id),
  seat_id         TEXT REFERENCES seats(id),
  qr_token        TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('VALID', 'CHECKED_IN', 'VOID')),
  paid_paise      INTEGER NOT NULL CHECK (paid_paise >= 0),
  checked_in_at   BIGINT,
  checked_in_gate TEXT,
  checked_in_by   TEXT,
  voided_at       BIGINT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX idx_tickets_order ON tickets(order_id);
CREATE INDEX idx_tickets_tier  ON tickets(tier_id, status);
CREATE INDEX idx_tickets_event ON tickets(event_id, status);

CREATE TABLE refunds (
  id           TEXT PRIMARY KEY,
  order_id     TEXT REFERENCES orders(id),
  payment_id   TEXT NOT NULL REFERENCES payments(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  kind         TEXT NOT NULL CHECK (kind IN ('BUYER_CANCEL', 'ORGANISER', 'LATE_PAYMENT')),
  -- PENDING = we owe the money back and the gateway has not confirmed yet; a worker finishes it, retrying until DONE.
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
  provider_ref TEXT,
  created_at   BIGINT NOT NULL,
  done_at      BIGINT
);
CREATE INDEX idx_refunds_payment ON refunds(payment_id);
CREATE INDEX idx_refunds_pending ON refunds(created_at) WHERE status = 'PENDING';

CREATE TABLE scan_log (
  id         BIGSERIAL PRIMARY KEY,
  at         BIGINT NOT NULL,
  ticket_id  TEXT,
  event_id   TEXT,
  gate       TEXT,
  scanned_by TEXT,
  result     TEXT NOT NULL
);
CREATE INDEX idx_scan_event ON scan_log(event_id, id DESC);

CREATE TABLE event_staff (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id  TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (event_id, user_id)
);

-- Messages to send (OTP, ticket confirmation). A worker delivers them; in the demo they are shown in an inbox.
CREATE TABLE outbox (
  id         BIGSERIAL PRIMARY KEY,
  phone      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT')),
  created_at BIGINT NOT NULL,
  sent_at    BIGINT
);
CREATE INDEX idx_outbox_phone ON outbox(phone, id DESC);
CREATE INDEX idx_outbox_pending ON outbox(id) WHERE status = 'PENDING';

-- The simulated payment gateway's own books. Reconciliation compares our records against these.
CREATE TABLE sim_gateway_orders (
  provider_order_id TEXT PRIMARY KEY,
  amount_paise      INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('CREATED', 'PAID', 'FAILED')),
  refunded_paise    INTEGER NOT NULL DEFAULT 0,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);

CREATE TABLE sim_gateway_refunds (
  refund_id         TEXT PRIMARY KEY,
  provider_order_id TEXT NOT NULL REFERENCES sim_gateway_orders(provider_order_id),
  amount_paise      INTEGER NOT NULL,
  created_at        BIGINT NOT NULL
);

CREATE TABLE reconciliation_issues (
  id          BIGSERIAL PRIMARY KEY,
  payment_id  TEXT,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);
