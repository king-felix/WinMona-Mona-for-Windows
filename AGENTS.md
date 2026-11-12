# AGENTS.md — Mona build instructions

Mona is a local desktop workbench for Codewhale. `Mona_Project.md` v1.0 is the
authoritative product specification; `Mona_PROMPTS.md` v1.0 is the authoritative
build sequence and operating contract. Neither is implemented merely by being
described. Where this file and those documents disagree, the specification wins
and the conflict must be recorded in `.mona/build/DECISIONS.md`.

## Start every session here

1. Read this file, `.mona/build/HANDOFF.md`, `.mona/build/state.json`, and the
   open rows of `.mona/build/BLOCKERS.md` / `.mona/build/attempts.jsonl`.
2. Reconcile the recorded state with the working tree and fresh evidence. Run
   `node tools/build/cli.mjs validate` before trusting any status.
3. Read only the assigned prompt in `Mona_PROMPTS.md` plus its relevant
   `Mona_Project.md` sections. Section offsets and hashes are in
   `docs/spec-index.json`; do not re-read 100 KB of specification by habit.
4. Resume the unfinished `current_prompt`; otherwise take the earliest eligible
   prompt. Do not redo completed work because the session is new.

Build-state commands (P00 utility, not the product framework):

```text
node tools/build/cli.mjs index      # rehash + reindex both spec documents
node tools/build/cli.mjs validate   # schema, hashes, graph, evidence, secret scan
node tools/build/cli.mjs status     # compact state summary
node tools/build/cli.mjs checkpoint --prompt P00 --status completed --expected-revision <N> ...
node tools/build/cli.mjs recover    # after an interrupted write
npm test                            # product (vitest) + bootstrap/spike (node --test)
npm run build                       # contracts + main + preload + renderer
npm run typecheck                   # contracts and desktop programs
npm run lint                        # ESLint flat config
```

## Non-negotiables

- **Preserve the economics.** No router, summarizer, background inference, or
  paid UI feature. Idle Mona must cause zero provider requests.
- **Codewhale executes.** Do not reimplement provider clients, the tool loop,
  compaction, permissions, or orchestration. Use the installed engine's
  documented surfaces and verify them against version 0.10.2 (ff466b2ed0bf).
- **Preserve Victor's route.** Provider `deepseek`, model `deepseek-flash`,
  endpoint `https://api.deepseek.com`, Full Access posture. Do not change
  credentials, endpoints, models, or telemetry without an explicit request.
- **Show real state.** Disconnected ≠ stopped; interrupted ≠ completed;
  unknown cost ≠ zero; untested ≠ supported.
- **No fabricated evidence.** A mock-only test is never runtime compatibility.
  Record command, result, timestamp, version/commit and artifact path/hash.
- **No secrets.** Never commit keys, tokens, credential paths or private
  transcripts. `.mona/build` is shareable and redacted.
- **No unrequested publication.** No public repo, package, release, purchase or
  certificate. Local commits only; there is no Mona remote.
- **Scope discipline.** One numbered prompt per session unless Victor queues
  more. Do not drift into later prompts or Later-scope features.

## Three-attempt rule (persistent across sessions)

One attempt = one hypothesis plus observed result, recorded in
`.mona/build/attempts.jsonl` with `problem_id`, `requirement_id`,
`symptom_fingerprint`, hypothesis, action, observed result, evidence path,
`material_progress`, and `consecutive_no_progress`. At three consecutive
no-progress attempts, stop that problem, record the exact help Victor must
provide in `BLOCKERS.md`, keep the requirement blocked, and continue only
genuinely independent eligible work. Never reset the counter by starting a new
session, never remove a test, lower a criterion, swap platforms or substitute
fake behavior to make a blocker disappear.

## Checkpointing

Checkpoint after a meaningful boundary, a new blocker, a test milestone, and
before handing off. A checkpoint must use `--expected-revision` so a stale writer
cannot overwrite newer state. Then update `HANDOFF.md`, the requirement ledger
(`docs/requirements.json`, via `cli.mjs evidence`), and any decision records.
Commit locally once the prompt's work is coherent and verified.

Prompt statuses are exactly `pending | running | verifying | completed | blocked |
interrupted | skipped`; requirement statuses are `pending | partial | verified |
blocked | skipped`. `skipped` requires an explicit recorded decision by Victor.

## Layout

```text
Mona_Project.md / Mona_PROMPTS.md   authoritative specification + prompts
AGENTS.md                           this file
docs/requirements.json              requirement + prompt traceability ledger
docs/spec-index.json                section/ID index and hashes (generated)
docs/codewhale-capabilities.json    pinned-engine capability coverage ledger
docs/discovery-report.md            P00 environment/engine discovery
docs/evidence/                      evidence artifacts referenced by the ledger
.mona/build/state.json              durable build state (schema v1)
.mona/build/HANDOFF.md              short deterministic handoff
.mona/build/DECISIONS.md            decisions and their reasons
.mona/build/BLOCKERS.md             blockers and required human help
.mona/build/attempts.jsonl          append-only attempt ledger
.mona/build/checkpoints.jsonl       append-only checkpoint journal
tools/build/                        bootstrap utility, schemas, seeders, tests
tests/bootstrap/                    P00 utility tests
```

Layout now includes `apps/desktop` (Electron main, preload, React renderer) and
`packages/contracts` (Zod schemas and fixtures). `native/windows-shell` and
`tests/integration` arrive in later prompts. The bootstrap CLI must not grow into
the product framework, and the product must never depend on it to boot.

## Reporting

Follow the report shape in `Mona_PROMPTS.md` O5: prompt + status, concrete
delivered behavior, validation evidence location, open problem IDs and help
needed, next eligible prompt, checkpoint commit and handoff path.
