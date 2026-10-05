# AtomicPass: Concurrency-Safe Ticketing

AtomicPass sells event tickets and never sells a seat twice. A buyer first **holds** seats, which are taken in one atomic step from the tier and from the event's shared pool, then **pays**. An unpaid hold expires and frees its seats, and every ticket's QR code is admitted at the gate exactly once.

It is one TypeScript process (Node.js, Fastify) with one SQLite file. It needs no external service, no API key and no AI.

## Run it in 5 commands

```bash
git clone https://github.com/Yash13606/debugdevise
cd debugdevise
npm install
npm run killer
npm start
```

`npm run killer` runs the concurrency tests. `npm start` serves the API at http://localhost:3000 (try `/health`). It needs Node.js 22.12 or newer; it was developed and tested on Node 24.13 on Windows 11.

**Settings.** Every setting has a default, so no `.env` is needed. To change one, copy `.env.example` to `.env`. Time limits are in seconds (names ending in `_MS` are milliseconds). A real environment variable beats `.env`, and a wrong value stops start-up with a message that names it. No setting is a secret except the two keys, which are placeholders you should change.

## The three Killer Tests

`npm run killer` runs these, plus the variants and races in the last rows.

| Test | What happens | It passes when |
|---|---|---|
| **KT1** the last ticket | Two buyers ask for the last ticket at the same moment | exactly one gets a hold, the other gets `409 SOLD_OUT` |
| KT1-n | 50 buyers, 10 seats, repeated 20 times | exactly 10 holds every time |
| KT1-db | Two worker threads, each with its own database connection, released together by a barrier, race for the last ticket (20 rounds) | exactly one wins each round |
| **KT1-pool** | Two tiers of 5 seats share an event pool of 5; ten buyers ask at once | exactly 5 holds, neither tier above its capacity |
| **KT2** an unpaid hold frees its seat | With `HOLD_TTL_SECONDS=1`: buyer 1 holds the last seat, buyer 2 is refused, 1.5 s later buyer 2 succeeds | buyer 2 gets a hold, and paying buyer 1's old hold is `410 HOLD_EXPIRED` |
| **KT3** one scan per ticket | Scan a QR twice, then scan a new ticket's QR twenty times in parallel | `200` then `409 ALREADY_CHECKED_IN`; exactly one `200` among twenty |
| races | The gate race again across two connections; a refund against a scan; one admission used from two connections; one buyer's cap raced from two connections | exactly one winner every time |

The tests set their own hold lifetime (KT2 uses 1 second). To see the same by hand, put `HOLD_TTL_SECONDS=2` in `.env` and restart.

## The two improvements

- **The fix, GAP-1: capacity is enforced on the tier and on the event pool together.** A reservation raises `held` on both with conditional updates inside one transaction, so `sold + held` cannot pass the capacity on either, and a database `CHECK` backs that up. Tested by KT1-pool.
- **The differentiator: a waiting room and a per-buyer cap.** With the queue on, buyers join a first-come, first-served line, a ticker admits a few per tick, and an admission is used up only by the hold that succeeds. `MAX_TICKETS_PER_BUYER` limits each buyer (by normalised email) across active holds and valid tickets. Tested by Q-1, Q-2 and B-1 in `test/unit`.

## Try it with curl

Start the server, then run these in Git Bash (or any POSIX shell). Replace `EVENT_ID` and `TIER_ID` with the ids in the answers.

```bash
curl -s -X POST localhost:3000/api/admin/events -H 'x-admin-key: change-me-admin' -H 'content-type: application/json' -d '{"name":"Fest","starts_at":"2026-10-20T13:00:00Z","capacity":1}'
curl -s -X POST localhost:3000/api/admin/events/EVENT_ID/tiers -H 'x-admin-key: change-me-admin' -H 'content-type: application/json' -d '{"name":"General","price_cents":49900,"capacity":1}'
curl -s -X POST localhost:3000/api/events/EVENT_ID/holds -H 'content-type: application/json' -d '{"email":"a@x.com","items":[{"tier_id":"TIER_ID","quantity":1}]}'
```

Run the third line again with another email: the answer is `{"error":{"code":"SOLD_OUT",...}}`. Paying, scanning and the rest of the API are in [docs/API.md](docs/API.md) ("Worked example").

## Other commands

| Command | What it does |
|---|---|
| `npm test` | every test (unit tests, the Killer Tests and the races) |
| `npm run build` | type-check only (`tsc --noEmit`); `npm start` needs no build |
| `npm run rush` | 5,000 buyers press buy at once for 4,500 seats; prints holds made, sold-outs and the invariant result (`-- --buyers N --capacity C` to change it) |
| `npm run demo` | a narrated run of the waiting room and the per-buyer cap: ten buyers join, three are admitted per tick, an unadmitted buyer is refused with `403 NOT_ADMITTED`, and the cap refuses extra tickets with `409 BUYER_LIMIT` |
| `npm run dev` | start with auto-restart on file changes |

## What the tests do and do not show

- Requests sent together over HTTP (`Promise.all` of `app.inject`) are handled one at a time by a single process, so those tests check the rules. Real contention between database connections is tested only by the worker-thread tests.
- After every test, an audit recomputes the counters from the rows (the invariants in [docs/DATA_MODEL.md](docs/DATA_MODEL.md)) and the test fails if they differ. The same audit is in `GET /api/admin/events/:id/stats`.
- SQLite admits one writer, so one machine is the ceiling. `npm run rush` measures it: in one run on the development laptop, 5,000 requests took 5.7 s.

## Documentation

All in [docs/](docs/): [PRD](docs/PRD.md) (requirements and test table), [ARCHITECTURE](docs/ARCHITECTURE.md) (design and algorithms), [DATA_MODEL](docs/DATA_MODEL.md) (schema and invariants), [API](docs/API.md), [GAPS](docs/GAPS.md) (weaknesses found in the original and what this does about them), [OBSERVATIONS](docs/OBSERVATIONS.md) (how the original behaves, with file and line evidence) and [AGENT_LOG](docs/AGENT_LOG.md) (how an AI coding agent was used, including its mistakes).

## Limits

Payments are a deterministic mock (`simulate: "decline"` declines). There is no user interface and no email. The per-buyer cap keys on a normalised email. There is one node and one database file. See [docs/GAPS.md](docs/GAPS.md), "Known limitations".
