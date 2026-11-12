# Mona build decisions

Append-only. Each decision records what was chosen, why, and what it constrains.
Product-behavior decisions that change `Mona_Project.md` need Victor's agreement.

## D-0001 — Git initialized in place; no remote

- **Decision:** `git init -b main` in `X:\AI_projects\Mona`, repository-local
  identity `Mona Build <mona-build@localhost>`, no remote configured.
- **Why:** the working directory had no repository, and local checkpoint commits
  are required by O1/section 17. Inventing a remote is forbidden.
- **Constrains:** every push requires an existing, clearly authorized Mona
  remote and repository rules. None exists today.

## D-0002 — Bootstrap tooling is plain Node ESM with one pinned schema library

- **Decision:** `tools/build/cli.mjs` (Node 26 ESM) + `ajv` 8.20.0 for JSON
  Schema validation, committed `package-lock.json`, tests on the built-in
  `node:test` runner.
- **Why:** P00 asks for a small validation/checkpoint utility, not a premature
  app framework. ajv is the schema library the later TypeScript packages are
  expected to share; using it now keeps one validation semantic.
- **Constrains:** Electron/React/Vite/SQLite versions are chosen at P02, not
  here. The bootstrap CLI must not become a product dependency.

## D-0003 — Build state is temp-write + rename, with backups, history and a journal

- **Decision:** schema v1 in `.mona/build/state.json`; writes go to
  `.mona/build/tmp`, fsync, then rename; the prior revision is copied to
  `.mona/build/backup/`; each committed revision is copied to
  `.mona/build/history/`; every checkpoint appends to
  `.mona/build/checkpoints.jsonl`; `recover` promotes a complete interrupted
  write or falls back to the newest schema-valid backup.
- **Why:** spec section 8.3 requires atomic replace, monotonic revision checks,
  recovery copies and conflict detection. Revision conflicts exit without
  writing.
- **Constrains:** `backup/`, `history/`, `tmp/` and `.lock` are machine-local and
  gitignored; `state.json` and `checkpoints.jsonl` are shareable and redacted.
- **Verified by:** `npm test` (interrupted write, torn temp, corrupt state,
  stale revision, graph/hash/evidence rejection).

## D-0004 — The requirement ledger mirrors the prompt map exactly

- **Decision:** `docs/requirements.json` registers P00–P23 with the
  prerequisites and requirement IDs from `Mona_PROMPTS.md` section 3, plus all
  30 MONA requirements with 114 acceptance criteria seeded from
  `Mona_Project.md` section 7. `owning_prompts` is the inverse of the prompt map.
- **Why:** traceability must be machine-checkable, and the dependency graph must
  be validated rather than asserted. `validate` rejects missing IDs, unknown
  references, ownership disagreement and cycles.
- **Constrains:** adding a prompt or requirement means updating the ledger; the
  ledger is the source of truth for status, not prose in reports.

## D-0005 — Preserve the existing engine route; no probe spend at P00

- **Decision:** record `deepseek` / `deepseek-flash` /
  `https://api.deepseek.com` (doctor-resolved) and leave config, settings and
  the credential store untouched. A credential entry exists but is unprobed;
  `codewhale doctor` reports "no verified key".
- **Why:** O1 forbids silently changing provider, endpoint, model or
  credentials. P00 is discovery; a live API probe is paid inference and belongs
  to P01's declared pilot ceiling.
- **Constrains:** P01 must verify the route with a bounded
  `codewhale doctor --probe-api` before any G0/G1 claim. Until then the live-test
  prerequisite is open, not assumed passing.

## D-0006 — No extra search/terminal tooling installed yet

- **Decision:** `rg` is not installed; use PowerShell `Select-String` or Node
  for searching. No MCP servers are installed at P00 (doctor reports zero
  configured).
- **Why:** O2 says install only what removes a concrete bottleneck. File reading
  and search are already covered by existing tools.
- **Constrains:** revisit only with a recorded bottleneck.

## D-0007 — `.codewhale/` workspace state is preserved and not committed

- **Decision:** `.codewhale/state/*` (Codewhale's own subagent/session state) is
  left untouched and gitignored.
- **Why:** it is engine-owned runtime state, not project instructions, and may
  contain machine-specific data.
- **Constrains:** project-level MCP configuration (`/.codewhale/mcp.json`) may be
  committed later once it exists and is reviewed; it does not exist today.

## D-0008 — Two state layers stay separate

- **Decision:** building Mona uses `.mona/build/`; the shipped product will own
  project state under `.mona/project/` (P05+).
- **Why:** spec section 8.1 requires the build to bootstrap itself without
  depending on the product, and the product must not depend on the bootstrap
  utility.
- **Constrains:** shared schemas are allowed; shared runtime dependencies are not.
