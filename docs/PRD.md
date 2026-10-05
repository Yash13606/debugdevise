# PRD — AtomicPass: concurrency-safe, rush-proof event ticketing

## 1. Problem
A college fest releases **5,000 passes at 6 PM**. About 5,000 students press *Buy* in the same second. The system must:
1. **never oversell** — not by one ticket, not across tiers, not under concurrency;
2. **free seats from unpaid checkouts** so they can be bought by others;
3. **admit each pass into the venue exactly once.**

## 2. Users
| User | Needs |
|---|---|
| **Buyer** (student) | Fair chance to buy; a hold that lasts long enough to pay; a QR ticket |
| **Organiser** | Create event, tiers, promo codes; see sales; refund |
| **Gate staff** | Scan a QR; get a clear *admitted / already used / refunded / invalid* answer in under a second |

## 3. Goals and non-goals
**Goals:** correctness under concurrency; time limits configurable in seconds; simple to run (one process, one file database); every rule testable.
**Non-goals:** real payment gateway, email/SMS delivery, seat maps, invoices, multi-currency, multi-node deployment, user accounts.

## 4. Core flow (build in this order)
`create event + tier` → `availability` → `hold` → `pay` → `ticket + QR` → `check-in` (twice → second refused) → `hold expiry frees seat` → `refund returns capacity`.
Then promo codes, then the two improvements (§7).

## 5. Functional requirements and acceptance criteria

**FR-1 Events and tiers (admin).** An event has a total `capacity` (the pool). A tier has its own `capacity`, `price_cents`, optional sale window and `max_per_order`. Tier capacities may add up to more than the event capacity.
*Accept:* creating a tier with `capacity > 0` and a price ≥ 0 succeeds; invalid input → `400 VALIDATION_ERROR`.

**FR-2 Availability.** Tier available = `min(tier.capacity − sold − held, event.capacity − sold − held)`, never negative. Always computed fresh, never cached.
*Accept:* after a 2-ticket hold on a 10-ticket tier, available is 8.

**FR-3 Hold.** A buyer reserves one or more tier lines. Success returns a hold with an expiry and a secret `hold_token`. Quantities are taken from the tier **and** the event pool atomically, or not at all.
*Accept:* `409 SOLD_OUT` (with `details.scope` = `tier` or `event`) when either would be exceeded; `422 MAX_PER_ORDER`; `409 SALE_NOT_OPEN`.

**FR-4 Hold expiry.** An `ACTIVE` hold older than `HOLD_TTL_SECONDS` becomes `EXPIRED` and its quantities return to the tier and the pool. Expiry runs lazily inside every reservation, payment and availability read, and also in a periodic sweeper; correctness must not depend on the sweeper.
*Accept:* with `HOLD_TTL_SECONDS=2`, a seat held and not paid is purchasable by another buyer after 2 s; paying the expired hold returns `410 HOLD_EXPIRED`.

**FR-5 Pay.** Paying an `ACTIVE`, unexpired hold converts it into a `PAID` order with one ticket per unit, moving quantity from `held` to `sold` in the same transaction. A declined payment leaves the hold `ACTIVE`. Paying twice returns the same order.
*Accept:* `201` with order and tickets; `402 PAYMENT_FAILED` on decline; `409 HOLD_NOT_ACTIVE` if released.

**FR-6 Release.** A buyer can release their own active hold with the token.
*Accept:* capacity returns immediately; promo use returns.

**FR-7 Promo codes.** `PERCENT` or `FIXED`, optional `max_uses`, optional validity window, optional single-tier restriction. Usage is counted atomically at hold time and returned on expiry, release and full refund. An invalid, expired or exhausted code **fails the request** with `422 PROMO_INVALID` and a `reason`; it is never silently ignored.
*Accept:* with `max_uses = 1`, two concurrent holds using the code → exactly one succeeds.

**FR-8 Tickets and QR.** Each ticket has a unique 128-bit random `qr_token`; the QR payload is `AP1:` + token.
*Accept:* tokens are unique; two tickets never share a token.

**FR-9 Check-in (gate).** Admits a ticket exactly once.
*Accept:* first scan `200 ADMITTED`; second scan `409 ALREADY_CHECKED_IN` (with first scan time and gate); unknown code `404 INVALID_QR`; refunded ticket `409 TICKET_VOID`. Two simultaneous scans of the same code → exactly one `200`.

**FR-10 Refund (admin).** Whole order or listed tickets. Refunded tickets become `VOID`; `sold` falls on tier and pool; a full refund returns the promo use. A ticket that is already `CHECKED_IN` cannot be refunded.
*Accept:* capacity returns; the voided QR is refused at the gate; a second refund of the same ticket → `409 ALREADY_REFUNDED`. A refund and a scan racing for the same ticket → exactly one wins.

**FR-11 Waiting room (differentiator).** When an event has the queue enabled, buyers must join a first-come-first-served queue and be admitted before they can create a hold. See §7.

**FR-12 Per-buyer cap (differentiator).** A buyer (normalised email) may hold or own at most `MAX_TICKETS_PER_BUYER` tickets per event.

**FR-13 Admin stats.** Per-tier and pool `capacity / sold / held / available`, tickets by status, queue sizes, and an **invariant check** that recomputes counters from rows and reports mismatches.

**FR-14 Configuration.** Every time limit and rate is an environment variable with a default (see ARCHITECTURE §6). The application runs with the defaults and **without any AI or third-party key**.

## 6. Acceptance tests (must exist and pass; run with `npm run killer` and `npm test`)

| ID | Scenario | Expected |
|---|---|---|
| **KT1** | Tier capacity 1. Two buyers request 1 ticket at the same moment (parallel requests). | Exactly one `201`; the other `409 SOLD_OUT`; tier `held = 1`, event `held = 1` |
| KT1-n | Capacity 10, 50 parallel buyers, repeat 20 times. | Exactly 10 successes every run; `sold + held = 10` |
| KT1-db | Two worker threads, **separate DB connections**, released together by a barrier, last ticket. | Exactly one success |
| **KT1-pool** *(the fix)* | Tiers A (cap 5) and B (cap 5), event cap 5; 10 parallel holds of 1 spread over A and B. | Exactly 5 succeed; event `held = 5`; neither tier exceeds its cap |
| **KT2** | `HOLD_TTL_SECONDS=1`. Buyer 1 holds the last seat; buyer 2 gets `409`; wait 1.5 s; buyer 2 retries. | Buyer 2 gets `201`; hold 1 is `EXPIRED`; paying hold 1 → `410` |
| KT2-paid | A paid hold is never expired. | Order and tickets remain; capacity not released |
| **KT3** | Pay, then scan the QR twice; then twenty parallel scans of a new ticket. | `200` then `409`; exactly one `200` among twenty |
| KT3-void | Refund then scan. | `409 TICKET_VOID` |
| P-1 | Promo `max_uses = 1`, two parallel holds. | One success, one `422 PROMO_INVALID (EXHAUSTED)` |
| P-2 | Expire/release/refund a promo hold. | `used` decreases; code usable again |
| R-1 | Full refund of a 3-ticket order. | `sold` falls by 3 on tier and pool; order `REFUNDED` |
| Q-1 | Queue on; 10 join in order; admit 3 per tick. | First 3 admitted in join order; 4th gets `403 NOT_ADMITTED` on hold |
| Q-2 | Join twice with the same email. | Same entry returned |
| B-1 | `MAX_TICKETS_PER_BUYER = 4`; email `a+x@g.com` then `a@g.com` ask 3 + 2. | Second request `409 BUYER_LIMIT` |
| I-1 | After any test, run the invariant check. | No mismatches |

A rush simulation script (`scripts/rush.ts`) fires 5,000 parallel hold requests at one tier of capacity 5,000 − k and prints successes, sold-outs, and the invariant check. The default is k = 500 (4,500 seats); `npm run rush -- --buyers N --capacity C` overrides both numbers. It runs in one process against a temporary database, sending the requests through the HTTP stack without a network. Its result is informational, not an acceptance gate.

## 7. The two improvements

### 7.1 Fix (from GAPS): pooled, hold-aware, atomic capacity — GAP-1
Capacity is enforced on the tier **and** the event pool in one atomic step that counts holds as well as sales, so `sold + held ≤ capacity` is true on both at every instant, including across tiers that share the pool. A database `CHECK` constraint backs it up. Proven by KT1-pool.

### 7.2 Differentiator (absent from Hi.Events): waiting room + per-buyer cap — GAP-2, GAP-3, GAP-4
- **Join:** `POST /api/events/:id/queue` with an email → queue entry (FIFO by arrival), secret `queue_token`, position.
- **Poll:** `GET /api/events/:id/queue` → position, ahead, rough ETA, and, once admitted, the admission window.
- **Admit:** a ticker admits the next waiting entries every `QUEUE_TICK_MS`, at most `QUEUE_ADMIT_PER_TICK` per tick and never more than `QUEUE_MAX_ADMITTED` unused admissions at once. An admission lasts `QUEUE_ADMIT_TTL_SECONDS`.
- **Use:** the hold request carries `x-queue-token`; a successful hold consumes the admission. The hold's email must match the entry's email.
- **Cap:** `MAX_TICKETS_PER_BUYER` per normalised email, counted over active holds and valid tickets, enforced inside the reservation transaction.
- **Why it helps:** it meters entry into the short critical section instead of letting 5,000 requests contend, it is fair by arrival order independent of IP, and it blocks one buyer from hoarding.
- **No AI involved.**

## 8. Non-functional requirements
- **Correctness first:** the invariants in DATA_MODEL §3 hold after every operation, including failed ones.
- **Latency:** reserve and check-in are single short transactions.
- **Operability:** one process, one SQLite file, `.env` configuration, `GET /health`.
- **Testability:** all durations are seconds (or milliseconds) from the environment; the clock is injectable.

## 9. Assumptions and out of scope
Single currency; amounts are integers in minor units. One event pool per event. Payment provider is a deterministic mock. Gate devices are trusted with a shared key. Multi-node operation would need the same statements on PostgreSQL (ARCHITECTURE §8).

## 10. Glossary
**Hold** — temporary reservation of quantity, expires. **Pool** — the event-wide capacity shared by all tiers. **Held / sold** — counters on tier and event. **Admission** — right, granted by the queue, to create one hold. **QR payload** — `AP1:` + ticket token.
