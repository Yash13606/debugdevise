# HACKBACK code review · DBG-462 · Rush-proof Event Ticketing
- Reviewed at: 2026-10-06T08:40:30Z (2026-10-06T14:10:30 IST)
- Judged commit: 1d5288c84242124e6db9ca1b00f059d7159302b7 (2026-10-06T13:26:17+05:30) · the last commit before the code freeze
- Reviewer: AI agent run by a HACKBACK judge

### DBG-462 · Rush-proof Event Ticketing
Commit: 1d5288c84242124e6db9ca1b00f059d7159302b7 · 2026-10-06T13:26:17+05:30 · Clean-room: OK

| Section | Score | Why (path:line) |
|---|---|---|
| A. Core flow | 30/30 | End-to-end functionality built and tested. Schema manages tier/pool capacity (`src/schema.ts:15`), holds execute with atomic deductions (`src/holds.ts:147`), validation applies limits (`src/holds.ts:181`), and mock checkout works (`src/holds.ts:276`). |
| B. Killer Tests | 30/30 | Last ticket race handled with atomic DB increments. Unpaid holds sweep based on `.env` TTL. QR scans atomically guard check-ins. |
| C. Two improvements | 20/20 | 1. Shared-pool capacity fixed with atomic DB updates (`src/inventory.ts:43`). 2. Waitlist & Buyer cap incorporated natively into the checkout flow (`src/queue.ts:51`, `src/holds.ts:122`). |
| D. Built from their docs | 10/10 | Strict adherence; `src/schema.ts` is exactly matching `docs/DATA_MODEL.md`. Improvements precisely mirror `docs/GAPS.md`. |
| E. Engineering | 10/10 | Extensive use of atomic operations. SQLite constraints applied universally (`src/schema.ts:12`). No client-side price trust (subtotals checked on server `src/holds.ts:191`). Cents used universally. |
| Total | 100/100 | |

Killer Tests:
1. READY · 10/10 · Atomic `UPDATE tiers SET held = held + ? WHERE id = ? AND sold + held + ? <= capacity` and SQLite CHECK constraint (`src/schema.ts:12`, `src/inventory.ts:20`), proven by `test/killer/kt1.test.ts`.
2. READY · 10/10 · Expiry logic inside `closeHold` explicitly executed lazily via `expireIfDue` and sweeping (`src/holds.ts:88`), proven by `test/killer/kt2.test.ts`.
3. READY · 10/10 · Single source of truth with atomic `UPDATE tickets SET status = 'CHECKED_IN' WHERE qr_token = ? AND status = 'VALID'` returning `changes === 1` (`src/tickets.ts:47`), proven by `test/killer/kt3.test.ts`.

Improvements:
1. GAP-1: Shared-pool capacity fix · 10/10 · Replaced pre-checks with authoritative constraints on both tier and event tables atomically within one transaction (`src/schema.ts:12`, `src/inventory.ts:43`).
2. GAP-2/3/4: Virtual waiting room + per-buyer cap · 10/10 · Built a queue system (`src/queue.ts:51`) and limits buyer across valid tickets and active holds (`src/holds.ts:122`), enforced atomically in `createHold`.

Flags: none.

3 questions for the judges to ask this team in their Defence, aimed at the weakest spots you found:
1. Your waiting room limits connections per buyer using a normalized email (`src/holds.ts:157`). How would you prevent a bot from generating thousands of aliases (e.g. `user+1@gmail.com`) to bypass the cap and drain the queue?
2. You successfully used SQLite for concurrent writes, but what limits did you hit with `better-sqlite3`'s single writer lock under max load, and how would this adapt to an async payment gateway without deadlocking?
3. The promo system correctly deducts usage atomically via `UPDATE promo_codes SET used = used + 1` (`src/promo.ts:23`). If an order is refunded, you return the use (`src/promo.ts:43`). How does this affect your max-usage limits if a promo expires before the refund occurs?

SCORE core=30 kt=30 imp=20 docs=10 eng=10 total=100
