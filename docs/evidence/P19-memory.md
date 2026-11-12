# P19 — project memory, portable handoff and diagnostics

**Status:** completed. Requirements MONA-024 and MONA-025 are satisfied by this
prompt; P20 re-tests the recovery boundary and may reopen a criterion if it finds
a real failure.

**Goal:** make a project understandable across sessions and machines without a
cloud service, a second transcript authority or a paid inference call.

## What was delivered

### Local, deterministic project memory

- Migration v7 adds `memory_documents` and `memory_terms`. There is no FTS
  extension, no embedding service and no model call. A project that was never
  indexed reports `indexed: false` instead of returning an empty "success".
- `MemoryIndex.reindexProject` rebuilds one project's index in one transaction
  from state Mona already owns: project label and repository kind, decisions,
  tasks (title, description, status, acceptance criteria, requirement ids),
  task evidence, requirement evidence, problems, attempts, and the newest 400
  timeline items by default. Task `prompt_text` and runtime bindings are not
  indexed.
- Redaction runs before tokenization. Credential assignments, bearer tokens,
  URL tokens, provider-key shapes, environment assignments and the account name
  in a home path are replaced. The index records that a document was redacted;
  the secret itself is never stored or searchable.
- Retrieval is AND over a deterministic tokenizer (lowercase words plus one
  term per CJK character), with title terms weighted 3 and body terms 1.
  Results are ordered by score then document id, so the same query gives the
  same order on every machine.
- Retention is explicit. Documents carry `ephemeral | task | evidence |
  permanent`; the default policy indexes `task`, `evidence` and `permanent`
  and can exclude timeline or attempts entirely.
- `MemoryIndex.searchFiles` walks the project folder on demand. It never writes,
  never copies content into SQLite, never follows symlinks or junctions, skips
  `.git`, `node_modules`, build output and other ignored directories, refuses
  credential-shaped names (`.env`, `*.pem`, key stores, credentials files) and
  binary content, and reports scanned files/bytes plus what it skipped. Bounds:
  800 files, 256 KiB per file, 8 MiB total, 40 hits by default.

### Versioned prompt shelf

- The P14 favorite array is now the shelf, upgraded in place. Every entry has a
  template, declared variables (`{{name}}`), acceptance criteria, a version and
  a bounded history of the previous ten versions. Legacy favorites are read as
  version 1 prompts with no variables, so no saved text is lost.
- `renderPrompt` returns the exact text that would be inserted into the
  composer, including the acceptance checklist, with a sha256 and the missing,
  undeclared, unused and malformed variable names. Missing values stay visible
  as `{{name}}`; a preview cannot look finished when it is not.
- A content edit appends a snapshot of the previous version and increments the
  version. A no-op edit does not.
- Prompt packs are a schema-validated JSON document with a digest. Import
  validates the digest and stores text; it never sends, executes or schedules
  anything. Export writes the same shape. The renderer needs no Node module:
  the pack and preview functions live in `@mona/project-state`.

### Portable handoff and resume packets

- A handoff carries project label and repository kind, tasks (including steps,
  criteria, requirement links and evidence pointers), dependencies, decisions,
  requirement evidence, a deterministic resume summary and a digest. It carries
  **no** canonical path, filesystem identity, runtime endpoint, pid, token
  digest, engine thread id or conversation.
- `files` is empty unless the human explicitly selects paths. Credential-shaped
  files are refused even when selected; a bundle is capped at 200 files, 1 MiB
  each and 4 MiB total.
- Import requires a folder on this machine. The folder is registered/rebound as
  the project binding (`requalified: true`), and the report states
  `autoExecuted: false`. Nothing is claimed or submitted, and no engine call is
  made.
- Evidence is re-checked against the new folder: a missing file and a changed
  digest are both reported, the evidence row is marked stale, and a completed
  task that depends on stale evidence is imported as `verifying` with the
  reason recorded. Completion is never carried over on trust.
- A resume packet is the concise form: pointers, decisions and the next action,
  no files. It re-imports the same pointers.
- What cannot travel is listed in the bundle itself: engine-owned thread/turn
  history, runtime bindings, credentials/environment, the absolute path,
  unselected artifacts and Mona UI state.

### Safe paths and hostile bundles

`assertSafeRelativePath` rejects empty paths, control characters, backslashes,
absolute paths, drive letters, UNC prefixes, traversal that leaves the root,
empty/relative segments, segments ending in dot or space, Windows device names
and stream separators. Import refuses such a bundle before the store is touched.
`extractPortableFiles` revalidates every member, verifies its digest and size,
and writes with exclusive-create under the chosen root. A test and the probe
both attempt `../escape.txt` and confirm nothing is written outside the root.

### Settings backup and restore

- A settings backup carries the newest value of every settings scope with a
  digest. A key that names a credential is replaced wholesale and recorded in
  `redactedPaths`; every other string still passes through text redaction.
- Restore verifies the file digest (and an expected digest when supplied),
  refuses a backup from a newer store schema, then runs under the maintenance
  barrier with `BEGIN IMMEDIATE`. It appends a new settings version per scope
  and never rewrites history. A concurrent write during the restore is refused
  with `maintenance`; a failed restore rolls back and releases the barrier.

### Diagnostic bundle preview

- The preview is assembled locally from app facts, the reported engine facts,
  store schema/revision/integrity and row counts, an artifact listing with
  existence and optional digest verification, bounded log excerpts and notes.
  There is no environment dump, no full source and no network call.
- The whole document passes through one redaction pass, including the account
  name in home paths. Export writes exactly the previewed bytes, and the
  preview's digest matches the written file.
- A missing artifact is reported as missing, a digest mismatch as a mismatch,
  and an unavailable artifact root as unavailable. None is silently treated as
  healthy.

### Desktop surface

- New Memory section (Alt+9, palette entry): local search with history/file
  scope, reindex, shelf list, variable inputs, exact preview with digest and
  checklist, insert-into-composer, pack import/export, handoff/resume export and
  import, settings backup/restore, and diagnostic preview.
- Ten named, sender-checked, schema-validated IPC channels. File paths come
  from native dialogs in the main process; the renderer never supplies one.
  Total named preload methods: 71.
- Studio's prompt shelf uses the same entries. A prompt with variables is not
  inserted raw there; it points to the Memory preview.

## Verification

Commands and results:

- `npx vitest run` → 58 files, **496 tests passed**, including 53 new
  tests in 8 new files (36 project-state, 17 desktop).
  - `packages/project-state/src/memory.test.ts` (7): indexing, AND retrieval,
    redaction, unindexed reporting, retention, CJK tokenization, on-demand file
    search with ignore/secret/binary/oversize handling and bounded results.
  - `packages/project-state/src/prompts.test.ts` (11): rendering, defaults,
    missing/undeclared/unused/malformed variables, checklist append, bounded
    version history, no-op version, pack digest and inert import.
  - `packages/project-state/src/handoff.test.ts` (9): machine-local fields
    absent, explicit files only, credential file refusal, clean-profile import,
    missing/stale evidence reopening, tamper/missing-folder/non-empty refusals,
    resume packet, traversal/device-name rejection and extraction refusal.
  - `packages/project-state/src/settings.test.ts` (5): redacted backup, digest
    checks, maintenance barrier with a refused concurrent write, newer-schema
    refusal, rollback.
  - `packages/project-state/src/diagnostics-bundle.test.ts` (4): redaction
    fixtures (home path, env key, bearer token), artifact missing/mismatch,
    exact export bytes, unavailable artifact root.
  - `apps/desktop/src/main/ui-state.test.ts` (9): legacy favorite upgrade,
    version history, inert pack import.
  - `apps/desktop/src/main/memory-service.test.ts` (7): search, file search,
    prompt preview/version/export/import, handoff export and clean-store import,
    settings backup/restore, diagnostics redaction, cancelled dialogs.
  - `apps/desktop/src/main/memory-ipc.test.ts` (6): exact channel set, sender
    check, payload validation, pass-through, unavailable service.
  - `apps/desktop/src/renderer/MemoryPanel.test.tsx` (3): exact preview before
    insert, local search hit, handoff export + redacted diagnostics.
- `node tools/spike/p19-memory.mjs` → **23/23 checks**, zero engine starts,
  zero provider requests. Evidence: `docs/evidence/P19-memory.json`,
  `docs/evidence/P19-memory-log.txt`.
- `npm run smoke` → real Electron window; navigation and popup refused, one
  frozen preload bridge with **71 named methods**, footprint 351 MB. Evidence:
  `docs/evidence/P19-electron-smoke.json` and its log.
- `npm run typecheck`, `npm run lint`, `npm run format:check` → pass.
- `npm run build -w @mona/desktop` → renderer 377.13 kB (gzip 107.66 kB);
  terminal chunk remains lazy. `npm run check:build -w @mona/desktop` → pass,
  71 named channels, no fixtures, no credentials, no whitespace in the bundle
  that looks like a remote origin.
- `node tools/build/cli.mjs validate` → see the checkpoint recorded in state.

Zero provider spend for P19: search, preview, export, import and diagnostics
have no adapter dependency. The probe asserts `providerRequests: 0`.

## What this intentionally cannot do

- It cannot search engine-owned conversation history on another machine; the
  engine remains the transcript authority and those sessions do not travel.
- It cannot show the exact provider request. It shows the exact task prompt
  dispatch text (P10) and the exact prompt-shelf text; everything else is a
  local projection.
- It does not copy repository files into the database. File results are
  transient and bounded.
- A handoff does not carry the source project's artifacts unless they were
  explicitly selected, and import does not write selected files automatically;
  extraction is a separate, validated call.
- Importing a handoff into a profile that already contains the source project is
  refused because the bundle preserves task ids. The supported path is a clean
  profile or an empty folder; this is recorded as P19-ISSUE-002.

## Open issues

- **P19-ISSUE-001** — The Memory panel was exercised in happy-dom and through
  the real preload/main path in the Electron smoke (bridge shape only), not by a
  human clicking through a real window. P20 whole-product QA should open the
  section, reindex, preview a prompt and inspect diagnostics live.
- **P19-ISSUE-002** — Handoff import preserves task ids, so importing a copy of
  a project that still exists in the same profile is refused with `conflict`.
  This is deliberate until id remapping is designed; the clean-profile path is
  verified.
- **P19-ISSUE-003** — The diagnostic preview reports engine version/commit as
  unknown unless the caller supplies them. The current service passes `null`
  rather than inventing an identity; the capability explorer remains the place
  that reads live engine identity.
- **P19-ISSUE-004** — Prompt packs and handoff files are JSON documents rather
  than ZIP archives (decision D-0089). The path-traversal requirement is met by
  validating member paths, but there is no compressed archive to inspect with
  ordinary ZIP tooling.

## Evidence files

- `docs/evidence/P19-memory.md` (this file)
- `docs/evidence/P19-memory.json` — 23 probe checks, zero provider requests
- `docs/evidence/P19-memory-log.txt` — human-readable probe log
