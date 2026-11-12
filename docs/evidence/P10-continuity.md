# P10 — Prompt execution and durable continuation

**Status:** completed. Every P10 acceptance item is exercised by the task-state
tests and the sample project run; no model request was made.

Mona can now turn a bounded prompt into a durable task with prerequisites,
acceptance criteria, requirement links, an explicit execution owner and a
deterministic resume point. Completion is refused unless recorded evidence still
matches the workspace. The product keeps this state in project-scoped SQLite and
never reuses or edits Mona's own build ledger.

## What was delivered

- **Schema v3** (`packages/project-state/src/migrations.ts`): task description,
  owner, prompt text, ordinal, recorded step and transition timestamps; plus
  `task_steps`, `task_acceptance`, `task_evidence`, `task_requirements` and
  `task_transitions`. Trigger checks keep owner and status vocabularies honest.
- **One active task per workspace** is a partial unique index on
  `tasks(project_id)` for `running`/`verifying`, not a scheduler convention.
- **Task service** (`packages/project-state/src/tasks.ts`): create, edit, read,
  remove, dependency add/remove, board, deterministic selection, claim, step
  control, evidence recording, human acceptance, verification, completion,
  interrupt, block/unblock, skip, reconcile, resume, revalidation, context
  preview, handoff and plan import.
- **Execution ownership** is stored per task. Mona's queue claims only
  `mona_queue` tasks; a `native_workflow` task is visible on the board but never
  selected or claimed by Mona.
- **State machine** follows spec 8.2: `pending -> running -> verifying ->
  completed`, with `blocked`, `interrupted`, `skipped` and the resume edges. The
  single extension is `completed -> verifying` when later code changes make
  recorded evidence stale.
- **Evidence-gated completion**: a check records the SHA-256 of a real
  project-relative artifact (or verifies a supplied hash against it). Completion
  re-hashes linked artifacts, rejects stale or missing evidence, requires all
  required check and human criteria, and refuses a task with no configured
  criteria. A model's claim is not a completion path.
- **Stale verification**: `revalidate` marks evidence stale and reopens a
  completed task to `verifying`. `completeTask` performs the same hash check even
  without an explicit revalidate, so a late file change cannot slip through.
- **Resume**: `reconcile` marks an active task with no live run as `interrupted`
  and keeps its recorded step. `resumeTask` verifies prerequisites, resumes at
  the recorded step, or moves to verification when every step is already done.
- **Selection**: interrupted work first, then ordinal, prompt id, creation time
  and id. Every board entry carries its status, prerequisite, owner and workspace
  checks plus a human-readable reason. `runOnce` runs exactly one selection and
  returns; the queue never loops into a second task.
- **Context preview**: the exact prompt text and hash that dispatch will submit;
  it contains the selected task, steps, acceptance criteria, prerequisites and
  requirement ids. Whole design or prompt documents are never injected
  (`documentsInjected: 0`), and an over-limit prompt is refused rather than
  silently truncated.
- **Plan import**: `mona.task-plan` is schema-checked, cycle-checked and inert by
  default. `apply: true` creates pending tasks only. Every task must name its
  owner; a plan cannot smuggle in an implicit scheduler.
- **Export/import**: project export schema v2 carries task criteria, steps,
  requirement links and evidence. Import refuses a digest-valid document that
  claims completion with an unsatisfied criterion and turns an exported active
  task into `interrupted`.
- **Handoff**: a deterministic short Markdown handoff from recorded state
  (current/next task, recorded step, completion gaps, verified work, blockers,
  workspace and evidence), written atomically when a path is supplied.

## Acceptance evidence

| P10 acceptance item | Where it is proved |
|---|---|
| Dependency cycles rejected | `tasks.test.ts` cycle/self/cross-workspace test; cyclic plan test |
| Completed prerequisites verified | dependent task is ineligible and unclaimable until its prerequisite completes |
| Interrupted task resumes at recorded step | `reconcile` then `resumeTask` test, plus the sample run |
| Out-of-order independent work keeps accurate status | ordinals 1/2/3 test; independent task remains `pending` in the sample |
| Two workspaces do not share task ownership | one-active-per-project refusal; second project claim succeeds; native task unclaimable |
| Explicit queue runs its selection and stops | `runOnce` returns after one task; the next call selects the next; the third reports none |
| User-authored criteria survive import/export | project export v2 round trip asserts criteria, prompt text and requirement links |
| Completed is not a model claim | unsatisfied check, open human item and no-criteria task all refuse completion |
| Code change invalidates test evidence | explicit `revalidate` and late-hash completion test both reopen to `verifying` |
| Exact context review | preview text/hash equals the claim prompt; no documents injected |
| Build ledger stays separate | handoff names project SQLite; D-0059 records the boundary |

## Sample project run

`packages/project-state/scripts/task-run.mjs` opens a fresh local state
directory, registers a temporary workspace, creates four tasks and drives the
real service with a deterministic local executor. It records 14 steps:

1. `Create greeting` completed from a recorded check.
2. A two-step task was started, reconciled with no live run, resumed at step two
   and completed.
3. `Review greeting` stopped in `verifying` until the human criterion was
   explicitly accepted, then completed.
4. `greeting.txt` changed; revalidation marked the first task's evidence stale
   and reopened it, a fresh check restored completion.
5. `Independent polish` remains pending and is the deterministic next selection.

The JSON capture is `docs/evidence/P10-continuity.json`; the sample made zero
provider requests and used no network.

## Limitations kept honest

- The work-board **data** surface is complete (board, reasons, criteria,
  dependencies, next selection). A rendered board view is not part of P10's
  execute list; the API is ready for the UI prompts.
- Three-attempt enforcement, attempt counters and blocker cards remain P11. This
  prompt implements the `blocked` state and transition, not the policy that
  decides when to enter it.
- Pause-after-task / interrupt-now / cancel-queued process behavior remains P11;
  P10 owns the task status and recorded step they will act on.
- A task's evidence paths are project-relative. Artifacts outside the workspace
  are refused, not copied or trusted.
- No task is dispatched by the desktop UI yet. `runOnce` is the tested dispatch
  boundary; the studio submission path is unchanged and still requires a user
  send.

## Validation

- `npm test` → 282 Vitest + 13 bootstrap + 12 launch + 8 spike = 315 passing.
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  290.35 kB (gzip 87.39 kB).
- `npm run typecheck`, `npm run lint`, `npm run format:check` → pass.
- `node tools/build/cli.mjs validate` → see the checkpoint report.
- Spend: zero. No provider request was made by the task tests or sample run.

Decisions D-0055 … D-0059 record owner enforcement, evidence-gated completion,
inert imports, deterministic selection and the two-layer state boundary.
