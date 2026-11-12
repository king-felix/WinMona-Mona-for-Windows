# Mona build handoff

**Current prompt:** P06 — Build Mona's distinctive design system
**Current status:** P00–P05 completed. State revision 17. Next eligible: P06.

**Last verified commit / dirty work:** the P05 commit covers the state layer, the
desktop wiring and the evidence below; the working tree is clean after it.

## P05 result — one durable authority for local state

`packages/project-state` is new and is opened by the desktop at launch
(`apps/desktop/src/main/local-state.ts`).

- **Engine:** SQLite through `node:sqlite` (`DatabaseSync`, online `backup`).
  No native module, no toolchain prerequisite.
- **One write path:** `ProjectStore.write()` enters the maintenance barrier and
  one `BEGIN IMMEDIATE` transaction. Revision checks fail stale writers
  (`stale_revision`) instead of overwriting newer state.
- **Barrier:** `exclusive` (migration, restore) refuses reads and writes until
  in-flight work drains; `snapshot` (backup) refuses writers but keeps reads.
  A write during maintenance gets a typed `maintenance` error.
- **Schema v1:** 16 tables plus `store_meta`, covering projects, runtime
  bindings, threads, turns, submissions, tasks, dependencies, evidence, attempts,
  decisions, cursors, usage, capability snapshots, settings versions, artifacts.
  Migrations are immutable and checksummed; drift fails closed; a failed
  migration rolls back to the previous version.
- **Backup/restore:** verified snapshot, digest-checked restore, prior database
  parked in `recovery/`, recovery files never unlinked.
- **Artifacts:** content-addressed, 8 MiB bound, disk-reserve refusal, bounded
  reads, retention that refuses to prune protected evidence.
- **Identity:** aliases (same folder, junction, same inode) resolve to one
  project; a moved folder needs an explicit rebind and keeps its id; worktrees
  are distinct roots sharing the canonical `.git` key; removal never deletes the
  folder.
- **Export/import:** digest-covered, revision-aware, free of machine-local
  bindings.
- **Journal:** `SqliteSubmissionJournal` replaces the file journal and is bound
  into `EngineHost`, so quit-and-stop can issue a real interrupt once a project
  is open.

Proof: `docs/evidence/P05-state.md`, `P05-state-open.json` (the real app opens
schema v1, 17 tables, integrity ok), `P05-tests.txt` (132 Vitest, 23 new),
`P05-checks.txt`, `P05-build.txt`. Decisions D-0032…D-0034.

## Next exact action (P06)

Read P06 in `Mona_PROMPTS.md` and spec 4, 12, 15. Build the design system in
`packages/ui` (tokens, typography, spacing, surfaces, focus, density, motion) and
the components P06 lists, plus a clearly labeled fixture-backed visual harness
for home, project studio, work board, cost lens, blocker card and settings.
Validate contrast by measurement rather than assuming the starting palette; keep
fonts and icons local; honor reduced motion; prove keyboard access and visible
focus. Capture screenshots in both themes and both densities at 1280×800 and a
large desktop. The harness must be labeled as visual development data, must not
fetch anything external, and must make zero inference calls.

## Relevant files and spec sections

- `packages/project-state/src/{store,barrier,migrations,backup,artifacts,export,identity}.ts`
- `apps/desktop/src/main/{local-state,engine-host,main}.ts`
- `apps/desktop/src/shared/engine-status.ts`, `apps/desktop/src/renderer/App.tsx`
- Spec 4 (visual experience), 12 (delight), 15 (quality) for P06; 8/10.1 for
  reference on what the state layer guarantees.

## Open problem IDs and no-progress counts

No open blocker; `attempts.jsonl` holds only the closed P02 rows.

- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift; P16 resolves.
- **P01-ISSUE-002** — Windows allows a second runtime in one workspace; Mona
  leases one workspace at a time, parallel workspaces stay off.
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.
- **P04-ISSUE-001** — no Job Object on this host; `taskkill /T` plus reconcile.
- **P04-ISSUE-002** — close-to-tray has no tray affordance until P07.
- **P05-ISSUE-001** — the maintenance barrier is in-process; cross-process
  safety is SQLite's locking plus the single-instance lock (D-0032).

## Blocked dependencies

None.

## Last relevant validation

- `npx vitest run` → 132 pass (23 new for P05); bootstrap 13; spike 8.
- `npm run lint`, `npm run format:check`, `npm run typecheck` → pass.
- `npm run build` → contracts, adapter, project-state, desktop; renderer 225 kB.
- `npm run smoke -w @mona/desktop` → pass, 334 MB, security assertions intact.
- `npm run lifecycle -w @mona/desktop` → 10/10 lifecycle checks **and** local
  state opened (schema v1, 17 tables, integrity ok).
- `node tools/build/cli.mjs validate --verbose` → OK, state r17.
- Spend ≈ $0.05 of the $2 pilot ceiling; P04 and P05 made no provider request.

## Human input needed

None. Same caution: edit source with byte-safe tools, not PowerShell
`Get-Content`/`Set-Content` round-trips (D-0027).
