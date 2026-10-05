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
- That the agent must not appear as a collaborator or co-author on pushed commits.
- Adoption of the agent's proposed improvements (fix = GAP-1, differentiator = waiting room + per-buyer cap) — proposed by the agent in its Phase 1 report; used as written in these docs.

## Prompts (paraphrased, in order)
1. Save the problem statement to a markdown file; clone the original repository.
2. Give the complete ordered plan for the whole hackathon.
3. Build phase-wise plan documents, using the listed external skills/repositories as reference.
4. "Phase 0 done, do Phase 1": trace capacity, holds/expiry and QR check-in in the original, with `file:line` evidence.
5. Do phases 1–3 only, following the timing rules; push the docs to the given repository without adding the agent as a collaborator.

## What the agent did
1. **Orientation:** listed the backend layout; located the order, product-quantity and check-in code with text search.
2. **Capacity trace:** read the order-creation action and handler, the availability service, the quantity-update service, the reserved/sold repository queries and the lock service.
3. **Hold/expiry trace:** read the order manager, the scheduler, completion, abandon and payment-intent handlers, and the Stripe success webhook handler.
4. **Check-in trace:** read both check-in paths, the check-in-list data service, the unique-index migration, the routes and the frontend QR component.
5. **Promo/refund trace:** read the promo usage service and order repository queries, the cancel service and both refund handlers.
6. **Data model:** read generated domain objects, the schema documentation and migrations.
7. **Analysis:** ranked gaps, chose the fix and differentiator, designed the rebuild (counters, conditional updates, queue).
8. **Writing:** produced the seven documents from the verified notes; re-checked cited paths against what had actually been read.

## Mistakes the agent made, and how they were caught
| # | Mistake | Correction |
|---|---|---|
| 1 | Hypothesised, from a search for one lock API, that the original had **no locking** and would oversell. | Reading the order handler showed a per-event advisory lock (OBSERVATIONS CAP-2). The hypothesis was withdrawn and never used. |
| 2 | A file-listing pattern with a wrong base directory returned nothing. | Re-ran with the correct directory. |
| 3 | A search using a brace-style multi-path filter reported "no matches" although matches existed. | Re-ran per directory without the filter before concluding a feature was absent. |
| 4 | A search listing was cut off at its output limit while arguing that no code dispatches a capacity event on hold expiry. | Re-ran in file-list mode to get the full set (eleven files) before stating the claim. |
| 5 | While drafting this documentation the agent wrote a **wrong class-file name** in a citation (HOLD-8). | Caught on re-reading its own output against the earlier search result; fixed in the same session. |
| 6 | Assumed the scanner endpoints were public without having seen the end of the route group. | Read the group's closing lines and added the exact line range (`routes/api.php:714-833`). |

## Claims deliberately marked as analysis, not fact
GAP-1, GAP-2 (impact), GAP-3, GAP-4 (impact), GAP-8, GAP-10, and the "two paths" outcome in CHK-3 are reasoned from the code but were **not executed or reproduced**. The documents say so wherever they appear.

## Known limits of this work
Static reading only; nothing in the original was run. Several areas were not traced (OBSERVATIONS §10). The rebuild described in the other documents has not been implemented at the time of writing.

## Human review notes
*(Maintainers: add anything you checked or changed by hand here.)*
