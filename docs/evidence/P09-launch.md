# P09 — Make the first right-click launch work

**Status:** completed for the classic-menu milestone; the modern Windows 11 menu
and packaged executable remain P21.

Mona now accepts the launcher command from spec 14, registers the per-user
classic folder and folder-background menu under the exact label **Start new DS
project with Mona**, and turns a real selection into a ready studio: the project
is opened or reused once, the saved DS Full Access profile is kept, the owned
runtime starts, and the composer takes focus with no task sent.

## What was delivered

- **Launcher contract** (`packages/adapter/src/cli.ts`):
  `project open --path <folder> --profile ds-full-access`, plus the
  `--path=value` form and a bare-path fallback used by existing probes. Unknown
  actions/options, missing values, a missing path and a profile Mona does not own
  are rejected with a specific reason. Paths keep their spelling; duplicates
  collapse case-insensitively on Windows; switch-like arguments are ignored.
- **argv normalization**: `stripLauncherArgs` removes the executable and, in an
  unpackaged run, Electron's app path. The same function handles the initial
  argv and `second-instance` argv.
- **Path inspection** (`launch-target.ts`): empty/oversized/control-character
  paths are refused; drive roots, share roots and WSL distribution roots route to
  explicit folder selection; missing paths, files, permission denials and silent
  network locations get distinct, honest messages. UNC/WSL subfolders open with a
  recorded caveat that the pinned runtime is not qualified there. Network stats
  are bounded (2.5 s local, 5 s network).
- **Serialized dispatch** (`launch-dispatch.ts`): one FIFO queue; identical
  pending launches coalesce; each path produces one receipt. A launch opens or
  reuses the project (`created` / `existing` / `alias` all use the same store
  identity rules), selects it, records the studio view, and starts the owned
  runtime unless it already serves that workspace. It never calls the studio
  submission path. A runtime serving another workspace is reported, never
  stopped or replaced.
- **Single-instance data bridge**: the second instance parses its own argv and
  sends `{ monaLaunch }` through `app.requestSingleInstanceLock(additionalData)`.
  The owner validates it with `coerceLaunchCommand` and falls back to argv.
  This was required by live evidence — see the finding below.
- **Renderer**: the launch receipt is read once at load and pushed thereafter.
  The shell refreshes the catalog, activates the project, selects the Studio,
  focuses `#draft`, and shows the receipt's own explanation and caveats. Stale
  sequence numbers are ignored.
- **Classic registration** (`tools/launch/context-menu.mjs`): per-user keys
  `HKCU\Software\Classes\Directory\shell\Mona.StartNewProject` and
  `...\Directory\Background\shell\Mona.StartNewProject`, with the exact label,
  an `Icon`, `MonaOwned=1`, `NeverDefault`, `MultiSelectModel=Single`, and a
  command that quotes the executable, the app directory and `"%V"`. Registration
  overwrites in place; unregistration deletes only those two keys. Every write is
  an argument array through `reg.exe`; no path is ever interpolated into a shell
  command.
- **No model work in the shell's process**: the registered command starts Mona
  only. Nothing is submitted until the user presses Submit. The live run recorded
  zero threads, zero timeline items and zero spend.

## Live finding — Windows does not forward argv intact

The first live probe failed exactly where a mock would have passed. A second
Electron instance exited correctly, but the owner never received the selection.
Instrumenting both sides showed the child's own argv was intact, while
`second-instance` delivered a Chromium re-serialization:

```text
[electron.exe, "--path", "--profile", "--allow-file-access-from-files",
 appPath, "project", "open", "<folder>"]
```

The `--path` value was detached from its switch. Parsing that argv cannot recover
the selection reliably, so the second instance now sends the parsed command as
structured data through the lock. The fallback parser stays for launches that do
not pass data. Evidence: the first live run exposed the gap; the successful run
logs `second-instance bridged=true` for all five real second instances.
Decision D-0051.

## Path and launch matrix

| Case | Result | Evidence |
|---|---|---|
| Spaces, apostrophes, `&`, parentheses, Unicode | opened from a real launch; one argv element | `P09-launch.json` seq 1, screenshot 01 |
| Trailing separator + different case | same project reused, no new entry | `P09-launch.json` seq 3; probe step |
| Duplicate launch | coalesced while pending; no duplicate project | `launch-dispatch.test.ts` |
| Missing folder | rejected with "was not found"; current project unchanged | probe seq 6 |
| File selected | rejected as "is a file" | `launch-target.test.ts` |
| Inaccessible folder | "cannot be read with this Windows account" | `launch-target.test.ts` |
| Drive root `C:\` | folder selection requested; nothing indexed | `launch-dispatch.test.ts` |
| UNC/WSL folder | opens with an unqualified-runtime caveat | `launch-target.test.ts` |
| Share/WSL root | folder selection requested | `launch-target.test.ts` |
| Real junction | accepted; store identity de-duplicates | `launch-target.test.ts` |
| Moved folder | `relocation-required`, no second project | `launch-dispatch.test.ts` |
| Two fast launches | two ordered receipts; newest ready project on screen | probe seq 4–5, screenshot 03 |
| Runtime serving another project | project opens with a caveat; runtime untouched | probe seq 2, screenshot 02 |

Broad-root selection is unit-tested, not live: showing and cancelling the folder
dialog cannot be driven headlessly and was not faked into the probe.

## Registration and uninstall

- First register: verified; second register: verified and `changed=false`.
- Read-back through `reg export` matched every value Mona owns on both keys.
- Folder and folder-background resolve to the same quoted `%V` command.
- Uninstall removed exactly the two Mona keys while a foreign sibling key
  (`MonaP09ForeignProbe`) survived; the probe removed its own foreign key after
  the check.
- The milestone leaves a verified registration in place, currently pointing at
  the development Electron binary and this checkout:

```text
"X:\AI_projects\Mona\node_modules\electron\dist\electron.exe"
"X:\AI_projects\Mona\apps\desktop" project open --path "%V" --profile ds-full-access
```

Windows 11 may place this entry under **Show more options**. The modern
`IExplorerCommand` menu is P21 and is not claimed by this prompt.

## Validation

- `npm test` → 258 vitest (28 files), 13 bootstrap, **12 launch**, 8 spike; 0
  failures (`P09-tests.txt`).
- `npm run lint`, `npm run format:check`, `npm run typecheck` → pass
  (`P09-checks.txt`).
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  290.35 kB (gzip 87.39 kB) (`P09-build.txt`).
- `npm run check:build -w @mona/desktop` → pass, 27 named preload channels.
- `npm run launch` → 14/14 script checks and 20/20 in-app launch steps; 3 live
  screenshots (`P09-launch.json`, `P09-launch-registration.json`,
  `P09-launch-log.txt`, `shots-p09/`).
- P07 shell/catalog regression: 21/21, 6 live screenshots
  (`P09-catalog-regression.json`, `P09-catalog-regression-log.txt`).
- Shell smoke: 27 named bridge methods, 332 MB (`P09-shell-smoke.json`).
- `node tools/build/cli.mjs validate` → OK, r29, 0 warnings at the time of the
  checks; the final checkpoint raises the revision.

Spend: zero provider requests. The launches started the local runtime only; no
thread, turn, submission or usage record was created.

## Limits and open issues

- **P09-ISSUE-001** — the registration points at the development Electron binary
  and repository path until P21/P23 install a packaged executable. Re-registering
  after an install is P21's job.
- **P09-ISSUE-002** — the classic menu's placement (`Show more options`) and a
  real human Explorer click are not programmatically verifiable here. The probe
  executes the exact registered argv through real Electron instances; a manual
  click remains a human acceptance step at P21/P22.
- The UNC/WSL caveat records that the pinned runtime is unqualified on those
  workspaces; it does not claim support.
- No approval/denial UI was added for launch; broad-root selection uses the
  existing folder dialog.

## Files changed

```text
packages/adapter/src/cli.ts                     new contract parser + boundary validation
packages/adapter/src/cli.test.ts                17 parser/normalization tests
packages/adapter/src/lifecycle.ts               parseLaunchArgs delegates to the parser
packages/adapter/src/index.ts                   exports the launcher surface
packages/adapter/src/work-control.test.ts       path spelling expectation updated
apps/desktop/src/main/launch-target.ts          path shape + bounded reachability
apps/desktop/src/main/launch-target.test.ts     10 tests
apps/desktop/src/main/launch-dispatch.ts        serialized receipts
apps/desktop/src/main/launch-dispatch.test.ts   11 tests
apps/desktop/src/main/launch-ipc.ts             launch-state channel
apps/desktop/src/main/launch-ipc.test.ts        3 tests
apps/desktop/src/main/launch-probe.ts           native second-instance probe
apps/desktop/src/main/main.ts                   startup/second-instance wiring
apps/desktop/src/shared/launch.ts               receipt types and channels
apps/desktop/src/preload/preload.ts             getLaunchState + onLaunchEvent
apps/desktop/src/renderer/App.tsx               apply receipt, focus, notice
apps/desktop/src/renderer/StudioPanel.tsx       focusToken composer focus
apps/desktop/src/renderer/App.test.tsx          snapshot + push launch tests
apps/desktop/scripts/launch.mjs                 registration + native evidence run
apps/desktop/scripts/{check-build,smoke}.mjs    channel/key expectations
tools/launch/context-menu.mjs                   register/unregister/verify helper
tests/launch/context-menu.test.mjs              12 registration tests
package.json / apps/desktop/package.json        launch scripts
```
