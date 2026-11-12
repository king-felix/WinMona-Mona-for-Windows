# P18 follow-up — native Windows PTY terminal

**Status:** implemented and verified
**Authority:** Victor authorized a native Windows PTY path on 2026-11-12,
closing the blocked terminal criterion of MONA-023 (`ISSUE-0018`).
**Engine:** Codewhale `0.10.2 (ff466b2ed0bf)` — its own `/v1/terminal` route is
still Unix-only and is reported as unavailable (see P18-capabilities.md).
**Spend:** zero. The terminal never contacts a provider; the probe made no turn.

## What was built

A **Mona-owned ConPTY terminal** in a bottom drawer (Ctrl+` or the Terminal
button), rendered with xterm.js:

- **Real PTY.** `node-pty@1.1.0` spawns `powershell.exe -NoLogo -NoProfile
  -NoExit` through ConPTY with `name: xterm-256color`. The package ships N-API
  prebuilt binaries for `win32-x64`; **no compiler or build tools are needed**,
  and the package install script is **denied** in `package.json` so nothing runs
  at install time.
- **Project-bound.** The renderer sends a `projectId`, never a path. Main
  resolves the folder from the catalog and refuses a missing folder. A session
  belongs to one project; another project cannot write to it.
- **Input.** Typed characters go through xterm → one dedicated IPC channel →
  the PTY. Input is capped at 8 KiB per call; the renderer chunks larger pastes.
  Nothing about terminal content can reach a shell command string: there is no
  command construction anywhere.
- **Output.** Bounded to 256 KiB of scrollback in main; each event is split at
  32 KiB. Closing the drawer destroys the renderer surface but leaves the shell
  running; reopening calls `terminalRefresh` and replays the bounded scrollback.
  Only **End session** (or app quit) kills the process.
- **Exit truth.** The badge shows `running` → `closing` → `exited`, and the exit
  code comes from the PTY's own exit event. Mona never shows "running" after the
  user ended a session; the reply to `kill` is not treated as proof.
- **Copy.** `Copy` copies the selection; `Copy all` copies the whole buffer. Both
  try `navigator.clipboard` and fall back to a narrow `mona:terminal-copy`
  channel that writes through Electron's clipboard in main (a window without
  focus cannot use the async clipboard API). The probe reads the OS clipboard
  back from the main process, so the copy proof is real.
- **Search.** xterm's search addon with visible match decorations; the toolbar
  reports "Match found" or "No match" from the addon's own return value.
- **Resize.** A `ResizeObserver` fits the terminal to the drawer and sends
  `cols`/`rows` to the PTY; the PTY reports the new size back.
- **Isolation.** xterm is loaded lazily only when the drawer opens. No link
  addon is loaded, so a URL in output is inert text. OSC 52 (a program asking to
  write the clipboard) is consumed and ignored. The preload exposes six named
  terminal methods and no `exec`, `spawn`, `shell`, `require`, `process` or
  `ipcRenderer`.
- **Credentials.** The shell inherits the user's environment minus runtime and
  provider tokens Mona injected (`CODEWHALE_RUNTIME_TOKEN`,
  `DEEPSEEK_RUNTIME_TOKEN`, `DEEPSEEK_API_KEY`, `CODEWHALE_API_KEY`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `MONA_*` secrets).

## Live evidence (`docs/evidence/P18-terminal.json`)

`npm run terminal` launches the built app in real Electron, opens a fixture
project, and drives the real UI. 18/18 checks passed:

1. The fixture project opens in the real catalog.
2. The Terminal control opens the drawer.
3. The drawer is visible.
4. A shell starts in the open project folder (PowerShell prompt in that path).
5. The terminal rendered through xterm.
6. **A command typed at the prompt produces real shell output** — typing went
   through the real textarea input path (`typedVia: "keyboard"`).
7. Terminal output contains no clickable links.
8. Terminal output contains no images or frames.
9. Resizing the window resizes the terminal and the PTY reports it
   (160×11 → 138×15).
10. Copy with no selection explains what to do.
11. Search reports a real hit and a real miss.
12. **Copy all puts the real terminal buffer on the OS clipboard** (215 chars,
    contains the command output, read back from the main process).
13. Closing the drawer releases the renderer surface.
14. **The shell keeps running in main after the drawer closes.**
15. Reopening the drawer replays bounded scrollback.
16. End session is available.
17. Ending the session reports an exit instead of a silent close
    (`exit -1073741510`, `[killed] The shell was terminated (code …)`).
18. The bridge exposes only named terminal methods and no shell or Node globals.

Screenshots: `docs/evidence/shots-p18-terminal/01..05`.
Log: `docs/evidence/P18-terminal-log.txt`.

No orphan process remained after the probe (checked with `Get-CimInstance` for
`powershell.exe`/`node.exe` matching the fixture path).

## Two real defects the probe found and fixed

- **`screenReaderMode: true` silently disabled typed input.** xterm's
  textarea-input path is skipped when that option is on, so a user's keystrokes
  were dropped. The drawer now leaves the option off and `ISSUE-0019` records
  that a human screen-reader pass is still required before enabling it.
- **The badge stayed "running" after End session.** The kill reply arrives
  before the process exits. The drawer now keeps the session id until the real
  exit event, shows `closing` meanwhile, and only then reports `exited` with the
  code. The buffer is also no longer cleared, so the user can still copy it.

## Honest limits

- The terminal is Mona-owned, not an engine feature. The engine's own
  `/v1/terminal` routes still return HTTP 501 on Windows and are reported as
  `unavailable-on-platform` (CAP-0053).
- No shell-process allowlist, sandbox or per-command approval applies to the
  terminal: Full Access is a posture, and a local shell is a local shell. What
  is enforced is that model output, Markdown, hooks, MCP content and tool output
  cannot reach it.
- node-pty's console-list helper prints `AttachConsole failed` to stderr when a
  forced kill happens outside a console. The session still exits and no process
  survives; it is recorded as `ISSUE-0020` rather than hidden.
- App-quit cleanup (`closeAll`) is unit-tested, but the probe ends with
  `app.exit`, which bypasses `will-quit`; a live close-then-quit check belongs to
  P20/P22 rather than being implied here.
- Screen-reader mode, OSC 52 copy intent, and pointer drag-selection with a real
  mouse are not machine-verified (`ISSUE-0019`, `ISSUE-0021`).
- The packaged installer must mark `node-pty` as an unpacked native dependency;
  that belongs to P21.

## Checks

- `npm test` — 443 Vitest (50 files) + 13 bootstrap + 12 launch + 8 spike.
- `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run check:build -w @mona/desktop` (60 named preload channels).
- `npm run terminal` — 18/18 live checks.
