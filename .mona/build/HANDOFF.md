# Mona build handoff

**Current prompt:** P04 — Own runtime processes and stopping behavior correctly
**Current status:** P01, P02 (with one unverified runtime check), and P03
completed. State revision 7. Next eligible: P04, P05, P06.

**Last verified commit / dirty work:** P03 work is in this session's local
commit (see `git log`); working tree is clean after it.

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

- **P02-ELECTRON-BINARY** — 3 no-progress attempts; exact help in `BLOCKERS.md`.
  Desktop runtime launch and process footprint remain unverified.
- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift. P03 reports
  the runtime fingerprint; P16 resolves.
- **P01-ISSUE-002** — Windows allows a second runtime in one workspace.
  Serialized execution remains the default until P04 owns a lease.
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.

## Blocked dependencies

- Electron runtime: P02-ELECTRON-BINARY. Does not block P04/P05/P06.
- No adapter blocker. `attempts.jsonl` has only the three Electron entries.

## Last relevant validation

- `npm test` → 73 Vitest + 11 bootstrap + 8 spike = 92 pass.
- `npm run typecheck`, `npm run lint`, `npm run format:check` → pass.
- `npm run build` → contracts, adapter, desktop; renderer checks pass.
- `node tools/build/cli.mjs validate --verbose` → OK, state r7.
- Live smoke spend **$0.003543**; cumulative P01/P03 recorded spend still well
  under the $2 pilot ceiling.

## Human input needed

Electron binary for the desktop smoke: allow GitHub/objects.githubusercontent.com
egress, provide a reachable `ELECTRON_MIRROR`, or seed
`%LOCALAPPDATA%\electron\Cache` with `electron-v45.3.0-win32-x64.zip`, then
`node node_modules/electron/install.js` and `npm run smoke -w @mona/desktop`.
