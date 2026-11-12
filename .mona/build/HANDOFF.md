# Mona build handoff

**Current prompt:** P03 — Implement the real versioned engine adapter
**Current status:** P01 completed; P02 delivered with one unverified runtime check
(state revision 6). Next eligible: P03.

**Last verified commit / dirty work:** P02 work is in this session's local
commit (see `git log`); working tree is clean after it.

## P02 result (read this before trusting the desktop app)

The Electron/React/TypeScript foundation is built, typechecked, linted, tested,
and statically security-checked:

- npm workspaces: `apps/desktop` + `packages/contracts`; lockfile committed.
- Electron 45.3.0, React 19.3.1, Vite 8.3.8, TypeScript 6.0.3, Zod 4.6.7,
  Vitest 5.1.0. TypeScript is held at 6.0.3 because typescript-eslint 8.72 does
  not accept 7.x.
- Sandboxed, context-isolated renderer; Node integration and webviews disabled;
  one frozen preload method over `mona:app-info`; sender-frame and payload
  validation; CSP injected at build time and sent as a header; navigation,
  redirects, window opens, webviews, and permission requests denied.
- Contracts: branded opaque IDs, engine identity/capabilities, effective profile,
  event envelope + known payloads, usage with explicit unknown cost, submission
  state machine with reconciliation, project/task, typed errors, upstream wire
  types mapped at the boundary, and labeled fixtures.
- 38 Vitest + 11 bootstrap + 8 spike tests pass; production build passes; the
  built renderer has no fixture marker, credential, remote origin, or engine
  route; one preload channel only.
- Bundle baseline: renderer JS 224.22 kB (70.18 kB gzip), CSS 4.74 kB, preload
  327 B, main 9.58 kB total.

**Unverified, blocked:** the Electron runtime binary cannot be downloaded here.
Only `registry.npmjs.org` resolves; GitHub and every tested mirror return
`ENOTFOUND`, and the npm tarball has no binary. The window launch, navigation
refusal in a live process, and process-footprint measurement did **not** run.
`npm run smoke` exits 3 with guidance. See `BLOCKERS.md` P02-ELECTRON-BINARY and
`docs/evidence/P02-electron-blocker.txt`. Do not claim Electron runtime
compatibility until this runs.

## Next exact action (P03)

Read P03 in `Mona_PROMPTS.md` (spec 6, 7.1, 10.2) plus P01 decisions and
fixtures. Build the reusable adapter in `packages/` over the qualified HTTP
transport, preserving the P01 contracts: operation key persisted before send,
no blind retry, event cursor/replay, typed unsupported capabilities, bounded
stream parsing. Use the P01 spike client and contract JSON as the reference, not
prose.

## Relevant files and spec sections

- `apps/desktop/src/main/{main,security,ipc}.ts`, `src/preload/preload.ts`.
- `packages/contracts/src/*` — schemas, fixtures, upstream mapping.
- `tools/spike/runtime/client.mjs` — P01 client to replace.
- `docs/evidence/P01-{contract,g0,bench}.json` — observed wire behavior.
- `Mona_Project.md` sections 6, 7.1, 10.2.

## Open problem IDs and no-progress counts

- **P02-ELECTRON-BINARY** — 3 consecutive no-progress attempts, recorded in
  `attempts.jsonl`; exact help in `BLOCKERS.md`. Not reset by this session.
- **P01-ISSUE-001** — endpoint fingerprint drift (exec vs runtime); P03 displays
  the runtime fingerprint, P16 resolves.
- **P01-ISSUE-002** — serialize per workspace until P04/P07 own a lease.
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional.

## Blocked dependencies

The desktop **runtime** proof waits on the Electron binary. The adapter (P03)
does not need it, which is why P03 proceeds; its dependency on the repository and
contracts is satisfied. Do not mark MONA-006 or MONA-026 verified while the
runtime check is unrun.

## Last relevant validation

- `npm run typecheck`, `npm run lint`, `npm run format:check` → pass.
- `npm test` → 38 + 11 + 8 pass.
- `npm run build` + `apps/desktop/scripts/check-build.mjs` → pass.
- `npm audit` → 10 moderate dev-only (ESLint/minimatch), 0 high/critical.
- `node tools/build/cli.mjs validate --verbose` → run after checkpoint.

## Human input needed

One of: allow GitHub/objects.githubusercontent.com egress; provide a reachable
`ELECTRON_MIRROR`; or seed `%LOCALAPPDATA%\electron\Cache` with
`electron-v45.3.0-win32-x64.zip`. Then run `node node_modules/electron/install.js`
and `npm run smoke -w @mona/desktop`.
