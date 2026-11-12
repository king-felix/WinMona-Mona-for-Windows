# Mona build handoff

**Current prompt:** P17 — Make tools and extensions manageable
**Current status:** P00–P16 completed. State revision 49 after the P16 checkpoint.
Next eligible: P17.

`last_verified_commit` stays null because a state file cannot contain the hash of
the commit that contains it. Verify with `node tools/build/cli.mjs validate`
(expect OK, r49, 0 warnings) before trusting this file.

## P15 result — native agents, goals, fleets and workflows

- **Adapter.** `packages/adapter/src/native.ts` projects `/v1/goals`,
  `/v1/threads/{id}/goal`, `/v1/tasks`, `/v1/agent-runs`, `/v1/fleet/runs`,
  fleet receipts/workers and turn artifacts. Tolerant wire schemas, strict
  internal contracts; missing usage stays `unknown`.
- **Observatory.** `apps/desktop/src/main/agent-observatory.ts` builds the
  thread/goal/agent/fleet/task/worker graph, one explicit ownership record and
  aggregate spend that uses the parent thread total once. `AgentsPanel.tsx` is a
  new Agents section (Alt+4) with nine validated IPC channels.
- **Control without a second scheduler.** `StudioService.submit` refuses while a
  native owner is active; native starts are refused while Mona's queue owns the
  turn. Fleet runs are created with one task, one worker and `max_workers: 1`.
- **Real delegated run.** One parent turn delegated a one-word read-only task
  through the native `agent` tool. `agent.spawned` seq 2088 and
  `agent.completed` seq 2095 were observed; child cost 678 µUSD is included in
  the parent thread total 5,731.872 µUSD, so it is marked `inParent` and not
  added twice.
- **Fleet limitation.** `POST /v1/fleet/runs/{id}/start` returned
  `execution: scheduled`, `leased: 0`, `queued: 1`; no worker lease appeared in
  180 s and usage did not move. Mona reports exactly that (P15-ISSUE-001).

## P16 result — providers, models and effective settings

- **Adapter.** `packages/adapter/src/configuration.ts` maps `/v1/config`,
  `/v1/providers`, `/v1/providers/{id}/models` and `/v1/settings/schema`.
- **Workbench.** `provider-workbench.ts` + `ProviderWorkbench.tsx` show the
  provider catalog, credential state (never a value), per-model capabilities,
  requested vs effective route, saved default, supported reasoning levels,
  permission choices and offline diagnostics.
- **Scoped writes.** `codewhale config set` with a config.toml + settings.toml
  snapshot, hashed backup, expected-revision check and read-back verification.
  Route changes affect new threads; the active thread keeps its route.
- **Live scope proof.** `P16-scope.json`: thread created on `deepseek-flash`;
  config set model `deepseek-chat`; `getThread` still reports `deepseek-flash`;
  the runtime still reports its launch route. Isolated `CODEWHALE_HOME`, zero
  inference.
- **Diagnostics.** Offline `doctor --json`; missing credential and invalid
  endpoint are distinct. No `--probe-api` call. Redaction test covers keys,
  bearer tokens and `token:` values.
- **Reasoning.** `deepseek-flash` reports `reasoning_effort: "unknown"` with no
  levels, so no reasoning control is offered and none is sent.

## Next exact action (P17)

Read P17 in `Mona_PROMPTS.md` and spec sections 7 (021), 9.2, 11 extensions and
13. P17 owns MONA-021 (MCP, skills, plugins, hooks, rules, instructions). Reuse
the runtime routes already observed: `/v1/skills` exists and P01 tested it;
MCP/plugin management capabilities are advertised. Do not load every server
description into model context just to render a settings page.

## Relevant files and spec sections

- `packages/adapter/src/{native,configuration,http,adapter}.ts` (+ tests)
- `packages/contracts/src/{orchestration,configuration}.ts`
- `apps/desktop/src/main/{agent-observatory,agents-ipc,provider-workbench,provider-ipc,engine-config,main}.ts`
- `apps/desktop/src/shared/{agents,provider}.ts`
- `apps/desktop/src/renderer/{AgentsPanel,ProviderWorkbench,App}.tsx`
- `docs/adr/0001-orchestration-ownership.md`
- `docs/evidence/P15-*`, `docs/evidence/P16-*`
- Spec 7 (018/019/020), 9.1, 10.3, 11, 12, 13; O3/O5.

## Open problem IDs and no-progress counts

No open blocker. `attempts.jsonl` still holds only the closed P02 rows.

Carried forward, relevant to P17+:
- **P15-ISSUE-001** — local fleet start schedules but no worker lease was
  observed in the app-server runtime; a foreground supervisor or later build may
  be required. Re-qualify at P18/P20.
- **P15-ISSUE-002** — parallel builder runs are not offered; worktrees, branch
  ownership, budgets and a merge boundary remain unqualified.
- **P15-ISSUE-003** — agent-run history is engine-owned; Mona keeps a last
  observed projection, not full child transcripts.
- **P16-ISSUE-001** — Flash reports reasoning support as unknown; no reasoning
  control is offered.
- **P16-ISSUE-002** — diagnostics are offline; live route probes stay explicit.
- **P16-ISSUE-003** — credential entry remains with the engine.
- **P16-ISSUE-004** — providers without a model catalog cannot be validated
  locally; the workbench refuses to pretend.
- Carried earlier: P01-ISSUE-001 (endpoint fingerprint drift), P01-ISSUE-002
  (one runtime per machine session), P01-ISSUE-003 (terminal flags false; P18),
  P01-ISSUE-004 (provisional cost sample), P05-ISSUE-001 (in-process barrier),
  P06-ISSUE-002 (no human screen-reader pass), P07-ISSUE-001 (probe default
  paths), P08-ISSUE-001..003, P09-ISSUE-001..002, P10-ISSUE-001..003,
  P11-ISSUE-001, P12-ISSUE-001..003, P13-ISSUE-001..003, P14-ISSUE-001..004.

## Blocked dependencies

None.

## Last relevant validation

- `npm test` → 381 Vitest (40 files) + 13 bootstrap + 12 launch + 8 spike
  (`docs/evidence/P15-tests.txt`).
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  332.57 kB (gzip 97.06 kB) (`docs/evidence/P15-build.txt`).
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run check:build -w @mona/desktop` (48 named preload channels), and
  `node tools/build/cli.mjs validate` → pass (`docs/evidence/P15-checks.txt`).
- `node tools/spike/p15-agent-run.mjs` → one real delegated run; 119 events;
  `docs/evidence/P15-agent-run.json`.
- `node tools/spike/p16-scope.mjs` → isolated live scope probe, zero inference;
  `docs/evidence/P16-scope.json`.
- Spend: P15 delegated run 5,731.872 µUSD; every other P15/P16 check local and
  offline. P16 spend zero.

## Human input needed

None to continue P17. Standing acceptance item for P21/P22: right-click a folder
and a folder background in Explorer and choose **Start new DS project with Mona**
(possibly under **Show more options**). The registration currently points at the
development build; remove it with `npm run launch:menu -- unregister` or replace
it at install time.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and one test
string in P14; Prettier does not repair that. `check-build.mjs` fails on mojibake
in the renderer bundle. The remaining `Â·`/`â€™` sequences in `DECISIONS.md` and
older handoff text are quoted examples of that incident, not corrupted text.
