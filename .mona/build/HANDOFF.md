# Mona build handoff

**Current prompt:** P23 in `.mona/build/state.json` (revision 83). **But the tree is past it:**
commits P24 (collapsible Inspector, Ctrl +/-/0 scaling) and P25 (Cost lens and Work board) are
recorded inside P23's task row, and `state.json` was never checkpointed forward. `validate`
passes because it checks schema, hashes, graph and evidence — not whether the ledger matches git
history. The next session must reconcile the ledger to P25 with a `checkpoint` at the correct
`--expected-revision` before treating P23 as the resume point.

**New pending queue (2026-11-14):** the Windows improvement supplement is registered in
`docs/requirements-windows.json` — **26 prompts W00–W25, 18 requirements WX-01–WX-18, all
pending**, with `W00` the only eligible one. It is a separate, validated id space (D-0116); it
does not reopen or extend the P00–P23 sequence. The supplement documents were written against a
P23-era report, so W00's first job is to reconcile them with the P24/P25 work already committed.

**Brand artwork (2026-11-14):** `assets/brand/MidnightMona.png` is the approved icon source and
now drives the window icon, tray, in-app header and the three declared package images through a
deterministic pipeline (D-0117). Two W12 gaps remain open: 16 px legibility and the Electron icon
still embedded in `Mona.exe`.

**The claim that stands is "Core usable release candidate 0.1.0".** Not 1.0 complete: MONA-027's
`modern-menu` criterion is registered but not seen (a human right-click is owed), MONA-028 is
partial on memory (370.5–377.1 MB vs 350 MB, **accepted for 0.1.0 by D-0111 with the target
unchanged**) and on the human-only checks. Nothing was relabelled and no complete claim was made.

**Local install for Victor:** double-click `install-mona.cmd` in the repository root (or run
`node tools/install/cli.mjs install --smoke`). It installs per user to
`%LOCALAPPDATA%\Programs\Mona`, verifies the installed build and starts Mona. The layout round's
build was installed and verified on 2026-11-12 (1,681 files, `verify --smoke` exit 0) and left
closed for testing; re-running the launcher is idempotent.

Nothing was published: no remote, no package feed, no certificate purchase, no public repo.
Local commits only. The license decision is deliberately unresolved.

Verify before trusting this file: `node tools/build/cli.mjs validate` (expect OK, 0 warnings),
`node tools/build/cli.mjs status` (expect the `windows_supplement` block: 26 pending, W00
eligible) and `node tools/install/cli.mjs verify` (expect `checks.ok: true`).

## Layout round result

- **Inspector collapsed by default.** `.workspace` yields its 300 px column; the panel collapses to
  a 32 px labelled rail with an upright chevron. Measured timeline width **933 px collapsed vs
  665–680 px open**. The choice persists in `localStorage` (`mona.inspector`); Focus Mode unchanged.
- **<kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>−</kbd>/<kbd>0</kbd> scale the window.** A fixed 50–200 %
  ladder applied in the main process (`before-input-event` → `setZoomFactor`), so it works with
  focus anywhere including the terminal. Persisted in `state/appearance.json`; status-bar control
  shows the applied percentage, disables the exhausted rung, and resets on click. Three validated
  IPC channels, sender-checked, in the existing audit.
- **Defect found and fixed by measuring:** at 150 % the work area painted over the status bar.
  `.layout` is now one bounded row; the probe asserts `studio-region.bottom <= statusbar.top`.
- **Verified:** `npm run appearance` **19/19** on development and installed builds
  (`P24-appearance.md`); `npm run a11y` 12/12 after the change; 558 Vitest / 68 files; `ci` exit 0.
- **Artifact:** 1,681 files / 452,756,367 bytes; MSIX sha256 `8c815f83…9abc2`; installed,
  `Status: Ok`, `verify --smoke` exit 0. Spend: **0 µUSD**.

## Surfaces round result

- **The Cost and Work screens had never been wired.** The Cost screen's own sentence ("Budget
  controls and export arrive with P12") was true: the ledger was finished in P12 but the renderer
  had no budget or export channel, and the Work screen printed "No tasks recorded"
  unconditionally. Both are now real surfaces (`CostPanel.tsx`, `WorkPanel.tsx`) over five new
  sender-checked channels.
- **Evidence basis corrected (D-0114).** MONA-009 `prompt-catalog` and MONA-013
  `budgets`/`export` had been marked passed on service-level tests only. They now cite
  `docs/evidence/P25-surfaces.md`; the mistake is recorded, not erased.
- **Verified:** `npm run surfaces` **26/26** on development and installed builds, with four
  screenshots each; the probe seeds real `usage_records` and real tasks and reads the live DOM. A
  header-vs-lens disagreement was caught and fixed. `npm run ci` exit 0 (575 Vitest / 70 files);
  a11y 12/12 on the installed build.
- **Not automated:** the native Save dialog for CSV export (the probe supplies a destination).
  Content, labels and byte counts after the dialog are proven.
- **Artifact:** 1,695 files / 452,888,542 bytes; MSIX sha256 `9f6b1cb3…7ace`; installed and
  `verify --smoke` clean. Spend: **0 µUSD**.

## Elevated round result

- **Machine trust — done, verified, and reversible.** The one command that every earlier round
  was blocked on ran in an elevated shell: `trust-test-certificate` re-checked the certificate,
  the package signer, the manifest Publisher and the build record, then imported thumbprint
  `5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95` into `Cert:\LocalMachine\TrustedPeople` **only**.
  `Root` stayed absent; developer mode stayed off. `untrust-test-certificate` was exercised as a
  round trip: both `TrustedPeople` scopes went absent, `Root` untouched, then the import was
  repeated. (Windows mirrors machine trust into the user's TrustedPeople view, so removal now
  clears both — D-0110.)
- **The identity package registers.** `install --force` completed with
  `MonaWorkbench_0.1.0.0_x64__beqf7zj0yys3p`, `Status: Ok`, `SignatureKind: Developer`, both
  verbs declared for `Directory` and `Directory\Background`. The `0x800B0109` refusal is gone on
  this machine.
- **Packaging guard.** The identity payload now contains the `MonaMenu.dll` its manifest declares
  by path, and `missingComServerPayloads` makes `stage`/`package` fail if manifest and payload
  diverge (D-0109). This is hardening, not a diagnosed fix — see the next point.
- **A probe that proved nothing, recorded so it is not repeated.** Direct `CoCreateInstance` of
  the CLSID returns `REGDB_E_CLASSNOTREG` for Mona **and** for Notepad++'s shipped packaged
  shell command. Plain CLSID activation is not a valid test of packaged shell commands, in either
  direction. No menu claim rests on it.
- **Probes re-run on the rebuilt bytes.** `install verify` ok (1,673 files, 0 checksum
  problems); `npm run a11y` 12/12; `npm run memory` 370.5 MB idle (average 382.5 MB, 20,000
  rows, renderer heap 3.3 MB); `npm run qa` cold 421 ms / warm 722 ms. The 350 MB target is
  still unmet.
- **Artifact:** payload 1,673 files / 452,709,537 bytes; `Mona-0.1.0-x64.msix` (127,926 bytes)
  sha256 `5a7a645582602d80bb389c252b7b465fc4808c722a957fc7367ed8dfc46544ee`, test-signed, now
  reported with a trusted chain **because this machine trusts the test certificate**. Rebuilt and
  reinstalled after the last source edits so the payload matches the commit; `install verify`
  exits 0.

## Next exact action (needs Victor)

1. **Right-click a folder, then a folder background**, and confirm **Start new DS project with
   Mona** appears in the Windows 11 menu (not only under **Show more options**). Record the
   result in `docs/evidence/P23-human-checklist.md`. This is the only thing between MONA-027 and
   a verified `modern-menu` criterion.
2. **Remaining human checks** in the same checklist: Narrator walkthrough, physical 200% scaling,
   conversation export through the real Save dialog.
3. **Memory: decided.** 370.5–377.1 MB is accepted for 0.1.0 (D-0111); the 350 MB target is
   unchanged and unmet, and the next evidence-led step stays unauthorized. Do not reopen it
   without a new measurement on an installed candidate.
4. **Decide the license** before any public distribution.
5. Keep the trust scoped: `node tools/install/cli.mjs untrust-test-certificate` (elevated) removes
   exactly this thumbprint from both `TrustedPeople` stores when it is no longer wanted.
6. Later-scope features (mobile, cloud sync, multi-provider routing, background summarisation)
   are not started and must not be started automatically.

## Where the pieces are

- Elevation round: `docs/evidence/P23-elevated-round.md`, `P23-trust-elevated.json`,
  `P23-untrust-check.json`, `P23-install-after-trust.json`, `P23-package-fixed.json`,
  `P23-install-menu-fixed.json`, `P23-package-final.json`, `P23-install-final.json`,
  `P23-a11y-installed-2.json`, `P23-memory-installed-2.json`, `P23-qa-installed-2.json`.
- Earlier rounds: `docs/evidence/P23-followup.md`, `P23-human-checklist.md`,
  `P23-trust-verify.json`, `P23-release-candidate.md`, `P22-product-QA.md`.
- Code touched this round: `tools/install/installer.mjs` (identity payload + guard),
  `tools/install/trust.mjs` (both TrustedPeople scopes on removal),
  `tests/install/installer.test.mjs` (one new test).
- Decisions added: D-0108 (verified machine-scope trust), D-0109 (packaged helper + no claim
  from CLSID activation), D-0110 (`untrust` clears both scopes).
- Probes: `npm run memory`, `npm run a11y`, `npm run qa` accept `MONA_MEMORY_EXE` /
  `MONA_A11Y_EXE` / `MONA_QA_EXE` plus `*_OUT` / `*_LOG` overrides. **Set
  `MONA_MEMORY_HISTORY=10000`** for the P22-comparable workload; without it the probe measures an
  empty timeline and fails its own window experiment.

## Requirement matrix

- 28 verified. **MONA-027 blocked** at the requirement level: `installer`, `uninstall` and
  `signing` pass; `modern-menu` is registered and awaiting the human click. **MONA-028 partial**
  (memory 370.5–377.1 MB vs 350 MB; Narrator and physical scaling human-only).
- No three-attempt blocker is open. `attempts.jsonl` holds the closed P02 rows and two
  P23-IDLE-MEMORY rows with material progress. ISSUE-0023 is resolved and recorded as such;
  the state's `blocker_ids` on P21/P23 remain the historical reference to it.

## Last relevant validation

- `npm run ci` exit 0 (575 Vitest in 70 files, 14 bootstrap, 12 launch, 26 install, 8 spike,
  typecheck, lint, format, production build).
- `node tools/build/cli.mjs validate` OK; checkpoint r83.
- Installed candidate: `npm run surfaces` 26/26, `npm run a11y` 12/12, `verify --smoke` exit 0.
- Spend this round: **0 µUSD**. No provider request; no adapter, context or orchestration change.

## Older validation

- `npm run ci` exit 0 for the functional change (format, lint, typecheck, 549 Vitest in 67
  files, 14 bootstrap, 12 launch, 26 install, 8 spike, build); after the final comment edits,
  `format:check`, `lint` and the 26 install tests were re-run green.
- `node tools/build/cli.mjs validate` OK; checkpoint r80.
- Installed candidate: `install verify` exit 0, `npm run memory` 370.5 MB, `npm run a11y` 12/12,
  `npm run qa` cold 421 ms / warm 722 ms.
- Spend this round: **0 µUSD**. No provider request; no adapter, context or orchestration change.

## Cautions

- **A prompt number in the UI is a promise the product has not kept.** Two screens shipped with
  "arrives with P10/P12" while the named prompt had shipped its service and never its surface.
  Grep the renderer for `arrive with P`, `not yet wired` and `placeholder` before calling a
  release candidate done, and treat any such string as a bug report (D-0114).
- A closed requirement is not evidence that a person can reach the feature. Drive the app.

- Edit source with byte-safe tools; a PowerShell `Get-Content`/`Set-Content` round trip
  double-encoded a file once, and a blank-line filter can silently destroy Markdown structure.
- Never overwrite a previous prompt's evidence artifact; the probe scripts accept path overrides.
- Do not claim the modern menu is visible until a person has seen it. Do not "fix" memory by
  moving the target, and do not publish anything.
