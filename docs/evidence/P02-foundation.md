# P02 — Desktop foundation and strict contracts

Captured 2026-11-12. Node 26.13.1, npm 11.20.0, Windows 11 x64.

## Status

The desktop repository, security boundary, shared schemas, fixtures, renderer
shell, tests, and production build are implemented and pass. **One acceptance
item is blocked by the environment:** the Electron runtime binary cannot be
downloaded (only `registry.npmjs.org` resolves; GitHub and every tested mirror
return `ENOTFOUND`), so the real window launch and process-footprint measurement
could not run. See `P02-electron-blocker.txt` and `BLOCKERS.md`
(P02-ELECTRON-BINARY). Nothing in this report claims Electron runtime
compatibility.

## Stack and pinned versions

| Concern | Decision | Version |
|---|---|---|
| Package manager | npm workspaces (`apps/*`, `packages/*`) | 11.20.0 |
| Desktop shell | Electron | 45.3.0 |
| UI | React + React DOM | 19.3.1 |
| Renderer build | Vite + `@vitejs/plugin-react` | 8.3.8 / 6.3.0 |
| Language | TypeScript | 6.0.3 (7.0.2 is outside typescript-eslint's peer range) |
| Validation | Zod, shared across IPC and persisted types | 4.6.7 |
| Main/preload build | tsc for main; esbuild CJS bundle for sandboxed preload | 6.0.3 / 0.28.2 |
| Product tests | Vitest + happy-dom for renderer DOM tests | 5.1.0 / 21.0.4 |
| Lint / format | ESLint 10 flat config + typescript-eslint; Prettier | 10.14.0 / 8.72.2 / 3.10.0 |
| Bootstrap tests | retained `node:test` (P00 utility, separate from product) | Node 26.13.1 |

`package-lock.json` is committed. One schema library (Zod), one product test
runner (Vitest), one state approach for this prompt (typed in-memory records;
SQLite belongs to P05), one package manager (npm). The bootstrap/spike suites use
`node:test` because they are P00 tooling, not product code; D-0019 records this.

## Security boundary (MONA-026 contribution)

- `BrowserWindow`: `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`,
  `webviewTag: false`, `devTools` only in development,
  `allowRunningInsecureContent: false`.
- Preload exposes exactly one frozen method (`getAppInfo`) over exactly one
  channel (`mona:app-info`); no filesystem, shell, network, or arbitrary IPC.
- IPC rejects a missing/subframe/untrusted sender and rejects any payload that is
  not `{}`. Failures return a typed `ErrorResult`; handlers never throw raw
  errors at the renderer.
- App-origin checks accept only the bundled `index.html` or an explicitly
  configured loopback dev server on `127.0.0.1`; remote URLs, other files, and
  subframes are refused.
- `will-navigate`, `will-redirect`, `will-attach-webview`, and
  `setWindowOpenHandler` deny anything outside the app origin.
- Permission requests and permission checks are denied.
- CSP is injected at build time and set as a response header. Production:
  `default-src 'none'; script-src 'self'; connect-src 'none'; object-src 'none';
  frame-ancestors 'none'`. The built renderer is statically checked for an
  unreplaced placeholder, credentials, fixture markers, remote origins, engine
  routes, and network transports.

## Contracts (`@mona/contracts`)

- Opaque branded IDs: project, task, attempt, submission, thread, turn,
  capability, operation key. Wrong-kind IDs fail at runtime and at compile time.
- `EngineIdentity`, `EngineCapabilities` (all flags required, so a missing flag
  cannot default to “supported”), `EffectiveProfile`, `CapabilityState`.
- `EngineEventEnvelope` + known payloads (`turn.completed`, `item.delta`,
  `approval.required`, `stream.end`). Unknown event names stay inspectable;
  known names with malformed payloads are rejected.
- `UsageBuckets` + `CostEvidence` discriminated union: cost is `known` with a
  source/rate revision, or explicitly `unknown` with a reason — never zero.
- `SubmissionState` + transition guard + `SubmissionRecord` with reconciliation
  guidance for `outcome_unknown`.
- `Project`, `ProjectTask`, `GitState`, `ErrorResult`.
- Upstream wire schemas (`UpstreamThread`, `UpstreamTurn`, `UpstreamEventFrame`)
  are separate and mapped into Mona types; raw upstream shapes do not reach UI
  code.
- Fixtures cover connecting, running, completed, interrupted, unknown-cost,
  blocked, unsupported, and malformed. They carry the marker
  `mona.fixture.test-only`, and the build scan proves the marker is absent from
  the shipped renderer.

## Verification

- `npm run typecheck` → pass (contracts build + main/preload/renderer/test programs).
- `npm run lint` → pass.
- `npm run format:check` → pass.
- `npm test` → **38 Vitest** (contracts, IPC/security, renderer DOM) + **11
  bootstrap** + **8 spike**, all pass.
- `npm run build` → pass: tsc main, esbuild preload (327 B), Vite renderer.
- `node apps/desktop/scripts/check-build.mjs` → pass: CSP replaced, no fixtures,
  no credentials, one preload channel, no remote origin, no engine route.
- Bundle baseline: renderer JS **224.22 kB** (70.18 kB gzip), CSS **4.74 kB**,
  HTML 736 B, main 5.46 kB + 2.68 kB + 1.44 kB, preload 327 B.
- `npm run smoke` → exits 3 with the explicit blocker message. No fake pass.
- Process footprint: **not measured** (requires the Electron binary).

## Bugs found and fixed while verifying

- TypeScript 7.0.2 conflicted with typescript-eslint's peer range; pinned 6.0.3.
- `ajv` was dropped from root devDependencies during the workspace rewrite and
  broke the P00 bootstrap CLI; restored 8.20.0.
- The bootstrap test sandbox copied the live requirement ledger, so P01’s
  verified requirement changed what the test expected. The sandbox now resets
  requirement status/evidence to pending before `init`, honouring D-0010.
- The preload was emitted twice (tsc ESM and esbuild CJS); the authoritative
  `preload.cjs` remains and the stray emit was removed.

## Audit

`npm audit` reports **10 moderate, 0 high, 0 critical**, all in the dev-only
ESLint/minimatch chain (GHSA-g3hv-75wg-m249, ReDoS-style glob amplification).
The offered fix downgrades ESLint to 9.x, a breaking change. No production
dependency is implicated; recorded and accepted for P02.
