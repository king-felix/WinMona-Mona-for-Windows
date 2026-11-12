# Mona build handoff

**Current prompt:** P23 — release candidate and final handoff. **Status: completed.**
State revision 71; ledger revision 325. All 24 prompts are delivered.

**The claim Mona can support today is "Core usable release candidate 0.1.0".** A 1.0-complete
claim is not available: MONA-027 is blocked on a machine trust decision and MONA-028 is partial
on a measured memory miss plus two human-only checks. Nothing was relabelled to hide that.

The artifact is built, installed cleanly from an empty root, verified, and documented. Nothing
was published: no remote, no package, no certificate, no public repository. Local commits only.

`last_verified_commit` stays null because a state file cannot contain the hash of the commit that
contains it. Verify with `node tools/build/cli.mjs validate` (expect OK, 0 warnings).

## P23 result

- **Closed the last two Foundation/Core criteria**, both of which the ledger had assigned to P23:
  - MONA-014 `diffs` — new Changes section: `ChangesService`, `ChangesPanel`, three validated
    IPC channels, and `packages/ui` `virtualWindow`/`VirtualList`. Real-Electron probe: 20/20
    steps, 5 screenshots, 0 provider requests; an 8,007-line diff renders 29 DOM rows and its
    tail is reachable by scrolling.
  - MONA-007 `copy-export` — conversation export writes the recorded timeline to a Markdown file
    through a temp file plus rename; real store, real file write, cancelled-save and empty-
    session cases tested.
- **Fixed a silent persistence gap found while adding the section:** the IPC view allowlist
  accepted five sections while the shell rendered nine, so restarts dropped Agents, Extensions,
  Memory and Capabilities. One `PROJECT_VIEWS` list now drives rendering, persistence and
  validation, with a test over every entry (D-0103).
- **Gate:** `npm run ci` exit 0 — 546 Vitest (66 files), 14 bootstrap, 12 launch, 14 install,
  8 spike, typecheck/lint/format/build all pass; `npm run native:test` 7/7; `validate` OK.
- **Candidate:** stage 1,668 files / 452,401,443 bytes; MSIX `Mona-0.1.0-x64.msix` sha256
  `7795b587...17bc31`, test-signed, untrusted root reported honestly; clean-root install, smoke,
  verify and uninstall all documented in `docs/evidence/P23-clean-*.json`.
- **Measured on this build:** cold 1,093 ms, warm 741 ms, idle CPU 0.04%, idle memory 406.4 MB,
  engine 256.4 MB separately, 500 of 20,000 history rows in 1 ms.
- **Documentation:** README, user guide, developer guide, compatibility policy, release notes
  with hashes and rollback, changelog, third-party notices, contributing and security policy.
  License deliberately unchosen.
- **Bootstrap CLI defect found and fixed at the last checkpoint:** `checkpoint` back-filled
  `next_eligible_prompts` with the current prompt whenever the computed list was empty, so
  completing the final prompt left a stale entry and `validate` then failed against its own
  computation. The list is now purely derived, with a regression test (bootstrap 13 -> 14).

## Next exact action (for Victor, or for the next session)

1. **Decide the modern-menu trust question** (developer mode / one-time test-certificate trust /
   production certificate), then `node tools/install/cli.mjs install` and right-click a folder
   and a folder background. This is the only thing that can clear MONA-027.
2. **Decide the memory question.** Accept 406.4 MB for 0.1.0 or authorise a heap profile of the
   main and renderer processes. The 350 MB target stays either way (D-0104).
3. **Run the two human checks**: Narrator walkthrough and a physical 200% scaling pass.
4. Only then consider a 0.2.0 scope. Later-scope features (mobile, cloud sync, multi-provider
   routing, background summarisation) are not started and must not be started automatically.

## Where the pieces are

- Release notes with artifact hashes, provenance, rollback: `docs/release-notes-0.1.0.md`.
- P23 evidence: `docs/evidence/P23-release-candidate.md`, `P23-changes.json`,
  `P23-changes-log.txt`, `shots-p23/`, `P23-performance.json`, `P23-package.json`,
  `P23-clean-install.json`, `P23-clean-verify.json`, `P23-clean-uninstall.json`,
  `P23-install-restored.json`, `P23-gate-ci.txt`.
- Decisions added: D-0101 (Changes states), D-0102 (fixed-height virtualization),
  D-0103 (one section list), D-0104 (memory target unchanged).
- Probes: `npm run changes -w @mona/desktop` (new), plus the P22 set unchanged.

## Requirement matrix

- Foundation + Core: **28 verified**. Blocked: MONA-027. Partial: MONA-028.
- Open issues carried: P23-ISSUE-001 (memory), P23-ISSUE-002 (= ISSUE-0023), P23-ISSUE-003
  (export dialog not automated); P22-ISSUE-002..005; all earlier Pxx rows stay as recorded.
- No open three-attempt blocker. `attempts.jsonl` holds only the closed P02 rows.

## Last relevant validation

- `npm run ci` exit 0 (546 Vitest / 66 files + 14 + 12 + 14 + 8).
- `npm run native:test` 7/7. `node tools/build/cli.mjs validate` OK.
- `npm run changes` 20/20 steps, 5 screenshots, 0 provider requests.
- Spend this prompt: **0 µUSD**. No paid turn was run: the probe that submits a turn is
  `npm run studio`, and P23 changed no adapter, context or orchestration path. The P22 figure
  (596 µUSD) remains the last recorded real turn; P15's 5,731.872 µUSD remains the largest.

## Cautions

- Edit source with byte-safe tools. A PowerShell `Get-Content`/`Set-Content` round trip
  double-encoded `App.tsx` once; `check-build.mjs` fails on mojibake, and that check is the
  reason it is hard to ship now.
- Adding an IPC method means updating the allowlist in `apps/desktop/scripts/check-build.mjs`;
  the build fails on an unexpected channel on purpose.
- Do not "fix" the memory row by editing the target, and do not publish anything.
