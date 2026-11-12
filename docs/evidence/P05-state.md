# P05 — Transactional project state and safe migrations

**Prompt:** P05 · **Status:** completed · **Requirements:** MONA-005 (identity),
MONA-010 (state/recovery), MONA-016, MONA-025 (backup/migration) ·
**Environment:** win32-x64, Node v26.13.1 (`node:sqlite`), Electron 45.3.0

The desktop now has one durable authority for local project state, and the
adapter's submission journal is stored there instead of a directory of JSON
files. The database is SQLite through Node's built-in `node:sqlite`
(`DatabaseSync` + the online `backup` API) — no native module to compile, no
toolchain prerequisite.

## Shape

`packages/project-state` holds the schema, the single write path, the maintenance
barrier, artifact storage, backup/restore, project identity, and portable
export/import. `apps/desktop/src/main/local-state.ts` opens it under the app's
private data directory at launch.

**One write path.** `ProjectStore.write()` enters the maintenance barrier, opens
one `BEGIN IMMEDIATE` transaction, and either commits or rolls back completely.
Workers, ingestion, and the UI call the same method; nothing else may write.

**Revision checks.** A project row carries a revision. `updateProject` and any
`write({ projectId, expectedRevision })` fail with `stale_revision` when the
caller is behind, so two aliases of one project cannot silently overwrite each
other.

**Maintenance barrier.** Three modes of entry: read, write, and maintenance.
`exclusive` (migrations, restore) refuses both reads and writes until in-flight
work drains; `snapshot` (backup) refuses writers but keeps reads served so the UI
does not freeze. A write attempted during maintenance gets a typed `maintenance`
error rather than a stale read of a half-replaced file.

**Schema.** `schema_migrations` plus 16 tables covering the specification's
model: `projects`, `runtime_bindings`, `threads`, `turns`, `submissions`,
`tasks`, `task_dependencies`, `requirement_evidence`, `attempts`, `decisions`,
`event_cursors`, `usage_records`, `capability_snapshots`, `settings_versions`,
`artifacts` and `store_meta` (the store-wide revision counter). Foreign keys and
check constraints are on (`PRAGMA foreign_keys = ON`, verified by tests that
insert an invalid dependency row).

Engine history stays authoritative in Codewhale: this database stores thread and
turn identifiers, cursors, and projections — never a competing transcript.

**Migrations.** Each migration is immutable and checksummed. A changed checksum,
a database with a migration this build does not know, or a non-contiguous
version list fails closed (`migration_mismatch`) instead of re-applying
something. A failing migration rolls back and leaves the database at its previous
version (`migration_failed`). `openState()` takes a verified backup before
applying pending migrations to an existing database.

**Backup and restore.** `createBackup` uses the SQLite online backup API under a
snapshot barrier into a `.partial` file, verifies `integrity_check` and the
digest, then renames into place. `restoreBackup` verifies the file (and optional
expected digest) *before* touching anything, parks the current database and its
WAL/SHM files in a recovery directory, replaces the file, reopens, and returns a
receipt naming the parked copy. No recovery file is ever unlinked as an
optimistic repair.

**Artifacts.** Large outputs live as content-addressed files: bounded by
`maxArtifactBytes` (8 MiB default), refused when the volume would drop below the
reserved free space (`disk_full`), read with an explicit bound, and pruned only
when retention policy says so *and* the digest is not protected by an active
blocked task.

**Project identity.** A project has a stable `prj_` id, a canonical path
(realpath, case-normalized on Windows), and a filesystem identity (device +
inode). Registration resolves aliases instead of duplicating: the same folder,
a junction to it, or the same inode all return the existing project. A folder
carrying Mona's marker (`.mona/project/project.json`) at a *new* path is a
relocation: it returns `relocation_required` until the caller explicitly rebinds,
and rebinding keeps the same project id and bumps its revision. Git worktrees are
distinct project roots that share one repository key, so the UI can express the
relationship without merging them. Removing a catalog entry never touches the
folder.

**Export/import.** A project export is a versioned, digest-covered document with
the store revision; machine-local data (endpoints, pids, token digests, scratch
paths) is excluded by construction. Import validates schema, digest and revision
before a single transaction applies it; a newer local revision is refused unless
the caller explicitly accepts an older import.

## Acceptance evidence

| Criterion | Proof |
|---|---|
| Crash before/during/after a transaction leaves valid recoverable state | `store.test.ts`: failure before commit leaves zero rows and a usable connection; a **real child process** killed mid-transaction leaves the database valid with no uncommitted row and writable afterwards |
| Stale revision writes fail | `updateProject` with an old revision → `stale_revision`; value unchanged |
| Migrations recover from failure | failing migration → `migration_failed`, version stays 1, partial table absent, integrity ok; checksum drift → `migration_mismatch` |
| Backup/restore with writers quiesced | backup → mutate → restore reverts; parked copy and backup both still exist; write during maintenance → `maintenance` |
| Disk-full handled without false completion | `ArtifactStore` with a huge reserve → `disk_full` and no file; oversize → `oversize` |
| Two aliases do not duplicate a project | same folder and junction/`.` resolves to one project; marker-based move → `relocation_required` then `rebound` with the same id |
| Relocation and distinct worktrees | relocation test above; worktree test shows two project ids sharing one `shared_repo_key` |

Artifacts: `docs/evidence/P05-tests.txt` (132 Vitest, 23 new, + 13 bootstrap +
8 spike), `P05-checks.txt`, `P05-build.txt`, and `P05-state-open.json` — the real
Electron app opening schema v1 with 17 tables and `integrity_check = ok`.

## Integration

- The adapter's `SubmissionJournal` now has a transactional implementation
  (`SqliteSubmissionJournal`). `EngineHost.bindJournal` receives it at launch, so
  quit-and-stop can issue a real engine interrupt instead of reporting "no
  channel" — the remaining P04 limit is closed where a project is open.
- Evidence runs use `MONA_USER_DATA`, so smoke and lifecycle probes never write
  into the real user profile.

## Known limits, recorded rather than hidden

- **Single process writer.** The barrier is in-process. Two Mona processes are
  prevented by the single-instance lock, but a future external writer (a CLI)
  would need OS-level locking; SQLite's own `BEGIN IMMEDIATE` and busy timeout
  already reject interleaved writers from another process, and that is the only
  cross-process guarantee claimed. Recorded as D-0032.
- **Backups are local.** There is no upload, no cloud sync, and no automatic
  off-machine copy. The portable handoff bundle (P10/P19) builds on the export
  format, not on the raw database.
- **`settings_versions` and `capability_snapshots` store history, not policy.**
  Applying settings and the capability explorer UI arrive later; P05 only proves
  the durable shape.
- **Marker files are additive.** Mona writes `.mona/project/project.json` into a
  registered folder. It is a small document with an id, not state; deleting it
  only weakens relocation detection to path/inode matching.
