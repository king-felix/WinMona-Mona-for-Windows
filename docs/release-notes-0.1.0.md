# Mona 0.1.0 — release candidate notes

**Status: release candidate, not 1.0 complete.** Foundation and Core requirements are
verified. Two Complete-track requirements are not: MONA-027 is blocked on a machine-policy
decision, MONA-028 is partial on a measured memory miss and two human-only checks.

- Built: 2026-11-12 (local time), reference machine.
- Tested platform: Windows 11 Pro 10.0.26200 (25H2), AMD Ryzen 7 5800X, 32 GB RAM, x64.
- Tested engine: Codewhale `0.10.2 (ff466b2ed0bf)`.
- Source: the local commit that contains this file's directory (no remote exists).
- Node used to build: v26.13.1; Electron 45.3.0.

## Artifacts

All under `%LOCALAPPDATA%\Mona\artifacts\`:

| Artifact | Bytes | SHA-256 |
|---|---|---|
| `Mona-0.1.0-x64.msix` | 4,850 | `0c7446e71fcf9ea7124ae49ee97c0459ecc63c719295fce4f11032ae10f91a6a` |
| `Mona-test-signing-0.1.0.cer` | 792 | `3268b236318b2f2fcb7d5388bf9684a58f98a6f711e1c9089919a6544918fc1d` |
| `SHA256SUMS-0.1.0.txt` | 180 | lists both of the above |

Payload and program identity:

| Artifact | Value |
|---|---|
| Install payload | `build/install-stage`, **1,668 files**, 452,401,443 bytes |
| Payload manifest | `build/install-stage/checksums.json`, sha256 `b78ea8a0e116ed40a6b424ad1558eed03e886737fa6d84294d48f5facba09398` |
| `Mona.exe` | 249,270,272 bytes, sha256 `207853646fd0553430706aee4d2ef1fac8a492cc32001dcec739598c89d8a492` |
| `MonaMenu.dll` | sha256 `a6a595e149370290d8b9eea3e6c7ec23294a2b84e37374a966a6bf2786749bcd` |
| Identity package | `MonaWorkbench`, sparse, version `0.1.0.0`, x64 |

### Signing status — read this precisely

The MSIX is **test-signed** with a self-created certificate (`CN=Mona Development`, thumbprint
`5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95`). `signtool verify` reports **no trusted chain**
because the certificate's root is not in a trust store on this machine. No production
signature exists, none is claimed, and no root certificate was imported.

Consequence: `Add-AppxPackage` refuses the package with `0x800B0109`, so the Windows 11 modern
folder menu cannot be registered here. The classic Explorer entry is registered and verified.
See "Known issues" and `.mona/build/BLOCKERS.md` ISSUE-0023.

## Provenance and reproducibility

The artifact is what the repository builds: the stage is assembled from `apps/desktop` and the
installed Electron distribution by `node tools/install/cli.mjs stage`, and the MSIX contains
only the identity package (manifest plus four logo assets), not the program.

Reproducing the candidate from a clean checkout:

```powershell
npm ci
npm run ci                                  # format, lint, typecheck, tests, build
npm run native:test                         # native menu helper tests
node tools/build/cli.mjs validate
node tools/install/cli.mjs stage
node tools/install/cli.mjs package --test-sign
node tools/install/cli.mjs install --smoke
node tools/install/cli.mjs verify --smoke
```

What is reproducible exactly: the payload file set and its per-file hashes (`checksums.json`),
`MonaMenu.dll`, and the identity package contents. What is not byte-stable across machines:
the MSIX itself (contained signatures and timestamps differ) and `Mona.exe`'s embedded
Electron resources if a different Electron build is resolved. There is no signed attestation
and no reproducible-build proof beyond the recorded hashes.

## Clean-environment install evidence

`docs/evidence/P23-clean-install.json`, `P23-clean-verify.json`, `P23-clean-uninstall.json`.

Run against fresh roots (`MONA_INSTALL_ROOT`, `MONA_DATA_ROOT`, `MONA_USER_DATA` pointed at an
empty temporary directory), so nothing from the developer install could be reused:

1. `install --force --smoke` → ok. 1,668 files placed, payload checksums verified, PTY prebuilds
   present, classic menu registered and verified, uninstall entry written, identity package
   refused with `0x800B0109` (reported, not fatal).
2. Installed-app smoke → `ok`, exit 0, version `0.1.0`, renderer rendered, seven state
   migrations applied to schema v7.
3. `verify --smoke` → all checks pass; `MonaMenu.dll` hash matches the payload.
4. `uninstall --force` → program tree, Mona registry keys and classic menu removed;
   `~/.codewhale` untouched (2,855 entries still present); artifacts kept.

Afterwards the real per-user installation on this machine was reinstalled at
`%LOCALAPPDATA%\Programs\Mona` and verified (`docs/evidence/P23-install-restored.json`); the
classic menu command reads
`"…\Programs\Mona\Mona.exe" project open --path "%V" --profile ds-full-access`.

## Verification summary

- `npm run ci` (exit 0): Prettier, ESLint, typecheck across five workspaces, then
  **546 Vitest tests in 66 files**, 14 bootstrap, 12 launch, 14 install, 8 spike, and the
  production build. Log: `docs/evidence/P23-gate-ci.txt`.
- `npm run native:test` → 7/7.
- **Changes probe in real Electron** (`npm run changes`): 20/20 steps, 5 screenshots, zero
  provider requests (`P23-changes.json`, `shots-p23/`). It proves: a real Git repo, the real
  catalog, the Changes section reachable from the rail, "no baseline" distinguished from "no
  changes", baseline captured through the real IPC channel, modified/added paths reported, a
  real test receipt, Git's own diff text rendered, a 8,007-line diff rendered with 29 DOM rows
  and its tail reachable by scrolling, and a traversal path refused.
- **Performance on this build** (`P23-performance.json`, development build): cold 1,093 ms,
  warm 741 ms, idle CPU 0.04% average over 60 s, idle memory **406.4 MB** across 4 processes,
  engine 256.4 MB separately, 500 of 20,000 history rows loaded and rendered in 1 ms.
  Frame timing this run landed on the ~16.7 ms vsync grid (median and p95 both 16.7–16.8 ms),
  which is the first run where the window was presented; P22's collapsed-to-zero frame numbers
  remain invalid and are not reused.
- **Engine identity re-checked**: `codewhale --version` → `codewhale 0.10.2 (ff466b2ed0bf)`,
  matching the pinned build. An upstream repository check could not run: `api.github.com` did
  not resolve from this machine during P23. That is recorded as a gap, not worked around.

## What this candidate adds over P22

- **Changes section** (MONA-014 `diffs`): a change list from a captured baseline, Git status,
  a virtualized diff viewer, skipped-path reporting, and recorded test receipts. It is a new
  top-level section (Alt+0, command palette) and three validated IPC channels.
- **Conversation export** (MONA-007 `copy-export`): the recorded timeline written to a Markdown
  file you choose, with real timestamps, statuses and truncation labels; no model call. Copy of
  individual items already shipped.
- **One view list** for navigation and persistence. Previously the IPC allowlist accepted only
  five sections, so a restart silently dropped the others; now every renderable section is
  saveable, with a test that iterates the list.
- **Release documentation**: README, user guide, developer guide, compatibility policy,
  third-party notices, contributing, security policy, changelog, this note.

## Known issues

- **P23-ISSUE-001 / P22-ISSUE-001 — idle memory.** 406.4 MB across four processes against a
  350 MB internal target. Not adjusted away: see "Memory decision" below.
- **P23-ISSUE-002 — the modern Windows 11 menu is not registered** (`0x800B0109`, untrusted
  certificate root). Requires developer mode, an interactive certificate trust decision, or a
  production certificate. Blocked requirement: MONA-027.
- **P22-ISSUE-004 — screen-reader walkthrough** is human-only and still outstanding. So is a
  physical 200% scaling check; the harness captures 200% zoom but that is not the same test.
- **P22-ISSUE-003 — the packaged measurement harness stalled** in P22. This prompt re-ran the
  measurement on the development build only, and the packaged app was exercised through the
  install/verify/`--smoke-test` path instead. Packaged startup timing is therefore still
  unmeasured.
- **P22-ISSUE-005 — engine memory under load** is unmeasured; only idle engine memory is known.
- **Restore covers HEAD only.** No snapshot engine, no arbitrary-commit restore.
- **The engine's own terminal routes are unavailable on Windows**; Mona's ConPTY terminal
  replaces them and is labelled separately.
- **The conversation save dialog is not automated.** Export is covered by unit tests with a real
  file write and a fake dialog; a human click on the real dialog is unverified.

## Memory decision

The 350 MB target stays. It is an engineering budget from the specification, and lowering the
number to match the measurement would destroy its only function.

The measured 406.4 MB is recorded as a real deviation of +56.4 MB (16%). What is known: four
processes (browser, GPU, utility, renderer) on Windows 11 with Electron 45; the engine is
separate at 256.4 MB and excluded from the budget. What is not known: the split between the
main-process heap, the renderer heap, and Chromium's GPU/utility overhead, because no heap
profile has been taken.

Decision (D-0102): ship the release candidate with the deviation recorded, and treat a heap
profile as the first post-0.1.0 performance task rather than blocking the candidate on an
unprofiled number. MONA-028 stays **partial** until either the footprint drops below 350 MB on
a presented-window run or Victor records a deliberate change to the target.

## Rollback

- **Program rollback:** keep the previous stage directory. `tools/install/cli.mjs install`
  replaces the program tree atomically and moves the old tree to
  `Programs/Mona.old-<stamp>`; restoring that directory means closing Mona and renaming it back
  to `Programs\Mona`.
- **Database rollback:** a verified backup is written to
  `%LOCALAPPDATA%\Mona\backups\` before any migration. To roll back a schema change: quit Mona,
  keep a copy of the current `mona.sqlite`, then replace it with the pre-migration backup. Mona
  refuses to run the product on a database older than the current program expects, rather than
  guessing.
- **Uninstall** keeps user data; removing `%LOCALAPPDATA%\Mona` and
  `%APPDATA%\@mona\desktop` deletes local history. Nothing is uploaded anywhere.

## Next human actions

1. Decide the modern-menu trust question (developer mode, one-time test-certificate trust, or a
   production certificate), then right-click a folder and a folder background and confirm the
   entry appears in the Windows 11 menu.
2. Right-click a folder and a folder background and choose **Start new DS project with Mona**
   in the classic menu; confirm the project opens with the composer focused and nothing sent.
3. With Narrator on, open Mona, tab through Home → Studio → composer and confirm each control
   announces its name and state.
4. Set Windows scaling to 200% on a physical display and confirm no horizontal scrolling is
   needed for the composer and control strip.
5. Confirm or reject the memory decision above.
