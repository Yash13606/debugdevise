# Submission: AtomicPass: Concurrency-Safe Ticketing

| | |
|---|---|
| **Team ID** | DBG-462 |
| **Card** | FinTech, PS 01 "The Box Office": Rush-Proof Event Ticketing |
| **Product** | AtomicPass: Concurrency-Safe Ticketing |
| **Repository** | https://github.com/Yash13606/debugdevise (branch `main`) |

## Team

| GitHub | Name |
|---|---|
| Yash13606 | A Yash |
| ayushb89 | Ayush |
| gkavin2527 | G Kavin |

## The original we studied

[Hi.Events](https://github.com/HiEventsDev/Hi.Events) at commit `af22b01c5f3737dd6ae678ebc53ef66e9a6b4955` (2 Oct 2026, "Feature: Box Office & Seating (#1372)"). The study was a read of its source; nothing from it was run or copied. What was found, with file and line evidence, is in [docs/OBSERVATIONS.md](docs/OBSERVATIONS.md) and [docs/GAPS.md](docs/GAPS.md). Several of the weaknesses there are reasoned from the code and not reproduced; the documents mark which.

## How to run it

```bash
git clone https://github.com/Yash13606/debugdevise
cd debugdevise
npm install
npm run killer
npm start
```

Node.js 22.12 or newer. No `.env` and no key is needed; see the README.

## Improvements

- **Fix (GAP-1): shared-pool capacity that counts holds.** A reservation raises `held` on the tier and on the event pool with conditional updates in one transaction, so `sold + held` cannot pass capacity on either; a database `CHECK` backs it up. Test: KT1-pool.
- **Differentiator: a waiting room and a per-buyer cap** (GAP-2, GAP-3, GAP-4). Buyers join a first-come, first-served queue, a ticker admits a few per tick, and the admission is used up only by a hold that succeeds; one buyer (by normalised email) is limited across active holds and valid tickets. Tests: Q-1, Q-2, B-1, and two races across separate connections.

## Libraries used

From `package.json`, with the exact versions installed.

| | Library | Version | Used for |
|---|---|---|---|
| runtime | better-sqlite3 | 13.0.3 | the SQLite database |
| runtime | fastify | 5.12.5 | the HTTP server, request validation |
| runtime | qrcode | 1.5.4 | the optional QR image endpoint |
| dev | typescript | 7.0.2 | type-checking (`npm run build`) |
| dev | tsx | 4.23.15 | running TypeScript without a build step |
| dev | vitest | 5.0.3 | tests |
| dev | @types/node, @types/better-sqlite3, @types/qrcode | 26.6.4, 9.6.0, 1.5.6 | type definitions |

## AI

- **In the product: none.** The service runs without any AI or third-party key.
- **In making it:** Claude Code (model Claude Sonnet 5.5) wrote the observations, the documents and this code under the team's direction. [docs/AGENT_LOG.md](docs/AGENT_LOG.md) records the prompts, the decisions, the agent's mistakes and how each was caught.

## Known limitations

- SQLite admits one writer, so one machine is the ceiling; nothing here was run on more than one node.
- The per-buyer cap keys on a normalised email; many mailboxes defeat it.
- Payments are a deterministic mock. Asynchronous gateways would need a `PAYING` hold state (docs/GAPS.md, GAP-7).
- No user interface, email, seat maps, invoices or multi-currency.
- Requests sent together over HTTP in the tests are handled one at a time by one process; only the worker-thread tests make separate database connections collide.
- The findings about the original come from reading its code, not from running it.
