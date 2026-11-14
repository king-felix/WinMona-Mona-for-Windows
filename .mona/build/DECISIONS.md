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
- **Detection:** a repo-wide scan for double-encoded UTF-8 (the byte sequences
  `C3 82`, `C3 A2` and the replacement character `EF BF BD`) plus the fact that
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
## D-0035 — The design system lives in `packages/ui`, measured by its own tests

- **Decision:** tokens, primitives, overlays and the visual harness live in
  `packages/ui`. Contrast requirements are computed from the shipped
  `tokens.css` by `contrast.test.ts`, so a palette edit that fails WCAG breaks a
  test.
- **Why:** the specification's palette is a starting point, not a validated
  claim. Two real failures were found this way (`--border-strong` below 3:1, and
  coral used as a status colour at 4.10:1) and fixed by changing the tokens.
- **Constrains:** decorative accents (`--accent-coral`, `--accent-sea`) may never
  become status text; status text uses the measured `--success/--attention/
  --critical/--info` tokens, and every badge carries a glyph and a word.

## D-0036 — Status meaning is never colour alone

- **Decision:** every badge renders a glyph (`✓ ! ✕ i ○`) and a word; every
  notification carries a badge and a heading; toasts/notifications use
  `role="status"` for polite updates and `role="alert"` for critical failures.
  The audit counts colour-only status elements and fails if any exist.
- **Why:** WCAG 1.4.1 and the product's own "no colour-only meaning" rule; a
  red dot alone is unusable for a colour-blind reader and unclear in a
  screenshot.
- **Constrains:** new status surfaces must extend the Tone union rather than
  inventing a colour.

## D-0037 — Screenshots and the accessibility sweep are one reproducible command

- **Decision:** `npm run shots -w @mona/desktop` loads the labelled harness in a
  real Electron window, captures both themes and both densities at 1280×800 plus
  1920×1080 and 200% scaling, drives a real Tab traversal, and writes
  `docs/evidence/P06-shots.json` plus the PNGs. Capture uses the DevTools
  protocol because `capturePage()` fails with `UnknownVizError` on this host.
- **Why:** screenshots and keyboard access must be observed, not asserted, and a
  manual screenshot ritual would not survive the next prompt.
- **Constrains:** the harness is fixture data reachable only with `?harness=1`,
  and P07 must move it behind a development-only flag once the real shell exists.
## D-0038 — Catalog actions live in one service, the store keeps the single write path

- **Decision:** every shell action (open, create, rename, pin, archive, remove,
  relocate, reveal, select, engine start/stop, spend) goes through
  `CatalogService` in the main process. It validates input, maps store failures
  to renderer-safe `ErrorResult` codes, and delegates mutations to
  `ProjectStore`, which keeps its maintenance barrier, revision checks and
  one-transaction write path.
- **Why:** the acceptance criteria are behavioural ("aliases deduplicate",
  "removal never deletes", "switching stays isolated"), and those are testable
  against a service far more cheaply than against a window. The live probe then
  proves the same service through the real bridge.
- **Constrains:** the renderer never touches SQLite, filesystem paths or the
  engine directly; new catalog features must grow the service and the channel
  list together, and `check-build.mjs` fails on an unexpected channel.

## D-0039 — Drafts are machine-local UI state, not project content

- **Decision:** selected project, last view per project and unsent drafts per
  project/session live in an atomically written `ui-state.json` beside the
  SQLite database. Sessions are bounded (20) and draft text is bounded (200k
  characters). An unreadable file is set aside as `ui-state.json.corrupt-<ts>`
  with a visible warning instead of being overwritten.
- **Why:** a project export must not carry half-written text, and a reload must
  not lose a draft. Keeping it out of the project database also keeps
  `MONA-005`'s "catalog entry removal never touches project files" trivially
  true for drafts.
- **Constrains:** drafts are per machine and per install; they are not portable,
  and the UI must not promise otherwise.

## D-0040 — A moved folder is a relocation, an alias is the same project

- **Decision:** the same filesystem identity at a new path is a
  `relocation_required` when the previously recorded path no longer exists, and
  an `alias` (same project) when it still does. A project marker at a new path
  is always `relocation_required`. Only an explicit `relocateProject` with the
  expected revision rebinds.
- **Why:** P07's acceptance names both cases, and they need opposite answers:
  opening a junction must not create a duplicate, opening a moved folder must not
  silently rewrite identity. The observable difference is whether the old path
  still exists.
- **Constrains:** moving a project while the old path still exists (a copy, not a
  move) requires the explicit `Locate…` action; Mona will not guess.

## D-0041 — The fixture harness is development-only, enforced in the main process

- **Decision:** the renderer renders `?harness=1` only when `AppInfo`
  reports `harnessEnabled`, which the main process sets for a dev-server session
  or `MONA_ALLOW_HARNESS=1`. The screenshot runner sets the flag; production
  smoke asserts the harness never renders, and `check-build.mjs` still rejects
  the fixture marker in the bundle.
- **Why:** P06 shipped the harness behind a query parameter, which is reachable in
  production. A query parameter is not a development flag; the main process has
  to be the one that decides.
- **Constrains:** any new development-only surface needs the same treatment:
  decided in the main process, asserted by the smoke run.

## D-0042 — The composer comes before the connection explanation

- **Decision:** in the studio, the draft composer renders above the engine
  connection block and the execution-disabled explanation.
- **Why:** at 1280×800 the composer was below the fold in the first live capture.
  The specification asks that the main task and composer stay usable at that
  size; a screenshot, not a review, is what caught it.
- **Constrains:** status or diagnostic copy must never push the primary input out
  of the first viewport. Live screenshots are part of the check, not decoration.

## D-0043 — Mojibake is a build failure, not a review finding

- **Decision:** `apps/desktop/scripts/check-build.mjs` fails when the renderer
  bundle contains double-encoded UTF-8 sequences (`C3 82`, `C3 A2` + `E2 82 AC`,
  `C2 B7`). Source files are edited with byte-safe tools; PowerShell text
  round-trips are not used for source.
- **Why:** P07 hit the P02 failure mode again through `Get-Content`/`Set-Content`
  and it reached a rendered screenshot as `Â·` and `â€™`. A rule in a document did
  not prevent it; a failing check will.
- **Constrains:** the check is a bundle check, so it cannot catch corruption in a
  file that never reaches the bundle — those remain covered by
  `npm run format:check` and by reading what the build produced.

## D-0044 — A studio thread belongs to one Mona session and one mode

- **Decision:** the studio binds one engine thread per (project, session) and
  engine mode. Bindings live in the project database (`threads.session_id`,
  `threads.mode`, `threads.profile_json`); Plan and Work reuse their own thread
  when the user returns to that mode.
- **Why:** Mode is a property of an engine thread, not a per-turn flag. Reusing a
  thread per mode keeps the transcript and the runtime's history aligned, and
  keeps switching modes from silently mixing plan text into an executing thread.
- **Constrains:** changing mode opens a thread; it never rewrites an existing one.
  A thread bound to another workspace is left stored and untouched.

## D-0045 — The timeline is a projection, not a transcript of raw payloads

- **Decision:** `StudioService` projects each engine event into a typed timeline
  item with a bounded body. Known item kinds become user/assistant/tool/status/
  outcome rows; internal status items, provider requests and tool-schema
  snapshots go to Diagnostics; unknown events become one redacted diagnostic
  line. Deltas are appended in memory and flushed at most every 250 ms.
- **Why:** the pinned runtime emits many event families that Mona's contracts
  package does not model. Rendering them as content would invent structure;
  dropping them would hide state. A projection with an explicit mapping is testable
  and honest.
- **Constrains:** an item body never exceeds 64 KB in storage; larger output is
  labeled truncated, and the renderer expands on demand. A replayed `seq` is a
  no-op (unique index plus renderer sequence check).

## D-0046 — An approval wait is surfaced and interruptible, never answered by guesswork

- **Decision:** `approval.required`, an unrecognized `approval.*` event, and a
  `request_user_input` tool call in progress all produce a pending card, a run
  state of `awaiting_approval`, and an Interrupt-now action. Mona does not POST an
  approval decision in P08.
- **Why:** Full Access is Victor's engine posture, not permission for Mona to
  invent an answer to a question the runtime asked. The runtime exposes approval
  events; Mona has no qualified approval-response contract. Leaving the wait
  invisible would be the failure the spec forbids.
- **Constrains:** the capability is reported as unsupported in the studio view,
  with the reason, until an approval route is contract-tested.

## D-0047 — Model output is rendered by an escaped, anchor-free Markdown renderer

- **Decision:** `packages/ui/src/markdown.tsx` parses a small Markdown subset into
  React text nodes. Raw HTML is never interpreted; links become inert label +
  address text with no `href`.
- **Why:** the renderer is privileged. A summary of the security model is not
  enough; the renderer itself must have no path to navigation, no anchor, and no
  HTML injection. Tests assert the HTML is text and no anchor exists.
- **Constrains:** no external link opening from model output in v1; help links
  are a separate, validated shell action.

## D-0048 — Turn cost is attributed by the engine-priced thread delta

- **Decision:** on completion the studio reads `/v1/threads/{id}/usage`, compares
  it with the usage rows already recorded for that thread, and records only the
  difference, with source `engine_priced:thread_delta:<revision>`. When the engine
  reports no complete price, the turn's token counts are recorded with
  `costKnown = false` and the cost is shown as unknown.
- **Why:** `/usage` reports thread totals, not per-turn cost. Recording the total
  on every turn would overcount; showing $0.00 for a priced turn would lie.
  A delta against recorded rows is durable across restarts and idempotent.
- **Constrains:** a first completion after a manual database edit can attribute a
  larger delta; the source label exposes that. Unknown price is never zero.

## D-0049 — The saved DS profile is seeded once and displayed separately from the observed one

- **Decision:** the first launch writes `{ label, profile, provider, model,
  endpoint, permissionPosture: full_access, allowShell, trustMode, autoApprove }`
  to `settings_versions(scope = profile, version 1)` and reads it back on later
  launches. The context bar shows the saved label; the studio shows the posture
  the engine reported for the bound thread, or labels the saved value as saved.
- **Why:** "configure once and show it persistently" must not turn into a
  hard-coded badge. The observed thread record is the only authority for what the
  running engine actually applied.
- **Constrains:** existing saved values are not overwritten; a different observed
  posture is displayed as observed, never rewritten to match the saved intent.

## D-0050 — A launch is one serialized receipt owned by the main process

- **Decision:** every shell selection becomes an intent in one FIFO queue. The
  main process resolves the path, opens or reuses the project, records the
  studio view, starts the owned runtime and emits one receipt. The renderer only
  mirrors the receipt, refreshes the catalog, selects the project and focuses the
  composer.
- **Why:** a second instance, a broad root and a busy runtime are main-process
  facts. Letting the renderer re-open paths would race the queue, duplicate
  selections and lose the reason a launch did not become ready.
- **Constrains:** identical pending launches coalesce; later launches wait for
  earlier ones; a receipt is the only thing the renderer acts on; starting a
  runtime is still not a task and no submission is made.

## D-0051 — The parsed launcher command crosses the single-instance boundary as data

- **Decision:** each instance parses its own argv before requesting the lock and
  passes `{ monaLaunch }` as `additionalData`. The owner validates it with
  `coerceLaunchCommand` and uses it in preference to the `second-instance` argv.
- **Why:** live Windows evidence showed Chromium re-serializes the forwarded
  command line and detaches `--path` from its value. Parsing that argv cannot
  recover the selection; ignoring the problem would have shipped a broken
  right-click that a simulated `second-instance` event would never reveal.
- **Constrains:** the forwarded data is untrusted input and is schema-checked;
  the argv parser stays as the fallback; the documented CLI contract is unchanged.

## D-0052 — Broad roots ask for a project folder; UNC/WSL opens with a caveat

- **Decision:** drive roots, share roots and WSL distribution roots are routed to
  the existing folder picker and never registered. A folder below a UNC or WSL
  root opens normally and records that the pinned runtime is not qualified there.
- **Why:** spec 14 forbids whole-drive indexing, and pretending a network or WSL
  workspace is a qualified runtime environment would be false.
- **Constrains:** no recursive enumeration anywhere; no copying or indexing of
  remote content; the caveat is displayed with the launch receipt.

## D-0053 — The classic context menu is a milestone with named keys and an exact label

- **Decision:** register `Directory\shell\Mona.StartNewProject` and
  `Directory\Background\shell\Mona.StartNewProject` per user with the label
  **Start new DS project with Mona**, an owned marker, `NeverDefault`, single
  selection, and a quoted `"%V"` command. Uninstall deletes only those keys.
- **Why:** P09 must deliver a working Explorer entry without pretending the
  modern Windows 11 menu exists. A named, marked pair of keys makes ownership
  provable and removal safe.
- **Constrains:** no writes outside those keys; no path interpolation into a
  command string; Windows 11 may show the entry under "Show more options"; P21
  replaces the development executable path with the packaged one and delivers
  `IExplorerCommand`.

## D-0054 — A launch starts a runtime but never a task

- **Decision:** launching opens/selects/records and, when possible, starts the
  owned runtime. It never creates a thread, submits a prompt, creates a queue
  item or records usage. If another workspace owns the runtime, the project opens
  with an explicit caveat and the runtime is left alone.
- **Why:** "start the headless runtime" is not "invent a task for the user", and
  silently stopping someone else's runtime would be worse than a truthful
  refusal.
- **Constrains:** zero provider requests from a launch; the composer is focused
  and blocked with the existing reason when the runtime serves elsewhere.

## D-0055 — A task has one recorded execution owner and one active run per workspace

- **Decision:** every task stores `execution_owner = mona_queue | native_workflow`.
  The Mona queue selects and claims only its own tasks. SQLite enforces one
  active task (`running` or `verifying`) per project with a partial unique index.
- **Why:** spec 10.3 forbids the queue and a native workflow from independently
  scheduling the same task. A scheduler comment is not a guarantee; the database
  refusing the second active row is.
- **Constrains:** a native-owned task is visible on the board but never claimable
  by Mona; two workspaces may each run one task; a blocked or interrupted task
  does not occupy the active slot.

## D-0056 — Completion is a state transition over recorded evidence, never a model claim

- **Decision:** only `verifying` tasks can complete. Completion re-hashes every
  linked artifact, requires all required check and human-only criteria to be
  satisfied, rejects stale evidence, and requires at least one configured
  criterion. Checks record the hash of a real project-relative artifact; a
  supplied hash must match it. Human-only criteria are satisfied only by an
  explicit actor/note call.
- **Why:** a model saying "done" is a report, not proof. The project state must
  be able to refuse a false completion even when the caller is confident.
- **Constrains:** an executor cannot complete a task through the run control; it
  can only record checks and steps. A changed artifact reopens a completed task
  from `completed` to `verifying`, the one transition beyond the sketch in spec
  8.2, because post-completion verification can become stale.

## D-0057 — Imported plans are inert pending data until an explicit start

- **Decision:** `mona.task-plan` imports validate schema, ids, prerequisites and
  cycles without writing by default. `apply: true` inserts every task as
  `pending` with no claim, start time, evidence or dispatch. Project export
  schema v2 carries task criteria, steps, requirement links and evidence paths;
  an exported active task imports as `interrupted`.
- **Why:** importing a plan must not spend money or invent execution, and a
  machine restart is not evidence that a previous run is still alive.
- **Constrains:** import is a replace, not a merge; a digest-valid export that
  marks a task completed with an unsatisfied criterion is refused; user-authored
  criteria, requirement ids and prompt text survive the round trip.

## D-0058 — Selection is deterministic and every exclusion is explained

- **Decision:** eligible Mona tasks sort by interrupted-first, then ordinal,
  prompt id, creation time and task id. Each board entry carries its status,
  prerequisite, owner and workspace checks with a human-readable reason.
  `runOnce` executes exactly one selection and then stops.
- **Why:** "what should I do next?" must have a reproducible answer, and a
  blocked or native-owned task must not look merely unlucky.
- **Constrains:** prerequisites must be `completed` (not merely skipped); a
  missing workspace is ineligible; `runOnce` never loops into a second task.

## D-0059 — Product task state stays separate from Mona's own build ledger

- **Decision:** the task engine writes project-scoped SQLite state and a
  project-local handoff; Mona's build still uses `.mona/build/state.json`,
  `attempts.jsonl` and the bootstrap CLI. Shared semantics (revision checks,
  evidence hashes, deterministic handoff) do not become a shared file.
- **Why:** spec 8.1 requires the two layers to remain distinct, and a user
  project must not be able to corrupt or impersonate Mona's build state.
- **Constrains:** the product never depends on the bootstrap utility to boot; the
  bootstrap validator stays the authority for the Mona ledger only.

## D-0060 — One problem id per symptom, derived rather than minted

- **Decision:** a problem id is `prb_sha256(project_id + symptom_fingerprint)`,
  with a unique index on `(project_id, symptom_fingerprint)`. The attempt counter
  belongs to that row; a new session or a new task that meets the same symptom
  lands on the same counter.
- **Why:** spec 8.4 and O3 both say a new session must not reset the count. A
  model-chosen id string is a rename waiting to happen; a digest is not.
- **Constrains:** re-wording a symptom creates a different problem. That is
  acceptable because the fingerprint is recorded verbatim, and the board shows
  it; it is not acceptable to derive ids from attempt order.

## D-0061 — Two counters, and only one of them may reset

- **Decision:** `total_attempts` is append-only per problem.
  `consecutive_no_progress` resets only through an attempt that records
  `material_progress = true` **and** a `progress_reason`. Supplying one without
  the other is refused. Acknowledgement, reopening and session restarts leave
  both counters as they were, except that reopening resets the consecutive count
  with the new evidence recorded in `problem_transitions`.
- **Why:** O3 requires material progress to be demonstrable. Making the reason
  mandatory is what distinguishes "a required test now passes" from "more code".
- **Constrains:** the store refuses an inconsistent attempt row, so a caller
  cannot hand-wave progress through a boolean alone.

## D-0062 — The block lives in the database, not in the scheduler

- **Decision:** the third consecutive no-progress attempt transitions the
  problem to `blocked` in the same transaction that appends the attempt.
  `TaskService.claim`, `resumeTask` and `AttemptService.assertDispatchable`
  refuse a task whose problem is blocked, and `eligibilityFor` propagates the
  block to dependants with the problem id in `blockedByProblemIds`.
  `WorkQueue.blockOnProblem` puts the queue in a `blocked` state that
  `resumeQueue` cannot clear.
- **Why:** "stop trying" has to be true for every dispatch path, including a
  future one that forgets to check. The database row plus three call-site checks
  is the smallest mechanism that survives new callers.
- **Constrains:** a blocked task must be reopened (with evidence or a Victor
  decision) before it can be claimed; independent tasks in the same workspace
  stay eligible and are selected.

## D-0063 — Pause is Mona's boundary; a native owner gets a partial receipt

- **Decision:** `pauseAfterTask({ nativeDispatcherActive })` returns
  `outcome: 'partial'` with a detail naming the native workflow whenever a
  native dispatcher owns the run. `StudioService.pause` accepts this through an
  injected `nativeDispatcherActive` probe.
- **Why:** spec 10.3 separates queue boundaries from engine operations, and spec
  8.4 forbids promising enforcement Mona does not have. Silently claiming a
  pause while a native goal keeps dispatching would be exactly that promise.
- **Constrains:** a full native pause needs the native surface (P15). Until
  then, the receipt says so and the studio shows the partial detail.

## D-0064 — Engine-internal attempt loops are cooperative, and the UI says so

- **Decision:** Mona enforces attempt limits on its own dispatch and on structured
  attempt reports. Inside one engine turn it injects a stable
  `ENGINE_ATTEMPT_INSTRUCTION` and shows the enforcement boundary. It never
  parses error strings to infer a loop, and it never pays a second model to
  watch for repetition.
- **Why:** a heuristic counter over log text is a guess presented as a
  guarantee, which spec 8.4 explicitly forbids.
- **Constrains:** `docs/evidence/P11-attempts.md` is the reference for what is
  guaranteed; later prompts must not upgrade that claim without a verified
  engine event.

## D-0065 — Three cost origins, and unknown is a value

- **Decision:** every usage record is `provider_reported`, `estimated` (a recorded
  rate revision applied locally) or `unknown` (with a reason). Unknown carries no
  cost value and is excluded from subtotals rather than added as zero.
- **Why:** spec 9.3 requires provider-reported cost, local estimates and missing
  data to be distinguishable, and "unknown cost ≠ zero" is a project
  non-negotiable.
- **Constrains:** the store refuses a cost value on an unknown row; the CSV
  export labels the origin per row; the UI must not format a null as `$0.00`.

## D-0066 — Rate revisions are append-only and recalculation is a view

- **Decision:** `rate_cards` is keyed by `(provider, model, revision)`;
  re-inserting an existing revision with different numbers is a `conflict`.
  Usage rows keep the `rate_revision` that priced them. `recalculate` returns a
  projection under another revision and writes nothing.
- **Why:** spec 9.3 forbids retrospective rewriting of historical pricing without
  an explicit recalculation view; a mutable rate row would silently rewrite every
  past estimate.
- **Constrains:** nothing may UPDATE a rate card's numbers. A price change is
  a new revision with a later `effective_from`.

## D-0067 — Budgets warn before dispatch and disclose their own limit

- **Decision:** budgets are optional and scoped to session, project or day. A day
  scope resolves to a UTC window computed from an explicit timezone offset.
  Evaluation compares `spent + unreleased reservations` to warn/stop thresholds
  and returns `allow | warn | block_next_dispatch`; only the *next* dispatch is
  blocked, and every evaluation carries a disclosure string.
- **Why:** spec 9.3 permits optional user-set limits but forbids presenting them
  as an invoice cap. The disclosure travels with the result instead of living in
  documentation only.
- **Constrains:** no mandatory budget for ordinary authorized work; in-flight
  turns are never interrupted for cost; unknown records are reported, not priced.

## D-0068 — Change attribution comes from recorded tool paths, not from timing

- **Decision:** a change is labeled `tool_recorded` only when its path appears in
  the recorded tool-event set; everything else is `unattributed`. Pre-existing
  user edits are already inside the baseline and therefore never appear as agent
  work.
- **Why:** spec 7 and 11 require distinguishing attributable tool changes from
  workspace-wide deltas, and explicitly forbid inferring sole agent authorship
  from timing.
- **Constrains:** no heuristic promotion of `unattributed` to `tool_recorded`; a
  missing baseline produces `comparable: false`, not an empty diff.

## D-0069 — A baseline is a hash map, not a snapshot engine

- **Decision:** `change_baselines` stores path/sha/size/binary per file with
  explicit exclusions and a file cap. Restore is Git `checkout --` behind a hash
  guard. Non-Git folders report restore as unsupported.
- **Why:** spec 11 says not to build a second incomplete snapshot engine as a
  workaround for missing native behaviour. A hash map answers "what changed"
  cheaply and cannot be mistaken for a restorable snapshot.
- **Constrains:** restore refuses on staged changes, conflicts, untracked paths
  and any hash mismatch; `reset --hard` and blanket clean are never used.

## D-0070 — Selected commits use pathspecs, never the index

- **Decision:** commit runs `git commit -m <msg> -- <paths>`, so only the selected
  paths enter the commit and unrelated staged entries stay staged.
- **Why:** spec 11 requires staged/unstaged/user work to stay separate and
  forbids touching unrelated staged work. Committing the index would sweep a
  user's staged file into an agent commit.
- **Constrains:** a caller must pass explicit paths; an empty path list is
  refused; `git` is invoked with an argument array and no shell string.

## D-0071 — Editor writes are hash-guarded

- **Decision:** `writeFileFresh` requires either `expectedSha256: null` (the file
  must not exist) or the current file hash. A mismatch is a `conflict`, and the
  write happens through an fsynced temp file plus rename.
- **Why:** spec 11 requires fresh revisions and conflict detection, and forbids
  overwriting an externally edited buffer.
- **Constrains:** callers must keep the hash they read; there is no
  "force overwrite" escape hatch in the service.

## D-0072 — The brief is a projection, never a summarizer

- **Decision:** `BriefingService` reads the task board, attempt cards, cost
  totals, test receipts and Git status and assembles a typed structure. It never
  calls a model, never generates prose, and never computes a completion
  percentage. Unknown spend is labeled `unknown`; changed files are `unknown`
  rather than zero when neither Git nor a baseline exists.
- **Why:** spec 12 and the P14 economics rule forbid a background summarizer or
  an inference-shaped convenience. A deterministic projection can be checked
  against its source rows; a summary cannot.
- **Constrains:** every field must name a recorded source. New brief fields need
  a service or row that already exists, not a new inference path.

## D-0073 — Quiet hours silence delivery, not computation

- **Decision:** `NotificationPlanner` evaluates quiet hours at event time in
  the configured zone (`local` by default, so travel and DST move the window).
  A suppressed event is remembered and is not delivered later.
- **Why:** spec 12 says quiet hours silence notification delivery without
  pausing computation unless Victor asks for the separate behavior. Replaying a
  stale completion later would be worse than silence.
- **Constrains:** quiet hours cannot stop a turn, interrupt a runtime, or change
  a budget decision. Those remain explicit actions.

## D-0074 — Lock-screen content carries no project detail

- **Decision:** native notification titles/bodies are generic (finished, needs
  attention, could not finish, limit). Project name, prompt text, file paths,
  task titles and turn ids stay in the app after a click.
- **Why:** a notification is visible on a lock screen; spec 12 requires default
  content not to expose sensitive prompt or file details. Focusing the project
  after a click still carries the useful context locally.
- **Constrains:** new notification kinds must use `publicNotification`; the
  planner test asserts the private fields are absent.

## D-0075 — Focus Mode is a saved layout with non-negotiable controls

- **Decision:** Focus Mode is a per-project `standard | focus` layout stored in
  UI state. It hides the inspector, project search and recents; the topbar,
  navigation, composer, execution strip and Interrupt now remain.
- **Why:** spec 12 wants one task and fewer panels, but an emergency control
  that disappears with a layout is a safety defect. Saving the layout per
  project avoids re-toggling on every open.
- **Constrains:** Focus Mode must never hide the interrupt, stop, quit or
  approval-wait surfaces. Density is a separate persisted preference.

## D-0076 — Back up before taking the migration barrier

- **Decision:** `openState()` takes the verified pre-migration backup under its
  own snapshot barrier, then applies migrations under the exclusive migration
  barrier. It no longer nests `createBackup` inside `exclusive('migrate')`.
- **Why:** both operations use the one maintenance barrier; nesting them raised
  `maintenance already in progress (migrate)` on every launch that had an
  existing database. Fresh profiles hid the bug because no backup was due. The
  P14 seeded probe exposed it.
- **Constrains:** no other writer exists at open time; if a future startup path
  admits concurrent writers before migration, it must take one barrier that
  covers both operations rather than reintroducing the nested lock. A regression
  test opens an existing database twice and verifies the backup.

## D-0077 - Native orchestration has one execution owner

- **Decision:** Mona projects engine goals, fleet runs and child agents but
  never schedules their internal work. Each project has one active owner
  (`none | mona_queue | native_goal | native_fleet | native_agent`); Mona's
  queue and native starts refuse each other while an owner is active.
- **Why:** spec 10.3 forbids the Mona queue and an engine goal/fleet from
  independently scheduling the same task. Observing the engine's own records is
  also the only way to show real child lifecycle and spend.
- **Constrains:** parallel builder runs stay unavailable until isolated
  worktrees, branch ownership, aggregate budgets and a merge/review boundary are
  qualified. A fleet start that returns `scheduled` with no lease is reported as
  a queued run, never as running work. ADR: docs/adr/0001-orchestration-ownership.md.

## D-0078 - Configuration writes use the engine CLI with a hashed backup

- **Decision:** provider, model, permission and mode defaults are written by
  `codewhale config set`, after snapshotting `config.toml` and `settings.toml`,
  checking an expected revision and storing an app-private backup. The key is
  read back before success is reported.
- **Why:** the engine owns config.toml and settings.toml semantics, including
  unknown-key preservation and validation. Hand-editing would silently drop or
  reorder keys. A revision check detects a concurrent external edit.
- **Constrains:** a saved default applies to new threads only. Active threads
  keep the route they were created with; the workbench shows requested and
  effective values separately. No provider probe and no automatic fallback run
  from this path.

## D-0079 - Extension inventory is read from the runtime, never by spawning

- **Decision:** the Extensions view projects `/v1/apps/mcp/servers` (and one
  detail per server), `/v1/skills`, `/v1/apps/plugins`, `/v1/hooks` and
  `/v1/workspace/instructions`. It does not call `/v1/apps/mcp/tools`, does not
  reconnect a server, and does not read extension files itself.
- **Why:** opening a settings page must not spawn processes, execute project
  content, or pull every server and tool description into memory. The runtime
  already owns config parsing, trust and redaction. A local reimplementation
  would drift and could show a different effective state.
- **Constrains:** health is an explicit action against one named server. Tool
  names are returned only then. A route that fails is reported as an unavailable
  section, not as an empty list.

## D-0080 - MCP writes carry the displayed revision and stay engine-gated

- **Decision:** enable and disable send the runtime's MCP revision in `If-Match`.
  A mismatch is a conflict; Mona never retries with a fresher revision on the
  user's behalf. Required servers cannot be disabled from the UI.
- **Why:** the runtime refused a stale revision with HTTP 412 in the P17 probe,
  and the engine preserves unknown top-level and server-level keys. Delegating
  the write keeps that guarantee; recomputing or rewriting the file in Mona
  would not.
- **Constrains:** project-scope MCP servers and hooks appear only after the
  engine records workspace trust and approval. Mona reports that state and does
  not approve it. Install/trust/update for plugins and skills remain advanced
  engine actions; the UI shows the exact invocation instead of simulating it.

## D-0081 - The capability explorer separates the ledger from live truth

- **Decision:** the explorer reads the versioned `docs/codewhale-capabilities.json`
  as a static inventory and joins it with live `/v1/runtime/info` and
  `/v1/process` identity plus the capability-flag map. A version or commit
  mismatch is shown as drift; ledger claims are never inherited silently.
- **Why:** the ledger records what was tested at P00–P18. An upgraded engine
  could add, remove or change a route without Mona noticing. Keeping the two
  sources separate makes every row auditable and lets the coverage report count
  discovered-only and unavailable rows instead of hiding them.
- **Constrains:** the explorer refuses to invent a row or upgrade a status. The
  completeness figure is labelled catalog coverage, not parity. A missing or
  malformed ledger is an error, not an empty explorer.

## D-0082 - No fake terminal on a platform the engine does not support

- **Decision:** Mona shows the terminal route, the four capability flags and the
  engine’s exact response, and ships no terminal widget on Windows. Logs are a
  separate read-only surface.
- **Why:** the pinned runtime reports `terminal_stream/input/resize/kill` false
  and returns HTTP 501: “terminal sessions are Unix-only in this build; native
  Windows PTY support is not implemented yet.” A `child_process` shell or a
  pseudo-PTY would be a fake terminal with wrong resize, signal and job-control
  semantics. MONA-023/terminal stays blocked as ISSUE-0018 until Victor accepts
  platform-unavailable or authorizes a real Windows PTY path.
- **Constrains:** logs are capped at 64 KiB per request with offset pagination,
  path-like names are refused, and credential-shaped values are redacted. No
  terminal, shell or generic invoke channel may be added to the preload to work
  around the engine limitation.

## D-0083 - Capability palette entries navigate; they never invoke

- **Decision:** every ledger row becomes a palette item. Selecting it opens the
  Capabilities section and focuses that row.
- **Why:** the palette is a finder, not an execution surface. A row may be
  discovered-only, unavailable or blocked; invoking it from a keystroke would
  bypass the effect preview and consent rules in spec 7.1.
- **Constrains:** palette actions for local UI commands keep their existing
  behavior; capability items only navigate and can be selected even when the row
  is unavailable, because the explanation is the useful destination.

## D-0084 - The terminal is Mona's own ConPTY, not an engine claim

- **Decision:** Mona ships a Windows terminal built on `node-pty` (ConPTY) and
  xterm.js, in a bottom drawer. The engine's `/v1/terminal` routes stay reported
  as unavailable-on-platform and are never used.
- **Why:** the pinned engine returns HTTP 501 on every terminal route on
  Windows. Victor authorized a native PTY path instead of accepting the gap.
  Writing our own ConPTY host keeps the terminal real (job control, resize, ^C,
  full-screen apps) without pretending the engine provides it.
- **Constrains:** the terminal is project-bound (main resolves the folder from
  the catalog; the renderer never sends a path), input is capped at 8 KiB per
  call, scrollback is capped at 256 KiB in main, and no model output, Markdown,
  hook, MCP payload or tool result can reach a terminal input channel. The
  packaged installer must unpack `node-pty` (P21).

## D-0085 - `node-pty` uses its shipped prebuilt binary and runs no install script

- **Decision:** `node-pty@1.1.0` is installed with `allowScripts: { "node-pty":
  false }`. The package's N-API prebuild for `win32-x64` is used as shipped; no
  node-gyp build, no MSVC, no postinstall action.
- **Why:** the prebuild loads and spawns a real ConPTY (verified in plain Node,
  then in Electron). Running the install script would add a build step and a
  trust surface for no benefit on this machine.
- **Constrains:** if a future upgrade ships no prebuild for the target ABI, the
  upgrade is a deliberate decision with a toolchain prerequisite, not a silent
  compile. Re-verify with `npm run terminal` after any node-pty change.

## D-0086 - Terminal exit state comes from the PTY, never from the kill reply

- **Decision:** End session sends the kill, the badge shows `closing`, and only
  the PTY's own exit event sets `exited` with the exit code. The buffer is not
  cleared.
- **Why:** on Windows the kill reply arrives before the process is gone. Trusting
  it left the drawer claiming `running` after the user ended the session — a
  false state, and exactly the kind of claim this project refuses. Keeping the
  buffer also lets the user copy output after the shell dies.
- **Constrains:** a shell that ignores the kill shows `closing` until the exit
  event or until the app quits; the drawer must not invent an exit code.

## D-0087 - Screen-reader mode stays off until a human pass qualifies it

- **Decision:** xterm runs with `screenReaderMode: false` by default, even though
  the drawer has an accessible label and a labelled search field.
- **Why:** the live probe proved that `screenReaderMode: true` silently disables
  xterm's textarea input path, so typed characters were dropped. Turning it on by
  default would trade real input for unverified accessibility.
- **Constrains:** a human screen-reader pass (ISSUE-0019) must decide how to
  offer the mode, probably as a setting, before it is enabled for users.

## D-0088 - Clipboard writes go through a narrow terminal channel

- **Decision:** `Copy` and `Copy all` try `navigator.clipboard`, then fall back to
  `mona:terminal-copy`, which writes through Electron's clipboard in main.
  Payloads are capped at 256 KiB and validated by schema.
- **Why:** an unfocused window refuses the async clipboard API, so copy silently
  failed in the live probe. A one-purpose channel that only writes text is
  narrower than exposing a generic clipboard bridge and is user-initiated.
- **Constrains:** the channel cannot read the clipboard, cannot run commands, and
  is not used by model output or terminal escape sequences; OSC 52 remains
  consumed and ignored.

## D-0089 - Portable bundles are digest-checked JSON envelopes, not ZIP archives

- **Decision:** a handoff, resume packet, prompt pack and settings backup are
  JSON documents with a canonical-JSON sha256 digest. Selected files travel as
  entries with a relative path, digest, size and base64/utf8 content. Extraction
  validates every member path and digest before writing with exclusive-create.
- **Why:** the project has no archive dependency and P19 forbids adding a new
  runtime surface casually. A JSON envelope is inspectable with ordinary tools,
  works offline, and the acceptance requirement is about unsafe member paths —
  which are validated explicitly at parse, import and extraction time. Shipping
  a home-grown ZIP writer would add binary parsing risk for no user-visible gain.
- **Constrains:** a bundle is larger than a compressed archive, and ZIP tooling
  sees one JSON file. If compression becomes necessary, it is a new format
  version with the same path and digest rules, not a silent change.

## D-0090 - Project memory is a term table; prompt text and bindings stay out

- **Decision:** migration v7 indexes permitted metadata, decisions, task
  acceptance/evidence, requirement evidence, problems, attempts and bounded
  timeline items into `memory_documents`/`memory_terms`. There is no FTS
  extension and no embedding service. Task `prompt_text`, submissions intent and
  runtime bindings are never indexed. Repository files are searched on demand
  and never copied into the database.
- **Why:** deterministic local behaviour is testable and cheap; an embedding
  service is a hidden inference path. A prompt can contain pasted credentials,
  so indexing the full dispatch text would create a second secret surface.
- **Constrains:** search is lexical (plus one term per CJK character), not
  semantic. Rebuild is explicit; there is no background indexer.

## D-0091 - P14 favorites become the one versioned prompt shelf

- **Decision:** the per-project favorites array is upgraded in place into shelf
  prompts with template, variables, acceptance criteria, version and bounded
  history. `text` remains as an alias for the current template so the Studio
  shortcut keeps working. There is no second prompt store.
- **Why:** two shelves would split the user's prompts and double the migration
  surface. Legacy entries are read as version-1 prompts, so no saved text is
  lost. Prompts with variables are previewed in Memory rather than inserted raw
  into the Studio composer.
- **Constrains:** the UI state file remains machine-local; portability is by
  prompt pack. Version history is capped at ten snapshots per prompt.

## D-0092 - Handoff import preserves ids and refuses a non-empty target

- **Decision:** an imported handoff keeps task, decision and evidence ids, binds
  the chosen folder, and refuses a target project that already has recorded work
  unless replacement is explicit. Evidence is re-hashed against the new folder;
  stale evidence reopens a completed task to `verifying`.
- **Why:** preserving ids is what makes pointers and dependency graphs
  reconstructable without a remapping scheme. Remapping would have to rewrite
  criteria, steps, evidence and dependencies atomically; refusing a collision is
  more honest than performing a partial remap. The supported flow is a clean
  profile or empty folder.
- **Constrains:** importing a copy of a project that still exists in the same
  profile is a `conflict` (P19-ISSUE-002). A future id-remap design would need
  its own decision and round-trip tests.

## D-0093 - Settings restore appends versions under exclusive maintenance

- **Decision:** restore verifies the backup digest and store schema, then holds
  the maintenance barrier and writes a new settings version per scope inside one
  `BEGIN IMMEDIATE` transaction. It never rewrites recorded history. Credentials
  are redacted at backup time; the restore cannot recover a value that was
  removed.
- **Why:** settings can change runtime behaviour, so restore is a maintenance
  operation, not an ordinary write. Appending keeps the audit trail honest and
  makes a failed restore a rollback rather than a half-applied configuration.
- **Constrains:** a redacted backup restores `[redacted]` placeholders where a
  credential value lived; the user must re-enter the credential through the
  engine's credential store, which Mona does not own.
## D-0094 - Restore stages, verifies and atomically renames the replacement

- **Decision:** a restore copies the chosen backup to a temporary file beside the
  live database, verifies its `integrity_check`, removes the live WAL sidecars
  only after that succeeds, and renames the staged file over the live file.
  Failures remove the staged file and its sidecars and reopen the original
  store. The parked pre-restore copy and the backup are never deleted.
- **Why:** the previous direct copy could leave a partial live database if the
  process failed between truncate and completion, even though a valid parked
  copy existed. P20 failure injection at three points proved the new ordering
  keeps the live data readable and the store usable.
- **Constrains:** the staged file lives in the database directory, so a full disk
  can still refuse the restore; the refusal leaves the live database untouched.

## D-0095 - A failed database open closes its handle and preserves the file

- **Decision:** `openDatabase` closes a `DatabaseSync` if pragma setup fails and
  rethrows the original error. `openState` does not delete, rename or replace a
  file it cannot open.
- **Why:** Windows keeps a file locked while a SQLite handle exists, so a corrupt
  database could not be moved for inspection. P20's corrupt-state test now
  proves the file is byte-identical and movable after the failed open.
- **Constrains:** the UI reports local state unavailable and stays inspectable;
  recovery is a human decision on the preserved file, not an automatic reset.

## D-0096 - One IPC audit test guards every handled channel

- **Decision:** `apps/desktop/src/main/ipc-audit.test.ts` wires all IPC modules
  with an untrusted sender and a null service, then asserts every handled
  channel answers `untrusted_sender`. The build check separately enforces the
  exact preload channel list.
- **Why:** per-module tests showed the pattern but not that every channel follows
  it. A central audit makes a missed guard a failing test rather than a review
  oversight. Event channels are push-only and are not in the handled set.
- **Constrains:** adding a channel requires updating the checked-in preload list,
  and the audit fails if the wrapper does not check the sender first.

## D-0097 - The modern menu is a sparse package plus one small COM DLL

- **Decision:** Windows 11's context menu is delivered as a sparse MSIX identity
  package (`windows.fileExplorerContextMenus` + `windows.comServer`) whose
  `MonaMenu.dll` implements only `IExplorerCommand`. The DLL reads the installed
  `Mona.exe` path from `HKCU\Software\Mona\Install` and starts it with
  `CreateProcessW`; registration belongs to the package manifest, never to the DLL.
- **Why:** the classic per-user key is not the modern menu, and Microsoft documents
  identity as the only path into it. Keeping the DLL free of registration, network
  and model code keeps the shell extension small and auditable; the installer can
  move the executable on upgrade without touching the package identity.
- **Constrains:** without a trusted signing identity Windows refuses the package
  (0x800B0109) and without developer mode it refuses an unsigned one (0x80073CFF).
  Both are recorded as release prerequisites, not worked around.

## D-0098 - Portable pinned tools instead of installing a Windows SDK

- **Decision:** `tools/install/fetch-tools.mjs` downloads Zig 0.17.1 and Windows SDK
  BuildTools 10.0.28000.2957 into `node_modules/.cache/mona-build-tools` with exact
  SHA-256 pins. `native/windows-shell/build.mjs` compiles the helper with
  `zig cc -target x86_64-windows-gnu`.
- **Why:** no MSVC or Windows SDK exists here, and the work must not require an
  elevated installer. Zig supplies clang and mingw-w64 headers for the COM and
  shell interfaces; BuildTools supplies MakeAppx and SignTool. Both are verified by
  hash before use, so the build is reproducible from a clean checkout.
- **Constrains:** the compiled DLL is a build product, not a committed binary; a
  clean checkout runs `npm run tools:fetch` then `npm run native:build`.

## D-0099 - Installation replaces the program tree atomically and preserves user data

- **Decision:** `stage` builds a checksummed payload; `install` copies it to
  `<installRoot>.new-<stamp>`, renames the previous tree aside, renames the new tree
  into place, and only then deletes the old one. The installed uninstaller removes
  the program directory from a detached command after its own process exits.
- **Why:** a partially copied upgrade must never be launchable, and Windows cannot
  delete the executable running the uninstaller. User data
  (`%APPDATA%\@mona\desktop`) and `~/.codewhale` are outside every removed path; the
  uninstall evidence compares file counts before and after.
- **Constrains:** an upgrade needs enough free space for one extra copy, and the
  program directory disappears a few seconds after the uninstaller returns.

## D-0100 - The packaged app keeps the existing application identity

- **Decision:** the installed `resources/app/package.json` keeps
  `name: "@mona/desktop"` and the current version, so `app.getPath("userData")` is
  unchanged. `productName: "Mona"` is set for presentation only.
- **Why:** changing the application name would move the profile directory and
  detach the user's existing projects and history from the installed app, which the
  prompt forbids losing.
- **Constrains:** the on-disk profile directory remains `%APPDATA%\@mona\desktop`;
  renaming it is a future migration with its own evidence, not a side effect of
  packaging.
## D-0101 - The Changes surface reports facts and keeps "unavailable" distinct from "empty"

- **Decision:** a new Changes section (`ChangesPanel`, `ChangesService`,
  three IPC channels) reads Git status, a change list against a captured
  baseline, Git text diffs and recorded test receipts. Four states are
  separate and never collapse into one: no baseline ("Changes unavailable"),
  a real empty change list ("No changes since the baseline"), a non-Git
  workspace (a diff reports "no textual baseline"), and a missing folder
  ("Changes unavailable: the project folder is missing").
- **Why:** the specification requires "Changes unavailable" to differ from
  "No changes", and the engine's terminal or an empty diff would both be lies.
  The change list already existed in `ChangeService` but had no renderer
  surface (P13-ISSUE-001); this closes the Core criterion MONA-014/diffs.
- **Constrains:** the surface states its scan bounds (5,000 files, the excluded
  trees, the 1 MiB preview cap) because "no changes" means less when a scan
  stopped early. Attribution comes only from recorded tool paths; every other
  change is labelled unattributed, never "agent work".

## D-0102 - Virtualized lists are arithmetic on a fixed row height

- **Decision:** `packages/ui` exposes `virtualWindow` and `VirtualList`, which
  render only the visible rows plus overscan inside a full-height spacer. Diff
  rows are 18 px and change rows 30 px, declared in both the component and the
  stylesheet.
- **Why:** a 4,000-line change must not build 8,000 DOM nodes. Measured in real
  Electron, an 8,007-line diff renders **29** rows and its tail is reachable by
  scrolling. Measuring every row would reintroduce the freeze this replaces.
- **Constrains:** rows must be a uniform height. A future variable-height list
  needs its own measured implementation, not a tweak to this one.

## D-0103 - One list of sections governs rendering, persistence and validation

- **Decision:** `PROJECT_VIEWS` in `shared/catalog.ts` is the single list of
  sections. The catalog IPC schema, the persisted UI state and the rail all read
  it, and a test iterates every entry through `uiSetView`.
- **Why:** before P23 the IPC allowlist accepted five sections while the shell
  rendered nine, so a restart silently dropped Agents, Extensions, Memory and
  Capabilities. Renderable-but-unsavable was a bug waiting to be reported as a
  data loss.
- **Constrains:** adding a section means adding it in one place and adding its
  render branch; nothing else may hard-code a view list.

## D-0104 - The 350 MB memory target stays; the deviation is recorded, not absorbed

- **Decision:** the release candidate ships with idle memory measured at
  406.4 MB across four processes. The 350 MB budget is unchanged, MONA-028 stays
  partial, and the first post-0.1.0 performance task is a heap profile of the
  main and renderer processes (P23-ISSUE-001).
- **Why:** moving the target to the measurement would delete the only thing the
  target does. The number is real and reproducible on this machine; the *cause*
  is not yet known, so a fix now would be guesswork.
- **Constrains:** no release text may claim the budget is met. A stated target
  change requires Victor's recorded decision, not a builder's convenience.

## D-0105 - Trusting the test certificate is a verified, narrowly scoped action

- **Decision:** `tools/install/trust.mjs` owns trust. It reads the certificate, the
  package's own Authenticode signer, the manifest Publisher from inside the MSIX, and
  the build signing record, and refuses to import unless all four agree on subject
  and thumbprint, the certificate carries the code-signing EKU, has no private key,
  and is currently valid. The import target is `Cert:\LocalMachine\TrustedPeople`
  and nothing else. `tools/install/cli.mjs trust-test-certificate` runs the same
  check before writing; `untrust-test-certificate` removes exactly that thumbprint.
- **Why:** Victor authorized trusting *this* certificate, not any certificate that
  accompanies a file. The previous `trust-certificate` action imported into
  `CurrentUser\Root` and checked nothing; both are now removed, so no caller can
  reach the Root store and no unverified certificate can be imported.
- **Constrains:** the import needs an elevated shell, because AppX deployment writes
  machine state. The CLI refuses the non-elevated attempt with exit code 4 and the
  exact command rather than producing a confusing duplicate of the machine policy
  gate. No Developer Mode, no disabled signature validation, no exported private key.
- **Verified by:** `tests/install/trust.test.mjs` (11 policy tests) and
  `docs/evidence/P23-trust-verify.json`, which shows `verdict ok: true` with
  `elevationRequired: true` and all four stores absent before import.

## D-0106 - The timeline renders a bounded page of rows, and says so

- **Decision:** `StudioPanel` renders the newest 120 loaded items and offers
  "Show 120 earlier item(s)" for the rest. The shell still loads up to 500 items into
  state; only the DOM is windowed. A new session, project or mode resets to the first
  page.
- **Why:** measured, not assumed. Expanding the live DOM from 120 to 500 rendered
  items cost **+27.7 MB** of working set; windowing cut idle memory from 404 MB to
  371.4 MB on the installed candidate. Rendered rows, not stored text, hold the cost.
- **Constrains:** the control must stay keyboard reachable and must state the count,
  so "older items exist" is never hidden. `StudioPanel.test.tsx` pins the 120-row
  first page, the +120 reveal, and full rendering for a short history. No item is
  deleted from the database, export, or search.

## D-0107 - The memory target stays 350 MB; progress is recorded, not converted into a pass

- **Decision:** after two attempts with material progress, idle memory on the
  installed candidate is **371.4 MB** (from 404 MB). D-0104's 350 MB target stands,
  MONA-028 stays partial, and the remaining 21.4 MB is left as an explicit unmet
  target with a named next action (`P23-followup.md` §2.7).
- **Why:** the residue is Chromium's own process baseline — main JS heap 12.0 MB,
  renderer JS heap 3.4 MB, and a GPU process inflated by this host reporting
  `gpu_compositing: disabled_software`. Reaching 350 MB here would mean disabling
  features to hit a number, which the specification forbids.
- **Constrains:** attempt 3 is reserved for the next evidence-led step (hardware-GPU
  host comparison, then the network-service process). No further memory work may
  claim a pass without a measurement on the installed candidate.

## D-0108 - Trust is provisioned once, verified, at machine scope, and removable by thumbprint

- **Decision:** the elevated round performed the one authorized import: thumbprint
  `5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95` into `Cert:\LocalMachine\TrustedPeople`, after the
  D-0105 checks re-passed against the rebuilt artifact. The identity package then registered
  (`Status: Ok`). Nothing else was trusted: `Root` stayed absent, developer mode stayed off, and
  signature validation stayed on.
- **Why:** this was the last machine-policy gate on MONA-027. It was cleared by performing the
  recorded step in the environment it required, not by weakening validation or relabelling the
  requirement.
- **Constrains:** trust applies to the whole machine for any package signed by this key until it
  is removed; the evidence says so. Other machines need their own decision. A human right-click
  is still required before any claim that the menu is visible.
- **Verified by:** `docs/evidence/P23-trust-elevated.json`, `P23-install-after-trust.json`, and
  the round-trip removal in `P23-untrust-check.json`.

## D-0109 - The identity package carries the COM server its manifest declares, and the build refuses divergence

- **Decision:** `buildStage` copies the built `MonaMenu.dll` into the identity payload, and
  `missingComServerPayloads` makes both `stage` and `package` fail when the manifest names a
  `com:Class` path that the payload does not contain.
- **Why:** the manifest declares the server by a package-relative path, so the package should be
  able to satisfy its own declaration without depending on external-location resolution. This is
  hardening, not a diagnosed fix: Notepad++'s shipped sparse package resolves the same shape
  externally, so external resolution is plausible. The invariant (manifest and payload cannot
  diverge) is the part that is certainly worth having.
- **Constrains:** no evidence here claims the previous package could not have worked, and none
  claims the menu appears. Direct CLSID activation is explicitly **not** valid evidence for
  packaged shell commands: a known-good third-party package fails it identically
  (`REGDB_E_CLASSNOTREG`), so it may not be used in either direction.
- **Verified by:** `tests/install/installer.test.mjs` (payload guard) and the packaged content
  listing in `docs/evidence/P23-elevated-round.md`.

## D-0110 - `untrust` clears both TrustedPeople scopes and never Root

- **Decision:** `removeTrust` removes the exact thumbprint from `LocalMachine\TrustedPeople` and
  `CurrentUser\TrustedPeople`, reports what was present, and asserts `Root` is untouched.
- **Why:** importing to the machine store makes Windows mirror the certificate into the user's
  TrustedPeople view. Leaving that mirror behind after an `untrust` would be a half-removal that
  looks complete.
- **Constrains:** no other store is written or deleted; the per-user `My` store is handled by the
  uninstaller's owned-certificate cleanup.
- **Verified by:** `P23-untrust-check.json` (both stores absent after removal, `rootUntouched:
  true`) followed by a successful re-import.

## D-0111 - The 370.5-377.1 MB deviation is accepted for 0.1.0; the 350 MB target is not moved

- **Decision:** Victor accepted the measured idle-memory deviation on 2026-11-12. The 350 MB
  target stands unchanged, MONA-028's `performance` criterion keeps its measured numbers and
  stays `partial`, and the next evidence-led memory step stays unauthorized rather than
  cancelled.
- **Why:** the deviation is a known, measured, reproducible cost of Chromium's process baseline
  on this host, not a defect hidden by the number. Accepting it is a release judgement the user
  is entitled to make; rewriting the target would destroy the only thing the target does.
- **Constrains:** no release text may claim the budget is met, no feature may be removed to reach
  350 MB, and MONA-028 remains `partial` because the Narrator and physical 200 % scaling checks
  are still human-only. A later memory pass must re-measure the installed candidate, not infer.
- **Verified by:** `docs/evidence/P23-memory-acceptance.md` (the measurement table and this
  decision), `P23-memory-installed-2.json`, `P23-qa-installed-2.json`.

## D-0112 - Window scale lives in the main process on a fixed ladder

- **Decision:** Ctrl +/=, -, and 0 step a fixed ladder (50-200 % in twelve rungs) applied with
  `webContents.setZoomFactor`, handled in `before-input-event` in the main process, and persisted
  in `state/appearance.json`. The renderer may request a direction only, never a number.
- **Why:** the shortcut must work with focus anywhere, including the terminal drawer and dialogs,
  and scaling the whole web contents is what makes every panel reflow together instead of one
  column growing against fixed neighbours. A bounded ladder keeps a stray keypress from asking for
  an unreadable window and lets the UI disable an exhausted direction honestly.
- **Constrains:** scale is presentation only and must never be conflated with density (a design
  token change) or with a provider/model setting. Probes get their own profile, so a scale chosen
  on this machine cannot leak into evidence runs.
- **Verified by:** `appearance.test.ts` (8 tests), the IPC audit, and `docs/evidence/P24-appearance.md`
  (19 live steps with synthetic key input, on development and installed builds).

## D-0113 - The Inspector is a collapsed reference panel, and its choice is not schema state

- **Decision:** the Inspector starts collapsed to a 32 px labelled rail; the open/closed choice is
  stored in `localStorage`, not in the project database. Focus Mode still hides it.
- **Why:** the timeline is the work surface and a fixed 300 px reference column was costing it the
  width (measured 253-268 px). A layout preference needs no migration, and putting it in the
  ledger would imply durable project meaning it does not have.
- **Constrains:** the collapsed state must remain a labelled, keyboard-reachable control with
  `aria-expanded`; the panel may never become invisible-but-focusable.
- **Verified by:** the renderer test that opens, closes and persists it, and the live probe
  (`timelineWidthCollapsed` vs `timelineWidthOpen`).

## D-0114 - A criterion that describes what a person can do needs surface-level evidence

- **Decision:** MONA-013 `budgets`/`export` and MONA-009 `prompt-catalog` are now evidenced by
  the live Cost lens and Work board (`docs/evidence/P25-surfaces.md`, 26 steps on development and
  installed builds). They had previously been marked `passed` on service-level tests while the
  renderer had no budget, export or task channel; the Cost screen said budgets "arrive with P12"
  and the Work screen printed "No tasks recorded" unconditionally. The mistake is recorded here
  rather than rewritten out of the history.
- **Why:** "the service can do it" and "a person can do it" are different claims. Reading a
  closed requirement as satisfied because its backend works let two visible stubs survive a
  release-candidate pass. The product rule already says untested is not supported; this extends
  it to unreachable is not delivered.
- **Constrains:** any future criterion phrased as a user-facing capability must cite evidence
  produced by driving the app (probe or recorded screenshots), not only package tests. Where an
  OS surface cannot be automated (native Save dialog), the gap must be stated in the evidence.
- **Verified by:** the surface probe, `cost-ipc.test.ts` (8), `tasks-ipc.test.ts` (7), two
  renderer cases, the sender audit, and `P25-surfaces.json` / `P25-surfaces-installed.json`.

## D-0115 - The work board and cost lens read their services; the view recomputes nothing

- **Decision:** the Work board renders the task service's board verbatim, including eligibility
  and its reason; the Cost lens renders the ledger's lens, budgets and live budget evaluation.
  Neither view calculates eligibility, spend or remaining balance.
- **Why:** a second calculation is a second source of truth, and this product deliberately has
  one scheduler and one ledger. Copying the verdict keeps the screen honest when the service
  changes its rules.
- **Constrains:** task creation is the only write, and it records a pending task; it never starts
  a run. Budget writes go through `CostLedger.setBudget`; the renderer can request a direction or
  an amount, never a computed state.
- **Verified by:** the IPC tests asserting the service verdict is preserved, and the live probe
  asserting a dependency-blocked task shows the service reason.

## D-0116 - The Windows improvement supplement is a second validated ledger, not an extension of the first

- **Decision:** `Mona_Windows_Improvements_Project.md` and `Mona_Windows_Improvements_PROMPTS.md`
  are registered in `docs/requirements-windows.json` against
  `tools/build/schema/requirements-windows.schema.json`. The supplement owns the id spaces
  `W00-W25` (prompts) and `WX-01-WX-18` (requirements). `docs/requirements.json` keeps its own
  `Pnn` / `MONA-nnn` schema untouched.
- **Why:** the original gate is deliberately narrow - prompt ids must match `^P[0-9]{2}$` and the
  root object admits no extra keys. Widening it to hold a second namespace would have weakened the
  check that protects the P00-P23 sequence in order to add a queue. Two ledgers, two schemas, one
  `validate` command: the supplement gets the same evidence discipline without eroding the
  original.
- **Constrains:** `node tools/build/cli.mjs validate` now also checks the supplement: document
  hashes, the complete W00-W25 and WX-01-WX-18 sets, that every recorded title still matches its
  `### Wnn` heading, dependency cycles, symmetric ownership, that every prompt is claimed by at
  least one WX row, and that no prompt is `completed` without evidence or `verified` requirement
  without an original-ledger mapping (S10 requires that mapping). `status` reports the supplement
  queue separately. `docs/spec-index.json` now indexes all four documents.
- **Verified by:** `tests/bootstrap/windows-supplement.test.mjs` (7 cases, including deliberate
  title drift, an unclaimed prompt, a completion without evidence and a verification without a
  mapping), and `node tools/build/cli.mjs validate` returning OK on the real tree.

## D-0117 - One approved icon source, generated deterministically, with absence treated as failure

- **Decision:** `assets/brand/MidnightMona.png` is the only icon source. `tools/assets/build-icons.mjs`
  decodes it, crops to a centred square around its alpha bounds and resamples with a
  coverage-weighted box filter in premultiplied alpha, emitting `mona-16..256.png`, a multi-size
  `mona.ico`, and the three package images `AppxManifest.xml` declares. The output is byte-stable;
  `npm run assets:check` (part of `ci`) proves the committed files still match the source.
- **Why:** the repository carries no image dependency, so the pipeline decodes and re-encodes PNG
  itself and the only inputs are the source bytes and the script. Premultiplied resampling avoids
  the grey fringe straight-RGBA averaging leaves on an anti-aliased mark. A missing source or a
  wrong image size now fails the build with the exact path and command, because silently drawing
  a different logo is worse than shipping no icon.
- **Constrains:** the installer builds its identity package from those files and refuses a missing
  file or a size that disagrees with the manifest; the previous solid-colour placeholder is gone
  from the product path (kept only as a test fixture). Two gaps are recorded rather than hidden:
  at 16 px the ribbon detail collapses, and the packaged `Mona.exe` still carries Electron's
  embedded icon resources because no PE resource editor is part of this repository.
- **Verified by:** `tests/assets/icon-pipeline.test.mjs` (11 cases: sizes, ICO directory vs payload,
  transparent corners, byte stability, `--check`), `tests/install/installer.test.mjs` package
  artwork cases, and the desktop build emitting `mona-mark-*.png` into the renderer.

## D-0118 - Standing authorization: commit and push without asking, every turn

- **Decision (Victor, 2026-11-14):** from this point forward, an agent that changed files is
  pre-authorized to commit them locally and push to `origin`
  (`https://github.com/king-felix/WinMona-Mona-for-Windows`, branch `main`) as the closing step of
  the turn, without requesting approval again. The previous rule - "No unrequested publication.
  Local commits only; there is no Mona remote" - is superseded on the commit/push axis and amended
  in `AGENTS.md` rather than left to contradict practice.
- **Why:** the approval request at the end of each turn was pure latency. The repository, the
  branch and the credentials were already settled, the work had already been reviewed by the
  gates, and a standing instruction covers the repeated decision. Leaving the old rule in place
  would have made project law and actual practice disagree, which is worse than either.
- **Scope of the grant, stated so it cannot be widened by implication:** it covers `git add` of
  the agent's own coherent change set, `git commit`, and `git push origin main`. It does **not**
  cover publishing packages or releases, creating or renaming repositories, changing visibility,
  force-pushing or rewriting published history, tags, purchases, certificates, or credential and
  endpoint changes. Those still require an explicit request in the turn that performs them.
- **The material consequence, recorded because it is easy to forget:** the remote is **public**.
  A push publishes immediately and is not reversible in practice once mirrored. So the grant is
  conditioned on evidence, not on enthusiasm - `node tools/build/cli.mjs validate` (with its secret
  scan) must pass, no credentials or private transcripts may be staged, and `.gitignore` must keep
  excluding `.env*`, keys, `secrets.json` and local `.mona/build` state. A red validation result
  stops the push and is reported as a stop; it is never worked around to satisfy the standing
  authorization.
- **Constrains:** the end-of-turn report now states the commit SHA and the push result as facts,
  with the remote ref checked after pushing. "Pushed" is only claimed when `git ls-remote` agrees
  with local `HEAD`; a failed or rejected push is reported as failed.
- **First exercise:** commit `a1a4430` (Windows supplement registry + approved icon artwork) was
  pushed to `origin/main` under this grant, verified by matching `git ls-remote origin
  refs/heads/main` against local `HEAD`.

## D-0119 - The supervisor restart fixture waits for readiness instead of racing it

- **Decision:** `packages/adapter/src/supervisor.test.ts` sets `FAKE_CRASH_MS` to 6 000 ms (it was
  2 500 ms). Every assertion in that test is unchanged: readiness must succeed, the runtime crashes,
  the supervisor restarts it at most twice, three unexpected exits are observed, and the state ends
  `failed`.
- **Why:** on this machine node spawn plus the first successful health probe now measures
  2 821-2 948 ms across three runs. With a 2 500 ms crash timer the fake runtime died before
  readiness, so `start()` returned `engine_unavailable` and the test failed for a reason unrelated
  to what it tests. The crash delay is a setup parameter, not the criterion.
- **What was NOT done:** no assertion was relaxed, no test was removed, and the readiness poll
  interval (150 ms) was not tuned to make the old number pass. The measurement is recorded here so
  a future reader can tell a fixture adjustment from a behaviour change.
- **Constrains:** the restarted runtime inherits the same environment, so each restart also lives
  6 s; the test now takes about 19 s and its 40 s timeout still holds on this machine.

## D-0120 - The Windows improvement review keeps its own revision-checked ledger

- **Decision:** W00-W25 live in `.mona/build/reviews/windows-v2/state.json` plus an append-only
  `attempts.jsonl`, written by `tools/build/windows-review.mjs`. The P00-P23 state in
  `.mona/build/state.json` is untouched, because `cli.mjs` deliberately refuses `Wnn` ids and
  loosening its schema to admit a second namespace would weaken the gate that protects the first.
- **Why:** S01 requires a subordinate enhancement ledger with atomic revision-checked writes; the
  supplement is a separate id space by design (D-0116). Owning the gate in a second small utility
  is cheaper and safer than teaching the original validator a second dialect.
- **Mechanism, so the guarantees are not just prose:** `checkpoint` requires
  `--expected-revision` and refuses a stale writer; a `completed` task without evidence or with an
  open acceptance item is refused; a blocked task must name a problem id; prerequisites are read
  from the supplement document on every seed so a stale local copy cannot disagree with the
  dependency map; `attempt` refuses a fourth row after three consecutive no-progress attempts and
  resets the counter only on recorded material progress. `tests/bootstrap/windows-review.test.mjs`
  proves each refusal.
- **Constrains:** the review ledger is developer build state. Prompt Runner and the product must
  never depend on `windows-review.mjs`; it is excluded from the product path the same way the P00
  bootstrap CLI is.


## D-0121 - History is a windowed read over the whole thread, and stream identity is per item

- **Decision:** the studio reads stored history through `ProjectStore.timelinePage` with explicit
  `beforeSeq` / `aroundSeq` / `afterSeq` cursors and a computed `hasOlder` / `hasNewer` / `total`.
  The first load is the newest window (500 rows), the renderer holds at most 2 000 rows and renders
  120, and "older" is a store read rather than a re-label of one raw-event prefix. Export walks every
  row through `iterateTimelineItems` in bounded chunks. Search is a local
  `LIKE ... ESCAPE` read over the thread with wildcards matched literally.
- **Why:** the previous fixed `ORDER BY seq ASC LIMIT 500` read the *oldest* rows, so beyond 500
  stored rows the newest history was unreachable and export published a prefix as the conversation.
  Widening the constant would only move the cliff; S02 requires paging by a stable cursor.
- **Stream identity:** deltas are keyed by `(thread, turn, engine item id)`. An id-less delta binds
  to that turn's single open anonymous stream; a completion may adopt that row (same id and
  sequence, final text) but only when exactly one anonymous stream is open. A frame after its card
  closed is counted as late and dropped. A skipped sequence is recorded as a diagnostic; when the
  stream *resumes past* undelivered frames, open answers are closed as `interrupted` and a status row
  names the loss. Adoption is refused rather than guessing when the evidence is ambiguous.
- **Why the gap rule is narrow:** a skipped sequence alone does not mean lost text — the runtime
  filters frames such as heartbeats — so splitting on any gap would corrupt the common case. Only an
  explicit resume-past-loss signal claims an interruption.
- **Cross-thread:** every projected row and push carries its thread. The service refuses an envelope
  whose thread differs from its subscription, and the renderer ignores foreign-thread pushes; a
  thread switch detaches the old subscription and resets the cursor. Without this, one runtime
  serving Plan and Work could merge two conversations in one view.
- **Constrains:** the renderer window is a view, not the source of truth; anything dropped from it
  stays reachable through paging or search, and the UI says how many rows are stored versus loaded.

## D-0122 - The slash catalog is the engine's own registry plus a curated classification

- **Decision:** `tools/build/slash-catalog.mjs capture` reads the installed engine's
  `GET /v1/commands` once in a throwaway `CODEWHALE_HOME` (usage reporting off, no credentials, no
  provider call) and records engine version, commit, binary SHA-256 and route. `build` merges that
  capture with `tools/catalog/slash-annotations.json` into
  `apps/desktop/src/shared/slash-catalog.ts`; `check` fails when the shipped file is stale.
- **Why:** S03 requires a versioned catalog from the real registry, with provenance and no invented
  rows. The engine already publishes name, aliases, summary, usage, subcommands, hidden and
  discovery; guessing any of those would be fabrication, and reading them at product runtime would
  add a startup request Mona's economics forbid.
- **Mechanism, so coverage is not prose:** the generator refuses an unannotated registry row, an
  annotation naming a command the engine does not have, a name annotated twice, and an alias that
  collides with a command name or another alias. `slash-catalog.test.ts` reconciles the shipped file
  with the raw capture in both directions (names, aliases, summary, usage, subcommands, hidden,
  discovery, provenance).
- **Cost class is explicit.** `model` means the command sends a provider request; `none` means it
  does not; `unknown` means the registry summary does not settle it and Mona does not claim zero. A
  `model` row must say "provider request" in its side-effect note, enforced by test.
- **Routes are honest stage by stage.** Every row is `tui-only` in W04 because no typed operation
  exists yet; W05 flips the rows it can actually dispatch and the route note changes with them.
- **Command position is narrow on purpose.** Only `/` at column 0, only while the caret is in the
  first token, only with command characters. Paths (`/usr/bin/env`, `C:\…`, UNC), indented code,
  quoted examples and an escaped `\/` stay ordinary text, so autocomplete never rewrites prose.
- **Nothing command-shaped is sent silently.** A recognized command, an ambiguous prefix and a
  missing required argument each produce an explanation; the explicit ways to send text are an
  unknown word, prose, or a leading `\/` (whose escape is removed and reported).
