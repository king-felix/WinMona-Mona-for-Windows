# P00 — Bootstrap and ground truth (evidence)

Prompt: P00 "Bootstrap the project and establish ground truth".
Result: **completed** — build workspace, durable ledger, discovery and bootstrap
tooling are in place and verified on this machine.

## What P00 required, and where it is answered

1. **Inspect the workspace; establish Git; record platform facts.**
   No files were replaced. Git was initialized on `main` with no remote
   (decision D-0001). Platform, runtimes, shell, volume and native-toolchain
   facts are in `docs/discovery-report.md` section 1 and the raw engine outputs
   in `docs/evidence/engine/`.
2. **Codewhale identity, help, source match, PATH conflicts.**
   `codewhale 0.10.2 (ff466b2ed0bf)`, WinGet package `HunterBown.CodeWhale`,
   one installation on PATH, no conflicting copy. Help captured verbatim in
   `docs/evidence/engine/cli-help.txt`, `app-server-help.txt`, `exec-help.txt`.
   Matching source for this commit could not be fetched at P00 (no repository
   clone was performed and none is authorized); the version string is recorded
   as the compatibility anchor for P01/P03 to pin. This is a recorded gap, not a
   claim of source parity.
3. **Provider/model/endpoint by redacted inspection.**
   `deepseek` / `deepseek-flash` / `https://api.deepseek.com`, `api_key` auth,
   credential present but unprobed; `doctor` explicitly reports "no verified
   key". No value was read or stored. The live-route check is the first P01
   prerequisite (D-0005, `BLOCKERS.md` watchlist).
4. **`AGENTS.md` with the operating contract and pointers.**
   `AGENTS.md` covers start-of-session reads, non-negotiables, the three-attempt
   rule, checkpointing, status vocabulary, layout, and the report shape. No
   pre-existing repository instructions existed, so no conflict had to be
   reconciled (recorded in `docs/discovery-report.md` section 5).
5. **Durable state files and the requirement ledger.**
   - `.mona/build/state.json` — 24 tasks (P00–P23), schema v1, revision 2.
   - `.mona/build/attempts.jsonl` — append-only attempt ledger (empty; no
     attempts needed at P00).
   - `.mona/build/HANDOFF.md`, `DECISIONS.md` (D-0001…D-0008), `BLOCKERS.md`.
   - `docs/requirements.json` — all 30 `MONA-xxx` requirements with 114 seeded
     acceptance criteria, owning prompts derived from the prompt map, and the
     validated P00–P23 dependency graph. `docs/spec-index.json` — 55 sections of
     `Mona_Project.md` and 44 of `Mona_PROMPTS.md` with per-section hashes, 30
     requirement IDs and all prompt sections.
6. **Local validation/checkpoint utility.**
   `tools/build/cli.mjs`: `index`, `init`, `validate`, `checkpoint`, `recover`,
   `evidence`, `status`. It provides JSON-Schema validation (ajv 8.20.0,
   pinned), atomic temp-write + fsync + rename, prior-revision backups, an
   append-only checkpoint journal, monotonic revision conflict rejection, a
   single-writer lock with dead-owner detection, graph/hash/evidence/secret
   checks, and interrupted-write recovery.
7. **Discovery report and capability inventory structure.**
   `docs/discovery-report.md` plus `docs/codewhale-capabilities.json` seeded with
   43 top-level command rows and 4 transports, every row `unqualified` with the
   qualification work assigned to P01 (G2) and P18. Upstream overlap
   (`codewhale web` / `rc` / `serve`) is recorded for the G0 reassessment.

## Acceptance checks

| Acceptance | Evidence |
|---|---|
| Both specs indexed and hashed | `docs/spec-index.json`; `validate` compares state, ledger and live file hashes and fails on drift |
| All prompt IDs and requirements present | `docs/requirements.json` (24 prompts, 30 requirements, 114 criteria); `validate` requires exactly P00–P23 and MONA-001–030 |
| Dependency graph valid | `validate` walks the graph, rejects unknown/self prerequisites and cycles (tested) |
| Simulated interrupted checkpoint preserves recoverable state | `npm test` — interrupted-after-temp-write promotion, torn temp quarantine, corrupt state restored from verified backup, stale revision refused |
| No secret committed | `validate` scans Git-tracked files for key-shaped strings, assigned credentials, private-key blocks and tracked `secrets.json`/`.env`; clean at P00 |
| Actual engine/platform identity recorded or explicitly unavailable | engine identity complete; matching upstream source not fetched at P00 and explicitly recorded as open |

## Validation artifacts

- `docs/evidence/P00-tests.txt` — `node --test tests/bootstrap` output.
- `docs/evidence/P00-validation.txt` — `node tools/build/cli.mjs validate
  --verbose` output before the checkpoint.
- `docs/evidence/P00-final-audit.txt` — post-checkpoint validation and status.

## Requirement contributions

- **MONA-001** — `partial`: identity and reproducibility evidenced;
  `capabilities` remains partial because the inventory is a seed, not a
  qualified inventory (P01/P18 own the rest).
- **MONA-010** — `partial`: schema, atomic replace, conflict detection, handoff,
  traceability and attempt ledger exist and are tested at the build layer; the
  product-level transactional state and migrations remain with P05/P10.

No other requirement is claimed. No screens, adapters, installers or engine
integrations exist yet.

## Notes for the next prompt

- P01 must verify the live route before claiming G0, inside the $2 pilot ceiling.
- The upstream runtime API advertises `/v1/*` on `127.0.0.1:7878`; its actual
  route contracts are untested. Treat every route name as unverified until a
  contract test passes against 0.10.2.
- `docs/spec-index.json` is regenerated by `node tools/build/cli.mjs index`;
  update the ledger hashes if Victor ever changes either specification.
