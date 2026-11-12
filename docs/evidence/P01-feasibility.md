# P01 — Feasibility, economics, and coverage evidence

Captured 2026-11-11/12 on Victor's Windows 11 machine against the installed
Codewhale **0.10.2 (ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e)**. Provider route
was preserved untouched: `deepseek` / `deepseek-flash` / `https://api.deepseek.com`
(doctor) and `/beta` base URL as reported by the runtime config. No credential,
endpoint, model, permission, or telemetry setting was changed.

## Verdict

**Proceed.** All three gates have real evidence from the installed binary:

- **G0 — Engine: pass.** One real tool-enabled turn created files, ran its own
  test, streamed events, completed, survived a runtime restart, resumed in the
  same thread, and was interruptible with no owned child left running.
- **G1 — Economics: pass, provisional.** Matched direct `exec` and adapter turns
  used the same wire model, dialect, and **identical tool-schema hash**
  (`bf3cf7cb…`, 15 tools, 35,883 bytes), the same number of provider requests per
  task, and acceptance parity. Median paired cost delta **+1.45%** (within the 5%
  tolerance), with two of six pairs above 5% from model-side variance, not Mona
  overhead. Idle, discovery, history, and reconnect caused **zero** tokens.
- **G2 — Surface coverage: pass for the discovered surface.** 43 top-level
  commands captured with help, 250 `/v1/*` routes extracted from the binary and
  contract-tested where marked, effective configuration and capability flags
  recorded, unsupported capabilities named. Deep MCP/skill/plugin qualification
  remains P17/P18 scope, not silently claimed here.

## Evidence artifacts

- `docs/evidence/P01-contract.json` + `P01-contract-log.txt` — no-inference
  contract run (auth, discovery, idempotency, events, idle window, 404).
- `docs/evidence/P01-g0.json` + `P01-g0-log.txt` — live tool turn, resume,
  interrupt, concurrency.
- `docs/evidence/P01-bench.json` + `P01-bench-log.txt` — paired cost pilot.
- `docs/evidence/engine/commands/*.txt` — help capture for all 43 commands.
- `docs/codewhale-capabilities.json` — qualified ledger.
- `docs/evidence/P01-tests.txt` — `npm test` 19/19.

## G0 — what actually ran

Thread profile returned by the runtime: `permission_posture=full_access`,
`model_provider=deepseek`, `model=deepseek-flash`, workspace equal to the owned
runtime's cwd. The turn record separately reports effective route:
`effective_provider=deepseek`, `effective_model=deepseek-flash`,
`effective_billing_surface=first-party-payg`, `effective_billing_mode=metered`.

Observed sequence (abridged; full frame list in `P01-g0.json`):
`thread.started → turn.started → item.started(write) → item.completed →
turn.provider_request → turn.usage → … → turn.completed → turn.workspace_snapshot`.

| Check | Result |
|---|---|
| Tool turn wrote `sum.js` + `sum.test.js` | pass (66 and 187 bytes) |
| Mona-independent `node --test` | pass 1, fail 0 |
| Live events (tool, usage, snapshots, lifecycle) | pass, 68+ frames |
| Effective route + Full Access | pass |
| Replay with same operation key | 200, `idempotent_replay: true`, same turn id, turn count unchanged |
| Thread survives runtime restart | pass, seq preserved (319), 10 history messages |
| Resume turn in same thread | pass, completed, marker written |
| Interrupt of a 300 s shell command | pass, status `interrupted` |
| Owned child cleanup after interrupt | pass, no `Start-Sleep -Seconds 300` process remained |
| Unknown route | 404 (never a fabricated success) |

Interrupt used the documented engine operation
`POST /v1/threads/{id}/turns/{turn_id}/interrupt`; it returns a receipt with
status `in_progress` at request time, and the thread converges to `interrupted`.
Mona must therefore treat the receipt as acknowledgment, not completion.

## G1 — cost pilot

- Rates: engine bundled model catalog for `deepseek-flash`
  (`input 0.15`, `cache_read 0.003`, `output 0.6` USD per million). Reasoning
  tokens are already included in `output_tokens`; the formula was verified
  against engine-reported adapter cost to the last micro-dollar.
- Adapter cost is engine-reported (`pricing_provenances: ["provider_docs"]`).
  Direct `exec` emits no cost field, so its cost is an estimate from the same
  rates. Provider billing remains authoritative.
- Workspaces: fresh per run, identical seeds per task; execution order alternated
  per repetition. Two repetitions per task, three tasks.

| Task | Rep | Direct | Adapter | Delta |
|---|---|---|---|---|
| file-test | 0 | $0.002104 | $0.002129 | +1.19% |
| file-test | 1 | $0.002102 | $0.002307 | +9.75% |
| diagnostic | 0 | $0.001930 | $0.001937 | +0.32% |
| diagnostic | 1 | $0.001911 | $0.001905 | −0.33% |
| multi-step | 0 | $0.002137 | $0.002390 | +11.84% |
| multi-step | 1 | $0.002462 | $0.002505 | +1.72% |

Median paired delta **+1.45%**; total pilot cost **$0.0258** for these 12 runs.
The two high pairs came from additional model requests/longer outputs inside the
adapter turn (file-test rep1: 4 requests vs 3; multi-step rep0: 802 vs 345 output
tokens). Those are model decisions under the same tools and prompt, not injected
context or duplicated tool work. Sample is small; this is **provisional**.

Zero-inference checks (all pass, deltas exactly zero):
- 5-second idle window on a connected runtime;
- discovery (`/v1/runtime/info`, `/v1/config`, `/v1/providers`);
- thread creation and read-back;
- history read;
- event stream open/abort/reconnect.

## G2 — discovered surface and honest gaps

- 250 `/v1/*` route strings extracted from the installed binary. Not all are
  exercised; only the tested routes are listed in the ledger.
- 43 top-level CLI commands captured with `--help` and stored verbatim.
- Runtime capability flags include `turn_operation_idempotency`,
  `turn_operation_lookup`, `event_replay`, `event_stream_resume`,
  `thread_create_idempotency`, `turn_interrupt`, `turn_steer`,
  `fleet_event_stream`, `memory`, `mcp_server_management`,
  `skill_lifecycle`, `plugin_management`, `agent_mail`.
- Flags that are **false** and therefore not claimed: `terminal_stream`,
  `terminal_input`, `terminal_resize`, `terminal_kill`, `environments`.
- `agent_profile` and full command/subcommand schemas are not yet qualified;
  they belong to P15/P18.
- `/v1/runtime/info` is unauthenticated discovery metadata; stateful routes are
  bearer-protected (401 verified).

## Concurrency

Two owned runtimes on different workspaces coexisted. On Windows, a second
runtime in the **same** workspace was not refused: both created threads and both
completed simultaneous tiny turns without cross-thread history corruption. One
observation is not a safety proof, and the upstream changelog states the
per-workspace lease applies on macOS/Linux while Windows keeps its current
transport. **Mona therefore serializes mutating work per workspace by default**;
P04/P07 must own a lease before parallel execution is enabled.

## Route identity discrepancy (open)

CLI `exec` reports endpoint fingerprint `6a440b42…` while runtime turns report
`812b1f7c…` for the same provider, model, dialect, and tool schema. The wire
model (`deepseek-flash`), dialect (`openai-responses`), and tool schema hash are
identical, so this is not a model or tool divergence, but the fingerprint
difference is unexplained. It does not block P01; P03 must display the runtime
fingerprint it actually uses and P16 must resolve or explain the difference. No
silent route change is permitted.

## Upstream overlap

This build already ships `codewhale web`, `codewhale rc`, and a runtime server
with a mobile page. Mona does **not** embed or duplicate that chat client.
Mona's justification remains the Windows studio, folder launch, project
continuity, attempt ledger, and cost/evidence visibility. No engine fork.

## Spend

- G0 run: **$0.007501** (engine-reported).
- Paired pilot: **$0.025818** (engine-reported for adapter; estimate for direct).
- Trial and exploratory runs: ≈ **$0.010**.
- Runtime `/v1/usage` at end of P01: **$0.029901** across 17 runtime turns.
- Total recorded across arms is **≈ $0.04**, inside the predeclared **$2** ceiling.

## Open problems

| ID | Impact | Next |
|---|---|---|
| P01-ISSUE-001 | Exec vs runtime endpoint fingerprints differ | P03 display; P16 resolve. Not blocking. |
| P01-ISSUE-002 | Windows same-workspace lease not enforced for two runtimes | Serialized default; P04/P07 own the lease. Not blocking. |
| P01-ISSUE-003 | Terminal capability flags false on this build | Expose as unsupported with explanation; P18. Not blocking. |
| P01-ISSUE-004 | Cost sample is small and model-variance sensitive | Re-run after adapter changes per spec 9.4. Provisional, not a parity guarantee. |
