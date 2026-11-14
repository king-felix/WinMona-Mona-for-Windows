# W00 — Windows baseline reconciliation

Recorded 2026-11-14 on the reference machine. This is a reconciliation of the actual
checkout against the supplied P23 report; it is **not** a code review of the product and
it changes no production behaviour.

## Source and environment identity

- Repository HEAD: `c1c9138722b2002b28dfc847c0857b9954a10e08` ("Record standing authorization to
  commit and push without asking"), committed 2026-11-14T09:45:21-07:00.
- Working tree at start of W00: clean except `AGENTS.md`, which failed `prettier --check`
  because a URL in the standing-authorization bullet had been re-wrapped by hand. That is a
  formatting-only repair, committed separately from behaviour work.
- Engine: `codewhale --version` → `codewhale 0.10.2 (ff466b2ed0bf)`, matching the pin in
  `docs/compatibility.md`. This was returned by the installed executable, not assumed.
- Platform: Windows 11 Pro 10.0.26200 (25H2), x64. Node 26.13.1 (build tooling), npm 11.20.0.
- Electron 45.3.0 (Chromium 156, Node 24.22 inside the app) per `docs/compatibility.md`.
- Installed candidate: `%LOCALAPPDATA%\Programs\Mona`, 1,695 files, installed
  `2026-11-13T08:13:51.704Z`; MSIX `Mona-0.1.0-x64.msix` sha256 `9f6b1cb3…b27ace`; identity
  package `MonaWorkbench_0.1.0.0_x64__beqf7zj0yys3p` reports `Status: Ok`; the installed tree
  declares a `MonaMenu.dll` hash and all three `node-pty` prebuilds present.
- Supplement documents indexed: `Mona_Windows_Improvements_Project.md`
  sha256 `adf8ab55…f4555`, `Mona_Windows_Improvements_PROMPTS.md` sha256 `56aa9479…bb1a`
  (recorded in `docs/requirements-windows.json` revision 6 and re-checked by
  `node tools/build/cli.mjs validate`).

## Baseline checks (run, not assumed)

- `node tools/build/cli.mjs validate` → `OK: state revision 83; 24 tasks; 30 requirements;
  0 warning(s)`.
- `node tools/build/cli.mjs status` → 24 completed prompts, 28 verified / 1 blocked
  (MONA-027) / 1 partial (MONA-028) requirements; Windows supplement 26 pending, `W00`
  eligible.
- `npm run ci` before any edit → **failed** at `format:check` on `AGENTS.md` only. After the
  formatting-only repair the full gate ran green: assets:check, format:check, lint, typecheck,
  576 Vitest tests in 70 files, 11 bootstrap, 21 launch, 29 install, 12 assets, 8 spike, and the
  production build (main, preload, renderer).
- `node tools/install/cli.mjs verify` → `ok: true` for the installed tree (checksums, package
  status, PTY payload).
- Secret scan: covered by `cli.mjs validate`; no credential, token or private transcript is
  present in the tracked tree. Test fixtures that look like credentials are fixture strings and
  were not suppressed or rewritten.

## Older evidence, kept as history

The P22/P23 measurement artifacts were produced by earlier builds. They are retained with their
original source identity and are not treated as evidence for the current bytes:

| Historical claim | Recorded value | Status for this pass |
|---|---|---|
| Idle memory | 370.5–377.1 MB (D-0111 accepts for 0.1.0, target 350 MB unchanged) | Historical; W19 re-measures |
| Startup | cold 421 ms, warm 722 ms | Historical, development + installed harness; W24 re-measures on the packaged artifact |
| Accessibility | `npm run a11y` 12/12 | Historical; W20 must add Narrator and physical DPI |
| Modern Explorer menu | registered, never seen by a person | Still open (MONA-027 / W22) |
| Export Save dialog | writer proven, dialog not clicked by a person | Open; W02 qualifies the dialog |
| License | deliberately unchosen | Unchanged; W23/W25 must not choose it |

## Source map (production entry points, discovered by reading this checkout)

- **Shell / window**: `apps/desktop/src/main/main.ts` (window, menu, shortcuts, close-to-tray,
  probes), `apps/desktop/src/renderer/App.tsx` (rail, views, palette, launch receipts).
- **Studio**: `apps/desktop/src/main/studio-service.ts`, `apps/desktop/src/renderer/StudioPanel.tsx`,
  contracts in `apps/desktop/src/shared/studio.ts`.
- **History**: `timeline_items` projection in `studio-service.ts`; query in
  `packages/project-state/src/store.ts`; render window in `StudioPanel.tsx`.
- **State store**: `packages/project-state/src/{store,migrations,barrier,backup,export}.ts`
  (SQLite through `node:sqlite`, single write path, revision checks).
- **Engine adapter / supervisor / queue**: `packages/adapter/src/{adapter,supervisor,work-control,journal}.ts`.
- **Cost**: `packages/project-state/src/costs.ts`, `apps/desktop/src/main/cost-ipc.ts`,
  `apps/desktop/src/renderer/CostPanel.tsx`.
- **IPC boundary**: `apps/desktop/src/main/*-ipc.ts` plus `main.ts` registrations; preload exposes
  83 named methods and no generic invoke; 83 distinct `mona:` channel literals in
  `apps/desktop/src/shared`.
- **Native shell**: `native/windows-shell/mona-menu.c` (IExplorerCommand helper),
  `tools/launch/context-menu.mjs` (classic registration).
- **Packaging**: `tools/install/installer.mjs`, `tools/install/trust.mjs`, `tools/install/cli.mjs`,
  `install-mona.cmd`.
- **Tests and probes**: Vitest across `packages/*` and `apps/desktop/src`; `node --test` suites in
  `tests/{bootstrap,launch,install,assets,native,spike}`; live Electron probes
  `apps/desktop/src/main/*-probe.ts`.

## Suspected Mac→Windows parallels: actual status here

Each row was checked against this checkout before any edit. "Reproduced" means the code path was
read and the defect is present; it is not yet a fix.

| Suspected issue | Status here | Where |
|---|---|---|
| Async draft loss on project/thread switch | **Reproduced** | `App.tsx` `activateProject` commits after two awaits with no request identity; a late `selectProject` result can replace the newer project, session and draft |
| Accepted send clears newer text | **Reproduced** | `StudioPanel.tsx` captures `text` correctly, but `onDraftSent()` clears unconditionally; typing during the await is destroyed and the empty draft is persisted |
| Draft not flushed before `New session` | **Reproduced** | `App.tsx` `newSession` omits `flushDraft()` that `changeScreen` performs |
| Draft save failure silently swallowed | **Reproduced** | `App.tsx` `flushDraft` only acts on `result.ok` |
| Duplicate paid send (button + shortcut) | **Reproduced** | `studio-service.ts` checks run state, then awaits budget/open before committing `preparing`; `submitTurn` gets no `operationKey`, so the adapter mints a new key per call |
| IME / key repeat guarded on submit | **Absent** | no `isComposing` or `event.repeat` check anywhere in `apps`/`packages`; Ctrl+Enter itself is present and correct |
| Replacement import leaves orphaned rows | **Reproduced in library** | `export.ts` upserts the project row (so `ON DELETE CASCADE` never fires) and deletes only task children plus `decisions`; `threads`, `timeline_items`, `usage_records`, `event_cursors`, budgets, baselines, memory and artifacts survive. No product surface calls it yet |
| Maintenance barrier bypassed by a writer | **Partial** | all production writers go through `store.write/exclusive/snapshot`; raw writers exist only in probe seeding (`main.ts`, `memory-probe.ts`, `qa-probe.ts`) |
| Restore failure leaves prior state usable | **Already correct** | staged copy, integrity verify, atomic rename, parked copy retained; gaps are Windows lock/EBUSY retry, a reopen failure after rename, and no restored-schema check |
| Conversation export uses a real Save dialog | **Already correct** | `dialog.showSaveDialog` in `main.ts`; cancel, empty session and atomic write handled; read-only/overwrite rely on the native prompt and a generic error |
| History hidden behind a raw-event cap | **Reproduced (different shape)** | the studio always loads exactly 500 stored rows **ordered `seq ASC`**, so beyond 500 rows the newest history is unreachable; the renderer's "show earlier" only pages inside those 500 |
| Slash command catalog / autocomplete / dispatch | **Absent** | no registry, no parser, no dispatch route (W04/W05) |
| Native Windows fullscreen | **Absent** | Focus Mode is a saved layout only; no `setFullScreen` anywhere (W06) |
| Human answer to an approval request | **Display only** | the card shows and `Interrupt now` is offered; the run detail states Mona does not send approval decisions; no IPC or adapter route (W08) |
| Attachments | **Labelled unsupported** | file references are validated project-relative paths appended to the prompt text; no invented attachment API (W11) |
| Release placeholders ("arrives with P…") | **Already correct** | none remain in `apps/desktop/src`; probes assert their absence (D-0114) |

## Gates: machine-testable vs human/signing

Machine-testable and in scope for this pass: the draft/navigation/submit contracts, replacement
import cleanup, maintenance coverage, restore fault injection, history paging, Tauri-free Electron
window state, IPC sender/schema validation, and the installed-build probes that already exist
(`npm run a11y`, `npm run memory`, `npm run qa`, `npm run surfaces`, `npm run appearance`,
`node tools/install/cli.mjs verify --smoke`).

Human or signing gates, which do not block independent work: the modern Explorer menu appearing
in a real right-click (MONA-027 / W22), machine certificate trust on a clean recipient (W22/W23),
the Narrator walkthrough and physical 200 % scaling (MONA-028 / W20), the real Save dialog click
(W02 records what the dialog requires; a person confirms the overwrite prompt), and the license
decision (W23/W25).

## Review state

`.mona/build/reviews/windows-v2/` holds the subordinate W00–W25 ledger, written atomically with
revision checks by `tools/build/windows-review.mjs` and covered by
`tests/bootstrap/windows-review.test.mjs`. It refuses a completion with no evidence, an open
acceptance item on a completed task, a stale `--expected-revision`, and a fourth attempt after a
three-no-progress stop. All 26 W tasks start `pending`; nothing was pre-marked.

## Next eligible prompt

`W01` (and `W02`, which shares only the `W00` prerequisite). Ascending order is preferred, so W01
is next.
