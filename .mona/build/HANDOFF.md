# Mona build handoff

**Current prompt:** P14 — Deliver the daily-use polish without inference overhead
**Current status:** P00–P13 completed. State revision 41 (three refresh
checkpoints updated evidence hashes after the final gate runs; no work changed).
Next eligible: P14, P15,
P16. P14 is the earliest eligible prompt and needs P10–P13, all now complete.

**Last verified commit / dirty work:** P13 ended at the commit created after this
file and the evidence were written. `last_verified_commit` stays null because a
state file cannot contain the hash of the commit that contains it. Verify with
`node tools/build/cli.mjs validate` (expect OK, r41, 0 warnings) before trusting
this file.

## P11 result — the three-attempt rule, enforced and bounded

- **Schema v4**: `problems` (unique on project + symptom fingerprint),
  `problem_transitions`, and `attempts` extended with `requirement_id`,
  `attempt_no`, `progress_reason`, `actor`. Migration v1's table is extended, not
  replaced.
- **`AttemptService`** (`packages/project-state/src/attempts.ts`): stable
  `prb_<sha256>` ids; `total_attempts` append-only; `consecutive_no_progress`
  reset only by an attempt with both `materialProgress` and a `progressReason`;
  the third no-progress attempt blocks with required `helpNeeded`; a fourth
  `recordAttempt` throws `not_eligible`.
- **Acknowledgement is an audit event**, not progress: `acknowledge` writes a
  same-status transition and leaves both counters untouched. `reopenProblem`
  needs evidence or a Victor actor; the total survives.
- **Propagation**: a blocked problem blocks its task, and `eligibilityFor` marks
  every dependant ineligible with `blockedByProblemIds`. Independent tasks stay
  eligible and are selected. `claim`, `resumeTask` and `assertDispatchable`
  refuse a blocked task.
- **Blocker-paused queue**: `WorkQueue.blockOnProblem` / `releaseProblem`, state
  `blocked`, surfaced as `StudioControl.blockedProblem` and a renderer card.
- **Honest native pause**: `pauseAfterTask({ nativeDispatcherActive })` returns
  `partial` and names the native workflow instead of implying Mona stopped it.
- **Boundary document**: `docs/evidence/P11-attempts.md` separates mechanical,
  cooperative and unobservable enforcement. `ENGINE_ATTEMPT_INSTRUCTION` is the
  stable cooperative text.

## P12 result — a cost ledger with three origins and disclosed limits

- **Schema v5**: usage record origins (`cost_source`, `rate_revision`,
  `dedupe_key`, `task_id`, `parent_turn_id`, `unknown_reason`, cache/input/
  reasoning token columns), `rate_cards`, `budgets`, `budget_reservations`,
  `budget_events`. A partial unique index on `dedupe_key` makes replay
  idempotent in the database.
- **`CostLedger`** (`packages/project-state/src/costs.ts`): revisioned rates,
  duplicate-safe ingest, per-turn/task/session `lens`, explicit `recalculate`,
  CSV export with a per-row origin label, optional session/project/day budgets
  with reservations.
- **`estimateCost`** and **`dayWindow`** are pure and tested: exact micro-USD
  arithmetic, inclusive/exclusive cache semantics, separately-billed reasoning
  only when a rate exists, and a deterministic local-day window.
- **Studio gate**: `submit` evaluates budgets first; `block_next_dispatch` refuses
  the submit with the decision detail, `warn` records a diagnostic. In-flight
  turns are never interrupted for cost.
- **Zero-inference proof**: a test drives `view`/`pause`/`resume`/refused submit
  through the real service and asserts zero adapter thread opens and zero
  submissions.

## P13 result — changes, receipts, Git and restore

- **Schema v6**: `change_baselines`, `test_receipts`, `restore_receipts`.
- **`ChangeService`**: baseline hash maps with explicit exclusions; change
  reports with `tool_recorded` vs `unattributed`; bounded Git-only text diffs;
  test receipts with bounded output artifacts; restore preview and restore.
- **`GitService`**: porcelain v1 with `-z`, conflict codes separated, worktree
  detection, `execFileSync` argv only, path validation.
- **Selected commits**: `git commit -m <msg> -- <paths>` so unrelated staged work
  is untouched (verified against a real repository).
- **`writeFileFresh`**: hash-guarded writes via fsynced temp + rename; a mismatch
  is a `conflict`.
- **Restore**: refused for staged, conflicted, untracked or changed-after-preview
  paths; a non-Git folder reports restore as unsupported and no snapshot engine
  was invented.

## Next exact action (P14)

Read P14 in `Mona_PROMPTS.md` and spec 12. Implement the Resume Brief, "Since you
left" digest, Focus Mode, tray attention and quiet hours **from recorded state
only** — no summarizer, no background inference. Reuse `TaskService.handoff`,
`AttemptService.summary`, `CostLedger.totals` and `ChangeService.diff` as the
deterministic inputs instead of adding a second source of truth.

## Relevant files and spec sections

- `packages/project-state/src/{attempts,costs,git,changes}.ts` (+ `.test.ts`),
  `migrations.ts` (v4–v6), `tasks.ts` (problem-aware eligibility and claim),
  `scripts/{attempt-run,cost-lens,change-run}.mjs`
- `packages/adapter/src/work-control.ts` (`blocked` state, partial native pause)
- `apps/desktop/src/main/studio-service.ts` (budget gate, blocker state),
  `apps/desktop/src/renderer/StudioPanel.tsx` (blocked-problem card)
- Spec 8.4, 8.5, 9.3, 10.3, 11, 12; O3.

## Open problem IDs and no-progress counts

No open blocker. `attempts.jsonl` still holds only the closed P02 rows; the
three-attempt rule is now product code, and the Mona build ledger uses the same
semantics by hand.

- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift; P16.
- **P01-ISSUE-002** — one owned runtime per machine session; a launch for a
  different workspace opens the project with a caveat instead of stopping the
  runtime (live-verified by P09).
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.
- **P04-ISSUE-001** — no Job Object; `taskkill /T` plus reconcile.
- **P04-ISSUE-002** — close-to-tray still has no tray affordance; P14/P23.
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
- **P10-ISSUE-001** — the task engine has no renderer work-board surface yet.
- **P10-ISSUE-002** — `runOnce` is not yet wired to `StudioService`. The
  three-attempt guard is enforced in `TaskService`, which every dispatch path
  passes, so the rule holds without the wiring.
- **P10-ISSUE-003** — native-workflow execution is recorded as an owner; a real
  native dispatcher is P15. `nativeDispatcherActive` is a probe seam until then.
- **P11-ISSUE-001** — engine-internal attempt loops remain cooperative. The
  pinned runtime exposes no per-attempt event; parsing error strings would be a
  guess and was not done (D-0064).
- **P12-ISSUE-001** — the cost lens has no renderer surface; the cost screen still
  shows the P07 aggregate. Views, attribution and export are tested on the ledger.
- **P12-ISSUE-002** — budgets gate only Mona's outer dispatch; a running turn can
  overshoot. Disclosed in every evaluation and in the ADR.
- **P12-ISSUE-003** — `StudioService` does not attribute turn usage to a task id
  yet; the ledger supports it, the wiring belongs with P10-ISSUE-002.
- **P13-ISSUE-001** — no renderer surface for the change list, diff viewer or
  test cards; MONA-014 `diffs` therefore stays `pending` (its criterion asks for
  virtualized rendering).
- **P13-ISSUE-002** — attributed changes need a persisted per-task tool-touch set;
  today the studio only has the live run's paths.
- **P13-ISSUE-003** — restore covers HEAD only; restoring to an earlier commit
  needs an explicit revision picker plus the same hash guard.

## Blocked dependencies

None.

## Last relevant validation

- `npm test` → 321 Vitest (32 files; +31 across P11–P13) + bootstrap 13 + launch
  12 + spike 8 = 354 passing (`docs/evidence/P11-13-gates.txt`).
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  291.07 kB (gzip 87.57 kB). `check:build` → 4 renderer files, CSP replaced, no
  fixtures, no credentials, 27 named preload channels
  (`docs/evidence/P11-13-build.txt`).
- `npm run typecheck`, `npm run lint`, `npm run format:check` → pass
  (`docs/evidence/P11-13-checks.txt`).
- `node tools/build/cli.mjs validate` → OK, r41, 0 warnings.
- `node packages/project-state/scripts/attempt-run.mjs` → 13 steps, provider
  requests 0 (`docs/evidence/P11-sample.json`).
- `node packages/project-state/scripts/cost-lens.mjs` → provider requests 0,
  CSV at `docs/evidence/P12-cost-export.csv`.
- `node packages/project-state/scripts/change-run.mjs` → provider requests 0, a
  real throwaway Git repository.
- Spend: zero. Every P11–P13 check ran locally without a provider request.

## Human input needed

None to continue P14. One standing human acceptance item for P21/P22: right-click
a folder and a folder background in Explorer and choose **Start new DS project
with Mona** (possibly under **Show more options**). The registration currently
points at the development build; remove it with
`npm run launch:menu -- unregister` or replace it at install time.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and
`catalog-probe.ts` in P07; `check-build.mjs` fails on mojibake. The remaining
`Â·`/`â€™` sequences in `DECISIONS.md` and older handoff text are quoted examples
of that incident, not corrupted text.
