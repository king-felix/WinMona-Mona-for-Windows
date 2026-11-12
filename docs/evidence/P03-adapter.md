# P03 — Versioned engine adapter

Implemented 2026-11-12 against Codewhale **0.10.2 (ff466b2ed0bf)**. The P01 spike
client remains in `tools/spike/` as historical evidence; the product adapter is
`@mona/adapter` and does not import it.

## What the adapter is

`packages/adapter` is a Node-only, contract-tested client for the local HTTP/SSE
Runtime API. It maps upstream snake_case wire records into Mona's branded
contracts and returns typed results for every operation:

- `discover()` — identity, capabilities, and a compatibility report.
- `createOrOpenThread()` — effective Full Access profile, verified workspace.
- `getEffectiveProfile()` — observed profile, never a requested setting.
- `submitTurn()` — persisted intent, operation key, idempotent replay,
  outcome-unknown reconciliation.
- `reconcileSubmission()` — read-only operation lookup.
- `subscribe()` — durable event stream with replay, reconnect, dedup, bounded
  frames, malformed/unknown event handling.
- `interrupt()` — exact thread/turn verification.
- `readHistory()` — engine-owned messages, system prompt excluded, bounded.
- `readUsage()` — cache-hit/miss/output buckets and known-or-unknown cost.
- `invokeCapability()` — a small qualified allowlist; everything else is a typed
  `capability_unsupported`.
- `startOwnedRuntime()` / `shutdownOwnedRuntime` — minimal owned process for the
  smoke test. **P04 replaces the supervisor**; this version never kills by
  process name and never logs the token.

## Compatibility policy

- Qualified: version `0.10.2`, commit prefix `ff466b2ed0bf`, runtime API `1.0`.
- Compatible but unqualified: other `0.10.x` versions or commit drift, with the
  reasons recorded; every used capability is still checked individually.
- Unsupported: any other version; `startOwnedRuntime` refuses to drive it.
- A missing capability flag is treated as `false`, never as supported.
- `terminal_stream/input/resize/kill` are false on this build and remain named
  gaps; no terminal scraping is added.

## Submission safety

Observed live and in fixtures:

1. Intent is written to the journal **before** the POST; the unit test asserts
   the record exists in the store at send time.
2. Every turn carries a client-generated operation key. A replayed key returns
   `200` with `idempotent_replay: true` and the same turn (verified live).
3. A dropped response marks the submission `outcome_unknown` and performs at
   most one read-only `GET /v1/threads/{id}/turn-operations/{key}`. It never
   repeats the POST. A 404 becomes outcome-unknown with inspection guidance.
4. If the runtime does not advertise `turn_operation_lookup`, reconciliation
   returns outcome-unknown with guidance immediately.
5. A response for another thread or turn cannot mutate the intended record: the
   submission stays `outcome_unknown` with `thread_mismatch`, and no turn id is
   adopted.
6. Thread create also accepts an operation key; a repeated key with different
   data is a hard 409 (P01 evidence), not a silent substitution.

The journal is an atomic JSON-file store for P03. P05 replaces it with the
transactional SQLite store; the `SubmissionJournal` interface is the seam.

## Event stream

- Incremental SSE decoder handles UTF-8 split across chunks, CRLF/LF, comments,
  multi-line data, partial frames, and a configurable frame cap (1 MiB default).
- Oversized frames are dropped with an `oversize_event` diagnostic and reading
  continues.
- Malformed known payloads produce `schema_drift` diagnostics without killing
  the stream; unknown event names remain available with their full envelope.
- Dedup is by durable `seq`; replay at or below the cursor is ignored.
- Reconnect uses `since_seq` (the engine also honours `Last-Event-ID`), bounded
  exponential backoff, and stops on authentication or non-retryable stream end.
  A reconnect never re-executes tool work.
- `stream.end` is mapped from the wire `last_seq/retryable/reason` shape.

## Live smoke (real, pinned runtime, no route changes)

`packages/adapter/scripts/live-smoke.mjs` → `docs/evidence/P03-live.json`.

- Runtime started with the pinned identity, compatibility `qualified`.
- Thread profile: `deepseek` / `deepseek-flash` / `full_access` / shell+trust+auto
  all true.
- Real turn `MONA_P03_ADAPTER` completed in 15 frames; usage priced at
  **$0.003543312** (11,760 miss + 1,152 cache-hit + 7 output).
- Replay with the same operation key returned the same turn, `replayed: true`,
  and no second turn.
- Journal replay was strictly increasing (16 events, no duplicate projection).
- A 300-second shell sleep was interrupted after the tool stage; the turn
  converged to `interrupted` via read-only lookup.
- Zero diagnostics on the final run.

Recorded contract fixtures (shapes from P01/P03) live in
`packages/adapter/fixtures/`; no fixture is imported by the renderer or by
production code.

## Verification

- `npm test` → **73 Vitest** (35 adapter: discovery, policy, submission,
  reconciliation, reconnect/dedup, oversize, malformed, usage, interrupt,
  wrong-thread, journal, HTTP) + 11 bootstrap + 8 spike = 92.
- `npm run typecheck` → pass.
- `npm run lint`, `npm run format:check` → pass.
- `npm run build` → contracts, adapter, desktop; renderer static checks pass.
- Live smoke → all steps pass, spend **$0.003543**.

## Known limits and next prompts

- **Process ownership** (Job Objects, lease, crash handling) is P04. P03's
  `startOwnedRuntime` is deliberately minimal.
- **Durable project store** is P05; JSON journal is not the final state layer.
- **Broader capability invocation** (MCP, skills, plugins, fleet, terminal) is
  P15–P18. Unsupported operations return typed reasons today.
- **Endpoint fingerprint drift** between CLI `exec` and runtime turns remains
  open (P01-ISSUE-001); the adapter reports the runtime fingerprint it observes.
- **Electron runtime** is still blocked (P02-ELECTRON-BINARY); this package does
  not need it.
