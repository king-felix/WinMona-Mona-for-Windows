# Mona build handoff

**Current prompt:** P21 — Deliver the modern Windows menu and installation lifecycle
**Current status:** P00–P20 completed. State revision 65; ledger revision 300.
Next eligible: P21.

`last_verified_commit` stays null because a state file cannot contain the hash of
the commit that contains it. Verify with `node tools/build/cli.mjs validate`
(expect OK, r65, 0 warnings) before trusting this file.

## P20 result — failure injection and security boundary review

- **Failure matrix** at `docs/evidence/P20-failure-matrix.md`: 22 scenarios,
  each with a passing test/probe or a named residual issue. Covered: renderer
  crash (live lifecycle probe), runtime crash, lost stream, lost submission
  response, duplicate/out-of-order events, disk full (artifact level), stale
  revision, corrupted metadata, failed migration, missing artifact, revoked
  credentials (simulated 401), occupied port, interrupted restore, suspicious
  folder names, path canonicalization, imports, Markdown/file/terminal links,
  maintenance writes and owned-process shutdown.
- **P20-FIX-001:** restore now copies the backup to a staged file beside the live
  database, verifies it, removes live sidecars only after verification, and
  atomically renames. Failure at `afterPark`, `afterCopy` or `beforeReplace`
  leaves the live database intact and usable; no staged file remains.
- **P20-FIX-002:** a failed database open closes its SQLite handle and rethrows;
  a corrupt file is preserved byte-for-byte and can be moved for inspection.
- **IPC audit:** `ipc-audit.test.ts` wires all 12 IPC modules with an untrusted
  sender and proves all 67 handled channels answer `untrusted_sender`.
- **Security review** at `docs/evidence/P20-security-review.md`: renderer
  isolation, 71-method bridge, runtime auth/loopback, secret redaction, content
  safety, paths, terminal, imports, previews (none implemented). No
  release-blocking finding. MONA-016, MONA-025 and MONA-026 are verified.
- **Residual issues:** P20-ISSUE-001 (no end-to-end Electron main kill),
  P20-ISSUE-002 (database-level disk-full not simulated), P20-ISSUE-003 (OS
  sleep/resume not simulated).

**Verification:** `npm test` → 506 Vitest (60 files) + 13 bootstrap + 12 launch +
8 spike; typecheck, lint, format, build, `check:build` pass; validate r65 with 0
warnings. Logs: `docs/evidence/P20-tests.txt`, `P20-checks.txt`. Zero provider
spend.

## Next exact action (P21)

Read P21 in `Mona_PROMPTS.md` and spec sections 3.1, 14, 15, plus the current
Microsoft primary documentation for `IExplorerCommand` and sparse MSIX packages.
P21 owns MONA-004 and MONA-027. Key facts before starting:

- P09 registered the **classic** per-user folder and folder-background menu entry
  under the exact label **Start new DS project with Mona**, with idempotent
  register/uninstall and a real-argv launch probe. That is not the modern menu
  and must not be presented as one.
- The modern menu needs package identity (sparse MSIX) plus a small
  `IExplorerCommand` COM server. There is no code-signing certificate and no
  MSVC toolchain on this machine; `BLOCKERS.md` records both. Check whether
  `MakeAppx`/`signtool`/`dotnet`/`csc` are present before choosing an
  implementation. Self-signed test packages are acceptable only if labelled and
  do not silently add a trust root.
- The P21 installer must unpack `node-pty` from any archive (ISSUE-0022) and
  preserve source projects plus external Codewhale configuration/history.
- Registration must be per-user, idempotent, and remove only Mona-owned keys and
  files. Do not restart Explorer or interrupt a running task without an explicit
  documented need and user control.
- If signing credentials are required, finish all unsigned/local verification,
  then record the exact remaining prerequisite rather than inventing a
  signature or publishing an artifact as signed.

## Relevant files and spec sections

- `tools/launch/context-menu.mjs`, `apps/desktop/src/main/{launch-*,main}.ts`
- `apps/desktop/scripts/`, `package.json`, `native/` (P21 creates the helper)
- `docs/evidence/P09-launch*.{json,md}`, `docs/evidence/P20-*.md`
- `.mona/build/BLOCKERS.md` (signing certificate, Windows 11 menu qualification,
  human Explorer click)
- Spec 3.1, 14, 15; O1/O5.

## Open problem IDs and no-progress counts

No open three-attempt blocker. `attempts.jsonl` still holds only the closed P02
rows.

New in P20: **P20-ISSUE-001** (main hard kill not end-to-end), **P20-ISSUE-002**
(DB disk-full not simulated), **P20-ISSUE-003** (OS sleep not simulated).

Carried: P19-ISSUE-001..004 (Memory real-window pass, handoff copy refusal,
diagnostics engine identity, JSON bundles), P18-ISSUE-002/003, P17-ISSUE-001..005,
P16-ISSUE-001..004, P15-ISSUE-001..003, P14-ISSUE-001..004, P13-ISSUE-001..003,
P12-ISSUE-001..003, P11-ISSUE-001, P10-ISSUE-001..003, P09-ISSUE-001..002,
P08-ISSUE-001..003, P07-ISSUE-001, P06-ISSUE-002, P05-ISSUE-001,
P01-ISSUE-001..004, and terminal follow-ups ISSUE-0019..0022.

## Blocked dependencies

None for independent P21 work. Code signing is not available; the modern-menu
package and any signed installer remain pending until Victor supplies a
certificate/identity decision. Do not block the classic registration, installer
scripts, per-user lifecycle tests or unsigned local builds on it.

## Last relevant validation

- `npm test` → 506 Vitest (60 files) + 13 bootstrap + 12 launch + 8 spike.
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run build`, `npm run check:build -w @mona/desktop` → pass.
- `node tools/build/cli.mjs validate` → OK (r65, 0 warnings).
- Spend: zero for P20. P15's delegated run remains the last paid run
  (5,731.872 µUSD).

## Human input needed

- P21/P22: right-click a folder and a folder background in Explorer and choose
  **Start new DS project with Mona** (classic menu; possibly under **Show more
  options**) to qualify the human acceptance step registered at P09.
- A code-signing certificate and identity decision for the modern menu package
  and signed installer; unsigned local test builds proceed meanwhile.
- P19-ISSUE-001: a human click-through of Memory; P20 automated most of it.
- Terminal follow-ups ISSUE-0019 (screen-reader pass) and ISSUE-0021 (pointer
  drag selection).

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and one test
string in P14; Prettier does not repair that. `check-build.mjs` fails on mojibake
in the renderer bundle. The remaining `Â·`/`â€™` sequences in `DECISIONS.md` and
older handoff text are quoted examples of that incident, not corrupted text.
