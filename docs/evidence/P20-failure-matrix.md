# P20 — failure-injection matrix and security boundary review

**Status:** completed. Every high-consequence scenario below has passing evidence
or a named residual issue. No release-blocking security finding is open.

**Method:** targeted tests against real files, real child processes and the real
main-process IPC wrappers; existing live Electron probes where the scenario is
only observable in a window. No mock-only test is presented as runtime
compatibility.

## Failure matrix

| # | Scenario | Injection and evidence | Result |
|---|---|---|---|
| 1 | Renderer crash | `lifecycle` live probe: `forcefullyCrashRenderer()`, window recreated, runtime alive, no quit. Also `engine-host.test.ts`, `work-control.test.ts`. | **pass (live)** |
| 2 | Main crash | Real child process killed during an open SQLite transaction (`store.test.ts:survives a real process crash`), plus ownership reconciliation after a machine restart (`work-control.test.ts`). No end-to-end kill of the Electron main process. | **partial — P20-ISSUE-001** |
| 3 | Runtime crash | `supervisor.test.ts` bounded restart with no resubmission; `engine-host.test.ts` marks outcome unknown. | **pass** |
| 4 | Lost stream | `studio-service.test.ts:turns a dropped stream into reconnecting, then running after a replay`; adapter reconnect tests. | **pass** |
| 5 | Lost submission response | Adapter test: one POST, journal intent, reconcile by operation key, no second turn. | **pass** |
| 6 | Duplicate / out-of-order events | Adapter seq dedupe; `studio.test.ts` replayed sequence; unique `(thread_id, seq)`; renderer test; cost dedupe. | **pass** |
| 7 | Disk full | `ArtifactStore` refuses a write that would cross the free-space reserve and never writes a partial artifact (`state.test.ts`). Database-level disk-full is not simulated. | **pass (artifact) — P20-ISSUE-002** |
| 8 | Stale revision | `store.test.ts` refuses a stale project revision; extensions/provider tests refuse a stale view before writing. | **pass** |
| 9 | Corrupted metadata | UI state set aside; corrupt adapter journal skipped; **new** garbage SQLite file is refused, preserved byte-for-byte, and can be moved after the failed open. | **pass (new)** |
| 10 | Failed migration | `migrations.test.ts` leaves the database at the previous version and keeps the pre-migration backup. | **pass** |
| 11 | Missing artifact | Diagnostic preview reports `missing`, digest mismatches when asked; artifact reads are bounded and fail typed. | **pass** |
| 12 | Revoked credentials | HTTP 401 maps to `authentication_failed` without the token; SSE subscription stops reconnecting on auth failure. Simulated 401, not a rotated live key. | **pass** |
| 13 | Occupied port | `supervisor.test.ts` occupied-port path; external attach is read-only. | **pass** |
| 14 | Sleep / wake | Modeled as a dropped stream (reconnecting) plus stale-ownership reconciliation. OS suspend/resume itself is not simulated. | **partial — P20-ISSUE-003** |
| 15 | Interrupted restore | **new** `p20-recovery.test.ts` injects failure at `afterPark`, `afterCopy` and `beforeReplace`: live data intact and readable, no staged file, backup and parked copy preserved, then the same backup restores cleanly. | **pass (new)** |
| 16 | Suspicious folder names | **new** test registers `proj #1 100% 数据`, a trailing separator and an uppercase path as one project; junction launch already live-tested in `launch-target.test.ts`. | **pass (new)** |
| 17 | Path canonicalization | **new** test refuses `../outside.txt`, a drive-absolute path and a POSIX absolute path as evidence, and normalizes `docs/../docs/proof.txt`. P19 handoff validates every member path. | **pass (new)** |
| 18 | Imported archives / prompts | P19 tests: digest tamper, traversal, absolute and device-name members, credential-shaped files, extraction overwrite refusal, prompt pack inert. | **pass** |
| 19 | Markdown / file / terminal links | Markdown renders links as inert text, never raw HTML or `javascript:`; terminal has no link addon and ignores OSC 52; bundle check finds no remote origin in the renderer. | **pass** |
| 20 | Generated-app previews | No generated-app preview feature exists in this build, so there is no preview origin or bridge to isolate. Stated rather than claimed as tested. | **n/a** |
| 21 | Write paths obey maintenance | `state.test.ts` refuses a write during maintenance and accepts it after; P19 settings restore holds exclusivity. Every mutation enters the one barrier. | **pass** |
| 22 | Owned processes obey shutdown | `supervisor.test.ts` real descendant stop; `lifecycle` live quit-and-stop; `terminal-service.test.ts` closes every owned shell. | **pass (live)** |

## Findings and repairs

### P20-FIX-001 — Restore replaced the live database by direct copy

- **Symptom:** `restoreBackup` verified the backup, parked the current database,
  then copied the backup directly over the live file. A failure between the
  truncate and the completed copy would leave a partial live database, even
  though a valid parked copy existed.
- **Repair:** the replacement is copied to a temporary file beside the live
  database, verified with `integrity_check`, and only then renamed over the live
  file. The live `.wal`/`.shm` sidecars are removed only after staging verifies.
  Any failure removes the staged file and its sidecars and reopens the original
  store. The parked copy and backup are never deleted.
- **Proof:** `p20-recovery.test.ts` injects a failure at three points and asserts
  the live database is intact and the store is usable; the success path leaves
  no staged file.

### P20-FIX-002 — A failed database open leaked a SQLite handle

- **Symptom:** opening a non-database file created a `DatabaseSync`, and a
  PRAGMA failure threw before `close()`. On Windows the file stayed locked, so
  the corrupt file could not be moved or inspected.
- **Repair:** `openDatabase` now closes the handle on any setup failure and
  rethrows the original error. `openState` still refuses the file; it never
  deletes or replaces it.
- **Proof:** the corrupt-state test reads the file back byte-for-byte, renames
  it after the failed open, and confirms the directory contains only the
  preserved file.

## Residual issues

- **P20-ISSUE-001** — No end-to-end kill of the Electron main process while an
  owned runtime is live. Composed evidence covers WAL durability and stale
  ownership reconciliation; a real kill may leave the runtime orphaned until the
  next launch reconciles it (spec 6.4 does not require daemon survival).
- **P20-ISSUE-002** — Database-level disk-full is not simulated; only the
  artifact store's free-space refusal is. SQLite's own I/O error path is
  unchanged and reported honestly by the write path.
- **P20-ISSUE-003** — True OS sleep/resume is not simulated. Reconnect and
  stale-ownership behaviour is tested via a dropped stream and a restart.
- P19-ISSUE-001..004 remain as recorded in the P19 evidence.

## Reproduction

```text
npx vitest run packages/project-state/src/p20-recovery.test.ts
npx vitest run apps/desktop/src/main/ipc-audit.test.ts
npx vitest run            # 60 files, 506 tests
npm run typecheck
npm run lint
npm run build
npm run check:build -w @mona/desktop
```

Logs: `docs/evidence/P20-tests.txt` (full Vitest run),
`docs/evidence/P20-checks.txt` (typecheck, lint, format, build, bundle check,
state validation). The security audit is in
`docs/evidence/P20-security-review.md`.

The restore failure can be reproduced by making the staged copy step throw
(`hooks.afterCopy`), by making the rename step throw (`hooks.beforeReplace`), or
by interrupting the process after the live sidecars are removed. In each case
the test expects the live database to remain readable at its newer revision.
