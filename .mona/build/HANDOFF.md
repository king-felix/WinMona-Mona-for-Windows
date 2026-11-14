# Mona build handoff

**Two ledgers, both validated.**

- Original P00–P23 sequence: complete, `.mona/build/state.json` at revision 83 (`cli.mjs validate` OK).
- Windows supplement W00–W25: `.mona/build/reviews/windows-v2/state.json` (written by
  `tools/build/windows-review.mjs`, D-0120). Statuses: **13 completed, 2 verifying (W12, W22),
  11 pending**.

This session completed **W12, W13, W19, W20, W21, W22 (verifying), W23, W25**. The recommended next
work is W14 (numbered Markdown importer) or W24 (packaged qualification); the human-gated items below
come first because W22 and W24 cannot be called complete without them.

Verify before trusting this file:

```text
node tools/build/cli.mjs validate            # OK, 0 warnings
node tools/build/windows-review.mjs validate # OK, 0 errors
npm run ci                                   # 720 vitest in 77 files + node suites + build
npm run native:test                          # 8 pass, 1 skip (per-user COM limit, proven)
npm run check:build -w @mona/desktop          # 90 preload channels, no engine route in the bundle
```

## What this session delivered

- **W12 — icon identity.** The committed `mona.ico` was invalid (big-endian container: Windows saw
  type 256 with 1792 entries, Electron decoded an *empty image*). Fixed; the ICO is now little-endian
  and tested the way Windows reads it. New `tools/assets/embed-exe-icon.mjs` rewrites `RT_ICON` /
  `RT_GROUP_ICON` in the staged `Mona.exe`, and the installer fails rather than ship Electron's
  artwork. Verified on installed bytes with Windows `ExtractIconEx` (16/32 px pixel-identical).
  `docs/evidence/W12-identity.md`, `W12-icons.json`.
- **W13 — Prompt Runner contract.** Migration 10 (`prompt_runs`, `prompt_run_tasks`,
  `prompt_dispatches`, `runner_reports` + transitions) over the existing task engine. Send ≠ accepted
  ≠ turn completed ≠ task completed; one unsettled dispatch per workspace; bounded continuations;
  strict report schema; path containment including junctions. 15 tests; v9 → v10 with a verified
  backup. `docs/evidence/W13-runner-contract.md`.
- **W19 — performance.** Installed-candidate measurement: idle 353.8 → 352.5 MiB (unchanged within
  noise), CPU 0.02–0.06 %, cold 529 ms / warm 1,679 ms, 20,000 rows interactive at 60 fps. No leak
  across view/project churn. **350 MiB target still missed** (400.6 MiB with a live session).
  `docs/evidence/W19-performance.md`.
- **W20 — accessibility.** Windows UI Automation saw **nine stub elements**; Chromium had never built
  the tree. `app.setAccessibilitySupportEnabled(true)` now exposes 74 named elements (verified by
  `tools/spike/uia-tree.ps1`). Cost: +5.5 MiB idle. 12/12 automated keyboard checks on the installed
  build. Narrator and physical scaling remain human checks. `docs/evidence/W20-accessibility.md`.
- **W21 — reconciliation.** Full CI green on the settled candidate; three stale W12 evidence hashes
  re-recorded at their new bytes with corrected notes; both ledgers at zero warnings.
  `docs/evidence/W21-regression.md`.
- **W22 — Explorer and trust (verifying).** The shell's own verb table offers the command and invoking
  it starts Mona with the folder as one quoted argument. Classic keys register/unregister with scoped
  removal. Trust chain recorded (self-signed, `TrustedPeople` only). `0x800B0109` reproduced and
  explained. `native:test` was red at HEAD; fixed via a control-CLSID experiment, not a deleted
  assertion. `docs/evidence/W22-menu-trust.md`.
- **W23 — recipient file.** `Mona-Setup-0.1.0-x64.exe` (179 MB, unsigned): native stub + appended ZIP
  + validated trailer, unpacks with Windows `tar.exe`, installs through the shipped `Mona.exe` in
  Electron's Node mode. 1,745 files verified; Start shortcut, classic menu, registry, uninstall entry.
  Fresh install, upgrade, uninstall-from-installed-copy and reinstall all exercised. Three real
  defects fixed on the way. `docs/evidence/W23-installer.md`.
- **W25 — this handoff.** `docs/evidence/W25-handoff.md` holds the ordered review inbox and the full
  reconciliation.

## Needs the Human — in priority order

1. **Trust decision for the test certificate** (blocks the modern Explorer menu, MONA-027):
   elevated `node tools/install/cli.mjs trust-test-certificate`, then run the setup file again.
2. **Look at the Windows 11 menu once.** Right-click a folder; the item must appear in the modern menu,
   not only under "Show more options". Automated capture of the shell menu surface is not possible on
   this desktop.
3. **Narrator / 200 % / text size / contrast themes / physical IME** — checklist with expected results
   in `docs/evidence/W20-accessibility.md`.
4. **Idle-memory exception** (352.5 MiB vs 350 MiB target) — D-0111 covers 0.1.0 only.
5. **Signing + licensing** for any distribution beyond this machine.
6. **A real pending approval** (posture `ask`) to close the W06/W08 open item.

## Still open from the original sequence

1. Project import has no product surface (`importProject` is correct and tested; nothing calls it).
2. A physical IME composition is a human check.
3. The modern Explorer menu has never been seen by a person (MONA-027 / W22).
4. `node-pty`'s `AttachConsole failed` trace on forced teardown is ISSUE-0020, unchanged.

## Standing authorization

D-0118: commit verified work and push to `origin main` as the closing step of a turn that changed
files. The remote is public, so the push is gated on `node tools/build/cli.mjs validate` (secret scan
included) and on a green `npm run ci`.

## Last pushed commit

Recorded in the end-of-turn report. Verify with `git ls-remote origin refs/heads/main` against local
`HEAD`; do not trust a remembered SHA.
