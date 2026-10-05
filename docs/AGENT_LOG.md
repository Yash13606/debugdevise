# AGENT_LOG

An honest record of how an AI coding agent was used to produce the observations and these docs, including its mistakes. Times are omitted where they were not recorded; commit times are in the git history.

## Setup
- **Agent:** Claude Code in the VS Code extension; model Claude Sonnet 5.5 (the user briefly switched models and switched back).
- **Access:** read/search over a local shallow clone of the original (`git clone --depth 1`, commit `af22b01c5f3737dd6ae678ebc53ef66e9a6b4955`, kept **outside** this repository), a shell, and the GitHub CLI authenticated as the repository owner.
- **Not used:** the agent did not open the Playbook pages; it followed the written brief. No packaged skills were invoked through the skill mechanism in this session. No code from the original was copied into this repository.

## What the human decided
- Which problem statement and which original repository.
- The event's process rules: docs are pushed before any code; the first commit and the submission follow the stated times.
- The target repository (created and owned by the human).
- The product name, **AtomicPass: Concurrency-Safe Ticketing**, as shown on the team's submission page. The first version of these docs used a placeholder name the agent had invented.
- That the agent must not appear as a collaborator or co-author on pushed commits.
## Decisions made by the agent, not yet confirmed by the human
- The improvements: fix = GAP-1, differentiator = waiting room + per-buyer cap.
- The stack (Node.js, TypeScript, Fastify, SQLite).
- These were proposed in the agent's Phase 1 report and are used as written in these docs. The human has not explicitly confirmed them at the time of writing and may change them.

## Prompts (paraphrased, in order)
1. Save the problem statement to a markdown file; clone the original repository.
2. Give the complete ordered plan for the whole hackathon.
3. Build phase-wise plan documents, using the listed external skills/repositories as reference.
4. "Phase 0 done, do Phase 1": trace capacity, holds/expiry and QR check-in in the original, with `file:line` evidence.
5. Do phases 1–3 only, following the timing rules; push the docs to the given repository without adding the agent as a collaborator.
6. Confirm that everything so far was done correctly. The agent then re-checked the remote repository and ran a mechanical check of every `file:line` citation (see below).
7. Align with the platform's repo-check page and prepare a handoff for a fresh chat that builds from these docs only.

## What the agent did
1. **Orientation:** listed the backend layout; located the order, product-quantity and check-in code with text search.
2. **Capacity trace:** read the order-creation action and handler, the availability service, the quantity-update service, the reserved/sold repository queries and the lock service.
3. **Hold/expiry trace:** read the order manager, the scheduler, completion, abandon and payment-intent handlers, and the Stripe success webhook handler.
4. **Check-in trace:** read both check-in paths, the check-in-list data service, the unique-index migration, the routes and the frontend QR component.
5. **Promo/refund trace:** read the promo usage service and order repository queries, the cancel service and both refund handlers.
6. **Data model:** read generated domain objects, the schema documentation and migrations.
7. **Analysis:** ranked gaps, chose the fix and differentiator, designed the rebuild (counters, conditional updates, queue).
8. **Writing:** produced the seven documents from the verified notes; re-checked cited paths against what had actually been read.
9. **Alignment with the platform's repo-check page** (supplied as a screenshot): all seven docs were listed as found. The agent renamed the product to the team's name, added an access table to the API document and a component-interaction section to the architecture document, and verified on this machine that the planned dependencies install and that a worker thread can open its own database connection.

## Mistakes the agent made, and how they were caught
| # | Mistake | Correction |
|---|---|---|
| 1 | Hypothesised, from a search for one lock API, that the original had **no locking** and would oversell. | Reading the order handler showed a per-event advisory lock (OBSERVATIONS CAP-2). The hypothesis was withdrawn and never used. |
| 2 | A file-listing pattern with a wrong base directory returned nothing. | Re-ran with the correct directory. |
| 3 | A search using a brace-style multi-path filter reported "no matches" although matches existed. | Re-ran per directory without the filter before concluding a feature was absent. |
| 4 | A search listing was cut off at its output limit while arguing that no code dispatches a capacity event on hold expiry. | Re-ran in file-list mode to get the full set (eleven files) before stating the claim. |
| 5 | While drafting this documentation the agent wrote a **wrong class-file name** in a citation (HOLD-8). | Caught on re-reading its own output against the earlier search result; fixed in the same session. |
| 6 | Assumed the scanner endpoints were public without having seen the end of the route group. | Read the group's closing lines and added the exact line range (`routes/api.php:714-833`). |
| 7 | Cited a domain-object helper as the check-in list window gate without having read the validator the service actually calls. | Read `CheckInListActivityValidator`, corrected the citation in CHK-2. |
| 8 | Three paragraphs (CAP-3, PAY-4, CHK-2) used bare `:NN` line references after naming a different file, so a reader could attach them to the wrong file. | Found by the citation check below; each reference now names its file. |
| 9 | An earlier version of this log listed the agent's own proposals (improvements, stack) under "What the human decided". | Noticed on review; moved to a separate section stating they are unconfirmed. |
| 10 | The agent named the product "RushPass" on its own; the team's name on the submission page is "AtomicPass". | Renamed everywhere in the docs (name, database file name, QR prefix). |
| 11 | The architecture document's algorithms called a payments module that its module layout never listed. | Found while writing the component map; the module is now in the layout. |

## Citation check (run after the first push)
A script parsed every `path:line` citation in these documents and compared it with the local clone of the original at the studied commit. First run: 218 line-numbered citations, **0 missing files, 0 out-of-range line numbers**, plus the ambiguous bare references in mistake 8. After fixing those, the re-run covered 221 citations with **0 problems**. The first line of each cited range was also printed and compared with the claim it supports; no mismatch was found (end lines were checked only to exist). The script is a local helper and is not part of this repository.

## Claims deliberately marked as analysis, not fact
GAP-1, GAP-2 (impact), GAP-3, GAP-4 (impact), GAP-8, GAP-10, and the "two paths" outcome in CHK-3 are reasoned from the code but were **not executed or reproduced**. The documents say so wherever they appear.

## Known limits of this work
Static review only; nothing from the original was executed. Several areas were not examined (OBSERVATIONS §10). The rebuild outlined in the other documents had not been implemented at the time of writing.

## Build session

A second chat built the rebuild from these documents. This section records it.

### Setup
- **Agent:** Claude Code in the VS Code extension; model Claude Sonnet 5.5, in a new chat. It read `docs/` and a local build note kept outside the repository (order of work, deadlines, rules) and built from `docs/` only. The original's code and the other project folders were never opened.
- **Caveat:** the chat's workspace was the parent folder, which also holds those folders, so the separation rested on the agent's discipline, not on the folder set-up. For the same reason the agent did not use tools that index the whole workspace (a code-graph index, shared memory tools).
- **Skill used:** `tdd` (loaded once at the start). No sub-agents were started.
- **Tests first:** every step began with failing tests, then the smallest code to pass them, then a commit and a push.

### What the human decided
- Whether to build in that chat at all. The first two messages the human pasted were the previous agent's reports with no request in them; the agent did not act on them and asked. The human then chose, in a multiple-choice prompt: build in this chat, the stack and both improvements are confirmed, no attribution lines in commits or pull-request text, and push to `origin/main` after every step (`git pull --rebase` first, never force-push).

### What was built, step by step
| Step | Built | Tests added |
|---|---|---|
| 4.0 | config, clock, db (schema copied from DATA_MODEL), ids, errors, `.env.example` | schema equals the document; CHECK constraints refuse `sold + held` above capacity |
| 4.1 | `inventory.reserve`, `createHold`, admin create event and tier | KT1, KT1-n, KT1-db (worker threads, own connections, barrier) |
| 4.2 | (the pool update was already part of reserve) | KT1-pool |
| 4.3 | lazy and swept expiry, pay, release, orders, QR tickets, mock payments, `src/index.ts` | KT2, KT2-paid, pay, release and token tests |
| 4.4 | check-in with one conditional update, order read | KT3, plus the same race across two connections |
| 4.5 | no code; 20 consecutive runs of `npm run killer` | all green each time |
| 4.6 | promo codes, refunds, discount spread over tickets | P-1, P-2, R-1, KT3-void, refund-versus-scan (HTTP and two connections) |
| 4.7 | waiting room, per-buyer cap | Q-1, Q-2, B-1, one admission used from two connections, cap raced from two connections |
| 4.8 | stats with the invariant audit, event list, QR image | I-1: the audit runs after every test |
| 4.9 | `scripts/rush.ts` | a small rush with exact numbers |

### Defects found in these documents while building, and what was corrected
| # | Defect | Correction |
|---|---|---|
| 1 | ARCHITECTURE 4.6 said a re-join deletes the buyer's `USED` entry, but the hold that used it references the entry (foreign key), so the delete would fail | Old entries are kept; a re-join inserts a new row (the partial unique index only covers live entries) |
| 2 | `NOT_ADMITTED` had no reason for an admission that was already used | Added `USED`; documented the order in which the reason is chosen |
| 3 | DATA_MODEL 5 did not say whose cents "the remaining cents" are, whether a one-tier promo is spread over all tickets, or what happens to free tickets | Leftover discount cents; eligible tickets only; free tickets are skipped so no ticket goes negative |
| 4 | A refund with no ticket list on a partly refunded order was ambiguous | It refunds every ticket not yet refunded; `ALREADY_REFUNDED` only when none is left |
| 5 | A refund naming a ticket of another order had no defined answer | 404 NOT_FOUND |
| 6 | A duplicate promo code had no error code | `409 PROMO_EXISTS` |
| 7 | The rush script's "5,000 − k" had no k | Default k = 500, with options |
| 8 | "Parallel" HTTP tests suggested lock contention that one process cannot produce | Documented; real contention is tested with worker threads |
| 9 | The layout and component rules missed `schema.ts`, the test helpers, the read helpers in `inventory.ts` and the `clock.ts` import | Documents updated |
| 10 | No `INTERNAL` error code; `gate` and whitespace in `qr` unspecified; mismatch shape of the audit and what it checks unspecified; TTL settings are whole seconds | Documented |

### Mistakes made during the build, and how they were caught
| # | Mistake | How it was caught |
|---|---|---|
| 1 | A first KT2-paid asked for more seats than `max_per_order` allows | The test failed with 422 instead of 409; the test was changed |
| 2 | A test helper's default argument swallowed an explicit `undefined`, so a "no gate" scan still sent a gate | The test failed; the helper now takes `null` |
| 3 | Adding the per-buyer cap broke three older tests that bought 20 to 40 tickets for one buyer | The full run; those tests now use several buyers or switch the cap off |
| 4 | Expected a deferred transaction to break the check-in race; it did not, because the first statement there is already a write | Run as an experiment; the check-in tests were then tested by removing the conditional guard instead |
| 5 | A sale-window test ignored that the default 10-minute hold lifetime expires holds during a two-hour clock jump | The test failed; it now uses a one-day lifetime |

### Evidence that the tests can fail
Each of these was done by a temporary edit, run and reverted; none was committed. A deferred transaction instead of `BEGIN IMMEDIATE` made KT1-db and the per-buyer cap race fail with "database is locked". Removing the pool guard made KT1-pool fail. Removing the `VALID` guard from check-in made every KT3 test fail, over HTTP and across connections. Loosening the promo limit made five promo tests fail.

### Limits of the build
- HTTP-level "parallel" requests run one at a time inside one process; only the worker-thread tests create real contention between connections.
- SQLite admits one writer: a single machine is the ceiling. Statements are prepared on every call; a per-connection cache would raise throughput and was not needed to meet the documents.
- Payments are a mock; there is no user interface.

## Human review notes
*(Maintainers: add anything you checked or changed by hand here.)*
