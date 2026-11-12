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

## Resolved

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

