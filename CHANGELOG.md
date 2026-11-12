# Changelog

Mona uses one line per user-visible change. Version numbers follow the product version in
`apps/desktop/package.json`.

## 0.1.0 — release candidate

First coherent Mona build. Everything below exists in the shipped artifact; where it does not,
the notes say so.

### Added

- **Shell** — Daybreak/Afterglow themes, comfortable/compact density, scale and reduced-motion
  handling, keyboard-first navigation (Alt+1…0 for sections, Ctrl+K palette), Focus Mode,
  per-project color and monogram, one inspector.
- **Projects** — catalog over local folders with branch and worktree awareness, pin, archive,
  rename label, relocate, reveal, per-project drafts and view state; removing an entry never
  deletes files.
- **Studio** — one engine thread per session and mode, streaming timeline from the engine's own
  events, explicit Plan/Work, observed permission posture, file references, prompt shelf,
  approvals and interrupts, diagnostics drawer.
- **Execution control** — pause after task, interrupt now, queue cancel, resume, bounded runtime
  restart, stop engine, quit and stop; submission journal with reconciliation and no replay of a
  possibly-executed call.
- **Work board** — tasks with dependencies, steps, acceptance criteria, evidence-gated
  completion and deterministic eligibility.
- **Blocker rules** — three consecutive no-progress attempts block a problem, propagate to
  dependants, and stay blocked across restarts until new evidence or a recorded decision.
- **Cost lens** — recorded usage with pricing sources, unknown labelled unknown, rate revisions,
  optional budgets with warn/stop, CSV export.
- **Changes** _(new in this release)_ — a hash comparison against a baseline you capture, real
  Git status and text diffs in a virtualized viewer, per-path attribution, skipped-path
  reporting, and recorded test receipts with output digests. "No baseline", "no changes",
  "non-Git" and "folder missing" are four different states.
- **Changes for a non-Git folder** stay honest: the change list works against a captured
  baseline, and a text diff reports that no textual baseline exists instead of showing an empty
  one.
- **Conversation export** _(new in this release)_ — the recorded timeline is written to a
  Markdown file you choose, with real timestamps, statuses and truncation labels; no model call.
- **Agents** — native goals, fleets, runs and child agents with parent/child graph, one owner
  per project and explicit spend boundaries.
- **Extensions** — MCP servers, skills, plugins, hooks and project instructions with
  provenance, health checks and revision-guarded enable/disable.
- **Memory** — local term search over recorded state, on-demand file search, versioned prompt
  shelf with packs, portable handoff/resume bundles, settings backup/restore, redacted
  diagnostics preview.
- **Capabilities** — explorer over 57 ledger rows joining documented support with the live
  engine's flags, including a native ConPTY terminal and read-only logs.
- **Windows integration** — per-user installer, atomic replacement, active-run deferral,
  uninstall with user-data preservation, classic Explorer menu, and a built/test-signed
  Windows 11 modern-menu identity package.
- **Release engineering** — staged payload with a 1,668-file checksum manifest, identity package
  with test signing, artifact checksums, and probes that produce evidence artifacts.

### Changed in the follow-up round

- **Timeline renders a bounded page.** The newest 120 loaded items render, with a keyboard
  reachable "Show 120 earlier item(s)" control; idle memory dropped from 404 MB to 371.4 MB on
  the installed candidate. Nothing is dropped from storage, export or search (D-0106).
- **Certificate trust is a checked action.** `trust-test-certificate` verifies the certificate,
  the package signer, the manifest Publisher and the build record before importing only into
  `LocalMachine\TrustedPeople`; the previous Root-store import was removed (D-0105).
- **Evidence paths are overridable** in the design-system probe, so a later prompt re-captures
  into its own artifacts instead of overwriting the prompt that first produced them.

### Fixed during the 0.1.0 build

- Double-encoded UTF-8 in `App.tsx` and one test string (PowerShell round trip), now guarded by
  a build check.
- Theme overwrite found by inspecting real captures.
- Nested maintenance-barrier deadlock on existing databases.
- `screenReaderMode` blocking terminal typing; exit state now comes from the PTY event.
- Silent view-persistence gap: the IPC allowlist accepted only five sections, so most screens
  were not restored after restart. All sections now share one list, with a test.
- Packaged argv stripping found by the installed launch probe.

### Changed in the elevation round

- **The trust gate was cleared with an elevated, verified import.** `trust-test-certificate`
  wrote the certificate thumbprint `5C0AD0D7…4C95` into `LocalMachine\TrustedPeople` after
  re-checking the certificate, the package signer, the manifest Publisher and the build record.
  `Add-AppxPackage` now accepts the MSIX and the identity package registers (`Status: Ok`).
- **Removal clears both TrustedPeople scopes.** `untrust-test-certificate` removes the exact
  thumbprint from the machine and per-user `TrustedPeople` stores (the per-user entry is Windows
  mirroring the machine entry) and never touches `Root`. Verified by a full remove/re-add round
  trip.
- **The identity package ships the menu DLL its manifest declares.** Staging and packing now
  refuse a package whose `com:Class` path is absent from the payload, so manifest and payload
  cannot diverge. This is hardening, not a proven fix: direct CLSID activation is not a valid
  test for packaged shell commands (a known-good third-party package fails it identically).
- **Memory re-measured on the final bytes:** 370.5 MB idle with the 20,000-row workload; the
  350 MB target is still unmet and nothing was relabelled.

### Known issues

- **Modern Windows 11 menu: registered, not yet seen.** The package registers and both verbs are
  declared for folders and folder backgrounds, but no human right-click capturing the entry in
  the Windows 11 menu has been recorded. Other machines still need the same trust decision.
- **Idle memory 370.5 MB** across four processes, against an internal 350 MB target. Recorded, not
  adjusted away.
- **Screen-reader walkthrough and physical 200% scaling** remain human-only checks.
- **Paint frame timing** was not measured (the measurement window was not presented).
- **Restore** covers HEAD only; there is no snapshot engine and no arbitrary-commit restore.
- **Engine terminal routes** are unavailable on Windows; Mona's own ConPTY terminal replaces
  them and is reported separately.
