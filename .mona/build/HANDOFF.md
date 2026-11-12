# Mona build handoff

**Current prompt:** P19 — Finish project memory, portable handoff and diagnostics
**Current status:** P00–P18 completed, plus the authorized native Windows PTY
follow-up. State revision 62 after this checkpoint. Next eligible: P19.

`last_verified_commit` stays null because a state file cannot contain the hash of
the commit that contains it. Verify with `node tools/build/cli.mjs validate`
(expect OK, r62, 0 warnings) before trusting this file.

## Native Windows terminal (follow-up to P18, authorized by Victor)

The engine's `/v1/terminal` routes remain unavailable on Windows (HTTP 501), so
Mona now owns a real ConPTY terminal instead of reporting a gap.

- **Host.** `apps/desktop/src/main/terminal-host.ts` spawns
  `powershell.exe -NoLogo -NoProfile -NoExit` through `node-pty@1.1.0` (shipped
  N-API prebuild, install script **denied**, no compiler) with
  `name: xterm-256color`. Scrollback is capped at 256 KiB in main, output events
  at 32 KiB, input at 8 KiB per call, four sessions at most.
- **UI.** `TerminalDrawer.tsx` is a lazily loaded bottom drawer (Ctrl+` or the
  Terminal button) using xterm.js + fit + search. Copy, Copy all, search with a
  real hit/miss readout, resize via `ResizeObserver`, and a `closing → exited`
  state that comes from the PTY's own exit event.
- **Reconnect.** Closing the drawer destroys the renderer surface but leaves the
  shell running; reopening replays bounded scrollback. Only **End session** or
  app quit kills it.
- **Isolation.** Six named bridge methods and one event channel. No `exec`,
  `spawn`, `shell`, `require`, `process` or `ipcRenderer` in the renderer. No
  link addon (URLs stay text), OSC 52 is consumed and ignored, and injected
  runtime/provider tokens are stripped from the shell environment.
- **Project binding.** The renderer sends `projectId`; main resolves the folder
  and refuses a missing one. Another project cannot write to a session.

**Live proof:** `npm run terminal` → 18/18 checks in real Electron: a shell in the
fixture folder, a command typed through the real textarea input path, output on
screen, no links, resize 160×11 → 138×15 reported by the PTY, real clipboard
write read back from the main process, drawer reconnect, exit with code, and a
bridge without shell globals. No orphan process survived the run.

Two defects the probe found and fixed: `screenReaderMode: true` silently dropped
typed input (now off until a human pass, ISSUE-0019), and the badge claimed
`running` after End session (now driven by the exit event, D-0086).

## P18 result — auditable capability explorer, honest engine terminal gap

- **Explorer.** 57 ledger rows joined with live identity (`/v1/runtime/info`,
  `/v1/process`), capability flags, coverage counts and version/commit drift.
- **Palette.** Every row is a palette item; selecting one opens the explorer and
  focuses the row. Capability items never invoke anything.
- **Logs.** Read-only `GET /v1/logs` with 64 KiB slices, offset paging, path
  refusal and credential redaction.
- **Engine terminal route.** `unavailable-on-platform` (CAP-0053) with the exact
  501 text. Mona's own terminal is CAP-0057, marked `native` rather than engine.

## P17 result — tools and extensions are manageable

Extensions section (Alt+5): MCP servers with revision-guarded enable/disable and
explicit health checks, skills, plugins, hooks and workspace instructions with
scope and provenance. Snapshot performs seven reads and never connects a server
or requests the tool catalog. Unknown config keys survived an edit; a stale
revision is refused.

## Next exact action (P19)

Read P19 in `Mona_PROMPTS.md` and spec sections 8, 10.1, 12 and 13. P19 owns
MONA-024 and MONA-025.

Known starting facts:

- P05 already owns SQLite state, backup/restore and the artifact store. Reuse
  them; no second database, indexer or snapshot engine.
- Prompt shelf: per-project favorites exist (P14). P19 adds variables,
  acceptance criteria, preview, versioning and inert import.
- Search must be local and deterministic: index only permitted metadata; search
  repository files on demand; never copy the repository into the DB.
- Diagnostics: the provider workbench has offline redacted text, and P18 added a
  log reader. P19 adds a local diagnostic bundle preview with redaction and
  artifact digests.
- Portable handoff must omit machine-local bindings and engine-owned sessions;
  imported bindings need requalification.
- Restore and import must take the P05 maintenance barrier.

## Relevant files and spec sections

- `packages/project-state/src/{state,store,changes,catalog,studio}.ts`
- `packages/adapter/src/{diagnostics,configuration,extensions,http}.ts`
- `apps/desktop/src/main/{terminal-host,terminal-service,terminal-ipc,capability-service,extensions-service,provider-workbench,ui-state}.ts`
- `apps/desktop/src/renderer/{TerminalDrawer,CapabilitiesPanel,ExtensionsPanel,ProviderWorkbench,App}.tsx`
- `apps/desktop/src/shared/{terminal,capabilities,extensions,catalog}.ts`
- `docs/evidence/{P17-extensions,P18-capabilities,P18-terminal}.*`
- `docs/codewhale-capabilities.json`, `tools/spike/{p17-extensions,p18-capabilities,qualify-*}.mjs`
- Spec 8, 10.1, 12, 13; O3/O5.

## Open problem IDs and no-progress counts

No open three-attempt blocker. `attempts.jsonl` still holds only the closed P02
rows.

Resolved this session: **ISSUE-0018** — Windows terminal, closed by Victor's PTY
authorization and the verified Mona ConPTY terminal.

New, open:
- **ISSUE-0019** — xterm `screenReaderMode` is off because it disables typed
  input. A human screen-reader pass must decide how to offer it.
- **ISSUE-0020** — node-pty's console-list helper can print `AttachConsole
  failed` to stderr during a forced kill. The session still exits and no process
  survives; it is log noise, not a false state.
- **ISSUE-0021** — pointer drag-selection with a real mouse was not machine
  verified; Copy all and the no-selection message were. Needs a human check.
- **ISSUE-0022** — the P21 installer must unpack `node-pty` from the archive.

Carried: P18-ISSUE-002 (27 of 57 rows discovered-only), P18-ISSUE-003 (no engine
upgrade qualified), P17-ISSUE-001..005, P15-ISSUE-001..003, P16-ISSUE-001..004,
P01-ISSUE-001..004, P05-ISSUE-001, P06-ISSUE-002, P07-ISSUE-001,
P08-ISSUE-001..003, P09-ISSUE-001..002, P10-ISSUE-001..003, P11-ISSUE-001,
P12-ISSUE-001..003, P13-ISSUE-001..003, P14-ISSUE-001..004.

## Blocked dependencies

None. MONA-023 is verified; the engine's own terminal route stays reported as
unavailable, which is a fact rather than a blocker.

## Last relevant validation

- `npm test` → 443 Vitest (50 files) + 13 bootstrap + 12 launch + 8 spike.
- `npm run build` → contracts, adapter, project-state, ui, desktop. Renderer
  361.08 kB (gzip 103.77 kB) plus a lazily loaded terminal chunk 371.57 kB
  (gzip 95.50 kB); idle screens never load xterm.
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run check:build -w @mona/desktop` (61 named preload channels) → pass.
- `npm run terminal` → 18/18 live checks; `docs/evidence/P18-terminal.json`,
  `docs/evidence/P18-terminal-log.txt`, 5 screenshots in
  `docs/evidence/shots-p18-terminal/`.
- `node tools/spike/p18-capabilities.mjs` → 13/13; `p17-extensions.mjs` → 16/16.
- `node tools/build/cli.mjs validate` → OK (r62, 0 warnings).
- Spend: zero for the terminal, P17 and P18. P15's delegated run remains the last
  paid run (5,731.872 µUSD).

## Human input needed

- A real mouse click-drag selection check in the terminal (ISSUE-0021) and a
  screen-reader pass (ISSUE-0019) whenever convenient; neither blocks P19.
- Standing acceptance item for P21/P22: right-click a folder and a folder
  background in Explorer and choose **Start new DS project with Mona** (possibly
  under **Show more options**).

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and one test
string in P14; Prettier does not repair that. `check-build.mjs` fails on mojibake
in the renderer bundle. The remaining `Â·`/`â€™` sequences in `DECISIONS.md` and
older handoff text are quoted examples of that incident, not corrupted text.
