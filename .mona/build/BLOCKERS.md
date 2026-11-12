# Mona build blockers

No blocker is open. This file records blockers that stop a problem after three
consecutive no-progress attempts, plus the human input required to clear them.
Acknowledging a blocker never resets its counter or clears the row.

## Open

### P02-ELECTRON-BINARY — no reachable Electron runtime artifact

- **Problem:** `electron@45.3.0`'s postinstall cannot download
  `electron-v45.3.0-win32-x64.zip`. Only `registry.npmjs.org` resolves from this
  machine; `github.com`, `objects.githubusercontent.com`, and every tested
  mirror return `ENOTFOUND`. The npm tarball itself contains no runtime.
- **Impact:** the built desktop app cannot be launched, so the Electron window
  smoke test (real rendered version, navigation, process footprint, runtime
  navigation refusal) is unverified. Build, typecheck, 38 unit/DOM tests, and
  static bundle checks pass.
- **Attempts:** 3 consecutive without material progress
  (`P02-ELECTRON-BINARY` in `attempts.jsonl`). Counter persists.
- **Exact human help (any one):**
  1. Allow outbound HTTPS/DNS to `github.com` and
     `objects.githubusercontent.com`, then run
     `node node_modules/electron/install.js` and `npm run smoke -w @mona/desktop`.
  2. Provide a reachable `ELECTRON_MIRROR` serving
     `electron-v45.3.0-win32-x64.zip`, then run the same installer.
  3. Place the zip in `%LOCALAPPDATA%\electron\Cache\<sha256>\` (Electron's
     cache layout) and run the installer.
- **Do not:** switch desktop shells, substitute a browser screenshot for the
  Electron window, or mark the runtime check passed. Those would abandon the
  promised architecture or fake evidence.

## Prerequisites that are not blockers yet

| Item | Needed by | State | What clears it |
|---|---|---|---|
| Verifiable DeepSeek route | P01 (G0/G1) | **verified** at P01: `doctor --probe-api` passed; model resolved to `deepseek-flash`; live turns priced | nothing; re-probe only if the key is rotated |
| Native build toolchain | P02/P05 if prebuilt native binaries are unavailable | no MSVC Build Tools detected; Electron prebuilt availability not yet tested | verified prebuilt Electron/native modules, or installing VS Build Tools with the authorization already given |
| Code-signing certificate | P21/P23 release packaging | not present, not requested | Victor's explicit decision at release time; unsigned test packages are labeled until then |
| Windows 11 modern context-menu qualification | P21 | untested | a clean per-user install and Explorer test on this machine |

## Resolved

_None yet._
