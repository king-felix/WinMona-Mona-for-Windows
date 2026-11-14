# W02 — State integrity and export qualification

Executed 2026-11-14 on the reference machine. Requirement: WX-03. Original criteria affected:
MONA-005 (project lifecycle), MONA-007 (conversation export), MONA-025 (backup/restore).

## What the checkout actually did

**Replacement import left the previous project's state behind.** `importProject` upserted the
`projects` row instead of deleting it, so `ON DELETE CASCADE` never fired, and the explicit deletes
covered only the task children plus `decisions`. A replacement therefore kept the old
installation's `threads`, `turns`, `timeline_items`, `event_cursors`, `usage_records`,
`submissions`, `budgets`, `problem`/`attempt` history, memory documents, artifacts, runtime
bindings, requirement evidence, baselines and test receipts — attached to the imported task graph.
There was also no pre-import copy of what was about to be replaced, and the export document itself
carries only the project, its tasks and its decisions.

The defect was latent, not reachable by a person: nothing in `apps/desktop` calls
`importProject`/`exportProject`. Recorded rather than papered over — the library is now correct
and a product surface for project import is still absent (that is W14/W23 scope, not this prompt).

**Restore had three edge gaps.** It accepted a backup whose schema was *newer* than the build
(restoring it would leave rows this code cannot read); a rename that Windows briefly refused was a
hard failure; and if the verified backup had already replaced the live file but could not be
reopened, the store was left closed with no statement of which database was live.

**The maintenance barrier itself was sound.** Every production writer goes through
`store.write`/`exclusive`/`snapshot` (TaskService, attempts, cost ledger, changes, memory, handoff,
the SQLite submission journal, backup, restore, migrations, settings restore). The only raw writers
are the a11y/memory/QA probes that seed a fixture database before a probe run starts; they hold no
lock because nothing else is using that file yet.

## What changed

- `packages/project-state/src/export.ts`
  - `PROJECT_OWNED_TABLES` + a per-table scope predicate, deleted child-first for the replaced
    project only. Global tables (`rate_cards`, `settings_versions`, `schema_migrations`,
    `store_meta`) are deliberately absent, and other projects' rows are never touched.
  - `ImportOptions.backupDirectory`: a verified `createBackup` snapshot is taken before the
    replacement transaction, and `ImportResult` reports `replacedRows` (per table) and
    `backupFile`. A replacement is now reversible.
- `packages/project-state/src/backup.ts`
  - refuse a backup whose schema version is newer than the live build (`schema_drift`), before
    anything is closed;
  - bounded retry for `EPERM`/`EACCES`/`EBUSY` renames, so a short scanner hold slows a restore
    instead of failing it;
  - if the replacement is already in place and reopening fails, the error states that and names
    the parked previous database instead of reporting a generic failure.
- `packages/project-state/src/errors.ts`: `schema_drift` added to the state error vocabulary.
- Export itself needed no writer change: the native Save dialog, cancel, empty-session refusal,
  absolute-path check and temp-then-rename write were already correct.

## Verification

`npm test` → **591 Vitest tests in 70 files**, plus 11 bootstrap, 26 launch, 12 assets, 29 install
and 8 spike tests, all passing. New coverage:

- `state.test.ts`:
  - replacement import clears `turns`, `timeline_items`, `event_cursors`, `usage_records`,
    `budgets` (+ events), `problems` (+ transitions), `attempts`, `artifacts`, `memory_documents`
    (+ terms), `submissions`, `runtime_bindings`, `requirement_evidence`, `change_baselines` and
    `test_receipts` for the replaced project, while a second project's task, both `projects` rows
    and the global `rate_cards` row survive; the pre-import backup verifies with
    `integrity_check`.
  - restore refuses a newer-schema backup with `schema_drift` and leaves the live rows intact.
  - TaskService, CostLedger and `putStudioThread` all return `maintenance` while an exclusive
    barrier is held, so the barrier is proven at the service boundary rather than the store only.
- `studio-service.test.ts` (conversation export):
  - a Unicode, spaced destination under a created folder writes, reports the exact byte count and
    hash, and the file contains the recorded turn;
  - an existing file is replaced atomically with no `.tmp` sibling left behind;
  - an unwritable destination (missing parent) fails closed with "could not be written" and leaves
    no file;
  - cancel writes nothing; an empty session is refused before any dialog is offered.
- `studio-ipc.test.ts`: a renderer-supplied `path` on the export channel is refused by the strict
  schema, so only the native Save dialog chooses a destination.
- Negative check: with the delete loop disabled, the replacement test fails (`expected undefined to
  be 1`), so it is testing the new cleanup rather than passing by accident.

## Still open, stated rather than implied

- **Project import has no product surface.** The library is correct and tested; no desktop channel,
  dialog or menu calls it. Importing a project file is not something a person can do in this build.
- **Conversation export reads one window of 500 rows per session** and that window is currently the
  *oldest* 500 (`listTimelineItems` orders `seq ASC`). For a conversation longer than 500 items the
  export is a prefix, not the whole conversation, and the file says so via `itemBound`. Fixing the
  ordering and paging is W03's contract; this prompt does not claim the export is complete past 500.
- **A genuine disk-full or antivirus lock on the live database was not injected.** The rename retry
  is exercised only by its normal path; the disk-full refusal that *is* proven is the artifact
  store's, from P20.
