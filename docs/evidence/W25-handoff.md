# W25 — Honest handoff

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 (x64) · source `main` at the commit recorded at the end
of this turn · engine `codewhale 0.10.2 (ff466b2ed0bf)` (unchanged) · Electron 45.3.0.

This pass completed **W12, W13, W19, W20, W21, W22, W23, W25**. Four of those carry a human
observation that this machine could not make; they are named below rather than being closed.

## 1. Review inbox — in the order it matters

1. **Trust the test certificate for one machine, or decide not to.**
   *Why:* the Windows 11 Explorer menu cannot register until the package signer is trusted. Today it
   fails with `0x800B0109 – The root certificate of the signature … must be trusted`, reproduced on the
   current bytes.
   *Affects:* the modern-menu claim (MONA-027) and any "share it with a friend" claim.
   *Prepared:* `Mona-Setup-0.1.0-x64.exe` (installs everything else), the certificate at
   `%LOCALAPPDATA%\Mona\artifacts\Mona-test-signing-0.1.0.cer`, thumbprint `5C0AD0D7…C95`.
   *Exact action:* in an elevated shell run `node tools/install/cli.mjs trust-test-certificate`, then
   run the setup file again, then right-click a folder and confirm **Start new DS project with Mona**
   appears in the modern menu (not only under "Show more options").
2. **Look at the Windows 11 menu once.** Same command, seen by a person, closes W22/MONA-027. Automated
   attempts on this machine could not read the shell menu surface.
3. **Narrator, exact 200 % scaling, text size, contrast theme, physical IME.** Nothing here is claimed
   passed. `docs/evidence/W20-accessibility.md` has the checklist with expected results; the machine is
   at 300 % scaling, and the accessibility tree is now exposed to Windows (it was not before this pass).
4. **The 350 MiB idle-memory target is missed.** 352.5 MiB final / 360.1 MiB average idle, 400.6 MiB with
   a 20,000-row session. The app-reducible part is a ~4 MiB renderer heap; the rest is Chromium's
   per-process baseline plus a ~100 MiB software GPU process on this GPU-less VM. Options are in
   `docs/evidence/W19-performance.md`; D-0111 still covers 0.1.0 only.
5. **Signing and licensing for distribution.** The setup file is unsigned. No licence decision was
   invented; redistribution terms are recorded in `THIRD_PARTY_NOTICES.md`, which now ships inside the
   payload.
6. **Decide whether W14–W18 (Prompt Runner import, execution, inbox, UI, fault qualification) and
   W24 (packaged qualification) are next.** W13 delivered only the contract and durable state model;
   nothing schedules a queue yet.

## 2. What was delivered in this pass

- **W12 — identity.** The committed `mona.ico` was invalid: the container was written big-endian, so
  Windows read type 256 with 1792 entries and Electron's `nativeImage` returned an empty image — the
  window/taskbar icon had been silently missing. It is now little-endian and tested the way Windows
  reads it. `tools/assets/embed-exe-icon.mjs` rewrites `RT_ICON`/`RT_GROUP_ICON` in the staged
  `Mona.exe`, staging fails if the embedded bytes do not verify, and the installed binary returns
  16 px/32 px icons byte-identical to the generated PNGs through Windows' own `ExtractIconEx`.
- **W13 — Prompt Runner contract.** Migration 10 adds runs, frozen run tasks, dispatches, transitions
  and report receipts over the existing task engine. Send ≠ accepted ≠ turn completed ≠ task
  completed, one unsettled dispatch per workspace, bounded continuations, report paths contained
  (junctions included), strict report schema. 15 tests; a v9 database migrates with a verified backup.
- **W19 — performance.** Measured before/after on the installed artifact: 353.8 → 352.5 MiB idle
  (unchanged within noise), CPU 0.02–0.06 %, cold start 529 ms / warm 1,679 ms, 20,000-row history
  interactive at 60 fps with 500 rows loaded and 120 rendered. No leak: five view switches and four
  project switches grew DOM, listeners and heap by zero. Target still missed; reported as such.
- **W20 — accessibility.** A plain UI Automation query saw **nine stub elements** because Chromium had
  not built its tree; `app.setAccessibilitySupportEnabled(true)` now exposes 74 named elements, verified
  by `tools/spike/uia-tree.ps1`. Cost measured (352.5 → 358.0 MiB idle). 12/12 automated keyboard checks
  on the installed build.
- **W21 — regression.** `npm run ci` green on the settled candidate (720 vitest in 77 files; node
  suites 17/27/12/29/8), `native:test` 8 pass 1 skip with a proven environment reason, `check:build`
  green (90 preload channels, no engine route in the renderer), both ledgers validating with zero
  warnings after re-recording three stale W12 evidence hashes at their new bytes.
- **W22 — Explorer and trust.** The shell's own verb table offers the command and invoking it starts
  Mona with the folder as one quoted argument; classic keys register and unregister with scoped
  removal; the trust chain is recorded (self-signed, `TrustedPeople` only, never `Root`); the
  `0x800B0109` condition is reproduced and explained. `native:test` was red before this pass and is
  fixed with a control experiment rather than a deleted assertion.
- **W23 — recipient file.** `Mona-Setup-0.1.0-x64.exe` (179 MB, unsigned) installs per user with no
  Node, compiler or checkout: 1,745 files verified, Start shortcut, classic menu, registry and uninstall
  entry; fresh install, upgrade, uninstall from the installed copy and reinstall all exercised. Three
  real defects were found and fixed on the way (packaged installer could not load its icon tool; asar
  rewrote a missing-file error; deferred uninstall cleanup never ran).

## 3. The exact file a recipient uses today

```text
%LOCALAPPDATA%\Mona\artifacts\Mona-Setup-0.1.0-x64.exe
sha256 9abd2b9a2183…  (full value in docs/evidence/W23-installer.json)
```

Unsigned. Installs the app, Start entry and classic menu; the packaged modern menu needs item 1 above.
It is not a "friend-ready, frictionless" distribution and is not described as one.

## 4. Tested versus not tested

- **Tested on the installed artifact:** install/upgrade/uninstall, icon and shell extraction, shell verb
  invocation, accessibility tree and keyboard paths, memory/CPU/startup/history, classic menu values.
- **Tested with fixtures only:** runner contract behaviour (no execution exists yet).
- **Not tested anywhere:** a real pending approval round trip (needs the engine's posture switched to
  `ask`), Narrator, exact 200 % scaling, mixed-DPI, a genuinely clean Windows image, and any signed
  distribution.

## 5. Where things live

- Dispositions and evidence: `.mona/build/reviews/windows-v2/state.json`,
  `docs/requirements-windows.json`, `docs/evidence/W12-*` … `W25-*`.
- Decisions from this pass: D-0128 (executable icon + ICO endianness), D-0129 (runner contract),
  D-0130 (memory target still missed), D-0131 (accessibility enabled explicitly), D-0132 (Explorer/trust
  evidence and the per-user COM limit), D-0133 (single setup file and its installer runtime).
- Build state: `.mona/build/state.json` (original P00–P23 ledger, untouched) and the Windows review
  namespace above.
- Next session: read this file, then `.mona/build/HANDOFF.md`, then run
  `node tools/build/cli.mjs validate` and `node tools/build/windows-review.mjs validate` before trusting
  any status.
