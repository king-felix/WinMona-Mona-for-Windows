# Mona build blockers

No blocker is open. This file records blockers that stop a problem after three
consecutive no-progress attempts, plus the human input required to clear them.
Acknowledging a blocker never resets its counter or clears the row.

## Open

_None._

## Prerequisites that are not blockers yet

| Item | Needed by | State | What clears it |
|---|---|---|---|
| Verifiable DeepSeek route | P01 (G0/G1) | credential stored but `source=secret_store_unprobed`; doctor reports "no verified key" | bounded `codewhale doctor --probe-api` (or one sentinel `exec` turn) inside the P01 pilot ceiling; if the key is actually invalid, Victor re-saves it with `codewhale auth set --provider deepseek` |
| Native build toolchain | P02/P05 if prebuilt native binaries are unavailable | no MSVC Build Tools detected | verified prebuilt Electron/native modules, or installing VS Build Tools with the authorization already given |
| Code-signing certificate | P21/P23 release packaging | not present, not requested | Victor's explicit decision at release time; unsigned test packages are labeled until then |
| Windows 11 modern context-menu qualification | P21 | untested | a clean per-user install and Explorer test on this machine |

## Resolved

_None yet._
