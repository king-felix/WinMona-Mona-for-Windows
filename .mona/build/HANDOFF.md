# Mona build handoff

**Current prompt:** P23 — release candidate and final handoff. **Status: completed**, plus an
authorized follow-up round (trust, memory, accessibility, startup). State revision 75;
ledger revision 337. All 24 prompts are delivered; there is no next eligible prompt.

**The claim that stands is "Core usable release candidate 0.1.0".** Not 1.0 complete: MONA-027
is blocked on one elevated trust command, MONA-028 is partial on memory (371.4 MB vs 350 MB)
and on the human-only checks. Nothing was relabelled.

Nothing was published: no remote, no package feed, no certificate purchase, no public repo.
Local commits only. The license decision is deliberately unresolved.

Verify before trusting this file: `node tools/build/cli.mjs validate` (expect OK, 0 warnings)
and `node tools/install/cli.mjs verify` (expect `checks.ok: true`).

## Follow-up round result

- **Certificate trust — verified, paused at exactly one step.** The `.cer` (subject
  `CN=Mona Development`, thumbprint `5C0AD0D7…4C95`, code-signing EKU, no private key, valid
  to 2027-11-12), the MSIX's own signer, the manifest Publisher read from inside the package,
  and the build signing record all agree. `tools/install/trust.mjs` now enforces that before
  any import and writes only `LocalMachine\TrustedPeople`; the old Root-store import was
  removed. The import needs elevation and this shell is a standard user, so **no trust was
  added** (all four stores were absent) and no modern-menu claim is made.
- **Memory — 404 → 371.4 MB, target still unmet.** P22's metric was preserved (`workingSetSize`
  sum over `app.getAppMetrics()`, 60 s idle, same 20,000-row workload) and reproduced at 404 MB.
  The cost is not Mona's heap (main 12.0 MB, renderer 3.4 MB) but rendered DOM: 500 rendered
  rows cost +27.7 MB. Windowing to 120 rows with a "show earlier" control cut idle memory to
  **371.4 MB** on the installed candidate. Remaining cost is Chromium's baseline plus a GPU
  process inflated by this host's software compositing. Two attempts with material progress
  are in `attempts.jsonl`; attempt 3 is reserved for the named next step.
- **Accessibility — automated half done.** `npm run a11y` passes 12/12 against the installed
  candidate: labelled composer, named controls with an honestly disabled Interrupt, `role=log`
  + `aria-live=polite`, dialog focus trap and restoration, keyboard reveal of older rows,
  focusable virtualized diff, no horizontal overflow at 200% zoom. Narrator and physical 200%
  scaling remain human.
- **Startup — measured on the installed build.** Cold 422 ms, warm 738 ms (budgets 5 s / 2 s).
  The earlier 418/722 ms came from the development build; that ambiguity is corrected in the
  release notes. The packaged harness completed, so P22-ISSUE-003 "did not reproduce".
- **Gate:** `npm run ci` exit 0 — 549 Vitest (67 files), 14 bootstrap, 12 launch, 25 install,
  8 spike; `npm run native:test` 7/7; `validate` OK.
- **Artifact:** payload 1,672 files / 452,468,362 bytes; `Mona-0.1.0-x64.msix` sha256
  `e9008c1126c8d5607d0abf82c3fcdb83da8f4638e39deeacacc6d458cd4ac202`, test-signed, untrusted
  root reported honestly; clean-root install/verify/uninstall and the installed probes were all
  re-run against these bytes.

## Next exact action (needs Victor)

1. **One elevated command** to enable the modern menu, then the click test:
   `Import-Certificate -FilePath 'C:\Users\victo\AppData\Local\Mona\artifacts\Mona-test-signing-0.1.0.cer' -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'`,
   then `node tools/install/cli.mjs trust-test-certificate`, then `install --force`, then
   right-click a folder and a folder background. Removal:
   `node tools/install/cli.mjs untrust-test-certificate` (elevated).
2. **Work through `docs/evidence/P23-human-checklist.md`** — 21 rows: modern menu (after 1),
   Narrator walkthrough, physical 200% scaling, conversation export through the real Save
   dialog.
3. **Decide memory:** accept 371.4 MB with the target still unmet, or authorize the next
   evidence-led step (`docs/evidence/P23-followup.md` §2.7). The 350 MB target is unchanged.
4. **Decide the license** before any public distribution.
5. Later-scope features (mobile, cloud sync, multi-provider routing, background summarisation)
   are not started and must not be started automatically.

## Where the pieces are

- Follow-up evidence: `docs/evidence/P23-followup.md`, `P23-human-checklist.md`,
  `P23-trust-verify.json`, `P23-memory-installed.json`, `P23-memory-dev.json`,
  `P23-a11y.json`, `P23-a11y-installed.json`, `P23-a11y-shots.json`, `P23-polish.json`,
  `P23-startup-installed.json`, `P23-installed-final.json`, `P23-installed-verify.json`,
  `P23-clean-install.json`, `P23-clean-uninstall.json`, `P23-gate-ci.txt`,
  `shots-p23-installed/`.
- Probes: `npm run memory`, `npm run a11y`, `npm run changes`, `npm run qa`, `npm run shots`,
  `npm run polish` — the first four accept an installed-executable env var (`MONA_*_EXE`);
  shots and polish run the development build.
- Decisions added this round: D-0105 (verified, narrowly scoped trust), D-0106 (windowed
  timeline), D-0107 (memory target unchanged, progress recorded).

## Requirement matrix

- 28 verified. **MONA-027 blocked** (modern menu needs the elevated trust step). **MONA-028
  partial** (memory 371.4 MB vs 350 MB; Narrator and physical scaling human-only).
- Issues: P23-ISSUE-001 (memory, improved not met), P23-ISSUE-002 (= ISSUE-0023),
  P23-ISSUE-003 (export dialog not automated), P23-ISSUE-004 (packaged startup now measured;
  P22-ISSUE-003 did not reproduce), P22-ISSUE-004/005.
- No three-attempt blocker is open. `attempts.jsonl` holds the closed P02 rows and two
  P23-IDLE-MEMORY rows with material progress.

## Last relevant validation

- `npm run ci` exit 0 (549 Vitest / 67 files + 14 + 12 + 25 + 8).
- `npm run native:test` 7/7. `node tools/build/cli.mjs validate` OK.
- Installed candidate: `npm run memory` 371.4 MB, `npm run a11y` 12/12, `npm run changes`
  20/20, `npm run qa` cold 422 ms / warm 738 ms.
- Spend this round: **0 µUSD**. No paid turn was run; no adapter, context or orchestration path
  changed. P22's 596 µUSD remains the last recorded real turn.

## Cautions

- Edit source with byte-safe tools; a PowerShell `Get-Content`/`Set-Content` round trip
  double-encoded a file once, and a blank-line filter can silently destroy Markdown structure.
  `check-build.mjs` catches mojibake in the renderer, not in documents.
- Never overwrite a previous prompt's evidence artifact; the probe scripts now accept path
  overrides — use them.
- Do not "fix" memory by moving the target, and do not publish anything.
