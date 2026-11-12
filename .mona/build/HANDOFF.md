# Mona build handoff

**Current prompt:** P22 — Run whole-product QA and prove the remaining claims
**Current status:** P00–P21 completed. State revision will advance at the P21
checkpoint; ledger revision 309. MONA-027 is **blocked** on one named prerequisite
(modern-menu package trust), so a 1.0-complete claim is not available.

`last_verified_commit` stays null because a state file cannot contain the hash of
the commit that contains it. Verify with `node tools/build/cli.mjs validate`
(expect OK, 0 warnings) before trusting this file.

## P21 result — modern Windows menu and installation lifecycle

- **Native helper** `native/windows-shell/`: a 239 KB x64 COM DLL implementing only
  `IExplorerCommand`, built with pinned Zig 0.17.1 (`zig cc -target
  x86_64-windows-gnu`) after `node tools/install/fetch-tools.mjs` verifies both
  toolchain downloads by SHA-256. 7/7 native checks pass, including real
  `CoCreateInstance` activation, hidden state for files and multi-selection, and a
  byte-exact argv check on a folder named `a & b (café) — 'quoted' 中文`.
- **Sparse identity package**: `AppxManifest.xml` with `windows.comServer` +
  `windows.fileExplorerContextMenus` verbs for `Directory` and
  `Directory\Background`, `uap10:AllowExternalContent`, `runFullTrust`. Packed with
  pinned MakeAppx and test-signed with a labelled self-created certificate.
  `Mona-0.1.0-x64.msix` sha256 `3a397745…`, package signed but **untrusted root**.
- **Per-user installer** `tools/install/`: `stage`, `package`, `install`, `upgrade`,
  `uninstall`, `status`, `verify`. 1,656 checksummed files; atomic tree replacement;
  only Mona keys written; classic menu re-registered against the installed exe;
  uninstaller runs from the installed copy, removes its own directory after exit,
  and leaves `%APPDATA%\@mona\desktop` and `~/.codewhale` byte-identical.
- **Upgrade gate**: `apps/desktop/src/main/install-gate.ts` publishes
  `runtime/activity.json`; an active run defers the upgrade with exit 3, an idle
  running app needs `--close-running`, `--force` is explicit.
- **Packaged-argv bug fixed**: Electron reports
  `[Mona.exe, <install>\resources\app, project, open, …]`; `stripLauncherArgs` now
  removes the app directory in both packaged and unpackaged modes. This was found by
  the installed launch probe, which then passed 20/20 in-app steps.
- **Requirement effect**: MONA-004 is **verified**. MONA-027 is **blocked** —
  installer, uninstall and signing criteria pass; the modern-menu criterion cannot
  be shown working until Windows will register the package.

## The one blocking prerequisite (Victor's decision)

Windows refuses the identity package in every non-elevated path on this machine:

- unsigned `Add-AppxPackage -Register` → `0x80073CFF` (developer licence/sideloading);
- test-signed `Add-AppxPackage -Path` → `0x800B0109` (untrusted root);
- `Import-Certificate` into `CurrentUser\Root` → "UI is not allowed in this
  operation"; `certutil -addstore -user Root` waits for a consent dialog;
- developer mode is an `HKLM` policy and this account is not an administrator.

Victor picks one: **(A)** enable developer mode, **(B)** accept the labelled test
certificate into the current-user Root store once (then `node tools/install/cli.mjs
trust-test-certificate` in an interactive terminal and re-run `install`), or
**(C)** supply a production certificate for `MONA_SIGN_PFX`. Details and exact
observed errors: `docs/evidence/P21-windows.md`, `.mona/build/BLOCKERS.md`.

## Next exact action (P22)

P22 is whole-product QA, not more implementation. Start from the existing probes
rather than inventing new ones:

1. `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
   `npm run build`, `node tools/build/cli.mjs validate` — establish the gate baseline.
2. Re-run the live probes with fresh output paths under `docs/evidence/P22-*`:
   `apps/desktop/scripts/{smoke,polish,shots,studio,catalog,terminal}.mjs` and
   `apps/desktop/scripts/launch.mjs` with `MONA_LAUNCH_EXE` set to the installed
   `Mona.exe`.
3. Measure cold/warm startup, typing/scrolling on a 10,000-event fixture, idle CPU
   over 60 s, and total Mona memory with the engine reported separately. Record the
   hardware and method; do not move the budget to match the number.
4. Re-run the zero-inference checks; state cost confidence without spending.
5. Audit all 30 requirement rows and the capability ledger; write
   `docs/evidence/P22-product-QA.md` with the remaining human checklist.

## Relevant files and spec sections

- `native/windows-shell/`, `tools/install/`, `tests/install/`, `tests/native/`
- `apps/desktop/src/main/install-gate.ts`, `apps/desktop/scripts/launch.mjs`
- `packages/adapter/src/cli.ts` (`stripLauncherArgs`)
- `docs/evidence/P21-windows.md` and `P21-*.json`, `docs/evidence/shots-p21/`
- Spec 14, 15, 16, 17; prompt P22.

## Open problem IDs and no-progress counts

No open three-attempt blocker. `attempts.jsonl` holds only the closed P02 rows.

New in P21: **P21-ISSUE-001** (modern menu not seen in Explorer — trust gate),
**P21-ISSUE-002** (no Windows VM), **P21-ISSUE-003** (package registration
blocked), **P21-ISSUE-004** (packaged app keeps the `@mona/desktop` identity),
**P21-ISSUE-005** (452 MB staged payload due to full Electron locales),
**P21-ISSUE-006** (uninstall directory removal is deferred by a few seconds).

Carried: P20-ISSUE-001..003, P19-ISSUE-001..004, P18-ISSUE-002/003,
P17-ISSUE-001..005, P16-ISSUE-001..004, P15-ISSUE-001..003, P14-ISSUE-001..004,
P13-ISSUE-001..003, P12-ISSUE-001..003, P11-ISSUE-001, P10-ISSUE-001..003,
P09-ISSUE-001..002, P08-ISSUE-001..003, P07-ISSUE-001, P06-ISSUE-002,
P05-ISSUE-001, P01-ISSUE-001..004, terminal ISSUE-0019..0022.

## Last relevant validation

- `npm test` → 513 Vitest (61 files) + 13 bootstrap + 12 launch + 14 install + 8 spike.
- `npm run native:test` → 7/7 pass (compiled helper; `npm run tools:fetch` +
  `npm run native:build` first).
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` → pass.
- `node tools/build/cli.mjs validate` → OK, 0 warnings.
- Spend: zero for P21. P15's delegated run remains the last paid run
  (5,731.872 µUSD).

## Human input needed

- The modern-menu choice A/B/C above, then a right-click check in Explorer.
- A by-hand classic-menu right-click (registered and verified only by argv).
- P19-ISSUE-001 Memory click-through, ISSUE-0019 screen reader, ISSUE-0021 pointer
  drag selection.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and one test string
in P14; Prettier does not repair that. `check-build.mjs` fails on mojibake in the
renderer bundle. The `Â·`/`â€™` sequences in `DECISIONS.md` and older handoff text
are quoted examples of that incident, not corrupted text.
