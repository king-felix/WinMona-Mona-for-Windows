# W13 — Prompt Runner contract and durable state model

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · source `960e00c` + this change set.

Status: **complete for the contract and state model.** No execution, import or UI is claimed here;
those are W14–W17. Verified by `packages/project-state/src/runner.test.ts` (15 tests) inside the
package suite (`npx vitest run packages/project-state`, 169 pass).

## What was added

- **`packages/project-state/src/runner.ts`** — `RunnerService` plus the versioned report schema.
  It schedules the existing `tasks` rows rather than growing a second task engine: the run only
  freezes order and per-task prompt hashes; task lifecycle, criteria, evidence and problems stay
  where they already are.
- **Migration 10 (`prompt-runner`)** — `prompt_runs`, `prompt_run_transitions`, `prompt_run_tasks`,
  `prompt_dispatches`, `runner_reports`, with check constraints and two partial unique indexes:
  one unsettled dispatch per workspace, and at most one accepted report per dispatch.
- **`index.ts`** — the module is exported from `@mona/project-state`.

## The identities and what carries them

- **Run** — `prompt_runs`: project, title, source path/hash/revision, `plan_revision`,
  `plan_sha256` over the frozen `(position, task, prompt hash)` list, policy JSON, status
  (`draft|running|paused|completed|blocked|cancelled`), stop reason, start/end.
- **Task** — the existing `tasks` row. `createRun` refuses a task from another project, a task
  owned by `native_workflow`, a task with no prompt text, duplicates, an empty selection and more
  than 500 tasks.
- **Dispatch** — `prompt_dispatches`: `operation_key` unique per run, frozen prompt hash, session
  id, engine thread id, engine turn id, continuation index, transport state
  (`recorded|accepted|turn_completed|reported|uncertain|failed`).
- **Thread / turn** — engine identity supplied by the controller (`bindTurn`,
  `markTurnCompleted`), never guessed by the agent. Rebinding a dispatch to a different turn is
  refused.
- **Problem** — the existing stable `problems` rows from the attempt ledger; a report may only
  cite recorded problems for that task.
- **Human request** — the existing `human_requests` table (migration 9); `needs_human` reports
  carry questions, and W16 owns turning them into inbox records.
- **Report** — `runner_reports`, one row per submission, accepted or rejected, with the reason,
  the raw JSON, its sha256 and size.

## Distinctions the code enforces (not merely documents)

- **Send ≠ acceptance ≠ turn completion ≠ task completion.** `markAccepted` only moves
  `recorded → accepted`. `markTurnCompleted` requires the engine's turn id. `submitReport` is
  accepted only after the engine's own turn completion. Nothing in this module changes a task's
  status or records evidence; `TaskService.completeTask` and its evidence gate remain the only
  completion path.
- **Stale / mismatched / partial reports are refused.** A report must bind to the exact
  run/task/dispatch/prompt hash; a second accepted report for one dispatch is refused; unknown
  fields are rejected by `strict()` (so a report cannot add tasks or verifier commands);
  `ready_for_verification` with any unmet/unknown claim is contradictory; `needs_human` without a
  question is refused; `blocked` without a problem or question is refused; over 64 KiB is refused
  at the boundary.
- **Workspace containment includes reparse points.** Paths must be workspace-relative, must exist,
  must be files, and the resolved real path (junction/symlink followed) must still sit under the
  real workspace root. Tests cover `..`, absolute paths, a missing file, a wrong hash and a junction
  to an outside directory (created with `mklink /J`, skipped only if the privilege is unavailable).
- **One mutating dispatch per workspace**, enforced by a partial unique index and a clear service
  error, mirroring the task engine's `tasks_active_per_project`.
- **Continuations are bounded.** `continuationAllowance` (default 3, max 10) is counted from the
  dispatch rows; the extra dispatch is refused with a message that says increasing it is a human
  decision, not a retry. `reportRepairAllowance` is capped at 1 by the service.
- **Unknown outcomes reconcile read-only.** `reconcile()` moves unsettled dispatches to
  `uncertain`; `markTurnCompleted` then refuses to retry them. A deliberate new dispatch needs a
  new operation key.
- **Reports are files with a controlled path.** `reportRelativePath` assigns
  `.mona/runner/reports/<dispatchId>.json`; `writeReportFile` writes atomically (temp + rename);
  `readReportFile` re-applies containment and the size cap.

## Migration and backup

`runner.test.ts` opens a database at schema v9, registers a project and task, then applies
migration 10 and checks the project, canonical path, task row and new tables. A second test opens
the same v9 database through `openState()`: it records a pre-migration backup at schema version 9,
applies migration 10, and the task is still readable at schema 10.

## Economics

No provider request, no runtime, no paid layer. The service only reads and writes local SQLite
rows; the module contains no HTTP client and no model call, and it does not start a thread.
