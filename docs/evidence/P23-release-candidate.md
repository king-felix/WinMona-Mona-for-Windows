# P23 — release candidate and final handoff

**Status:** completed. The candidate exists, is documented, installs cleanly from an empty
root, and its requirement matrix is honest. Mona 1.0 complete is **not** claimed.

**Date:** 2026-11-12. **Machine:** Windows 11 Pro 10.0.26200, Ryzen 7 5800X, 32 GB, x64.
**Engine:** Codewhale `0.10.2 (ff466b2ed0bf)`.

## Gate

| Check | Result |
|---|---|
| `npm run ci` | exit 0 — Prettier, ESLint, typecheck (5 workspaces), 546 Vitest in 66 files, 14 bootstrap, 12 launch, 14 install, 8 spike, production build |
| `npm run native:test` | 7/7 |
| `node tools/build/cli.mjs validate` | OK |
| `node tools/build/cli.mjs stage` | 1,668 files, 452,401,443 bytes |
| `package --test-sign` | MSIX packed and test-signed; `signtool verify` reports an untrusted root, as recorded |
| clean-root `install --smoke` | ok; 1,668 files, checksums verified, PTY present, classic menu verified, app smoke ok at 0.1.0 |
| clean-root `verify --smoke` | all checks pass |
| clean-root `uninstall` | program tree and Mona keys removed; `~/.codewhale` untouched |
| `npm run changes` (real Electron) | 20/20 steps, 5 screenshots, 0 provider requests |
| `npm run qa` | cold 1,093 ms, warm 741 ms, idle CPU 0.04%, idle memory 406.4 MB, engine 256.4 MB separate |

Logs and artifacts: `P23-gate-ci.txt`, `P23-changes.json`, `P23-changes-log.txt`,
`shots-p23/`, `P23-performance.json`, `P23-performance-log.txt`, `P23-package.json`,
`P23-clean-install.json`, `P23-clean-verify.json`, `P23-clean-uninstall.json`,
`P23-install-restored.json`.

## The two Core criteria this prompt closed

Both were named in the ledger as P23 work and were the only open Foundation/Core items.

**MONA-014 `diffs` — virtualized diff from real workspace state.**
New `ChangesService` + `ChangesPanel` + three validated IPC channels, plus
`packages/ui/src/virtual.ts` and `VirtualList`. Proven in real Electron against a real Git
workspace: change list against a captured baseline, `-one`/`+one changed` from Git's own diff,
an 8,007-line diff rendered as **29 DOM rows** whose tail is reachable by scrolling, and a
`../../outside.txt` request refused by the main process. Unit tests cover the four distinct
states (no baseline, empty list, non-Git diff, missing folder), path traversal, and line
counting. Evidence: `P23-changes.json`, `shots-p23/`, `changes-service.test.ts`,
`changes-ipc.test.ts`, `ChangesPanel.test.tsx`, `virtual.test.ts`.

**MONA-007 `copy-export` — copy and export preserve real content.**
`exportConversation` renders the stored timeline to Markdown and writes it through a temp file
plus rename to a path the user picks; `fenceFor` outruns any backtick run inside machine output
so a tool body cannot close its own fence. Tests use a real SQLite store and a real file write:
content, thread facts, truncation labels, cancellation (nothing written), and refusal of an
empty session. Copy of single items already shipped. **Not automated:** the OS save dialog
itself; a human click on it is unverified and that is stated in the release notes.

## Documentation delivered

`README.md`, `docs/user-guide.md`, `docs/developer-guide.md`, `docs/compatibility.md`,
`docs/release-notes-0.1.0.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md`,
`SECURITY.md`. License: none chosen; that is Victor's decision before any public release, and
the README says so instead of inventing one.

## Upstream maintenance reassessment

`codewhale --version` on this machine still reports `0.10.2 (ff466b2ed0bf)`, so the pinned
build is unchanged and the adapter's qualification stands. A check against the upstream
repository could not run: `api.github.com` did not resolve from this machine during P23.
No upstream change is claimed or assumed. The maintenance case is therefore unchanged: Mona
owns no engine logic, so a new engine build needs requalification (compatibility policy), not a
merge of engine code.

## Requirement matrix outcome

- Foundation + Core: **all verified** (MONA-001…017, MONA-029, MONA-030 among them). This is a
  **Core usable** release.
- MONA-027 **blocked**: modern Windows 11 menu needs a machine trust decision (ISSUE-0023).
- MONA-028 **partial**: idle memory 406.4 MB vs the 350 MB target (P23-ISSUE-001), screen-reader
  and physical-scaling checks are human-only (P22-ISSUE-004), packaged startup timing and engine
  memory under load remain unmeasured (P22-ISSUE-003/005).
- 1.0 complete is therefore not available. No gap was relabelled as an enhancement.

## Issues opened by this prompt

- **P23-ISSUE-001** — idle memory 406.4 MB; target unchanged, profiling scheduled post-0.1.0
  (D-0104).
- **P23-ISSUE-002** — modern-menu registration still refused (`0x800B0109`); carried blocker
  ISSUE-0023, unchanged by this prompt.
- **P23-ISSUE-003** — the conversation export's save dialog is not automated; unit-tested with a
  real file write and a fake dialog only.
