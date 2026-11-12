# Mona build handoff

**Current prompt:** P08 — Deliver the live work studio
**Current status:** P00–P07 completed. State revision 24. Next eligible: P08.

**Last verified commit / dirty work:** this session's P07 commit covers the
catalog, the shell, the probe and the evidence below. Verify with
`node tools/build/cli.mjs validate` (OK, r24, 0 warnings) before trusting this
file.

## P07 result — a real shell over a real catalog

The placeholder view router is gone. Mona opens on a SQLite-backed project
catalog and shows the engine's actual state; nothing in this prompt submits a
turn.

- **Catalog** (`packages/project-state/src/catalog.ts`): list/get with search,
  branch read from `.git/HEAD` (worktrees included), folder existence, runtime
  binding and worktree siblings. Store additions: `relocateProject`,
  `putRuntimeBinding`, `getRuntimeBinding`, `listRuntimeBindings`,
  `clearRuntimeBinding`, `projectUsage`, `countThreads`.
- **Aliases vs moves:** the same filesystem identity at a new path is
  `relocation_required` when the old path is gone, `alias` (same project) when it
  is not. Only `relocateProject` rebinds. Junction aliases deduplicate (live
  proof, not a unit test alone).
- **Main process** (`apps/desktop/src/main/catalog-service.ts`,
  `catalog-ipc.ts`): one service for every shell action, 18 named IPC channels,
  sender + payload validation, store errors mapped to renderer-safe codes.
- **UI state** (`apps/desktop/src/main/ui-state.ts`): selected project, last view
  per project, unsent drafts per project/session, atomic writes, bounded sizes,
  corrupt file set aside with a visible warning. Deliberately outside the project
  database so export never carries half-written text.
- **Shell** (`apps/desktop/src/renderer/App.tsx`): rail with search/recents/
  sections, context bar (label, branch, engine, model, permission, spend,
  Ctrl+K), home with per-project actions, studio with the draft composer first,
  work/cost/settings scoped honestly, one inspector, closed-by-default
  diagnostics drawer, command palette.
- **Harness gated:** `?harness=1` renders only when the main process reports
  `harnessEnabled` (dev server or `MONA_ALLOW_HARNESS=1`). Smoke fails if the
  harness renders, if the empty catalog state is missing, or if the palette
  entry point is absent. Closes P06-ISSUE-001.

Evidence: `docs/evidence/P07-projects.md` (report), `P07-catalog.json` +
`P07-catalog-log.txt` (21 live Electron steps), `docs/evidence/shots-p07/`
(6 live screenshots), `P07-shell.json` (smoke), `P07-tests.txt` (180 Vitest + 13
bootstrap + 8 spike), `P07-checks.txt`, `P07-build.txt`. Decisions D-0038 … D-0043.

## Next exact action (P08)

Read P08 in `Mona_PROMPTS.md` and spec 4, 5.2, 6, 13. Connect the timeline and
composer to P03/P04: streaming text, tool cards, safe Markdown, drafts, explicit
file references; expose Plan/Work and the effective permission through qualified
controls; configure Victor's DS Full Access profile once and show it; implement
the execution control strip and real pending-input/approval handling; keep user
explanations separate from raw logs. `CatalogService.startEngine` and the
`selectProject`/`engineState` surfaces are the entry points the studio should
extend — do not build a second engine path in the renderer. Submission is
currently a labelled disabled button; P08 replaces it with the real receipt flow.

## Relevant files and spec sections

- `apps/desktop/src/renderer/App.tsx` (shell), `styles.css`
- `apps/desktop/src/main/{catalog-service,catalog-ipc,ui-state,catalog-probe}.ts`,
  `main.ts` (IPC registration, dev flag, probe wiring)
- `apps/desktop/src/shared/{catalog,ipc}.ts`, `preload/preload.ts`
- `packages/project-state/src/{catalog,store,identity}.ts`
- `packages/ui/src/{primitives,overlay,palette}.tsx`, `tokens.css`
- Spec 4.2/4.3 (layout, views), 5 (journeys), 9.1 (zero inference), 12.

## Open problem IDs and no-progress counts

No open blocker; `attempts.jsonl` holds only the closed P02 rows.

- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift; P16.
- **P01-ISSUE-002** — Windows allows a second runtime in one workspace; Mona
  leases one and now *refuses* a start for a different workspace while one is
  owned (live-verified).
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.
- **P04-ISSUE-001** — no Job Object; `taskkill /T` plus reconcile.
- **P04-ISSUE-002** — close-to-tray still has no tray affordance. The shell now
  exists, so this is P23 packaging work rather than a blocker.
- **P05-ISSUE-001** — maintenance barrier is in-process (D-0032).
- **P06-ISSUE-002** — no human screen-reader pass yet; P22 owns it.
- **P07-ISSUE-001** — the P04/P05/P06 evidence scripts write to fixed historical
  paths, so a regression run rewrites those artifacts. Their state hashes were
  refreshed (timestamps/temp paths only, same probe, same result) and ledger rows
  re-recorded. Fix the mechanism by passing prompt-scoped `MONA_*_OUT` paths when
  running a probe outside its own prompt.
- **P07-ISSUE-002** — the studio composer is a local draft only; submission,
  streaming and control strip are P08. The button is disabled and says so.

## Blocked dependencies

None.

## Last relevant validation

- `npx vitest run` → 180 passed (20 files; +32 in P07).
- `npm run bootstrap:test` → 13; `npm run spike:test` → 8.
- `npm run lint`, `npm run format:check`, `npm run typecheck` → pass.
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  275 kB.
- `npm run check:build -w @mona/desktop` → pass, now also fails on mojibake.
- `npm run catalog -w @mona/desktop` → 21/21 live steps, 6 live screenshots.
- `npm run smoke -w @mona/desktop` (output `P07-shell.json`) → pass, 18 named
  bridge methods, 331 MB.
- `npm run shots -w @mona/desktop` → 34 harness screenshots, 4 audits clean
  (harness now needs `MONA_ALLOW_HARNESS=1`; the script sets it).
- `npm run lifecycle -w @mona/desktop` → 10/10, local state schema v1.
- `node tools/build/cli.mjs validate` → OK, r24, 0 warnings.
- Spend unchanged: `CatalogService.startEngine` starts a runtime and submits no
  turn; P07 made no provider request.

## Human input needed

None. One standing caution, now enforced: edit source with byte-safe tools. A
PowerShell `Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and
`catalog-probe.ts` this session and shipped `Â·`/`â€™` into a screenshot;
`check-build.mjs` now fails on mojibake, and `DECISIONS.md`/`HANDOFF.md` were
cleaned as part of the repair.
