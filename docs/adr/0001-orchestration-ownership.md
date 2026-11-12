# ADR 0001 — Native orchestration has one owner per task

- Status: accepted
- Date: 2026-11-12
- Prompt: P15 (MONA-018, MONA-019)
- Engine: Codewhale 0.10.2 (ff466b2ed0bf)

## Context

Codewhale already ships native sub-agents, goals, fleet runs, workflow lanes and
durable receipts. Mona must make that work visible and controllable without
becoming a second agent engine. Spec 10.3 is explicit: one execution owner per
task; parallel Mona task execution needs isolated worktrees, separate branch
ownership, aggregate budgets, a merge/review step and native support.

## Decision

1. **The engine is the executor.** Mona reads `/v1/goals`, `/v1/tasks`,
   `/v1/agent-runs`, `/v1/fleet/runs` and turn artifacts. It never creates a
   parallel run loop, never re-implements sub-agent scheduling and never copies a
   child task into Mona's queue.
2. **One ownership value is shown and enforced.** Each project has exactly one
   active owner: `none`, `mona_queue`, `native_goal`, `native_fleet` or
   `native_agent`. When a native owner is active, `StudioService.submit` refuses
   a new Mona-queued turn with an explicit message. When Mona's queue owns the
   turn, native starts are refused the same way.
3. **A goal is a native start, not a label.** `PUT /v1/threads/{id}/goal` starts
   a goal kickoff turn in the engine. Mona treats creation as a native owner and
   does not submit the same objective itself.
4. **A fleet start is reported exactly.** `POST /v1/fleet/runs/{id}/start` can
   answer `execution: scheduled` with `leased: 0`. Mona polls briefly for a
   lease and, when none appears, says so: the run remains queued and this runtime
   build did not start a local supervisor. It does not report a worker as
   running.
5. **Serial by default.** Mona creates fleet runs with one task, one worker and
   `max_workers: 1`. No UI control starts multiple builders on one mutable tree.
6. **Spend is counted once.** A child sub-agent's reported cost is part of the
   parent thread's routed usage on this engine. Mona marks the child
   `spendIncludedInParent` and computes the aggregate from the parent thread
   total once. A child with unreported usage stays `unknown`; it is never zero.
7. **No credential handoff.** Fleet roles and sub-agents inherit the engine's
   configured route. Mona does not copy keys into process arguments, child specs
   or project files.

## Consequences

- The observatory is an observability surface with explicit controls, not a
  scheduler. Its start/stop/interrupt actions return engine receipts.
- A runtime that only schedules fleet runs (as the app-server transport did in
  the P15 run) leaves the run queued. That is recorded as P15-ISSUE-001, not
  hidden behind a success state.
- Parallel Mona task execution remains unavailable until isolated worktrees,
  branch ownership, aggregate budgets and a merge/review boundary are qualified.

## Evidence

- `docs/evidence/P15-surface-raw.json` — empty native lists and 405/404 control
  surfaces.
- `docs/evidence/P15-agent-run.json` — one real delegated run: `agent.spawned`,
  `agent.completed`, child usage 678 µUSD, parent thread total 5,731.872 µUSD
  including the child, 119 events.
- `docs/evidence/P15-agents.md` — acceptance mapping and limitations.
