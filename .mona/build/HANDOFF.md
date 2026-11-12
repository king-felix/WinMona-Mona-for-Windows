# Mona build handoff

**Current prompt:** P20 — Harden recovery and test hostile or failing inputs
**Current status:** P00–P19 completed. State revision 64; ledger revision 296.
Next eligible: P20.

`last_verified_commit` stays null because a state file cannot contain the hash of
the commit that contains it. Verify with `node tools/build/cli.mjs validate`
(expect OK, r64, 0 warnings) before trusting this file.

## P19 result — local memory, portable handoff and diagnostics

- **Search.** Migration v7 adds a deterministic term index
  (`memory_documents`/`memory_terms`) over project metadata, decisions, tasks,
  evidence, requirement evidence, problems, attempts and bounded timeline
  items. No FTS extension, no embeddings, no background indexer. Task
  `prompt_text` and runtime bindings are not indexed; credential-shaped text is
  redacted before tokenization. `searchFiles` reads the project folder on
  demand, never writes, skips symlinks, ignored directories, credential-shaped
  files and binary content, and reports scanned counts and skips.
- **Prompt shelf.** P14 favorites were upgraded in place to versioned prompts
  with `{{variables}}`, acceptance criteria, exact preview (text + sha256),
  bounded history and inert pack import/export. Studio uses the same entries;
  prompts with variables are filled in Memory rather than inserted raw.
- **Portable handoff.** JSON envelopes with canonical-JSON digests carry tasks,
  dependencies, decisions, requirement evidence, a resume summary and optional
  explicitly selected files. No path, endpoint, pid, token digest, thread id or
  conversation travels. Import requires a folder, rebinds it, re-hashes evidence
  against that folder, marks missing/changed evidence stale, reopens affected
  completions to `verifying`, and executes nothing. Resume packets are the
  concise form and re-import the same pointers.
- **Settings and diagnostics.** Settings backup redacts credential-shaped keys
  and values; restore verifies the digest and schema, then appends new versions
  under the exclusive maintenance barrier. The diagnostic preview is local and
  redacted (home path and credentials), reports missing artifacts and digest
  mismatches, and exports exactly the previewed bytes.
- **Desktop.** New Memory section (Alt+9), ten sender-checked IPC channels, 71
  named preload methods. File paths come only from native dialogs in main.

**Verification:** `npx vitest run` → 58 files / 496 tests (53 new in 8 files);
`node tools/spike/p19-memory.mjs` → 23/23 checks, zero provider requests,
`docs/evidence/P19-memory.{json,md}`; `npm run smoke` → real Electron window,
71 named methods, `docs/evidence/P19-electron-smoke.json`; typecheck, lint,
format, build, `check:build` pass. MONA-024 and MONA-025 are verified.

**Reconciliation:** the P18 terminal evidence hash was stale at session start
because the state file was written before the final evidence edit. The committed
`P18-terminal.md` content is unchanged; its hash was re-recorded in state at
r63 and in the ledger for MONA-023/terminal. No claim changed.

## Next exact action (P20)

Read P20 in `Mona_PROMPTS.md` and spec sections 6.4, 10, 13, 15. P20 owns the
failure matrix and the security-boundary review across the assembled product.

Known starting facts and likely targets:

- P05 owns backups, restore and the maintenance barrier; P19 settings restore
  and handoff import already take the barrier. Exercise interrupted restore,
  corrupted metadata, failed migration and disk-full paths with real failures.
- P19 surfaces that need hostile input: handoff/resume/prompt packs (digest,
  traversal, wrong shape), settings backups (redacted placeholders, newer
  schema), diagnostics (secret/home-path fixtures), memory search (binary,
  credential files, huge trees), prompt preview (malformed placeholders).
- P18 terminal and P17 extensions have live probes; P20 should re-run the
  security boundaries: IPC sender validation, loopback/auth, Markdown and file
  links, terminal links, imported archives, path canonicalization, junction and
  suspicious-folder cases.
- Open P19 issues: UI needs a real-window pass (P19-ISSUE-001); handoff copy
  import into the same profile is refused by design (P19-ISSUE-002); engine
  version/commit in diagnostics is unknown (P19-ISSUE-003); bundles are JSON,
  not ZIP (P19-ISSUE-004).
- Carried issues remain: P18-ISSUE-002 (27 of 57 capability rows
  discovered-only), P18-ISSUE-003 (no engine upgrade qualified), P17-ISSUE-001..005,
  P15-ISSUE-001..003, P16-ISSUE-001..004, P14-ISSUE-001..004, P13-ISSUE-001..003,
  P12-ISSUE-001..003, P11-ISSUE-001, P10-ISSUE-001..003, P09-ISSUE-001..002,
  P08-ISSUE-001..003, P07-ISSUE-001, P06-ISSUE-002, P05-ISSUE-001,
  P01-ISSUE-001..004, plus the four terminal follow-ups (ISSUE-0019..0022).

## Relevant files and spec sections

- `packages/project-state/src/{memory,prompts,handoff,settings,diagnostics-bundle,redaction}.ts`
- `apps/desktop/src/main/{memory-service,memory-ipc,ui-state}.ts`
- `apps/desktop/src/renderer/MemoryPanel.tsx`, `apps/desktop/src/shared/memory.ts`
- `docs/evidence/P19-memory.md`, `P19-memory.json`, `P19-memory-log.txt`,
  `P19-electron-smoke.json`
- `tools/spike/p19-memory.mjs`
- Spec 6.4, 10, 13, 15; O3/O5.

## Open problem IDs and no-progress counts

No open three-attempt blocker. `attempts.jsonl` still holds only the closed P02
rows.

New in P19: **P19-ISSUE-001** (Memory section not yet exercised by a human in a
real window), **P19-ISSUE-002** (handoff copy into the same profile refused by
preserved task ids), **P19-ISSUE-003** (diagnostics engine identity unknown),
**P19-ISSUE-004** (JSON bundles, no ZIP tooling).

Carried terminal follow-ups: ISSUE-0019 (screen-reader pass), ISSUE-0020
(node-pty console noise on forced kill), ISSUE-0021 (pointer drag selection),
ISSUE-0022 (P21 installer must unpack node-pty).

## Blocked dependencies

None. MONA-024 and MONA-025 are verified; P20 may reopen a criterion if a
failure-injection result contradicts the evidence.

## Last relevant validation

- `npm test` → 496 Vitest (58 files) + 13 bootstrap + 12 launch + 8 spike.
- `node tools/spike/p19-memory.mjs` → 23/23 checks, zero provider requests.
- `npm run smoke` → real Electron window, 71 named preload methods.
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run check:build -w @mona/desktop` → pass.
- `node tools/build/cli.mjs validate` → OK (r64, 0 warnings).
- Spend: zero for P19. P15's delegated run remains the last paid run
  (5,731.872 µUSD).

## Human input needed

- P19-ISSUE-001: a human click-through of Memory (reindex, prompt preview,
  diagnostics) is still worth doing; P20 can automate most of it.
- Standing acceptance item for P21/P22: right-click a folder and a folder
  background in Explorer and choose **Start new DS project with Mona** (possibly
  under **Show more options**).
- Terminal follow-ups ISSUE-0019/0021 remain human checks.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and one test
string in P14; Prettier does not repair that. `check-build.mjs` fails on mojibake
in the renderer bundle. The remaining `Â·`/`â€™` sequences in `DECISIONS.md` and
older handoff text are quoted examples of that incident, not corrupted text.
