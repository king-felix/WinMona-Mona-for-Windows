# P23 follow-up — the elevated trust step, package registration and what it does not prove

**Date:** 2026-11-12. **Machine:** Windows 11 Pro 10.0.26200, Ryzen 7 5800X, 32 GB, x64.
**Engine:** Codewhale `0.10.2 (ff466b2ed0bf)` (unchanged; no engine call was made).
**Shell:** elevated (`DESKTOP-RBG5MUC\victo`, `IsInRole(Administrator) = true`), which is the
one prerequisite every earlier round recorded as missing.
**Spend:** **0 µUSD**. No provider request, no turn, no adapter or context change.

This closes the machine-policy gate that kept ISSUE-0023 open. It does **not** close the human
checks, and it does not turn an unobserved right-click into an observed one.

---

## 1. Certificate trust — provisioned, verified, and removable again

`node tools/install/cli.mjs trust-test-certificate` was run in the elevated shell. It performs
the full D-0105 verification before it writes anything: certificate subject, thumbprint,
validity, code-signing EKU, absence of a private key, the package's own Authenticode signer, the
manifest Publisher read from inside the MSIX, and the build signing record.

```text
ok                    true
stage                 trust
added                 true          (nothing was trusted before)
thumbprint            5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95
store                 Cert:\LocalMachine\TrustedPeople
LocalMachine\Root     false         (untouched, by design)
```

Evidence: `docs/evidence/P23-trust-elevated.json`.

**Round trip, so removal is evidence and not a claim.** `untrust-test-certificate` was run
against the same binary, then the import was repeated:

- removal reported `removed: ["LocalMachine\\TrustedPeople"]`, all four checked stores `absent`,
  `rootUntouched: true` (`docs/evidence/P23-untrust-check.json`);
- the re-import reported `added: true` again, and the package registration survived it.

**A detail worth naming.** After the machine import, `CurrentUser\TrustedPeople` also reports the
certificate. That is Windows mirroring machine trust into this user's view, not a second
independent grant: it appears in the same step as the machine entry and disappears in the same
step as it. `removeTrust` was therefore widened to clear the exact thumbprint from **both**
`TrustedPeople` stores (never `Root`), and the removal above confirms both go absent together.

## 2. The identity package now registers

With trust present, `install --force` registered the sparse package instead of refusing it:

```text
packageFullName   MonaWorkbench_0.1.0.0_x64__beqf7zj0yys3p
Status            Ok
SignatureKind     Developer
Publisher         CN=Mona Development
installLocation   C:\Program Files\WindowsApps\MonaWorkbench_0.1.0.0_x64__beqf7zj0yys3p
```

Evidence: `docs/evidence/P23-install-after-trust.json` (first successful registration against
the pre-guard package), `P23-package-final.json` / `P23-install-final.json` (the committed
source: 1,673 files, `verify` ok, package `Ok`), `P23-package-fixed.json` /
`P23-install-menu-fixed.json` (the intermediate build that first carried the DLL), and
`P23-qa-installed-2.json` / `P23-a11y-installed-2.json` / `P23-memory-installed-2.json` for the
installed-build probes. The payload ships `installer.mjs`, so comment-only source edits were
rebuilt and reinstalled rather than leaving the artifact behind the commit.

The same install verified 1,673 files with 0 checksum problems, the Mona-only registry keys, the
classic folder-menu registration, the three node-pty binaries, and the package status above.
`signtool verify` now reports a trusted chain — because this machine now trusts the test
certificate, which is exactly the scope D-0105 limits it to.

The Windows deployment log for the failed attempt (`0x800B0109`) and for the successful ones
contains no COM warning at any level.

The manifest inside the installed package declares both verbs:

```text
desktop5:ItemType Directory           -> Verb MonaStartNewProject           Clsid 6D2F1C9A-…-1F8E5B0D7C42
desktop5:ItemType Directory\Background -> Verb MonaStartNewProjectBackground Clsid 6D2F1C9A-…-1F8E5B0D7C42
```

## 3. A probe that proves nothing — recorded so it is not repeated

An attempt was made to verify the registered command by activating its CLSID directly
(`CoCreateInstance` → `IExplorerCommand`). It failed:

```text
Mona  {6D2F1C9A-…}  -> 0x80040154 REGDB_E_CLASSNOTREG
```

**That result is not evidence about Mona.** The same call against Notepad++'s packaged shell
command (`E6950302-61F0-4FEB-97DB-855E30D4A991`, a shipped sparse-package integration with the
same `com:SurrogateServer` shape) fails identically on this machine. Plain `CoCreateInstance`
does not activate shell commands declared inside a package; the shell does that in its own
context. Two consequences:

- no menu claim may rest on CLSID activation, in either direction;
- a "fix" was attempted on the strength of that failure and is **not** justified by it.

## 4. What actually changed in the packaging, and on what grounds

`buildStage` now places the built `MonaMenu.dll` inside the identity payload next to the
manifest that declares it, and `missingComServerPayloads` refuses to stage or pack a package
whose manifest names a COM server the payload does not contain.

The honest rationale, since §3 removed the original one: the manifest declares the server by a
package-relative path (`Path="MonaMenu.dll"`). Shipping that file with the manifest means the
package does not depend on external-location resolution for a file it names itself. Notepad++'s
package relies on external resolution and works in the wild, so this is a **hardening, not a
demonstrated fix**; nothing here says the previous package could not have worked. What it does
buy is a build-time invariant: manifest and payload cannot silently diverge.

Cost: one extra 239,104-byte copy inside the package (payload 1,672 → 1,673 files).

## 5. Installed-build probes, re-run on these bytes

| Probe | Result |
|---|---|
| `install --force` | ok; 1,673 files, 0 checksum problems, registry ok, classic menu verified, PTY present, package `Ok` |
| `install verify` | `checks.ok: true` |
| `npm run a11y` (installed) | **12/12** steps (`P23-a11y-installed-2.json`) |
| `npm run memory` (installed, 20,000 rows) | idle **370.5 MB** total, average 382.5 MB, 11 samples, CPU 0.01%; renderer heap 3.3 MB / 2,497 DOM nodes; windowed 120 → 500 rows at 4 clicks cost **+28.5 MB** |
| `npm run qa` (installed) | ok; cold start **421 ms**, warm **722 ms** (budgets 5 s / 2 s) |
| Tests | 26 install tests pass, including the new payload guard |

Those probes ran against the same program binaries that ship now: `Mona.exe` in the installed
tree is sha256 `207853646fd0553430706aee4d2ef1fac8a492cc32001dcec739598c89d8a492`, identical to
the build the probes exercised. The final rebuild changed only the copied `installer.mjs`
comments and therefore the payload manifest, not the app.

The 350 MB memory target is **still unmet** (370.5 MB). Nothing was relabelled.

One probe run is discarded rather than quoted: the first memory pass was launched without
`MONA_MEMORY_HISTORY`, so it measured an empty timeline (351.5 MB, 305 DOM nodes) and correctly
failed its own render-window step. That number is not comparable to P22's workload and is not
used anywhere.

## 6. What is still not proven

- **The menu entry has not been seen.** `Get-AppxPackage` status, the manifest verbs and the
  registration the shell reads are all in place; no screenshot or UI Automation capture of the
  Windows 11 context menu exists. A right-click on a folder and on a folder background, with the
  item found in the modern menu rather than under **Show more options**, remains a human check
  (`P23-human-checklist.md`).
- **A click has not been exercised end to end.** The command's launch path (`HKCU\Software\Mona\
  Install\MonaExe` with the recorded argv) is verified from the classic menu and by the P21
  native probe, not by a modern-menu click.
- Narrator walkthrough, physical 200% scaling, and the real Save dialog for conversation export
  remain human-only.
- Distribution to other machines still requires a certificate those machines trust; this round
  trusts the test certificate on **this** machine only.
