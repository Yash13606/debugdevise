# ARCHITECTURE

## 1. Stack (decided)
| Concern | Choice |
|---|---|
| Runtime | Node.js ≥ 22, TypeScript (strict) |
| HTTP | Fastify (built-in JSON-schema validation) |
| Database | SQLite via `better-sqlite3` (synchronous, WAL) |
| QR image (optional endpoint) | `qrcode` |
| Tests | `vitest`, requests through `app.inject()`; worker threads for the cross-connection test |
| Dev | `tsx` |
No Redis, no queue broker, no external services. One process, one database file.

Scripts: `dev` (`tsx watch src/index.ts`), `build` (type-check only: `tsc --noEmit`), `start` (`tsx src/index.ts`; no build step is needed to run), `test` (everything), `killer` (KT1, KT1-n, KT1-db, KT1-pool, KT2, KT3 only), `rush` (5,000-buyer simulation).

## 2. Layout
```
src/
  config.ts      env parsing with defaults (§6); throws on invalid values
  clock.ts       now() → Date.now(); overridable in tests
  db.ts          open DB, pragmas, run schema (DATA_MODEL §2), transaction helper
  schema.ts      the DDL of DATA_MODEL §2 as one string (a test keeps it identical to the document)
  ids.ts         randomId(prefix), randomToken(), sha256(), normaliseEmail()
  errors.ts      AppError(code, httpStatus, message, details)
  inventory.ts   ONLY module that changes tiers/events held|sold counters
  promo.ts       reserve / return promo usage, discount calculation
  payments.ts    mock provider, no network: charge(totalCents, reference, simulate) and refund(reference, cents)
  queue.ts       join, status, admit tick, consume admission
  holds.ts       createHold, releaseHold, expireDueHolds, payHold
  tickets.ts     checkIn, refund
  admin.ts       create event/tier/promo, patch event, stats + invariant check, manual sweep and queue tick
  http.ts        route table, auth hooks, error mapper
  index.ts       build app, start timers (sweeper, queue ticker), listen
test/  killer/*.test.ts  and  unit/*.test.ts   (helpers.ts: temp databases)
scripts/rush.ts
```
`inventory.ts` is the deep module: a small interface (`reserve`, `release`, `convert`, `returnSold`) hiding all counter SQL. No other module writes `held` or `sold`.

### 2a. How the components talk
```text
request ─► http.ts            auth headers, JSON-schema validation, error mapping. No SQL, no business rules.
             ├─► holds.ts     createHold · payHold · releaseHold · expireDueHolds
             │     ├─► queue.ts      consume admission            (inside createHold)
             │     ├─► promo.ts      reserve / return usage, discount maths
             │     ├─► payments.ts   charge                       (inside payHold)
             │     └─► inventory.ts  reserve · release · convert  (the only writer of held/sold)
             ├─► tickets.ts   checkIn · refund ─► inventory.ts (returnSold), payments.ts (refund), promo.ts
             ├─► queue.ts     join · status · tick
             └─► admin.ts     create event/tier/promo · patch event · stats + invariants · manual sweep/tick
every operation ─► db.ts      one BEGIN IMMEDIATE transaction per request
timers (index.ts): sweeper ─► holds.expireDueHolds      queue ticker ─► queue.tick
```
Rules: (1) `http.ts` contains no SQL; (2) no module imports `http.ts`; (3) only `holds.ts` and `tickets.ts` call `inventory.ts`; (4) `inventory.ts` imports only `db.ts` and `errors.ts`; (5) only the operations shown under `http.ts` open a transaction — `inventory.ts`, `promo.ts` and `payments.ts` are plain functions that run inside the caller's transaction; (6) tests may call any module directly against a test database.
Example, `pay`: `http.ts` → `holds.payHold` → inside one transaction: check the hold → `payments.charge` → `inventory.convert` → insert order and tickets → back to `http.ts`, which maps the result to JSON.

## 3. Concurrency model
- Every state change is **one transaction opened with `BEGIN IMMEDIATE`** (`db.transaction(fn).immediate()`), so writers are serialised by the database and a failed step rolls everything back.
- Correctness never depends on that serialisation alone: each guard is a **conditional UPDATE** whose number of changed rows decides the outcome (`changes() = 0` ⇒ lost). The same statements are correct on PostgreSQL under READ COMMITTED because row locks serialise conflicting updates (§8).
- A function that wants to commit a "refusal" (for example expiring a stale hold while answering `410`) **returns** an error object instead of throwing; throwing rolls back.
- Time: every function takes `now` from `clock.now()` once at the start of its transaction and uses that value throughout.

## 4. Core algorithms (exact)

### 4.1 reserve — create a hold  *(KT1, KT1-pool, the Fix)*
Input: `event_id, email, items[{tier_id, quantity}], promo_code?, queue_token?`.
```
BEGIN IMMEDIATE
 0. now = clock.now();  expireDueHolds(now)                       -- §4.2
 1. validate event exists; items non-empty; quantities ≥ 1; tier lines unique; each tier in this event
 2. per line: quantity ≤ tier.max_per_order else 422 MAX_PER_ORDER
 3. if event.queue_enabled: consume admission (§4.6) and remember the entry id (stored as holds.queue_entry_id) else 403 NOT_ADMITTED
 4. per-buyer cap (§4.7)                                          -- 409 BUYER_LIMIT
 5. promo (if given):
      UPDATE promo_codes SET used = used + 1
       WHERE event_id=:e AND code=:code_lower
         AND (max_uses IS NULL OR used < max_uses)
         AND (valid_from IS NULL OR valid_from <= :now) AND (valid_to IS NULL OR valid_to > :now)
      changes()=0 → 422 PROMO_INVALID, reason by re-reading the row:
         NOT_FOUND | NOT_STARTED | EXPIRED | EXHAUSTED
      if promo.tier_id is set and no line uses that tier → 422 PROMO_INVALID (NOT_APPLICABLE)
 6. for each line, in ascending tier_id order:
      UPDATE tiers SET held = held + :q
       WHERE id=:tier AND event_id=:e AND capacity - sold - held >= :q
         AND (sale_starts_at IS NULL OR sale_starts_at <= :now)
         AND (sale_ends_at   IS NULL OR sale_ends_at   >  :now)
      changes()=0 → re-read tier: sale window closed/not open → 409 SALE_NOT_OPEN
                    else 409 SOLD_OUT {scope:"tier", tier_id}
 7. UPDATE events SET held = held + :total
       WHERE id=:e AND capacity - sold - held >= :total
      changes()=0 → 409 SOLD_OUT {scope:"event"}                   -- the pooled check (the Fix)
 8. compute subtotal, discount (DATA_MODEL §5), total;
    INSERT holds (status ACTIVE, expires_at = now + HOLD_TTL_SECONDS*1000, token_hash), INSERT hold_items
COMMIT
```
Any `409/422/403` above is thrown, so the transaction rolls back and **nothing** (counters, promo use, admission) is consumed. Tier updates run in ascending id order before the event update, which is also the lock order to use on PostgreSQL.

### 4.2 expireDueHolds(now)  *(KT2)*
```
ids = SELECT id FROM holds WHERE status='ACTIVE' AND expires_at <= :now      -- idx_holds_due
for each id:  closeHold(id, 'EXPIRED', now)
```
`closeHold(id, newStatus, now)` is shared with release:
```
UPDATE holds SET status=:newStatus, closed_at=:now WHERE id=:id AND status='ACTIVE'
if changes()=1:
   for each hold_item: UPDATE tiers SET held = held - :q WHERE id=:tier
   UPDATE events SET held = held - :quantity_total WHERE id=:event
   if promo: UPDATE promo_codes SET used = used - 1 WHERE id=:promo AND used > 0
   if queue_entry: nothing (an entry is USED only when a hold succeeded; it stays USED)
```
Called: at the start of reserve, pay, availability reads (only when a due hold exists), by the sweeper every `HOLD_SWEEP_INTERVAL_MS`, and by release. The sweeper is an optimisation for reporting; **seats are freed by the next reserve even if the sweeper never runs.**

### 4.3 pay — convert a hold  *(KT2, KT3 setup; closes the hold→sold gap)*
```
BEGIN IMMEDIATE
 now = clock.now()
 h = SELECT * FROM holds WHERE id=:id            -- 404 if missing; token hash mismatch → 403 FORBIDDEN
 if h.status='CONVERTED' → return existing order (200, idempotent)
 if h.status = 'EXPIRED'  → 410 HOLD_EXPIRED
 if h.status = 'RELEASED' → 409 HOLD_NOT_ACTIVE
 if h.expires_at <= now:  closeHold(h.id,'EXPIRED',now);  RETURN error 410 HOLD_EXPIRED   -- returned, so it commits
 result = payments.charge(h.total_cents, reference)     -- mock provider; decline → throw 402 PAYMENT_FAILED (rollback, hold stays ACTIVE)
 UPDATE holds SET status='CONVERTED', closed_at=:now WHERE id=:id AND status='ACTIVE' AND expires_at > :now
 if changes()=0 → throw 409 HOLD_NOT_ACTIVE
 per item:  UPDATE tiers  SET held = held - :q, sold = sold + :q WHERE id=:tier AND held >= :q   (changes()=1 or throw 500)
 UPDATE events SET held = held - :total, sold = sold + :total WHERE id=:e AND held >= :total
 INSERT orders (PAID); INSERT one ticket per unit with qr_token = randomToken(), paid_cents per DATA_MODEL §5
COMMIT
```
`held + sold` is unchanged by the conversion, so the capacity invariant is never momentarily broken (contrast GAP-8).

### 4.4 release (buyer)
`closeHold(id,'RELEASED',now)` after token check; `changes()=0` → `409 HOLD_NOT_ACTIVE`.

### 4.5 check-in  *(KT3)*
```
BEGIN IMMEDIATE
 token = strip "AP1:" prefix (missing prefix → 404 INVALID_QR)
 UPDATE tickets SET status='CHECKED_IN', checked_in_at=:now, checked_in_gate=:gate
  WHERE qr_token=:token AND status='VALID'
 changes()=1 → log ADMITTED; return 200
 else t = SELECT … WHERE qr_token=:token
      none → log INVALID_QR; return 404
      CHECKED_IN → log ALREADY_CHECKED_IN; return 409 with first time and gate
      VOID → log TICKET_VOID; return 409
COMMIT   (logs are written in the same transaction; refusals are returned, not thrown)
```
The refund path uses the same guard (`status='VALID'`), so a scan and a refund racing for one ticket have exactly one winner.

### 4.6 waiting room  *(the Differentiator)*
- **Join** (`queue.join`): in one transaction, if a live entry (`WAITING`/`ADMITTED`) exists for `(event, email_norm)` return it unchanged (idempotent). Otherwise delete any `USED`/`EXPIRED` entry for that pair and insert a new `WAITING` entry (new `seq`, new `queue_token`). Joining an event with `queue_enabled = 0` → `409 QUEUE_NOT_ENABLED`.
- **Admit tick** every `QUEUE_TICK_MS` (and callable directly in tests), for each queue-enabled event:
```
UPDATE queue_entries SET status='EXPIRED' WHERE status='ADMITTED' AND admit_expires_at <= :now
active = SELECT COUNT(*) FROM queue_entries WHERE event_id=:e AND status='ADMITTED'
n = min(QUEUE_ADMIT_PER_TICK, QUEUE_MAX_ADMITTED - active)
if n > 0:
  UPDATE queue_entries SET status='ADMITTED', admitted_at=:now, admit_expires_at=:now + QUEUE_ADMIT_TTL_SECONDS*1000
   WHERE seq IN (SELECT seq FROM queue_entries WHERE event_id=:e AND status='WAITING' ORDER BY seq LIMIT :n)
```
  Order is strictly by `seq` (arrival): first in, first admitted.
- **Consume** (inside reserve step 3): 
```
UPDATE queue_entries SET status='USED', used_at=:now
 WHERE queue_token=:t AND event_id=:e AND status='ADMITTED' AND admit_expires_at > :now AND email_norm=:email_norm
changes()=0 → 403 NOT_ADMITTED {reason: WAITING | EXPIRED | EMAIL_MISMATCH | UNKNOWN_TOKEN}
```
  Because consume is inside the reservation transaction, a sold-out or invalid request rolls it back and the admission survives until its TTL.
- **Status** returns `status`, `position`, `ahead`, `eta_seconds = ceil(position / QUEUE_ADMIT_PER_TICK) * QUEUE_TICK_MS / 1000`, `admit_expires_at`, and `sold_out` (event available = 0).

### 4.7 per-buyer cap
Inside reserve, if `MAX_TICKETS_PER_BUYER > 0`:
```
used = (SELECT COALESCE(SUM(hi.quantity),0) FROM holds h JOIN hold_items hi ON hi.hold_id=h.id
         WHERE h.event_id=:e AND h.email_norm=:email_norm AND h.status='ACTIVE')
     + (SELECT COUNT(*) FROM tickets t JOIN orders o ON o.id=t.order_id
         WHERE t.event_id=:e AND o.email_norm=:email_norm AND t.status IN ('VALID','CHECKED_IN'))
if used + requested > MAX_TICKETS_PER_BUYER → 409 BUYER_LIMIT {limit, used, requested}
```
The single-writer transaction makes the read-then-insert safe. On PostgreSQL take `pg_advisory_xact_lock(hashtext(event_id || email_norm))` first.

### 4.8 refund
```
BEGIN IMMEDIATE
 order = SELECT …; 404 if missing
 targets = listed ticket_ids (each must belong to the order) or all tickets of the order
 if any target is CHECKED_IN → 409 TICKET_CHECKED_IN
 if any target is already VOID → 409 ALREADY_REFUNDED
 per target: UPDATE tickets SET status='VOID', voided_at=:now WHERE id=:id AND order_id=:o AND status='VALID'
   count changed rows; if changed ≠ targets.length → rollback, 409 TICKET_CHECKED_IN   (lost a race with a scan)
 per tier: UPDATE tiers SET sold = sold - :n WHERE id=:tier AND sold >= :n
 UPDATE events SET sold = sold - :total WHERE id=:e AND sold >= :total
 refund_cents = Σ paid_cents of voided tickets; payments.refund(order.payment_ref, refund_cents)   -- mock
 UPDATE orders SET refunded_cents = refunded_cents + :refund_cents, status = (all tickets VOID ? 'REFUNDED' : 'PARTIALLY_REFUNDED')
 if order now REFUNDED and promo: UPDATE promo_codes SET used = used - 1 WHERE id=:p AND used > 0
COMMIT
```

## 5. Security
- Admin endpoints require `x-admin-key` = `ADMIN_API_KEY`; the check-in endpoint requires `x-gate-key` = `GATE_API_KEY`. Compare in constant time. Missing/invalid → `401 UNAUTHORIZED`.
- Buyer endpoints on a hold or order require `x-hold-token` (hash compared to `token_hash`). Queue status requires `x-queue-token`.
- Keys and secrets come only from the environment. `.env` is never committed; `.env.example` lists every name with a placeholder.
- All SQL uses bound parameters. Request bodies are validated with JSON schema; unknown fields rejected.
- The application never reads an AI key; there is no AI dependency.

## 6. Configuration (`.env`; every value has a default; invalid values stop startup)
`.env` is read with Node's built-in `process.loadEnvFile()` when the file exists (no extra dependency); real environment variables take precedence; the application also runs with no `.env` at all, using the defaults below.
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/atomicpass.db` | SQLite file (`:memory:` allowed in tests) |
| `HOLD_TTL_SECONDS` | `600` | Hold lifetime in whole seconds (≥ 1); tests use `1`–`2` |
| `HOLD_SWEEP_INTERVAL_MS` | `5000` | Sweeper period (`0` disables; correctness unaffected) |
| `DEFAULT_MAX_PER_ORDER` | `6` | Default `max_per_order` for new tiers |
| `MAX_TICKETS_PER_BUYER` | `4` | Per-buyer cap per event (`0` = off) |
| `QUEUE_TICK_MS` | `2000` | Admission tick period (`0` disables the timer; tests call the tick directly) |
| `QUEUE_ADMIT_PER_TICK` | `25` | Entries admitted per tick |
| `QUEUE_MAX_ADMITTED` | `100` | Max unused admissions at once |
| `QUEUE_ADMIT_TTL_SECONDS` | `120` | Admission lifetime in whole seconds (≥ 1) |
| `ADMIN_API_KEY` | `change-me-admin` | Admin header value |
| `GATE_API_KEY` | `change-me-gate` | Gate header value |
| `PAYMENT_MODE` | `mock` | Only `mock` exists |
| `CURRENCY` | `INR` | Label returned in responses |
| `LOG_LEVEL` | `info` | Fastify logger level |

## 7. Testing strategy
- **Where:** `test/killer/` holds KT1, KT1-n, KT1-db, KT1-pool, KT2, KT3 (PRD §6); `test/unit/` the rest. Each test creates its own temp database file and config.
- **Parallelism:** `Promise.all` of `app.inject()` calls for HTTP-level races; `worker_threads` for KT1-db — each worker opens its **own** `better-sqlite3` connection to the same file, waits on a shared `Atomics` barrier, then calls `createHold`. The test passes only if exactly one worker succeeds.
- **Time:** KT2 uses `HOLD_TTL_SECONDS=1` and waits 1.5 s; unit tests may instead override `clock.now()`.
- **Invariants:** a helper runs the invariant check (DATA_MODEL §3) after each test.
- **Repeat:** race tests loop (≥ 20 iterations) to catch flakiness.

## 8. Performance and the ceiling
SQLite admits one writer at a time, so throughput is the speed of a short transaction on one machine; it has **not been benchmarked here** — use `npm run rush` to measure. The waiting room bounds the number of concurrent shoppers. For multi-node operation, move to PostgreSQL: the statements in §4 stay the same, row locks serialise conflicting updates, tier updates are taken in ascending id order then the event row, and the per-buyer cap takes an advisory lock.

## 9. Known design limits
- Real payment gateways are asynchronous; they need a `PAYING` hold state with a capped grace extension (GAPS GAP-7). Not implemented.
- The per-buyer cap keys on a normalised email (GAPS, Known limitations).
- Gate devices share one key.

## 10. How this differs from the original, and why
The original keeps no `held` counter, relies on time-filtered order rows plus a per-event lock, counts "sold" in a later step, and checks pooled capacity without holds under its lock (OBSERVATIONS CAP-2 … CAP-7). This design instead (a) keeps explicit `held`/`sold` counters on both tier and pool, guarded by conditional updates, (b) converts hold→sold in one step, (c) expires lazily inside every critical transaction and also by sweeper, (d) uses one check-in path with one conditional update, and (e) adds a waiting room and per-buyer cap in front of the reservation step.
