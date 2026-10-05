# GAPS — weaknesses found in Hi.Events and what this rebuild does about them

Evidence references (CAP-, HOLD-, PAY-, CHK-, PROMO-, REF-, LIM-) point to `OBSERVATIONS.md`.
Severity is assessed for the target scenario: **5,000 passes released at one instant (6 PM), Tatkal-style.**
**Confidence:** *code-read* = established from cited lines; *analysis* = reasoned from cited lines, not reproduced.

## Decisions

| Slot | Choice | Why |
|---|---|---|
| **Fix (from this list)** | **GAP-1** — capacity must be enforced across tiers *and* the event-wide pool, counting holds, in one atomic step | It is the "never oversell" requirement at the point where Hi.Events is weakest, and it is demonstrable with a concurrency test |
| **Differentiator** (absent from Hi.Events entirely) | **Virtual waiting room + per-buyer ticket cap** | Targets the rush itself (GAP-2, GAP-3, GAP-4). Needs no AI, no external service |

Everything else below is either handled by the baseline design (no separate credit claimed) or recorded as a known, unaddressed limitation.

## The gaps

### GAP-1 — Shared-pool capacity ignores live holds in the authoritative check *(chosen fix)*
- **Evidence:** pool figure is `capacity − used` only (CAP-5: `backend/app/DomainObjects/CapacityAssignmentDomainObject.php:78-85`, folded in at `AvailableProductQuantitiesFetchService.php:75-83`); the locked check uses that figure (`CreateOrderHandler.php:187-221`); the only code subtracting holds from the pool is the *unlocked* pre-check (`OrderCreateRequestValidationService.php:722-731`, run at `CreateOrderActionPublic.php:44`); the pool counter is raised by an unguarded increment at completion (`ProductQuantityUpdateService.php:99-106`, CAP-6); the payment webhook does not re-check capacity (PAY-3).
- **Scenario (analysis):** A single event-wide pool of 5,000 seats is shared across Early, General, and VIP tiers, with only 1 seat remaining. Buyers A and B both pass the stale pre-check. Each also passes the locked check because A’s hold is not deducted from the shared pool. Both proceed with payment, causing the pool counter to reach 5,001.
- **Severity:** High. **Confidence:** analysis (not reproduced).
- **Rebuild:** every reservation raises `held` on the tier **and** on the event pool with conditional updates in one transaction; `sold + held ≤ capacity` holds on both at every instant (ARCHITECTURE §4.1, DATA_MODEL invariants I1–I2). A database `CHECK` constraint is a second line of defence. Test: `KT1-pool` in PRD §6.

### GAP-2 — One event-wide lock serialises all order creation; no queue in front
- **Evidence:** CAP-2, CAP-3 — the critical section covers event/settings load, session-order deletion, promo query, several availability queries, order and item inserts, pricing, totals.
- **Impact (analysis):** 5,000 simultaneous creates queue behind one lock; each waiter holds a DB connection; latency and timeouts grow with the length of the critical section.
- **Severity:** High. **Confidence:** lock = code-read; impact = analysis.
- **Rebuild:** critical section reduced to a few conditional `UPDATE`s plus two inserts; admission to that section is metered by the **waiting room** (differentiator).

### GAP-3 — No anti-hoarding: only a per-order cap
- **Evidence:** LIM-2; default maximum 100 per order (CAP-1, `OrderCreateRequestValidationService.php:489`); holds last up to the timeout (HOLD-2); the browser session is a cookie (`CreateOrderActionPublic.php:45,77-79`) and only same-session orders are cleaned up (HOLD-7).
- **Impact (analysis):** a script that discards cookies can hold most of the inventory for the whole timeout; combined with the default order rate (LIM-1) the arithmetic upper bound is 60 orders × up to 100 tickets per minute per IP (untested).
- **Severity:** High. **Confidence:** analysis.
- **Rebuild:** per-buyer cap (`MAX_TICKETS_PER_BUYER`) counted over active holds and valid tickets, checked inside the reservation transaction; one admission = one hold (differentiator). Limitation: keyed by normalised email, so a determined buyer with many mailboxes is not stopped (see Known limitations).

### GAP-4 — Per-IP order throttle collides with campus NAT
- **Evidence:** LIM-1 — 60/min per IP, keyed by IP only.
- **Impact (analysis):** thousands of students behind a few campus IPs share one budget; legitimate buyers receive 429s.
- **Severity:** Medium. **Confidence:** config = code-read; impact = analysis.
- **Rebuild:** fairness comes from the queue (FIFO by arrival), not from IP throttling.

### GAP-5 — Hold expiry is silent
- **Evidence:** HOLD-4, HOLD-5, HOLD-7.
- **Impact:** seats are correctly free in queries, but rows stay `RESERVED`, no event fires, and waitlisted users are not offered a freed seat until an unrelated capacity event occurs.
- **Severity:** Medium. **Confidence:** code-read (absence verified by search).
- **Rebuild (baseline):** expiry runs both lazily inside every reservation/payment transaction and in a periodic sweeper; each expiry moves the hold to `EXPIRED` and releases counters in the same transaction.

### GAP-6 — Admin check-in endpoint is read-then-write; two disjoint sources of truth
- **Evidence:** CHK-3, CHK-4 versus CHK-2.
- **Impact:** simultaneous requests both succeed, or one attendee is admitted once per path.
- **Severity:** Medium (API level). **Confidence:** code = code-read; outcome = analysis.
- **Rebuild (baseline):** one check-in path, one conditional update on the ticket row (`status = VALID → CHECKED_IN`), one source of truth.

### GAP-7 — Late payment is charged and then refunded; hold not extended when payment starts
- **Evidence:** HOLD-8, PAY-4.
- **Impact:** a buyer who starts paying near expiry (3-D Secure / UPI delay) is charged, refused, then refunded.
- **Severity:** Medium. **Confidence:** code-read.
- **Rebuild:** with the synchronous mock payment provider the expiry check, the "charge" and the hold→sold conversion happen in one transaction, so a charge cannot follow expiry. **Not solved for real asynchronous gateways:** that would need a `PAYING` hold state with a capped grace window (noted in ARCHITECTURE §9).

### GAP-8 — Hold→sold conversion is not atomic with capacity; webhook uses a different lock
- **Evidence:** CAP-7, PAY-3 (order lock vs event lock).
- **Scenario (analysis):** if a hold's expiry falls *inside* the webhook transaction and a newcomer reserves the same last seat in that window, both can complete — oversell by one.
- **Severity:** Low–Medium. **Confidence:** analysis only.
- **Rebuild:** conversion moves quantity from `held` to `sold` in the same statements and transaction as the status change, so `held + sold` never changes (ARCHITECTURE §4.3).

### GAP-9 — Promo silently dropped when exhausted
- **Evidence:** PROMO-3.
- **Impact:** buyer previewed a discount; the last use was taken in between; the order is created at full price with no error.
- **Severity:** Low–Medium. **Confidence:** code-read.
- **Rebuild (baseline):** an invalid or exhausted code fails the request with `422 PROMO_INVALID` and a reason; usage is counted atomically at reservation and returned on expiry, release and full refund.

### GAP-10 — Order cancel is not serialised
- **Evidence:** REF-1 (no lock), clamp at zero (CAP-6).
- **Impact (analysis):** a concurrent double-cancel could lower the sold counter twice; the clamp hides it.
- **Severity:** Low. **Confidence:** analysis.
- **Rebuild (baseline):** refund is a conditional update on each ticket (`VALID → VOID`); the counter is lowered only by the number of rows actually changed.

### GAP-11 — QR is an unsigned, upper-cased 7-character id
- **Evidence:** CHK-1; scanner endpoints authorised only by the list id (CHK-2).
- **Impact:** guessable only by brute force (36⁷ ≈ 7.8×10¹⁰ combinations after upper-casing), but there is no tamper detection and no per-ticket secrecy beyond that.
- **Severity:** Low. **Confidence:** code-read.
- **Rebuild:** 128-bit random token per ticket (unguessable) with a unique index, plus a gate API key on the check-in endpoint. No signature scheme.

### GAP-12 — Hold timeout is whole minutes (minimum 1); public availability cache up to 2 s
- **Evidence:** HOLD-2, CAP-8.
- **Impact:** slow to demonstrate expiry; briefly stale "available" display.
- **Severity:** Low. **Confidence:** code-read.
- **Rebuild:** timeouts in seconds from `.env`; availability is never cached.

## Things that are *not* gaps (do not claim)
Locking exists (CAP-2). Late payments are handled rather than ignored (PAY-4). The scanner check-in path is database-enforced (CHK-2). The promo limit is race-safe at order creation (PROMO-2). Per-tier counting is correct inside the lock (CAP-3, CAP-4).

## Known limitations of this rebuild
- SQLite serialises writers; a single node is the ceiling (ARCHITECTURE §8).
- The per-buyer cap keys on a normalised email; many mailboxes defeat it. A device or payment-instrument signal would be the next step.
- Payments are a mock provider; asynchronous gateways need the `PAYING` state (GAP-7).
- No email delivery, seat maps, invoices or multi-currency.
