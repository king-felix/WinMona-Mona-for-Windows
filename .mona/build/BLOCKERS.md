# Mona build blockers

No blocker is open. This file records blockers that stop a problem after three
consecutive no-progress attempts, plus the human input required to clear them.
Acknowledging a blocker never resets its counter or clears the row.

## Open

_None._

## Prerequisites that are not blockers yet

| Item | Needed by | State | What clears it |
|---|---|---|---|
| Verifiable DeepSeek route | P01 (G0/G1) | **verified** at P01: `doctor --probe-api` passed; model resolved to `deepseek-flash`; live turns priced | nothing; re-probe only if the key is rotated |
| Native build toolchain | P05+ if a native binary is needed | no MSVC Build Tools; Electron and esbuild prebuilts supply everything used so far | a verified prebuilt for the specific native module, or installing VS Build Tools |
| Code-signing certificate | P21/P23 release packaging | not present, not requested | Victor's explicit decision at release time; unsigned test packages are labeled until then |
| Windows 11 modern context-menu qualification | P21 | untested | a clean per-user install and Explorer test on this machine |
| Human click on the classic menu | P21/P22 acceptance | registered live at P09 and exercised through the exact registered argv, not by a hand click | a right-click on a folder and on a folder background, choosing **Start new DS project with Mona** (possibly under **Show more options**) |

## Resolved

### ISSUE-0018 — Windows terminal, resolved 2026-11-12 by authorizing a native PTY

- **Original problem:** the pinned engine reports `terminal_stream/input/resize/
  kill` as false and `/v1/terminal/{name}/output` returns HTTP 501 (“terminal
  sessions are Unix-only in this build”). MONA-023/terminal could not be met by
  the engine on Windows.
- **Victor's decision:** authorize a native Windows PTY path rather than accept
  terminal as unavailable for 1.0.
- **Resolution:** Mona now owns a ConPTY terminal (`node-pty@1.1.0` shipped N-API
  prebuild + xterm.js) in a bottom drawer. The package install script is denied;
  no compiler was installed. Verified with 18 live checks in real Electron:
  typing, output, resize, search, clipboard write read back from the OS, drawer
  reconnect, and exit.
- **Still true:** the engine's own terminal route remains unavailable and is
  reported as `unavailable-on-platform` (CAP-0053). No engine claim was
  upgraded.
- **Proof:** `docs/evidence/P18-terminal.md`, `docs/evidence/P18-terminal.json`.
- **Follow-ups:** ISSUE-0019 (screen-reader pass), ISSUE-0020 (node-pty console
  helper logs on forced kill), ISSUE-0021 (pointer drag selection needs a human
  check), and node-pty unpacking in the P21 installer.

### P02-ELECTRON-BINARY — resolved 2026-11-12 by transient-DNS recovery

- **Original problem:** `electron@45.3.0` postinstall could not download
  `electron-v45.3.0-win32-x64.zip`; `github.com`,
  `objects.githubusercontent.com`, and three mirrors returned `ENOTFOUND` while
  `registry.npmjs.org` resolved.
- **What it actually was:** a transient failure of the local resolver at
  `192.168.1.1`, not a policy block. Re-checked with `Resolve-DnsName`: all four
  names resolved normally, `Invoke-WebRequest` reached `github.com`,
  `api.github.com`, and the release asset (`SHASUMS256.txt`, HTTP 200).
- **Resolution:** `node node_modules/electron/install.js` installed Electron
  45.3.0. No firewall, proxy, hosts-file, DNS, or registry setting was changed;
  the only new artifact is `node_modules/electron/dist`.
- **Counter:** the three no-progress attempts stay in `attempts.jsonl` with a
  closing row that records the prerequisite as obtained. The counter is closed
  by evidence, not reset.
- **Proof:** `docs/evidence/P02-smoke.json` / `P02-smoke-log.txt`.
- **If it recurs:** re-run resolution for `github.com` and
  `objects.githubusercontent.com`; if they still fail, use one of the three
  remedies retained in `docs/evidence/P02-electron-blocker.txt`.

