# P02 — Desktop foundation and strict contracts

Captured 2026-11-12. Node 26.13.1, npm 11.20.0, Windows 11 x64.

## Status

The desktop repository, security boundary, shared schemas, fixtures, renderer
shell, tests, production build, **and the real Electron window** are implemented
and verified.

The earlier Electron blocker was environmental and transient: at the time, the
local resolver (`192.168.1.1`) returned `ENOTFOUND` for `github.com`,
`objects.githubusercontent.com`, and three mirrors while `registry.npmjs.org`
resolved. On retry the same names resolved normally, `install.js` downloaded
Electron 45.3.0, and the smoke test passed. No firewall, proxy, hosts-file, or
DNS setting was changed; the only installed artifact is the Electron runtime
itself. `P02-electron-blocker.txt` keeps the original failure record, and
`BLOCKERS.md` marks the prerequisite obtained.

## Live window evidence (`P02-smoke.json`)

Launched the production build (`electron . --smoke-test`, no dev server, no
engine process, no network request from the window):

- Title `Mona`, displayed version `v0.1.0` = `app.getVersion()`.
- Placeholder navigation present: Projects, Work, Cost, Settings.
- Engine state rendered honestly as `Engine not connected`.
- Daybreak theme applied; no fixture marker in the DOM.
- Bridge: exactly one key (`getAppInfo`), frozen; no `window.require`,
  `window.process`, or `window.ipcRenderer`.
- **Remote navigation refused live:** `location.assign('https://example.com/')`
  left the URL at `file:///…/dist/renderer/index.html`.
- **Remote popup refused live:** `window.open('https://example.com/')` returned
  null; window count stayed 1.
- DevTools closed in the production window.
- Process footprint: Browser ~101–102 MB, GPU ~100 MB, Utility ~50 MB,
  renderer ~78 MB; **total ~323–330 MB working set** across two runs, one
  renderer process. Electron's memory is a local resource cost, not a token
  cost.

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

- `npm run typecheck` → pass (contracts build + adapter + main/preload/renderer/test programs).
- `npm run lint` → pass.
- `npm run format:check` → pass.
- `npm test` → **73 Vitest** (contracts, adapter, IPC/security, renderer DOM) +
  **12 bootstrap** + **8 spike**, all pass.
- `npm run build` → pass: tsc main, esbuild preload (327 B), Vite renderer.
- `node apps/desktop/scripts/check-build.mjs` → pass: CSP replaced, no fixtures,
  no credentials, one preload channel, no remote origin, no engine route.
- `npm run smoke -w @mona/desktop` → pass, including the live navigation,
  popup, bridge, and devtools assertions; report in `P02-smoke.json`.
- Bundle baseline: renderer JS **224.22 kB** (70.18 kB gzip), CSS **4.74 kB**,
  HTML 736 B, main 5.46 kB + 2.68 kB + 1.44 kB, preload 327 B.
- Process footprint: **~323–330 MB** total working set, one renderer process.

## Bugs found and fixed while verifying

- TypeScript 7.0.2 conflicted with typescript-eslint's peer range; pinned 6.0.3.
- `ajv` was dropped from root devDependencies during the workspace rewrite and
  broke the P00 bootstrap CLI; restored 8.20.0.
- The bootstrap test sandbox copied the live requirement ledger, so P01’s
  verified requirement changed what the test expected. The sandbox now resets
  requirement status/evidence to pending before `init`, honouring D-0010.
- The preload was emitted twice (tsc ESM and esbuild CJS); the authoritative
  `preload.cjs` remains and the stray emit was removed.
- The smoke test initially asserted only rendering. It now also drives a remote
  navigation and a `window.open` inside the real window and fails the run if
  either is allowed, so the security section is proven by behaviour rather than
  by code reading alone.
- A PowerShell `Get-Content`/`Set-Content` round-trip double-encoded four files,
  including the prompt-heading regex in `tools/build/cli.mjs`. `validate` then
  reported all 24 prompt sections missing even though `Mona_PROMPTS.md` was
  untouched. The literal is now ASCII-only (`^### (P\d{2})(?=\s)`) and D-0027
  bans that editing path.

## Audit

`npm audit` reports **10 moderate, 0 high, 0 critical**, all in the dev-only
ESLint/minimatch chain (GHSA-g3hv-75wg-m249, ReDoS-style glob amplification).
The offered fix downgrades ESLint to 9.x, a breaking change. No production
dependency is implicated; recorded and accepted for P02.
