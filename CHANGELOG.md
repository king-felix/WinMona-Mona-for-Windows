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

### Fixed during the 0.1.0 build

- Double-encoded UTF-8 in `App.tsx` and one test string (PowerShell round trip), now guarded by
  a build check.
- Theme overwrite found by inspecting real captures.
- Nested maintenance-barrier deadlock on existing databases.
- `screenReaderMode` blocking terminal typing; exit state now comes from the PTY event.
- Silent view-persistence gap: the IPC allowlist accepted only five sections, so most screens
  were not restored after restart. All sections now share one list, with a test.
- Packaged argv stripping found by the installed launch probe.

### Known issues

- **Modern Windows 11 menu is blocked on machine policy.** The identity package is built and
  test-signed; Windows refuses registration without developer mode or a trusted certificate
  (`0x800B0109`). The classic menu works.
- **Idle memory 404 MB** across four processes, against an internal 350 MB target. Recorded, not
  adjusted away.
- **Screen-reader walkthrough and physical 200% scaling** remain human-only checks.
- **Paint frame timing** was not measured (the measurement window was not presented).
- **Restore** covers HEAD only; there is no snapshot engine and no arbitrary-commit restore.
- **Engine terminal routes** are unavailable on Windows; Mona's own ConPTY terminal replaces
  them and is reported separately.
