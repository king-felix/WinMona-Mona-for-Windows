# Mona build handoff

**Current prompt:** P05 — Build transactional project state and safe migrations
**Current status:** P00–P04 completed. State revision 12. Next eligible: P05, P06.

**Last verified commit / dirty work:** the P04 commit covers the supervisor, the
desktop lifecycle wiring, the ledger updates and the evidence below; the working
tree is clean after it.

## P04 result — Mona owns processes, and stopping is truthful

`packages/adapter/src/supervisor.ts` replaces P03's minimal
`startOwnedRuntime` (which is now a thin wrapper over the supervisor, kept for
the P03 live script).

- **Ownership is (workspace, pid, creation time), not a pid.** Every record
  carries executable realpath/size/mtime, engine version+commit, pid, process
  creation time, parent pid, desktop instance id, loopback endpoint and a token
  digest. A pid whose creation time changed is a stranger: the record is marked
  `stale` and the process is left alone. An unreadable creation time is reported
  as unverifiable rather than guessed.
- **Readiness is identity, not a 200.** `/health` must say
  `codewhale-runtime-api`, `/v1/runtime/info` must match the 1.0 contract with
  `auth_required: true`, loopback `bind_host`, and the port Mona chose, and a
  stateful route (`/v1/providers`) must accept the token. A child that exits at
  any point before its record is written fails the start.
- **Stopping** captures observed descendants, uses `taskkill /PID <pid> /T`
  (grace, then `/F`), polls only those pids, and returns a receipt with
  `rollback_claimed: false`. Real engine stops report `stopped_forced` because a
  console app ignores the polite close — recorded honestly, not dressed up.
- **Crash → bounded process restart** with capped backoff inside a sliding
  window; no turn is ever resubmitted. Exhaustion is a terminal `failed` state.
- **Four transitions, four receipts** (`work-control.ts`): pause-after-task is a
  queue boundary, interrupt-now needs an engine receipt or reports
  `outcome_unknown`, cancel-queued refuses the running task, quit-and-stop
  interrupts then stops and reports `partial` when either half is uncertain.
- **Desktop** (`apps/desktop/src/main/engine-host.ts`, `lifecycle-probe.ts`,
  `main.ts`): single owner, second-instance path forwarding, close hides while
  work is owned, renderer crash destroys the dead window and recreates exactly
  one, `window-all-closed` quits only when nothing is owned, quit interrupts then
  stops. External runtimes attach read-only and `stop()` is refused.
- **No spawn at launch.** Idle Mona starts no process and makes no request.

Two real defects were found by the evidence runs and fixed: a crashed last window
fired `window-all-closed` → quit → stop (work loss), and an exit during startup
was reported as a running runtime with a dead pid.

Evidence: `docs/evidence/P04-supervisor.md` (matrix + limits), `P04-live.json`
(15/15 against the real pinned engine), `P04-lifecycle.json` (10/10 in real
Electron), `P04-tests.txt` (109 Vitest + 13 bootstrap + 8 spike), `P04-checks.txt`,
`P04-build.txt`. Decisions D-0028…D-0031.

Also fixed here: the renderer bundle had pulled zod in through the AppInfo
labels; the label/status vocabulary now lives in
`apps/desktop/src/shared/engine-status.ts` and the bundle dropped from 286 kB to
225 kB.

## Next exact action (P05)

Read P05 in `Mona_PROMPTS.md` (spec 8.1–8.3, 10.1, 17) plus D-0003, D-0008 and
P04's ownership record shape. Build `packages/project-state`: SQLite via
`node:sqlite` (Node 26 has `DatabaseSync`, `backup`), migrations with a version
table, foreign keys, one write path, revision checks, and the maintenance barrier
that all writers respect. Tables per spec 10.1: projects, runtime_bindings,
threads, turns, submissions, tasks, task_dependencies, requirement_evidence,
attempts, decisions, event_cursors, usage_records, capability_snapshots,
settings_versions. Keep engine history authoritative; store projections and
references. Bind `EngineHost.bindJournal` here so quit-and-stop can interrupt for
real. Atomic project export/import with digests; bounded artifact files; portable
handoff bundle; crash injection around transactions; relocation vs. rebinding.

## Relevant files and spec sections

- `packages/adapter/src/{supervisor,ownership,process,work-control,lifecycle}.ts`
- `apps/desktop/src/main/{engine-host,engine-host-config,lifecycle-probe,main}.ts`,
  `apps/desktop/src/shared/engine-status.ts`
- Spec 6.4, 10.3, 13; next: 8.1–8.3, 10.1, 17.
- `docs/evidence/P04-supervisor.md` for the lifecycle matrix and known limits.

## Open problem IDs and no-progress counts

No open blocker; `attempts.jsonl` still holds only the closed P02 rows.

- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift; P16 resolves.
- **P01-ISSUE-002** — Windows allows a second runtime in one workspace; Mona now
  leases one workspace at a time and refuses a second runtime, but the upstream
  behaviour itself is unchanged and parallel workspaces stay off.
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.
- **P04-ISSUE-001** — no Job Object on this host (no MSVC toolchain). Cleanup is
  `taskkill /T` on the verified pid plus reconcile-at-start. Revisit only with a
  recorded build prerequisite (D-0029).
- **P04-ISSUE-002** — close-to-tray has no tray affordance until P07; a hidden
  window is restored by launching Mona again.

## Blocked dependencies

None.

## Last relevant validation

- `npx vitest run` → 109 pass (25 new for P04); bootstrap 13; spike 8.
- `npm run lint`, `npm run format:check`, `npm run typecheck` → pass.
- `npm run build` → pass; `check:build` → pass (225 kB renderer, no zod).
- `npm run smoke -w @mona/desktop` → pass, 332 MB, security assertions intact.
- `npm run lifecycle -w @mona/desktop` → 10/10 real-Electron checks.
- `node packages/adapter/scripts/live-supervisor.mjs` → 15/15 real-engine steps.
- `node tools/build/cli.mjs validate --verbose` → OK, state r12.
- Spend so far ≈ $0.05 of the $2 pilot ceiling; P04 made no provider request.

## Human input needed

None. Same caution as before: edit source with byte-safe tools, not PowerShell
`Get-Content`/`Set-Content` round-trips (D-0027).
