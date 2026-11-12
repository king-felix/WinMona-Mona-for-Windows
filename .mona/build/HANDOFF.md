# Mona build handoff

**Current prompt:** P04 — Own runtime processes and stopping behavior correctly
**Current status:** P01, P02 (now verified end to end, including the real Electron
window), and P03 completed. State revision 9. Next eligible: P04, P05, P06.

**Last verified commit / dirty work:** this session's commit covers the P02
runtime verification, the blocker resolution, and two bootstrap-CLI additions;
working tree is clean after it.

## P02 runtime verification — the blocker is gone

P02-ELECTRON-BINARY was a **transient resolver failure**, not a network policy.
On retry, `github.com`, `api.github.com`, and `objects.githubusercontent.com`
resolved and served HTTP 200, `node node_modules/electron/install.js` installed
Electron 45.3.0, and the smoke test passed. No firewall, proxy, hosts-file, DNS,
or registry setting was changed.

The smoke test now proves behaviour, not rendering only:

- real window renders `Mona`, version `v0.1.0`, Projects/Work/Cost/Settings,
  `Engine not connected`, Daybreak theme, no fixture marker;
- bridge has exactly one frozen key (`getAppInfo`), no `require`/`process`/
  `ipcRenderer` globals;
- live `location.assign('https://example.com/')` refused (URL unchanged);
- live `window.open('https://example.com/')` returned null, window count 1;
- DevTools closed; footprint **~323–330 MB** working set, one renderer.

Evidence: `docs/evidence/P02-smoke.json`, `P02-smoke-log.txt`,
`P02-foundation.md`. `BLOCKERS.md` now has no open entry; the three no-progress
attempts remain in `attempts.jsonl` with a closing row (D-0025).

Two bootstrap-CLI additions this session: `--clear-remaining-steps` (finish a
previously recorded remaining step) and `evidence --prune-stale` (drop evidence
references whose digest no longer matches). Both are covered by
`tests/bootstrap` (13/13).

## P03 result — the adapter is real now

`packages/adapter` replaces the P01 spike for product use:

- `discover`, `createOrOpenThread`, `getEffectiveProfile`, `submitTurn`,
  `reconcileSubmission`, `subscribe`, `interrupt`, `readHistory`, `readUsage`,
  `invokeCapability`, and a minimal `startOwnedRuntime`/`stop`.
- Compatibility policy: qualified `0.10.2` + `ff466b2ed0bf`; other `0.10.x` is
  compatible-unqualified with reasons; anything else is refused. Missing
  capability flags are treated as unsupported.
- Submission safety: intent persisted before POST; operation key on every turn;
  replay returns the same turn; a lost response becomes `outcome_unknown` and
  reconciles with one read-only lookup, never a second POST; wrong-thread answers
  cannot mutate the intended record.
- Event stream: bounded SSE decoder (UTF-8 split, CRLF, partial frames, 1 MiB
  cap), seq dedup, `since_seq` reconnect with bounded backoff, unknown events
  preserved, malformed known payloads reported as diagnostics, auth errors stop.
- Usage: thread totals mapped to miss/hit/output buckets; cost known only when
  the engine reports complete pricing, otherwise explicitly unknown.

Live smoke against the pinned engine passed every step: real turn, priced usage
**$0.003543312**, idempotent replay, strictly increasing journal, interrupt to
`interrupted`, zero diagnostics. Evidence: `docs/evidence/P03-adapter.md`,
`P03-live.json`, fixtures in `packages/adapter/fixtures/`.

## Next exact action (P04)

Read P04 in `Mona_PROMPTS.md` (spec 6.4, 10.3) plus D-0012 and P03's process
notes. Replace the minimal `startOwnedRuntime` with a real supervisor: track
executable/version/PID creation identity, workspace, endpoint, ownership token
and startup receipt; one driver per workspace; renderer-crash-safe main process;
tray/quit semantics belong later; Windows Job Object or equivalent tested
descendant cleanup; never kill by process name. Do not enable parallel
workspaces until the lease is proven.

## Relevant files and spec sections

- `packages/adapter/src/{adapter,http,sse,journal,compatibility,mapping}.ts`.
- `packages/contracts/src/*` — event/usage/submission contracts.
- `docs/evidence/P03-adapter.md`, `P03-live.json`, P01 G0/concurrency evidence.
- `Mona_Project.md` sections 6.4, 10.2, 10.3.

## Open problem IDs and no-progress counts

No open blocker. `attempts.jsonl` holds only the closed P02-ELECTRON-BINARY rows.

- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift. P03 reports the
  runtime fingerprint; P16 resolves.
- **P01-ISSUE-002** — Windows allows a second runtime in one workspace.
  Serialized execution remains the default until P04 owns a lease.
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.

## Blocked dependencies

None. The only prerequisite that was blocking (Electron runtime) is resolved and
evidenced.

## Last relevant validation

- `npm test` → 73 Vitest + 13 bootstrap + 8 spike = 94 pass.
- `npm run typecheck`, `npm run lint`, `npm run format:check` → pass.
- `npm run build` → contracts, adapter, desktop; renderer checks pass.
- `npm run smoke -w @mona/desktop` → pass with the live security assertions.
- `node tools/build/cli.mjs validate --verbose` → OK, state r9.
- Spend so far ≈ $0.05 of the $2 pilot ceiling.

## Human input needed

None. One caution for the next session: edit source with byte-safe tools, not
PowerShell `Get-Content`/`Set-Content` round-trips — one such round-trip
double-encoded four files and broke the prompt-heading validator (D-0027).
