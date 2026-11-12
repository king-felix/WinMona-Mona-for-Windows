# Mona build handoff

**Current prompt:** P18 — Complete advanced access and the capability explorer
**Current status:** P00–P17 completed. State revision 54 after the P17 checkpoint.
Next eligible: P18.

`last_verified_commit` stays null because a state file cannot contain the hash of
the commit that contains it. Verify with `node tools/build/cli.mjs validate`
(expect OK, r54, 0 warnings) before trusting this file.

## P17 result — tools and extensions are manageable

- **Adapter.** `packages/adapter/src/extensions.ts` projects
  `/v1/apps/mcp/servers` (+ detail), `/v1/skills`, `/v1/apps/plugins`,
  `/v1/hooks` and `/v1/workspace/instructions`. Sections carry `ok` or
  `unavailable`, so an empty list is never mistaken for a failed read.
- **Workbench.** `extensions-service.ts` + `ExtensionsPanel.tsx` add an
  Extensions section (Alt+5, palette entry) with MCP provenance, key-name-only
  env reporting, skills/plugins/hooks/instructions and explicit scope notes.
- **Actions.** MCP enable/disable and health check are the only writes. They
  send the displayed `mcp-v1-…` revision in `If-Match`; HTTP 412/428 map to a
  `conflict` and the UI asks for a reload. Required servers cannot be disabled.
- **No implicit side effects.** Snapshot performs seven reads (MCP list, two
  details, skills, plugins, hooks, instructions) and never calls
  `/v1/apps/mcp/tools` or `/reconnect`. Health is explicit and per server.
- **Scope.** Global MCP servers are visible and writable. Project MCP servers
  and project hooks remain hidden/inert until the engine records workspace trust
  and approval; Mona reports that state and does not approve it.
- **Unknown keys.** The live probe disabled a server and confirmed the unknown
  top-level key, the unknown server-level key, the unrelated server and its
  secret value all survived. A stale revision was refused and left the state
  unchanged.
- **Spend.** Zero. The probe submitted no turn; `/v1/usage` totals were
  identical before and after (0 turns, 0 tokens, 0 cost).

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
- **Reasoning.** `deepseek-flash` reports `reasoning_effort: "unknown"` with no
  levels, so no reasoning control is offered and none is sent.

## Next exact action (P18)

Read P18 in `Mona_PROMPTS.md` and spec sections 7.1, 11 (terminal/palette) and
13. P18 owns MONA-022, MONA-023 and MONA-030.

Known starting facts:

- P01 recorded `terminal_stream`, `terminal_input`, `terminal_resize` and
  `terminal_kill` as **false** in this build (P01-ISSUE-003). Do not fake a
  terminal. Qualify the advertised terminal routes and, if the build still
  reports them false, record the exact advanced/terminal route and the blocked
  native claim.
- The capability ledger now has 52 rows with P17 extension coverage. P18 must
  compare its rows with the P01 inventory, investigate additions/removals and
  version drift, and give every supported row a name, scope, invocation, status,
  help source, cost class and test.
- The palette already ranks projects, prompts and local actions. P18 finishes
  the engine-capability part and must not convert local commands into model
  prompts.
- Windows PTY: the discovery report found no Visual Studio Build Tools; check
  whether a prebuilt PTY package is installable before promising a native
  terminal. If not, record the blocker rather than switching the stack.

## Relevant files and spec sections

- `packages/adapter/src/{extensions,configuration,native,http,adapter}.ts`
- `packages/contracts/src/{extensions,configuration,orchestration}.ts`
- `apps/desktop/src/main/{extensions-service,extensions-ipc,provider-workbench,agent-observatory,main}.ts`
- `apps/desktop/src/shared/{extensions,provider,agents,catalog}.ts`
- `apps/desktop/src/renderer/{ExtensionsPanel,ProviderWorkbench,AgentsPanel,App}.tsx`
- `docs/codewhale-capabilities.json`, `docs/evidence/P17-extensions.{md,json}`
- `tools/spike/p17-extensions.mjs`, `tools/spike/qualify-p17.mjs`
- Spec 7.1, 11 terminal/palette, 13, 15; O3/O5.

## Open problem IDs and no-progress counts

No open blocker. `attempts.jsonl` still holds only the closed P02 rows.

New, carried for P18+:
- **P17-ISSUE-001** — project-scope MCP servers and hooks stay hidden/inert
  until the engine records workspace trust and approval. Engine authority; Mona
  does not bypass it.
- **P17-ISSUE-002** — MCP add/remove/connect/login are CLI advanced actions in
  this build; there is no runtime add/remove route. The UI shows the exact
  invocation.
- **P17-ISSUE-003** — plugin install/trust/update and skill install/trust/update
  were not exercised because they stage or execute third-party content. They
  remain engine actions with their own consent step.
- **P17-ISSUE-004** — an isolated `CODEWHALE_HOME` still scans the real
  `~/.codewhale/skills`, producing shadowing warnings that are a probe artifact,
  not a product defect.
- **P17-ISSUE-005** — an MCP health check can start a configured server. That is
  why it is explicit, per server, and never part of page load.

Carried earlier: P15-ISSUE-001..003 (fleet lease, parallel builders, agent-run
history), P16-ISSUE-001..004 (Flash reasoning unknown, offline diagnostics,
engine-owned credentials, providers without catalogs), P01-ISSUE-001..004,
P05-ISSUE-001, P06-ISSUE-002, P07-ISSUE-001, P08-ISSUE-001..003,
P09-ISSUE-001..002, P10-ISSUE-001..003, P11-ISSUE-001, P12-ISSUE-001..003,
P13-ISSUE-001..003, P14-ISSUE-001..004.

## Blocked dependencies

None.

## Last relevant validation

- `npm test` → 403 Vitest (43 files) + 13 bootstrap + 12 launch + 8 spike.
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  347.57 kB (gzip 100.21 kB).
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run check:build -w @mona/desktop` (51 named preload channels), and
  `node tools/build/cli.mjs validate` → pass (r54, 0 warnings).
- `node tools/spike/p17-extensions.mjs --out docs/evidence/P17-extensions.json`
  → 16/16 checks; zero inference; `docs/evidence/P17-extensions.json`.
- Spend: P17 zero. P15 delegated run remains the last paid run (5,731.872 µUSD).

## Human input needed

None to continue P18. Standing acceptance item for P21/P22: right-click a folder
and a folder background in Explorer and choose **Start new DS project with Mona**
(possibly under **Show more options**). The registration currently points at the
development build; remove it with `npm run launch:menu -- unregister` or replace
it at install time.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and one test
string in P14; Prettier does not repair that. `check-build.mjs` fails on mojibake
in the renderer bundle. The remaining `Â·`/`â€™` sequences in `DECISIONS.md` and
older handoff text are quoted examples of that incident, not corrupted text.
