# Mona developer guide

This is the working guide for changing Mona. It assumes Windows PowerShell 5.1 (no `pwsh`
required), Node 22+, and an installed Codewhale engine for the live probes.

## 1. Layout and ownership

| Path | Owns |
|---|---|
| `apps/desktop/src/main` | Electron main process: services, IPC registration, probes, lifecycle |
| `apps/desktop/src/preload` | The whole renderer surface: frozen, named methods only |
| `apps/desktop/src/renderer` | React shell, panels, styles; no file system, shell or network |
| `apps/desktop/src/shared` | Types and channel names shared by main, preload and renderer |
| `packages/contracts` | Zod schemas, engine event contracts, fixtures |
| `packages/adapter` | HTTP client, SSE parser, supervisor, work queue, config/extension adapters |
| `packages/project-state` | SQLite store, migrations, tasks, attempts, costs, changes, memory |
| `packages/ui` | Tokens, primitives, overlays, virtualization, the design harness |
| `native/windows-shell` | `IExplorerCommand` helper; builds with the pinned Zig toolchain |
| `tools/build` | Bootstrap state/ledger utility — never a product dependency |
| `tools/install` | Staging, identity package, signing, per-user install/upgrade/uninstall |

Rules that keep the boundary honest:

- A renderer never receives a raw engine payload or an arbitrary runtime capability.
- One IPC audit test wires every module with an untrusted sender; any channel that answers
  something other than `untrusted_sender` fails the suite.
- `apps/desktop/scripts/check-build.mjs` asserts the exact preload channel allowlist, denies
  remote origins, network transports and engine routes in the renderer bundle, and rejects
  double-encoded UTF-8.

## 2. Build and gate

```powershell
npm ci
npm run build          # contracts -> adapter -> project-state -> ui -> desktop
npm run typecheck
npm run lint
npm run format:check
npm test               # Vitest + bootstrap/launch/install/spike node:test suites
npm run native:test    # compiled menu helper
npm run ci             # all of the above in order
```

Probes (each drives real Electron; the ones that need an engine say so):

```powershell
npm run smoke                                   # window, CSP, isolation, one IPC channel
npm run lifecycle -w @mona/desktop              # owner, restart, crash, quit
npm run shots -w @mona/desktop                  # themes, densities, scaling, focus audit
npm run catalog -w @mona/desktop                # catalog lifecycle and drafts
npm run studio -w @mona/desktop                 # real paid turn: costs money
npm run polish -w @mona/desktop                 # keyboard, notifications, quiet hours
npm run terminal -w @mona/desktop               # ConPTY typing, resize, search, exit
npm run qa -w @mona/desktop                     # startup, idle CPU, memory, history
npm run changes -w @mona/desktop                # real Git diffs, change list, receipts
```

Only `studio` submits a paid turn. Everything else is designed to make zero provider requests,
and each probe asserts that.

## 3. Build state and the requirement ledger

```powershell
node tools/build/cli.mjs validate
node tools/build/cli.mjs status
node tools/build/cli.mjs checkpoint --prompt P23 --status completed --expected-revision 67 ...
node tools/build/cli.mjs evidence --requirement MONA-014 --criterion diffs --path docs/evidence/x.md --status passed
node tools/build/cli.mjs index     # rehash the spec documents after editing them
node tools/build/cli.mjs recover   # after an interrupted write
```

`checkpoint` requires `--expected-revision`, so a stale writer cannot overwrite newer state.
Evidence rows are hashed; a criterion cannot be marked passed with no artifact, and editing an
artifact after recording it leaves a stale reference that `evidence --prune-stale` removes
explicitly. Requirement status is derived from criteria, not asserted.

## 4. Schemas and migrations

- `packages/project-state/src/migrations.ts` holds versioned, immutable migrations, each with a
  checksum. Editing a shipped migration fails closed; add a new one.
- `openState()` takes a **verified backup** before applying pending migrations, then applies them
  under the maintenance barrier. A failure rolls back; recovery files are never deleted.
- Writes go through a single write path with revision checks and foreign keys enabled.
- Current schema version in the shipped build: **7**.
- Rollback path for a release: restore the pre-migration backup (`backups/`) while the app is
  closed — see `docs/release-notes-0.1.0.md`. Downgrading the *program* without restoring the
  database is refused rather than silently operated on an older schema.

## 5. Failure fixtures and high-risk boundaries

`docs/evidence/P20-failure-matrix.md` lists 22 scenarios with the injection method for each:
real-file failure, killed process, corrupt file, disk-full refusal, interrupted restore, IPC
sender spoofing, path injection. When you touch one of these boundaries, run its scenario and
add a test at the same layer:

- **Process ownership** — `packages/adapter/src/supervisor.test.ts` (real process trees).
- **Submission replay** — `packages/adapter/src/journal.test.ts`, studio reconciliation tests.
- **State writes** — `packages/project-state/src/store.test.ts` (crash mid-transaction).
- **Restore** — `packages/project-state/src/changes.test.ts` (stale hash, staged changes).
- **Budget math** — `packages/project-state/src/costs.test.ts` (microUSD arithmetic).
- **IPC boundary** — `apps/desktop/src/main/ipc-audit.test.ts`.

Never replace an integration test with a mock and call it runtime compatibility. A mock can
prove Mona's reaction; only the real engine proves the contract.

## 6. Adapter qualification

1. `EngineAdapter.discover()` reads the engine's identity and capability flags.
2. `assessCompatibility()` maps that into `qualified | compatible_unqualified | unsupported`
   with reasons (missing flags are false).
3. Every operation Mona uses is qualified individually against the pinned build; the ledger row
   records the route, the platform, the risk class and the evidence path.
4. To add a route: add the adapter method, the ledger row, a fixture test, one live probe step,
   and the UI entry point — in that order. No route is surfaced before it is verified.

## 7. Adding capability coverage

`docs/codewhale-capabilities.json` has one row per engine capability with its Mona integration
label. Adding coverage means:

1. Add or update the row (`status`, `integration`, `uiLocation`, `tests`, `gap`).
2. Provide the native control, or the schema-validated advanced action with effect preview, or
   an honest `unavailable` state with the exact reason.
3. Re-run `node tools/spike/qualify-capabilities.mjs` and re-hash the ledger with
   `node tools/build/cli.mjs evidence`.
4. Never mark a row qualified because a terminal command exists. A terminal preserves access; it
   does not satisfy a promised native control.

## 8. Editing rules that have already cost time

- **Byte safety.** A PowerShell `Get-Content`/`Set-Content` round trip double-encoded `App.tsx`
  once. Use an editor or Node that writes UTF-8, and run `check-build` — it fails on mojibake.
- **Renderer bundles.** No remote origin, no `fetch` to an absolute URL, no WebSocket, no `/v1/`
  route. The static check enforces all four.
- **Channel allowlist.** Adding an IPC method means updating `check-build.mjs`; the build fails
  on an unexpected channel on purpose.
- **Costs.** Never call the provider from a UI path. Idle, navigation, exports, reconnects and
  replays must remain free; there are tests that assert zero turns.

## 9. Local commits

This repository has **no remote**. Commit locally, one coherent change per commit, and record
the checkpoint (`state.json`, `HANDOFF.md`, ledger) in the same commit or the one immediately
after. Do not create a remote, publish a package, or push anywhere without an explicit,
recorded authorisation.
