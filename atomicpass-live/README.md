# AtomicPass Live

The next level of AtomicPass: the same all-or-nothing ticketing rules, rebuilt on PostgreSQL so they can run on several servers, with phone login, a catalogue, reserved seating, a waiting room, a Redis-style fast gate, an asynchronous payment flow, organiser and gate tools, and a web app for buyers, organisers and gate staff.

This folder sits inside the `debugdevise` repository next to the submitted app, which it does not change. It has its own `package.json`; run everything below from inside this folder.

## Run it

Needs Node 22.12 or newer. No database to install: with no `DATABASE_URL` it starts a real PostgreSQL from an npm package into `.data/pg`.

```
cd atomicpass-live
npm install
npm run web:build  # installs and builds the web app into web/dist
npm start          # http://localhost:3100  (seeds demo events on first run)
npm test           # 111 tests against a real PostgreSQL
npm run load       # 5,000-buyer rush against the running server (start it with RATE_LIMIT=false)
```

The server registers the web app's files when it starts, so restart it after each `web:build`. For front-end work run the API (`npm start`) and `npm run dev:web` (Vite on :5173, proxying `/api`).

Demo logins use a random 6-digit code that the API returns in the response (`DEMO_OTP=true`, the default) and also shows under Messages. Organiser demo account: phone `9000000001`.

## The web app

React + Vite + TypeScript in `web/`, served by the same server. Fonts and icons are bundled, so it works with no internet.

| Screen | What it does |
|---|---|
| Events | Search, city, category tabs; each event is a flat colour poster led by its date. |
| Event | Tickets, reserved-seat map, promo code, the waiting room (a small proof-of-work challenge, then a live place in line), a sticky buy bar on phones. |
| Checkout | A hold timer, then a simulated bank whose choices show how the system copes: approve, decline, late confirmation, duplicate message. |
| My tickets | Each ticket is a stub with a tear line and a signed QR code; cancel with an in-place confirmation. |
| Messages | Everything the demo would have texted: login codes, confirmations, hold reminders, waitlist news. |
| Organiser | Create events with a live poster preview; a dashboard with the audit, a 30-minute timeline, tickets and promo codes, the gate team with a scan report, and a settlement preview. |
| Gate | Camera scanning, typed or hardware-scanner codes, instant verdicts, and offline checking with the public key plus a sync when the network returns. |

Visual system: warm cream canvas, weight-300 display type, 4px corners, flat surfaces (no shadows, no gradients), mono labels, one violet accent used for focus and selection. Motion answers an action or marks a state change; the gate verdict has none, and everything honours `prefers-reduced-motion`. Light theme only.

## What the backend does

| Area | What it does |
|---|---|
| Rules | Every rule is one guarded `UPDATE`; the changed-row count decides. Counters also have `CHECK` constraints. Locks are always taken in the same order (tiers, event, seats). |
| Login | Phone + random OTP, 5 tries, expiry, rate limits, hashed storage, bearer sessions. |
| Catalogue | Events by city, category and search; tiers; availability. |
| Seating | General tiers and reserved seats (`rows x seats_per_row`); a seat is taken by `AVAILABLE -> HELD`. |
| Waiting room | First come, first served, paced by seats left, signed passes checked without the database, live updates over server-sent events, a proof-of-work challenge at join. |
| Fast gate | Redis counters that turn away obvious losers before the database. The database stays the judge. Fails open if Redis is down. |
| Payments | `PAYING` state, signed idempotent webhooks, money-after-timeout rule, refunds for late payments, reconciliation, retrying refunds. **The gateway is simulated.** |
| Tickets | Signed (Ed25519) QR codes: a gate holding only the public key can tell a forged ticket from a real one with no network. Offline scans sync later with the time they were made; a ticket two offline devices both admitted is found, not hidden. |
| Organiser / gate | Create events, tiers, promo codes; add and remove gate staff by phone (removal bites on the very next scan); dashboard with the audit; illustrative settlement. |
| Messages | Hold-expiry reminders (once per hold) and a waitlist that tells waiting buyers when seats free up. |
| Operations | `/healthz`, `/readyz`, `/metrics` (Prometheus text), invariant audit at `/api/admin/invariants`. |

## How it was checked

- 111 backend tests pass; 5 more (a contract test for a real Redis) are skipped unless `REDIS_URL` is set.
- The audit (`server/src/invariants.ts`) recomputes every counter from the records after every test.
- Safeguards were removed one at a time to confirm tests fail: the buyer-limit lock, the scan guard, webhook de-duplication, the tier guard, the event-pool guard and the seat guard. The first pass caught only some; two gaps in the tests were found and fixed (the Redis gate was hiding the database guards, so the concurrency suite now also runs with the gate off).
- Two real server processes on one database: 200 buyers for 50 seats gives exactly 50; one ticket scanned at both gives exactly one entry.
- The web app was walked through in headless Chrome: sign in, book and pay, free events, seat picking, the waiting room, the organiser dashboard and event creation, gate scans online and offline with sync, phone width (390 px), and reduced motion. 19 steps passed with no browser errors, and axe-core reported no findings on the main screens. That walkthrough script is not in this repository.
- **Not checked:** a real phone camera (the QR decoding path ran only on typed codes), Safari and Firefox, and screen readers.

## Measured, and what that does not show

Rush of 5,000 buyers for 4,500 seats, then every winner paid (one Windows laptop, local PostgreSQL, one server process):

- Correct: 4,500 holds, 500 refused, 4,500 paid, 0 oversold, audit clean.
- **Slow**: the hold rush took 186 s (27 requests per second sustained, median latency 16 s). Paying took 58 s (78 per second).
- In-process, without HTTP, the same hold path ran at about 385 per second on one hot event, so the gap is not explained by the hold logic alone. Time spent waiting for the lock on the one hot counter row was measured at hundreds of milliseconds under load. The cause on this machine was not isolated and nothing was tried on Linux. The submitted SQLite version did about 1,000 holds per second on the same laptop, so Live is currently slower on one machine; what it adds is the ability to run on several servers.

## Not done

Real payments (the gateway interface has four methods; a Cashfree sandbox adapter is one file but needs sandbox keys and was not written untested); testing against a real Redis (the code uses the ioredis call shapes; only the in-process stand-in was exercised); deployment; real SMS; payouts, GST invoices and legal terms; event photos (posters are typographic); a dark theme. Settlement numbers are illustrative. The per-buyer limit is by phone number, so many numbers get around it. Demo login shows the code on screen and must not be used as is in production (the server refuses the built-in dev secrets when `NODE_ENV=production`).

The gate's camera needs https (or localhost), and offline checking needs a browser with Ed25519 in WebCrypto (recent Chrome, Safari and Firefox). The scanner page has to be opened once with a network so it can fetch its key.

## Free-tier hosting (untested here)

Set `DATABASE_URL` to a Neon or Supabase connection string and `REDIS_URL` to an Upstash `rediss://` URL, run `npm run web:build`, then `npm start`. The server needs a long-running process (timers, event streams), so a serverless-only host does not fit.
