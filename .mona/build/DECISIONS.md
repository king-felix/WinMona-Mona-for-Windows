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

## D-0009 — Repository checks out bytes exactly (no EOL rewriting)

- **Decision:** `.gitattributes` sets `* -text` and `core.autocrlf=false`.
- **Why:** evidence digests are recorded over working-tree bytes. Git's EOL
  normalization would change file hashes on a fresh checkout and make every
  recorded evidence hash appear stale.
- **Constrains:** text files keep whatever line endings they were authored with;
  editors and scripts must not rewrite line endings gratuitously.

## D-0010 — Bootstrap tests build their own baseline

- **Decision:** `tests/bootstrap` copies the repository (excluding
  `node_modules`, `.git`, `dist`, `out`, `.mona/build`) into a temporary
  directory and runs `cli.mjs init` there instead of asserting against the live
  build state.
- **Why:** the first version asserted `revision 1` against real state and broke
  the moment P00 itself completed. Tests must not depend on build progress.
- **Constrains:** test evidence is fixture-based by nature; runtime/engine
  compatibility claims still require tests against the real binary (P01+).

## D-0011 — HTTP/SSE runtime is the primary integration; exec is one-shot only

- **Decision:** Mona integrates through `codewhale app-server --http` (`/v1/*`,
  bearer token, loopback) behind a versioned adapter. `codewhale exec` is used
  only for verified one-shot jobs and diagnostics, never as a silent substitute
  for the persistent control channel.
- **Why:** P01 contract tests proved auth, thread/turn lifecycle, durable events,
  replay, resume, usage, interrupt, and idempotent submission on `/v1/*`. The
  stdio/socket compatibility transports advertise a narrower surface.
- **Evidence:** `docs/evidence/P01-contract.json`, `P01-g0.json`.
- **Constrains:** P03 must keep the adapter contract-tested against the pinned
  binary; no route may be added from documentation alone.

## D-0012 — Serialize mutating work per workspace by default

- **Decision:** one mutating turn per workspace is the default. Parallel project
  execution stays disabled until Mona owns and verifies a workspace lease.
- **Why:** on Windows the second runtime in the same workspace was not refused;
  two simultaneous tiny turns completed without observed corruption, but one
  observation is not a safety proof, and the upstream changelog says the
  per-workspace lease is Unix-only today.
- **Evidence:** `docs/evidence/P01-g0.json` (concurrent A/C step).
- **Constrains:** P04/P07 must implement the lease before enabling parallelism.

## D-0013 — Persist submission intent and operation key before sending

- **Decision:** every thread create and turn submit carries a client-generated
  operation key persisted locally first. A replay of the same key with the same
  data is accepted idempotently; a replay with different data is a hard error.
- **Why:** the runtime advertises `turn_operation_idempotency`,
  `turn_operation_lookup`, and `thread_create_idempotency`. P01 observed turn
  replay as `200` + `idempotent_replay: true` with the same turn id, and thread
  replay as `201` with the same thread id; a changed request under the same key
  returns `409` and was never substituted.
- **Evidence:** `docs/evidence/P01-contract.json`, `P01-g0.json`.
- **Constrains:** a lost response must never trigger a blind retry. P03 must
  reconcile with the operation key and surface outcome-unknown when the runtime
  cannot answer.

## D-0014 — Cost buckets use cache-hit, cache-miss, and output separately

- **Decision:** cost is computed as
  `hit × 0.003 + miss × 0.15 + output × 0.6` USD per million for the pinned
  `deepseek-flash` route, using rates from the engine's bundled model catalog.
  Reasoning tokens are not added again because the engine includes them in
  `output_tokens`. Unknown buckets remain unknown.
- **Why:** the formula reproduces the engine-reported adapter cost exactly, and
  the stream/period endpoints expose the three buckets.
- **Evidence:** `docs/evidence/P01-bench.json`, `P01-g0.json`.
- **Constrains:** provider billing stays authoritative; P12 must store rate
  provenance and the historical rate revision.

## D-0015 — Runtime token travels through the environment, never argv

- **Decision:** the owned runtime receives `CODEWHALE_RUNTIME_TOKEN` through its
  environment; the client binds only to `http://127.0.0.1:<port>`; credentials
  are never printed, committed, or passed on a command line.
- **Why:** the engine help states `--auth-token` is visible in the process list.
  The client rejects non-loopback base URLs and short tokens at construction.
- **Evidence:** `tests/spike/client.test.mjs`, `tools/spike/runtime/client.mjs`.
- **Constrains:** P02's preload/IPC boundary must never expose the token or
  arbitrary HTTP to the renderer.

## D-0016 — Preserve the route and report fingerprint drift, do not "fix" it

- **Decision:** the configured provider/model/endpoint stay untouched. The
  observed difference between CLI `exec` and runtime endpoint fingerprints
  (`6a440b42…` vs `812b1f7c…`) is recorded as an open issue, not corrected by
  editing config.
- **Why:** wire model, dialect, and tool-schema hash are identical, so this is
  not justification for changing Victor's working route.
- **Evidence:** `docs/evidence/P01-feasibility.md`, `P01-bench.json`.
- **Constrains:** P03 displays the runtime fingerprint actually used; P16 must
  explain or resolve the difference with Victor's consent.

## D-0017 — Desktop stack pinned; TypeScript held at 6.0.3

- **Decision:** npm workspaces; Electron 45.3.0, React 19.3.1, Vite 8.3.8,
  Zod 4.6.7, Vitest 5.1.0, ESLint 10.14.0, Prettier 3.10.0, esbuild 0.28.2.
  TypeScript is 6.0.3 because typescript-eslint 8.72.2 declares a peer range
  below 6.1 and 7.0.2 breaks the lint chain.
- **Why:** one package manager, one schema library, one product test runner, and
  a lockfile are required by P02. Pinning exact versions makes the build
  reproducible; the TS downgrade is a compatibility decision, not a preference.
- **Evidence:** `docs/evidence/P02-foundation.md`, `package-lock.json`.
- **Constrains:** upgrades are deliberate decisions with a green `npm run ci`.

## D-0018 — One narrow preload channel, validated in main

- **Decision:** the renderer receives one frozen API (`getAppInfo`) on
  `mona:app-info`. The main process validates the sender frame and an empty
  payload schema; the preload is a single esbuild CJS bundle because sandboxed
  preloads cannot be ESM.
- **Why:** sandbox + context isolation + no Node integration are only meaningful
  if the bridge is narrow. A typed `IpcResult` keeps failures structured.
- **Evidence:** `apps/desktop/src/preload/preload.ts`,
  `apps/desktop/src/main/ipc.ts`, `security.test.ts`, `ipc.test.ts`.
- **Constrains:** every later IPC addition needs its own channel, schema, sender
  check, and test; no generic `invoke` bridge.

## D-0019 — Vitest is the product test runner; node:test stays for P00 tooling

- **Decision:** product/contract/renderer tests run under Vitest (with
  happy-dom for renderer DOM tests). The P00 bootstrap and P01 spike suites stay
  on `node:test` because they exercise the bootstrap utility and the throwaway
  spike, not the product.
- **Why:** P02 requires one test runner for the product; rewriting working
  bootstrap tests would add risk without value.
- **Constrains:** `npm test` runs all three groups; product code must not depend
  on `node:test`.

## D-0020 — Electron runtime download is an external blocker, not a code gap

- **Decision:** do not switch desktop shells, fake the window smoke test, or
  weaken the runtime check. Record `P02-ELECTRON-BINARY` after three
  no-progress attempts and continue build/test evidence that does not require
  the binary.
- **Why:** only `registry.npmjs.org` resolves here; GitHub, objects storage, and
  every tested mirror fail DNS. The npm tarball contains no runtime.
- **Evidence:** `docs/evidence/P02-electron-blocker.txt`,
  `.mona/build/attempts.jsonl`, `BLOCKERS.md`.
- **Constrains:** the window/process-footprint acceptance item stays unverified
  until the binary is available; no runtime-compatibility claim may be made.

## D-0021 — Adapter lives in `packages/adapter`, not the renderer

- **Decision:** the versioned adapter is a Node-only workspace package with a
  typed `Result` surface and a small capability allowlist. The Electron main
  process will own it; the renderer never imports it.
- **Why:** P03 requires a reusable, contract-tested client independent of the
  UI and of the P01 spike. Keeping it Node-only preserves the P02 process
  boundary.
- **Evidence:** `docs/evidence/P03-adapter.md`, `packages/adapter/src`.
- **Constrains:** any new capability needs a contract test and a compatibility
  gate; unsupported operations return typed reasons.

## D-0022 — Persist intent, never retry a possibly accepted write

- **Decision:** a `SubmissionJournal` record is written before the POST; a lost
  response becomes `outcome_unknown`; reconciliation uses only the read-only
  operation lookup. The POST is never repeated automatically.
- **Why:** the runtime advertises idempotent operation keys and lookup, but a
  client cannot prove exactly-once from local journaling alone. P01 observed
  replay as `200` + same turn and 409 on changed data.
- **Evidence:** `packages/adapter/src/adapter.test.ts`,
  `docs/evidence/P03-live.json`.
- **Constrains:** P05 may swap the journal implementation but not the semantics.

## D-0023 — Event projection is cursor-based, bounded, and tolerant

- **Decision:** dedup by durable `seq`; reconnect with `since_seq`; bounded
  exponential backoff; drop oversized frames with a diagnostic; keep unknown
  events; report malformed known payloads as schema drift without killing the
  stream.
- **Why:** replay must never re-execute work or double-count charges, and one bad
  frame must not take down a long job.
- **Evidence:** `packages/adapter/src/sse.ts`, `adapter.test.ts`,
  `docs/evidence/P03-live.json`.
- **Constrains:** the renderer receives projected events, never raw transport
  frames.

## D-0024 — Usage buckets come from the endpoint that preserves their meaning

- **Decision:** thread usage maps `totals.input_tokens` to cache-miss, `cached_tokens`
  to cache-hit, and `output_tokens` to output; `turn.usage.input_tokens` is total
  input and must not be mixed into that projection. Reasoning tokens are already
  included in output on this route (D-0014).
- **Why:** the two surfaces use different `input_tokens` semantics; mixing them
  would double-count or misprice. Unknown cost remains a typed unknown.
- **Evidence:** `packages/adapter/src/mapping.ts`, P01 cost formula checks.
- **Constrains:** P12's ledger stores buckets plus source/provenance, not a bare
  total.
