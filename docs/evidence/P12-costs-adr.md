# P12 usage semantics, rates and budgets (ADR)

Status: accepted, P12.
Applies to: `packages/project-state/src/costs.ts`, project `usage_records`,
`rate_cards`, `budgets`, `budget_reservations`, `budget_events`.

## Decision

Mona keeps a local cost ledger with **three explicit cost origins** and never
collapses them:

| Origin | Meaning | Stored as |
|---|---|---|
| `provider_reported` | the engine returned a complete price for the turn/thread | `cost_known = 1`, `cost_source = 'provider_reported'`, `cost_micros` |
| `estimated` | Mona applied a recorded rate revision to reported token buckets | `cost_known = 1`, `cost_source = 'estimated'`, `rate_revision`, `cost_micros` |
| `unknown` | usage or price was missing, partial, or unpriced | `cost_known = 0`, `cost_micros = NULL`, `unknown_reason` |

A usage record marked unknown may not carry a cost value; the store refuses it.
Unknown is never rendered or summed as `$0.00`.

## Usage semantics

The DeepSeek route reports disjoint cache buckets
(`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`) and output. Mona's
default `estimateCost` treats `cacheHitTokens` and `cacheMissTokens` as separate
buckets. When a caller has only an inclusive total, it must pass
`inputSemantics: 'inclusive_cache'` plus `inputTokens`; Mona then derives
`miss = input - hit` and refuses a negative result rather than clamping it to
zero.

Reasoning tokens are included in output on this route. They are shown, not
added, and are billed separately only when the caller sets
`reasoningBilledSeparately: true` **and** a reasoning rate exists in the
revision. Otherwise the record is unknown, not silently cheaper.

```
micros = round(miss × missRatePerUnit / unitTokens)
       + round(out  × outRatePerUnit  / unitTokens)
       + (hit > 0 ? round(hit × hitRatePerUnit / unitTokens) : 0)
       + (separately billed reasoning, when configured)
```

Rates are stored as micro-USD per `unitTokens` (default 1,000,000), so no float
accumulates and no rounding drift is hidden.

## Double counting

- **Replay / reconnect.** `dedupe_key` defaults to
  `ingest|project|thread|turn|parentTurn` with a unique index. A repeated ingest
  returns the existing row with `duplicate: true` and records nothing.
- **Parent/child aggregates.** A row whose `turn_id` is referenced as another
  row's `parent_turn_id` is an aggregate and is excluded from totals; the child
  rows carry the detail. Neither the parent nor the children are counted twice.
- **Engine thread deltas.** The studio already records the delta between the
  engine's thread totals and what it has stored for that thread, so a replayed
  `turn.usage` event cannot add a second copy.

Order of arrival is never used for identity.

## Rate history

`rate_cards` is append-only by revision: `(provider, model, revision)` is unique
and re-inserting an existing revision with different numbers is a `conflict`.
Each usage record keeps the `rate_revision` that priced it. A new price appends a
new revision with a later `effective_from`; historical rows are untouched.
`recalculate(projectId, { provider, model, revision })` is an explicit,
read-only projection that shows what the totals would be under a different
revision and writes nothing.

## Budgets

Budgets are optional, user-set, and scoped to `session`, `project` or `day`.
A day scope resolves to a UTC window computed from the caller's timezone offset,
so a day boundary follows the user's local day and is testable.

Evaluation compares `spent + unreleased reservations` against `warn` and `stop`
thresholds and returns `allow`, `warn` or `block_next_dispatch`. Unknown records
are counted and reported but not priced into the projection. Warnings and blocks
are written to `budget_events` for audit.

**Enforcement limit, disclosed in every evaluation:** this is a local dispatch
limit, not a provider invoice cap. It blocks the *next* dispatch. An in-flight
request may complete after a stop request and may overshoot. The engine exposes
no internal call-level budget control on the pinned build, so Mona cannot stop a
turn mid-tool-loop on cost grounds; it can only refuse the next outer turn.

No mandatory limit is created for ordinary authorized work, and there is no
automatic fallback to a cheaper or more expensive model.

## Not claimed

- No scraping of account balances; Mona has no supported interface for that and
  will not present a local sum as a remaining prepaid balance.
- No claim that an estimate equals the invoice. Provider billing is
  authoritative; the ledger is evidence.
- Cost figures from P01 remain the economics reference; P12 did not re-run the
  paid benchmark because the adapter's context assembly and routing are
  unchanged.
