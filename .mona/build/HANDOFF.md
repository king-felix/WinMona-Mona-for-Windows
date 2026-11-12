# Mona build handoff

**Current prompt:** P11 — Enforce the three-attempt rule and clear stop controls
**Current status:** P00–P10 completed. State revision 34 (a second checkpoint
refreshed evidence hashes after the final gate runs; no work changed). Next
eligible: P11, P12, P13. P11 is the earliest eligible prompt.

**Last verified commit / dirty work:** P09 ended at `fbce731`; the P10 commit is
created after this file and the evidence are written. `last_verified_commit`
stays null because a state file cannot contain the hash of the commit that
contains it. Verify with `node tools/build/cli.mjs validate` (expect OK, r34, 0
warnings) before trusting this file.

## P10 result — bounded tasks with evidence-gated completion

Project state now holds real prompt work: each task has one explicit execution
owner (`mona_queue` or `native_workflow`), dependencies, steps, acceptance
criteria, requirement links and recorded evidence. The Mona queue runs one
eligible task and stops; a native-owned task is visible but never scheduled by
Mona. SQLite enforces one active task per workspace with a partial unique index.

- **Schema v3** (`packages/project-state/src/migrations.ts`): task description,
  owner, prompt text, ordinal, recorded step and transition timestamps, plus
  `task_steps`, `task_acceptance`, `task_evidence`, `task_requirements` and
  `task_transitions`. Triggers constrain owner and status values.
- **TaskService** (`packages/project-state/src/tasks.ts`): create/edit/remove,
  dependency validation with cycle rejection, deterministic board and selection,
  claim, step control, check recording, human acceptance, verification,
  completion, interrupt/block/skip, reconcile/resume, revalidation, context
  preview, handoff and inert plan import.
- **Completion cannot be claimed**: only `verifying` tasks complete; every
  required check and human item must be satisfied; completion re-hashes linked
  artifacts and refuses missing or stale evidence; a task with no criteria cannot
  complete. A model has no completion path through the run control.
- **Stale verification**: changed artifacts mark evidence stale and reopen a
  completed task to `verifying`. This is the one transition beyond spec 8.2,
  recorded as D-0056.
- **Resume**: `reconcile` turns an active task with no live run into
  `interrupted` and preserves its recorded step; `resumeTask` continues at that
  step or moves to verification when all steps are done.
- **Selection**: interrupted work first, then ordinal, prompt id, creation time
  and id. Every board entry explains status, prerequisite, owner and workspace
  checks. `runOnce` runs exactly one task and returns.
- **Context preview**: the exact prompt and hash that dispatch submits; only the
  task, steps, criteria, prerequisites and requirement ids. `documentsInjected`
  is always 0; over-limit prompts are refused, never silently truncated.
- **Import/export**: `mona.task-plan` is inert until `apply: true`, which creates
  pending tasks only. Project export v2 carries criteria, steps, requirement
  links and evidence; a digest-valid completion claim with an unsatisfied
  criterion is refused; exported active tasks import as `interrupted`.
- **Build ledger separation**: product tasks live in project-scoped SQLite and a
  project-local handoff. Mona's own build still uses `.mona/build` and the
  bootstrap CLI (D-0059).

Evidence: `docs/evidence/P10-continuity.md` (report and acceptance matrix),
`P10-continuity.json` + `P10-sample-log.txt` (14-step sample run, 4 tasks,
provider requests 0), `P10-tests.txt` (282 Vitest + 13 bootstrap + 12 launch +
8 spike = 315 passing), `P10-checks.txt`, `P10-build.txt`. Decisions D-0055 …
D-0059.

## Next exact action (P11)

Read P11 in `Mona_PROMPTS.md`, spec 8.4/8.5 and 10.3. Implement stable problem
IDs, the append-only attempt ledger with total and consecutive-no-progress
counters, the third-attempt block and Victor handoff card, dependency-block
propagation, and the execution boundaries for pause/interrupt/cancel. Use
P10's `blocked`/`interrupted` task states and recorded step; do not invent a
second scheduler. Keep the build attempt ledger in `.mona/build/attempts.jsonl`
separate from project attempts in SQLite.

## Relevant files and spec sections

- `packages/project-state/src/{tasks.ts,tasks.test.ts,export.ts,migrations.ts}`,
  `packages/project-state/scripts/task-run.mjs`
- P11 will also touch `packages/adapter/src/{work-control,supervisor}.ts`,
  `apps/desktop/src/main/studio-service.ts` and the task IPC/UI boundary.
- Spec 8.1 (two layers), 8.2 (task state machine), 8.4 (three-attempt rule),
  8.5 (resume), 10.3 (scheduler ownership), 17 (definition of done).

## Open problem IDs and no-progress counts

No open blocker; `attempts.jsonl` holds only the closed P02 rows.

- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift; P16.
- **P01-ISSUE-002** — one owned runtime per machine session; a launch for a
  different workspace opens the project with a caveat instead of stopping the
  runtime (live-verified by P09).
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.
- **P04-ISSUE-001** — no Job Object; `taskkill /T` plus reconcile.
- **P04-ISSUE-002** — close-to-tray still has no tray affordance; P23 packaging.
- **P05-ISSUE-001** — maintenance barrier is in-process (D-0032).
- **P06-ISSUE-002** — no human screen-reader pass yet; P22 owns it.
- **P07-ISSUE-001** — probe scripts still default to fixed historical paths when
  prompt-scoped `MONA_*` output variables are absent.
- **P08-ISSUE-001** — `packages/contracts` models four engine event names; the
  studio projects the rest by name in the desktop service; revisit at P16/P18.
- **P08-ISSUE-002** — approval waits are surfaced and interruptible; Mona still
  has no qualified approval-response route.
- **P08-ISSUE-003** — the engine writes its own `.codewhale/state/*` into a
  workspace during a turn; evidence for P22 documentation.
- **P09-ISSUE-001** — the classic registration names the development Electron
  binary and repository path until P21/P23 install a packaged executable.
- **P09-ISSUE-002** — Explorer's own placement ("Show more options") and a human
  click are not programmatically verifiable.
- **P10-ISSUE-001** — the task engine has no renderer work-board surface yet. The
  board, reasons and selection API are tested; the UI is left to the later UI
  prompts rather than adding an unrequested screen in P10.
- **P10-ISSUE-002** — `runOnce` has a tested executor boundary but is not yet
  wired to `StudioService`. P11 owns pause/interrupt/cancel process behavior and
  is the natural point to connect the queue to live engine turns.
- **P10-ISSUE-003** — native-workflow execution is recorded as an owner but a
  real native workflow dispatcher is P15.

## Blocked dependencies

None.

## Last relevant validation

- `npm test` → 282 Vitest (29 files; +24 in P10); bootstrap 13, launch 12,
  spike 8 → 315 passing.
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  290.35 kB (gzip 87.39 kB).
- `npm run typecheck`, `npm run lint`, `npm run format:check` → pass.
- `node tools/build/cli.mjs validate` → OK, r34, 0 warnings after the final P10
  checkpoint refreshed the evidence hashes.
- `node packages/project-state/scripts/task-run.mjs` → 4 tasks, 14 steps,
  create/reconcile/resume/human-completion/stale-revalidation all recorded;
  provider requests 0.
- Spend: zero. Every P10 check ran locally without a provider request.

## Human input needed

None to continue P11. One standing human acceptance item for P21/P22: right-click
a folder and a folder background in Explorer and choose **Start new DS project
with Mona** (possibly under **Show more options**). The registration currently
points at the development build; remove it with
`npm run launch:menu -- unregister` or replace it at install time.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and
`catalog-probe.ts` in P07; `check-build.mjs` fails on mojibake. The remaining
`Â·`/`â€™` sequences in `DECISIONS.md` and older handoff text are quoted examples
of that incident, not corrupted text.
