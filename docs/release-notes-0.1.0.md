# Mona 0.1.0 — release candidate notes

**Status: release candidate, not 1.0 complete.** Foundation and Core requirements are
verified. Two Complete-track requirements are not: MONA-027's modern menu is registered but no
person has yet seen or clicked the entry, and MONA-028 is partial on a measured memory miss
(accepted for 0.1.0 by decision, target still unmet) and two human-only checks.

- Built: 2026-11-12 (local time), reference machine.
- Tested platform: Windows 11 Pro 10.0.26200 (25H2), AMD Ryzen 7 5800X, 32 GB RAM, x64.
- Tested engine: Codewhale `0.10.2 (ff466b2ed0bf)`.
- Source: the local commit that contains this file's directory (no remote exists).
- Node used to build: v26.13.1; Electron 45.3.0.

## Artifacts

All under `%LOCALAPPDATA%\Mona\artifacts\`:

| Artifact | Bytes | SHA-256 |
|---|---|---|
| `Mona-0.1.0-x64.msix` | 127,928 | `8c815f83e830b28937fe615fb1fa1e11e37b4cc61c15ada9d68e841a4839abc2` |
| `Mona-test-signing-0.1.0.cer` | 792 | `3268b236318b2f2fcb7d5388bf9684a58f98a6f711e1c9089919a6544918fc1d` |
| `SHA256SUMS-0.1.0.txt` | 180 | lists both of the above |

Payload and program identity:

| Artifact | Value |
|---|---|
| Install payload | `build/install-stage`, **1,681 files**, 452,756,367 bytes |
| Payload manifest | `build/install-stage/checksums.json`, sha256 `2125d7350b22cc6c34024fa86bd4e006dbfc9a64657bf7bcbc861e6b5c295cec` |
| `Mona.exe` | 249,270,272 bytes, sha256 `207853646fd0553430706aee4d2ef1fac8a492cc32001dcec739598c89d8a492` |
| `MonaMenu.dll` | sha256 `a6a595e149370290d8b9eea3e6c7ec23294a2b84e37374a966a6bf2786749bcd` |
| Identity package | `MonaWorkbench`, sparse, version `0.1.0.0`, x64 |

### Signing status — read this precisely

The MSIX is **test-signed** with a self-created certificate (`CN=Mona Development`, thumbprint
`5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95`). No production signature exists, none is claimed,
and no certificate was bought.

On **this reference machine** the certificate is trusted in `LocalMachine\TrustedPeople` by the
elevated, verified `trust-test-certificate` step (D-0105). That is why `Add-AppxPackage` now
accepts the package and the Windows 11 modern folder menu registers. `signtool verify` reports
a trusted chain only because of that local import.

Consequences, stated plainly:

- Any other machine refuses the package with `0x800B0109` until it makes the same trust
  decision; a machine without this certificate trusts nothing Mona signs, by design.
- The trust covers any package signed by this key on this machine, not just Mona's.
- The menu entry's **appearance has not been captured**; registration is proven, a right-click
  is not. See `docs/evidence/P23-elevated-round.md` and the human checklist.
- Removal is exact and elevated: `node tools/install/cli.mjs untrust-test-certificate` clears
  the thumbprint from both `TrustedPeople` stores and never touches `Root`.

## Provenance and reproducibility

The artifact is what the repository builds: the stage is assembled from `apps/desktop` and the
installed Electron distribution by `node tools/install/cli.mjs stage`, and the MSIX contains
only the identity package (manifest, four logo assets, and the menu DLL the manifest declares),
not the program.

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

## Follow-up round — trust, memory, accessibility, startup

This round was authorized after the first candidate: verify the certificate before trusting it,
investigate the memory miss, and finish the automated accessibility and startup work. Full
detail is `docs/evidence/P23-followup.md`; artifacts below are rebuilt and re-measured.

**Certificate trust — verified, blocked on exactly one elevated step.** The `.cer`, the MSIX's
own signer, the packaged manifest Publisher and the build signing record all agree
(`CN=Mona Development`, thumbprint `5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95`, code-signing EKU,
no private key, valid to 2027-11-12). Trust provisioning is now a checked code path that writes
only `Cert:\LocalMachine\TrustedPeople`; the previous Root-store import was removed. The import
needs an elevated shell and none was available, so **P23 imported nothing and claims nothing** —
no trust existed in any store beforehand. One command remains; it is in `BLOCKERS.md`
ISSUE-0023 and `P23-human-checklist.md`.

**Memory — 404 MB → 371.4–377.1 MB, target still unmet.** The P22 metric was preserved exactly
(`sum of workingSetSize across app.getAppMetrics()`, 60 s idle, same 20,000-row workload) and
reproduced at 404.0–404.4 MB before changing anything. The footprint is not Mona's data:
main JS heap 12.0 MB, renderer JS heap 3.4 MB, and 2,497 DOM nodes. Windowing the rendered
timeline to the newest 120 rows (with a keyboard-reachable "show earlier" control) cut idle
working set to **371.4–377.1 MB** on the installed candidate; rendering all 500 loaded rows costs
+27.7 MB. The remaining 21.4 MB is Chromium's own process baseline plus a GPU process inflated
by this host reporting `gpu_compositing: disabled_software`. The 350 MB target is unchanged and
MONA-028 stays partial.

**Accessibility — automated half done.** `npm run a11y` passes 12/12 against the installed
candidate: labelled composer, named controls with an honestly disabled Interrupt while idle,
`role="log"` with `aria-live="polite"`, dialog focus trap and focus restoration, keyboard
reveal of older timeline rows, a focusable virtualized diff, and no horizontal overflow at
200% zoom. Narrator and physical 200% scaling remain human-only.

**Startup — measured on the installed build.** Cold 427 ms and warm 732 ms on the installed
`Mona.exe` (budgets 5 s / 2 s). The earlier report's 418/722 ms came from the development
build; that ambiguity is corrected. The packaged harness completed this time, so
P22-ISSUE-003 "did not reproduce" — its cause is still unknown.

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

## Layout round

Two display controls were added after the candidate was qualified, because the reference machine
is driven from a TV:

- **The Inspector collapses** to a 32 px rail and starts closed, returning 253–268 px of width to
  the agent timeline (measured 933 px vs 665–680 px). Open with the rail button, close with
  **Hide**; the choice is remembered, and Focus Mode still hides it.
- **<kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> scale the whole window** through a
  fixed 50–200 % ladder, handled in the main process so it works with focus anywhere. A status
  bar control shows the applied percentage, disables the exhausted direction and resets on click;
  the choice persists in `state/appearance.json`. Because the whole web contents scales, every
  panel reflows together rather than one column growing.
- A layout defect was found at 150 % and fixed: the work area had been painting over the status
  bar. The live probe now asserts the boundary.

Verification: `docs/evidence/P24-appearance.md`, 19 live steps and three screenshots on both the
development and the installed build; 558 Vitest tests in 68 files; the accessibility probe still
passes 12/12 at 200 % zoom.

## Known issues

- **P23-ISSUE-002 / ISSUE-0023 — the modern Windows 11 menu is registered but unseen.** Machine
  trust was provisioned by the verified elevated import, the identity package registers
  (`Status: Ok`) and both verbs are declared, but no human right-click has confirmed the entry.
  Classic menu works.
- **P23-ISSUE-001 — idle memory 370.5–377.1 MB** across four processes against the 350 MB target.
  Improved from 404 MB by windowing rendered timeline rows. The deviation is **accepted for
  0.1.0** (D-0111); the target is unchanged and still unmet.
- **P22-ISSUE-004 — screen-reader walkthrough and physical 200% scaling** remain human-only.
  The automated accessibility probe passes 12/12 and is not a substitute.
- **P23-ISSUE-004 — conversation export's Save dialog** is unit-tested with a real file write and
  a stubbed dialog; the OS dialog has not been clicked by any automated run.
- **P22-ISSUE-005 — engine memory under load** is still unmeasured; only idle engine memory is known.
- **P22-ISSUE-003 — the packaged QA harness stall** did not reproduce in this round. Recorded as
  "did not reproduce", not "fixed": the cause remains unknown.
- **Restore covers HEAD only.** No snapshot engine, no arbitrary-commit restore.
- **The engine's own terminal routes are unavailable on Windows**; Mona's own ConPTY terminal
  replaces them and is labelled separately.

## Superseded notes

The first candidate reported 404–406.4 MB idle memory, a development-build startup timing and
an unverified Save dialog. The follow-up round above replaces all three: memory is 371.4–377.1 MB on
the installed candidate, startup is 427 ms / 732 ms on the installed build, and the export write
path is tested with a real file. The original numbers stay here so the change is auditable
rather than silently rewritten.
## Memory decision

The 350 MB target stays. It is an engineering budget from the specification, and lowering the
number to match a measurement would destroy its only function.

Two attempts produced material progress: **404 MB → 371.4–377.1 MB** on the installed candidate, by
bounding rendered timeline rows to 120 with an explicit "show earlier" control (D-0106). What is
now known: the cost is not Mona's JavaScript heap (12.0 MB main, 3.4 MB renderer) but rendered
DOM plus Chromium's process baseline, and this host's GPU process is inflated by software
compositing (`gpu_compositing: disabled_software`). What is still unknown: how much of the
residue a hardware-accelerated host would not pay.

Decision (D-0107): ship the release candidate with the improvement recorded and the target
**still unmet by 21.4 MB**. MONA-028 stays partial. The third attempt is reserved for the next
evidence-led step in `docs/evidence/P23-followup.md` §2.7 and is not started on speculation.
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

1. Right-click a folder and a folder background and confirm **Start new DS project with Mona**
   appears in the Windows 11 modern menu (not only under **Show more options**). Registration,
   signer and publisher are already verified; this is the only observation still owed.
2. Classic menu by hand: right-click a folder and a folder background, choose
   **Start new DS project with Mona**, confirm the project opens with the composer focused and
   nothing sent.
3. Work through `docs/evidence/P23-human-checklist.md`: Narrator walkthrough, physical 200%
   scaling, and the conversation export Save dialog (success and cancel).
4. Memory question: **decided** — the 371.4–377.1 MB deviation is accepted for 0.1.0 (D-0111);
   the next evidence-led step in `docs/evidence/P23-followup.md` §2.7 stays unauthorized.
5. Decide the license before any public distribution. It remains unresolved on purpose.