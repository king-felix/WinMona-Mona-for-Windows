# P25 — the Cost lens and Work board were never wired; they are now

**Date:** 2026-11-13. **Machine:** Windows 11 Pro 10.0.26200, Ryzen 7 5800X, 32 GB, x64.
**Engine:** Codewhale `0.10.2 (ff466b2ed0bf)` — untouched. **Spend: 0 µUSD**, no provider request.

## 1. What Victor noticed, and what it actually was

The Cost screen ended with:

> Budget controls and export arrive with P12. No remaining balance is inferred locally.

P12 was completed long before. The sentence was not merely stale copy. It was **true**:

| Requirement | Ledger said | What a user could actually do |
|---|---|---|
| MONA-013 `budgets` | `passed` | nothing — no budget channel existed |
| MONA-013 `export` | `passed` | nothing — no export channel existed |
| MONA-009 `prompt-catalog` | `passed` | nothing — the Work screen rendered a hardcoded "No tasks recorded" |

The services were complete (`CostLedger.lens/exportCsv/setBudget/listBudgets/evaluateBudget`,
`TaskService.board/listTasks/createTask`), and the evidence cited for those criteria was real
but **service-level**: ledger and task tests, plus a sample run. The renderer had exactly one
cost channel (`mona:project-spend`, three numbers) and **no task channel at all**.

The Work screen was worse than empty: it printed "No tasks recorded" **unconditionally**, so a
project with tasks would have been shown a false fact. That contradicts the project's own rule
that the shell shows real state.

So: the finding is accepted. Two requirements had been marked verified on evidence that could
not demonstrate the user-facing behaviour they describe. This document records the fix, the
live proof, and the correction to the record.

## 2. What was built

**Cost lens** — `apps/desktop/src/renderer/CostPanel.tsx` over new channels
`mona:cost-lens`, `mona:cost-budget-set`, `mona:cost-export`:

- totals with provider-reported and locally-estimated **kept separate**, unknown count and
  per-reason breakdown, latest record, cache tokens only when the provider reported them;
- the recorded lens's own breakdown by task, by session and by turn;
- budget list (scope, limit, warn, stop) plus the live evaluation verdict
  (`allow` / `warn` / `block_next_dispatch`), each decision showing spent, reserved and detail;
- a set-budget form (project / day / session) that sends whole micro-USD, with the ledger's own
  validation message surfaced instead of a generic failure;
- CSV export to a file the person chooses, written through temp-file-then-rename;
- the ledger's disclosure text, so a local dispatch limit is never mistaken for an invoice cap.

**Work board** — `apps/desktop/src/renderer/WorkPanel.tsx` over `mona:task-board` and
`mona:task-create`:

- every task with status, owner, ordinal, steps, acceptance criteria (met/unmet, required,
  check/human), evidence with its stale flag, dependency and dependent edges, and requirement
  traceability refs;
- eligibility **copied from the task service** with its stated reason — never recomputed in the
  view, because a second eligibility calculation would be a second scheduler;
- a create form (title, description, steps, criteria, optional dependency) that records a
  **pending** task and starts nothing.

Both panels replaced the stubs in `App.tsx`; the two placeholder paragraphs and the stale
"connect to the engine in P08/P11" queue note are deleted.

The header spend chip and the Cost lens read the same `usage_records` table, so opening the
lens now refreshes the chip. Without that, the probe caught the header saying "No recorded
spend" while the lens showed $0.0035 — two surfaces disagreeing about the same rows.

## 3. Live proof, not mocks

`npm run surfaces` seeds a real project, ingests real cost rows through `CostLedger`, creates
real tasks through `TaskService`, then drives the actual window and reads its DOM.

```text
PASS the shell is ready before it is driven
PASS the first navigation click opens the Cost lens and stays there
PASS the Cost lens renders recorded rows :: {"knownMicros":3500,"unknownRecords":1}
PASS known cost matches the ingested micro-USD total :: "$0.0035 + 1 unknown"
PASS unknown-priced rows are counted and never folded into the money :: unknownText "1"
PASS the provider-reported and locally-estimated splits are both stated
PASS the stale P12 placeholder is gone
PASS the header spend chip agrees with the Cost lens after it loads :: {"chip":"$0.0035 + unknown"}
PASS a budget can be set from the Cost lens
PASS the saved budget shows the limit, warn and stop thresholds :: limit $2.5000 · warn $2.0000 · stop $2.5000
PASS the evaluation states that this is a local dispatch limit
PASS CSV export wrote a file with the recorded rows :: {"rows":4}
PASS the CSV header carries cost_label and unknown_reason
PASS every CSV row labels provider-reported, locally-estimated or unknown
     ["provider-reported","locally-estimated","unknown (provider did not report usage)"]
PASS the Work board renders tasks the service recorded
PASS the stale P10 placeholder is gone
PASS a seeded task title is on the board
PASS steps and acceptance criteria are shown, not summarised
PASS a blocked dependency is explained :: "Not eligible: …" and "Depends on …"
PASS a task can be added from the Work board
PASS the new task is pending and eligible, with nothing started
P25 surfaces probe: 26 steps passed, 4 screenshots
```

Run against the development build **and** the installed candidate: 26/26 each.
Screenshots: `docs/evidence/shots-p25/`, `shots-p25-installed/`.
Exported CSV: `docs/evidence/P25-cost-export.csv` (3 rows, one of each cost origin).

**One honest gap:** the CSV export normally opens the native Save dialog. A probe cannot click
it, so the probe supplies a destination through `MONA_SURFACES_EXPORT` (only reachable together
with `--surfaces-probe`). The dialog itself remains human-verified only, exactly like the
conversation export. Everything after the dialog — content, labels, byte count — is proven.

## 4. A defect the probe caught in the probe

The first run "failed" to open the Cost screen. The cause was the probe clicking before the
shell had finished booting: `App` renders a boot screen until its initial load completes, so the
rail did not exist yet and `querySelector(...).click()` was a silent no-op. The probe now waits
for the rail and the timeline before driving anything, and asserts that the first click lands.

A speculative guard was written during diagnosis and then **reverted** once `setLoaded(true)` was
confirmed to run after the persisted view is applied — the race it defended against cannot
occur, and unreachable defensive code is its own kind of false claim.

## 5. Gates and artifact

| Check | Result |
|---|---|
| `npm run ci` | exit 0 — Prettier, ESLint, typecheck (5 workspaces), **575 Vitest in 70 files**, 14 bootstrap, 12 launch, 26 install, 8 spike, production build |
| `npm run surfaces` (dev) | **26/26** |
| `npm run surfaces` (installed) | **26/26** |
| `npm run a11y` (installed) | 12/12 |
| `install --force` | 1,695 files, 0 checksum problems, package `Status: Ok` |
| `verify --smoke` | exit 0, renders at 0.1.0 |

Artifact: payload **1,695 files / 452,888,542 bytes**; `Mona-0.1.0-x64.msix`
sha256 `9f6b1cb3c81ecac3f3b2ccef7a2e78dfda4ef5c10a534896759e7879acb27ace`.

New tests: `cost-ipc.test.ts` (8), `tasks-ipc.test.ts` (7), two renderer cases in
`App.test.tsx`, and both modules added to the cross-module sender audit.

## 6. Correction to the record

MONA-013 and MONA-009 keep `verified`, because the behaviour now exists and is proven at the
surface. What changes is the **basis**: the ledger now cites surface-level evidence, and
D-0114 records the rule this exposed — service-level evidence cannot carry a criterion that
describes what a person can do in the app. Two criteria had been marked passed on probes that
never touched the renderer. That was the mistake, and it is recorded rather than quietly
overwritten.
