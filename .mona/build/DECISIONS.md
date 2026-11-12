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

## D-0025 — External blockers record resolution; counters are closed by evidence

- **Decision:** when a recorded blocker's prerequisite appears, retry the
  blocked action, append a closing attempt row with `material_progress: true`
  and `resolution: prerequisite_obtained`, and move the blocker to `Resolved`.
  The original no-progress rows stay in `attempts.jsonl`.
- **Why:** P02-ELECTRON-BINARY turned out to be a transient failure of the local
  resolver, not a network policy. The honest record is "three attempts made no
  progress, a fourth obtained the prerequisite", not "the blocker never existed".
- **Evidence:** `.mona/build/attempts.jsonl` (4 rows),
  `docs/evidence/P02-smoke.json`, `BLOCKERS.md` Resolved section.
- **Constrains:** a resolved prerequisite does not retroactively justify prose
  claims made while it was blocked; the earlier reports keep their original
  blocker note in `P02-electron-blocker.txt`.

## D-0026 — The window smoke proves security behaviour, not just rendering

- **Decision:** `npm run smoke -w @mona/desktop` launches the production build
  and additionally drives `location.assign('https://example.com/')` and
  `window.open('https://example.com/')` inside the real renderer, asserting the
  URL is unchanged, the popup returns null, the window count stays 1, DevTools
  are closed, the preload exposes exactly one frozen key, and no Node or
  `ipcRenderer` globals exist. Any failure exits non-zero.
- **Why:** P02 acceptance requires remote navigation and privileged popups to be
  refused. Reading `security.ts` is not evidence that the running app refuses
  them.
- **Evidence:** `apps/desktop/src/main/main.ts` (`runSmoke`),
  `apps/desktop/scripts/smoke.mjs`, `docs/evidence/P02-smoke.json`.
- **Constrains:** later prompts that add windows or IPC must extend this smoke
  rather than replace it with a screenshot.

## D-0027 — Source files are edited with byte-safe tools only

- **Decision:** edit repository source with the file tools (or Node with explicit
  `utf8`), never by round-tripping through PowerShell 5.1 `Get-Content` /
  `Set-Content`, and never add a dependency on a non-ASCII byte sequence in a
  validator. `tools/build/cli.mjs` now matches prompt headings with the
  ASCII-only pattern `^### (P\d{2})(?=\s)`.
- **Why:** a `Get-Content -Raw` / `Set-Content -Encoding utf8` round-trip
  double-encoded four files during P02 verification (an em-dash regex literal,
  the `héllo` test fixture, and the `package.json` description). The corrupted
  regex silently stopped matching every prompt heading, so `validate` reported
  all 24 prompt sections missing even though the document was untouched.
- **Detection:** a repo-wide mojibake scan (`â€`, `Ã¢`, `ï¿½`) plus the fact that
  `.gitattributes` stores bytes exactly, so an encoding change shows up as a
  real diff.
- **Evidence:** this session's diff; `node tools/build/cli.mjs validate` returns
  OK at revision 9; `tests/bootstrap` 13/13.
- **Constrains:** any future validator that parses the specification must be
  ASCII-only or operate on parsed structures, so an encoding accident cannot
  masquerade as a content failure.

## D-0028 — Ownership is (workspace lease, pid, creation time), never a pid alone

- **Decision:** every owned runtime has a machine-local record keyed by the
  normalized workspace, holding executable realpath + size + mtime, engine
  version and commit, pid, **process creation time**, parent pid, desktop
  instance id, loopback endpoint, and a token digest. Any lifecycle decision
  that could terminate a process compares the recorded creation time with the
  live one; a mismatch means the pid was reused and the record is marked
  `stale` without touching the process.
- **Why:** pids are reused on Windows, and P01-ISSUE-002 showed a second runtime
  can start in one workspace. Without creation identity, "kill the pid in our
  record" can kill an unrelated process — the exact harm P04 forbids.
- **Constrains:** the record never contains the token (digest only), never lives
  in a project repository, and is written atomically. Reclaiming a previous
  instance's runtime is allowed only with a matching creation time; an
  unverifiable live pid is reported and left running.

## D-0029 — Windows cleanup is `taskkill /T` on one verified pid; Job Objects are deferred

- **Decision:** descendant cleanup walks the OS parent/child relation for the
  single owned pid (`taskkill /PID <pid> /T`, then bounded `/F`), polls every
  observed descendant by pid, and never selects processes by image name. A
  Windows Job Object with `KILL_ON_JOB_CLOSE` is the stronger mechanism and is
  deferred until a native addon or helper binary can be built and qualified.
- **Why:** there is no MSVC toolchain on this host (BLOCKERS prerequisite
  table), and `taskkill /T` plus creation-identity reconciliation is testable
  today: `supervisor.test.ts` stops a real parent/child tree while an unrelated
  node process survives, and the live run stops the real engine with its child.
- **Constrains:** forced desktop termination leaves the runtime alive until the
  next start reconciles; this is documented as bounded recovery, not as a
  daemon guarantee. Revisiting Job Objects requires a recorded build
  prerequisite, not a silent dependency swap.

## D-0030 — Losing a window never abandons owned work; the tray arrives at P07

- **Decision:** closing the window while Mona owns a runtime prevents the close
  and hides the window; `window-all-closed` quits only when nothing is owned;
  a renderer crash destroys the dead window and recreates exactly one window
  while the runtime continues. Relaunching the app restores the existing window.
- **Why:** the probe exposed a real defect — destroying the crashed last window
  fired `window-all-closed` → `app.quit()` → stop during a renderer crash, which
  would have thrown away work precisely when the spec requires it to survive.
- **Constrains:** until the tray icon exists (desktop shell, P07), a hidden
  window is restored by launching Mona again. Quit remains the only path that
  stops owned children, and it does so deliberately.

## D-0031 — Pause, interrupt, cancel and quit are four transitions with four receipts

- **Decision:** `pause_after_task` is a Mona queue boundary and never calls the
  engine; `interrupt_now` requires an engine receipt and reports
  `outcome_unknown` when the channel is missing or fails, leaving active work in
  place; `cancel_queued` removes future starts and refuses the running task;
  `quit_and_stop` interrupts (best effort), then stops the owned runtime, and
  reports `partial` if either half is uncertain. Every receipt carries
  `rollback_claimed: false`.
- **Why:** the specification forbids collapsing these, and a forced termination
  cannot promise rollback of already-sent requests or external side effects.
- **Constrains:** the desktop interrupt path stays honestly unknown until a
  project binds a submission journal (P05/P08). No receipt may claim success
  that the engine did not acknowledge.
## D-0032 — SQLite through `node:sqlite`, with a single in-process write path

- **Decision:** local project state is SQLite opened through Node's built-in
  `node:sqlite` (`DatabaseSync`, `backup`), not `better-sqlite3` or a native
  driver. Every mutation goes through `ProjectStore.write()`, which holds the
  maintenance barrier and one `BEGIN IMMEDIATE` transaction.
- **Why:** no native module to compile (there is no MSVC toolchain), the online
  backup API is built in, and one write path makes revision checks and the
  maintenance barrier enforceable in one place instead of by convention.
- **Constrains:** the barrier is in-process. Cross-process safety rests on
  SQLite's own locking (`BEGIN IMMEDIATE`, `busy_timeout`), and Mona's
  single-instance lock keeps a second desktop owner from appearing. A future
  external writer must respect both, not invent a third path.
- **Evidence:** `packages/project-state/src/{db,store,barrier}.ts`,
  `P05-tests.txt` (crash, stale revision, maintenance refusal).

## D-0033 — Two maintenance modes: exclusive and snapshot

- **Decision:** `exclusive` (migration, restore) refuses reads and writes until
  in-flight work drains; `snapshot` (backup) refuses writes but keeps reads
  available. Both are entered through the same barrier that every writer uses.
- **Why:** restore replaces the database file, so a read during it could observe
  a half-written file; backup does not move the file, and blocking the UI for it
  would be a self-inflicted freeze.
- **Constrains:** any new maintenance operation must declare which mode it needs.
  A write that requires the barrier gets a typed `maintenance` error rather than
  a retry loop inside the store.

## D-0034 — Project identity is path + inode + marker, and moving needs a rebind

- **Decision:** a project is keyed by its canonical path and filesystem identity
  (device + inode), with an optional marker document at
  `.mona/project/project.json`. Registration resolves aliases (same folder,
  junction, same inode) to the existing project, and refuses to create a second
  project from a marker found at a new path until the caller explicitly rebinds.
  Git worktrees are separate roots that share the canonical `.git` key.
- **Why:** the specification requires ids that are stable independently of path,
  deliberate rebinding after a move, distinct worktree roots, and no accidental
  duplicates. Copy-and-register would violate all four.
- **Constrains:** the marker is additive and small; losing it degrades relocation
  detection to path/inode matching. Removing a catalog entry never deletes user
  files, and the tests assert the folder and marker survive removal.