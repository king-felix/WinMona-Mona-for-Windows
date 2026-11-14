# W22 — Explorer integration and trust, told exactly

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · installed candidate (W12 stage) · no provider
request, no turn, no purchase, no trust change was made in this pass.

Status: **engineering work complete; modern-menu visual placement remains a human check and
MONA-027 stays open for it.** Nothing here claims the Windows 11 menu was seen.

Evidence: `W22-shell-verb.json` (shell verb enumeration + invocation), `W22-trust.json`
(certificate, package, registry, event scan), `tools/spike/shell-verb.mjs` (the probe),
`P23-elevated-round.md` (the original `0x800B0109` round, unchanged).

## What was actually observed

**The shell offers the command, and invoking it launches Mona.** Through the shell's own verb table
(`Shell.Application` → `ParseName` → `Verbs()` → `DoIt()`), for a folder named
`Mona Shell Probe café 中文 c1dc1098`:

- the verb list contains `Start new DS project with Mona`;
- invoking it started
  `"…\Mona.exe" project open --path "…\Mona Shell Probe café 中文 c1dc1098" --profile ds-full-access`;
- the Unicode folder name survived as **one** argument in its own quotes (the raw JSON shows the
  console mojibake of the recording pipeline, not of the argument, which the process table holds).

This is the same command path the packaged verb and the classic verb share, exercised through the
shell rather than by guesswork.

**Classic registration is present and its removal is scoped.** `unregister` removed only the two
Mona keys (`Directory\shell\Mona.StartNewProject` and `Directory\Background\shell\…`); every other
shell key count was unchanged; `register` restored both and verified the exact command, icon,
`MonaOwned`, `NeverDefault` and `MultiSelectModel` values. A folder-background key exists alongside
the folder key.

**Trust state, and what it does and does not mean.** `Mona-0.1.0-x64.msix` verifies `Valid` with a
**self-signed** `CN=Mona Development` certificate (thumbprint `5C0AD0D7…C95`, expires 2027-11-12).
The package registers with `Status: Ok`, `SignatureKind: Developer`, and a `Publisher` equal to the
signature subject and to the manifest's `Publisher`. The certificate sits in
`LocalMachine\TrustedPeople` and `CurrentUser\TrustedPeople` (Windows mirrors machine trust into the
user view) and **not** in either `Root` store.

That is a local test-trust decision on this machine (D-0105). It is not production distribution and
it is not a recipient's trust.

**`0x800B0109` today: no event.** A scan of the two AppX deployment logs (last 500 events each)
found **zero** `0x800B0109` entries, consistent with the reported state: the failure occurred while
the signer was untrusted and stopped once the certificate was in `TrustedPeople`. The historical
round with the actual error text is `P23-elevated-round.md`; it is not re-derived here.

Developer Mode is **not** what fixes this, and nothing in this pass enables it or imports a root.

## The defect this pass actually found and fixed

`npm run native:test` was **red** on this machine: `activates through CoCreateInstance like a
packaged COM server` failed with `0x80040154 REGDB_E_CLASSNOTREG` against the helper after
registering its CLSID in `HKCU\Software\Classes\CLSID\…\InprocServer32`.

Investigation, in order:

1. Registered the helper's CLSID per user and re-ran → still `0x80040154`.
2. Confirmed `HKCR\CLSID\{6D2F1C9A-…}` resolves to that per-user key, so the write landed.
3. **Control experiment:** a different CLSID pointing at `scrrun.dll` in the same per-user location
   also fails to activate. So **this Windows install does not activate per-user CLSID
   registrations at all**; it is an environment property, not a Mona defect, and not evidence about
   the packaged menu (which Explorer activates in its own context, as `P23-elevated-round.md` §3
   already warned).

The test now: attempts activation, and when it gets `REGDB_E_CLASSNOTREG` it *proves the environment
limit with the control CLSID* before skipping with that reason. If per-user COM works, the test still
asserts the real activation. Two real cases were added in its place: a **junction alias** path
launches with the alias as the argument (no reparse resolution surprises), and a **missing
executable** fails `Invoke` promptly rather than hanging the shell (48 ms).

Result: `npm run native:test` → 8 pass, 1 skip (reason recorded), 0 fail.

## What is still not proven

- **The modern Windows 11 menu has not been seen.** Automated attempts to capture the shell's menu
  surface on this machine reached a `#32768` pane with no exposed children; UI Automation could not
  read menu items, so no screenshot or item list exists. It also could not be forced by bringing
  Explorer to the foreground (`SetForegroundWindow` was refused by the session's input policy on
  this desktop). **A human right-click on a folder and on a folder background, finding the item in
  the modern menu rather than under "Show more options", is still required.**
- **MONA-027 stays blocked** on exactly that observation. Classic-menu success does not close it.
- **Recipient trust is untouched.** Another machine needs its own decision about trusting the
  test certificate; nothing was published.

## Side effect, disclosed and repaired

While testing whether the package's own verbs were visible, the two classic menu keys were
temporarily deleted so any item found could only come from the package. They were re-registered from
`tools/launch/context-menu.mjs` and verified afterwards (values and scope above). No other registry
value was touched, and no Explorer restart was performed.
