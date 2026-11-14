# W23 — One installable file a recipient can actually use

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 (x64) · installed candidate from the W12/W13/W19/W20/W22
change set.

Status: **the recipient path exists and is exercised on its real bytes.** The modern Explorer menu still
needs a certificate trust decision on the target machine, and that gate is reported by the installer
instead of being hidden.

Evidence: `W23-installer.json` (artifact hash, payload contents, installed state, lifecycle results),
`W23-setup-receipt.json` (build receipt: stub + payload hashes), this note.
Build tooling: `native/setup/setup-stub.c`, `tools/install/make-setup.mjs`.

## The file

```text
%LOCALAPPDATA%\Mona\artifacts\Mona-Setup-0.1.0-x64.exe
  179,309,695 bytes   sha256 9abd2b9a2183…
```

It is unsigned. A signing decision is a separate, explicit release gate; nothing here calls it trusted
or "friend-ready". It is the only file a recipient needs for the program itself.

How it works: the file is a small native stub with the staged payload (a ZIP) appended, followed by a
32-byte trailer the stub validates (magic, payload offset/length, `offset + length + 32 == file size`).
On run it copies the payload to `%TEMP%\mona-setup-<pid>`, unpacks it with Windows' own `tar.exe`, and
runs the product's installer — **without Node, a compiler or a source checkout** — by starting the
shipped `Mona.exe` in Electron's Node mode and executing `installer\cli.mjs install --stage …`. The
temporary payload is removed afterwards. `--quiet` and `--json <path>` exist for tests; a plain double
click pauses at the end so the result stays readable.

## What a recipient gets

- Per-user install to `%LOCALAPPDATA%\Programs\Mona` (no elevation, no machine-wide keys).
- 1,745 files verified against the payload's own `checksums.json` (0 problems).
- Registry values for the install path, the executable and the uninstaller; an "Apps & features" entry
  with `DisplayIcon` and `UninstallString`.
- A **Start menu shortcut** (`Mona.lnk`) pointing at the installed executable, so Start works even
  while the packaged identity is deferred.
- Classic Explorer menu for folders and folder backgrounds, verified (label, icon, `MonaOwned`,
  `NeverDefault`, `MultiSelectModel`, command).
- `MonaMenu.dll`, the node-pty prebuilt binaries, `LICENSE`, `LICENSES.chromium.html` and
  `THIRD_PARTY_NOTICES.md` (all three notices are inside the file).
- No `.env`, key, certificate, transcript or database file in the payload — a scan for secret-like
  names found **none**. The recipient supplies their own credentials; the existing Codewhale
  configuration and the recipient's project data are untouched.
- Network: an explicit, single internet step exists only if the certificate trust decision is taken
  later; installation itself needs no download.

## Lifecycle actually exercised (on these bytes)

- **Fresh install** from the setup file: exit 0, 1,745 files, classic menu verified, Start shortcut
  created, installed `Mona.exe` hash identical to the staged one.
- **Upgrade over the same version**: exit 0; the previous tree is preserved as
  `…\Programs\Mona.old-<stamp>` and the replacement proceeds (`decision: proceed`).
- **Uninstall from the installed copy** (`uninstall.cmd --force`): install root removed, Start shortcut
  removed, both registry keys removed and the uninstall entry removed; the user's project data
  (`%APPDATA%\@mona\desktop`) and `~/.codewhale` remain. `codewhaleUntouched: true`.
- **Reinstall** to leave the machine in the recipient-ready state.

## Three real defects this qualification found and fixed

1. **The packaged installer could not load its icon tool.** `installer.mjs` statically imported
   `../assets/embed-exe-icon.mjs`, which only exists in the repository layout; from a staged payload it
   pointed at a missing file and the whole install failed. It is now resolved at call time, and the tool
   travels with the payload (`installer/assets/embed-exe-icon.mjs`).
2. **Electron's asar layer rewrote the error, and the installer crashed on a missing path.** Running the
   installer through `Mona.exe` in Node mode turned a normal "file not found" into
   `ENOENT, not found in …resources\default_app.asar`, which named nothing. `cli.mjs` now sets
   `process.noAsar = true` when `process.versions.electron` is present: an installer deals with real
   files only.
3. **Uninstall from the installed copy left the program behind.** The deferred cleanup batch used
   `timeout /t 12`, which fails without a console (`Input redirection is not supported`), so the
   `rmdir` never ran. It now waits with `ping -n 13 127.0.0.1`, and the uninstall above removes the
   install root within the deferred window.

Two further payload gaps were closed: the installer reported version `0.0.0-uninstalled` because it
looked for the app manifest one directory above the payload (`defaultRepoRoot` now detects a payload
root), and the signed identity package now travels inside the payload so the modern menu can register
from the setup file alone.

## The one open gate, stated plainly

The identity package does **not** register on this machine right now:

```text
0x80073CF0 Package could not be opened
  error 0x800B0109: The root certificate of the signature in the app package or bundle must be trusted.
```

This is the documented failure (W22), reproduced today with the *current* bytes, and the cause is
concrete: the uninstaller removes the test certificate it created (`removeOwnedTestCertificate`), so
trust is gone. Consequence: everything except the packaged modern-menu verb installs; the classic menu
and the Start shortcut still work. The remedy is one elevated, already-specified step:

```text
node tools/install/cli.mjs trust-test-certificate
```

then run the setup file again. That is a trust decision for the machine, not an engineering gap, and it
was not taken here.

## Not claimed

- The file is **not signed** and installing it may show SmartScreen reputation warnings. A recipient
  package for strangers needs a signing identity that does not exist yet.
- "Genuinely clean Windows" was not available: trust stores, developer tooling and prior installs exist
  on this machine. The uninstall/reinstall cycle and the empty-artifacts case were exercised, and the
  deferred-removal path was proven, but that is a clean *destination folder and user state*, not a clean
  OS image.
- No repair operation is offered; Windows lists the entry with `NoModify`/`NoRepair`, and "run the setup
  file again" is the replacement path that was tested.
- Locked-file and disk-full behaviour beyond the existing checksum verification was not injected here;
  the installer's own checksum and placement guards are the `tests/install` suite (29 tests, passing).
