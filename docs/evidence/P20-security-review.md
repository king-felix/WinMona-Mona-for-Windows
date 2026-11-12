# P20 — security boundary review

**Scope:** the assembled product at P19: Electron shell, preload bridge, main
services, local persistence, engine transport, terminal, imports and generated
content. This is an engineering review of concrete code and tests, not a formal
security certification or penetration test.

## Trust boundaries

```text
untrusted content (model output, repository files, imported packs/bundles)
        |
        v
renderer (sandboxed, contextIsolation, no Node, CSP connect-src 'none')
        |  frozen 71-method bridge; 67 handled invoke channels + 4 push-only
        v
preload (named methods only, no generic invoke, no fs/shell/net)
        |
        v
main (sender/frame check -> zod payload validation -> service)
        |            |                    |
        v            v                    v
SQLite state    engine HTTP        terminal ConPTY
(one barrier)   (loopback + token) (fixed command, no IPC bridge)
```

## Audit results

| Boundary | Mechanism | Evidence | Residual risk |
|---|---|---|---|
| IPC sender | Every module checks the sender before payload validation. | **New** `ipc-audit.test.ts` wires all 12 IPC modules with an untrusted sender and asserts all 67 handled channels answer `untrusted_sender`; per-module tests too. | A future channel added outside the shared `register` helper would escape the pattern; the audit test fails if it does not answer `untrusted_sender`, so the gap is visible. |
| IPC payload | Strict zod schemas per channel, bounded strings/arrays; no arbitrary object forwarding. | Module IPC tests; `ipc-audit.test.ts`; invalid-payload cases. | A schema can be too permissive; review is per channel. |
| Renderer isolation | `contextIsolation`, `sandbox`, no Node integration, frozen preload, CSP with `connect-src 'none'`, navigation/popup refusal. | `security.test.ts`; `check:build` (CSP replaced, no remote origins, no network transports, no `/v1/` routes); live smoke (navigation and popup refused, one frozen bridge). | Renderer compromise is still a risk; the bridge is the blast radius and remains named and narrow. |
| Renderer globals | No `require`, `process`, `exec`, `spawn`, `shell`, or `ipcRenderer` in built renderer; terminal renderer tested separately. | `check:build`, terminal tests/probe, App tests. | Third-party UI dependencies could add a global; the bundle check is static, not a runtime guarantee for every future dependency. |
| Runtime auth / loopback | Token generated per owned runtime, kept out of argv and renderer; requests authenticate; bind verified loopback; external attach read-only. | `http.test.ts` (401 mapped, token not leaked); `supervisor.test.ts` ownership/identity; P03/P04 live evidence. | A stolen token would grant runtime API access to a local process; scope is loopback only. |
| Secret storage | Codewhale owns credentials; Mona never reads or echoes them. Local logs, diagnostics, settings backups and handoffs redact credential-shaped values and home paths. | Provider workbench tests; P19 redaction fixtures; `check:build` secret patterns; `cli.mjs validate` secret scan. | Redaction is pattern-based; an unusual secret format could pass. Callers avoid collecting secrets. |
| Settings / restore | Digest and schema verification; credential keys redacted; restore under exclusive maintenance; appends versions. | `settings.test.ts`; `state.test.ts` barrier test; P20 interrupted-restore test. | A redacted backup cannot restore the secret value; re-entry is required. |
| Content safety | Markdown escapes raw HTML and renders links as inert text; no anchors; terminal has no link handler; OSC 52 is consumed and ignored. | `markdown.test.tsx`; `terminal-host.test.ts` / terminal probe; `check:build`. | Copying model output is user-initiated and may contain unsafe text; it is never executed. |
| File links / paths | Evidence paths must be project-relative; drive-absolute and traversal paths are refused; bundle members validated at parse, import and extraction; extraction uses exclusive-create. | **New** P20 evidence-path test; P19 handoff tests (traversal, device names, digest); `assertSafeRelativePath`. | Windows short names/8.3 and reparse points are covered partially by canonicalization and junction tests, not exhaustively. |
| Project identity | Canonical path + filesystem identity detect aliases; junctions resolve to the same project; a moved folder requires a deliberate rebind. | `catalog.test.ts`, `store.test.ts`, `launch-target.test.ts` (real junction), **new** suspicious-name test. | A filesystem identity change after a restore/format may require manual rebinding; reported, not guessed. |
| Terminal | Fixed `powershell.exe` argv, no renderer shell globals, six narrow channels, bounded scrollback/input, project binding enforced, environment tokens stripped. | `terminal-host.test.ts`, `terminal-ipc.test.ts`, live 18-check probe (P18). | A local shell is inherently powerful; it is user-driven and cannot be reached from model output. |
| Imports | Prompt packs are inert text with a digest; handoffs validate shape/digest/paths and never execute; import requires a folder; no auto-extraction. | P19 tests and probe; **new** P20 path test. | A handoff can carry malicious *text*; it is shown as text and never executed. |
| Generated-app previews | No preview feature exists; no privileged preview origin, bridge or localhost permission was introduced. | Absence verified by route/feature inventory; stated in the matrix. | A future preview feature must be isolated from the Mona origin before it ships. |
| IPC surface shape | 71 named preload methods; no generic invoke; event channels are push-only; check-build rejects an unexpected channel. | `check-build.mjs`, preload tests, IPC audit. | Channel count is enforced by a checked-in list; adding one requires updating the list deliberately. |
| Storage | Single write path, maintenance barrier, foreign keys, migrations with checksums, verified backups, atomic restore staging. | `store.test.ts`, `state.test.ts`, `migrations.test.ts`, `p20-recovery.test.ts`. | Disk-level failure and OS sleep are not simulated (P20-ISSUE-002/003). |

## Findings

- No release-blocking security defect was found.
- Two boundary defects were found and repaired during failure injection:
  **P20-FIX-001** (non-atomic restore replacement) and **P20-FIX-002** (SQLite
  handle leak on a failed open). Both have regression tests.
- Residual issues are recorded in `docs/evidence/P20-failure-matrix.md`:
  main-process hard kill, database-level disk full, and OS sleep/resume.

## Out of scope / not claimed

- No formal certification, no third-party audit, no exhaustive fuzzing.
- No claim that every future dependency or channel will remain safe; the
  checked-in channel list and the IPC audit are the mechanism that makes a
  change visible.
- No claim that pattern redaction catches every possible secret.
