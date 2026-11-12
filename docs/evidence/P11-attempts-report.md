# P11 — Enforce the three-attempt rule and clear stop controls

**Status: completed.** Requirements MONA-011 and MONA-012 are now backed by
mechanical enforcement, not by a model's promise to stop.

## What was delivered

- **Stable problem identity.** `AttemptService.openProblem` derives
  `prb_<sha256(project + symptom fingerprint)>`, so a new session that meets the
  same symptom lands on the same counter. The unique index on
  `(project_id, symptom_fingerprint)` enforces it in SQLite too.
- **Append-only attempt ledger.** Migration v4 adds `problems`,
  `problem_transitions` and extends `attempts` with `requirement_id`,
  `attempt_no`, `progress_reason`, `actor` and `kind`. Every attempt records the
  hypothesis, action, observed result, evidence path and the resulting counter.
- **Two counters, one resettable.** `total_attempts` only grows.
  `consecutive_no_progress` resets only for an attempt with
  `materialProgress: true` and a `progressReason`; supplying one without the
  other is refused with `invalid_request`.
- **Stop at three.** The third consecutive no-progress attempt blocks the problem
  in the same transaction, records `blocked_at` and requires `helpNeeded`. A
  fourth `recordAttempt` throws `not_eligible`.
- **Victor handoff card.** `handoffCard(problemId)` returns the problem, the
  three attempts, their evidence paths, the counters, the required help, and an
  explicit `acknowledgmentDoesNotReset: true`.
- **Acknowledgement is not progress.** `acknowledge` writes a same-status
  transition (audited) and leaves both counters untouched.
- **Reopen is evidence-gated.** `reopenProblem` requires an evidence path or an
  actor of `victor`; the total attempt count survives and only the consecutive
  counter resets, with the reason and evidence in `problem_transitions`.
- **Dependency-block propagation.** A blocked problem blocks its task
  (`TaskService.blockTask`), and every task that depends on it becomes
  ineligible with `blockedByProblemIds` naming the problem. Independent tasks
  stay eligible and are selected.
- **Mechanical dispatch guard.** `TaskService.claim`, `resumeTask` and
  `AttemptService.assertDispatchable` refuse a task with a blocked problem. This
  runs before dispatch; there is no bypass path.
- **Blocker-paused queue.** `WorkQueue.blockOnProblem` puts the queue in
  `blocked`; `startNext` returns null and `resumeQueue` is rejected until
  `releaseProblem(problemId)` is called with the right id. The studio reports it
  through `StudioControl.blockedProblem` and the renderer shows the card.
- **Honest stop controls.** `pauseAfterTask({ nativeDispatcherActive })` returns
  `outcome: 'partial'` when a native workflow owns the run, naming it, instead of
  implying Mona stopped work it does not own. Interrupt, cancel-queued and
  quit-and-stop keep their existing distinct receipts and `rollback_claimed:
  false`.
- **Enforcement-boundary document.** `docs/evidence/P11-attempts.md` states what
  is mechanical, what is cooperative (`ENGINE_ATTEMPT_INSTRUCTION`), and what
  Mona cannot observe.

## Acceptance matrix

| P11 acceptance item | Result | Where |
|---|---|---|
| Fixture sequence 1/2/3 blocks at three | pass | `attempts.test.ts` "blocks a problem at the third..." |
| Material progress resets only the consecutive counter | pass | `attempts.test.ts` "resets only the consecutive counter..." |
| Session restart retains the count | pass | `attempts.test.ts`, sample step "new session reads the persisted counter" |
| Manual acknowledgement changes nothing | pass | `attempts.test.ts`, sample step "acknowledge" |
| Dependency block propagates | pass | `attempts.test.ts`, sample "board after the block" |
| Independent task continues | pass (`next` = independent task) | `attempts.test.ts`, `P11-sample.json` |
| Fourth hidden retry rejected in Mona logic | pass (`not_eligible`) | `attempts.test.ts`, sample "fourth attempt refused" |
| Uncertain interruption shown honestly | pass (`outcome_unknown`, active work kept) | `work-control.test.ts` |
| Native-owned pause not overstated | pass (`partial` + detail) | `work-control.test.ts`, `studio-service.test.ts` |
| Engine-internal loops stated, not overstated | pass | `docs/evidence/P11-attempts.md` |

## Evidence

- `docs/evidence/P11-attempts.md` — enforcement boundary document.
- `docs/evidence/P11-sample.json` — deterministic 13-step run against real
  SQLite: open, two no-progress attempts, acknowledge, restart read, third
  attempt blocks, fourth refused, board with propagation, reopened with evidence,
  audit trail. `providerRequests: 0`.
- `docs/evidence/P11-13-gates.txt` — `npm test` (321 Vitest + 13 bootstrap + 12
  launch + 8 spike = 354 passing).
- `docs/evidence/P11-13-checks.txt` — typecheck, lint, format, build-state
  validate.
- `docs/evidence/P11-13-build.txt` — production build plus the desktop bundle
  check.

## Known limits

- Engine-internal loops remain cooperative. The pinned runtime has no event that
  identifies a semantic attempt, and Mona does not guess from error strings.
- The work-board UI surface is still P10-ISSUE-001; the blocked-problem card
  renders in the studio, not on a work board.
- `runOnce` still has no live `StudioService` wiring (P10-ISSUE-002); the guard
  is enforced in the task service where every dispatch path already passes.
