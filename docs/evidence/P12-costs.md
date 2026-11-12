# P12 — Cost ledger and optional budget controls

**Status: completed.** MONA-013 is delivered as a local ledger with explicit
origins, append-only rate revisions, honest unknowns, and disclosed budget
enforcement limits.

## What was delivered

- **Migration v5.** `usage_records` gains `provider`, `model`, `input_tokens`,
  `reasoning_tokens`, `cache_known`, `cost_source`, `rate_revision`,
  `dedupe_key`, `task_id`, `parent_turn_id`, `unknown_reason`; plus
  `rate_cards`, `budgets`, `budget_reservations` and `budget_events`. A partial
  unique index on `dedupe_key` makes replay idempotent at the database.
- **`CostLedger`** (`packages/project-state/src/costs.ts`):
  - `putRate` / `rates` / `activeRate` — revisioned rate cards; re-using a
    revision with different numbers is refused.
  - `ingest` — one usage fact, three cost origins, duplicate-safe.
  - `records` / `totals` / `lens` — per-turn, per-task, per-session views with
    cache, input, output and reasoning buckets when reported, plus rate
    freshness and disclosure lines.
  - `recalculate` — explicit, read-only re-pricing under a chosen revision.
  - `exportCsv` — labels every row `provider-reported`, `locally-estimated` or
    `unknown (reason)`.
  - `setBudget` / `listBudgets` / `reserve` / `releaseReservation` /
    `evaluateBudget` — optional warn/stop thresholds with reservations.
- **`estimateCost`** — exact micro-USD arithmetic for disjoint buckets,
  inclusive-cache handling, and unknown-with-reasons for missing buckets or
  missing rates.
- **`dayWindow`** — a local-day UTC window from an explicit offset, so day
  budgets are deterministic and testable.
- **Studio gate.** `StudioService.submit` evaluates budgets before dispatch:
  `block_next_dispatch` refuses the submit with the decision detail, `warn`
  records a diagnostic and proceeds. In-flight work is never interrupted.
- **Zero-inference boundary check.** A test drives `view`, `pause`, `resume` and
  a refused submit through the real `StudioService` and asserts the fake adapter
  saw **zero** thread opens and **zero** submissions.

## Acceptance matrix

| P12 acceptance item | Result | Where |
|---|---|---|
| Known arithmetic fixtures match exactly | pass (3,100 microUSD, inclusive 3,100, reasoning 1,000) | `costs.test.ts` "cost arithmetic" |
| Inclusive/exclusive token buckets handled | pass | `costs.test.ts` "handles inclusive input..." |
| Duplicates/reconnects do not inflate totals | pass | `costs.test.ts` "does not charge a replayed or duplicate..." |
| Child aggregates do not double count | pass | `costs.test.ts` "does not count a parent aggregate..." |
| Unknown rates propagate as unknown | pass | `costs.test.ts` "stores unknown as unknown, never as zero" |
| Timezone/day boundaries correct | pass | `costs.test.ts` "scopes a day budget...", "computes a local day window..." |
| Provider-reported vs estimated labelled | pass | `costs.test.ts` export test, `P12-cost-export.csv` |
| Budget warns before dispatch | pass | `costs.test.ts` "warns, then blocks...", `studio-service.test.ts` |
| No misleading invoice-cap promise | pass (disclosure string, asserted) | `costs.test.ts`, ADR |
| UI actions cause no inference | pass | `studio-service.test.ts` "gates the next dispatch..." |

## Evidence

- `docs/evidence/P12-costs-adr.md` — usage semantics, rates and budget ADR.
- `docs/evidence/P12-sample.json` — deterministic ledger run against real
  SQLite: rate card, provider-reported ingest, estimated ingest, duplicate
  refusal, unknown ingest, budget, evaluation, lens, rate freshness.
  `providerRequests: 0`.
- `docs/evidence/P12-cost-export.csv` — the exported ledger with per-row origin
  labels.
- `docs/evidence/P11-13-gates.txt`, `P11-13-checks.txt`, `P11-13-build.txt`.

## Unobservable costs, stated rather than invented

- Usage is only ever what the engine reports. A turn whose usage event never
  arrives is stored as `unknown` with the reason; no token count is estimated
  from text length.
- Provider account balances and prepaid remainders are not observable through any
  supported interface used here, so Mona does not display them.
- The P01 cost-parity figure stays the economics reference. P12 did not run a new
  paid benchmark because the adapter's context assembly and routing did not
  change; the zero-inference boundary is proven by test instead.

## Open follow-ups

- **P12-ISSUE-001** — the cost lens has no renderer surface yet. The views,
  attribution and export are implemented and tested on the ledger; the cost
  screen still shows the P07 aggregate. Left to the UI prompts rather than adding
  an unrequested screen here.
- **P12-ISSUE-002** — budgets can only gate Mona's outer dispatch. The pinned
  engine exposes no internal call control, so a running turn may overshoot; this
  is disclosed in every evaluation and in the ADR.
- **P12-ISSUE-003** — `StudioService` does not yet attribute a turn's usage to a
  task id; the ledger supports `task_id` and the wiring belongs with the task
  dispatch connection (P10-ISSUE-002).
