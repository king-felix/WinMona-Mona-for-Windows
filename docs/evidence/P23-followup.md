# P23 follow-up — trust, memory, accessibility, startup

**Date:** 2026-11-12. **Machine:** Windows 11 Pro 10.0.26200, Ryzen 7 5800X, 32 GB, x64.
**Engine:** Codewhale `0.10.2 (ff466b2ed0bf)` (re-checked; unchanged).
**Candidate:** 0.1.0, `Mona-0.1.0-x64.msix` sha256
`6b152b1798b58018b4a368720b8c9bb2042d928534a133c87d7a8d3b6f7bc7c1`, payload 1,672 files.

This file records the follow-up work Victor authorized: certificate trust, memory
investigation, accessibility checks, and the startup-measurement ambiguity.

---

## 1. Certificate trust — verified, then paused at exactly one elevated step

Trust is now a **verified policy in code**, not a manual import. `tools/install/trust.mjs`
refuses to trust anything until seven facts agree, and `tools/install/cli.mjs
trust-test-certificate` runs that check before it touches a certificate store.

### What was verified (2026-11-12, unelevated)

| Fact | Observed | Source |
|---|---|---|
| Certificate subject | `CN=Mona Development` | `Mona-test-signing-0.1.0.cer` |
| Certificate thumbprint | `5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95` | same |
| Validity | 2026-11-12T17:22:49Z → 2027-11-12T17:32:49Z | same |
| Key usage / EKU | Digital Signature + Code Signing `1.3.6.1.5.5.7.3.3` | same |
| Private key in the `.cer` | **absent** (`HasPrivateKey=false`) | same |
| Self-signed | yes (subject = issuer) | same |
| Certificate sha256 (file) | `3268b236318b2f2fcb7d5388bf9684a58f98a6f711e1c9089919a6544918fc1d` | same |
| **Package signer** thumbprint | `5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95` | `Get-AuthenticodeSignature` on the MSIX |
| Package signer subject | `CN=Mona Development` | same |
| Manifest Name / Publisher / Version | `MonaWorkbench` / `CN=Mona Development` / `0.1.0.0` | read from `AppxManifest.xml` inside the MSIX |
| Build signing record | same thumbprint and subject | `%LOCALAPPDATA%\Mona\signing\test-signing.json` |
| Verdict | `ok: true`, 0 problems | `P23-trust-verify.json` |

The package is signed by the same key the certificate describes, and the manifest Publisher
equals the signing subject character for character. Nothing was trusted on the strength of
the file sitting beside the artifact.

### What the provisioning actually does

- Store: `Cert:\LocalMachine\TrustedPeople` only. Never `Root`, never `CurrentUser`, never
  "disable signature validation", never Developer Mode.
- Scope: this is **certificate trust for the machine**, not a per-package bypass. Any package
  signed by this key on this machine would be accepted while the certificate is trusted.
- Idempotent: an already-trusted thumbprint is reported as `alreadyPresent` and not duplicated.
- Removable by exact thumbprint (see §1.4).

### 1.3 Blocked step: elevation

`node tools/install/cli.mjs trust-test-certificate` currently returns exit code `4`,
`stage: "elevation"`, because AppX deployment runs as a machine account and a
`LocalMachine` store write needs administrator rights. The current shell is a **standard
user** (`DESKTOP-RBG5MUC\victo`, `IsInRole(Administrator) = false`).

Presence before any import (all four stores checked):

```
LocalMachine\TrustedPeople : absent
LocalMachine\Root         : absent
CurrentUser\TrustedPeople : absent
CurrentUser\Root          : absent
CurrentUser\My            : the certificate exists (created by the packaging step)
```

So this step would **add** trust; it would not find it already present. Nothing was imported,
so no trust change was made on this machine by P23.

**The exact command** (elevated PowerShell — "Run as administrator"):

```powershell
Import-Certificate -FilePath 'C:\Users\victo\AppData\Local\Mona\artifacts\Mona-test-signing-0.1.0.cer' `
  -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'
node 'X:\AI_projects\Mona\tools\install\cli.mjs' trust-test-certificate
```

The second command re-runs the full verification and reports `added: true` or
`alreadyPresent: true`. Then:

```powershell
node tools/install/cli.mjs install --force
```

### 1.4 Exact removal procedure

```powershell
# elevated PowerShell; the thumbprint is printed by the verifier as well
Remove-Item -Path 'Cert:\LocalMachine\TrustedPeople\5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95' -Force
# or, with the same verification as import:
node tools/install/cli.mjs untrust-test-certificate
```

After removal, packages signed by this key are refused again (`0x800B0109`). Uninstall removes
the **current-user** copy of the certificate; a `LocalMachine` trust entry needs the elevated
command above, and uninstall reports it rather than silently failing
(`machineTrustNote` with the exact path).

### 1.5 What is therefore still unproven

- The Windows 11 modern context menu has **not** been registered or clicked on this machine.
  Classic-menu evidence from P21/P22 stands and does not substitute for it.
- Launch/focus/repeat-invocation/uninstall-cleanup of the *modern* entry are unproven for the
  same reason.
- Production distribution to ordinary computers remains pending: a machine without this
  certificate trusts nothing Mona signs, by design.

MONA-027 stays **blocked**, narrowed to one elevated command. Its installer, uninstall and
signing criteria remain verified.

---

## 2. Memory — baseline reproduced, one fix landed, target still unmet

### 2.1 What the original number was

`P22-performance.json` recorded **404 MB**, meaning the **sum of `workingSetSize` across
`app.getAppMetrics()`** (browser, renderer[Tab], GPU, utility), in MiB, sampled after a
60-second idle window, with 10,000 × 2 seeded timeline rows and 500 rendered items, on the
**development** Electron build. "Engine 270.8 MB" was a separate process, never part of the
budget. That definition is preserved verbatim in the new probe; no metric was changed.

### 2.2 Baseline reproduced on this machine

`npm run memory` with `MONA_MEMORY_HISTORY=10000` (the P22 workload) on the development build
before any product change: **404.0–404.4 MB** total working set across four processes. The
number reproduces the P22 value, so the comparison basis is sound.

### 2.3 Where the memory actually is (installed candidate, 60 s idle, 11 samples)

| Process | Working set | Private bytes | Note |
|---|---|---|---|
| Browser (main) | 113.8 MB | 77.9 MB | main-process **JS heap is 12.0 MB**; RSS 114.6 MB |
| GPU | 108.9 MB | 261.5 MB | `gpu_compositing: disabled_software` on this host — see §2.5 |
| Utility (network service) | 51.0 MB | 11.9 MB | Chromium's network service, not Mona code |
| Tab (renderer) | 103.4 MB | 47.5 MB | **JS heap 3.3 MB**, 2,497 DOM nodes, 299 listeners |
| **Total** | **377.1 MB** | — | engine measured separately, never included |

The JavaScript heap is **not** the problem: 12.0 MB in main and 3.4 MB in the renderer, on a
406 MB footprint. What is left is Chromium's own process baseline, which Mona inherits by
choosing Electron and does not allocate itself.

### 2.4 One evidence-led fix: windowed timeline rendering

Evidence: removing already-rendered timeline rows from the live DOM and forcing GC released
**~23 MB**; rendering all 500 loaded items instead of 120 cost **+27.7 MB** of working set.
Rendered rows, not stored text, are what costs memory.

Fix: `StudioPanel` renders the newest **120** items and offers
**"Show 120 earlier item(s)"** (D-0106). The shell still loads the newest 500 into state;
only the DOM is windowed, so nothing recorded becomes unreachable, and no data is dropped
from the database or the export.

Effect on the installed candidate with the P22 workload:

| | Before | After |
|---|---|---|
| Total working set, idle | 404 MB | **371.4–377.1 MB** |
| Renderer DOM nodes | 9,382 | 2,497 |
| Renderer JS heap | 5.8 MB | 3.4 MB |
| Rendered rows | 500 | 120 |
| Cold startup | 418 ms (P22, dev) | 427 ms (installed, final bytes) |
| Warm startup | 722 ms (P22, dev) | 732 ms (installed, final bytes) |
| Idle CPU | 0.04% | 0.01–0.04% |

**−27 to −33 MB, target still unmet: 371.4–377.1 MB against 350 MB (gap 21.4–27.1 MB).** The two installed runs bracket sampler variance; both are recorded, neither is cherry-picked. MONA-028 stays
partial; D-0104's target is unchanged.

### 2.5 Why the GPU process is large here — a machine fact, not a Mona defect

`app.getGPUFeatureStatus()` reports `gpu_compositing: disabled_software` and
`rasterization: disabled_software` on this host: there is no usable hardware GPU for Electron,
so Chromium falls back to software compositing and the "GPU" process grows. That is why the
GPU process shows `privateMb` (287.4) larger than its working set. On a machine with working
hardware acceleration this figure is expected to differ; it has not been measured here, and
this report does not extrapolate it.

### 2.6 Attempt ledger for the memory problem

Two attempts, both with material progress (see `.mona/build/attempts.jsonl`):

1. **Hypothesis:** the aggregate hides which process holds the memory.
   **Action:** per-process + JS-heap probe with forced GC, baseline reproduced.
   **Result:** 404 MB reproduced; JS heap is 3.4–5.8 MB, so the cost is rendered DOM and
   Chromium baseline. **Material progress: yes.**
2. **Hypothesis:** 500 rendered timeline rows account for tens of MB.
   **Action:** measured full-render cost (+27.7 MB), shipped windowed rendering at 120 rows.
   **Result:** 404 → 371.4–377.1 MB installed. **Material progress: yes.**

One attempt remains open before the three-attempt rule forces a stop. The next attempt is
named in §2.7 and needs no new authorization; it is not started here because it is not
evidence-led yet.

### 2.7 Proposed next action (not a fix claim)

1. Measure the same probe on a machine with **working GPU acceleration** to see whether the
   102 MB GPU process is host-specific (cheap: rerun `npm run memory` there).
2. Evaluate the network-service utility process: Mona's renderer is forbidden from opening a
   transport (`connect-src 'none'`), so its 51 MB deserves a check against a build that defers
   network-service start until the engine is actually contacted. Must not break the loopback
   engine client.
3. Only if 1 and 2 leave a gap: inspect Chromium flags and Electron's recommended baseline
   for a 4-process desktop app. Do not disable features at random to reach a number.

### 2.8 Profiling data handling

No heap snapshot was committed. The probe's own artifacts (`P23-memory*.json`,
`P23-memory*-log.txt`) contain counts and sizes only — no snapshot, no strings from user data,
and the workload was synthetic content generated by the probe. Had a `.heapsnapshot` been
needed it would have stayed in the temp directory and been deleted, as the harness does with
its throwaway profile and workspace.

---

## 3. Accessibility — automated checks done, listening still human

`npm run a11y` drives the real window; it passed **12/12** on both the development build and
the installed candidate (`P23-a11y.json`, `P23-a11y-installed.json`).

Observed, not assumed:

- Composer: `<textarea id="draft">` with the label "Prompt for &lt;project&gt;".
- Execution controls present by name; **Interrupt now is honestly disabled while idle**.
- Timeline is `role="log"` with `aria-live="polite"` — one region, so streamed tokens are not
  announced one by one as separate alerts.
- Dialog: opens from the keyboard with an accessible name, takes focus, **Tab from the last
  control stays inside**, Escape closes it and **focus returns to the control that opened it**.
- Windowed timeline: the "earlier items" control is keyboard reachable and reveals older rows
  (120 → 240) with Enter.
- Virtualized diff: the region is focusable, scrolls to its tail by keyboard, and keeps a
  bounded row count (28 rows of an 8,000-line diff).
- 200% zoom (supplemental, browser-level): no horizontal overflow, composer still laid out.
- `npm run shots`: 34 captures, 4 audits clean, 0 duplicate ids, 0 unnamed controls across both
  themes and densities.
- `npm run polish`: 40 steps, keyboard-only navigation, notification focus starts no work.

Not verified by any tool here: **Narrator's actual speech**, and **Windows display scaling at
200% on a physical display**. The checklist is `docs/evidence/P23-human-checklist.md`.

Conversation export through the real Save dialog is likewise human: the export path is
unit-tested against a real file write with a stubbed dialog, and cancelling writes nothing,
but no automated run has clicked the OS dialog.

---

## 4. Startup measurement — the ambiguity resolved

The P22 report called the timings "measured on this machine" while also stating the harness
used the development build. Both were true; the sentence was wrong. Recorded precisely:

| Run | Build | Cold | Warm | Harness |
|---|---|---|---|---|
| P22 (`P22-performance.json`) | **development** Electron, 60 s idle | 418 ms | 722 ms | `npm run qa` |
| P23 earlier (`P23-performance.json`) | **development**, 60 s | 1,093 ms | 741 ms | `npm run qa` |
| **P23 installed candidate** (`P23-startup-installed.json`) | **installed `Mona.exe`**, 60 s | **427 ms** | **732 ms** | `npm run qa` with `MONA_QA_EXE` |

So: cold and warm startup have now been measured **on the installed release candidate**
(427 ms / 732 ms, both inside the 5 s / 2 s budgets), and the earlier report's numbers came
from the development build. The installed run also completes — the P22 packaged-harness stall
(P22-ISSUE-003) did not reproduce, and its cause is unknown; this is reported as "did not
reproduce", not as "fixed".

Idle memory from that same harness run: 381.7 MB (its sampling includes the first warm sample;
the probe's 11-sample mean is the figure used for the budget comparison, 371.4–377.1 MB).

---

## 5. Status of the claims after this work

| Claim | State |
|---|---|
| Core usable release candidate 0.1.0 | **stands**, re-verified on the installed candidate |
| All 30 requirements verified | no — MONA-027 blocked, MONA-028 partial |
| Modern menu works locally | **not yet** — one elevated command short; nothing trusted by P23 |
| Memory budget met | **no** — 371.4–377.1 MB vs 350 MB, down from 404 MB |
| Narrator / physical 200% | **not verified** — human checklist prepared |
| Packaged startup measured | **yes** — 427 ms cold, 732 ms warm |
| License / public distribution | **unresolved by design**, Victor's decision |
| Upstream engine check | **unavailable** — `api.github.com` did not resolve; pinned evidence unchanged |
