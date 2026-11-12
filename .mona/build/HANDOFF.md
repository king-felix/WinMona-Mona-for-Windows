# Mona build handoff

**Current prompt:** P23 — Package the release candidate and finish the handoff
**Current status:** P00–P22 completed. State revision 67; ledger revision 314.
MONA-027 is **blocked** (modern-menu package trust) and MONA-028 is **partial**
(idle memory over budget, human screen-reader check). A 1.0-complete claim is
therefore not available.

`last_verified_commit` stays null because a state file cannot contain the hash of
the commit that contains it. Verify with `node tools/build/cli.mjs validate`
(expect OK, 0 warnings) before trusting this file.

## P22 result — whole-product QA

- **Measured on this machine** (Ryzen 7 5800X, 32 GB, Windows 11 26200): cold
  startup 418 ms, warm 722 ms, idle CPU 0.04% over 60 s, idle memory **404 MB**
  across 4 processes, engine 270.8 MB separately, history query 1 ms for the newest
  500 of 20,000 rows, 500 items rendered.
- **Real engine turn through the installed app**: 22/22 steps, `hello.txt` written,
  project test passed, one turn at **596 µUSD**, replay sent nothing.
- **Accessibility**: focus trail has a solid outline on every stop, no duplicate
  ids, no unnamed controls, no colour-only statuses; both themes, both densities,
  1280×800, 1920×1080 and 200% zoom captured; Alt+2, Focus Mode and notification
  focus are keyboard-only.
- **Findings recorded, not smoothed over**: memory misses its 350 MB budget by
  54 MB (P22-ISSUE-001); paint frame timing is invalid because the harness window
  was not presented (P22-ISSUE-002); the packaged QA harness stalled and needs the
  watchdog (P22-ISSUE-003); screen-reader and engine-under-load memory remain
  unmeasured (P22-ISSUE-004/005).
- **Requirement effect**: MONA-030 verified; MONA-028 partial; MONA-027 still
  blocked.

## Next exact action (P23)

P23 packages the release candidate and closes the project. Work from what exists:

1. Re-run the gate: `npm run ci`, `npm run native:test`, `node tools/build/cli.mjs
   validate`.
2. Build the candidate: `node tools/install/cli.mjs stage`,
   `node tools/install/cli.mjs package --test-sign`, `install --smoke`, and record
   checksums in the release notes.
3. Write the release documentation the spec asks for: README, third-party notices,
   contribution and security-report instructions, compatibility policy,
   reproducible-build steps, and screenshots of actual builds (reuse
   `docs/evidence/shots-p22/`).
4. Publish nothing. No public repository, package, release, certificate, or
   purchase. Local commits only.
5. Produce the final report with the honest matrix: MONA-027 blocked on
   ISSUE-0023, MONA-028 partial on the measured memory miss and the human checks,
   and the remaining human checklist from `docs/evidence/P22-product-QA.md`.
6. Decide the memory question explicitly: accept 404 MB with a recorded reason, or
   schedule profiling. Do not move the 350 MB target to match the number.

## The one blocking prerequisite (Victor's decision)

The modern-menu identity package cannot register until one of these happens: enable
developer mode (administrator), accept the labelled test certificate into the
current-user Root store once
(`node tools/install/cli.mjs trust-test-certificate`, interactive), or supply a
production certificate for `MONA_SIGN_PFX`. Details: `.mona/build/BLOCKERS.md`
ISSUE-0023 and `docs/evidence/P21-windows.md`.

## Relevant files and spec sections

- `tools/install/` (lifecycle), `native/windows-shell/` (menu helper)
- `apps/desktop/scripts/qa.mjs`, `apps/desktop/src/main/qa-probe.ts`
- `docs/evidence/P21-windows.md`, `P22-product-QA.md`, `P22-performance.json`
- Spec 14–17; prompt P23.

## Open problem IDs and no-progress counts

No open three-attempt blocker. `attempts.jsonl` holds only the closed P02 rows.

P22-ISSUE-001..005 (memory miss, paint timing, packaged harness stall,
screen-reader, engine-under-load memory). P21-ISSUE-001..006. Carried from P20 and
earlier: P20-ISSUE-001..003, P19-ISSUE-001..004, P18-ISSUE-002/003,
P17-ISSUE-001..005, P16-ISSUE-001..004, P15-ISSUE-001..003, P14-ISSUE-001..004,
P13-ISSUE-001..003, P12-ISSUE-001..003, P11-ISSUE-001, P10-ISSUE-001..003,
P09-ISSUE-001..002, P08-ISSUE-001..003, P07-ISSUE-001, P06-ISSUE-002,
P05-ISSUE-001, P01-ISSUE-001..004, terminal ISSUE-0019..0022.

## Last relevant validation

- `npm test` → 513 Vitest (61 files) + 13 bootstrap + 12 launch + 14 install + 8 spike.
- `npm run native:test` → 7/7. `npm run typecheck`, `lint`, `format:check`, `build` pass.
- `node tools/build/cli.mjs validate` → OK, 0 warnings.
- Spend this prompt: 596 µUSD (one real turn). P15's delegated run (5,731.872 µUSD)
  remains the largest single paid run; the $2 pilot ceiling is not approached.

## Human input needed

- Modern-menu choice A/B/C, then a right-click in Explorer for both the modern and
  classic entries.
- Screen-reader walkthrough; 200% scaling on a physical display.
- A decision on the 404 MB idle footprint.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and one test string
in P14; Prettier does not repair that. `check-build.mjs` fails on mojibake in the
renderer bundle.
