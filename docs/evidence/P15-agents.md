# P15 — Native agents, goals, fleets and workflows

- Prompt: P15
- Requirements: MONA-018 (agent observatory), MONA-019 (native goals, fleets,
  workflows, runs and artifacts without a competing scheduler)
- Engine: Codewhale 0.10.2, commit `ff466b2ed0bf`
- Date: 2026-11-12
- Status: completed with one recorded engine limitation (P15-ISSUE-001)

## Delivered behavior

- **Native surfaces read through the authenticated runtime API.**
  `packages/adapter/src/native.ts` projects `/v1/goals`,
  `/v1/threads/{id}/goal`, `/v1/tasks`, `/v1/agent-runs`, `/v1/fleet/runs`,
  fleet receipts and turn artifacts into strict contract types. Unknown fields
  are preserved in the wire shape and never invented in the projection.
- **Agent observatory.** `apps/desktop/src/main/agent-observatory.ts` builds a
  flat parent/child node graph (thread, goal, agent, fleet run, fleet task,
  worker), an explicit ownership record and a one-owner rule. The renderer
  surface is `apps/desktop/src/renderer/AgentsPanel.tsx` with a new Agents
  section (Alt+4) and nine validated IPC channels.
- **Controls.** Create a serial fleet run (one task, one worker,
  `max_workers: 1`), start/stop a run, interrupt a worker, cancel a child agent
  or native task, create/complete a native goal. Every action returns the engine
  receipt; nothing claims a lease or completion the engine did not report.
- **One scheduler.** `StudioService.submit` refuses a turn while a native owner
  is active; native starts are refused while Mona's queue owns the turn. The
  rule is data in `OwnershipView`, not prose.
- **Spend without double counting.** Child usage reported by the engine is
  marked `spendIncludedInParent`; the aggregate equals the parent thread total
  once. A child with no usage stays `unknown`.
- **Real delegated run.** One parent turn delegated a one-word read-only task
  through the native `agent` tool. Both `agent.spawned` and `agent.completed`
  were observed, plus `GET /v1/agent-runs`.

## Acceptance evidence

| Acceptance item | Evidence |
|---|---|
| One real small delegated run | `P15-agent-run.json`: 119 events, `agent.spawned` seq 2088, `agent.completed` seq 2095, child `agent_b659284a`, thread `thr_2291035a27c24f958f1c4d493f80f650` |
| Parent/child totals do not double count | Child usage `cost_microusd: 678`; thread total `0.005731872` includes the child's routed usage; observatory aggregate uses the parent total once (`agent-observatory.test.ts`) |
| Child failure, disconnect, unknown usage, blocked dependency, cancel, partial completion | Fixtures and tests in `agent-observatory.test.ts` and `native.test.ts`: unknown usage, missing lease, ownership conflict, disconnected workspace, cancel/stop receipts. Engine-side failure states are mapped by name, never invented |
| Ownership is clear | `OwnershipView` and the one-owner guard; ADR `docs/adr/0001-orchestration-ownership.md` |
| Merge conflicts stop integration without deleting branches | Not enabled: Mona starts no parallel builder. The serial-only refusal is the current honest state (P15-ISSUE-002) |
| Missing native features and platform gaps | P15-ISSUE-001 below; capability rows updated in `docs/codewhale-capabilities.json` |

## Observed native contract

- `GET /v1/goals` → `{ goals: [...] }`; `PUT /v1/threads/{id}/goal` requires
  `objective` and starts a goal kickoff turn.
- `GET /v1/agent-runs` → `{ runs: [...], governor: { launch_slots, ... } }`.
  A parent's `actor_kind` is `subagent`; child route and usage are reported on
  the run record.
- `GET /v1/fleet/runs` → `{ status, runs }`; a run carries tasks, worker specs,
  labels and lifecycle status.
- `POST /v1/fleet/runs` requires `name`, `target` (`this_computer`),
  `roles`, `workflow { id, kind: "parallel", tasks }`. A task requires `id`,
  `name`, `instructions` and `worker.role`.
- `POST /v1/fleet/runs/{id}/start` returned `execution: "scheduled"`,
  `leased: 0`, `queued: 1`, `worker_ids: [...]`. No worker lease was observed
  within 180 s and no token or cost moved.
- `GET /v1/threads/{id}/turns/{turnId}/artifacts` is the artifact route; a
  missing route returns a typed failure, not an empty list.

## Open issues

- **P15-ISSUE-001 — local fleet start schedules but does not lease.** The
  app-server runtime accepted the start and listed a local worker id, but the
  run stayed `queued` and the task stayed `enqueued` for 180 s. Usage before and
  after were identical (zero inference). Mona surfaces this exactly and does not
  fake execution. A foreground `codewhale fleet run` supervisor or a later
  runtime build may be required; re-qualify at P18/P20.
- **P15-ISSUE-002 — parallel execution is not offered.** The engine advertises
  fleet concurrency, but Mona starts one task and one worker. Isolated
  worktrees, branch ownership, aggregate budgets and a merge/review boundary
  remain unqualified, so parallel builder runs are explicitly unavailable.
- **P15-ISSUE-003 — agent-run history is engine-owned.** Records are readable
  while the runtime is alive. Mona does not copy full child transcripts into its
  database; a stopped runtime leaves the last observed projection, labeled
  stale.

## Evidence files

- `docs/evidence/P15-surface-raw.json` — GET shapes and control method probes.
- `docs/evidence/P15-agent-run.json` — the real delegated run.
- `docs/evidence/P15-tests.txt` — Vitest results.
- `docs/evidence/P15-checks.txt` — typecheck, lint, format and build checks.
- `docs/evidence/P15-build.txt` — production build output.
- `docs/adr/0001-orchestration-ownership.md` — the ownership decision.

## Spend

The delegated run cost 5,731.872 µUSD (0.005731872 USD) for two priced turns,
including the child's 678 µUSD. No other P15 check contacted a provider.
