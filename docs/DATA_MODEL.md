# DATA_MODEL

SQLite (WAL). All times are **epoch milliseconds (INTEGER, UTC)**. All money is **integer minor units** (`*_cents`). Booleans are 0/1.

## 1. Conventions
- **IDs:** `prefix_` + 12 random lowercase base32 characters (from `crypto.randomBytes`): `evt_`, `tier_`, `hold_`, `ord_`, `tkt_`, `promo_`, `que_`.
- **Secrets:** 128-bit random, base64url (22 chars): `hold_token`, `queue_token`, ticket `qr_token`. Hold tokens are stored as SHA-256 hex (`token_hash`); queue and QR tokens are stored in clear because they are looked up directly and are short-lived/revocable via status.
- **Email normalisation (N1):** trim, lowercase; remove everything from `+` in the local part; for `gmail.com` and `googlemail.com` also remove dots from the local part. Store as `email_norm`; keep the original as `email`.
- **Pragmas on open:** `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`.

## 2. Schema (DDL)

```sql
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
-- one live entry per buyer per event; USED/EXPIRED rows are replaced on re-join
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
```

## 3. Invariants (must hold after every committed transaction)

| ID | Statement |
|---|---|
| **I1** | For every tier: `sold + held ≤ capacity` (enforced by conditional UPDATE and the `CHECK`). |
| **I2** | For every event: `sold + held ≤ capacity` (the pool), same enforcement. |
| **I3** | `tier.held` = sum of `hold_items.quantity` over `ACTIVE` holds for that tier. `tier.sold` = number of tickets in that tier with status `VALID` or `CHECKED_IN`. `event.held` / `event.sold` = sums over its tiers. |
| **I4** | A ticket moves only along `VALID → CHECKED_IN` or `VALID → VOID`. Never back, never from `CHECKED_IN` to `VOID`. |
| **I5** | `promo.used` = number of `ACTIVE` holds using it + number of orders using it whose status is not `REFUNDED`. |
| **I6** | A hold leaves `ACTIVE` exactly once; counters for it are released or converted exactly once. |
| **I7** | At most one live (`WAITING`/`ADMITTED`) queue entry per `(event, email_norm)`. |

The admin stats endpoint recomputes I3 and I5 from rows and reports differences.

## 4. State machines

**Hold:** `ACTIVE → CONVERTED` (pay) · `ACTIVE → EXPIRED` (time) · `ACTIVE → RELEASED` (buyer). All other transitions are forbidden. Each is a conditional `UPDATE … WHERE status = 'ACTIVE'`; the number of rows changed decides who won.

**Ticket:** `VALID → CHECKED_IN` (scan) · `VALID → VOID` (refund).

**Order:** `PAID → PARTIALLY_REFUNDED → REFUNDED`, or `PAID → REFUNDED`.

**Queue entry:** `WAITING → ADMITTED → USED` · `ADMITTED → EXPIRED`.

## 5. Derived values
- Tier available = `min(tier.capacity − tier.sold − tier.held, event.capacity − event.sold − event.held)`, floored at 0.
- Queue position = `COUNT(*)` of `WAITING` entries for the event with `seq ≤ this.seq` (1 = next to be admitted).
- Ticket `paid_cents`: the order discount is spread over tickets in proportion to unit price using floor division; the remaining cents go one each to the first tickets in creation order, so the per-ticket values sum exactly to the order total.
- Discount: `PERCENT` → `floor(eligible_subtotal × value / 100)`; `FIXED` → `min(value, eligible_subtotal)`; eligible = lines for `promo.tier_id`, or all lines when null.
