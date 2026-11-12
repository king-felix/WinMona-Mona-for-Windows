# P13 — Changes, evidence, Git and restore

**Status: completed.** MONA-014 is complete (diffs, receipts, provenance,
bounded output) and MONA-015 is delivered (Git awareness, selected commits,
non-Git behaviour, conflict-aware restore).

## What was delivered

- **Migration v6.** `change_baselines` (hash map, not a snapshot engine),
  `test_receipts`, `restore_receipts`.
- **`ChangeService`** (`packages/project-state/src/changes.ts`):
  - `captureBaseline` — deterministic hash map of the workspace with explicit
    exclusions (`.git`, `node_modules`, `.mona`, `dist`, `out`, `.vite`,
    `coverage`), symlinks skipped and named, a file cap that sets `truncated`.
  - `diff` — added/modified/deleted against the latest (or named) baseline, with
    `attribution: 'tool_recorded' | 'unattributed'`, byte size, binary flag and a
    `preview` classification of `text | binary | oversized | missing`.
  - `diffText` — Git diff only; without Git the result is
    `available: false` with the reason "no textual baseline", never an empty
    diff.
  - `gitStatus` / `stage` / `commit` — real repository facts; `commit` uses
    `git commit -- <paths>` so unrelated staged work stays staged.
  - `restorePreview` / `restore` — preview scope, exclusions, conflicts and
    current hashes; restore refuses when a file changed after the preview, when
    the path has staged changes, or when it is untracked.
  - `recordTestReceipt` / `testReceipts` — command, exit code, outcome, commit,
    duration, and a bounded output artifact with a digest.
- **`writeFileFresh`** — fresh-revision writes: `expectedSha256: null` requires
  the file not to exist; otherwise the current hash must match or the write is
  refused with `conflict`. Writes go through a fsynced temp file and a rename.
- **`GitService`** (`packages/project-state/src/git.ts`) — porcelain v1 parsing
  with `-z`, conflict codes surfaced separately, worktree detection through
  `--git-dir` vs `--git-common-dir`, path validation that rejects absolute
  paths and `..`, and no shell string construction anywhere (`execFileSync`
  argv only).
- **No second snapshot engine.** For a non-Git folder `restorePreview` returns
  `unsupported: ["restore is unavailable: ...; Mona has no native snapshot
  engine"]` instead of building one.

## Acceptance matrix

| P13 acceptance item | Result | Where |
|---|---|---|
| Dirty repository preserves user changes and staged entries | pass | `changes.test.ts` "commits only the selected path..." |
| A changed file edited externally gets conflict handling | pass | `changes.test.ts` "refuses to restore when the file changed after the preview", "refuses to overwrite a file that changed after it was read" |
| Deleted/binary/large files display honestly | pass | `changes.test.ts` "reports added, modified and deleted..." (`binary`, `oversized`, `deleted`) |
| Missing snapshot is not an empty diff | pass | `changes.test.ts` "says plainly that a missing baseline is not an empty diff" |
| Supported restore works, unsupported scope explained | pass | `changes.test.ts` restore test; non-Git test |
| Test cards link to commands/results/commit | pass | `changes.test.ts` "links a real command, exit status and bounded output" |
| Unsupported restore stays in the capability gap ledger | pass | rows CAP-0009/CAP-0021 remain `discovered`; see below |

## Capability ledger note

Mona does not claim a native snapshot feature. The restore path is Git
`checkout --` with a hash-guarded preview. Engine-side capabilities that could
offer a native undo (`resume`, `apply`, `fork`) remain `discovered` rows; P13
does not mark them qualified, and no terminal shim was added to simulate them.

## Evidence

- `docs/evidence/P13-sample.json` — deterministic run in a throwaway Git repo:
  repository facts, baseline, attributed change report, text diff, selected
  commit leaving the user's staged file alone, test receipt, restore preview,
  refused restore with a stale hash, applied restore, and the restored content.
  `providerRequests: 0`.
- `docs/evidence/P11-13-gates.txt`, `P11-13-checks.txt`, `P11-13-build.txt`.
- `packages/project-state/src/changes.test.ts` — 10 tests including 5 real-Git
  tests.

## Open follow-ups

- **P13-ISSUE-001** — no renderer surface yet for the change list, diff viewer
  or test cards; the service layer and receipts are complete and tested.
- **P13-ISSUE-002** — attributed changes rely on tool-event paths supplied by
  the studio; today those paths are recorded for the live run but not persisted
  as a per-task touch set (same wiring as P10-ISSUE-002).
- **P13-ISSUE-003** — restore intentionally covers HEAD only. Restoring to an
  arbitrary earlier commit is a later feature and would need an explicit
  revision picker plus the same hash guard.
