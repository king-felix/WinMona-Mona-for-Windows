# Mona build handoff

**Current prompt:** P10 — Implement prompt execution and durable continuation
**Current status:** P00–P09 completed. State revision 32 (two later P09 checkpoints
refreshed evidence hashes after wording and line-ending normalization; no work
changed). Next eligible: P10, P12, P13.

**Last verified commit / dirty work:** P08 ended at `380d7bb`; the P09 commit is
created after this file and the evidence are written. `last_verified_commit`
stays null because a state file cannot contain the hash of the commit that
contains it. Verify with `node tools/build/cli.mjs validate` (expect OK, r32, 0
warnings) before trusting this file.

## P09 result — the first right-click launch works

A real Explorer selection now reaches the ready studio. The classic per-user
folder and folder-background menu are registered on this machine under the exact
label **Start new DS project with Mona** (Windows 11 may show it under **Show more
options**; the modern menu is P21).

- **Launcher contract** (`packages/adapter/src/cli.ts`):
  `project open --path <folder> --profile ds-full-access`; `--path=value`, a
  bare-path fallback, and strict refusal of unknown actions/options, missing
  values/paths and foreign profiles. `stripLauncherArgs` removes the executable
  and Electron's app path in development; `coerceLaunchCommand` validates a
  command that crossed a process boundary.
- **Live finding — Windows argv is not forwarded intact.** A real second
  instance exits, but `second-instance` gives the owner a Chromium
  re-serialization where `--path` is separated from its value
  (`[exe, "--path", "--profile", ..., appPath, "project", "open", folder]`).
  Fix: each instance parses its own argv before taking the lock and sends
  `{ monaLaunch }` through `requestSingleInstanceLock(additionalData)`; the owner
  validates it and falls back to argv. Decision D-0051. The failed attempt is in
  `P09-launch-log.txt` history; the successful run logs `bridged=true` five times.
- **Dispatch** (`launch-dispatch.ts`, `launch-target.ts`): one FIFO queue;
  identical pending launches coalesce; each path yields one receipt. Opens or
  reuses the project once, selects the saved DS Full Access profile, records the
  Studio view, starts the owned runtime unless it already serves that workspace,
  and never submits a task. Missing/file/inaccessible/unreachable paths are
  distinct rejections; drive, share and WSL roots open the folder picker; UNC/WSL
  subfolders open with an unqualified-runtime caveat. A runtime serving another
  workspace is reported, never stopped.
- **Renderer**: reads the latest receipt on load and subscribes to new ones;
  refreshes the catalog, selects the project, forces Studio and focuses `#draft`.
  Stale sequence numbers are ignored. 27 named preload methods
  (`getLaunchState`, `onLaunchEvent` added).
- **Registration** (`tools/launch/context-menu.mjs`): keys
  `HKCU\Software\Classes\Directory\shell\Mona.StartNewProject` and
  `...\Directory\Background\shell\Mona.StartNewProject`, exact label, Icon,
  `MonaOwned=1`, `NeverDefault`, `MultiSelectModel=Single`, and
  `"<exe>" "<app>" project open --path "%V" --profile ds-full-access`. Every write
  is an argument array through `reg.exe`; nothing is interpolated into a shell
  command. Register twice → `changed=false`; uninstall removes only the two Mona
  keys (a foreign sibling survived the live check). The final registration is
  left in place and currently names the development Electron binary and this
  checkout; `npm run launch:menu -- unregister` removes it.
- **No model work from the shell**: zero threads, zero timeline items and zero
  spend after every launch in the live run.

Evidence: `docs/evidence/P09-launch.md` (report), `P09-launch.json` +
`P09-launch-log.txt` (20 live in-app steps, 6 ordered receipts, 3 screenshots),
`P09-launch-registration.json` (14 registration checks), `shots-p09/` (3 live
screenshots plus each child instance's recorded argv), `P09-tests.txt`,
`P09-checks.txt`, `P09-build.txt`, `P09-shell-smoke.json`,
`P09-catalog-regression.json` + log + `shots-p09-catalog/` (P07 regression,
21/21). Decisions D-0050 … D-0054.

Live receipt: startup argv opened the folder
`…\mona p09 alpha & (beta) 'quoted' — ünïcode`, runtime ready, composer focused,
notice "Opened from Explorer"; a real second instance opened
`mona p09 second` and the window switched with an honest "runtime is serving
another workspace" caveat; a trailing-separator/case-changed relaunch reused the
same project id with no new entry; two fast launches produced receipts seq 4–5
with the newest on screen; a missing folder was rejected and left the screen
unchanged.

## Next exact action (P10)

Read P10 in `Mona_PROMPTS.md` and spec section 8. Implement task/prompt creation,
dependencies, single-owner scheduling, the task state machine, evidence-backed
completion, resume reconciliation and short handoff generation. Keep the Mona
build ledger separate from user project state. No launch work remains open; the
modern menu and packaged registration are P21.

## Relevant files and spec sections

- `packages/adapter/src/{cli,lifecycle}.ts`,
  `apps/desktop/src/{shared/launch.ts,preload/preload.ts}`,
  `apps/desktop/src/main/{launch-target,launch-dispatch,launch-ipc,launch-probe,
  main}.ts`, `apps/desktop/src/renderer/{App,StudioPanel}.tsx`,
  `tools/launch/context-menu.mjs`, `apps/desktop/scripts/launch.mjs`
- Spec 5.1 (J1), 6.4 (process lifecycle), 14 (Explorer integration), 9.1, 13.

## Open problem IDs and no-progress counts

No open blocker; `attempts.jsonl` holds only the closed P02 rows.

- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift; P16.
- **P01-ISSUE-002** — one owned runtime per machine session; a launch for a
  different workspace opens the project with a caveat instead of stopping the
  runtime (live-verified again by P09).
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.
- **P04-ISSUE-001** — no Job Object; `taskkill /T` plus reconcile.
- **P04-ISSUE-002** — close-to-tray still has no tray affordance; P23 packaging.
- **P05-ISSUE-001** — maintenance barrier is in-process (D-0032).
- **P06-ISSUE-002** — no human screen-reader pass yet; P22 owns it.
- **P07-ISSUE-001** — probe scripts still default to fixed historical paths when
  prompt-scoped `MONA_*` output variables are absent (P09 used scoped variables).
- **P07-ISSUE-002** — closed by P08.
- **P08-ISSUE-001** — `packages/contracts` models four engine event names; the
  studio projects the rest by name in the desktop service; revisit at P16/P18.
- **P08-ISSUE-002** — approval waits are surfaced and interruptible; Mona still
  has no qualified approval-response route.
- **P08-ISSUE-003** — the engine writes its own `.codewhale/state/*` into a
  workspace during a turn; evidence for P22 documentation.
- **P09-ISSUE-001** — the classic registration names the development Electron
  binary and repository path until P21/P23 install a packaged executable.
- **P09-ISSUE-002** — Explorer's own placement ("Show more options") and a human
  click are not programmatically verifiable; the probe runs the exact registered
  argv through real Electron instances. Manual acceptance remains for P21/P22.

## Blocked dependencies

None.

## Last relevant validation

- `npx vitest run` → 258 passed (28 files; +43 in P09).
- `npm run bootstrap:test` → 13; `npm run launch:test` → 12; `npm run spike:test` → 8.
- `npm run lint`, `npm run format:check`, `npm run typecheck` → pass.
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  290.35 kB (gzip 87.39 kB).
- `npm run check:build -w @mona/desktop` → pass, 27 named preload channels.
- `npm run launch` → 14/14 registration checks + 20/20 live launch steps, 3 live
  screenshots; exact read-back of both keys; uninstall isolation verified.
- `npm run catalog -w @mona/desktop` (`P09-catalog-regression.json`) → 21/21.
- `npm run smoke -w @mona/desktop` (`P09-shell-smoke.json`) → pass, 27 named
  bridge methods, 332 MB.
- `node tools/build/cli.mjs validate` → OK, r29, 0 warnings before the final
  checkpoint (r32); re-run after reading this file.
- Spend: zero. Every P09 check ran without a provider request; launches start the
  local runtime only.

## Human input needed

None to continue. One standing human acceptance item for P21/P22: right-click a
folder and a folder background in Explorer and choose **Start new DS project with
Mona** (possibly under **Show more options**). The registration currently points
at the development build; remove it with `npm run launch:menu -- unregister` or
replace it at install time.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and
`catalog-probe.ts` in P07; `check-build.mjs` fails on mojibake. The two remaining
`Â·`/`â€™` sequences in `DECISIONS.md` and older handoff text are quoted examples
of that incident, not corrupted text.
