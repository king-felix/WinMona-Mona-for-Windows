# P11 enforcement boundary

What Mona guarantees mechanically, what it can only request, and what it cannot
see. This document is the honest boundary required by spec 8.4 and prompt P11.

## The rule

An **attempt** is one hypothesis-driven effort followed by an observed result.
A **problem** is one stable unresolved symptom. Mona keeps, per problem:

- a stable `problem_id` derived from `sha256(project_id + symptom_fingerprint)`,
  so a new session that meets the same symptom cannot mint a fresh counter;
- `total_attempts`, append-only and never renumbered;
- `consecutive_no_progress`, reset to zero only by an attempt that carries
  `material_progress = true` **and** a recorded `progress_reason`. Supplying one
  without the other is refused;
- the stop threshold (spec: 3).

`AttemptService.recordAttempt` writes the attempt row and the counters in a
single transaction before returning any continuation decision. When the counter
reaches the threshold the same transaction sets `status = 'blocked'`, records
`help_needed` and `blocked_at`, and appends a `problem_transitions` row. A fourth
`recordAttempt` on a blocked problem throws `not_eligible`; there is no code path
that produces a fourth attempt.

## Mechanically enforced (Mona owns the loop)

| Boundary | Mechanism | Evidence |
|---|---|---|
| Attempt ledger is append-only | v4 `problems` / `problem_transitions`, `attempts` extended with `attempt_no`, `progress_reason`, `actor` | `attempts.test.ts` |
| Fourth attempt impossible | `recordAttempt` refuses on `status = 'blocked'` | `attempts.test.ts`, `P11-sample.json` |
| Counter survives restart | counters and attempts are SQLite rows, not memory | `attempts.test.ts` (closed and reopened store) |
| Acknowledgement never resets | `acknowledge` writes a same-status transition only | `attempts.test.ts`, sample step "acknowledge" |
| Reopen needs evidence or a decision | `reopenProblem` requires `evidencePath`, or actor `victor` | `attempts.test.ts` |
| Blocked task cannot dispatch | `TaskService.claim`, `resumeTask` and `runOnce` check `problems.status = 'blocked'` for the task | `attempts.test.ts`, sample step "claim of the blocked task refused" |
| Dependency propagation | `eligibilityFor` marks a task ineligible and names the blocking problem when a prerequisite is blocked | `attempts.test.ts`, sample "board after the block" |
| Independent work continues | selection skips only the blocked subtree; other eligible tasks still rank | `attempts.test.ts`, sample step "board after the block" |
| Queue refuses new starts while blocked | `WorkQueue.blockOnProblem` / state `blocked`; `resumeQueue` is rejected | `work-control.test.ts` |
| Pause/interrupt/cancel distinctions | queue boundary vs engine interrupt vs future-start cancel, each with its own receipt | `work-control.test.ts`, `studio-service.test.ts` |
| A native owner is not silently paused | `pauseAfterTask` returns `outcome: 'partial'` and names the native workflow | `work-control.test.ts`, `studio-service.test.ts` |

## Cooperatively requested (engine-internal loop)

Mona stops an *outer* loop: a task may not be claimed, resumed or dispatched
again while its problem is blocked. Inside one engine turn, Codewhale's own tool
loop may keep iterating, and the pinned runtime exposes no event that tells Mona
"this is attempt three of a semantic problem". Mona therefore:

1. injects `ENGINE_ATTEMPT_INSTRUCTION` (stable text, no per-turn rewriting)
   into the task prompt, so the agent has the rule and the required report shape;
2. accepts structured attempt reports as attempt records, and applies the same
   counters to them;
3. shows the boundary in the UI and in this document rather than claiming a
   semantic guarantee.

What Mona does **not** do: parse error strings, count "similar" tool calls to
infer a loop, or run a second model to watch for repetition. Those are guesses,
and a guess is not a guarantee.

## Stop controls and their real reach

| Control | What happens | What is not claimed |
|---|---|---|
| Pause after task | `WorkQueue.pauseAfterTask`; next `startNext` returns null; submits are refused | Does not interrupt the running turn. With a native owner it reports `partial`. |
| Interrupt now | engine `interrupt` route; receipt recorded; failure becomes `outcome_unknown` | Never claims rollback of external side effects or already-sent requests. |
| Cancel queued | removes one queued entry; a running entry is rejected with guidance | Cannot cancel a running turn. |
| Blocker-paused | queue state `blocked`; `resumeQueue` rejected until `releaseProblem` | Does not cancel unrelated work in other workspaces. |
| Quit and stop | interrupt then stop owned runtime; `partial` when either is uncertain | No rollback claim. |

## Unknowns kept visible

- An engine-internal loop is not counted as attempts Mona can see. The UI says
  so; it does not display a fabricated attempt count.
- Acknowledge is an audit event. The card says acknowledgement does not reset
  the counter, and it does not.
- A problem's `help_needed` is required when it blocks. A blocked problem with no
  recorded help would be an incomplete report, so the transition is refused.
