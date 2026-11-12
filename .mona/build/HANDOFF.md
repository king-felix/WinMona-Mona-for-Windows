# Mona build handoff

**Current prompt:** P19 — Finish project memory, portable handoff and diagnostics
**Current status:** P00–P18 completed. State revision 58 after the P18 checkpoint.
Next eligible: P19.

`last_verified_commit` stays null because a state file cannot contain the hash of
the commit that contains it. Verify with `node tools/build/cli.mjs validate`
(expect OK, r58, 0 warnings) before trusting this file.

## P18 result — auditable capability explorer, honest terminal gap

- **Explorer.** `capability-service.ts` + `CapabilitiesPanel.tsx` join the
  versioned `docs/codewhale-capabilities.json` (56 rows) with live
  `/v1/runtime/info` and `/v1/process` identity. Every row shows source, scope,
  class, permission and cost implications, integration label, UI location,
  tests, evidence, status and gap.
- **Coverage.** The explorer computes qualified, read-qualified, discovered,
  unavailable, blocked and unknown counts plus integration counts. The figure is
  labelled catalog coverage, not parity. At capture: 25/56 verified entry points
  (45%), 27 discovered-only, 4 unavailable, 0 blocked, 0 unknown.
- **Drift.** Live version/commit are compared with the ledger. A mismatch is
  shown as version or commit drift; ledger claims are never inherited silently.
- **Palette.** Every row is a locally ranked palette item. Selecting one opens
  Capabilities and focuses that row; capability items never invoke anything.
  P18 also fixed a P17 regression where `action:extensions` was inert.
- **Logs.** `GET /v1/logs` lists sources and files; `GET /v1/logs/{name}` is read
  in 64 KiB slices with offset paging. Path-like names are refused and
  credential-shaped values are redacted. No log is writable from the renderer.
- **Terminal.** The pinned engine reports `terminal_stream/input/resize/kill` as
  false and returns HTTP 501: “terminal sessions are Unix-only in this build;
  native Windows PTY support is not implemented yet.” Mona ships no terminal
  widget and no pseudo-PTY. CAP-0053 is `unavailable-on-platform`.
- **Spend.** Zero. The probe submitted no turn; `/v1/usage` was identical before
  and after (0 turns, 0 tokens, 0 cost).

## P17 result — tools and extensions are manageable

- **Adapter.** `packages/adapter/src/extensions.ts` projects
  `/v1/apps/mcp/servers` (+ detail), `/v1/skills`, `/v1/apps/plugins`,
  `/v1/hooks` and `/v1/workspace/instructions`. Sections carry `ok` or
  `unavailable`, so an empty list is never mistaken for a failed read.
- **Workbench.** Extensions section (Alt+5) with MCP provenance, key-name-only
  env reporting, skills/plugins/hooks/instructions and explicit scope notes.
- **Actions.** MCP enable/disable and health check send the displayed `mcp-v1-…`
  revision in `If-Match`; HTTP 412/428 map to `conflict`. Required servers cannot
  be disabled. Snapshot performs only list/detail reads and never connects a
  server or requests the tool catalog.
- **Scope.** Project MCP servers and hooks stay hidden/inert until the engine
  records workspace trust and approval. Unknown top-level and server-level keys
  survived an edit; the unrelated server and its secret did too.

## Next exact action (P19)

Read P19 in `Mona_PROMPTS.md` and spec sections 8, 10.1, 12 and 13. P19 owns
MONA-024 and MONA-025.

Known starting facts:

- P05 already owns SQLite state, backup/restore and the artifact store. P19 must
  reuse those, not add a second database or snapshot engine.
- Prompt shelf/import/export exists in a minimal per-project favorite form
  (P14). P19 adds variables, acceptance criteria, preview, versioning and inert
  import behavior; imported prompts never execute.
- Search must be local and deterministic. No embedding service and no copied
  repository contents; index only explicitly permitted metadata and search
  repository files on demand.
- Diagnostics currently exist as the provider workbench’s offline redacted text
  and the P18 log reader. P19 adds a local diagnostic bundle preview with
  redaction and artifact digests.
- Portable handoff must omit machine-local bindings and unavailable engine-owned
  sessions; imported bindings need requalification.
- The artifact store and maintenance barrier from P05 must gate restore and
  import; no writer may bypass them.

## Relevant files and spec sections

- `packages/project-state/src/{state,store,changes,catalog,studio}.ts`
- `packages/adapter/src/{diagnostics,configuration,extensions,http}.ts`
- `packages/contracts/src/{capabilities,configuration,extensions,project}.ts`
- `apps/desktop/src/main/{capability-service,capability-ipc,extensions-service,provider-workbench,ui-state,briefing-ipc}.ts`
- `apps/desktop/src/renderer/{CapabilitiesPanel,ExtensionsPanel,BriefingPanel,App}.tsx`
- `docs/evidence/P18-capabilities.{md,json}`, `docs/evidence/P17-extensions.{md,json}`
- `docs/codewhale-capabilities.json`, `tools/spike/p18-capabilities.mjs`
- Spec 8, 10.1, 12, 13; O3/O5.

## Open problem IDs and no-progress counts

No open three-attempt blocker. `attempts.jsonl` still holds only the closed P02
rows.

New, carried for P19+:
- **ISSUE-0018 (MONA-023/terminal)** — the pinned engine has no Windows PTY and
  returns HTTP 501. Victor must accept terminal as platform-unavailable for 1.0
  or authorize a native Windows PTY path (likely P21). Logs and isolation pass;
  the terminal criterion is blocked, so MONA-023 is blocked.
- **P18-ISSUE-002 (not a ledger issue)** — 27 of 56 capability rows are
  discovered-only. Their help or route is recorded, but no tested entry point is
  claimed. The explorer says so; closing them is P23/P22 scope unless Victor
  narrows the list.
- **P18-ISSUE-003 (not a ledger issue)** — upgrade qualification remains partial.
  No engine upgrade was performed; P21/P22 must qualify one explicitly.

Carried earlier: P17-ISSUE-001..005, P15-ISSUE-001..003, P16-ISSUE-001..004,
P01-ISSUE-001..004, P05-ISSUE-001, P06-ISSUE-002, P07-ISSUE-001,
P08-ISSUE-001..003, P09-ISSUE-001..002, P10-ISSUE-001..003, P11-ISSUE-001,
P12-ISSUE-001..003, P13-ISSUE-001..003, P14-ISSUE-001..004.

## Blocked dependencies

Windows PTY support for MONA-023/terminal is undecided (ISSUE-0018). It does not
block P19: P19 depends on P10, P13 and P18, all completed.

## Last relevant validation

- `npm test` → 418 Vitest (46 files) + 13 bootstrap + 12 launch + 8 spike.
- `npm run build` → contracts, adapter, project-state, ui, desktop; the ledger is
  copied to `apps/desktop/dist/resources/capabilities.json`; renderer 358.30 kB
  (gzip 102.61 kB).
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run check:build -w @mona/desktop` (54 named preload channels), and
  `node tools/build/cli.mjs validate` → pass (r58, 0 warnings).
- `node tools/spike/p18-capabilities.mjs --out docs/evidence/P18-capabilities.json`
  → 13/13 checks; zero inference.
- Spend: P18 zero. P15 delegated run remains the last paid run (5,731.872 µUSD).

## Human input needed

One decision is open, and it is not needed for P19: **ISSUE-0018** — should
terminal be accepted as unavailable on Windows for 1.0, or should P21 build a
native Windows PTY path? Until Victor decides, MONA-023 stays blocked and no
terminal claim is made.

Standing acceptance item for P21/P22: right-click a folder and a folder
background in Explorer and choose **Start new DS project with Mona** (possibly
under **Show more options**). The registration currently points at the
development build; remove it with `npm run launch:menu -- unregister` or replace
it at install time.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and one test
string in P14; Prettier does not repair that. `check-build.mjs` fails on mojibake
in the renderer bundle. The remaining `Â·`/`â€™` sequences in `DECISIONS.md` and
older handoff text are quoted examples of that incident, not corrupted text.
