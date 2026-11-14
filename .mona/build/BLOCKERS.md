# Mona build blockers

No blocker is open. This file records blockers that stop a problem after three
consecutive no-progress attempts, plus the human input required to clear them.
Acknowledging a blocker never resets its counter or clears the row.

## Open

### MONA-028 — two human-only checks and one measured memory miss

This is not a three-attempt blocker; it is recorded here because it needs Victor.

- **Memory:** 404 MB at the start of P23, **370.5 MB** on the installed candidate on the
  current bytes (range 370.5 to 377.1 MB across runs). **Accepted by Victor on 2026-11-12**
  (D-0111): the 350 MB target is unchanged and still unmet, no release text claims it is met,
  and the next evidence-led step stays unauthorized. Two rows remain in `attempts.jsonl`; the
  third slot is unused because an explicit decision closed the item, not a fix.
- **Screen reader:** a Narrator walkthrough is human-only (P22-ISSUE-004). The
  automated half is done and recorded: `P23-a11y-installed-2.json`, 12/12 steps on the current
  bytes.
- **Physical 200% scaling:** the harness captures 200% zoom, which is not the
  same test as a real display at 200%. The automated zoom check passed; the
  physical-display check is still owed.

## Prerequisites that are not blockers yet

| Item | Needed by | State | What clears it |
|---|---|---|---|
| Verifiable DeepSeek route | P01 (G0/G1) | **verified** at P01: `doctor --probe-api` passed; model resolved to `deepseek-flash`; live turns priced | nothing; re-probe only if the key is rotated |
| Native build toolchain | P05+ if a native binary is needed | no MSVC Build Tools; Electron and esbuild prebuilts supply everything used so far | a verified prebuilt for the specific native module, or installing VS Build Tools |
| Code-signing certificate | P21/P23 release packaging | **No production certificate.** A labelled self-created test certificate exists at `%LOCALAPPDATA%\Mona\signing\test-signing.pfx`; the package is test-signed and reported as such | Victor provides a certificate whose subject matches `CN=Mona Development`, or changes the manifest publisher; sign with `MONA_SIGN_PFX` / `MONA_SIGN_PASSWORD` |
| Windows 11 modern context-menu qualification | P21 | **Registered.** Machine trust was provisioned by the verified elevated import; `MonaWorkbench_0.1.0.0_x64__beqf7zj0yys3p` reports `Status: Ok`, both verbs are declared for `Directory` and `Directory\Background`, and the packaged payload contains the declared `MonaMenu.dll` | a human right-click on a folder and on a folder background confirming the entry in the Windows 11 menu |
| Human click on the classic menu | P21/P22 acceptance | registered live at P09 and re-registered by the P21 installer against the installed `Mona.exe`; exercised through the exact registered argv, not by a hand click | a right-click on a folder and on a folder background, choosing **Start new DS project with Mona** (possibly under **Show more options**) |
| Human click on the modern menu | P21/P22 acceptance | package registered and the menu is now offered; no human has confirmed seeing or clicking the entry | right-click a folder and a folder background and confirm **Start new DS project with Mona** in the Windows 11 menu; record the result in `P23-human-checklist.md` |
| Live approval observation | W06, W08 | Not observed. The engine settings record `permission_posture = "full-access"`, and the binary documents that `auto_approve`, `trust_mode` and `allow_shell` are capped by that saved policy, so a thread created in posture `ask` still ran a bash tool call with no `approval.required` event. The reply routes themselves are qualified live (`W08-reply.json`, typed 404s from their own handlers), and the durable record/reply/acknowledgement path is covered by fixtures | switch Mona's saved permission posture to **ask** in Provider settings for one bounded turn, then run `node tools/spike/approval-roundtrip.mjs` (it should observe `approval.required`, accept `allow`, and see `approval.decided`); afterwards repeat `npm run focus:live`-style Focus/fullscreen transitions across that pending card to close W06 |
| Narrator walkthrough | P22/P23 acceptance | not performed; no automated claim is made | with Narrator on, open Mona, tab Home -> Studio -> composer, send nothing, confirm every control announces a name and state |
| 200% scaling on a physical display | P22/P23 acceptance | automated 200% zoom captured; physical display not tested | set Windows scaling to 200% and confirm the composer and control strip stay reachable without horizontal scrolling |
| W06 answering-input variant | W06 acceptance | Focus/fullscreen/typing/scrolled-back/open-drawer transitions are now observed during one bounded live streaming turn (21 steps, `W06-focus-live.json`). The remaining variant needs a real pending approval on screen, which no turn on this machine produces | same prerequisite as the live approval observation above |
| Release candidate decision | 0.1.0 handoff | candidate rebuilt after the packaging guard (`Mona-0.1.0-x64.msix` sha256 `5a7a6455…44ee`), installed, verified and documented; not published | accept the candidate as 0.1.0, or schedule the memory profile and the human checks first |

## Resolved

### ISSUE-0023 — machine-policy gate, resolved 2026-11-12 in an elevated shell

- **What it was:** Windows refused the test-signed identity package (`0x800B0109`) because no
  store on this machine trusted the signing certificate. Not a code defect; three attempts were
  recorded before it was narrowed to one elevated command.
- **Resolved by:** Victor's recorded authorization plus an elevated shell. The verified
  `trust-test-certificate` step re-checked the certificate, the package signer, the manifest
  Publisher and the build record, then imported thumbprint `5C0AD0D7…4C95` into
  `LocalMachine\TrustedPeople` only. `install --force` then registered
  `MonaWorkbench_0.1.0.0_x64__beqf7zj0yys3p` with `Status: Ok`, and the identity package now
  contains the `MonaMenu.dll` its manifest declares.
- **Round trip:** `untrust-test-certificate` removed the thumbprint from both `TrustedPeople`
  stores (the machine entry and the per-user mirror), left `Root` untouched, and the import was
  repeated successfully.
- **Still owed:** a human right-click on a folder and on a folder background confirming the entry
  in the Windows 11 menu rather than under **Show more options**. Registration is proven;
  appearance is not. This also covers the same human check for the classic entry.
- **Requirement:** MONA-027's `modern-menu` criterion stays unverified until that click is
  recorded. Other machines still need their own trust decision.
- **Proof:** `docs/evidence/P23-elevated-round.md`, `P23-trust-elevated.json`,
  `P23-untrust-check.json`, `P23-install-after-trust.json`, `P23-install-menu-fixed.json`.

### ISSUE-0018 — Windows terminal, resolved 2026-11-12 by authorizing a native PTY

- **Original problem:** the pinned engine reports `terminal_stream/input/resize/
  kill` as false and `/v1/terminal/{name}/output` returns HTTP 501 (“terminal
  sessions are Unix-only in this build”). MONA-023/terminal could not be met by
  the engine on Windows.
- **Victor's decision:** authorize a native Windows PTY path rather than accept
  terminal as unavailable for 1.0.
- **Resolution:** Mona now owns a ConPTY terminal (`node-pty@1.1.0` shipped N-API
  prebuild + xterm.js) in a bottom drawer. The package install script is denied;
  no compiler was installed. Verified with 18 live checks in real Electron:
  typing, output, resize, search, clipboard write read back from the OS, drawer
  reconnect, and exit.
- **Still true:** the engine's own terminal route remains unavailable and is
  reported as `unavailable-on-platform` (CAP-0053). No engine claim was
  upgraded.
- **Proof:** `docs/evidence/P18-terminal.md`, `docs/evidence/P18-terminal.json`.
- **Follow-ups:** ISSUE-0019 (screen-reader pass), ISSUE-0020 (node-pty console
  helper logs on forced kill), ISSUE-0021 (pointer drag selection needs a human
  check), and node-pty unpacking in the P21 installer.

### P02-ELECTRON-BINARY — resolved 2026-11-12 by transient-DNS recovery

- **Original problem:** `electron@45.3.0` postinstall could not download
  `electron-v45.3.0-win32-x64.zip`; `github.com`,
  `objects.githubusercontent.com`, and three mirrors returned `ENOTFOUND` while
  `registry.npmjs.org` resolved.
- **What it actually was:** a transient failure of the local resolver at
  `192.168.1.1`, not a policy block. Re-checked with `Resolve-DnsName`: all four
  names resolved normally, `Invoke-WebRequest` reached `github.com`,
  `api.github.com`, and the release asset (`SHASUMS256.txt`, HTTP 200).
- **Resolution:** `node node_modules/electron/install.js` installed Electron
  45.3.0. No firewall, proxy, hosts-file, DNS, or registry setting was changed;
  the only new artifact is `node_modules/electron/dist`.
- **Counter:** the three no-progress attempts stay in `attempts.jsonl` with a
  closing row that records the prerequisite as obtained. The counter is closed
  by evidence, not reset.
- **Proof:** `docs/evidence/P02-smoke.json` / `P02-smoke-log.txt`.
- **If it recurs:** re-run resolution for `github.com` and
  `objects.githubusercontent.com`; if they still fail, use one of the three
  remedies retained in `docs/evidence/P02-electron-blocker.txt`.

